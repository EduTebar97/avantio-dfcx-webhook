// functions/index.js

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const Fuse = require("fuse.js");

// Usamos la librería para la API de Google AI Studio
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- INICIALIZACIÓN GLOBAL ---
// Inicializamos la app con la configuración para que el emulador funcione correctamente
admin.initializeApp({
  projectId: "gloove-chatbot-prod",
  storageBucket: "gloove-chatbot-prod.appspot.com"
});


const db = admin.firestore();
const storage = admin.storage().bucket();

// --- Claves y URLs ---
const AVANTIO_AUTH_TOKEN = 'RzRV86mDe8h0EziTJzG5AzFN4TlbE7a1';
const AVANTIO_API_BASE_URL = 'https://api.avantio.pro/pms/v2';


// --- INICIO DE LA SECCIÓN DE PRUEBA RÁPIDA (INSEGURA) ---
//
//      ADVERTENCIA: NO USAR EN PRODUCCIÓN.
//      La API Key está escrita directamente aquí para una prueba rápida.
//      ¡RECUERDA QUITARLA ANTES DE TERMINAR!
//
const geminiApiKey = "AIzaSyCpo6IyOQwIXiVBGaKLpQbWdKwujhriSoI"; // <-- REEMPLAZA ESTO CON TU NUEVA CLAVE
//
// --- FIN DE LA SECCIÓN DE PRUEBA RÁPIDA ---


// Inicialización del cliente de Gemini con la API Key escrita arriba
const genAI = new GoogleGenerativeAI(geminiApiKey);
const generativeModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });


// --- FUNCIONES DE AYUDA (Sin cambios) ---
function addTextMessage(messagesArray, text) {
    messagesArray.push({ text: { text: [text] } });
}
function addSuggestionChips(messagesArray, chipsOptions) {
    messagesArray.push({ payload: { richContent: [[{ type: "chips", options: chipsOptions }]] } });
}

