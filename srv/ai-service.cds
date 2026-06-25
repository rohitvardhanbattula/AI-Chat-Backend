using {sap.aigateway as db} from '../db/schema';

service AIService {
    entity ChatSessions as projection on db.ChatSessions;
    entity ChatMessages as projection on db.ChatMessages;
    entity Users        as projection on db.Users;
    entity Ratings      as projection on db.Ratings;

    type ModelResponse {
        modelId : String;
        content : LargeString;
        latency : Integer;
        error   : String;
    }

    action generateMultiModelResponse(prompt: String, category: String, extractedText: LargeString)                        returns array of ModelResponse;
    action sendChatMessage(sessionId: UUID, modelId: String, prompt: String, category: String, extractedText: LargeString) returns LargeString;
    action login(username: String, password: String)                                                                       returns String;
    action register(username: String, password: String)                                                                    returns String;
    action verifyOTP(username: String, otp: String)                                                                        returns String;
    action submitRating(userId: String, modelId: String, category: String, rating: Integer)                                returns String;
    action validateABAPCode(code: LargeString)                                                                             returns array of String;

    action testMcp(sessionId: UUID,
                   toolName: String,
                   payload: LargeString) returns LargeString;

    action createSapSession(
    sessionId : UUID,
    sapUrl : String,
    sapUser : String,
    sapPassword : String,
    sapClient : String,
    sapLanguage : String
) returns String;

action sendAbapAgentMessage(
    sessionId : UUID,
    prompt : LargeString
) returns LargeString;
}
