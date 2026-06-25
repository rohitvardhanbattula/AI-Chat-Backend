class Formatter {

    formatToolResponse(toolResult) {

        if (!toolResult.success) {

            return {

                type: "error",

                message: toolResult.error

            };

        }

        return {

            type: "tool",

            tool: toolResult.tool,

            duration: toolResult.duration,

            data: toolResult.response

        };

    }

    formatChat(text) {

        return {

            type: "chat",

            message: text

        };

    }

}

module.exports = Formatter;