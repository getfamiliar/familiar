import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentRunRow, ToolRunContext } from "@getfamiliar/shared";
import { buildBashArgv, buildBashTool, clampTimeoutMs } from "./bash.js";

const CTX: ToolRunContext = { limit: 1_000_000, spill: async () => "/scratch/test/stub" };

function parentRow(privileged: boolean): AgentRunRow {
    return { id: "p", eventId: "evt-1", privileged } as unknown as AgentRunRow;
}

/** Invoke the bash tool's execute with the SDK's (input, options) shape. */
async function runBashTool(
    parent: AgentRunRow,
    input: { command: string; intent: string; working_directory?: string; timeout_ms?: number },
): Promise<string> {
    const exec = buildBashTool(parent, CTX).execute;
    if (!exec) {
        throw new Error("bash tool has no execute");
    }
    // biome-ignore lint/suspicious/noExplicitAny: SDK options type isn't needed here.
    return (await (exec as any)(input, {} as any)) as string;
}

describe("buildBashArgv", () => {
    it("runs bash directly for a privileged run", () => {
        assert.deepEqual(buildBashArgv(true, "echo hi"), { file: "bash", args: ["-c", "echo hi"] });
    });

    it("drops to unpriv via sudo for a non-privileged run", () => {
        assert.deepEqual(buildBashArgv(false, "echo hi"), {
            file: "sudo",
            args: ["-n", "-H", "-u", "unpriv", "bash", "-c", "echo hi"],
        });
    });
});

describe("clampTimeoutMs", () => {
    const saved = process.env.AGENTSTEP_TIMEOUT_SECONDS;
    afterEach(() => {
        if (saved === undefined) {
            delete process.env.AGENTSTEP_TIMEOUT_SECONDS;
        } else {
            process.env.AGENTSTEP_TIMEOUT_SECONDS = saved;
        }
    });

    it("defaults to 30s and stays under the 150s fallback step budget", () => {
        delete process.env.AGENTSTEP_TIMEOUT_SECONDS;
        assert.equal(clampTimeoutMs(undefined), 30_000);
        // 150s budget − 5s margin = 145s ceiling.
        assert.equal(clampTimeoutMs(999_999), 145_000);
        assert.equal(clampTimeoutMs(5_000), 5_000);
    });

    it("bounds the timeout by the configured per-step budget", () => {
        process.env.AGENTSTEP_TIMEOUT_SECONDS = "20";
        // 20s budget − 5s margin = 15s ceiling; a 30s request is clamped down.
        assert.equal(clampTimeoutMs(30_000), 15_000);
    });
});

describe("bash tool — execution", () => {
    let workDir: string;
    beforeEach(() => {
        workDir = mkdtempSync(path.join(tmpdir(), "familiar-bash-test-"));
    });
    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
    });

    it("runs a privileged command and returns stdout + an exit-code footer", async () => {
        const out = await runBashTool(parentRow(true), {
            command: "echo hello",
            intent: "test echo",
            working_directory: workDir,
        });
        assert.match(out, /hello/);
        assert.match(out, /\[exit code 0 in \d+ ms\]/);
    });

    it("surfaces a non-zero exit code without throwing", async () => {
        const out = await runBashTool(parentRow(true), {
            command: "echo oops >&2; exit 3",
            intent: "test failure",
            working_directory: workDir,
        });
        assert.match(out, /--- stderr ---\noops/);
        assert.match(out, /\[exit code 3 in \d+ ms\]/);
    });

    it("times out and reports it instead of hanging", async () => {
        const out = await runBashTool(parentRow(true), {
            command: "sleep 5",
            intent: "test timeout",
            working_directory: workDir,
            timeout_ms: 200,
        });
        assert.match(out, /timed out after \d+ ms/);
    });

    it("rejects a relative working_directory", async () => {
        await assert.rejects(
            () =>
                runBashTool(parentRow(true), {
                    command: "echo hi",
                    intent: "bad cwd",
                    working_directory: "relative/path",
                }),
            /absolute path/i,
        );
    });
});
