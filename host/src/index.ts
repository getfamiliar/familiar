import { resolve } from "node:path";
import { ContainerPool } from "./container-runner/index";

/**
 * Test harness: sends a task to a test context via ContainerPool
 * and logs the result.
 */
async function main(): Promise<void> {
    const dataPath = resolve(__dirname, "../../data");
    console.log(`Data path: ${dataPath}`);

    const pool = new ContainerPool({
        imageName: "effective-agent",
        dataPath,
        timeoutMs: 60_000,
    });

    try {
        console.log("Submitting test task...");

        const result = await pool.submitTask(
            { contextId: "test-context", mcpTools: [] },
            "Say hello",
        );

        console.log("Task result:", JSON.stringify(result, null, 4));
    } finally {
        await pool.stopAll();
        console.log("Done.");
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
