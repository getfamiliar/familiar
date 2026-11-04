# Tailscale plugin

Makes the familiar web UI reachable from your other devices through your [tailnet](https://tailscale.com/kb/1136/tailnet), and nothing else of the machine familiar runs on.

## What it does

The plugin runs a dedicated Tailscale node as the docker sidecar `familiar-tailscale`, using the official `tailscale/tailscale` image pinned by digest. The node shows up in your tailnet as its own device, named `familiar` by default. It forwards exactly one thing: **HTTPS on port 443 → the familiar webserver** (`webserver.port` on the host).

The host itself does **not** join the tailnet. The node runs in userspace networking mode, without a TUN device. It accepts no routes or DNS from the tailnet, advertises no routes or exit node, and has Tailscale SSH off. There is no HTTP on port 80 either. A tailnet peer can therefore reach `https://familiar.<tailnet>.ts.net/` and nothing else: no other port, not the host, not your LAN.

## Requirements

- `webserver.enabled: true` in `config/config.yml`. The webserver must bind on all interfaces (`webserver.host`, default `0.0.0.0`) so the container can reach it via `host.docker.internal`. Without the webserver the plugin logs a warning and does not start.
- In the [Tailscale admin console](https://login.tailscale.com/admin/dns): **MagicDNS** and **HTTPS certificates** enabled. Without them, the node joins the tailnet but HTTPS requests fail, because no certificate can be issued for `*.ts.net`. Check with `docker logs familiar-tailscale`.

## Setup

1. Add `@getfamiliar/plugin-tailscale` to `config/plugins`.
2. Optionally set a device name with `familiar config set tailscale.hostname familiar`.
3. Start the daemon (`familiar start`), or restart it if it is already running.
4. Run `familiar tailscale login`, open the printed URL, and approve the device. The command waits and then prints the web UI URL.

For an unattended first login, set an [auth key](https://tailscale.com/kb/1085/auth-keys) instead: `familiar config set tailscale.authKey` prompts for it with hidden input. The key is only used for the first login, after which the node state in `data/tailscale/state/` is reused.

## Commands

| Command | Purpose |
| --- | --- |
| `familiar tailscale status` | Login state, device name, web UI URL, login URL while logged out. |
| `familiar tailscale login` | Print the login URL and wait until the node is in the tailnet. |
| `familiar tailscale logout` | Remove the node from the tailnet; it then waits for a new login. |

All three need the running daemon, which owns the sidecar.

## Who can open it

Anyone your tailnet ACLs allow to reach the `familiar` device. The webserver has no login of its own yet. To restrict access, tag the device and grant `tcp:443` on that tag only to yourself, e.g. in the tailnet policy file:

```json
"grants": [{ "src": ["you@example.com"], "dst": ["tag:familiar"], "ip": ["tcp:443"] }]
```

Tailscale passes the caller's identity to the webserver as the `Tailscale-User-Login` / `Tailscale-User-Name` headers. The webserver will use these later for its own authentication.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `tailscale.hostname` | `familiar` | Device name → `https://<hostname>.<tailnet>.ts.net/`. |
| `tailscale.authKey` | – | Optional auth key for an unattended first login (secret). |

Changing `tailscale.*` or `webserver.enabled` / `port` / `host` restarts the plugin on `familiar config reload`, which also regenerates the serve config.
