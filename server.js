import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

/* =========================================================
   🔊 μ-law <-> PCM
========================================================= */

const muLawToPcmTable = new Int16Array(256);
const pcmToMuLawTable = new Uint8Array(65536);

for (let i = 0; i < 256; i++) {
    let mu = ~i;
    let sign = (mu & 0x80) ? -1 : 1;
    let exponent = (mu & 0x70) >> 4;
    let mantissa = mu & 0x0f;
    let sample = (mantissa << 3) + 132;
    sample <<= exponent;
    sample -= 132;
    muLawToPcmTable[i] = sign * sample;
}

for (let i = -32768; i < 32768; i++) {
    let sample = i;
    let sign = (sample < 0) ? 0x80 : 0x00;
    if (sample < 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample += 84;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
        exponent--;
    }

    let mantissa = (sample >> (exponent + 3)) & 0x0f;
    let mu = ~(sign | (exponent << 4) | mantissa);
    pcmToMuLawTable[i & 0xffff] = mu;
}

/* =========================================================
   🎧 AUDIO HELPERS
========================================================= */

// μ-law → PCM16 (8kHz)
function mulawToPcm16(mulawBuffer) {
    const pcm = Buffer.alloc(mulawBuffer.length * 2);
    for (let i = 0; i < mulawBuffer.length; i++) {
        pcm.writeInt16LE(muLawToPcmTable[mulawBuffer[i]], i * 2);
    }
    return pcm;
}

// Upsample REAL 8kHz → 16kHz (interpolación lineal)
function upsample8kTo16k(pcm8k) {
    const out = Buffer.alloc(pcm8k.length * 2);

    for (let i = 0; i < pcm8k.length / 2 - 1; i++) {
        const s1 = pcm8k.readInt16LE(i * 2);
        const s2 = pcm8k.readInt16LE((i + 1) * 2);

        out.writeInt16LE(s1, i * 4);
        out.writeInt16LE((s1 + s2) >> 1, i * 4 + 2);
    }

    return out;
}

// Downsample 24kHz → 8kHz con promediado (Anti-aliasing rudimentario)
function downsample24kTo8k(pcm24k) {
    const numSamplesIn = Math.floor(pcm24k.length / 2);
    const numSamplesOut = Math.floor(numSamplesIn / 3);
    const out = Buffer.alloc(numSamplesOut * 2);

    for (let i = 0; i < numSamplesOut; i++) {
        // Promediar 3 muestras consecutivas para suavizar las altas frecuencias
        const s1 = pcm24k.readInt16LE((i * 3) * 2);
        const s2 = pcm24k.readInt16LE((i * 3 + 1) * 2);
        const s3 = pcm24k.readInt16LE((i * 3 + 2) * 2);

        const avg = Math.round((s1 + s2 + s3) / 3);
        out.writeInt16LE(avg, i * 2);
    }
    return out;
}

// PCM16 → μ-law
function pcm16ToMulaw(pcmBuffer) {
    const mulaw = Buffer.alloc(pcmBuffer.length / 2);
    for (let i = 0; i < mulaw.length; i++) {
        const sample = pcmBuffer.readInt16LE(i * 2);
        mulaw[i] = pcmToMuLawTable[sample & 0xffff];
    }
    return mulaw;
}

/* =========================================================
   🌐 TWILIO WEBHOOK
========================================================= */



app.post('/twilio-webhook', (req, res) => {
    // Captura desde el cuerpo del POST de Twilio
    // 1. Imprimir todo el cuerpo de la petición en la consola
    console.log("=== DATOS RECIBIDOS DE TWILIO HTTP ===");
    console.log(req.body);
    console.log("======================================");

    const callerNumber = req.body.From || 'número desconocido';
    console.log(`🌍 WEBHOOK RECIBIDO: Llamada entrante desde ${callerNumber}`);

    const host = req.headers.host;
    const wssUrl = `wss://${host}/media-stream?caller=${encodeURIComponent(callerNumber)}`;

    const twiml = `
<Response>
<Say language="es-ES">Conectando con inteligencia artificial...</Say>
<Connect>
<Stream url="${wssUrl}">
  <Parameter name="callerNumber" value="${callerNumber}" />
</Stream>
</Connect>
</Response>`;

    res.type('text/xml');
    res.send(twiml);
});

