import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger, PluginTool, PluginToolCallContext } from "@getfamiliar/shared";
import type { Bootstrap } from "../Bootstrap.js";
import { McpCommandRunner } from "../mcp/McpCommandRunner.js";
import { McpRegistry } from "../mcp/McpRegistry.js";
import type { DaemonReloader } from "../reload/DaemonReloader.js";
import { HostConfigService } from "../utils/ConfigService.js";
import { buildConfigTools } from "./ConfigTools.js";
import { MASKED_SECRET_VALUE } from "./SecretKeys.js";

const silentLog = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => silentLog,
} as unknown as Logger;
const callCtx = {
    toolRunContext: { limit: 100_000, spill: async () => "/scratch/x" },
} as unknown as PluginToolCallContext;

const CONFIG = `core:
  postgresPassword: pw
  defaultChatChannel: cli
inference:
  defaultProvider: openai
  defaultModel: gpt-5
  apiKeys:
    openai: KEY
mail:
  allowSend: false # keep this comment
`;

let scratch: string;
let configFile: string;
let mcpConfigFile: string;
let tools: Map<string, PluginTool>;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-config-tools-"));
    configFile = path.join(scratch, "config.yml");
    mcpConfigFile = path.join(scratch, "mcp.yml");
    writeFileSync(configFile, CONFIG);
    const config = new HostConfigService(configFile);
    config.getString("core.postgresPassword");
    tools = new Map(
        buildConfigTools({
            configFile,
            mcpConfigFile,
            config,
            mcpRegistry: new McpRegistry(mcpConfigFile, silentLog),
            reloader: {} as DaemonReloader,
            isPluginToolGroup: (id) => id === "telegram",
            boot: {} as Bootstrap,
            log: silentLog,
            mcpCommandRunner: new McpCommandRunner(),
        }).map((tool) => [tool.name, tool]),
    );
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

/** Run a tool by name. */
function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} exists`);
    return tool.execute(args, callCtx);
}

describe("config tools", () => {
    it("config_get masks secrets and lists pending keys", async () => {
        writeFileSync(configFile, CONFIG.replace("allowSend: false", "allowSend: true"));
        const result = (await call("config_get", {})) as {
            value: {
                core: Record<string, unknown>;
                inference: { apiKeys: Record<string, unknown> };
            };
            pendingReload: string[];
        };
        assert.equal(result.value.core.postgresPassword, MASKED_SECRET_VALUE);
        assert.equal(result.value.inference.apiKeys.openai, MASKED_SECRET_VALUE);
        assert.deepEqual(result.pendingReload, ["mail.allowSend"]);
    });

    it("config_set writes a value, keeps comments, and refuses secrets", async () => {
        await call("config_set", { key: "mail.allowSend", value: true });
        assert.match(readFileSync(configFile, "utf-8"), /allowSend: true # keep this comment/);
        await assert.rejects(
            call("config_set", { key: "telegram.botToken", value: "x" }),
            /secret/,
        );
        assert.doesNotMatch(readFileSync(configFile, "utf-8"), /botToken/);
    });

    it("config_set rolls back a write that breaks the lint", async () => {
        await assert.rejects(
            call("config_set", { key: "core.defaultChatChannel", value: 5 }),
            /rolled back/,
        );
        assert.equal(readFileSync(configFile, "utf-8"), CONFIG);
    });

    it("mcp_add writes an entry, refuses secret values and plugin id clashes", async () => {
        const entry = {
            title: "GitHub",
            description: "GitHub API",
            source: "docker-mcp-registry",
            image: "mcp/github",
            env: [{ name: "GITHUB_TOKEN", value: "", is_secret: true }],
        };
        const result = (await call("mcp_add", { id: "github", entry })) as {
            secretsToEnter: string[];
        };
        assert.deepEqual(result.secretsToEnter, ["GITHUB_TOKEN"]);
        assert.match(readFileSync(mcpConfigFile, "utf-8"), /github:/);

        await assert.rejects(
            call("mcp_add", {
                id: "other",
                entry: { ...entry, env: [{ name: "API_KEY", value: "leaked" }] },
            }),
            /secret/,
        );
        await assert.rejects(call("mcp_add", { id: "telegram", entry }), /plugin/);
    });

    it("mcp_set_env sets plain vars and refuses secrets; mcp_list masks", async () => {
        writeFileSync(
            mcpConfigFile,
            "fetch:\n  title: F\n  description: f\n  source: external\n  url: http://x\n  env:\n    - name: API_KEY\n      value: real\n",
        );
        await call("mcp_set_env", { id: "fetch", name: "REGION", value: "eu" });
        await assert.rejects(
            call("mcp_set_env", { id: "fetch", name: "API_KEY", value: "x" }),
            /secret/,
        );
        const listed = (await call("mcp_list", {})) as {
            servers: { id: string; status: string; env: { name: string; value: unknown }[] }[];
        };
        const fetch = listed.servers.find((s) => s.id === "fetch");
        assert.equal(fetch?.status, "pending-add");
        assert.deepEqual(fetch?.env, [
            { name: "API_KEY", value: MASKED_SECRET_VALUE },
            { name: "REGION", value: "eu" },
        ]);
        await call("mcp_remove", { id: "fetch" });
        assert.doesNotMatch(readFileSync(mcpConfigFile, "utf-8"), /fetch:/);
    });
});
