import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
    ConfigService,
    Logger,
    PluginManifest,
    PluginTool,
    PluginToolCallContext,
} from "@getfamiliar/shared";
import { type Bootstrap, bootstrap } from "../Bootstrap.js";
import { McpRegistry } from "../mcp/McpRegistry.js";
import { PluginHost } from "./PluginHost.js";
import { PluginToolsRegistry } from "./ToolsRegistry.js";

/** Logger stub that records error/warn lines so tests can assert on them. */
function recordingLog(lines: string[]): Logger {
    const log = {
        debug: () => {},
        info: () => {},
        warn: (...args: unknown[]) => lines.push(String(args.at(-1))),
        error: (...args: unknown[]) => lines.push(String(args.at(-1))),
        child: () => log,
    };
    return log as unknown as Logger;
}

/** Config stub: every lookup returns the caller's default (or throws when none). */
const defaultsOnlyConfig = new Proxy(
    {},
    {
        get: (_target, prop) => {
            if (prop === "set") {
                return async () => {};
            }
            return (key: string, ...rest: unknown[]) => {
                if (rest.length === 0) {
                    throw new Error(`config key "${key}" not set in test`);
                }
                return rest[0];
            };
        },
    },
) as ConfigService;

/** A trivial tool whose `execute` resolves with `"ok"`. */
function okTool(name: string): PluginTool {
    return {
        name,
        description: `${name} test tool`,
        inputSchema: { type: "object" },
        execute: async () => "ok",
    };
}

let homeDir: string;
let boot: Bootstrap;
let lines: string[];

beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "familiar-pluginhost-"));
    process.env.FAMILIAR_HOME = homeDir;
    boot = bootstrap();
    lines = [];
});

afterEach(() => {
    delete process.env.FAMILIAR_HOME;
    rmSync(homeDir, { recursive: true, force: true });
});

/**
 * Build a daemon-mode {@link PluginHost} (tools registry wired) for the
 * given fake plugins.
 */
function buildHost(plugins: PluginManifest[]): { host: PluginHost; registry: PluginToolsRegistry } {
    const log = recordingLog(lines);
    const mcpRegistry = new McpRegistry(boot.mcpConfigFile, log);
    const host = new PluginHost(boot, log, plugins, defaultsOnlyConfig, mcpRegistry);
    const registry = new PluginToolsRegistry(mcpRegistry, log);
    host.setToolsRegistry(registry);
    return { host, registry };
}

describe("PluginHost plugin failure isolation", () => {
    it("keeps booting when a plugin's start throws, and its tools fail on call", async () => {
        let healthyStarted = false;
        const { host, registry } = buildHost([
            {
                id: "tesla",
                host: {
                    start: async () => {
                        throw new Error("EACCES: permission denied");
                    },
                    tools: () => [okTool("status")],
                },
            } as unknown as PluginManifest,
            {
                id: "healthy",
                host: {
                    start: async () => {
                        healthyStarted = true;
                    },
                    tools: () => [okTool("ping")],
                },
            } as unknown as PluginManifest,
        ]);

        host.prepareAll();
        await host.startDaemons();

        assert.equal(healthyStarted, true);
        assert.equal(
            await registry.get("healthy_ping")?.execute({}, {} as PluginToolCallContext),
            "ok",
        );
        const teslaTool = registry.get("tesla_status");
        assert.ok(teslaTool, "the disabled plugin's tool stays registered");
        await assert.rejects(
            teslaTool.execute({}, {} as PluginToolCallContext),
            /plugin "tesla" failed in start \(EACCES: permission denied\)/,
        );
        assert.ok(lines.some((l) => l.includes('plugin "tesla" failed in start')));
        assert.ok(lines.some((l) => l.includes("1 plugin disabled: tesla (start: EACCES")));
    });

    it("never starts or stops a plugin whose prepare threw", async () => {
        let started = false;
        let stopped = false;
        const { host } = buildHost([
            {
                id: "broken",
                host: {
                    prepare: () => {
                        throw new Error("bad config");
                    },
                    start: async () => {
                        started = true;
                    },
                    stop: async () => {
                        stopped = true;
                    },
                },
            } as unknown as PluginManifest,
        ]);

        host.prepareAll();
        await host.startDaemons();
        await host.close();

        assert.equal(started, false);
        assert.equal(stopped, false);
        assert.ok(lines.some((l) => l.includes('plugin "broken" failed in prepare: bad config')));
    });

    it("keeps running a started plugin whose tools() throws, and still stops it", async () => {
        let stopped = false;
        const { host, registry } = buildHost([
            {
                id: "toolless",
                host: {
                    start: async () => {},
                    stop: async () => {
                        stopped = true;
                    },
                    tools: () => {
                        throw new Error("schema bug");
                    },
                },
            } as unknown as PluginManifest,
        ]);

        host.prepareAll();
        await host.startDaemons();
        await host.close();

        assert.equal(
            registry.list().some((t) => t.pluginId === "toolless"),
            false,
        );
        assert.equal(stopped, true);
        assert.ok(lines.some((l) => l.includes('plugin "toolless" failed in tools: schema bug')));
    });
});
