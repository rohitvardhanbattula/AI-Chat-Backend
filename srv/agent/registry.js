const McpClient = require("../mcp-client");

class ToolRegistry {

    constructor(credentials) {
        this.client = new McpClient(credentials);
        this.tools = new Map();
        this.loaded = false;
    }

    async load() {

        if (this.loaded) {
            return;
        }

        const tools = await this.client.listTools();

        for (const tool of tools) {

            this.tools.set(
                tool.name,
                tool
            );

        }

        this.loaded = true;

        console.log(
            `Loaded ${this.tools.size} MCP tools`
        );
    }

    async reload() {

        this.loaded = false;
        this.tools.clear();

        await this.load();
    }

    getTool(name) {

        return this.tools.get(name);

    }

    getAllTools() {

        return Array.from(
            this.tools.values()
        );

    }

    hasTool(name) {

        return this.tools.has(name);

    }

    search(keyword) {

        keyword = keyword.toLowerCase();

        return this.getAllTools().filter(tool =>

            tool.name.toLowerCase().includes(keyword) ||

            tool.description.toLowerCase().includes(keyword)

        );

    }

}

module.exports = ToolRegistry;