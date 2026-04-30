import { resolve } from "node:path";
import { ContainerPool } from "./container-runner/index";

interface ChatArgs {
    readonly contextId: string;
    readonly prompt: string;
}

/**
 * Parse argv for the chat command.
 * Supports `--context-id <id>` and collects remaining positional args as the prompt.
 * If no positional prompt is given and stdin is piped, reads the prompt from stdin.
 *
 * @param argv - Command-line arguments (without the node/script prefix).
 * @returns The parsed context id and prompt.
 * @throws If a required value is missing or flags are malformed.
 */
async function parseArgs(argv: readonly string[]): Promise<ChatArgs> {
    let contextId = "test-context";
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--context-id") {
            const value = argv[i + 1];
            if (!value) {
                throw new Error("--context-id requires a value");
            }
            contextId = value;
            i += 1;
        } else if (arg.startsWith("--context-id=")) {
            contextId = arg.slice("--context-id=".length);
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: cli.sh chat [--context-id <id>] <prompt>\n" +
                    "       echo <prompt> | cli.sh chat [--context-id <id>]",
            );
            process.exit(0);
        } else {
            positional.push(arg);
        }
    }

    let prompt = positional.join(" ").trim();
    if (!prompt && !process.stdin.isTTY) {
        prompt = (await readAllStdin()).trim();
    }

    if (!prompt) {
        throw new Error("No prompt provided. Pass it as an argument or pipe it via stdin.");
    }

    return { contextId, prompt };
}

/**
 * Read every byte from stdin until EOF.
 *
 * @returns The full stdin contents as a UTF-8 string.
 */
function readAllStdin(): Promise<string> {
    return new Promise((resolveStdin, rejectStdin) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolveStdin(data));
        process.stdin.on("error", rejectStdin);
    });
}

/**
 * CLI entry point: send a single chat message to the agent and print the result.
 */
async function main(): Promise<void> {
    const args = await parseArgs(process.argv.slice(2));

    const dataPath = resolve(__dirname, "../../data");
    const pool = new ContainerPool({
        imageName: "effective-agent",
        dataPath,
        timeoutMs: 60_000,
    });

    try {
        const result = await pool.submitTask({ contextId: args.contextId }, args.prompt);

        console.log(JSON.stringify(result, null, 4));
    } finally {
        await pool.stopAll();
    }
}

main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
});
