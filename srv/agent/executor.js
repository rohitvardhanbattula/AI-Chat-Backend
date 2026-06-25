const McpClient = require("../mcp-client");

class ToolExecutor {

    constructor(credentials) {

        this.client = new McpClient(credentials);

    }

    async execute(toolName, args = {}) {

        const start = Date.now();

        try {

            const response =
                await this.client.callTool(
                    toolName,
                    args
                );

            return {

                success: true,

                tool: toolName,

                arguments: args,

                duration:
                    Date.now() - start,

                response

            };

        } catch (error) {

            return {

                success: false,

                tool: toolName,

                arguments: args,

                duration:
                    Date.now() - start,

                error:
                    error.message || String(error)

            };

        }

    }

}

module.exports = ToolExecutor;