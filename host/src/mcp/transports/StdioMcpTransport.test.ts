import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { classifyJsonRpcMessage, classifyStdioLine } from "./StdioMcpTransport.js";

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

describe("classifyJsonRpcMessage", () => {
    it("classifies an initialize request as 'initialize'", () => {
        // Shape sent by `@modelcontextprotocol/sdk` Client and
        // `@ai-sdk/mcp` MCPClient on first connect. The bastion needs
        // to stash this verbatim for replay after every cold respawn.
        const body =
            '{"jsonrpc":"2.0","id":1,"method":"initialize",' +
            '"params":{"protocolVersion":"2024-11-05","capabilities":{},' +
            '"clientInfo":{"name":"familiar","version":"0.0.1"}}}';
        assert.equal(classifyJsonRpcMessage(body), "initialize");
    });

    it("classifies a notifications/initialized as 'initialized-notification'", () => {
        const body = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
        assert.equal(classifyJsonRpcMessage(body), "initialized-notification");
    });

    it("classifies a tools/call as 'other'", () => {
        // The normal post-handshake traffic — must not be confused with
        // initialize.
        const body =
            '{"jsonrpc":"2.0","id":47,"method":"tools/call",' +
            '"params":{"name":"search","arguments":{"query":"x"}}}';
        assert.equal(classifyJsonRpcMessage(body), "other");
    });

    it("classifies a tools/list as 'other'", () => {
        const body = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}';
        assert.equal(classifyJsonRpcMessage(body), "other");
    });

    it("classifies a non-initialize notification as 'other'", () => {
        // `notifications/cancelled`, `notifications/progress`, etc.
        // must not trip the initialize-capture path.
        const body =
            '{"jsonrpc":"2.0","method":"notifications/cancelled",' + '"params":{"requestId":17}}';
        assert.equal(classifyJsonRpcMessage(body), "other");
    });

    it("returns 'unparseable' for invalid JSON", () => {
        assert.equal(classifyJsonRpcMessage("welcome banner not json"), "unparseable");
        assert.equal(classifyJsonRpcMessage(""), "unparseable");
    });

    it("returns 'other' for arrays and primitives", () => {
        // Batches and primitives are valid JSON but not the request
        // shape we care about — never an initialize.
        assert.equal(classifyJsonRpcMessage("[]"), "other");
        assert.equal(classifyJsonRpcMessage("null"), "other");
        assert.equal(classifyJsonRpcMessage("42"), "other");
    });

    it("returns 'other' for an object without a method field", () => {
        // A response (has `id` + `result`) wouldn't normally hit the
        // request side of the bastion, but if it does we must not treat
        // it as an initialize.
        assert.equal(classifyJsonRpcMessage('{"jsonrpc":"2.0","id":1,"result":{}}'), "other");
    });

    it("does not match an initialize with method as a non-string", () => {
        // Defensive: a malformed frame with method=null shouldn't be
        // captured as initialize and replayed against future children.
        assert.equal(classifyJsonRpcMessage('{"jsonrpc":"2.0","id":1,"method":null}'), "other");
    });
});
