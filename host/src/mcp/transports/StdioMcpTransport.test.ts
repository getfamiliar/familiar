import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { classifyStdioLine } from "./StdioMcpTransport.js";

describe("classifyStdioLine", () => {
    it("classifies a JSON-RPC response with id as a response", () => {
        const line = '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}';
        assert.equal(classifyStdioLine(line), "response");
    });

    it("classifies a JSON-RPC response carrying id:0 as a response", () => {
        // Numeric id 0 is valid JSON-RPC; Object.hasOwn must catch it
        // even though `parsed.id` would be falsy.
        const line = '{"jsonrpc":"2.0","id":0,"result":null}';
        assert.equal(classifyStdioLine(line), "response");
    });

    it("classifies a JSON-RPC error response as a response", () => {
        const line = '{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"x"}}';
        assert.equal(classifyStdioLine(line), "response");
    });

    it("classifies a notifications/message frame as non-response", () => {
        // The exact shape duckduckgo emits during search.
        const line =
            '{"method":"notifications/message","params":{"level":"info","data":"Searching..."},"jsonrpc":"2.0"}';
        assert.equal(classifyStdioLine(line), "non-response");
    });

    it("classifies a notifications/progress frame as non-response", () => {
        const line =
            '{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"x","progress":0.5}}';
        assert.equal(classifyStdioLine(line), "non-response");
    });

    it("treats unparseable text as non-response", () => {
        // Stray banner text on stdout (some MCPs print copyright on
        // first run before switching to JSON-RPC). Must never satisfy
        // a waiter.
        assert.equal(classifyStdioLine("welcome to ddg-search v1.27.1"), "non-response");
    });

    it("treats a JSON array (batch) as non-response", () => {
        // Batches aren't supported yet; the entire batch is one stdio
        // line per the MCP spec, so don't satisfy a single waiter
        // with it. Future batch support will need its own correlator.
        assert.equal(classifyStdioLine('[{"jsonrpc":"2.0","id":1,"result":1}]'), "non-response");
    });

    it("treats a primitive JSON value as non-response", () => {
        assert.equal(classifyStdioLine("null"), "non-response");
        assert.equal(classifyStdioLine("42"), "non-response");
        assert.equal(classifyStdioLine('"hello"'), "non-response");
    });

    it("treats an empty object as non-response", () => {
        assert.equal(classifyStdioLine("{}"), "non-response");
    });
});
