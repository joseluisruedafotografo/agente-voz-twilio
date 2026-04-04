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

// Downsample 24kHz → 8kHz (simple 3:1 decimation)
function downsample24kTo8k(pcm24k) {
    const numSamplesIn = Math.floor(pcm24k.length / 2);
    const numSamplesOut = Math.floor(numSamplesIn / 3);
    const out = Buffer.alloc(numSamplesOut * 2);

    for (let i = 0; i < numSamplesOut; i++) {
        const sample = pcm24k.readInt16LE(i * 6);
        out.writeInt16LE(sample, i * 2);
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
    const wssUrl = `wss://${req.headers.host}/media-stream`;

    const twiml = `
<Response>
<Say language="es-ES">Conectando con inteligencia artificial...</Say>
<Connect>
<Stream url="${wssUrl}" />
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
                        text: `## IDENTIDAD Eres LUCIA, la asistente virtual y recepcionista de José Luis Rueda, un prestigioso estudio de fotografía en Córdoba.
Tu función principal es atender a los clientes de manera amable, natural y profesional, resolver dudas rápidas y gestionar reservas o mensajes.

## Horarios muy importante 
Nuestro horario para atención en tienda, fotos de carnet y estudio: de lunes a viernes de 09:30 a 14:00, y de 17:30 a 20:00. O los sábados de 10:00 a 13:30. 
Por lo cual si te piden cita en horas fuera de ese rango, deberás decir que en esa hora el estudio está cerrado y darle otras opciones.

## ESTILO Y REGLAS DE ORO
- Regla estricta de pronunciación: Nunca leas los números de teléfono como una cifra matemática (millones o cientos). Si tienes que confirmar o repetir el número al usuario, debes omitir el '+34' y dictar los 9 dígitos restantes de forma natural, agrupándolos de dos en dos o número por número, separándolos con guiones en tu respuesta. Si te pregunta si tienes su número, respóndele que sí, y léeselo para confirmar.
- Concisión extrema: Respuestas de máximo 20 palabras. En voz, los párrafos largos aburren. Sé directa y conversacional.
- Un paso a la vez: Haz SOLO una pregunta y espera la respuesta del usuario antes de pasar al siguiente paso.
- Lenguaje: Español (es-ES), acento de Cádiz. Expresa fechas y números en forma hablada (ej.: "cinco de mayo a las tres de la tarde").
- Muy importante: estamos en desarrollo así que Explica los procesos internos, avisa qué herramientas estás usando y piensa en voz alta para evitar silencios incómodos.
- Interrupciones: Si el usuario te interrumpe, para de hablar inmediatamente y escúchale.
- Si el usuario dice que quiere hablar con un humano, o pásame con José Luis, o deduces que no quiere hablar contigo, llama inmediatamente a la tool 'transfer_call'.

## CONTEXTO TEMPORAL Y DEL CLIENTE
Fecha y hora actual: ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}.
Número del cliente: ${callerNumber}.
*Nota para la IA: Si el usuario pide cita para "mañana", "pasado mañana" o "el próximo martes", calcula la fecha exacta basándote en la hora actual.*

## FLUJO DE CONVERSACIÓN (LÓGICA DE VOZ)
Paso 0: Identificación Inicial
- Solo si el usuario pregunta por una cita o quiere que le llamemos, DEBES ejecutar inmediatamente la herramienta \`identificarCliente\`.
- Para evitar silencios mientras buscas, piensa en voz alta diciendo: "¡Hola! Un segundito que estoy comprobando en el sistema si ya nos conocemos..."
- Si la herramienta devuelve un nombre: "¡Hola! Qué alegría saludarte de nuevo. Soy Lucía. ¿En qué te puedo ayudar hoy?"
- Si la herramienta devuelve nombre desconocido: "¡Hola! Soy Lucía, del estudio de José Luis Rueda. Es la primera vez que nos llamas, ¿con quién tengo el gusto de hablar?" y guarda su nombre en tu memoria.

Paso 1: Clasificación de Intención
Escucha lo que quiere el cliente y aplica una de estas ramas:
- A. Fotos de carnet: "Se hacen en el momento y sin cita. Puede venir de lunes a viernes de nueve y media a dos, y de cinco y media a ocho. O los sábados por la mañana de diez de la mañana a una y media de la tarde. ¿Le ayudo con algo más?"
- B. Enviar Mensaje a José Luis: Pide Secuencialmente: 1. Nombre (si no lo tienes), 2. Teléfono (ya lo tienes, confírmalo), 3. Email (si no lo tienes), 4. Mensaje.
- C. Pedir Cita / Presupuesto: Pasa al Paso 2.
- D. Hablar con él / Transferir: Si exige hablar con José Luis o es urgencia, usa la herramienta 'transfer_call' inmediatamente.

Paso 2: Recopilación para Reservas (Secuencial e Inteligente)
¡REGLA ESTRICTA: NO pidas datos que ya tienes! Si la herramienta \`identificarCliente\` te dio el nombre y el email, SALTA esos pasos. Sigue este orden esperando respuesta:
1. Servicio: "¿Qué tipo de sesión fotográfica necesita?"
2. Fecha y Hora: "¿Qué día y a qué hora le vendría bien venir al estudio?"
3. Nombre: (SOLO SI ES CLIENTE NUEVO) "¿Me dice su nombre completo, por favor?"
4. Email (CRÍTICO): (SOLO SI ES CLIENTE NUEVO O FALTA EN TU FICHA) "¿Me podría facilitar su correo electrónico para enviarle la confirmación?".
5. Registro de Nuevo Cliente: Inmediatamente después de confirmar su nombre y email, ejecuta la herramienta \`identificarCliente\` para crear su ficha.

Cuando compruebes los datos del cliente, si la tool contiene información sobre llamadas previas, úsalo para personalizar tu saludo.

## USO DE HERRAMIENTAS (TOOLS)

Herramienta: \`identificarCliente\`
- CUÁNDO: después del saludo inicial, cuando es un cliente nuevo para grabarlo en la base de datos, cuando un usuario te dice datos que no coinciden con los que tienes en tu base de datos, debes de decir "quiere que actualice sus datos" y llamar a la herramienta 'identificarCliente'. 
- Al despedirte llama a 'identificarCliente' para asegurar que grabas sus datos en el sistema.
- PARÁMETROS: Pásale los datos que tengas del usuario, nombre, teléfono, email, notas.

Herramienta: \`checkAvailability\`
- CUÁNDO: Cuando tengas el Servicio, Fecha acordada y los datos del cliente (Nombre, Teléfono, Email). Si la herramienta 'identificarCliente' ya te dio el Nombre y Email, úsalos directamente sin preguntar.
- PARÁMETROS: \`preferred_time\` (en ISO 8601), \`telefono\`, \`nombre\`, \`email\`, \`tipo_servicio\`.
- OBJETIVO: Esta herramienta comprobará la disponibilidad en la agenda y, simultáneamente, guardará o actualizará la ficha del cliente en nuestra base de datos interna. DI LA RESPUESTA VERBALMENTE.

Herramienta: \`transfer_call\`
- CUÁNDO: Si el usuario quiere hablar con José Luis.

## BASE DE CONOCIMIENTOS RÁPIDA
- Ropa recomendada: "Recomendamos traer ropa cómoda, de colores neutros y sin estampados fuertes o logotipos."
- Estilo de fotografía: "José Luis trabaja mucho con luz natural y tiene una gran sensibilidad artística."
- No inventes: Si piden un precio exacto que no sabes, di: "No dispongo de esa tarifa ahora mismo, le dejo una nota a José Luis para que le escriba por WhatsApp con el presupuesto."`
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
            console.log('🛠️ [TOOL CALL] Gemini solicitó agendar:', JSON.stringify(msg.toolCall.functionCalls, null, 2));

            const functionCalls = msg.toolCall.functionCalls;

            // Usamos una función asíncrona autoejecutable para poder usar "await" con n8n
            (async () => {
                const functionResponses = [];

                for (const call of functionCalls) {
                    const args = call.args;

                    if (call.name === 'identificarCliente') {
                        console.log(`[TOOL] Buscar/Actualizar Cliente:`, args);
                        // URL N8N PARA IDENTIFICAR AL CLIENTE
                        const WEBHOOK_IDENTIFICAR = 'https://n8n.ruedia.space/webhook/identificador_cliente';

                        let dataParaGemini = { message: "Cliente no encontrado. Debes pedirle los demás datos." };
                        try {
                            const res = await fetch(WEBHOOK_IDENTIFICAR, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
                            const text = await res.text();
                            console.log('✅ n8n (identificar) respondió:', text);
                            dataParaGemini = { respuestaN8N: text };
                        } catch (e) {
                            console.error('❌ Error n8n (identificar):', e);
                        }

                        functionResponses.push({ id: call.id, name: call.name, response: { result: dataParaGemini } });
                    }

                    if (call.name === 'checkAvailability') {
                        console.log(`[TOOL] Agendando Cita (checkAvailability):`, args);
                        // TU URL ACTUAL PARA GUARDAR LA RESERVA
                        const WEBHOOK_RESERVA = 'https://n8n.ruedia.space/webhook/retell_reservas';

                        let dataParaGemini = { status: "success", respuestaServidor: "Consulta de reserva enviada con éxito." };
                        try {
                            const res = await fetch(WEBHOOK_RESERVA, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
                            const text = await res.text();
                            console.log('✅ n8n (reserva) respondió:', text);
                            dataParaGemini = { respuestaN8N: text };
                        } catch (e) {
                            console.error('❌ Error n8n (reserva):', e);
                        }

                        functionResponses.push({ id: call.id, name: call.name, response: { result: dataParaGemini } });
                    }

                    if (call.name === 'transfer_call') {
                        console.log(`[TOOL] Transfiriendo llamada...`);
                        // URL N8N PARA GESTIONAR EL DESVÍO DE LLAMADA
                        const WEBHOOK_TRANSFERIR = 'https://tu-n8n-url.com/webhook/transferir-llamada';

                        let dataParaGemini = { status: "success", message: "Procediendo a transferir. Despídete del cliente por ahora." };
                        try {
                            const res = await fetch(WEBHOOK_TRANSFERIR, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
                            const text = await res.text();
                            console.log('✅ n8n (transferir) respondió:', text);
                            dataParaGemini = { respuestaN8N: text };
                        } catch (e) {
                            console.error('❌ Error n8n (transferir):', e);
                        }

                        functionResponses.push({ id: call.id, name: call.name, response: { result: dataParaGemini } });
                    }
                }

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
            console.log(`📞 Llamada iniciada: SID=${streamSid}, Número=${callerNumber}`);
            
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
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});