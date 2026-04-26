import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContainerOutput, ContainerParameters } from "effective-assistant-shared";
import { AgentClient } from "./AgentClient";

const TASKS_DIR = "/workspace/context/ipc/tasks";

/**
 * Write a ContainerOutput result file to the IPC tasks directory.
 *
 * @param taskId - The task ID for the result filename.
 * @param output - The output payload to write.
 */
function writeResult(taskId: string, output: ContainerOutput): void {
    mkdirSync(TASKS_DIR, { recursive: true });
    const resultPath = join(TASKS_DIR, `${taskId}.result.json`);
    writeFileSync(resultPath, JSON.stringify(output), "utf-8");
    console.error(`Result written to ${resultPath}`);
}

/**
 * Container entry point. Reads ContainerParameters from /tmp/input.json,
 * executes the task via the agent SDK, streams each emitted event as a
 * JSONL line into `<taskId>.log.jsonl`, and writes a ContainerOutput
 * result file.
 */
async function main(): Promise<void> {
    const raw = readFileSync("/tmp/input.json", "utf-8");
    const params: ContainerParameters = JSON.parse(raw);

    const task = params.task;
    if (!task?.taskId) {
        console.error("No task found in input payload");
        process.exit(1);
    }

    console.error(`Context: ${params.contextId}`);
    console.error(`Processing task ${task.taskId}: ${task.prompt}`);

    mkdirSync(TASKS_DIR, { recursive: true });
    const logPath = join(TASKS_DIR, `${task.taskId}.log.jsonl`);
    const logStream = createWriteStream(logPath, { flags: "a" });

    try {
        const client = new AgentClient(params.sessionId);
        const executeResult = await client.execute(task.prompt, (event) => {
            logStream.write(`${JSON.stringify(event)}\n`);
        });

        console.error(`Session: ${executeResult.sessionId}`);
        console.error(
            `Turns: ${executeResult.summary.numTurns}, cost: $${executeResult.summary.totalCostUsd.toFixed(4)}`,
        );

        writeResult(task.taskId, {
            taskId: task.taskId,
            sessionId: executeResult.sessionId,
            output: executeResult.result,
        });
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`Task failed: ${errorMessage}`);

        writeResult(task.taskId, {
            taskId: task.taskId,
            sessionId: params.sessionId ?? "",
            output: { error: errorMessage },
        });

        process.exit(1);
    } finally {
        await new Promise<void>((resolve) => logStream.end(resolve));
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
