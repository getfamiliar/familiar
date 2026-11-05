# Proxy Plugins

A proxy plugin publishes the core webserver through some access technology (a VPN overlay, a tunnel, an identity-aware proxy) and passes the identity of the authenticated user on to it. The tailscale plugin (`plugins/tailscale`) is the reference implementation. This page explains the mechanism and is the guide for building further plugins of this kind. General plugin structure is covered in [create-plugins.md](create-plugins.md); the user-facing auth settings are in [config.md](../config.md#who-gets-in).

## The trusted-proxy contract

The webserver (`host/src/web/`) knows exactly two ways in: a session from a `familiar web login` link, and a **trusted proxy**. It has no code for any particular proxy product. A proxy plugin is therefore just one more trusted proxy, the same as an Authelia that a user configures under `webserver.auth.trustedProxies`.

A request counts as "from proxy X" only when it carries the header `X-Familiar-Proxy-Secret` (`PROXY_SECRET_HEADER` in `shared/src/WebAuth.ts`) with X's secret. Then, and only then:

| What the webserver does | Detail |
| --- | --- |
| Reads the proxy's `userHeader` as the login | Trimmed. It must be listed in `webserver.auth.users` (case-insensitive), otherwise `403`. |
| Reads the optional `nameHeader` as display name | Falls back to the login. |
| Decodes RFC 2047 encoded words in both headers | Non-ASCII text arrives e.g. as `=?utf-8?q?J=C3=BCrgen_Wei=C3=9F?=` (Tailscale does this); `MimeEncodedWord.ts` decodes it centrally, so a plugin passes the header through unchanged. |
| Treats an empty or missing `userHeader` as "no identity" | The request falls back to the session cookie, or the login flow. Use this for callers the proxy cannot identify (e.g. tagged tailnet devices). |
| Believes `X-Forwarded-Proto` | `https` there makes the session cookie `Secure`. |
| Believes `X-Forwarded-Host` | Used for the same-origin (CSRF) check of non-GET requests, because a proxy may rewrite `Host` to its upstream. |

A request with an unknown secret gets `401`. A request without the secret header has all identity headers ignored, whatever their name. That is the whole point: anyone who reaches `:8080` directly can send `Tailscale-User-Login: you@…`, but cannot send the secret.

A plugin registers itself in its **`prepare`** hook:

```ts
ctx.web.registerTrustedProxy({
    secret,                              // ≥ 32 characters (MIN_PROXY_SECRET_LENGTH)
    userHeader: "Tailscale-User-Login",  // header with the authenticated login
    nameHeader: "Tailscale-User-Name",   // optional
    publicBaseUrl: () => currentTailnetUrl(), // optional, see below
    hasBuiltInAuth: true,                     // optional, see below
});
```

`publicBaseUrl` tells the host where browsers reach the web UI through this proxy *right now* (`https://familiar.<tailnet>.ts.net`), or `null` while it is not serving. What happens with it depends on `hasBuiltInAuth`:

- `true`: the proxy signs users in by itself (Tailscale identity, an identity-aware proxy's login page). Then a login link there is pointless. `web_login_link` lists the bare URL under `autoSignIn` ("open it, you are signed in automatically"), and the agent's skill (`skills/configuration/web-interface.md`) offers it first.
- `false` (default): the proxy only publishes the webserver, e.g. a tunnel without identity. The one-time login link is built for the URL instead. Such a plugin does not need the trusted-proxy secret at all to get its URL into login links. But the contract has only one registration call, so it registers with a `userHeader` that the proxy never sets.

Keep the getter cheap and side-effect-free: return state the plugin already holds (the tailscale plugin remembers the DNS name once `tailscale serve` is applied and clears it on logout).

The registration gets the id `plugin:<plugin-id>`, which the start-up log line and the signed-in page show as `via plugin:<plugin-id>`. A plugin may register one proxy; a second call throws. The host drops the registration when the plugin restarts (config reload), and `prepare` registers it again. Registering in `prepare` also means it works without the daemon's `start` order mattering: the webserver reads the registry on every request.

## Why the proxy needs its own hop

Access technologies typically *do* pass the user's identity, but not in a way the webserver can verify:

- **Identity headers alone are forgeable.** `tailscale serve` strips client-sent `Tailscale-User-*` headers and sets its own, but that only protects requests that come through Serve. The webserver must bind `0.0.0.0` (Docker Desktop's `host.docker.internal` does not reach a loopback-only listener in WSL), so the LAN can reach it directly.
- **Source-IP checks are not reliable.** Docker Desktop NATs container traffic towards the host, so "came from the sidecar's IP" cannot be told apart from other callers. Do not build on it.
- **The access product usually cannot add a custom header.** `tailscale serve` has no option for extra request headers (a handler is only `Path` / `Proxy` / `Text`), and credentials in the target URL are not turned into an `Authorization` header either.

So the plugin puts a small, pinned reverse proxy between the access product and the webserver. Its only job is to add `X-Familiar-Proxy-Secret`, and the important part is *where* it listens:

```
browser ──HTTPS──▶ tailscale serve :443 ──▶ Caddy 127.0.0.1:18080 ──▶ host webserver :8080
                   (strips forged            (sets X-Familiar-
                    Tailscale-User-*,         Proxy-Secret)
                    sets the real ones)
        └──────── shared network namespace of familiar-tailscale ────────┘
```

The header proxy runs with `--network container:<access-container>`. It has no interface of its own on `familiar-net` and listens only on `127.0.0.1` of the shared namespace. Only the access product inside that namespace can reach it. If the proxy were a normal container on `familiar-net`, the agent container or any MCP container could call it, set `Tailscale-User-Login` themselves and have the proxy sign the forgery.

Joining the namespace also shares the access container's `/etc/hosts`, so `host.docker.internal` (added via `hostGatewayArgs()` on the access container) resolves in the proxy too. `--add-host` is not allowed together with `--network container:`.

## Building a proxy plugin

Use `plugins/tailscale/src/TailscaleProxy.ts` as the template; most of it carries over unchanged.

### 1. The secret

Generate it once into the plugin's data directory and reuse it, so the registration (from `prepare`) and the proxy config (from `start`) always agree, also across restarts:

```ts
export function readOrCreateProxySecret(pluginDataDir: string): string
```

`<dataDir>/<plugin-id>/proxy-secret`, 32 random bytes as base64url, mode `0600`. Do not put it into `config.yml`: the user never needs to see or type it.

### 2. Register in `prepare`

```ts
export default definePlugin({
    id: "example",
    host: {
        restartOnConfigChange: ["webserver.enabled", "webserver.port", "webserver.host"],
        prepare: (ctx) => registerTrustedProxy(ctx),
        start: (ctx) => startExampleDaemon(ctx),
        stop: () => stopExampleDaemon(),
    },
});
```

`prepare` is synchronous and must not touch the network; reading or writing the secret file is fine. List the `webserver.*` keys the plugin captures in `start` under `restartOnConfigChange`, so a port change regenerates the proxy config.

### 3. Start the access container, then the header proxy

In `start`, after checking `webserver.enabled` (log a warning and return when it is off):

1. Start the access container with `--network familiar-net` and `hostGatewayArgs()`. Run it as the host uid/gid (`--user`), not root.
2. Write the proxy config with the secret, mode `0600`, and mount it read-only. The proxy container runs as the same uid/gid so it can read the file.
3. Start the header proxy with `--network container:<access-container>`, no published ports.
4. Point the access product at `http://127.0.0.1:<proxy-port>`, never at the webserver directly.

The Caddyfile from `buildCaddyfile` is the reference config:

```
{
	admin off
	auto_https off
	persist_config off
	servers {
		trusted_proxies static 127.0.0.1/32 ::1/128
	}
}

:18080 {
	bind 127.0.0.1
	reverse_proxy host.docker.internal:8080 {
		header_up x-familiar-proxy-secret "<secret>"
	}
}
```

- `bind 127.0.0.1` keeps the listener inside the namespace.
- `header_up` *replaces* the header, so a client-sent value never survives.
- `trusted_proxies` makes Caddy keep the `X-Forwarded-Proto` / `X-Forwarded-Host` the access product set (otherwise the webserver sees `http` and the internal host). Only trust loopback here.
- Use the site address `:<port>` (any host), not `127.0.0.1:<port>`: the access product may forward the browser's `Host`.
- The admin API, automatic HTTPS and config persistence are off; TLS is the access product's job.
- Pin the image by digest (`docker buildx imagetools inspect caddy:<tag>`) and bump it deliberately, like every other image in the repo.

The access product must also strip client-sent copies of its identity headers before setting its own. Check this in its documentation before building the plugin; if it does not, the header proxy has to remove them (e.g. `header_up -<Header>` before setting the trusted value from a verified source).

### 4. Stop in reverse order

`stop` removes the header proxy first, then the access container. The proxy lives in the access container's namespace, so a restarted access container always needs a fresh proxy as well; `startProxy` removes a stale one before running a new one.

### 5. Tell the user what to configure

The plugin README must say that `webserver.auth.users` has to contain the logins the access product reports (for Tailscale: the tailnet login, usually an e-mail address). Explain who gets in and what happens to callers without identity. See the "Who can open it" section of `plugins/tailscale/README.md`.

## Testing

Unit tests (see `TailscaleProxy.test.ts`):

- The proxy config listens on loopback only and sets the secret header.
- The `docker run` arguments join the access container's namespace and have no `-p` / `--publish` / `--add-host`.
- The secret is created once with mode `0600` and returned unchanged afterwards.

The webserver side of the contract is covered once for all proxies in `host/src/web/WebServer.test.ts`. A proxy plugin does not need to re-test it.

Live checks, after `familiar start`:

```bash
# Forged identity without the secret is ignored → 401
curl -i -H 'Tailscale-User-Login: you@example.com' http://localhost:8080/

# The header proxy is not reachable from familiar-net → connection refused
docker exec familiar-agent curl -m 3 http://familiar-tailscale:18080/

# The access product points at the header proxy
docker exec familiar-tailscale tailscale --socket=/tmp/tailscaled.sock serve status
```

Then open the published URL from another device. The page shows `Signed in as … via plugin:<plugin-id>`.

## Checklist

- [ ] Secret generated once into `<dataDir>/<plugin-id>/proxy-secret` (0600), never in `config.yml`
- [ ] `ctx.web.registerTrustedProxy` called in `prepare`, with the product's user (and name) header, a `publicBaseUrl` getter and the right `hasBuiltInAuth`
- [ ] Access product verified to strip client-sent identity headers
- [ ] Header proxy pinned by digest, `--network container:<access-container>`, bound to `127.0.0.1`, no published ports
- [ ] Access product targets the header proxy, never the webserver directly
- [ ] `trusted_proxies` limited to loopback, so `X-Forwarded-Proto` / `-Host` survive
- [ ] `stop` removes proxy and access container; `restartOnConfigChange` lists the captured `webserver.*` keys
- [ ] README explains `webserver.auth.users` and the fallback for callers without identity
- [ ] Unit tests for the proxy config, run arguments and secret file
