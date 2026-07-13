using { cuid, managed } from '@sap/cds/common';

namespace sap.aigateway;

entity Users : cuid, managed {
    username     : String(255);
    passwordHash : String(255);
    otp          : String(6);
    otpExpiry    : Timestamp;
    isVerified   : Boolean default false;
    failedLogins : Integer  default 0;
    lockedUntil  : Timestamp;
    promptCount  : Integer  default 0; // total number of prompts sent by this user
}

entity ChatSessions : cuid, managed {
    userId        : String(255);
    title         : String(100);
    selectedModel : String(50);
    functionalspec: LargeString;  // excluded from service projection list queries
}

entity ChatMessages : cuid, managed {
    session_ID : UUID;            // FK to ChatSessions
    role       : String(20) enum { user; assistant; system; tool };
    content    : LargeString;
    modelId    : String(50);
    latency    : Integer;
}

entity Ratings : cuid, managed {
    userId   : String(255);
    modelId  : String(50);
    category : String(100);
    rating   : Integer;           // 1–5
}

entity RefreshTokens : cuid, managed {
    userId    : String(255);
    tokenHash : String(255);      // SHA-256 of the refresh token
    expiresAt : Timestamp;
    revoked   : Boolean default false;
}
entity Destinations : cuid, managed {
    name        : String(200) not null; // must match the BTP Destination name exactly
    description : String(255);          // free-text, shown in the dropdown as a hint
    isActive    : Boolean default true;  // inactive destinations are hidden from the dropdown
}