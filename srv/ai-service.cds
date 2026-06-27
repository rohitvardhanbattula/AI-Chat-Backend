using {sap.aigateway as db} from '../db/schema';

service AIService {

    // ── Entities ─────────────────────────────────────────────────────────────
    entity ChatSessions as
        projection on db.ChatSessions
        excluding {
            functionalspec
        }; // never expose full spec in list queries

    entity ChatMessages as projection on db.ChatMessages;

    entity Users        as
        projection on db.Users
        excluding {
            passwordHash,
            otp,
            otpExpiry,
            failedLogins,
            lockedUntil
        };

    entity Ratings      as projection on db.Ratings;

    // ── Response types ────────────────────────────────────────────────────────
    type ModelResponse {
        modelId : String;
        content : LargeString;
        latency : Integer;
        error   : String;
    }

    type AuthTokens {
        accessToken  : String;
        refreshToken : String;
        expiresIn    : Integer; // seconds
    }

    // ── Auth actions ──────────────────────────────────────────────────────────
    action register(username: String, password: String)                                             returns String;
    action verifyOTP(username: String, otp: String)                                                 returns AuthTokens;
    action login(username: String, password: String)                                                returns AuthTokens;
    action refreshToken(refreshToken: String)                                                       returns AuthTokens;
    action logout(refreshToken: String)                                                             returns String;
    action getChatSessions()                                                                        returns array of ChatSessions;
    action getChatMessages(sessionId: UUID)                                                         returns array of ChatMessages;
    // ── Chat actions ──────────────────────────────────────────────────────────
    action generateMultiModelResponse(prompt: String, category: String, extractedText: LargeString) returns array of ModelResponse;

    type MessageInput {
        role    : String(20);
        content : LargeString;
        modelId : String(50);
    }

    action createSession(title: String,
                         selectedModel: String,
                         messages: array of MessageInput,
                         functionalspec: String)                                                    returns ChatSessions;
    action deleteSession(sessionId: UUID)                returns String;
    action renameSession(sessionId: UUID, title: String) returns String;
    action sendChatMessage(sessionId: UUID,
                           modelId: String,
                           prompt: String,
                           category: String,
                           extractedText: LargeString)                                              returns LargeString;

    // ── Utility actions ───────────────────────────────────────────────────────
    action submitRating(userId: String, modelId: String, category: String, rating: Integer)         returns String;

    action validateABAPCode(code: LargeString)                                                      returns array of String;

    action establishConnection(sessionId: String,
                               url: String,
                               user: String,
                               password: String,
                               client: String,
                               language: String)                                                    returns String;
}
