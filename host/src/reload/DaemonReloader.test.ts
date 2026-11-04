import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "@getfamiliar/shared";
import type { McpGateway } from "../mcp/McpGateway.js";
import { type McpDiff, McpRegistry } from "../mcp/McpRegistry.js";
import type { PluginHost } from "../plugins/PluginHost.js";
import type { PluginToolsRegistry } from "../plugins/ToolsRegistry.js";
import { HostConfigService } from "../utils/ConfigService.js";
import { DaemonReloader, renderReloadReport } from "./DaemonReloader.js";

const silentLog = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => silentLog,
} as unknown as Logger;

/** A config that passes the platform lint, with `extra` appended. */
function configYaml(extra = ""): string {
    return `core:
  postgresPassword: pw
  defaultChatChannel: cli
inference:
  defaultProvider: openai
  defaultModel: gpt-5
  apiKeys:
    openai: KEY
${extra}`;
}

let scratch: string;
let configFile: string;
let mcpConfigFile: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-reloader-"));
    configFile = path.join(scratch, "config.yml");
    mcpConfigFile = path.join(scratch, "mcp.yml");
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

/** Build a reloader over real config files and recording fakes. */
function buildReloader(calls: string[]) {
    const config = new HostConfigService(configFile);
    config.getString("core.postgresPassword");
    const mcpRegistry = new McpRegistry(mcpConfigFile, silentLog);
    const pluginHost = {
        modelMetadata: {
            lookupProvider: async (key: string) =>
                key === "openai" ? { npmPackage: "@ai-sdk/openai" } : undefined,
        },
        reloadPluginsForConfigChange: async (keys: readonly string[]) => {
            calls.push(`plugins:${keys.join(",")}`);
            return {
                restarted: keys.some((k) => k.startsWith("telegram")) ? ["telegram"] : [],
                failed: [],
                needsDaemonRestart: [],
            };
        },
        storage: { resetCaches: () => calls.push("storage-reset") },
        storageProviders: { pluginIds: () => [] },
        mcp: {
            invalidate: async (ids: readonly string[]) => calls.push(`invalidate:${ids.join(",")}`),
        },
    } as unknown as PluginHost;
    const mcpGateway = {
        applyDiff: async (diff: McpDiff) => calls.push(`gateway:+${diff.added.join(",")}`),
    } as unknown as McpGateway;
    const reloader = new DaemonReloader({
        configFile,
        mcpConfigFile,
        config,
        pluginHost,
        toolsRegistry: {
            hasPlugin: (id: string) => id === "telegram",
        } as unknown as PluginToolsRegistry,
        mcpRegistry,
        mcpGateway,
        applyInference: async () => {
            calls.push("inference");
        },
        applyWebServer: async () => {
            calls.push("webserver");
        },
        publishContainerConfig: async () => {
            calls.push("container-config");
        },
        log: silentLog,
    });
    return { reloader, config };
}

describe("DaemonReloader", () => {
    it("applies changes, pins restart-only keys and restarts affected plugins", async () => {
        writeFileSync(configFile, configYaml());
        const calls: string[] = [];
        const { reloader, config } = buildReloader(calls);
        writeFileSync(
            configFile,
            configYaml("telegram:\n  botToken: t\nmail:\n  allowSend: true\n").replace(
                "pw",
                "changed",
            ),
        );
        writeFileSync(
            mcpConfigFile,
            "fetch:\n  title: Fetch\n  description: fetch pages\n  source: external\n  url: http://x\n",
        );

        const report = await reloader.reload();

        assert.deepEqual(report.errors, []);
        assert.deepEqual(report.appliedKeys, ["mail.allowSend", "telegram.botToken"]);
        assert.deepEqual(report.restartRequiredKeys, ["core.postgresPassword"]);
        assert.deepEqual(report.plugins.restarted, ["telegram"]);
        assert.deepEqual(report.mcp, { added: ["fetch"], removed: [], changed: [] });
        assert.equal(config.getString("core.postgresPassword"), "pw", "pinned");
        assert.equal(config.getBool("mail.allowSend"), true);
        assert.deepEqual(calls, [
            "inference",
            "plugins:mail.allowSend,telegram.botToken",
            "gateway:+fetch",
            "invalidate:",
            "container-config",
        ]);
        assert.match(
            renderReloadReport(report),
            /Daemon restart required for:.*core\.postgresPassword/,
        );
    });

    it("aborts without applying anything when a file is invalid", async () => {
        writeFileSync(configFile, configYaml());
        const calls: string[] = [];
        const { reloader, config } = buildReloader(calls);
        writeFileSync(
            configFile,
            configYaml("mail:\n  allowSend: true\n").replace("  defaultChatChannel: cli\n", ""),
        );

        const report = await reloader.reload();

        assert.ok(report.errors.some((e) => e.includes("core.defaultChatChannel")));
        assert.deepEqual(calls, []);
        assert.equal(config.getBool("mail.allowSend", false), false);
        assert.match(renderReloadReport(report), /Nothing was applied/);
    });

    it("restarts the webserver only when a webserver key changed", async () => {
        writeFileSync(configFile, configYaml());
        const calls: string[] = [];
        const { reloader } = buildReloader(calls);

        writeFileSync(configFile, configYaml("mail:\n  allowSend: true\n"));
        await reloader.reload();
        assert.ok(!calls.includes("webserver"), "unrelated change leaves the webserver alone");

        writeFileSync(
            configFile,
            configYaml("mail:\n  allowSend: true\nwebserver:\n  enabled: true\n"),
        );
        const report = await reloader.reload();
        assert.deepEqual(report.appliedKeys, ["webserver.enabled"]);
        assert.ok(calls.includes("webserver"));
    });

    it("refuses an MCP id that clashes with a plugin's tool group", async () => {
        writeFileSync(configFile, configYaml());
        const calls: string[] = [];
        const { reloader } = buildReloader(calls);
        writeFileSync(
            mcpConfigFile,
            "telegram:\n  title: T\n  description: t\n  source: external\n  url: http://x\n",
        );
        const report = await reloader.reload();
        assert.ok(report.errors.some((e) => e.includes('MCP id "telegram" collides')));
        assert.deepEqual(calls, []);
    });
});
