# Tesla plugin

Read-only access to the user's Tesla through the unofficial **Owner API**: vehicle list, full state, position, and the Supercharger / Premium Connectivity invoice PDFs the monthly bookkeeping needs.

The Owner API was chosen over Tesla's official Fleet API because it needs no developer-app registration, no partner-account onboarding and no per-call billing — the user signs in once with their normal Tesla account and the plugin keeps a refresh token on the host.

The plugin runs on operational defaults — no `tesla:` block in `config.yml` is required. Real enablement is gated on a cached login under `data/tesla/auth.json`; run `familiar tesla login` to add one.

## What the agent sees

The plugin emits no events and runs no pollers. Every capability is a tool the agent calls on demand, and the workspace skill at `skills/tesla/SKILL.md` tells it when to reach for which.

| Tool | Arguments | Effect |
|------|-----------|--------|
| `tesla_vehicles_list` | — | Vehicles on the account: `id`, `vin`, `display_name`, `state`, `is_default`. Never wakes anything. |
| `tesla_set_default_vehicle` | `id` | Remembers which vehicle the other tools act on. Validated against the live list. |
| `tesla_info` | — | Full `vehicle_data` rollup. Wakes the car first. |
| `tesla_location` | — | Latitude, longitude, heading, and the local time of the GPS fix. Wakes the car first. |
| `tesla_invoices` | `from_day?`, `to_day?`, `kind?` | Downloads invoice PDFs into `/scratch/<event-id>/` and returns a table of paths. |

Handlers can pull the whole set in with `tools: tesla` — the plugin id doubles as a tool group.

### Choosing a vehicle

Every vehicle tool resolves a default first. One car on the account is adopted silently. Several cars with no default set produce a normal result carrying `needs_vehicle_choice: true` and a table of the cars — deliberately **not** an error, because the agent is supposed to act on it: show the list, ask, call `tesla_set_default_vehicle`, retry. A remembered vehicle that has since left the account is treated as unset, so swapping cars self-heals.

The choice lives in `data/tesla/default-vehicle.json`.

### Waking and cached answers

A parked Tesla sleeps and answers `408 vehicle unavailable`. `tesla_info` and `tesla_location` therefore call `wake_up` and poll the vehicle's state every two seconds until it reports `online` or `tesla.wakeTimeoutSeconds` (default 30) passes.

On timeout the tools still answer — from `data/tesla/cache/<vehicleId>.json`, the last rollup that came back successfully — and mark the result `from_cache: true` with a `cached_at` timestamp. The skill instructs the agent to pass that age on rather than presenting stale data as current. When nothing is cached either, the tool fails with `VEHICLE_ASLEEP`.

`tesla_info` and `tesla_location` share one cache entry, because location is a slice of the same rollup; caching them separately would let the two answers disagree about when the car was last seen.

### Invoices

`tesla_invoices` merges two unrelated billing sources:

- **Supercharging** — one invoice per paid session, with the site name and the summed fees. Sessions on free supercharging carry no invoice and simply don't appear.
- **Connectivity** — the Premium Connectivity subscription, one invoice per billing period. Tesla's subscription endpoint returns no amount at all (only date, id, filename), so these rows carry `read the PDF at filepath — not in the API` in the `amount` column rather than a blank, which would read as "this one was free".

`from_day` / `to_day` are inclusive `YYYY-MM-DD` **local** days (interpreted in `core.timezone`), matching `cal_get_events`' convention. Omitting both selects the last full calendar month — the monthly-bookkeeping case. Neither Tesla endpoint filters by date server-side, so the range narrows a list the plugin already holds.

Each PDF is staged as its own file under `/scratch/<event-id>/` with a per-call random suffix so concurrent runs can't clobber each other, and the tool returns `filepath | kind | date | location | amount`. Scratch is swept after 24 hours, so the agent is told to finish the job in the same run.

## Setting up

### 1. Log in

```bash
familiar tesla login
```

The command asks for the account e-mail, the password, and — when the account has multi-factor enabled — the authenticator code. **None of the three is ever written to disk**; they exist only as locals for the duration of the command. Only the resulting tokens are persisted, to `data/tesla/auth.json` at mode `0600`.

Tesla's SSO sits behind a WAF that frequently challenges scripted credential posts. When that happens the command doesn't fail — it prints the authorize URL and walks you through reading the code out of the browser instead:

```
Scripted login was refused: Tesla answered the login with a captcha challenge.

Falling back to the browser.

Tesla redirects the finished login to `tesla://auth/callback?code=…`, a custom
scheme no browser can open — so the code has to be read out of devtools rather
than the address bar.

 1. Open a browser and press F12, go to the Network tab, tick "Preserve log".
 2. Open this URL in that tab and sign in:
    https://auth.tesla.com/oauth2/v3/authorize?client_id=ownerapi&…
 3. The page ends on an error or an "open an app?" prompt — that is expected.
 4. Find the last `authorize` request (status 302), open
    Headers → Response Headers, copy the full `location:` value.
 5. Paste it below.

