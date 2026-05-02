import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerOutput, ContainerParameters } from "effective-assistant-shared";
import { AgentClient } from "./AgentClient";

const IPC_INPUT_DIR = "/ipc/input";
const IPC_OUTPUT_DIR = "/ipc/output";
const SESSION_FILE = "/workspace/.last-session";
const POLL_INTERVAL_MS = 200;

/**
 * Long-running task loop running inside the agent container.
 *
 * Polls `/ipc/input/` for `{taskId}.json` files written by the host's
 * chat client. Files are processed sequentially: read, deleted, executed
 * via `AgentClient`, and a `{taskId}.json` result file is written to
 * `/ipc/output/`. The most recent successful sessionId is persisted to
 * `/workspace/.last-session` and reloaded as the resume target on every
 * task — giving callers a single continuous conversation across
 * invocations until they explicitly start a new session.
 *
 * Polling (rather than `fs.watch`) is used because watch is unreliable
 * across Docker volumes, particularly on WSL2.
 */
export class TaskLoop {
    private stopRequested = false;
    private inFlight: Promise<void> | undefined;

    /**
     * Begin polling for tasks. Resolves only when {@link requestStop} is
     * called and any in-flight task has completed.
     */
    async run(): Promise<void> {
        mkdirSync(IPC_INPUT_DIR, { recursive: true });
        mkdirSync(IPC_OUTPUT_DIR, { recursive: true });

        console.error(`Task loop watching ${IPC_INPUT_DIR}`);

        while (!this.stopRequested) {
            const taskFile = await this.nextTaskFile();
            if (!taskFile) {
                await this.sleep(POLL_INTERVAL_MS);
                continue;
            }

            this.inFlight = this.processTaskFile(taskFile);
            await this.inFlight;
            this.inFlight = undefined;
        }

        console.error("Task loop stopped");
    }

    /**
     * Signal the loop to stop after the current task (if any) completes.
     * Awaitable via the promise returned by {@link run}.
     */
    requestStop(): void {
        this.stopRequested = true;
    }

    /**
     * Return the oldest pending task filename in the input dir, or
     * undefined if nothing is waiting.
     */
    private async nextTaskFile(): Promise<string | undefined> {
        try {
            const entries = await readdir(IPC_INPUT_DIR);
            const taskFiles = entries.filter((name) => name.endsWith(".json")).sort();
            return taskFiles[0];
        } catch {
            return undefined;
        }
    }

    /**
     * Process a single task file end-to-end: parse, delete the input,
     * run the agent, write the result, persist the session.
     *
     * @param fileName - Bare filename inside `/ipc/input/`, e.g. `abcd1234.json`.
     */
    private async processTaskFile(fileName: string): Promise<void> {
        const inputPath = join(IPC_INPUT_DIR, fileName);

        let params: ContainerParameters;
        try {
            const raw = readFileSync(inputPath, "utf-8");
            params = JSON.parse(raw) as ContainerParameters;
        } catch (err) {
            console.error(`Failed to read ${inputPath}: ${describeError(err)}`);
            this.tryUnlink(inputPath);
            return;
        }

        this.tryUnlink(inputPath);

        const task = params.task;
        if (!task?.taskId) {
            console.error(`Input ${fileName} missing task.taskId; skipping`);
            return;
        }

        const sessionId = params.sessionId ?? this.loadSessionId();
        console.error(
            `Processing task ${task.taskId} (${sessionId ? `resume ${sessionId}` : "new session"})`,
        );

        const logStream = createWriteStream(join(IPC_OUTPUT_DIR, `${task.taskId}.log.jsonl`), {
            flags: "a",
        });

        try {
            const client = new AgentClient(sessionId);
            const result = await client.execute(task.prompt, (event) => {
                logStream.write(`${JSON.stringify(event)}\n`);
            });

            console.error(
                `Task ${task.taskId} done — turns=${result.summary.numTurns} cost=$${result.summary.totalCostUsd.toFixed(4)}`,
            );

            this.saveSessionId(result.sessionId);
            this.writeResult(task.taskId, {
                taskId: task.taskId,
                sessionId: result.sessionId,
                output: result.result,
            });
        } catch (err) {
            const message = describeError(err);
            console.error(`Task ${task.taskId} failed: ${message}`);
            this.writeResult(task.taskId, {
                taskId: task.taskId,
                sessionId: sessionId ?? "",
                output: { error: message },
            });
        } finally {
            await new Promise<void>((resolve) => logStream.end(resolve));
        }
    }

    /**
     * Atomically write the result file (write to a temp path, rename
     * into place) so chat.sh never reads a half-written JSON file.
     */
    private writeResult(taskId: string, output: ContainerOutput): void {
        const finalPath = join(IPC_OUTPUT_DIR, `${taskId}.json`);
        const tempPath = `${finalPath}.tmp`;
        writeFileSync(tempPath, JSON.stringify(output), "utf-8");
        renameSync(tempPath, finalPath);
    }

    /** Read the persisted last-session id, or undefined if none yet. */
    private loadSessionId(): string | undefined {
        if (!existsSync(SESSION_FILE)) {
            return undefined;
        }
        const value = readFileSync(SESSION_FILE, "utf-8").trim();
        return value || undefined;
    }

    /** Persist the most recent session id for reuse on the next task. */
    private saveSessionId(sessionId: string): void {
        writeFileSync(SESSION_FILE, sessionId, "utf-8");
    }

    /** Best-effort delete; swallow ENOENT and similar. */
    private tryUnlink(path: string): void {
        try {
            unlinkSync(path);
        } catch {
            // ignore
        }
    }

    /** Promise-based setTimeout. */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

/** Reduce an unknown thrown value to a human-readable string. */
function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