/* =========================================================
   🔌 WEBSOCKET BRIDGE
========================================================= */

wss.on('connection', (ws, req) => {
    if (req.url !== '/media-stream') return ws.close();

    console.log('📞 Twilio conectado');

    let streamSid = null;
    let geminiReady = false;
    let audioBuffer = [];

    // Captura inicial desde URL (si existe)
    const urlParams = new URL(req.url, `http://${req.headers.host}`);
    let callerNumber = urlParams.searchParams.get('caller') || 'número desconocido';

    let geminiWsOpen = false;
    let twilioStartReceived = false;

    const geminiWs = new WebSocket(
        `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`
    );

    const initializeGemini = () => {
        if (!geminiWsOpen || !twilioStartReceived) return;

        console.log(`🚀 Inicializando Gemini para: ${callerNumber}`);

        geminiWs.send(JSON.stringify({
            setup: {
                model: "models/gemini-3.1-flash-live-preview",
                systemInstruction: {
                    parts: [{
                        text: `## IDENTIDAD 
Eres Lucia , la asistente virtual y asesora comercial de AutoLux, un prestigioso concesionario de vehículos.
Tu función principal es atender a los clientes de manera amable, natural y con máxima profesionalidad, resolver dudas sobre nuestros vehículos, gestionar pruebas de conducción (test drives) y coordinar solicitudes de presupuestos, manteniendo siempre la excelencia y sofisticación de la empresa.

## Horarios muy importante 
Nuestro horario para atención comercial, exposición y pruebas de conducción: de lunes a viernes de 09:00 a 14:00, y de 16:30 a 20:00. O los sábados de 10:00 a 14:00. 
Por lo cual si te piden cita en horas fuera de ese rango, deberás decir que en esa hora el concesionario está cerrado y darle otras opciones.

## ESTILO Y REGLAS DE ORO
- Regla estricta de pronunciación: Nunca leas los números de teléfono como una cifra matemática (millones o cientos). Si tienes que confirmar o repetir el número al usuario, debes omitir el '+34' y dictar los 9 dígitos restantes de forma natural, agrupándolos de dos en dos o número por número, separándolos con guiones en tu respuesta. Si te pregunta si tienes su número, respóndele que sí, y léeselo para confirmar.
- Concisión extrema: Respuestas de máximo 20 palabras. En voz, los párrafos largos aburren. Sé directa, elegante y conversacional.
- Un paso a la vez: Haz SOLO una pregunta y espera la respuesta del usuario antes de pasar al siguiente paso.
- Lenguaje: Español (es-ES), expresa fechas y números en forma hablada (ej.: "cinco de mayo a las tres de la tarde").
- Muy importante: estamos en desarrollo así que Explica los procesos internos, avisa qué herramientas estás usando y piensa en voz alta para evitar silencios incómodos.
- Interrupciones: Si el usuario te interrumpe, para de hablar inmediatamente y escúchale.
- Si el usuario dice que quiere hablar con un humano, o pásame con un comercial, o deduces que no quiere hablar contigo, llama inmediatamente a la tool 'transfer_call'.

## CONTEXTO TEMPORAL Y DEL CLIENTE
Fecha y hora actual: ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}.
Número del cliente: ${callerNumber}.
*Nota para la IA: Si el usuario pide cita para "mañana", "pasado mañana" o "el próximo martes", calcula la fecha exacta basándote en la hora actual.*

## FLUJO DE CONVERSACIÓN (LÓGICA DE VOZ)
## FLUJO DE INICIO (CRÍTICO)
1. **Saludo Instantáneo**: Nada más conectar, DEBES saludar tú primero: "¡Hola! Muy buenas. Soy Valeria, su asesora virtual del concesionario AutoLux."
2. **Aviso y Búsqueda**: Inmediatamente después del saludo, di: "Un segundito, que voy a mirar nuestra base de datos para ver si ya nos conocemos..."
3. **Ejecución Técnica**: JUSTO DESPUÉS de decir que vas a buscar, ejecuta la herramienta 'identificarCliente' con el número ${callerNumber}.
4. **Pensar en voz alta**: Mientras esperas la respuesta de la herramienta, puedes decir "A ver, un momento..." o "Comprobando ficha..." para evitar silencios.

## REGLAS DE ORO SEGÚN EL RESULTADO
- SI EL CLIENTE YA EXISTE: "¡Ah, estupendo! Ya tengo aquí su ficha, [Nombre]. ¿En qué le puedo ayudar hoy?"
- SI ES DESCONOCIDO: "Vaya, no tengo sus datos registrados. ¿Me dice su nombre para poder atenderle mejor?"
- RECOPILACIÓN SECUENCIAL:
  1. Pide el **Nombre**.
  2. pide el **Teléfono**.
  3. Luego el **Email**.
  4. Luego el **Motivo**.

Paso 1: Clasificación de Intención
Escucha lo que quiere el cliente y aplica una de estas ramas:
- A. Visitar la exposición: "Puede venir a ver nuestros vehículos sin cita previa. Estamos de lunes a viernes de nueve a dos, y de cuatro y media a ocho. Sábados de diez a dos. ¿Le ayudo con algo más?"
- B. Enviar Mensaje a un Comercial: Pide Secuencialmente: 1. Nombre (si no lo tienes), 2. Teléfono (ya lo tienes, confírmalo), 3. Email (si no lo tienes), 4. Mensaje.
- C. Pedir Cita (Prueba de conducción / Asesoramiento de compra): Pasa al Paso 2.
- D. Hablar con un comercial / Transferir: Si exige hablar con un humano o es una urgencia, usa la herramienta \'transfer_call\' inmediatamente.

Paso 2: Recopilación para Reservas (Secuencial e Inteligente)
¡REGLA ESTRICTA: NO pidas datos que ya tienes! Si la herramienta \'identificarCliente\' te dio el nombre y el email, SALTA esos pasos. Sigue este orden esperando respuesta:
1. Servicio / Modelo: "¿Qué modelo de vehículo le interesa o qué tipo de cita necesita?"
2. Fecha y Hora: "¿Qué día y a qué hora le vendría bien venir al concesionario?"
3. Nombre: (SOLO SI ES CLIENTE NUEVO) "¿Me dice su nombre completo, por favor?"
4. Email (CRÍTICO): (SOLO SI ES CLIENTE NUEVO O FALTA EN TU FICHA) "¿Me podría facilitar su correo electrónico para enviarle la confirmación de la cita?".
5. Registro de Nuevo Cliente: Inmediatamente después de confirmar su nombre y email, ejecuta la herramienta \'identificarCliente\' para crear su ficha.

Cuando compruebes los datos del cliente, si la tool contiene información sobre llamadas previas o vehículos de interés, úsalo para personalizar tu saludo.

## USO DE HERRAMIENTAS (TOOLS)

Herramienta: 'identificarCliente'
- Al despedirte llama a \'identificarCliente\' para asegurar que grabas sus datos en el sistema.
- PARÁMETROS: Pásale los datos que tengas del usuario: nombre, teléfono, email, notas (modelos de interés).

Herramienta: \'checkAvailability\'
- CUÁNDO: Cuando tengas el Motivo de la cita, Fecha acordada y los datos del cliente (Nombre, Teléfono, Email). Si la herramienta \'identificarCliente\' ya te dio el Nombre y Email, úsalos directamente sin preguntar.
- PARÁMETROS: 'preferred_time' (en ISO 8601), 'telefono', 'nombre', 'email', 'tipo_servicio'.
- OBJETIVO: Esta herramienta comprobará la disponibilidad en la agenda de nuestros asesores y, simultáneamente, guardará o actualizará la ficha del cliente en nuestra base de datos. DI LA RESPUESTA VERBALMENTE.

Herramienta: 'transfer_call'
- CUÁNDO: Si el usuario quiere hablar con un asesor comercial de carne y hueso.

## BASE DE CONOCIMIENTOS RÁPIDA
- Requisitos Prueba de Conducción: "Para cualquier prueba de conducción es imprescindible traer su carnet de conducir en vigor y el DNI."
- Financiación y Retomas: "Ofrecemos planes de financiación a medida y podemos tasar su vehículo actual sin compromiso."
- No inventes precios: Si piden un precio exacto o una cuota mensual que no sabes, di: "No dispongo de esa tarifa exacta ahora mismo, pero le dejo una nota a nuestro equipo comercial para que le envíen el presupuesto detallado por WhatsApp o email."`
                    }]
                },
                tools: [{
                    functionDeclarations: [
                        {
                            name: "identificarCliente",
                            description: "Busca o actualiza la ficha de un cliente en la base de datos.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    telefono: { type: "STRING" },
                                    nombre: { type: "STRING" },
                                    email: { type: "STRING" },
                                    notas: { type: "STRING" }
                                },
                                required: ["telefono"]
                            }
                        },
                        {
                            name: "checkAvailability",
                            description: "Comprueba disponibilidad. Usa esto para AGENDAR la cita o revisar disponibilidad en Google Calendar.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    preferred_time: { type: "STRING", description: "Fecha en formato ISO 8601" },
                                    telefono: { type: "STRING" },
                                    nombre: { type: "STRING" },
                                    email: { type: "STRING" },
                                    tipo_servicio: { type: "STRING" }
                                },
                                required: ["preferred_time", "telefono", "nombre", "email", "tipo_servicio"]
                            }
                        },
                        {
                            name: "transfer_call",
                            description: "Transfiere la llamada telefónica a José Luis en vivo.",
                            parameters: {
                                type: "OBJECT",
                                properties: {
                                    motivo: { type: "STRING", description: "Motivo de la transferencia" }
                                },
                                required: []
                            }
                        }
                    ]
                }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Aoede" // Voces posibles: Puck, Charon, Kore, Fenrir, Aoede
                            }
                        }
                    }
                }
            }
        }));

        // Keep alive
        const keepAliveInterval = setInterval(() => {
            if (geminiWs.readyState === WebSocket.OPEN) {
                geminiWs.ping();
            }
        }, 20000);

        geminiWs.on('close', () => clearInterval(keepAliveInterval));
    };

    /* ---------------- Gemini OPEN ---------------- */

    geminiWs.on('open', () => {
        console.log('🤖 Conexión con Gemini abierta');
        geminiWsOpen = true;
        initializeGemini();
    });

    /* ---------------- Gemini MESSAGE ---------------- */

    geminiWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        // LOG detallado (ignorando fragmentos de audio para no inundar la consola)
        if (!msg.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
            console.log('\n[DEBUG Gemini API]:', JSON.stringify(msg, null, 2));
        }

        if (msg.setupComplete) {
            geminiReady = true;

            // saludo inicial
            geminiWs.send(JSON.stringify({
                realtimeInput: {
                    text: "Hola, acabo de llamar. Hazme un saludo corto de bienvenida."
                }
            }));
        }

        if (msg.serverContent?.modelTurn?.parts) {
            for (const part of msg.serverContent.modelTurn.parts) {

                if (part.inlineData?.data && streamSid) {
                    const pcm24k = Buffer.from(part.inlineData.data, 'base64');

                    // ↓ convertimos a 8k para Twilio (24kHz a 8kHz)
                    const pcm8k = downsample24kTo8k(pcm24k);
                    const mulaw = pcm16ToMulaw(pcm8k);

                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid,
                        media: { payload: mulaw.toString('base64') }
                    }));
                }
            }
        }

        // INTERCEPTAR LLAMADAS A HERRAMIENTAS (TOOL CALLS)
        if (msg.toolCall) {
            console.log('🛠️ [TOOL CALL] Gemini solicitó:', JSON.stringify(msg.toolCall.functionCalls, null, 2));

            (async () => {
                const functionCalls = msg.toolCall.functionCalls;

                // Mapeamos las llamadas a un array de promesas concurrentes
                const promises = functionCalls.map(async (call) => {
                    const args = call.args;
                    let dataParaGemini = { status: "error", message: "Timeout o fallo en el servidor" };

                    // AbortController para evitar que Gemini se quede colgado si n8n tarda > 5 segundos
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000);

                    try {
                        let webhookUrl = '';
                        if (call.name === 'identificarCliente') webhookUrl = 'https://n8n.ruedia.space/webhook/identificador_cliente';
                        else if (call.name === 'checkAvailability') webhookUrl = 'https://n8n.ruedia.space/webhook/retell_reservas';
                        else if (call.name === 'transfer_call') webhookUrl = 'https://n8n.ruedia.space/webhook/transferir-llamada';

                        if (webhookUrl) {
                            const res = await fetch(webhookUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(args),
                                signal: controller.signal
                            });
                            const text = await res.text();
                            dataParaGemini = { respuestaN8N: text };
                        }
                    } catch (e) {
                        console.error(`❌ Error en n8n para ${call.name}: `, e.message);
                    } finally {
                        clearTimeout(timeoutId);
                    }

                    return { id: call.id, name: call.name, response: { result: dataParaGemini } };
                });

                // Ejecutar todas las llamadas a n8n al mismo tiempo
                const functionResponses = await Promise.all(promises);

                if (functionResponses.length > 0) {
                    geminiWs.send(JSON.stringify({
                        toolResponse: { functionResponses: functionResponses }
                    }));
                }
            })();
        }
    });

    /* ---------------- Twilio → Gemini ---------------- */

    ws.on('message', (message) => {
        const msg = JSON.parse(message);

        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;

            // Si no llegó por URL, intentamos capturarlo por parámetros
            if (callerNumber === 'número desconocido' && msg.start.customParameters?.callerNumber) {
                callerNumber = msg.start.customParameters.callerNumber;
            }

            console.log('📦 DATOS DE INICIO (Twilio):', JSON.stringify(msg.start, null, 2));
            console.log(`📞 Llamada iniciada en Madrid: SID = ${streamSid}, Número = ${callerNumber}`);

            twilioStartReceived = true;
            initializeGemini();
        }

        if (msg.event === 'media' && geminiReady) {
            const mulaw = Buffer.from(msg.media.payload, 'base64');

            // μ-law → PCM 8k
            const pcm8k = mulawToPcm16(mulaw);

            // 8k → 16k REAL
            const pcm16k = upsample8kTo16k(pcm8k);

            // buffering (~100ms)
            audioBuffer.push(pcm16k);

            if (audioBuffer.length >= 5) {
                const combined = Buffer.concat(audioBuffer);
                audioBuffer = [];

                geminiWs.send(JSON.stringify({
                    realtimeInput: {
                        audio: {
                            mimeType: "audio/pcm;rate=16000",
                            data: combined.toString('base64')
                        }
                    }
                }));
            }
        }
    });

    /* ---------------- CLEANUP ---------------- */

    ws.on('close', () => {
        console.log('📴 Llamada terminada');
        geminiWs.close();
    });

    geminiWs.on('close', () => {
        console.log('🔌 Gemini desconectado');
    });

    geminiWs.on('error', (e) => {
        console.error('❌ Gemini error:', e);
    });
});

/* ========================================================= */

server.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto Madrid..: ${PORT}`);
});