// functions/index.js

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const Fuse = require("fuse.js");

// Usamos la librería para la API de Google AI Studio
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- INICIALIZACIÓN GLOBAL ---
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
const geminiApiKey = "AIzaSyCpo6IyOQwIXiVBGaKLpQbWdKwujhriSoI"; // <-- RECUERDA CAMBIAR ESTO POR LA LECTURA DE CONFIG DE FIREBASE
// --- FIN DE LA SECCIÓN DE PRUEBA RÁPIDA ---

// Inicialización del cliente de Gemini
const genAI = new GoogleGenerativeAI(geminiApiKey);
const generativeModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- FUNCIONES DE AYUDA (Sin cambios) ---
function addTextMessage(messagesArray, text) {
    messagesArray.push({ text: { text: [text] } });
}
function addSuggestionChips(messagesArray, chipsOptions) {
    messagesArray.push({ payload: { richContent: [[{ type: "chips", options: chipsOptions }]] } });
}

// --- WEBHOOK PRINCIPAL ---
exports.dialogflowWebhook = functions.https.onRequest(async (req, res) => {
    const startTime = Date.now();
    const tag = req.body.fulfillmentInfo?.tag;
    // --- NUEVO: Extraemos el ID de sesión para usarlo como clave ---
    const sessionId = req.body.sessionInfo.session.split('/').pop();
    
    console.log(`[+${Date.now() - startTime}ms] --- Webhook execution started. Tag: ${tag}, Session: ${sessionId} ---`);

    const sessionParams = req.body.sessionInfo?.parameters || {};
    const messagesToSend = [];
    let updatedSessionParams = {};

    try {
        // --- MODIFICADO: Lógica para construir el documento de sesión del alojamiento ---
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
                    // --- NUEVO: Hacemos todas las llamadas a la API en paralelo ---
                    console.log(`[+${Date.now() - startTime}ms] Fetching full document for accommodation ${accId}`);
                    const [accommodationResponse, galleryResponse] = await Promise.all([
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN }, timeout: 15000 }),
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}/gallery`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN }, timeout: 15000 })
                    ]);

                    const fullDocument = {
                        type: 'ACCOMMODATION',
                        details: accommodationResponse.data.data,
                        gallery: galleryResponse.data.data,
                        retrievedAt: new Date()
                    };

                    // --- NUEVO: Guardamos el documento completo en Firestore usando el ID de sesión ---
                    await db.collection('active_sessions').doc(sessionId).set(fullDocument);
                    console.log(`[+${Date.now() - startTime}ms] Session document saved for ${sessionId}`);
                    
                    // Ya no pasamos el `generative_context`. Solo un mensaje de saludo.
                    addTextMessage(messagesToSend, `¡Genial! Tengo la información sobre "${accName}". ¿En qué puedo ayudarte?`);
                }
            }
        }
        // --- MODIFICADO: Lógica para construir el documento de sesión de la reserva ---
        else if (tag === "uc3_get_booking_details") {
            const bookingId = sessionParams.booking_id;
            if (!bookingId) {
                addTextMessage(messagesToSend, "Para ayudarte, necesito tu localizador o ID de reserva.");
            } else {
                try {
                    const { data: { data: bookingDetails } } = await axios.get(`${AVANTIO_API_BASE_URL}/bookings/${bookingId}`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN }, timeout: 15000 });
                    
                    const accId = bookingDetails.accommodation.id;
                    const customer = `${bookingDetails.customer.name} ${bookingDetails.customer.surnames.join(" ")}`;
                    
                    console.log(`[+${Date.now() - startTime}ms] Fetching full document for booking ${bookingId}`);
                    const [accommodationResponse, galleryResponse, instructionsFile] = await Promise.all([
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN }, timeout: 15000 }),
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}/gallery`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN }, timeout: 15000 }),
                        storage.file(`${accId}.txt`).download().catch(() => null)
                    ]);

                    const fullDocument = {
                        type: 'BOOKING',
                        booking: bookingDetails,
                        details: accommodationResponse.data.data,
                        gallery: galleryResponse.data.data,
                        instructions: instructionsFile ? instructionsFile[0].toString('utf8') : "No hay instrucciones adicionales.",
                        retrievedAt: new Date()
                    };
                    
                    // --- NUEVO: Guardamos el documento completo en Firestore ---
                    await db.collection('active_sessions').doc(sessionId).set(fullDocument);
                    console.log(`[+${Date.now() - startTime}ms] Session document saved for ${sessionId}`);

                    // Aún necesitamos estos parámetros para el siguiente paso del flujo
                    updatedSessionParams.booking_found = true;
                    updatedSessionParams.customer_name = customer;
                } catch (err) {
                    if (err.response?.status === 404) { updatedSessionParams.booking_found = false; } else { throw err; }
                }
            }
        }
        // --- SIN CAMBIOS en los tags de apoyo ---
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
        // --- MODIFICADO: El tag de IA ahora lee el documento de sesión de Firestore ---
        else if (tag === "generative_q_and_a") {
            const userQuery = req.body.text;

            // --- NUEVO: Leemos el documento de la sesión actual desde Firestore ---
            const sessionDoc = await db.collection('active_sessions').doc(sessionId).get();

            if (!sessionDoc.exists) {
                addTextMessage(messagesToSend, "Lo siento, parece que tu sesión ha expirado o no he encontrado información sobre un alojamiento. ¿Podrías indicarme sobre qué alojamiento o reserva quieres preguntar?");
            } else {
                const fullContextDocument = sessionDoc.data();
                // Convertimos el objeto JSON completo en un string para que la IA lo pueda leer.
                const contextForAI = JSON.stringify(fullContextDocument, null, 2);

                const prompt = `Eres Gloovito, un asistente virtual experto en alquileres vacacionales. Tu tarea es responder la PREGUNTA DEL USUARIO usando únicamente la información del siguiente documento JSON en el CONTEXTO. Responde de forma amable y concisa. Si la información no está explícitamente en el documento, responde: "No dispongo de ese dato en concreto."\n\n---CONTEXTO (en formato JSON):\n${contextForAI}\n\n---PREGUNTA DEL USUARIO:\n${userQuery}\n\n---RESPUESTA:`;

                console.log(`[+${Date.now() - startTime}ms] Google AI Start: Calling generativeModel.generateContent with full session document`);

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