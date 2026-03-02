using { sap.aigateway as db } from '../db/schema';

service AIService {

    entity ChatSessions as projection on db.ChatSessions;
    entity ChatMessages as projection on db.ChatMessages;

    type ModelResponse {
        modelId : String;
        content : LargeString;
        latency : Integer;
        error   : String;
    }

    action generateMultiModelResponse(prompt: String) returns array of ModelResponse;
    action sendChatMessage(sessionId: UUID, modelId: String, prompt: String) returns LargeString;
}