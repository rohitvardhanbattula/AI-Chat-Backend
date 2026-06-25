class Planner {

    constructor(registry) {

        this.registry = registry;

    }

    async plan(userMessage) {

        const text =
            userMessage.toLowerCase();

        // Search object

        if (
            text.includes("find class") ||
            text.includes("search class") ||
            text.includes("find program") ||
            text.includes("find object")
        ) {

            const query =
                userMessage
                    .replace(/find class/i, "")
                    .replace(/search class/i, "")
                    .replace(/find object/i, "")
                    .replace(/find program/i, "")
                    .trim();

            return {

                requiresTool: true,

                tool: "searchObject",

                arguments: {

                    query

                },

                thought:
                    "Need to search the SAP repository."

            };

        }

        // Read source code

        if (
            text.includes("source") ||
            text.includes("open class") ||
            text.includes("show code")
        ) {

            return {

                requiresTool: true,

                tool: "getObjectSource",

                arguments: {},

                thought:
                    "Need to retrieve ABAP source."

            };

        }

        // Syntax Check

        if (
            text.includes("syntax") ||
            text.includes("check code")
        ) {

            return {

                requiresTool: true,

                tool: "syntaxCheckCode",

                arguments: {},

                thought:
                    "Need to run syntax check."

            };

        }

        // Pretty Printer

        if (
            text.includes("format") ||
            text.includes("pretty print")
        ) {

            return {

                requiresTool: true,

                tool: "prettyPrinter",

                arguments: {},

                thought:
                    "Need to format source code."

            };

        }

        // Default

        return {

            requiresTool: false,

            thought:
                "No SAP tool required."

        };

    }

}

module.exports = Planner;