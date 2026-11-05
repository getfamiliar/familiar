import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    PROXY_SECRET_HEADER,
    type WebAuthPageView,
    type WebUi,
    type WebUiEnv,
} from "@getfamiliar/shared";
import { MockLogger } from "@getfamiliar/shared/testing";
import { Hono } from "hono";
import { HostConfigService } from "../utils/ConfigService.js";
import { MemoryWebSessionStore } from "./auth/MemoryWebSessionStore.js";
import { TrustedProxyRegistry } from "./auth/TrustedProxyRegistry.js";
import { SESSION_COOKIE } from "./auth/WebAuth.js";
import { WebPluginRegistry } from "./WebPluginRegistry.js";
import { WebServer } from "./WebServer.js";
import { WebUiRegistry } from "./WebUiRegistry.js";

/** Auth block every enabled test server gets unless a test overrides it. */
const AUTH_YAML =
    "  auth:\n    users: [me@example.com]\n    trustedProxies:\n      authelia:\n        userHeader: Remote-User\n        secret: config-secret-config-secret-config-secret\n";

/** Secret of the plugin-registered proxy in {@link build}. */
const PLUGIN_SECRET = "plugin-secret-plugin-secret-plugin-secret";

let scratch: string;
let servers: WebServer[];

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-webserver-"));
    servers = [];
});

afterEach(async () => {
    for (const server of servers) {
        await server.stop();
    }
    rmSync(scratch, { recursive: true, force: true });
});

/**
 * Build a WebServer over a real config file with the given `webserver` block.
 *
 * @param webserverYaml Indented body of the `webserver:` group, or "" for none.
 * @returns The server and the config file path.
 */
function build(webserverYaml: string): {
    server: WebServer;
    configFile: string;
    sessions: MemoryWebSessionStore;
    proxies: TrustedProxyRegistry;
    webUis: WebUiRegistry;
    webPlugins: WebPluginRegistry;
} {
    const configFile = path.join(scratch, "config.yml");
    writeFileSync(configFile, configYaml(webserverYaml));
    const sessions = new MemoryWebSessionStore();
    const proxies = new TrustedProxyRegistry();
    proxies.registerPluginProxy("tailscale", {
        secret: PLUGIN_SECRET,
        userHeader: "Tailscale-User-Login",
        nameHeader: "Tailscale-User-Name",
    });
    const webUis = new WebUiRegistry();
    const webPlugins = new WebPluginRegistry();
    const server = new WebServer({
        config: new HostConfigService(configFile),
        log: new MockLogger(),
        trustedProxies: proxies,
        sessions,
        webUis,
        webPlugins,
    });
    servers.push(server);
    return { server, configFile, sessions, proxies, webUis, webPlugins };
}

/**
 * Start an enabled server on a random loopback port with {@link AUTH_YAML}.
 *
 * @returns The listening URL plus the stores.
 */
async function startWithAuth(extraYaml = ""): Promise<{
    url: string;
    server: WebServer;
    sessions: MemoryWebSessionStore;
    proxies: TrustedProxyRegistry;
    webUis: WebUiRegistry;
    webPlugins: WebPluginRegistry;
}> {
    const built = build(`  enabled: true\n  port: 0\n  host: 127.0.0.1\n${extraYaml}${AUTH_YAML}`);
    await built.server.start();
    const url = built.server.listeningUrl;
    assert.ok(url !== null);
    return {
        url,
        server: built.server,
        sessions: built.sessions,
        proxies: built.proxies,
        webUis: built.webUis,
        webPlugins: built.webPlugins,
    };
}

/** Headers of an allowlisted user vouched for by the plugin proxy. */
const SIGNED_IN = {
    [PROXY_SECRET_HEADER]: PLUGIN_SECRET,
    "tailscale-user-login": "me@example.com",
};

/**
 * A minimal web UI root controller that echoes the principal and has a
 * catch-all, as a SPA controller would.
 *
 * @param label Text identifying this controller in responses.
 * @returns The controller.
 */
function fakeWebUi(label: string, renderAuthPage?: WebUi["renderAuthPage"]): WebUi {
    const controller = new Hono<WebUiEnv>();
    controller.get("/api/me", (c) => c.json({ label, ...c.get("principal") }));
    controller.get("*", (c) => c.text(`${label} page`));
    return { controller, renderAuthPage };
}

