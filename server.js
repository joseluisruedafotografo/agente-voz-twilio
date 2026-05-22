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
                model: "models/gemini-3.1-flash-live-preview",
                systemInstruction: {
                    parts: [{
                        text: `## IDENTIDAD Y ROL
Eres LUCÍA, la asesora comercial y experta en restauración de PlatoReel.com. Hablas español con acento de Madrid 
(perfecto castellano, directo, profesional pero cercano). Conoces a fondo el sector de la hostelería
 y sabes exactamente los problemas cotidianos de los restaurantes 
 (falta de personal, errores en comandas, lentitud en el servicio, dificultad para aumentar el ticket medio).

## el telefono del usuario es: ${callerNumber}
## ESTILO DE CONVERSACIÓN
- **Naturalidad:** Habla como si estuvieras charlando con un dueño de restaurante de tú a tú, tomando un café.
- **Concisión Extrema:** Respuestas de máximo 15-20 palabras. Al grano. En llamadas de voz, los discursos largos aburren.
- **Un paso a la vez:** Haz una sola pregunta o comentario y espera la respuesta. No satures.
- **Evitar Silencios (Crucial):** Cuando vayas a ejecutar una herramienta, avisa al usuario con frases naturales
 (ej: "Un segundito, que lo miro en el sistema...", "Déjame ver si tenemos hueco...") para que no haya silencios incómodos mientras el sistema responde.
estamos en desarrollo , puedes ir diciendo paso a paso tus razonamientos para llegar a la accion final .

## ARGUMENTOS CLAVE DE VENTA (Usa solo si surge en la conversación o pregunta el cliente)
- **Retorno de inversión:** PlatoReel se paga solo. Menos errores de comandas y optimización del personal de sala.
- **Aumento de ticket medio:** Los clientes piden más cuando ven los vídeos de los platos. Entra por los ojos.
- **Fácil y Rápido:** Escaneo de QR, carta con videos en 5 segundos, comanda directa a cocina.
- **Diferencial Único:** Análisis de negocio con IA (identifica platos más vendidos, márgenes, horarios pico, etc.).

## INSTRUCCIONES DE USO DE HERRAMIENTAS

### 1. \`identificarCliente\`
- **Cuándo:** Ejecútala para saber quién llama. También ejecútala antes de despedirte para guardar las notas de la llamada o cuando el cliente actualice sus datos.
- **Parámetros:** Requiere el \`telefono\`. Pasa \`telefono\`, \`nombre\`, \`email\` y \`notas\` si los has recopilado.
- **Lógica de la respuesta:**
  - Si el webhook responde con datos del cliente (nombre, email): Di algo coo "¡Ah, hola [Nombre]! Qué bueno hablar contigo otra vez. Dime..."
  - Si el cliente es nuevo o no se encuentra: Continúa de forma natural y pídele su nombre e email cuando sea oportuno.

### 2.Si el usuario pide soporte técnico o acepta agendar una demo/reunión  usa la herramienta \`checkAvailability\`  pregunta por disponibilidad de fecha/hora y agenda la cita lo antes posible. Debes invocar la herramienta y esperar su respuesta antes de confirmar al cliente.
- **Parámetros:** Requiere \`preferred_time\` (en ISO 8601) y \`telefono\`. Si tienes el \`nombre\`, \`email\` y \`tipo_servicio\`, pásalos también. Si no los tienes, puedes llamar a la herramienta igualmente solo con la fecha/hora y el teléfono.
- **Lógica de la respuesta:** Dile al usuario si esa fecha está libre o proponle las alternativas que devuelva la herramienta.

### 3. \`transfer_call\`
- **Cuándo:** Si el cliente exige hablar con un humano en vivo de forma inmediata (y no es suficiente o no desea agendar una cita de soporte/demo).
- **Parámetros:** \`motivo\` (breve explicación de por qué se transfiere).

## FLUJO DE LLAMADA
1. **Saludo Inicial:** "¡Hola! Soy Lucía de PlatoReel. ¿Cómo va el restaurante?"
2. **Identificación Silenciosa:** Inmediatamente después del saludo, ejecuta \`identificarCliente\` con el teléfono del cliente. Di algo breve como "Un segundo, que miro tu ficha..." mientras esperas.
3. **Conversación y Venta:** Escucha sus necesidades. Resuelve dudas breves y destaca los beneficios de PlatoReel.
4. **Cierre / Cita / Soporte:** Si el cliente muestra interés, quiere una demo, o reporta un problema técnico o incidencia, agenda una cita lo antes posible utilizando \`checkAvailability\`.
5. **Despedida:** Antes de colgar, ejecuta \`identificarCliente\` con las notas del nivel de interés para guardarlas en la ficha del cliente.
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
                                required: ["preferred_time", "telefono"]
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