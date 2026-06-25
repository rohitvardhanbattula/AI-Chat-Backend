class Memory {

    constructor() {

        this.sessions = new Map();

    }

    create(sessionId) {

        if (!this.sessions.has(sessionId)) {

            this.sessions.set(sessionId, {

                messages: [],

                toolHistory: [],

                variables: {}

            });

        }

        return this.sessions.get(sessionId);

    }

    get(sessionId) {

        return this.create(sessionId);

    }

    addMessage(sessionId, role, content) {

        const memory = this.get(sessionId);

        memory.messages.push({

            role,

            content,

            timestamp: new Date().toISOString()

        });

    }

    addToolResult(sessionId, tool, result) {

        const memory = this.get(sessionId);

        memory.toolHistory.push({

            tool,

            result,

            timestamp: new Date().toISOString()

        });

    }

    setVariable(sessionId, key, value) {

        const memory = this.get(sessionId);

        memory.variables[key] = value;

    }

    getVariable(sessionId, key) {

        const memory = this.get(sessionId);

        return memory.variables[key];

    }

    clear(sessionId) {

        this.sessions.delete(sessionId);

    }

}

module.exports = Memory;