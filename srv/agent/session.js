const Memory = require("./memory");

class SessionManager {

    constructor() {

        this.memory = new Memory();

    }

    addUserMessage(sessionId, message) {

        this.memory.addMessage(

            sessionId,

            "user",

            message

        );

    }

    addAssistantMessage(sessionId, message) {

        this.memory.addMessage(

            sessionId,

            "assistant",

            message

        );

    }

    addToolExecution(sessionId, tool, result) {

        this.memory.addToolResult(

            sessionId,

            tool,

            result

        );

    }

    getHistory(sessionId) {

        return this.memory
            .get(sessionId)
            .messages;

    }

    getToolHistory(sessionId) {

        return this.memory
            .get(sessionId)
            .toolHistory;

    }

    clear(sessionId) {

        this.memory.clear(sessionId);

    }

}

module.exports = SessionManager;