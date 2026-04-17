import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Container entry point. Reads the start payload from /tmp/input.json,
 * executes the task, and writes a result file to the IPC tasks directory.
 */
function main(): void {
    const raw = readFileSync("/tmp/input.json", "utf-8");
    const payload = JSON.parse(raw);

    const task = payload.task;
    if (!task?.taskId) {
        console.error("No task found in input payload");
        process.exit(1);
    }

    console.error(`Processing task ${task.taskId}: ${task.prompt}`);

    const result = {
        taskId: task.taskId,
        output: `Did task ${task.taskId}`,
    };

    const tasksDir = "/workspace/ipc/tasks";
    mkdirSync(tasksDir, { recursive: true });

    const resultPath = join(tasksDir, `${task.taskId}.result.json`);
    writeFileSync(resultPath, JSON.stringify(result), "utf-8");

    console.error(`Result written to ${resultPath}`);
}

main();