? Callback URL ›
```

**"Preserve log" matters**: without it the browser wipes the Network list on each navigation and the `302` you need disappears before you can read it.

The authorization code is parsed out of the pasted URL and redeemed with the same PKCE verifier the scripted attempt generated, so both paths end in the same token file.

Restart the daemon afterwards so the running agent picks the login up.

### 2. Verify

```bash
familiar tesla status     # login state (proven by an actual refresh) + default vehicle
familiar tesla vehicles   # the vehicle table
```

Both work whether the daemon is running or not — they talk to Tesla directly using the host-side token file, no bastion involved. `familiar tesla logout` deletes the token file.

### 3. (Optional) Configure

```yaml
tesla:
  wakeTimeoutSeconds: 30
  deviceCountry: DE
  deviceLanguage: de
  locale: de_DE
  teslaAppUserAgent: "TeslaApp/4.28.3-2167"
  userAgent: "Tesla/1195 CFNetwork/1388 Darwin/22.0.0"
```

## Endpoints used

| Host | Method + path | Purpose |
|------|---------------|---------|
| `auth.tesla.com` | `GET /oauth2/v3/authorize` | Login page; hidden form fields + session cookie are scraped from it. |
| `auth.tesla.com` | `POST /oauth2/v3/authorize` | Credential post. Answers `302` with the code in `Location`. |
| `auth.tesla.com` | `GET /oauth2/v3/authorize/mfa/factors` | Lists the account's enrolled MFA factors. |
| `auth.tesla.com` | `POST /oauth2/v3/authorize/mfa/verify` | Verifies the authenticator code. |
| `auth.tesla.com` | `POST /oauth2/v3/token` | Code exchange and refresh. `client_id=ownerapi`. |

The `redirect_uri` throughout is **`tesla://auth/callback`** — see below.
| `owner-api.teslamotors.com` | `GET /api/1/products` | Vehicle list. **Not** `/api/1/vehicles` — see below. |
| `owner-api.teslamotors.com` | `GET /api/1/vehicles/{id}` | One vehicle's summary; the wake-up poll watches its `state`. |
| `owner-api.teslamotors.com` | `POST /api/1/vehicles/{id}/wake_up` | Asks a sleeping car to wake. Returns immediately. |
| `owner-api.teslamotors.com` | `GET /api/1/vehicles/{id}/vehicle_data` | Full state rollup. Requires the car to be awake. |
| `ownership.tesla.com` | `GET /mobile-app/charging/history` | Supercharger sessions with their invoice references. |
| `ownership.tesla.com` | `GET /mobile-app/charging/invoice/{contentId}` | One Supercharger invoice as binary PDF. |
| `ownership.tesla.com` | `GET /mobile-app/subscriptions/invoices` | Premium Connectivity invoice list. |
| `ownership.tesla.com` | `GET /mobile-app/documents/invoices/{InvoiceId}` | One subscription invoice as binary PDF. |

Every `ownership.tesla.com` call carries `deviceLanguage`, `deviceCountry`, `httpLocale` and `vin` as query parameters, plus `Authorization`, `x-tesla-user-agent` and `User-Agent` headers. Details that are easy to get wrong and cost hours:

- **`operationName=getChargingHistoryV2`** on the charging-history call is what makes it return the account's full session list. Without it the endpoint degrades to the few most recent sessions, which is useless for a closed month.
- **`optionCode=$CPF1`** on the subscription-invoice call is the Premium Connectivity product code and is mandatory.
- The subscription endpoints spell the locale parameter **`httpLocale`**. (`ttpLocale` belongs to a different, GraphQL-based charging surface this plugin does not use.)
- The charging payload is **camelCase** (`chargeStartDateTime`, `contentId`); the subscription payload is **PascalCase** (`InvoiceDate`, `InvoiceId`). Same host, different teams.
- The paths come from the mobile app's endpoint table as `bff/v2/mobile-app/…`. **Drop the `bff/v2` prefix** — keeping it yields a `param is missing` error.

## Things worth knowing

### `/api/1/vehicles` is dead; `/api/1/products` is not

The obvious endpoint for listing vehicles now answers:

> `412` — `{"error": "Endpoint is only available on fleetapi. Visit https://developer.tesla.com/docs for more info"}`

Only that one **collection** route was withdrawn. `GET /api/1/products` still answers `200` and carries everything the list needs (`id_s`, `vin`, `display_name`, `state`), and every per-vehicle route under `/api/1/vehicles/{id}/…` — including `vehicle_data` and `wake_up` — keeps working normally. So the plugin lists from `products` and addresses vehicles as before.

`products` also returns energy products (Powerwall, solar); those carry no `vin` and are filtered out.

This is worth keeping an eye on: Tesla is retiring the Owner API route by route, so the next thing to break will probably also be a single endpoint with a working neighbour rather than a wholesale shutdown.

