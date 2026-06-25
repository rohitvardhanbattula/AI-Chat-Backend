const Planner = require("./planner");
const ToolExecutor = require("./executor");
const ToolRegistry = require("./registry");

class Agent {

    constructor(credentials) {

        this.registry =
            new ToolRegistry(credentials);

        this.executor =
            new ToolExecutor(credentials);

        this.planner =
            new Planner(this.registry);

    }

    async initialize() {

        await this.registry.load();

    }

    async execute(userMessage) {

        if (!this.registry.loaded) {

            await this.initialize();

        }

        const plan =
            await this.planner.plan(
                userMessage
            );

        if (!plan.requiresTool) {

            return {

                success: true,

                type: "chat",

                message:
                    "No SAP tool required.",

                thought:
                    plan.thought

            };

        }

        const toolResult =
            await this.executor.execute(

                plan.tool,

                plan.arguments

            );

        return {

            success:
                toolResult.success,

            type: "tool",

            thought:
                plan.thought,

            tool:
                plan.tool,

            arguments:
                plan.arguments,

            result:
                toolResult

        };

    }

}

module.exports = Agent;