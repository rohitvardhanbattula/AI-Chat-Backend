namespace sap.aigateway;

using { cuid, managed } from '@sap/cds/common';

entity ChatSessions : cuid, managed {
    userId        : String(100);
    title         : String(255);
    selectedModel : String(50);  
    messages      : Composition of many ChatMessages on messages.session = $self;
}

entity ChatMessages : cuid, managed {
    session   : Association to ChatSessions;
    role      : String(20);      
    content   : LargeString;     
    modelId   : String(50);      
    latency   : Integer;       

}