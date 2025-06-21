// functions/index.test.js

// Importamos la función que queremos testear
const { dialogflowWebhook } = require('./index');

// --- SIMULACIÓN DE PETICIONES (REQUESTS) DE DIALOGFLOW ---

const mockRequestAlojamiento = {
  body: {
    fulfillmentInfo: { tag: 'uc2_get_accommodation_details' },
    sessionInfo: { parameters: { accommodation_name: 'Mar y Montaña House by Gloove' } }
  }
};
const mockRequestAlojamientoNoExiste = {
  body: {
    fulfillmentInfo: { tag: 'uc2_get_accommodation_details' },
    sessionInfo: { parameters: { accommodation_name: 'Villa Fantasma' } }
  }
};
const mockRequestReserva = {
  body: {
    fulfillmentInfo: { tag: 'uc3_get_booking_details' },
    sessionInfo: { parameters: { booking_id: '17719520' } }
  }
};
const mockRequestReservaNoExiste = {
  body: {
    fulfillmentInfo: { tag: 'uc3_get_booking_details' },
    sessionInfo: { parameters: { booking_id: '999999' } }
  }
};
const mockSessionParamsConReserva = {
  booking_found: true,
  customer_name: 'Elżbieta Kowalska',
};
const mockRequestGenerativo = {
    body: {
      text: '¿El alojamiento tiene piscina?', // Simula la pregunta del usuario
      fulfillmentInfo: { tag: 'generative_q_and_a' },
      sessionInfo: {
        parameters: {
          // Simula el contexto que el webhook preparó en un paso anterior
          generative_context: 'Nombre del alojamiento: Casa Playa Perfecta. Capacidad: 4 adultos. Piscina: Sí, privada. WiFi: Sí.'
        }
      }
    }
  };


// --- ESTRUCTURA DE LOS TESTS CON JEST ---

describe('Webhook End-to-End Logic Tests', () => {

  let mockResponse;
  beforeEach(() => {
    mockResponse = {
      status: jest.fn(() => mockResponse),
      json: jest.fn(),
    };
  });

  // --- Tests para el Flujo de Alojamiento ---
  describe('Caso de Uso 2: Consulta de Alojamiento', () => {
    it('Debe encontrar un alojamiento y devolver el contexto preparado', async () => {
      await dialogflowWebhook(mockRequestAlojamiento, mockResponse);
      const jsonResponse = mockResponse.json.mock.calls[0][0];

      console.log('UC2 Response (Success):', JSON.stringify(jsonResponse, null, 2));
      
      expect(jsonResponse.fulfillment_response.messages[0].text.text[0]).toContain('¡Genial! Tengo la información');
      expect(jsonResponse.session_info.parameters.generative_context).toContain('Piscina: Sí.');
    }, 20000); // Timeout extendido

    it('Debe devolver un mensaje de error si el alojamiento no se encuentra', async () => {
        await dialogflowWebhook(mockRequestAlojamientoNoExiste, mockResponse);
        const jsonResponse = mockResponse.json.mock.calls[0][0];
        console.log('UC2 Response (Not Found):', JSON.stringify(jsonResponse, null, 2));
        expect(jsonResponse.fulfillment_response.messages[0].text.text[0]).toContain('Lo siento, no he encontrado');
    });
  });

  // --- Tests para el Flujo de Reserva ---
  describe('Caso de Uso 3: Consulta de Reserva', () => {
    it('Debe encontrar una reserva y preparar el contexto', async () => {
      await dialogflowWebhook(mockRequestReserva, mockResponse);
      const jsonResponse = mockResponse.json.mock.calls[0][0];
      console.log('UC3 Response (Success):', JSON.stringify(jsonResponse, null, 2));
      expect(jsonResponse.fulfillment_response.messages.length).toBe(0);
      expect(jsonResponse.session_info.parameters.booking_found).toBe(true);
      expect(jsonResponse.session_info.parameters.customer_name).toBe('Elżbieta Kowalska');
    }, 20000); // Timeout extendido

    it('Debe marcar error si la reserva no se encuentra', async () => {
        await dialogflowWebhook(mockRequestReservaNoExiste, mockResponse);
        const jsonResponse = mockResponse.json.mock.calls[0][0];
        console.log('UC3 Response (Not Found):', JSON.stringify(jsonResponse, null, 2));
        expect(jsonResponse.session_info.parameters.booking_found).toBe(false);
    });

    it('Debe construir el mensaje de confirmación de identidad', async () => {
        const req = { body: { fulfillmentInfo: { tag: 'construir_mensaje_confirmacion' }, sessionInfo: { parameters: mockSessionParamsConReserva } } };
        await dialogflowWebhook(req, mockResponse);
        const jsonResponse = mockResponse.json.mock.calls[0][0];
        console.log('Confirm Msg Response:', JSON.stringify(jsonResponse, null, 2));
        expect(jsonResponse.fulfillment_response.messages[0].text.text[0]).toContain('¿eres tú?');
    });
  });

  // --- Test para la IA Generativa ---
  describe('Módulo de IA Generativa (generative_q_and_a)', () => {
    it('Debe recibir contexto y pregunta, y devolver una respuesta de la IA', async () => {
      await dialogflowWebhook(mockRequestGenerativo, mockResponse);
      const jsonResponse = mockResponse.json.mock.calls[0][0];
      
      const respuestaDeLaIA = jsonResponse.fulfillment_response.messages[0].text.text[0];
      console.log('Respuesta REAL de la IA en el test:', respuestaDeLaIA);

      expect(respuestaDeLaIA).toBeDefined();
      expect(respuestaDeLaIA.toLowerCase()).not.toContain('no dispongo');
    }, 20000); // Timeout extendido
  });
});