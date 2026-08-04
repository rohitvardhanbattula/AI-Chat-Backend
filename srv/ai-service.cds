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

    entity Destinations as
        projection on db.Destinations {
            *
        }
        where isActive = true; // only active destinations are ever exposed to the client

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

    type ConnectionStatus {
        connected : Boolean;
        message   : String;
    }

    // ── Auth actions ──────────────────────────────────────────────────────────
    action register(username: String, password: String)                                             returns String;
    action verifyOTP(username: String, otp: String)                                                 returns AuthTokens;
    action login(username: String, password: String)                                                returns AuthTokens;
    action refreshToken(refreshToken: String)                                                       returns AuthTokens;
    action logout(refreshToken: String)                                                             returns String;
    action forgotPassword(username: String)                                                         returns String;
    action resetPassword(username: String, otp: String, newPassword: String)                        returns String;
    action getChatSessions()                                                                        returns array of ChatSessions;
    action getChatMessages(sessionId: UUID)                                                         returns array of ChatMessages;
    // Names of the active, admin-maintained BTP Destinations the "Connect to SAP
    // System" dropdown should offer. Each name must match a real Destination
    // configured in the BTP cockpit.
    action getDestinations()                                                                        returns array of Destinations;
    // ── Chat actions ──────────────────────────────────────────────────────────
    action generateMultiModelResponse(prompt: String, category: String, extractedText: LargeString, connectionId: String) returns array of ModelResponse;

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

    // ── SAP ADT connection actions ────────────────────────────────────────────
    function ping() returns String;
    // Initial connection — accepts either a real sessionId or a client-generated
    // tempId when the DB session does not exist yet.
    // `destinationName` must match an active row in the Destinations table /
    // an actual BTP Destination — the backend resolves the real host from it,
    // so the client never needs to know or type a raw system URL.
    action establishConnection(sessionId: String,
                               destinationName: String,
                               user: String,
                               password: String,
                               client: String,
                               language: String)                                                    returns String;

    // Move a pre-session (temp) connection to the real DB session UUID.
    // Call this immediately after createSession() succeeds.
    action remapConnection(tempId: String, newSessionId: String)                                    returns String;

    // Ping whether the MCP bridge for a session is still alive.
    // Returns { connected: Boolean, message: String }.
    action checkConnection(sessionId: String)                                                       returns ConnectionStatus;
}
