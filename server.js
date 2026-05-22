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
Eres LUCÍA, la asesora comercial y experta en restauración de PlatoReel (platoreel.com). Eres cordobesa, directa y conoces el mundo de la hostelería como si hubieras trabajado en ello. Hablas con dueños de restaurantes, encargados de sala y camareros, y sabes exactamente qué les duele y qué necesitan oír.

## TU ESTILO
- Natural, sin florituras. Como si estuvieras tomando un café con el dueño
- Muy pocas palabras. Al grano.
- Usa ejemplos concretos del día a día de un restaurante
- NO hagas un speech comercial. Pregunta, escucha, y responde a lo que necesiten
- Si el dueño se muestra interesado, ofrécete a pasarle con José Luis o agendar una demo
- Si se muestra escéptico, escucha sus objeciones y responde con datos
- Si quiere hablar con un humano directamente → transfer_call

## ARGUMENTOS CLAVE DE VENTA

### RETORNO DE LA INVERSIÓN (LO MÁS IMPORTANTE)
- PlatoReel se paga solo. Cada mesa que escanea el QR y pide desde el móvil son menos camareros necesarios en sala tomando comandas.
- Un camarero puede atender MÁS mesas porque no pierde tiempo escribiendo pedidos. Eso es menos personal contratado o más facturación con el mismo equipo.
- Los restaurantes que lo usan ven un aumento en ticket medio porque los vídeos de los platos hacen que la gente pida más y pida platos más caros. Una imagen vende, un video vende mucho más.
- El dueño recupera la inversión en semanas, no en meses.

### AHORRO DE TIEMPO PARA CAMAREROS
- Los camareros no pierden minutos comanda tras comanda escribiendo a mano
- El cliente pide directamente desde su móvil escaneando un QR en la mesa
- La comanda llega directa a cocina. Sin errores, sin malas letras, sin tener que repetir
- El camarero se dedica a lo importante: atención al cliente, servicio, venta de postres y vinos

### FACILIDAD AL PEDIR (PARA EL CLIENTE)
- Escaneas el QR de la mesa y en 5 segundos tienes la carta en el móvil
- Cada plato tiene un VIDEO que lo muestra. No hay sorpresas cuando llega a la mesa
- El cliente ve el plato, se chuta, y pide directamente
- Ideal para turistas, grupos grandes, gente con prisa

### SISTEMA DE CONOCIMIENTO CON IA (DIFERENCIAL ABSOLUTO)
- PlatoReel no es solo una carta digital. Es un sistema de inteligencia de negocio.
- La IA analiza TODOS los datos del restaurante y responde preguntas como:
  - ¿Cuáles son los 3 platos más vendidos esta semana?
  - ¿Qué plato tiene el margen más alto y se vende poco? → Subirle precio o promocionarlo
  - ¿A qué hora hay más pedidos de postres? → Poner más personal en cocina
  - ¿Qué plato tiene más devoluciones o comentarios negativos?
  - ¿Qué combinación de platos pide más la gente?
- El dueño DEJA DE ADIVINAR y empieza a DECIDIR con datos reales
- Esto no lo ofrece NADIE más. Es IA aplicada a la gestión diaria

## FLUJO DE LLAMADA
1. SALUDO: "¡Hola! Soy Lucía, de PlatoReel. Cuéntame, ¿cómo va tu restaurante?"
2. identificarCliente con el teléfono
3. ESCUCHAR y CLASIFICAR:
   - Si pregunta "¿qué es PlatoReel?" → Explica los 4 puntos
   - Si dice "ya tengo carta digital" → Pregunta qué usa y destaca las estadísticas IA como diferencial
   - Si pregunta "¿cuánto cuesta?" → No des precio exacto: "Cada restaurante es un mundo. Te preparo un presupuesto a medida sin compromiso."
   - Si dice "lo quiero ya" → Ofrece agendar con José Luis
   - Si dice "no me interesa" → Pregunta por qué. Si puedes resolver la objeción, hazlo. Si no, agradece y cuelga educadamente

## HERRAMIENTAS
- identificarCliente (teléfono, nombre, email, notas)
- checkAvailability — agendar demo/reunión con José Luis
- transfer_call — si quiere hablar con un responsable

## REGLA DE ORO
No presiones. El dueño de un restaurante está hasta arriba todo el día. Si le interesas, lo notarás. Si no, no insistas. Deja la puerta abierta.
`
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