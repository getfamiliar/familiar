import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PluginTool, PluginToolCallContext } from "@getfamiliar/shared";
import { HostConfigService } from "../utils/ConfigService.js";
import { MemoryWebSessionStore } from "./auth/MemoryWebSessionStore.js";
import { TrustedProxyRegistry } from "./auth/TrustedProxyRegistry.js";
import { buildWebTools } from "./WebTools.js";

const callCtx = {
    toolRunContext: { limit: 100_000, spill: async () => "/scratch/x" },
} as unknown as PluginToolCallContext;

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-webtools-"));
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

/** Result shape of `web_login_link`. */
interface LinkResult {
    login: string;
    expiresAt: string;
    autoSignIn: { via: string; url: string }[];
    loginLinks: { via: string; url: string }[];
    notes: string[];
}

/**
 * Build `web_login_link` over a config with the given webserver block.
 *
 * @param webserverYaml Body of the `webserver:` group.
 * @param proxy Public URL and auth flag of the registered plugin proxy.
 * @returns The tool and the session store.
 */
function build(
    webserverYaml: string,
    proxy: { url: string | null; hasBuiltInAuth: boolean } = {
        url: "https://familiar.example.ts.net/",
        hasBuiltInAuth: true,
    },
): { tool: PluginTool; sessions: MemoryWebSessionStore } {
    const configFile = path.join(scratch, "config.yml");
    writeFileSync(
        configFile,
        `core:\n  postgresPassword: pw\n  timezone: Europe/Berlin\nwebserver:\n${webserverYaml}`,
    );
    const sessions = new MemoryWebSessionStore();
    const proxies = new TrustedProxyRegistry();
    proxies.registerPluginProxy("tailscale", {
        secret: "s".repeat(32),
        userHeader: "Tailscale-User-Login",
        publicBaseUrl: () => proxy.url,
        hasBuiltInAuth: proxy.hasBuiltInAuth,
    });
    const [tool] = buildWebTools({ config: new HostConfigService(configFile), sessions, proxies });
    assert.ok(tool !== undefined);
    return { tool, sessions };
}

/** Enabled, bound to loopback so no LAN addresses are detected. */
const ENABLED =
    "  enabled: true\n  port: 8099\n  host: 127.0.0.1\n  auth:\n    users: [you@example.com, other@example.com]\n";

describe("web_login_link", () => {
    it("is privileged", () => {
        assert.equal(build(ENABLED).tool.level, "privileged");
    });

    it("lists a proxy with built-in auth as auto sign-in, without a token", async () => {
        const { tool, sessions } = build(ENABLED);
        const result = (await tool.execute({}, callCtx)) as LinkResult;
        assert.equal(result.login, "you@example.com");
        assert.match(result.expiresAt, /[+-]\d\d:\d\d$/);
        assert.deepEqual(result.autoSignIn, [
            { via: "plugin:tailscale", url: "https://familiar.example.ts.net/" },
        ]);
        const [token] = [...sessions.loginTokens.keys()];
        assert.deepEqual(result.loginLinks, [
            { via: "local", url: `http://localhost:8099/login/${token}` },
        ]);
        assert.ok(result.notes.some((note) => note.includes("only reachable on this machine")));
    });

    it("builds a login link under a proxy URL without built-in auth", async () => {
        const { tool } = build(ENABLED, {
            url: "https://tunnel.example.com",
            hasBuiltInAuth: false,
        });
        const result = (await tool.execute({}, callCtx)) as LinkResult;
        assert.deepEqual(result.autoSignIn, []);
        assert.deepEqual(
            result.loginLinks.map((entry) => entry.via),
            ["plugin:tailscale", "local"],
        );
        assert.ok(result.loginLinks[0]?.url.startsWith("https://tunnel.example.com/login/"));
    });

    it("puts configured LAN URLs and a custom base URL first, for another allowed user", async () => {
        const { tool, sessions } = build(`${ENABLED}  lanUrls: [http://pc.lan:8099/]\n`, {
            url: null,
            hasBuiltInAuth: true,
        });
        const result = (await tool.execute(
            { user: "Other@Example.com", baseUrl: "http://192.168.1.20:8099/" },
            callCtx,
        )) as LinkResult;
        assert.equal(result.login, "Other@Example.com");
        assert.deepEqual(
            result.loginLinks.map((entry) => entry.via),
            ["configured", "custom", "local"],
        );
        assert.ok(result.loginLinks[0]?.url.startsWith("http://pc.lan:8099/login/"));
        assert.ok(result.loginLinks[1]?.url.startsWith("http://192.168.1.20:8099/login/"));
        assert.equal([...sessions.loginTokens.values()][0]?.login, "Other@Example.com");
    });

    it("offers detected LAN addresses between direct and local links when bound to all interfaces", async () => {
        const { tool } = build(
            "  enabled: true\n  port: 8099\n  host: 0.0.0.0\n  auth:\n    users: [you@example.com]\n",
            { url: null, hasBuiltInAuth: true },
        );
        const result = (await tool.execute({}, callCtx)) as LinkResult;
        const vias = result.loginLinks.map((entry) => entry.via);
        assert.equal(vias.at(-1), "local");
        assert.ok(vias.slice(0, -1).every((via) => via === "detected"));
        assert.ok(result.loginLinks.every((entry) => !entry.url.includes("127.0.0.1")));
        assert.ok(result.notes.some((note) => note.includes("guesses")));
    });

    it("refuses logins outside the allowlist, bad base URLs and a disabled webserver", async () => {
        const { tool, sessions } = build(ENABLED);
        await assert.rejects(tool.execute({ user: "eve@example.com" }, callCtx), /not listed/);
        await assert.rejects(
            tool.execute({ baseUrl: "ftp://x" }, callCtx),
            /http:\/\/ or https:\/\//,
        );
        assert.equal(sessions.loginTokens.size, 0);

        const disabled = build("  enabled: false\n  auth:\n    users: [you@example.com]\n");
        await assert.rejects(disabled.tool.execute({}, callCtx), /webserver\.enabled/);
    });
});
