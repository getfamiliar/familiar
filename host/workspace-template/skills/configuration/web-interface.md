# Web interface access

Familiar has a web UI (core webserver, `webserver.*` in `config.yml`). Every visitor must be signed in, and only logins listed in `webserver.auth.users` get in. There are two ways in:

- **Automatic sign-in through a proxy.** Some access paths authenticate the user by themselves. The main one is the tailscale plugin: anyone opening the tailnet URL (`https://<name>.<tailnet>.ts.net/`) from a device in their tailnet is signed in with their Tailscale login. No link or password is needed.
- **One-time login link.** Everywhere else, e.g. directly at `http://localhost:8080` or a LAN address, the user signs in with a link that is valid for 10 minutes and works once. Opening it gives a browser session that lasts `webserver.auth.sessionDays` (default 30).

## When the user asks for access

Call `web_login_link` (privileged; tool group `web`). The tool always mints a fresh token. The result has:

| Field | Meaning |
| --- | --- |
| `autoSignIn` | URLs where the user is signed in automatically (e.g. `via: plugin:tailscale`). Give these as they are, **without** a token. |
| `loginLinks` | The same one-time link under every direct address, ordered from most to least reliable. `via` tells you which address it is: `configured` (in `webserver.lanUrls`, confirmed to work), `custom` (the `baseUrl` you passed), a proxy id (a proxy without its own login), `detected` (guessed from host name and network interfaces; may not work), `local` (`localhost`, works **only on the familiar machine itself**). |
| `notes` | Caveats about reachability, e.g. WSL2 or "detected addresses are guesses". Pass on the ones that matter. |
| `expiresAt` | When the link stops working (local time). |

## How to answer

Answer in the user's language and keep it short. Lead with what works best for them:

1. If there is an `autoSignIn` URL, offer it first: "Open `https://familiar.example.ts.net/` — you are signed in automatically there (needs Tailscale on your device)."
2. Then the login link for direct access. Usually that is the `configured` link, else `local`. Say where it works: "On the familiar computer itself, open: …". Add `detected` links only as "you can also try this from another device in your network", never as a sure thing.
3. Say that the link works once and expires at `expiresAt`.

Formatting in messengers (Telegram, WhatsApp, chat):

- Put every URL on its own line, inside backticks or a code block, so it can be copied exactly and the messenger does not shorten or preview it. Never change, shorten or wrap a URL.
- A `localhost` link opened on a phone does nothing. Explain that the user should copy it and open it in a browser on the familiar computer, e.g. via the messenger's desktop app.
- Give at most three URLs. If there are more, pick the most reliable ones.

Example:

> Du hast zwei Möglichkeiten:
>
> 1. Über Tailscale – dort bist du automatisch angemeldet:
>    `https://familiar.example.ts.net/`
> 2. Direkt am PC – diesen Link dort im Browser öffnen (einmalig gültig bis 14:35):
>    `http://localhost:8080/login/abc…`

## Finding an address that works from other devices

`localhost` only works on the machine itself. For phones and laptops without Tailscale, the web UI needs an address in the local network:

- `detected` links are candidates: the computer's host name and its LAN IP. Ask the user to try one from the other device.
- When one works, propose to remember it: `config_set webserver.lanUrls ["http://<host>:<port>"]`, then `config_reload`. Agree with the user first. From then on it is listed as `configured`, first in `loginLinks`.
- If a `notes` entry says familiar runs in **WSL2**, the WSL addresses are usually reachable only from Windows itself. Other devices need one of these, set up by the user on Windows:
  - WSL `networkingMode=mirrored` in `%UserProfile%\.wslconfig`, or
  - a port forwarding (`netsh interface portproxy add v4tov4 listenport=8080 connectport=8080 connectaddress=<wsl-ip>`) plus a firewall rule.

  The LAN URL is then the Windows computer's name or IP. Don't run or change these yourself; explain them when the user wants LAN access.
- If `webserver.host` is `127.0.0.1`, the web UI is local-only by choice (a note says so). Changing it to `0.0.0.0` opens it to the network. Only do that when the user asks, and point out that over plain HTTP in the LAN the link and the session travel unencrypted. Tailscale (HTTPS) is the safer way.

## Problems

- **"Forbidden: … is not listed in webserver.auth.users"**: the login (e.g. the Tailscale login) is not on the allowlist. Adding a login gives that person access to familiar. Only add it on an explicit request from the user, and only their own login or one they name: `config_set webserver.auth.users [...]`, then `config_reload`.
- **"This login link is invalid, already used or expired"**: create a new one.
- **`WebServerDisabled`**: the web UI is off. Enabling it needs `webserver.enabled: true` and at least one login in `webserver.auth.users`. Agree with the user first.
- **Lost device or a link sent to the wrong place**: the user can end sessions with `familiar web sessions list` / `familiar web sessions revoke <id|all>` in a terminal.

## Rules

- Send a login link only to the user who asked, in the current conversation. Never post it to groups or other recipients, and never write it into files, memory or wiki pages.
- Never mint a link unasked, e.g. as a side effect of another task.