// --- WEBHOOK PRINCIPAL (Sin cambios en la lógica) ---
exports.dialogflowWebhook = functions.https.onRequest(async (req, res) => {
    const startTime = Date.now();
    const tag = req.body.fulfillmentInfo?.tag;
    console.log(`[+${Date.now() - startTime}ms] --- Webhook execution started. Tag: ${tag} ---`);

    const sessionParams = req.body.sessionInfo?.parameters || {};
    const messagesToSend = [];
    let updatedSessionParams = {};

    try {
        if (tag === "uc2_get_accommodation_details") {
            const nameInput = sessionParams.accommodation_name;
            if (!nameInput) {
                addTextMessage(messagesToSend, "Por favor, dime el nombre del alojamiento que te interesa.");
            } else {
                const norm = nameInput.trim().toLowerCase();
                let accId = null, accName = "";
                const snap = await db.collection("accommodations").where("nombre_normalizado", "==", norm).limit(1).get();
                if (!snap.empty) {
                    accId = snap.docs[0].data().avantio_id;
                    accName = snap.docs[0].data().name;
                } else {
                    const all = await db.collection("accommodations").get();
                    const list = all.docs.map(d => d.data());
                    const fuse = new Fuse(list, { keys: ["name", "nombre_normalizado"], threshold: 0.4 });
                    const result = fuse.search(nameInput);
                    if (result.length) {
                        accId = result[0].item.avantio_id;
                        accName = result[0].item.name;
                    }
                }
                if (!accId) {
                    addTextMessage(messagesToSend, `Lo siento, no he encontrado ningún alojamiento que se parezca a "${nameInput}".`);
                } else {
                    const response = await axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN }, timeout: 15000 });
                    const details = response.data.data;
                    let context = `Nombre del alojamiento: ${details.name}. Tipo: ${details.type}. Ubicación: ${details.location.address}, ${details.location.cityName}. Capacidad: ${details.capacity.maxAdults} adultos. `;
                    const hasPool = details.services.some(s => s.type === 'SWIMMING_POOL');
                    context += `Piscina: ${hasPool ? 'Sí.' : 'No.'}. `;
                    const hasWifi = details.services.some(s => s.type === 'INTERNET_ACCESS');
                    context += `WiFi: ${hasWifi ? 'Sí.' : 'No.'}. `;
                    updatedSessionParams.generative_context = context;
                    updatedSessionParams.id_alojamiento_actual = accId;
                    addTextMessage(messagesToSend, `¡Genial! Tengo la información sobre "${accName}". ¿En qué puedo ayudarte?`);
                }
            }
        }
        else if (tag === "uc3_get_booking_details") {
            const bookingId = sessionParams.booking_id;
            if (!bookingId) {
                addTextMessage(messagesToSend, "Para ayudarte, necesito tu localizador o ID de reserva.");
            } else {
                try {
                    const { data: { data: b } } = await axios.get(`${AVANTIO_API_BASE_URL}/bookings/${bookingId}`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN }, timeout: 15000 });
                    const accId = b.accommodation.id;
                    const customer = `${b.customer.name} ${b.customer.surnames.join(" ")}`;
                    const [{ data: { data: details } }, fileBuf] = await Promise.all([
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN }, timeout: 15000 }),
                        storage.file(`${accId}.txt`).download().catch(() => null)
                    ]);
                    const staticCtx = fileBuf ? fileBuf[0].toString('utf8') : "";
                    let context = `Resumen de la reserva para ${customer} (ID: ${bookingId}):\n`;
                    context += `- Fechas: Desde ${b.stayDates.arrival} hasta ${b.stayDates.departure}.\n`;
                    context += `- Estado de la Reserva: ${b.status}.\n`;
                    context += `- Alojamiento: ${details.name}, ubicado en ${details.location.cityName}.\n`;
                    const hasPool = details.services.some(s => s.type === 'SWIMMING_POOL');
                    context += `- El alojamiento tiene piscina: ${hasPool ? 'Sí.' : 'No.'}.\n`;
                    if (staticCtx) context += `- Instrucciones Adicionales: ${staticCtx}`;
                    updatedSessionParams.generative_context = context;
                    updatedSessionParams.booking_found = true;
                    updatedSessionParams.customer_name = customer;
                } catch (err) {
                    if (err.response?.status === 404) { updatedSessionParams.booking_found = false; } else { throw err; }
                }
            }
        }
        else if (tag === "construir_mensaje_confirmacion") {
            if (!sessionParams.booking_found) {
                addTextMessage(messagesToSend, "No encontré ninguna reserva con ese código. Por favor, verifícalo.");
            } else {
                const texto = `Gracias. He encontrado una reserva a nombre de ${sessionParams.customer_name}. Para confirmar, ¿eres tú?`;
                addTextMessage(messagesToSend, texto);
                addSuggestionChips(messagesToSend, [{ text: "Sí" }, { text: "No" }]);
            }
        }
        else if (tag === "construir_saludo_pregunta_abierta") {
            const cust = sessionParams.customer_name || "de nuevo";
            addTextMessage(messagesToSend, `¡Perfecto, ${cust}! Soy Gloovito. ¿En qué puedo ayudarte hoy sobre tu reserva?`);
        }
        else if (tag === "generative_q_and_a") {
            const userQuery = req.body.text;
            const context = sessionParams.generative_context;
            if (!context) {
                addTextMessage(messagesToSend, "Lo siento, no tengo un contexto sobre el cual responder.");
            } else {
                const prompt = `Eres Gloovito, un asistente virtual experto. Tu tarea es responder la PREGUNTA DEL USUARIO usando únicamente la información del CONTEXTO. Sé breve y amigable. Si la respuesta no está en el CONTEXTO, responde: "No dispongo de ese dato en concreto."\n\n---CONTEXTO:\n${context}\n\n---PREGUNTA DEL USUARIO:\n${userQuery}\n\n---RESPUESTA:`;

                console.log(`[+${Date.now() - startTime}ms] Google AI Start: Calling generativeModel.generateContent`);

                const result = await generativeModel.generateContent(prompt);
                const response = await result.response;
                const text = response.text();

                console.log(`[+${Date.now() - startTime}ms] Google AI End. Response: ${text}`);
                addTextMessage(messagesToSend, text);
            }
        }
        else {
            addTextMessage(messagesToSend, "Lo siento, ha habido un problema y no he reconocido la acción solicitada.");
        }
    } catch (error) {
        console.error(`[+${Date.now() - startTime}ms] ---!! CRITICAL ERROR CAUGHT !!---`);
        functions.logger.error("Error crítico en el webhook:", { errorMessage: error.message, errorStack: error.stack, errorResponse: error.response?.data });
        addTextMessage(messagesToSend, "Uups, parece que he tenido un problema técnico.");
    }

    const endTime = Date.now();
    console.log(`[+${endTime - startTime}ms] --- Webhook execution finished. Total time: ${endTime - startTime}ms ---`);

    res.status(200).json({
        fulfillment_response: { messages: messagesToSend },
        session_info: { parameters: { ...sessionParams, ...updatedSessionParams } }
    });
});