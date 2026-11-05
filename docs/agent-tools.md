# Agent Tools

This is the guide for implementing tools that Familiar's agent calls: what kind of tool to build, where to register it, and the conventions every tool follows (naming, groups, security level, schema, description, result, errors, tests). It is written for anyone adding a tool, human or coding agent. Plugin packaging is covered in [plugins/create-plugins.md](plugins/create-plugins.md); MCP servers, which bring their own tools, are in [mcp.md](mcp.md).

## The four kinds of tools

| Kind | Runs in | Defined in | Registered via | Key the agent sees |
| --- | --- | --- | --- | --- |
| **Container built-in** | agent container, per agentrun | `container/src/tools/*.ts` (AI SDK `tool()`) | `ToolsFactory` + `CONTAINER_TOOL_GROUPS` / `CONTAINER_TOOL_LEVELS` | bare name: `send_chat`, `fs_read`, `start_subagent` |
| **Host core tool** | host daemon, behind the bastion's `/plugin-tools/` gateway | `host/src/<area>/<Area>Tools.ts` (`PluginTool`) | `PluginHost.startDaemons` core list, or `Start.ts` `daemonCoreTools` | bare name: `cal_get_events`, `config_set`, `web_login_link` |
| **Plugin tool** | host daemon, inside the plugin's code | `plugins/<id>/src/…` (`PluginTool`) | the plugin's `tools(ctx)` hook | `<plugin-id>_<name>`: `memory_save`, `tesla_location` |
| **MCP tool** | an MCP container | external server | `config/mcp.yml` | `<mcp-id>_<name>` |

Which one to build:

- **Needs credentials, host files, the bus, host services or the network → host side.** The container has no credentials and no network except through the gateway. Almost every new capability is a host core tool or a plugin tool.
- **Belongs to a plugin's domain (a provider, a device, an account) → plugin tool.** It ships, starts and restarts with the plugin.
- **Platform capability without a plugin (config, mail/calendar/storage front-ends, reflection, web UI) → host core tool.**
- **Needs the agentrun's own state (its chat, its scratch, its subagent tree, the workspace mount) → container built-in.** These are rare; prefer the host side when either would work.
- **An existing MCP server already does it → configure the MCP**, don't wrap it.

## Anatomy of a host-side tool

Host core tools and plugin tools share one interface, `PluginTool` (`shared/src/Plugin.ts`):

```ts
import { type PluginTool, renderInZone, runJsonTool, ToolError } from "@getfamiliar/shared";

interface WebLoginLinkArgs {
    readonly user?: string;
    readonly baseUrl?: string;
}

function buildWebLoginLinkTool(deps: WebToolsDeps): PluginTool<WebLoginLinkArgs, object> {
    return {
        name: "web_login_link",
        level: "privileged",
        groups: ["web"],
        description: "Create a one-time link that signs the user in to the familiar web UI … ",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                user: { type: "string", description: "Login to sign in as; must be listed in webserver.auth.users." },
                baseUrl: { type: "string", description: "Extra base URL, e.g. http://192.168.1.20:8080." },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                if (deps.config.getBool("webserver.enabled", false) !== true) {
                    throw new ToolError("WebServerDisabled", "The web UI is off (webserver.enabled is not true) …");
                }
                const link = await createLoginLink({ … });
                return { login: link.login, expiresAt: renderInZone(…), loginLinks: link.loginLinks };
            }, callCtx.toolRunContext),
    };
}
```

(Abridged from `host/src/web/WebTools.ts`.) Group related tools in one `build<Area>Tools(deps): readonly PluginTool[]` factory per file. It takes its dependencies explicitly, which keeps the tools testable without a daemon.

### Registration

- **Plugin tools:** return them from the manifest's `tools(ctx)` hook. It runs after `start` and again after every plugin restart. It must be synchronous and side-effect free; it only builds the list.
- **Host core tools:** add the factory to the core list in `PluginHost.startDaemons` (`host/src/plugins/PluginHost.ts`) when its dependencies live in the plugin host (registries, services, the postgres connection). If they only exist in the daemon's `Start.ts` (the reloader, the `HostConfigService`, the webserver's session store), pass them in through `pluginHost.startDaemons([...buildConfigTools(…), ...buildWebTools(…)])`. Both end up registered under the reserved id `core`, which gives them bare keys.
- **Container built-ins:** build them in `ToolsFactory` and add their groups to `CONTAINER_TOOL_GROUPS` and any non-default level to `CONTAINER_TOOL_LEVELS`.

The `PluginToolsRegistry` (`host/src/plugins/ToolsRegistry.ts`) checks these rules and rejects registrations that break them at startup:

- A plugin with tools needs an id matching `IDENT_PATTERN` (`^[a-z][a-z0-9]*$`, no hyphens). The id must not be a reserved group name and must not collide with an MCP id.
- Keys are unique across the whole registry.
- Every declared group is valid (see below), and a plugin tool does not list its own plugin id.

