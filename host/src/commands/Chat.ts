import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap";

const POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_S = 600;

/**
 * `ea chat` — send one chat message to the running agent container via
 * the IPC directory. The host daemon (`ea start`) must be running.
 *
 * Pure file-based IPC: write `data/ipc/input/{taskId}.json`, poll
 * `data/ipc/output/{taskId}.json` until it appears, print and unlink.
 */
export const chatCommand = defineCommand({
    meta: {
        name: "chat",
        description: "Send a chat message to the running agent.",
    },
    args: {
        prompt: {
            type: "positional",
            required: false,
            description: "Prompt text. If omitted and stdin is piped, reads from stdin.",
        },
        timeout: {
            type: "string",
            description:
                "Seconds to wait for a reply (default 600, also honors $CHAT_TIMEOUT_S).",
        },
    },
    async run({ args }) {
        const boot = bootstrap();

        ensureDaemonAlive(boot.pidFile);

        const prompt = await collectPrompt(args.prompt);
        if (!prompt) {
            throw new Error(
                "No prompt provided. Pass it as an argument or pipe it via stdin.",
            );
        }

        mkdirSync(boot.ipcInputDir, { recursive: true });
        mkdirSync(boot.ipcOutputDir, { recursive: true });

        const taskId = randomBytes(4).toString("hex");
        const inputPath = join(boot.ipcInputDir, `${taskId}.json`);
        const outputPath = join(boot.ipcOutputDir, `${taskId}.json`);
        const logPath = join(boot.ipcOutputDir, `${taskId}.log.jsonl`);

        writeFileSync(
            inputPath,
            JSON.stringify({ task: { taskId, prompt } }),
            "utf-8",
        );

        const timeoutS = resolveTimeout(args.timeout);
        await waitForFile(outputPath, timeoutS);

        const result = readFileSync(outputPath, "utf-8");
        process.stdout.write(result);
        if (!result.endsWith("\n")) {
            process.stdout.write("\n");
        }

        removeQuietly(outputPath);
        removeQuietly(logPath);
    },
});

/**
 * Throw a clear error if the daemon isn't running or the pidfile is stale.
 */
function ensureDaemonAlive(pidFile: string): void {
    if (!existsSync(pidFile)) {
        throw new Error(
            `Daemon not running (no ${pidFile}). Start it with: ./cli.sh start`,
        );
    }
    const raw = readFileSync(pidFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
        throw new Error(
            `Stale pidfile (${pidFile}). Start the daemon: ./cli.sh start`,
        );
    }
    try {
        process.kill(pid, 0);
    } catch {
        throw new Error(
            `Stale pidfile (${pidFile}); pid ${pid} not running. Start the daemon: ./cli.sh start`,
        );
    }
}

/**
 * Resolve the prompt: positional arg wins, otherwise stdin (when piped),
 * otherwise an empty string.
 */
async function collectPrompt(positional: string | undefined): Promise<string> {
    if (positional) {
        return positional.trim();
    }
    if (process.stdin.isTTY) {
        return "";
    }
    return (await readAllStdin()).trim();
}

/** Read every byte from stdin until EOF. */
function readAllStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
    });
}

/**
 * Pick the chat-result wait timeout from `--timeout`, env, or default.
 */
function resolveTimeout(arg: string | undefined): number {
    if (arg) {
        const parsed = Number.parseInt(arg, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
        throw new Error(`Invalid --timeout: ${arg}`);
    }
    const envValue = process.env.CHAT_TIMEOUT_S;
    if (envValue) {
        const parsed = Number.parseInt(envValue, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return DEFAULT_TIMEOUT_S;
}

/** Poll for a file's existence; throw on timeout. */
async function waitForFile(path: string, timeoutS: number): Promise<void> {
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
        if (existsSync(path)) {
            return;
        }
        await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out after ${timeoutS}s waiting for ${path}`);
}

/** Best-effort unlink. */
function removeQuietly(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // ignore
    }
}

/** Promise-based setTimeout. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
