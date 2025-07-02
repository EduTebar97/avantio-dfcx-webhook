// functions/index.js

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const Fuse = require("fuse.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- INICIALIZACIÓN GLOBAL ---
admin.initializeApp({
  projectId: "gloove-chatbot-prod",
  storageBucket: "gloove-chatbot-prod.firebasestorage.app"
});

const db = admin.firestore();
const storage = admin.storage().bucket("gloove-chatbot-prod.firebasestorage.app");

// --- Claves y URLs ---
const AVANTIO_AUTH_TOKEN = 'RzRV86mDe8h0EziTJzG5AzFN4TlbE7a1';
const AVANTIO_API_BASE_URL = 'https://api.avantio.pro/pms/v2';
const geminiApiKey = "AIzaSyCpo6IyOQwIXiVBGaKLpQbWdKwujhriSoI";

// Inicialización del cliente de Gemini
const genAI = new GoogleGenerativeAI(geminiApiKey);
const generativeModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- FUNCIONES DE AYUDA ---
function addTextMessage(messagesArray, text) {
    messagesArray.push({ text: { text: [text] } });
}

// ==================================================================================
// --- WEBHOOK PRINCIPAL ---
// ==================================================================================
exports.dialogflowWebhook = functions.runWith({timeoutSeconds: 120}).https.onRequest(async (req, res) => {
    const startTime = Date.now();
    const tag = req.body.fulfillmentInfo?.tag;
    const sessionId = req.body.sessionInfo.session.split('/').pop();
    
    console.log(`[+${Date.now() - startTime}ms] --- Webhook execution started. Tag: ${tag}, Session: ${sessionId} ---`);

    const sessionParams = req.body.sessionInfo?.parameters || {};
    const messagesToSend = [];
    let updatedSessionParams = {};

    try {
        if (tag === "uc2_get_accommodation_details") {
            const nameInput = sessionParams.accommodation_name;
            if (!nameInput) {
                addTextMessage(messagesToSend, "Por favor, dime el nombre del alojamiento que te interesa.");
            } else {
                let accId = null, accName = "";
                const norm = nameInput.trim().toLowerCase();
                const snap = await db.collection("accommodations").where("nombre_normalizado", "==", norm).limit(1).get();
                if (!snap.empty) {
                    accId = snap.docs[0].data().avantio_id;
                    accName = snap.docs[0].data().name;
                } else {
                    const all = await db.collection("accommodations").get();
                    const list = all.docs.map(d => d.data());
                    const fuse = new Fuse(list, { keys: ["name", "nombre_normalizado"], threshold: 0.4 });
                    const result = fuse.search(nameInput);
                    if (result.length) { accId = result[0].item.avantio_id; accName = result[0].item.name; }
                }

                if (!accId) {
                    addTextMessage(messagesToSend, `Lo siento, no he encontrado ningún alojamiento que se parezca a "${nameInput}".`);
                } else {
                    console.log(`[+${Date.now() - startTime}ms] Fetching full document for accommodation ${accId}`);
                    const [ accommodationResponse, galleryResponse, schemaAccommodationFile, schemaGalleryFile ] = await Promise.all([
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN } }),
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}/gallery`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN } }),
                        storage.file('Descripcion_Entpoints_avantio/Respuesta get Accomodattion.txt').download(),
                        storage.file('Descripcion_Entpoints_avantio/Respuesta Get Accomodattion Gallery.txt').download()
                    ]);
                    const fullDocument = {
                        type: 'ACCOMMODATION',
                        dynamicData: { details: accommodationResponse.data.data, gallery: galleryResponse.data.data },
                        staticSchema: { accommodation: schemaAccommodationFile[0].toString('utf8'), gallery: schemaGalleryFile[0].toString('utf8') },
                        retrievedAt: new Date()
                    };
                    await db.collection('active_sessions').doc(sessionId).set(fullDocument);
                    console.log(`[+${Date.now() - startTime}ms] Enriched session document saved for ${sessionId}`);
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
                    const { data: { data: bookingDetails } } = await axios.get(`${AVANTIO_API_BASE_URL}/bookings/${bookingId}`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN } });
                    const accId = bookingDetails.accommodation.id;
                    const customer = `${bookingDetails.customer.name} ${bookingDetails.customer.surnames.join(" ")}`;
                    console.log(`[+${Date.now() - startTime}ms] Fetching full document for booking ${bookingId}`);
                    const [ accommodationResponse, galleryResponse, instructionsFile, schemaAccommodationFile, schemaGalleryFile, schemaBookingFile ] = await Promise.all([
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN } }),
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accId}/gallery`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN } }),
                        storage.file(`${accId}.txt`).download().catch(() => null),
                        storage.file('Descripcion_Entpoints_avantio/Respuesta get Accomodattion.txt').download(),
                        storage.file('Descripcion_Entpoints_avantio/Respuesta Get Accomodattion Gallery.txt').download(),
                        storage.file('Descripcion_Entpoints_avantio/Respuesta Get Booking.txt').download()
                    ]);
                    const fullDocument = {
                        type: 'BOOKING',
                        dynamicData: {
                            booking: bookingDetails,
                            details: accommodationResponse.data.data,
                            gallery: galleryResponse.data.data,
                            instructions: instructionsFile ? instructionsFile[0].toString('utf8') : "No hay instrucciones adicionales.",
                        },
                        staticSchema: {
                            accommodation: schemaAccommodationFile[0].toString('utf8'),
                            gallery: schemaGalleryFile[0].toString('utf8'),
                            booking: schemaBookingFile[0].toString('utf8')
                        },
                        retrievedAt: new Date()
                    };
                    await db.collection('active_sessions').doc(sessionId).set(fullDocument);
                    console.log(`[+${Date.now() - startTime}ms] Enriched session document saved for ${sessionId}`);
                    updatedSessionParams.booking_found = true;
                    updatedSessionParams.customer_name = customer;
                } catch (err) {
                    if (err.response?.status === 404) { updatedSessionParams.booking_found = false; } else { throw err; }
                }
            }
        }
        else if (tag === "uc1_search_accommodations") {
            console.log(`[+${Date.now() - startTime}ms] UC-1: Search execution started. Params:`, JSON.stringify(sessionParams));

            const { tipo_vivienda, 'geo-city': geoCity, num_personas, num_habitaciones, caracteristica: caracteristicas, fecha_periodo } = sessionParams;

            let query = db.collection('accommodations_index');

            if (tipo_vivienda) query = query.where('tipo_propiedad', '==', tipo_vivienda);
            if (geoCity && geoCity.original) query = query.where('ubicacion_ciudad', '==', geoCity.original);
            if (num_personas) query = query.where('capacidad_maxima', '>=', num_personas);
            if (num_habitaciones) query = query.where('num_habitaciones', '>=', num_habitaciones);
            if (caracteristicas && caracteristicas.length > 0) {
                caracteristicas.forEach(feature => { query = query.where('caracteristicas_principales', 'array-contains', feature); });
            }

            const snapshot = await query.limit(20).get();

            if (snapshot.empty) {
                addTextMessage(messagesToSend, "Lo siento, no he encontrado ningún alojamiento que cumpla con todos esos criterios. ¿Quieres intentar con una búsqueda más sencilla?");
            } else {
                let candidates = snapshot.docs.map(doc => doc.data());
                let finalResults = candidates;

                if (fecha_periodo && fecha_periodo.startDate && fecha_periodo.endDate) {
                    const userStartDate = new Date(Date.UTC(fecha_periodo.startDate.year, fecha_periodo.startDate.month - 1, fecha_periodo.startDate.day));
                    const userEndDate = new Date(Date.UTC(fecha_periodo.endDate.year, fecha_periodo.endDate.month - 1, fecha_periodo.endDate.day));

                    console.log(`[+${Date.now() - startTime}ms] Checking availability for ${candidates.length} candidates from ${userStartDate.toISOString().split('T')[0]} to ${userEndDate.toISOString().split('T')[0]}`);
                    
                    const availabilityPromises = candidates.map(accommodation => 
                        axios.get(`${AVANTIO_API_BASE_URL}/accommodations/${accommodation.avantio_id}/availabilities`, { headers: { "X-Avantio-Auth": AVANTIO_AUTH_TOKEN } })
                             .then(response => ({ id: accommodation.avantio_id, success: true, data: response.data.data }))
                             .catch(error => ({ id: accommodation.avantio_id, success: false, error: error.message }))
                    );
                    
                    const availabilityResponses = await Promise.all(availabilityPromises);

                    const availableIds = new Set();
                    for (const res of availabilityResponses) {
                        if (!res.success || !res.data || res.data.length === 0) continue;

                        const isAvailableForPeriod = res.data.some(period => {
                            if (period.status !== 'AVAILABLE') return false;
                            const periodStart = new Date(period.from);
                            const periodEnd = new Date(period.to);
                            return userStartDate <= periodEnd && userEndDate >= periodStart;
                        });

                        if (isAvailableForPeriod) {
                            availableIds.add(res.id);
                        }
                    }
                    finalResults = candidates.filter(c => availableIds.has(c.avantio_id));
                }

                if (finalResults.length === 0) {
                    addTextMessage(messagesToSend, "He encontrado alojamientos que encajan, pero ninguno está disponible en las fechas que me has indicado. ¿Quieres probar con otras fechas?");
                } else {
                    console.log(`[+${Date.now() - startTime}ms] Found ${finalResults.length} available accommodations.`);
                    const searchContext = { type: 'SEARCH_RESULTS', results: finalResults, retrievedAt: new Date() };
                    await db.collection('active_sessions').doc(sessionId).set(searchContext);
                    console.log(`[+${Date.now() - startTime}ms] Search results saved to session ${sessionId}.`);
                    
                    const resultsForAI = finalResults.map(r => ({ nombre: r.nombre, ubicacion: r.ubicacion_ciudad, capacidad: r.capacidad_maxima, caracteristicas: r.caracteristicas_principales.join(', ') })).slice(0, 3);
                    const prompt = `Eres un asistente de viajes. Has encontrado ${finalResults.length} alojamientos disponibles para un cliente. Resume brevemente las primeras opciones de esta lista para presentárselas de forma atractiva. Menciona el nombre, la ubicación y alguna característica destacada. Termina preguntando en qué más puedes ayudar o si quieren ver más detalles de alguna.\n\nResultados:\n${JSON.stringify(resultsForAI, null, 2)}`;
                    
                    const result = await generativeModel.generateContent(prompt);
                    const response = await result.response;
                    addTextMessage(messagesToSend, response.text());
                }
            }
        }
        else if (tag === "construir_mensaje_confirmacion") {
             if (!sessionParams.booking_found) { addTextMessage(messagesToSend, "No encontré ninguna reserva con ese código. Por favor, verifícalo."); } else { const texto = `Gracias. He encontrado una reserva a nombre de ${sessionParams.customer_name}. Para confirmar, ¿eres tú?`; addTextMessage(messagesToSend, texto); }
        }
        else if (tag === "construir_saludo_pregunta_abierta") {
             const cust = sessionParams.customer_name || "de nuevo"; addTextMessage(messagesToSend, `¡Perfecto, ${cust}! Soy Gloovito. ¿En qué puedo ayudarte hoy sobre tu reserva?`);
        }
        else if (tag === "generative_q_and_a") {
            const userQuery = req.body.text;
            const sessionDoc = await db.collection('active_sessions').doc(sessionId).get();
            if (!sessionDoc.exists) {
                addTextMessage(messagesToSend, "Lo siento, parece que tu sesión ha expirado o no he encontrado información. ¿Podrías indicarme sobre qué alojamiento o reserva quieres preguntar de nuevo?");
            } else {
                const fullContextDocument = sessionDoc.data();
                let prompt = "";
                if (fullContextDocument.type === 'SEARCH_RESULTS') {
                    const dynamicContext = `DATOS DE LA BÚSQUEDA (en formato JSON):\n\n${JSON.stringify(fullContextDocument.results, null, 2)}`;
                    prompt = `Eres Gloovito, un asistente experto. Un usuario ha realizado una búsqueda y estos son los resultados. Ahora te está haciendo una pregunta de seguimiento sobre ellos. Usa los datos del contexto para responder. Si te pide tu opinión ("cuál es mejor"), sé objetivo y compara características. Si te pide algo que no está en los datos, responde "No dispongo de ese dato en concreto."\n\n---CONTEXTO:\n${dynamicContext}\n\n---PREGUNTA DEL USUARIO:\n${userQuery}\n\n---RESPUESTA:`;
                } else {
                    const schemaString = Object.values(fullContextDocument.staticSchema).join('\n\n---\n\n');
                    const staticContext = `DICCIONARIO DE DATOS (Significado de los campos):\n\n${schemaString}`;
                    const dynamicContext = `DATOS ESPECÍFICOS DE LA CONSULTA ACTUAL (en formato JSON):\n\n${JSON.stringify(fullContextDocument.dynamicData, null, 2)}`;
                    prompt = `Eres Gloovito, un asistente virtual experto. Tu tarea es responder la PREGUNTA DEL USUARIO. Para ello, tienes dos piezas de información: un DICCIONARIO DE DATOS que explica qué significa cada campo, y los DATOS ESPECÍFICOS de la consulta actual. Usa el diccionario para entender los datos y dar una respuesta amable y completa. Si la información no está explícitamente en el documento, responde: "No dispongo de ese dato en concreto."\n\n---${staticContext}\n\n---${dynamicContext}\n\n---PREGUNTA DEL USUARIO:\n${userQuery}\n\n---RESPUESTA:`;
                }
                console.log(`[+${Date.now() - startTime}ms] Google AI Start: Calling generativeModel.generateContent with context type: ${fullContextDocument.type}`);
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
        session_info: { parameters: { ...req.body.sessionInfo.parameters, ...updatedSessionParams } }
    });
});