**Register tools unconditionally.** A tool whose feature is switched off stays visible and fails at call time with an error that names the switch (`WebServerDisabled`, "webserver.enabled is not true"). Hidden tools leave the agent unable to explain why something doesn't work.

## Naming

- `name` is lowercase `snake_case`, verb or noun-verb, short: `send_reply`, `get_events`, `login_link`.
- **Plugin tools** get the plugin id prefixed by the registry (`tesla` + `location` → `tesla_location`). Don't repeat the id in `name`.
- **Host core tools** have no automatic prefix. Give them an area prefix yourself, so related tools sort together and `*`-globs work: `cal_*`, `mail_*`, `storage_*`, `config_*`, `mcp_*`, `web_*`.
- When the tool mirrors a CLI command, say so in the description ("the agent's `familiar web login`") and give it the full CLI input surface. For example, if the CLI accepts a bulk id spec, so does the tool. Don't narrow it to a single item.

## Groups: how a tool reaches the model

Every tool is always reachable: the agent can find any tool with `tool_list` / `tool_describe` and run it with `tool_call`. Groups decide which tools are **preloaded** into a run, which saves that discovery round-trip:

- A handler's `tools:` frontmatter lists names, `*`-globs and group names (`tools: core, mail_*`). Without `tools:`, the run gets the `core` group. A preloaded skill's `tools:` adds to that. See [prompting.md](prompting.md).
- On top of that, the scheduler preloads the tools a handler successfully used in recent runs (`tool_calls` table, bounded by `core.toolDefinitionsContextFraction`).
- The plugin id is an automatic group for its tools (`tools: tesla`).
- `groups` adds curated groups. Group names match `IDENT_PATTERN`, and `all`, `mcp`, `none` are reserved. Coin new names freely (`web`, `reflection`, `cal`).
- **`core` is special:** it is loaded into every handler that declares no `tools`. Only use it for genuinely ambient capabilities whose description reads sensibly in any context (memory, chat reply, file read). Everything else goes into its own group.

## Security level

`level` (`shared/src/ToolLevel.ts`) decides who may run the tool. The container's tool wrapper (`ToolsFactory`) enforces it for every call, including `tool_call`, and throws `PrivilegeDenied` with a self-contained message.

| Level | Use for | Effect today |
| --- | --- | --- |
| `default` | Reads and low-risk actions | Always runs. |
| `approval` | External mutations with consequences: sending mail, sharing files, writes to third-party systems | Refused in non-privileged runs until the approval gate exists. |
| `privileged` | Changing Familiar itself (config, MCPs), handing out access (`web_login_link`), anything a prompt-injected mail must never trigger | Only in privileged runs, i.e. runs that descend from trusted user input (cli-chat, an allowlisted chat sender). |

Ask yourself: "Could a hostile incoming mail or web page talk the agent into calling this?" If the answer is yes and the consequence matters, the tool is not `default`. The tool stays visible in `tool_list` regardless (the listing shows the level), so the agent can explain the refusal.

Secrets never pass through tools. Tools that read configuration mask secret values (`isSecretConfigKey` / `maskSecrets`, `host/src/config/SecretKeys.ts`). Tools that write configuration refuse secrets and point the user to `familiar config set`. Never return API keys, tokens or passwords, and don't log them. A tool that *mints* a credential for the user (a login link) must say in its description where the result may go ("send it only to the user who asked, never store it").

## Input schema

`inputSchema` is raw JSON Schema (an object schema). The container wraps it with the AI SDK's `jsonSchema()`.

- Use `type: "object"` and `additionalProperties: false`, list `required`, and give **every** property a `description` with an example value.
- Use standard formats instead of mini-languages: ISO-8601 dates and wall-clock times in the user's timezone (`from_day` / `to_day`), plain arrays instead of comma strings, enums for closed sets.
- Validate again in `execute`. Models send wrong types, empty strings and extra whitespace. Trim, check, and throw a `ToolError("InvalidArgument", …)` that says what is wrong and what is expected.
- Hide plumbing the host already knows. Event id, agentrun, mailbox of the current event and similar values come from `callCtx`, not from arguments.

## Description

The description is the only documentation the model sees when it decides to call the tool. Write it for the model:

1. **What it does**, in the first sentence. `core.maxToolDescriptionChars` may cut the rest, and `tool_list` shows a shortened version.
2. **When to use it**, and when not to (if there is a sibling tool that fits better).
3. **What the result means**, field by field when it is structured.
4. **Side effects and follow-ups**: "Does NOT apply the change: call `config_reload` after your edits."
5. **Pointers to longer instructions** when the tool needs judgment: "Before answering, read `skills/configuration/web-interface.md`." Put the long how-to into a workspace skill (`data/workspace-template/skills/<name>/…`), not into the description.

Name concrete keys and values, not vague hints. "The provider must have an API key under `inference.apiKeys`" is better than "make sure it's configured".

## Result

Whatever `execute` resolves with goes back to the model **unwrapped**; there is no `{ ok, result }` envelope. Package it with a runner from `shared/src/ToolRunner.ts` and pass `callCtx.toolRunContext`:

