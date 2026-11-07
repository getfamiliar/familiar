import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PluginTool, PluginToolCallContext } from "@getfamiliar/shared";
import { WorkspaceUpdater } from "./WorkspaceUpdater.js";
import { buildWorkspaceUpdateTools } from "./WorkspaceUpdateTools.js";

const callCtx = {
    toolRunContext: { limit: 100_000, spill: async () => "/scratch/x" },
} as unknown as PluginToolCallContext;

let root: string;
let isAutoUpdateEnabled: boolean;
let tools: Map<string, PluginTool>;

beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "workspace-update-tools-"));
    const templateDir = path.join(root, "template");
    const workspaceDir = path.join(root, "workspace");
    mkdirSync(templateDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(path.join(templateDir, "a.md"), "template\n");
    writeFileSync(path.join(workspaceDir, "a.md"), "mine\n");
    const updater = new WorkspaceUpdater({
        workspaceDir,
        baseDir: path.join(root, "base"),
        sources: () => [{ id: "core", templateDir }],
        git: null,
    });
    await updater.sync("1.0.0");
    isAutoUpdateEnabled = true;
    tools = new Map(
        buildWorkspaceUpdateTools({ updater, isAutoUpdateEnabled: () => isAutoUpdateEnabled }).map(
            (tool) => [tool.name, tool],
        ),
    );
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/**
 * Run a tool by name.
 *
 * @param name Tool name.
 * @param args Tool arguments.
 * @returns The tool result.
 */
function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} exists`);
    return tool.execute(args, callCtx);
}

describe("workspace update tools", () => {
    it("lists the pending file", async () => {
        const status = (await call("workspace_update_status", {})) as {
            pending: { path: string; kind: string }[];
        };
        assert.deepEqual(
            status.pending.map((item) => [item.path, item.kind]),
            [["a.md", "unknown-base"]],
        );
    });

    it("refuses to resolve when core.autoUpdate is false, naming the switch", async () => {
        isAutoUpdateEnabled = false;
        await assert.rejects(
            call("workspace_update_resolve", {
                path: "a.md",
                resolution: "accept_live",
                summary: "keep",
            }),
            /core\.autoUpdate/,
        );
        // Read-only tools keep working.
        await call("workspace_update_diff", { path: "a.md" });
    });

    it("resolves when enabled", async () => {
        const result = (await call("workspace_update_resolve", {
            path: "a.md",
            resolution: "accept_live",
            summary: "keep",
        })) as { action: string };
        assert.equal(result.action, "unchanged");
    });
});
