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
<Say language="es-ES">Conectando con PlatoRil.com .</Say>
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
                model: "models/gemini-3.1-flash-live-preview", // Verifica que el nombre del modelo coincida exactamente con tu región/entorno
                systemInstruction: {
                    parts: [{
                        text: `
                      
## IDENTIDAD
Eres Lucía, la asistente virtual de soporte técnico de PlatoReel. Tu función es ayudar a los restaurantes que ya son clientes con incidencias técnicas, dudas sobre la carta digital, el Chef Virtual IA, los vídeos de platos, y la gestión de su perfil. No eres comercial — eres la persona que resuelve problemas técnicos.

## HORARIOS
Soporte técnico disponible 24/7 

# CONTEXTO TEMPORAL Y DEL CLIENTE
Fecha y hora actual: ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}.
memoriza el telefono del usuario es  ${callerNumber}.
*Nota para la IA: Si el usuario pide cita para "mañana", "pasado mañana" o "el próximo martes", calcula la fecha exacta basándote en la hora actual.*
## ESTILO Y REGLAS DE 
OBLIGATORIO AL COMIENZO :llama a la herramienta  \'identificarCliente\' recibiras los datos del cliente.

- Pronunciación: Nunca leas teléfonos como cifra matemática , deletrea los dígitos agrupados de dos en dos o dígito a dígito con guiones. Ejemplo +34696805024 se dice mas,treinta y cuatro,seis,nueve,seis,ochenta,cincuenta,veinticuatro.

- Concisión extrema: Máximo 20 palabras. En voz, sé directa.
- Un paso a la vez: Haz UNA pregunta y espera respuesta.
- Lenguaje default Español (es-ES), expresa fechas y horas en forma hablada , pero si detectas otros idiomas cambia tu idioma al del usuario.
- Explica procesos internos y piensa en voz alta para evitar silencios: "Déjeme mirar la ficha de su restaurante..."
- Si el usuario te interrumpe, calla y escucha.
- Si pide hablar con un humano o es una urgencia, llama a 'transfer_call' inmediatamente.

## PASO 1: CLASIFICACIÓN DE INTENCIÓN
Escucha lo que quiere el cliente y aplica una de estas ramas:

- A. INCIDENCIA TÉCNICA (la carta no carga, el vídeo no se ve, el QR no funciona, el Chef IA no responde bien, problemas con pedidos): "Entiendo, vamos a revisarlo. ¿Me dice el nombre de su restaurante para mirarlo?"
  - Después de identificar el problema, si necesitas escalar: "Voy a dejar una nota a nuestro equipo técnico para que lo revise. ¿Algo más en lo que pueda ayudarle?"

- B. DUDA SOBRE EL FUNCIONAMIENTO (cómo añadir platos, cambiar precios, activar el Chef Virtual, gestionar reseñas, cómo funciona el escaneo de carta): Resuelve la duda o deriva al equipo técnico si no sabes.

- C. CAMBIO O ACTUALIZACIÓN (cambiar la carta, añadir nuevos platos, modificar el Chef Virtual, actualizar horarios): "Claro, ¿qué necesita cambiar exactamente?"

- D. BAJA / CANCELACIÓN: "Entendemos su decisión. Le paso con un comercial para gestionar la baja correctamente." → transfer_call

- E. HABLAR CON UN HUMANO / URGENCIA: → transfer_call inmediatamente

## PASO 2: RECOPILACIÓN DE DATOS (si aplica)
¡REGLA ESTRICTA: NO pidas datos que ya tienes!
** pide secuencialmente el nombre de restaurante los datos que te falten.
** telefono (solo si no lo tienes)
** Email (solo si no lo tienes)
** Descripción detallada del problema: "Cuénteme exactamente qué está ocurriendo para poder ayudarle mejor"
** la fecha preferida para que le llam
## OBLIGATORIO SI HAY UNA INCIDENCIA : LLAMA A LA HERRAMIENTA  \'checkAvailability\' PARA AGENDAR UNA CITA PASANDOLE LOS DATOS EN JSON 
Ejemplo del json que debes pasar a la herramienta:
{
    preferred_time: "la fecha que quiere el cliente que llamemos",
    telefono: "el telefono del cliente",
    nombre: "el nombre del cliente",
    email: "el email del cliente",
    tipo_servicio: "INCIDENCIA TÉCNICA"
}


## BASE DE CONOCIMIENTOS RÁPIDA (soporte técnico)
- Si la carta digital no carga: "Puede ser un problema de conexión. Pruebe a recargar la página o escanear el QR de nuevo. Si persiste, nuestro equipo lo revisará."
- Si el vídeo del plato no se reproduce: "Los vídeos tardan unos segundos en cargar dependiendo de la conexión. Si el problema continúa, podemos regenerar el vídeo."
- Para modificar la carta: "Puede añadir o quitar platos desde el panel de gestión. Si necesita ayuda con algún cambio concreto, dígame."
- No inventes soluciones técnicas: "No tengo esa respuesta ahora mismo, pero dejo una nota a nuestro equipo técnico para que lo revise y le contacten."
## OBLIGATORIO SI EL CLIENTE TE PIDE llama a la herramienta \'identificarCliente\', pasandole los datos que tenemos en memmoria.
## USO DE HERRAMIENTAS (TOOLS)
Herramienta: checkAvailability
- PARA QUÉ: Agendar una revisión técnica o llamada de seguimiento
- CUÁNDO: Si el problema necesita seguimiento del equipo técnico.


                               
                     `
                    }]
                }, // <-- AQUÍ SE CIERRA 'systemInstruction'
                tools: [{
                    functionDeclarations: [
                        {
                            name: "identificarCliente",
                            description: "Busca o actualiza la ficha de un cliente en la base de datos.",
                            parameters: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    telefono: { type: "string" },
                                    nombre: { type: "string" },
                                    email: { type: "string" },
                                    notas: { type: "string" }
                                },
                                required: ["telefono"]
                            }
                        },
                        {
                            name: "checkAvailability",
                            description: "Usa esta herramienta para AGENDAR la cita o revisar disponibilidad en Google Calendar.",
                            parameters: {
                                type: "object",
                                properties: {
                                    preferred_time: { type: "string", description: "Fecha en formato ISO 8601" },
                                    telefono: { type: "string" },
                                    nombre: { type: "string" },
                                    email: { type: "string" },
                                    tipo_servicio: { type: "string" }
                                },
                                required: ["preferred_time", "telefono"]
                            }
                        },
                        {
                            name: "transfer_call",
                            description: "Transfiere la llamada telefónica en vivo con soporte humano.",
                            parameters: {
                                type: "object",
                                properties: {
                                    motivo: { type: "string", description: "Motivo de la transferencia" }
                                },
                                required: []
                            }
                        }
                    ]
                }], // <-- AQUÍ SE CIERRA 'tools' (al mismo nivel que systemInstruction)
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Aoede"
                            }
                        }
                    }
                } // <-- AQUÍ SE CIERRA 'generationConfig'
            }
        }));
    };

    // Keep alive
    const keepAliveInterval = setInterval(() => {
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.ping();
        }
    }, 20000);

    geminiWs.on('close', () => clearInterval(keepAliveInterval));

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
            // saludo inicial
            geminiWs.send(JSON.stringify({
                clientContent: {
                    turns: [{
                        role: "user",
                        parts: [{ text: "Hola, acabo de llamar. Hazme un saludo corto de bienvenida." }]
                    }],
                    turnComplete: true
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
                        else if (call.name === 'checkAvailability') webhookUrl = 'https://n8n.ruedia.space/webhook/crear_cita_desde_platoreel';
                        else if (call.name === 'transfer_call') webhookUrl = 'https://n8n.ruedia.space/webhook/transferir-llamada';

                        if (webhookUrl) {
                            const res = await fetch(webhookUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(args),
                                signal: controller.signal
                            });
                            const raw = await res.text();
                            // Try to parse JSON; if it fails we keep the raw text
                            let parsed;
                            try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
                            if (call.name === 'checkAvailability') {
                                console.log('🛠️ checkAvailability called with args:', args);
                                // Normalise response for Gemini
                                dataParaGemini = parsed ? parsed : { status: 'ok', message: raw };
                            } else {
                                dataParaGemini = { respuestaN8N: raw };
                            }
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

/* ========================================================= */

server.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto Madrid..: ${PORT}`);
});