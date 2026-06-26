using { cuid, managed } from '@sap/cds/common';

namespace sap.aigateway;

entity Users : cuid, managed {
    username     : String;
    password     : String; // In production, this should be hashed
    otp          : String;
    otpExpiry    : Timestamp;
    isVerified   : Boolean default false;
}

entity ChatSessions : cuid, managed {
    userId         : String;
    title          : String;
    functionalspec : LargeString; // Optional functional spec attached to the session
}

entity ChatMessages : cuid, managed {
    session_ID : String; // Reference to ChatSessions
    role       : String enum { user; assistant; system; tool };
    content    : LargeString;
    modelId    : String;
    latency    : Integer;
}

entity Ratings : cuid, managed {
    userId   : String;
    modelId  : String;
    category : String;
    rating   : Integer; // E.g., 1 to 5
}