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

    type ChatMessageInput {
        role    : String;
        content : LargeString;
    }

    action generateMultiModelResponse(prompt: String) returns array of ModelResponse;
    action sendChatMessage(modelId: String, prompt: String, history: array of ChatMessageInput) returns LargeString;
}