### Flaky links are handled, refusals are not retried

Every request — the four SSO calls and both REST clients — goes through one retry layer (`src/HttpRetry.ts`). It retries **connection-level** failures only: DNS, connect timeouts, resets, `fetch`'s opaque `TypeError: fetch failed`. Three retries with a growing delay, plus a 20-second ceiling per SSO attempt so a stalled socket fails instead of hanging.

An HTTP *answer* is never retried, whatever its status. That distinction matters: hammering `auth.tesla.com` after it refuses a login is what gets an account flagged, whereas a connection that never reached Tesla is nobody's business but the network's.

When every attempt fails you get `could not reach owner-api.teslamotors.com after 4 attempts: fetch failed (ETIMEDOUT)` rather than a bare `fetch failed` — the host and the underlying code are both named. `AggregateError`, which Node raises when a host resolves to several addresses and all of them fail, has an **empty** `message`; `describeError` in `src/ErrorText.ts` exists because rendering it naively produced `Refresh: FAILED — ` and made a train tunnel look like a dead login.

### `https://auth.tesla.com/void/callback` is dead

Every older guide — timdorr's included — pairs `client_id=ownerapi` with `redirect_uri=https://auth.tesla.com/void/callback`. Tesla retired that registration. Using it now fails the flow before the login form is even rendered:

> The 'redirect_uri' supplied is not registered for this 'client_id'.

The only redirect URI still registered for `ownerapi` is **`tesla://auth/callback`**, which is what this plugin sends. It is a custom scheme, so nothing serves it and no browser can follow it — irrelevant for the scripted path, which reads the code straight out of the `302`'s `Location` header without following it, and the reason the browser fallback routes you through devtools.

This is also why the failure is easy to misread: both paths break at once, because both start from the same authorize request. If the login ever fails with a message quoting Tesla verbatim about `redirect_uri`, this constant is the thing to check.

### There are no remote commands, and there can't be

No honking, no flashing, no climate control, no navigation destination, no locking or unlocking. Since 2024 every VCSEC-equipped vehicle — Model 3, Model Y, and Model S/X from 2021 on — rejects **unsigned** commands, no matter which API they arrive through. Supporting them would mean running Tesla's [`vehicle-command`](https://github.com/teslamotors/vehicle-command) HTTP proxy and pairing a keypair inside the car, which is a different piece of infrastructure from this plugin. Read paths are unaffected, and `wake_up` is not a VCSEC command, so it still works unsigned.

You don't have to take this on faith: `/api/1/products` reports a `command_signing` field per vehicle, and `familiar tesla vehicles` prints it in the **signed commands** column. `required` means unsigned commands would be rejected.

If someone picks this up later, the proxy is the whole of the work: the command bodies themselves are trivial (`POST /api/1/vehicles/{id}/command/<name>`).

### The token endpoint must be reached over TLS 1.3

Tesla's SSO scopes the token it mints by the TLS version of the connection that asked for it. Refresh over TLS 1.2 and you get a Fleet-scoped token that looks perfectly fine and makes every Owner API call answer `403 forbidden, see https://developer.tesla.com/docs/fleet-api`.

The four `auth.tesla.com` calls therefore go through `src/auth/TlsHttp.ts`, a small `node:https` helper pinned to `minVersion: "TLSv1.3"`, so a downgrade fails loudly at the handshake instead of silently producing a useless token. Everything else uses the global `fetch` like the rest of the repo.

Note that the widely-mirrored timdorr documentation says the opposite ("the service expects TLS 1.2 or lower"). That advice is inverted as of 2026.

### The old `81527cff…` token exchange is gone

Older writeups exchange the SSO token for an Owner API token against `client_id=81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384`. That endpoint has been removed; the SSO access token is used directly as the Owner API bearer.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `403 forbidden, see …/fleet-api` from Owner API calls | Token was minted over TLS < 1.3. Should be impossible here — check `TlsHttp.ts` still pins the version. |
| `could not reach …: … (ETIMEDOUT)` | The network, not Tesla. Already retried four times; try again with a better link. |
| `412 Endpoint is only available on fleetapi` | Tesla withdrew another Owner API route. Check whether a sibling endpoint still serves the data before reaching for the Fleet API. |
| `403` from `tesla_invoices` only | Stale `teslaAppUserAgent`. Bump it to a current Tesla app version. |
| `redirect_uri ... is not registered for this client_id` | Tesla changed the registered redirect URI again. Current value is `tesla://auth/callback` in `src/auth/PkceLogin.ts`. |
| `tesla status` reports `Refresh: FAILED` | Refresh token is dead (password change, session revoked). Re-run `familiar tesla login`. |
| Tools report `NO_TESLA_LOGIN` | The daemon started before the login existed. Restart it. |
| `tesla_invoices` returns nothing for a month | Either no paid supercharging that month, or free supercharging (no invoice is issued). Connectivity invoices only appear on billing periods. |
