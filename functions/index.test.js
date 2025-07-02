// functions/index.test.js

// --- B. MOCKS (Simulaciones) ---
// Mockeamos las librerías externas para controlar sus respuestas durante los tests.
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  get: mockAxiosGet,
}));

// --- NUEVO: Mocks más específicos y completos para Firestore ---
const mockFirestoreSet = jest.fn();
const mockFirestoreGet = jest.fn(); // Para .doc().get()
const mockFirestoreWhereGet = jest.fn(); // Para .where()...get()
const mockFirestoreCollectionGet = jest.fn(); // Para .collection().get()

jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  firestore: () => ({
    collection: (collectionName) => {
      // Si el código pide la colección 'accommodations', devolvemos un objeto
      // que entiende las funciones .where() y .get() que usamos en el código.
      if (collectionName === 'accommodations') {
        return {
          where: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: mockFirestoreWhereGet,
            })),
          })),
          get: mockFirestoreCollectionGet,
        };
      }
      // Para cualquier otra colección (como 'active_sessions'), devolvemos
      // el mock que entiende .doc().set() y .doc().get().
      return {
        doc: () => ({
          set: mockFirestoreSet,
          get: mockFirestoreGet,
        }),
      };
    },
  }),
  storage: () => ({
    bucket: () => ({
      file: () => ({
        download: jest.fn().mockResolvedValue([Buffer.from('Contenido de archivo estático simulado')]),
      }),
    }),
  }),
}));


const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: jest.fn(() => ({
        getGenerativeModel: () => ({
            generateContent: mockGenerateContent,
        }),
    })),
}));

// --- A. Importamos la función que queremos testear ---
const { dialogflowWebhook } = require('./index');


// --- C. DATOS DE PRUEBA ---
const fakeAccommodationDetails = { data: { data: { name: 'Mar y Montaña Fake', galleryId: '123' } } };
const fakeGalleryDetails = { data: { data: { name: 'Galería Fake', images: [] } } };


// --- D. ESTRUCTURA DE LOS TESTS CON JEST ---
describe('Webhook con Arquitectura de Documento de Sesión', () => {

  let mockResponse;

  beforeEach(() => {
    jest.clearAllMocks();
    mockResponse = {
      status: jest.fn(() => mockResponse),
      json: jest.fn(),
    };
  });

  describe('Caso de Uso 2: Creación de Documento de Alojamiento', () => {
    
    it('Debe llamar a las APIs, construir un documento y guardarlo en Firestore', async () => {
      // 1. Preparamos las respuestas simuladas
      // Simulamos que la búsqueda .where() en Firestore encuentra un resultado
      mockFirestoreWhereGet.mockResolvedValue({
        empty: false,
        docs: [{ data: () => ({ avantio_id: '436145', name: 'Mar y Montaña House by Gloove' }) }]
      });
      
      mockAxiosGet
        .mockResolvedValueOnce(fakeAccommodationDetails)
        .mockResolvedValueOnce(fakeGalleryDetails);

      // 2. Creamos la petición de Dialogflow
      const mockRequest = {
        body: {
          fulfillmentInfo: { tag: 'uc2_get_accommodation_details' },
          sessionInfo: {
            session: 'projects/gloove-chatbot-prod/locations/us-central1/agents/xxx/sessions/test-session-123',
            parameters: { accommodation_name: 'Mar y Montaña House by Gloove' }
          }
        }
      };
      
      // 3. Ejecutamos el webhook
      await dialogflowWebhook(mockRequest, mockResponse);

      // 4. Verificamos
      expect(mockFirestoreWhereGet).toHaveBeenCalledTimes(1);
      expect(mockAxiosGet).toHaveBeenCalledTimes(2); // Se llamó 2 veces a la API de Avantio
      expect(mockFirestoreSet).toHaveBeenCalledTimes(1); // Se guardó 1 documento en Firestore

      const savedDocument = mockFirestoreSet.mock.calls[0][0];
      expect(savedDocument.type).toBe('ACCOMMODATION');
      expect(savedDocument.dynamicData.details.name).toBe('Mar y Montaña Fake');
      expect(savedDocument.staticSchema.accommodation).toBe('Contenido de archivo estático simulado');
      
      const jsonResponse = mockResponse.json.mock.calls[0][0];
      expect(jsonResponse.fulfillment_response.messages[0].text.text[0]).toContain('¡Genial! Tengo la información');
    }, 20000);
  });

  describe('Módulo de IA Generativa con Documento de Sesión', () => {

    it('Debe leer de Firestore, construir un prompt enriquecido y devolver la respuesta de la IA', async () => {
      // 1. Preparamos el documento que simularemos que está en Firestore
      const fakeSessionDocument = {
        type: 'ACCOMMODATION',
        dynamicData: { details: { name: 'Alojamiento desde Firestore' } },
        staticSchema: { accommodation: 'Diccionario de datos aquí' }
      };
      mockFirestoreGet.mockResolvedValue({
        exists: true,
        data: () => fakeSessionDocument
      });

      // 2. Preparamos la respuesta simulada de Gemini
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => 'Respuesta simulada de la IA.'
        }
      });
      
      // 3. Creamos la petición de Dialogflow
      const mockRequest = {
        body: {
          fulfillmentInfo: { tag: 'generative_q_and_a' },
          text: '¿Qué tipo de vistas tiene?',
          sessionInfo: {
            session: 'projects/gloove-chatbot-prod/locations/us-central1/agents/xxx/sessions/test-session-456',
          }
        }
      };

      // 4. Ejecutamos el webhook
      await dialogflowWebhook(mockRequest, mockResponse);

      // 5. Verificamos
      expect(mockFirestoreGet).toHaveBeenCalledTimes(1);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      const promptEnviadoALaIA = mockGenerateContent.mock.calls[0][0];
      expect(promptEnviadoALaIA).toContain('DICCIONARIO DE DATOS');
      expect(promptEnviadoALaIA).toContain('Alojamiento desde Firestore');

      const jsonResponse = mockResponse.json.mock.calls[0][0];
      expect(jsonResponse.fulfillment_response.messages[0].text.text[0]).toBe('Respuesta simulada de la IA.');
    }, 20000);
  });
});