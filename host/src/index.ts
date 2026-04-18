import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerPool } from "./container-runner/index";

/**
 * Test harness: sends a task to a test context via ContainerPool
 * and logs the result.
 */
async function main(): Promise<void> {
    const workspace = mkdtempSync(join(tmpdir(), "ea-test-"));
    console.log(`Workspace: ${workspace}`);

    const pool = new ContainerPool({
        imageName: "effective-agent",
        workspacePath: workspace,
        timeoutMs: 30_000,
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
        rmSync(workspace, { recursive: true, force: true });
        console.log("Cleaned up.");
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