| Runner | For | Oversized result |
| --- | --- | --- |
| `runJsonTool` | One JSON object | Spilled whole to `/scratch/<event>/`, the model gets `{ truncated, fullResultAt, reason }` |
| `runJsonLinesTool` | Lists of records | Leading lines that fit, then a `{"truncated":true,"fullResultAt":…}` marker |
| `runTextTool` | Prose, logs | Prefix plus `[truncated; full result at <path>]` |

The token budget comes from `core.toolCallOffloadingLimit` / handler frontmatter. The model reads spilled files with `fs_read`.

Shape the result for the agent:

- **Use the user's form:** timestamps in `core.timezone` (`renderInZone(utcIso, config.getString("core.timezone", "UTC"))`), plain ids, human-readable states. Hide internal storage details (UTC columns, hashes, row ids the agent can't use).
- **Keep structured data structured.** Return JSON/JSONL as is, or raw log lines verbatim; don't wrap them in markdown. Markdown is for prose results.
- **Return what the next step needs:** the id of the created item, the path of a staged file, the list of affected keys. Don't make the model call a second tool to find out what the first one did.
- When a tool produces files, stage them in the event's scratch dir (`callCtx.host.scratch.addFiles(callCtx.event.id, files)`) and return the agent-visible paths.

## Errors

- Throw, don't return error objects. Use `ToolError(code, message)` for failures the agent should understand: a stable `code` (`InvalidArgument`, `NotFound`, `WebServerDisabled`, `PrivilegeDenied`) and a message that stands alone.
- The message says **what** failed, **why**, and **what to do**, and names every identifier involved: "`"eve@example.com"` is not listed in webserver.auth.users (you@example.com) — ask the user before adding a login".
- Catch library errors you can explain and re-throw them as `ToolError`. Let unexpected errors propagate; they reach the model with the code `ToolError`. Never swallow them.
- Don't half-do things. Validate everything before the first side effect. In the example above, the token is only minted after the login and base URL checked out.

## The call context

`execute(args, callCtx)` receives a `PluginToolCallContext`:

- `callCtx.event` / `callCtx.agentrun`: the full rows. Read the entity the run is about from `event.payload` (e.g. the mail id).
- `callCtx.host`: the plugin's `HostContext` (`ctx.config`, `ctx.events.emit`, `ctx.scratch`, `ctx.mcp`, …). For core tools it is the `core` context.
- `callCtx.log`: a logger scoped to plugin, tool, event and agentrun. Log consequential actions with every identifier in the message text.
- `callCtx.toolRunContext`: limit and spill function for the runners.

**Read configuration per call**, never into module-level constants. `familiar config reload` changes values while the daemon runs, and plugin tools are rebuilt only when their plugin restarts.

## Tests

Test the factory directly; no daemon, bastion or container is needed. `host/src/web/WebTools.test.ts` and `host/src/config/ConfigTools.test.ts` are templates:

```ts
const callCtx = {
    toolRunContext: { limit: 100_000, spill: async () => "/scratch/x" },
} as unknown as PluginToolCallContext;

const [tool] = buildWebTools({ config: new HostConfigService(configFile), sessions, proxies });
const result = await tool.execute({}, callCtx);
```

Cover at least:

- the declared `level` (a test that asserts `privileged` catches an accidental downgrade);
- the happy path, asserting on the result shape the description promises;
- each documented error, matched on its message or `code`, and that no side effect happened before it;
- the "feature off" path for config-gated tools.

Use real config files in a temp dir (`HostConfigService`) and in-memory fakes for stores (`MemoryWebSessionStore`, `shared/src/testing`). Tools against external APIs reuse their on-disk cache in tests and skip when credentials are absent.

## Making it known

- **Verify the surface:** `familiar tools list` (with the daemon running) shows key, level badge, groups and description exactly as the agent sees them.
- **Teach the judgment:** if the tool needs more than its description (how to word an answer, when to ask the user first), add or extend a workspace skill under `data/workspace-template/skills/` and reference it from the description. The daemon copies only *missing* files into existing workspaces, so existing workspaces need edited skill files synced by hand.
- **Document it:** user-facing settings in `docs/config.md`, architecture notes in `CLAUDE.md`, plugin tools in the plugin's README.

## Checklist

- [ ] Right kind (host core / plugin / container / existing MCP) and right file
- [ ] `name` snake_case; core tools carry an area prefix
- [ ] Registered unconditionally; feature-off fails at call time naming the switch
- [ ] `groups` set (`core` only if truly ambient)
- [ ] `level` chosen with the prompt-injection question in mind
- [ ] Schema: `additionalProperties: false`, `required`, every property described, standard formats
- [ ] Description: purpose first, when to use, result fields, side effects, skill pointer
- [ ] Result via `runJsonTool` / `runJsonLinesTool` / `runTextTool`, in the user's timezone and form
- [ ] Errors as `ToolError` with self-contained, actionable messages; validation before side effects
- [ ] No secrets in arguments, results or logs; config read per call
- [ ] Tests for level, happy path, errors, feature-off
- [ ] `familiar tools list` checked; skill and docs updated