/**
 * Sign in through the login-link flow.
 *
 * @param url Server URL.
 * @param sessions Session store.
 * @returns The `name=value` session cookie.
 */
async function signIn(url: string, sessions: MemoryWebSessionStore): Promise<string> {
    const token = await sessions.createLoginToken("me@example.com", 60_000);
    const res = await fetch(`${url}/login/${token}`, {
        method: "POST",
        headers: { origin: url },
        redirect: "manual",
    });
    assert.equal(res.status, 303);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(cookie, /HttpOnly/);
    return cookie.split(";")[0] ?? "";
}

/**
 * @param webserverYaml Indented body of the `webserver:` group, or "" for none.
 * @returns A config.yml text.
 */
function configYaml(webserverYaml: string): string {
    const group = webserverYaml === "" ? "" : `webserver:\n${webserverYaml}`;
    return `core:\n  postgresPassword: pw\n${group}`;
}

describe("WebServer", () => {
    it("does not listen when webserver.enabled is missing or false", async () => {
        const { server: missing } = build("");
        await missing.start();
        assert.equal(missing.listeningUrl, null);

        const { server: disabled } = build("  enabled: false\n  port: 0\n");
        await disabled.start();
        assert.equal(disabled.listeningUrl, null);
    });

    it("refuses to start without webserver.auth.users", async () => {
        const { server } = build("  enabled: true\n  port: 0\n  host: 127.0.0.1\n");
        await assert.rejects(server.start(), /webserver\.auth\.users is empty/);
        assert.equal(server.listeningUrl, null);
    });

    it("redirects browsers to /login and answers 401 to other clients without identity", async () => {
        const { url } = await startWithAuth();
        const page = await fetch(`${url}/`, {
            headers: { accept: "text/html" },
            redirect: "manual",
        });
        assert.equal(page.status, 302);
        assert.equal(page.headers.get("location"), "/login");
        assert.equal((await fetch(`${url}/`)).status, 401);
        const login = await fetch(`${url}/login`);
        assert.equal(login.status, 200);
        assert.match(await login.text(), /You are not signed in/);
    });

    it("shows on /login who is signed in, with a link to the root", async () => {
        const { url, sessions } = await startWithAuth();
        const cookie = await signIn(url, sessions);
        const viaSession = await (await fetch(`${url}/login`, { headers: { cookie } })).text();
        assert.match(viaSession, /You are signed in as me@example\.com/);
        assert.match(viaSession, /via\s+session/);
        assert.match(viaSession, /<a href="\/">/);

        const viaProxy = await (
            await fetch(`${url}/login`, {
                headers: {
                    [PROXY_SECRET_HEADER]: PLUGIN_SECRET,
                    "tailscale-user-login": "me@example.com",
                },
            })
        ).text();
        assert.match(viaProxy, /via\s+plugin:tailscale/);

        // A login outside the allowlist is not "signed in" on /login.
        const stranger = await (
            await fetch(`${url}/login`, {
                headers: {
                    [PROXY_SECRET_HEADER]: PLUGIN_SECRET,
                    "tailscale-user-login": "eve@example.com",
                },
            })
        ).text();
        assert.match(stranger, /You are not signed in/);
    });

    it("ignores identity headers without a trusted-proxy secret", async () => {
        const { url } = await startWithAuth();
        const res = await fetch(`${url}/`, {
            headers: { "tailscale-user-login": "me@example.com", "remote-user": "me@example.com" },
        });
        assert.equal(res.status, 401);
    });

    it("rejects an unknown trusted-proxy secret", async () => {
        const { url } = await startWithAuth();
        const res = await fetch(`${url}/`, {
            headers: { [PROXY_SECRET_HEADER]: "x".repeat(40), "remote-user": "me@example.com" },
        });
        assert.equal(res.status, 401);
    });

    it("trusts the user header of a plugin-registered proxy and checks the allowlist", async () => {
        const { url } = await startWithAuth();
        const ok = await fetch(`${url}/`, {
            headers: {
                [PROXY_SECRET_HEADER]: PLUGIN_SECRET,
                "tailscale-user-login": "Me@Example.com",
                "tailscale-user-name": "=?utf-8?q?M=C3=BC_<b>?=",
            },
        });
        assert.equal(ok.status, 200);
        const body = await ok.text();
        assert.match(body, /<h1>No web UI installed<\/h1>/);
        assert.match(body, /Mü &lt;b&gt;/);
        assert.match(body, /via plugin:tailscale/);

        const stranger = await fetch(`${url}/`, {
            headers: {
                [PROXY_SECRET_HEADER]: PLUGIN_SECRET,
                "tailscale-user-login": "eve@example.com",
            },
        });
        assert.equal(stranger.status, 403);

        // The plugin's header is not trusted with the config proxy's secret.
        const crossed = await fetch(`${url}/`, {
            headers: {
                [PROXY_SECRET_HEADER]: "config-secret-config-secret-config-secret",
                "tailscale-user-login": "me@example.com",
            },
        });
        assert.equal(crossed.status, 401);
    });

    it("trusts a config-defined proxy", async () => {
        const { url } = await startWithAuth();
        const res = await fetch(`${url}/`, {
            headers: {
                [PROXY_SECRET_HEADER]: "config-secret-config-secret-config-secret",
                "remote-user": "me@example.com",
            },
        });
        assert.equal(res.status, 200);
        assert.match(await res.text(), /via config:authelia/);
    });

    it("falls back to the session when a trusted proxy sends no login", async () => {
        const { url, sessions } = await startWithAuth();
        const anonymous = await fetch(`${url}/`, {
            headers: { [PROXY_SECRET_HEADER]: PLUGIN_SECRET },
        });
        assert.equal(anonymous.status, 401);
        const cookie = await signIn(url, sessions);
        const withSession = await fetch(`${url}/`, {
            headers: { [PROXY_SECRET_HEADER]: PLUGIN_SECRET, cookie },
        });
        assert.equal(withSession.status, 200);
    });

    it("drops a plugin proxy once the plugin is unregistered", async () => {
        const { url, proxies } = await startWithAuth();
        proxies.unregisterPlugin("tailscale");
        const res = await fetch(`${url}/`, {
            headers: {
                [PROXY_SECRET_HEADER]: PLUGIN_SECRET,
                "tailscale-user-login": "me@example.com",
            },
        });
        assert.equal(res.status, 401);
    });

    it("signs in with a one-time login link and signs out again", async () => {
        const { url, sessions } = await startWithAuth();
        const token = await sessions.createLoginToken("me@example.com", 60_000);

        // GET only shows the confirmation form; the token stays valid.
        const confirm = await fetch(`${url}/login/${token}`);
        assert.equal(confirm.status, 200);
        assert.match(await confirm.text(), /method="post"/);
        assert.equal(sessions.loginTokens.size, 1);

        const redeem = await fetch(`${url}/login/${token}`, {
            method: "POST",
            headers: { origin: url },
            redirect: "manual",
        });
        assert.equal(redeem.status, 303);
        const cookie = (redeem.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        assert.equal((await fetch(`${url}/`, { headers: { cookie } })).status, 200);

        const reused = await fetch(`${url}/login/${token}`, {
            method: "POST",
            headers: { origin: url },
        });
        assert.equal(reused.status, 401);

        const logout = await fetch(`${url}/logout`, {
            method: "POST",
            headers: { origin: url, cookie },
            redirect: "manual",
        });
        assert.equal(logout.status, 303);
        assert.equal((await fetch(`${url}/`, { headers: { cookie } })).status, 401);
    });

    it("rejects expired login links and revoked sessions", async () => {
        const { url, sessions } = await startWithAuth();
        const expired = await sessions.createLoginToken("me@example.com", -1);
        const res = await fetch(`${url}/login/${expired}`, {
            method: "POST",
            headers: { origin: url },
        });
        assert.equal(res.status, 401);

        const cookie = await signIn(url, sessions);
        assert.equal(await sessions.revokeSessions("all"), 1);
        assert.equal((await fetch(`${url}/`, { headers: { cookie } })).status, 401);
    });

    it("rejects cross-origin state-changing requests", async () => {
        const { url, sessions } = await startWithAuth();
        const token = await sessions.createLoginToken("me@example.com", 60_000);
        const foreign = await fetch(`${url}/login/${token}`, {
            method: "POST",
            headers: { origin: "https://evil.example" },
        });
        assert.equal(foreign.status, 403);
        const missing = await fetch(`${url}/login/${token}`, { method: "POST" });
        assert.equal(missing.status, 403);
        assert.equal(sessions.loginTokens.size, 1);
    });

    it("marks the cookie Secure behind a proxy that forwards HTTPS", async () => {
        const { url, sessions } = await startWithAuth();
        const token = await sessions.createLoginToken("me@example.com", 60_000);
        const res = await fetch(`${url}/login/${token}`, {
            method: "POST",
            headers: {
                origin: url,
                [PROXY_SECRET_HEADER]: PLUGIN_SECRET,
                "x-forwarded-proto": "https",
            },
            redirect: "manual",
        });
        assert.equal(res.status, 303);
        assert.match(res.headers.get("set-cookie") ?? "", /Secure/);
    });

    it("serves the fallback page on every GET and 404s other methods without a web UI", async () => {
        const { url } = await startWithAuth();
        const res = await fetch(`${url}/nope`, { headers: SIGNED_IN });
        assert.equal(res.status, 200);
        assert.match(await res.text(), /@getfamiliar\/plugin-web-ui/);
        const post = await fetch(`${url}/nope`, {
            method: "POST",
            headers: { ...SIGNED_IN, origin: url },
        });
        assert.equal(post.status, 404);
    });

    it("mounts the web UI controller behind auth, with the core login routes first", async () => {
        const { url, webUis } = await startWithAuth();
        webUis.set("web-ui", fakeWebUi("A"));

        const me = await fetch(`${url}/api/me`, { headers: SIGNED_IN });
        assert.equal(me.status, 200);
        assert.deepEqual(await me.json(), {
            label: "A",
            login: "me@example.com",
            displayName: "me@example.com",
            via: "plugin:tailscale",
        });
        assert.equal(
            await (await fetch(`${url}/deep/link`, { headers: SIGNED_IN })).text(),
            "A page",
        );
        assert.match(
            await (await fetch(`${url}/login`, { headers: SIGNED_IN })).text(),
            /Signed in/,
        );
        assert.equal((await fetch(`${url}/api/me`)).status, 401);
    });

    it("lets the web UI render the login pages, under the core's CSP and logic", async () => {
        const { url, webUis, sessions } = await startWithAuth();
        const views: WebAuthPageView[] = [];
        webUis.set(
            "web-ui",
            fakeWebUi("A", async (view) => {
                views.push(view);
                return `<!doctype html><p>pretty ${view.kind}</p>`;
            }),
        );

        const signedOut = await fetch(`${url}/login`);
        assert.equal(await signedOut.text(), "<!doctype html><p>pretty signedOut</p>");
        assert.match(signedOut.headers.get("content-security-policy") ?? "", /default-src 'none'/);
        assert.equal(signedOut.headers.get("cache-control"), "no-store");

        await fetch(`${url}/login`, { headers: SIGNED_IN });
        const token = await sessions.createLoginToken("me@example.com", 60_000);
        await fetch(`${url}/login/${token}`);
        assert.equal(sessions.loginTokens.size, 1);
        const invalid = await fetch(`${url}/login/bogus`, {
            method: "POST",
            headers: { origin: url },
        });
        assert.equal(invalid.status, 401);

        assert.deepEqual(views, [
            { kind: "signedOut", loginCommand: "familiar web login" },
            {
                kind: "signedIn",
                principal: {
                    login: "me@example.com",
                    displayName: "me@example.com",
                    via: "plugin:tailscale",
                },
                continueUrl: "/",
                logoutAction: "/logout",
            },
            { kind: "confirmLoginLink", formAction: `/login/${token}` },
            { kind: "invalidLoginLink", loginCommand: "familiar web login" },
        ]);

        // Redeeming stays core logic: cookie + redirect, no page rendered.
        const redeem = await fetch(`${url}/login/${token}`, {
            method: "POST",
            headers: { origin: url },
            redirect: "manual",
        });
        assert.equal(redeem.status, 303);
        assert.equal(views.length, 4);
    });

    it("falls back to the plain login page when the web UI's renderer throws", async () => {
        const { url, webUis } = await startWithAuth();
        webUis.set(
            "web-ui",
            fakeWebUi("A", async () => {
                throw new Error("boom");
            }),
        );
        const res = await fetch(`${url}/login`);
        assert.equal(res.status, 200);
        assert.match(await res.text(), /You are not signed in/);
        assert.match(res.headers.get("content-security-policy") ?? "", /form-action 'self'/);
    });

    it("mounts plugin controllers at /plugins/<id> behind auth; page routes fall through to the UI", async () => {
        const { url, webUis, webPlugins } = await startWithAuth();
        webUis.set("web-ui", fakeWebUi("A"));
        const controller = new Hono<WebUiEnv>();
        controller.get("/api/hello", (c) => c.json({ hello: c.get("principal").login }));
        webPlugins.set("web-chat", { controller, page: { module: "page/page.js" } });

        const hello = await fetch(`${url}/plugins/web-chat/api/hello`, { headers: SIGNED_IN });
        assert.deepEqual(await hello.json(), { hello: "me@example.com" });
        assert.equal((await fetch(`${url}/plugins/web-chat/api/hello`)).status, 401);
        assert.equal(
            await (await fetch(`${url}/plugins/web-chat`, { headers: SIGNED_IN })).text(),
            "A page",
        );
        assert.equal(
            await (
                await fetch(`${url}/plugins/web-chat/some/route`, { headers: SIGNED_IN })
            ).text(),
            "A page",
        );

        webPlugins.unregisterPlugin("web-chat");
        assert.equal(
            await (await fetch(`${url}/plugins/web-chat/api/hello`, { headers: SIGNED_IN })).text(),
            "A page",
        );
    });

    it("swaps the web UI in place when the registry changes", async () => {
        const { url, webUis } = await startWithAuth();
        webUis.set("web-ui", fakeWebUi("A"));
        assert.equal(await (await fetch(`${url}/`, { headers: SIGNED_IN })).text(), "A page");
        webUis.unregisterPlugin("web-ui");
        assert.match(
            await (await fetch(`${url}/`, { headers: SIGNED_IN })).text(),
            /No web UI installed/,
        );
        webUis.set("web-ui", fakeWebUi("B"));
        assert.equal(await (await fetch(`${url}/`, { headers: SIGNED_IN })).text(), "B page");
    });

    it("asks for webserver.uiPlugin when several plugins provide a web UI", async () => {
        const { url, webUis } = await startWithAuth();
        webUis.set("one", fakeWebUi("one"));
        webUis.set("two", fakeWebUi("two"));
        const ambiguous = await (await fetch(`${url}/`, { headers: SIGNED_IN })).text();
        assert.match(ambiguous, /Several plugins provide a web UI \(one, two\)/);
        assert.match(ambiguous, /webserver\.uiPlugin/);
    });

    it("serves the web UI named by webserver.uiPlugin, or says it is missing", async () => {
        const { url, webUis } = await startWithAuth("  uiPlugin: two\n");
        webUis.set("one", fakeWebUi("one"));
        assert.match(
            await (await fetch(`${url}/`, { headers: SIGNED_IN })).text(),
            /names &quot;two&quot;, but that plugin provides no web UI/,
        );
        webUis.set("two", fakeWebUi("two"));
        assert.equal(await (await fetch(`${url}/`, { headers: SIGNED_IN })).text(), "two page");
    });

    it("fails with a message naming the port when it is in use", async () => {
        const blocker: Server = createServer();
        await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
        const port = (blocker.address() as AddressInfo).port;
        try {
            const { server } = build(
                `  enabled: true\n  port: ${port}\n  host: 127.0.0.1\n${AUTH_YAML}`,
            );
            await assert.rejects(server.start(), new RegExp(`127\\.0\\.0\\.1:${port}.*in use`));
            assert.equal(server.listeningUrl, null);
        } finally {
            await new Promise<void>((resolve) => blocker.close(() => resolve()));
        }
    });

    it("frees the port on stop and follows config on reload", async () => {
        const { server, configFile, sessions, proxies } = build(
            `  enabled: true\n  port: 0\n  host: 127.0.0.1\n${AUTH_YAML}`,
        );
        await server.start();
        const firstUrl = server.listeningUrl;
        assert.ok(firstUrl !== null);

        await server.stop();
        assert.equal(server.listeningUrl, null);
        await assert.rejects(fetch(`${firstUrl}/`));

        const config = new HostConfigService(configFile);
        const reloadable = new WebServer({
            config,
            log: new MockLogger(),
            trustedProxies: proxies,
            sessions,
            webUis: new WebUiRegistry(),
            webPlugins: new WebPluginRegistry(),
        });
        servers.push(reloadable);
        await reloadable.start();
        assert.ok(reloadable.listeningUrl !== null);
        writeFileSync(configFile, configYaml("  enabled: false\n"));
        config.reload([]);
        await reloadable.reload();
        assert.equal(reloadable.listeningUrl, null);
    });
});
