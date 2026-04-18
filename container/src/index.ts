import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ContainerOutput, ContainerParameters } from "effective-assistant-shared";

/**
 * Container entry point. Reads ContainerParameters from /tmp/input.json,
 * executes the task, and writes a ContainerOutput result file.
 */
function main(): void {
    const raw = readFileSync("/tmp/input.json", "utf-8");
    const params: ContainerParameters = JSON.parse(raw);

    const task = params.task;
    if (!task?.taskId) {
        console.error("No task found in input payload");
        process.exit(1);
    }

    const sessionId = params.sessionId ?? generateSessionId();
    console.error(`Context: ${params.contextId}, Session: ${sessionId}`);
    console.error(`Processing task ${task.taskId}: ${task.prompt}`);

    const output: ContainerOutput = {
        taskId: task.taskId,
        sessionId,
        output: `Did task ${task.taskId}`,
    };

    const tasksDir = "/workspace/context/ipc/tasks";
    mkdirSync(tasksDir, { recursive: true });

    const resultPath = join(tasksDir, `${task.taskId}.result.json`);
    writeFileSync(resultPath, JSON.stringify(output), "utf-8");

    console.error(`Result written to ${resultPath}`);
}

/**
 * Generate a placeholder session ID. Will be replaced by the actual
 * Anthropic SDK session ID once integrated.
 *
 * @returns A 16-character hex string.
 */
function generateSessionId(): string {
    return randomBytes(8).toString("hex");
}

main();
