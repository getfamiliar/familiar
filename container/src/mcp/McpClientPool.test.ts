import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { gateMcpTool, type McpToolGating } from "./McpClientPool.js";

/**
 * Per-MCP tool gating: allowlist → denylist → approval → privileged,
 * matched on the bare tool name. `gateMcpTool` returns the resolved
 * level, or `null` when the tool is dropped.
 */
describe("gateMcpTool — mcp.yml allow/deny/approval/privileged", () => {
    const gating: McpToolGating = {
        allowlist: ["comment_*"],
        denylist: ["comment_delete"],
        approval: ["comment_post"],
        privileged: ["comment_admin_*"],
    };

    it("drops tools outside the allowlist", () => {
        assert.equal(gateMcpTool("other_x", gating), null);
    });

    it("drops denylisted tools even if allowlisted", () => {
        assert.equal(gateMcpTool("comment_delete", gating), null);
    });

    it("assigns approval to matching survivors", () => {
        assert.equal(gateMcpTool("comment_post", gating), "approval");
    });

    it("assigns privileged to matching survivors", () => {
        assert.equal(gateMcpTool("comment_admin_purge", gating), "privileged");
    });

    it("leaves other survivors at default", () => {
        assert.equal(gateMcpTool("comment_edit", gating), "default");
    });

    it("privileged wins over approval on overlap (evaluated last)", () => {
        const overlap: McpToolGating = {
            allowlist: [],
            denylist: [],
            approval: ["do_*"],
            privileged: ["do_*"],
        };
        assert.equal(gateMcpTool("do_thing", overlap), "privileged");
    });

    it("empty allowlist allows everything (no allow filter)", () => {
        const noAllow: McpToolGating = {
            allowlist: [],
            denylist: ["secret_*"],
            approval: [],
            privileged: [],
        };
        assert.equal(gateMcpTool("anything", noAllow), "default");
        assert.equal(gateMcpTool("secret_key", noAllow), null);
    });
});
