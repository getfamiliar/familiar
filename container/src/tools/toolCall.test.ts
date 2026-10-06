import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { jsonSchema, type ToolSet, tool } from "ai";
import { buildToolCallTool } from "./toolCall.js";

/** An MCP-style raw result: text content plus a duplicated `structuredContent`. */
const MCP_RESULT = {
    content: [{ type: "text", text: '{"issues":[]}' }],
    isError: false,
    structuredContent: { result: '{"issues":[]}' },
};

/** Build a pool with one MCP-like tool (own `toModelOutput`) and one plain tool. */
function buildPool(): ToolSet {
    return {
        at_jira_search: tool<{ jql: string }, typeof MCP_RESULT>({
            description: "search",
            inputSchema: jsonSchema({ type: "object", properties: { jql: { type: "string" } } }),
            execute: async () => MCP_RESULT,
            toModelOutput: ({ input, output }) => ({
                type: "content",
                value: [{ type: "text", text: `${input.jql}:${output.content[0].text}` }],
            }),
        }),
        plain_object: tool<Record<string, never>, { ok: boolean }>({
            description: "plain",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => ({ ok: true }),
        }),
        plain_string: tool<Record<string, never>, string>({
            description: "plain",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => "hello",
        }),
    };
}

describe("tool_call toModelOutput", () => {
    it("applies the delegate's toModelOutput with the delegate's own input", async () => {
        const proxy = buildToolCallTool(buildPool());
        const out = await proxy.toModelOutput?.({
            toolCallId: "c1",
            input: { name: "at_jira_search", arguments: { jql: "assignee=me" } },
            output: MCP_RESULT,
        });
        assert.deepEqual(out, {
            type: "content",
            value: [{ type: "text", text: 'assignee=me:{"issues":[]}' }],
        });
    });

    it("falls back to the SDK default for delegates without toModelOutput", async () => {
        const proxy = buildToolCallTool(buildPool());
        const json = await proxy.toModelOutput?.({
            toolCallId: "c2",
            input: { name: "plain_object" },
            output: { ok: true },
        });
        assert.deepEqual(json, { type: "json", value: { ok: true } });
        const text = await proxy.toModelOutput?.({
            toolCallId: "c3",
            input: { name: "plain_string" },
            output: "hello",
        });
        assert.deepEqual(text, { type: "text", value: "hello" });
    });
});
