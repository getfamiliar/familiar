import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentRunRow } from "@getfamiliar/shared";
import { jsonSchema, type ToolSet, tool } from "ai";
import { ToolsFactory } from "./ToolsFactory.js";

/**
 * The ToolsFactory wraps `resolveTools` errors with a fixed prefix so
 * the chat-facing error message points the user at the `tools:`
 * frontmatter attribute rather than dumping an opaque "unknown group"
 * message.
 */
describe("ToolsFactory — error wrapping", () => {
    it("wraps an unknown-group error with the resolve prefix", async () => {
        await assert.rejects(
            () => ToolsFactory.build({ tools: ["thisgroupdoesnotexist"] }),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.match(
                    err.message,
                    /^Cannot resolve tools frontmatter attribute \["thisgroupdoesnotexist"\], aborting: /,
                );
                assert.match(err.message, /unknown group: thisgroupdoesnotexist/);
                return true;
            },
        );
    });

    it("preserves the original error as `cause`", async () => {
        try {
            await ToolsFactory.build({ tools: ["thisgroupdoesnotexist"] });
            assert.fail("expected throw");
        } catch (err) {
            assert.ok(err instanceof Error);
            assert.ok(err.cause instanceof Error);
            assert.match((err.cause as Error).message, /unknown group: thisgroupdoesnotexist/);
        }
    });

    it("an omitted `tools:` falls back to the implicit core default (empty here)", async () => {
        // No tools registered (no chat/parent/bus), so `core` is empty —
        // but the discovery meta-tools are always injected, and the call
        // must succeed rather than throw.
        const out = await ToolsFactory.build({});
        assert.deepEqual(Object.keys(out).sort(), ["tool_call", "tool_list"]);
    });
});

/**
 * A non-`default` tool is refused in a non-privileged run but runs
 * normally in a privileged one. The guard lives in the tool wrapper, so
 * it applies to every pool tool uniformly (built-in, plugin, MCP).
 */
describe("ToolsFactory — security-level enforcement", () => {
    /** Build a one-plugin-tool pool at the given level + privilege. */
    async function buildWithDangerTool(
        level: "approval" | "privileged",
        privileged: boolean,
    ): Promise<ToolSet> {
        const pluginTools: ToolSet = {
            danger_do: tool({
                description: "does the dangerous thing",
                inputSchema: jsonSchema<Record<string, never>>({
                    type: "object",
                    additionalProperties: false,
                    properties: {},
                }),
                execute: async () => "ran",
            }),
        };
        return ToolsFactory.build({
            tools: ["danger_do"],
            pluginTools,
            pluginLevelsByKey: new Map([["danger_do", level]]),
            parent: { id: "1", privileged } as unknown as AgentRunRow,
        });
    }

    /** Invoke a tool's wrapped `execute` with empty args. */
    function invoke(tools: ToolSet, name: string): Promise<unknown> {
        const execute = tools[name]?.execute as
            | ((input: unknown, options: unknown) => Promise<unknown>)
            | undefined;
        assert.ok(execute, `${name} missing or not executable`);
        return execute({}, { toolCallId: "t", messages: [] });
    }

    for (const level of ["approval", "privileged"] as const) {
        it(`refuses a ${level} tool in a non-privileged run`, async () => {
            const tools = await buildWithDangerTool(level, false);
            await assert.rejects(invoke(tools, "danger_do"), (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /danger_do/);
                assert.match(err.message, /non-privileged/);
                return true;
            });
        });

        it(`runs a ${level} tool in a privileged run`, async () => {
            const tools = await buildWithDangerTool(level, true);
            assert.equal(await invoke(tools, "danger_do"), "ran");
        });
    }

    it("runs a default tool in a non-privileged run", async () => {
        const pluginTools: ToolSet = {
            safe_do: tool({
                description: "safe",
                inputSchema: jsonSchema<Record<string, never>>({
                    type: "object",
                    additionalProperties: false,
                    properties: {},
                }),
                execute: async () => "ran",
            }),
        };
        const tools = await ToolsFactory.build({
            tools: ["safe_do"],
            pluginTools,
            parent: { id: "1", privileged: false } as unknown as AgentRunRow,
        });
        assert.equal(await invoke(tools, "safe_do"), "ran");
    });
});
