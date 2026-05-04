import type { Tool } from "ai";
import { jsonSchema, tool } from "ai";

interface GetWeatherInput {
    readonly city: string;
}

interface GetWeatherOutput {
    readonly temperature: number;
    readonly rainProbability: number;
}

/**
 * Dummy weather tool used as a probe for tool-calling reliability on
 * the configured model+provider combo. Returns plausible-looking but
 * fully random values; the goal is to see whether the agent recognizes
 * a question like "what's the weather in Berlin?" and emits a real
 * structured tool call we can observe in `stepresults.tool_calls`.
 *
 * Replace with a real implementation once we trust the wiring.
 */
export function buildGetWeatherTool(): Tool<GetWeatherInput, GetWeatherOutput> {
    return tool<GetWeatherInput, GetWeatherOutput>({
        description:
            "Look up the current weather for a given city. Returns the " +
            "temperature in Celsius and the rain probability as a value " +
            "between 0 and 1. Use this whenever the user asks about " +
            "weather, temperature, or whether it will rain somewhere.",
        inputSchema: jsonSchema<GetWeatherInput>({
            type: "object",
            additionalProperties: false,
            required: ["city"],
            properties: {
                city: {
                    type: "string",
                    description: "City name, e.g. 'Berlin' or 'San Francisco'.",
                },
            },
        }),
        execute: async ({ city }) => {
            void city;
            // -5 °C to +30 °C range, one decimal.
            const temperature = Math.round((Math.random() * 35 - 5) * 10) / 10;
            // 0.00 to 1.00, two decimals.
            const rainProbability = Math.round(Math.random() * 100) / 100;
            return { temperature, rainProbability };
        },
    });
}
