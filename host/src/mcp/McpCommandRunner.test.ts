import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { MASKED_OUTPUT_SECRET } from "../config/SecretOutputMasking.js";
import {
    McpCommandRunner,
    type McpCommandSpawner,
    UnknownMcpCallError,
} from "./McpCommandRunner.js";

/** Runs the argv's single item as a `sh -c` script instead of docker. */
function shellSpawner(killed: string[] = []): McpCommandSpawner {
    return {
        spawn: (argv) => spawn("sh", ["-c", argv[0]], { stdio: ["pipe", "pipe", "pipe"] }),
        kill: async (containerName) => {
            killed.push(containerName);
        },
    };
}

describe("McpCommandRunner", () => {
    it("returns output and exit code of a quick command, then drops the call", async () => {
        const runner = new McpCommandRunner({ spawner: shellSpawner() });
        const callId = runner.start("demo", () => ["echo out; echo err >&2; exit 3"]);
        const result = await runner.read(callId, 5000, []);
        assert.equal(result.running, false);
        assert.equal(result.exitCode, 3);
        assert.match(result.output, /out/);
        assert.match(result.output, /err/);
        await assert.rejects(runner.read(callId, 0, []), UnknownMcpCallError);
    });

    it("returns early while running and delivers the rest on a later read", async () => {
        const runner = new McpCommandRunner({ spawner: shellSpawner() });
        const callId = runner.start("demo", () => ["echo code-1234; sleep 0.5; echo finished"]);
        const first = await runner.read(callId, 200, []);
        assert.equal(first.running, true);
        assert.equal(first.exitCode, null);
        assert.match(first.output, /code-1234/);
        const second = await runner.read(callId, 5000, []);
        assert.equal(second.running, false);
        assert.equal(second.exitCode, 0);
        assert.equal(second.output.trim(), "finished");
    });

    it("masks a secret split across two writes", async () => {
        const runner = new McpCommandRunner({ spawner: shellSpawner() });
        const secrets = ["SUPER-SECRET-TOKEN"];
        const callId = runner.start("demo", () => [
            "printf 'token: SUPER-SEC'; sleep 0.4; printf 'RET-TOKEN ok\\n'",
        ]);
        const first = await runner.read(callId, 200, secrets);
        const second = await runner.read(callId, 5000, secrets);
        const output = first.output + second.output;
        assert.equal(output, `token: ${MASKED_OUTPUT_SECRET} ok\n`);
        assert.doesNotMatch(first.output, /SUPER/);
    });

    it("stop kills the container and the process", async () => {
        const killed: string[] = [];
        const runner = new McpCommandRunner({ spawner: shellSpawner(killed) });
        const callId = runner.start("demo", () => ["echo started; exec sleep 30"]);
        await runner.read(callId, 200, []);
        const result = await runner.stop(callId, []);
        assert.equal(result.running, false);
        assert.deepEqual(killed, [`familiar-mcp-exec-demo-${callId}`]);
    });

    it("kills a command that exceeds the runtime cap", async () => {
        const runner = new McpCommandRunner({ spawner: shellSpawner(), maxRuntimeMs: 200 });
        const callId = runner.start("demo", () => ["exec sleep 30"]);
        const result = await runner.read(callId, 5000, []);
        assert.equal(result.running, false);
        assert.equal(result.timedOut, true);
    });

    it("reports truncation when unread output exceeds the buffer cap", async () => {
        const runner = new McpCommandRunner({ spawner: shellSpawner(), maxBufferChars: 10 });
        const callId = runner.start("demo", () => ["printf '0123456789abcdef'"]);
        const result = await runner.read(callId, 5000, []);
        assert.equal(result.outputTruncated, true);
        assert.equal(result.output, "6789abcdef");
    });
});
