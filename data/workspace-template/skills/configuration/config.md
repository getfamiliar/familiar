# config.yml recipes

`config_get` without a key shows the whole file (secrets masked). Its `pendingReload` lists keys edited but not applied yet; `restartOnly` lists keys that only take effect after a daemon restart.

## Layout

| Group | What lives there |
| --- | --- |
| `core` | `defaultChatChannel`, `timezone`, `defaultCalendar`, `agentStepTimeout` (seconds per step), `toolCallOffloadingLimit`, `maxToolDescriptionChars`, `toolDefinitionsContextFraction`, `toolHeuristicRunWindow`, `logSystemPrompt`, `writablePaths` (restart-only), `postgresPassword` / `bastionToken` (secrets, restart-only). |
| `inference` | `defaultProvider`, `defaultModel`, `aliases` (name → `provider/model`, used as `model: <alias>` in handlers), `maxRetries`, `outputFallbackPercentage`, `contextManagement.thresholdPercentage`, `apiKeys.<provider>` (secrets), debug captures. |
| `mail` | `allowSend`, `recipientWhitelist`, `emitEventsInDev`. |
| `calendar` | `allowAttendees`, `emitEventsInDev`. |
| `chat` | `compaction.thresholdBytes`, `compaction.keepUncompactedBytes` (keep must stay below threshold). |
| `storage` | Cloud-storage mounts and policy. |
| `webserver` | Web UI: `enabled`, `port`, `host`, `lanUrls` (confirmed LAN addresses), `auth.users` (allowed logins), `auth.sessionDays`, `auth.trustedProxies`. Access and login links: `skills/configuration/web-interface.md`. |
| `<plugin-id>` | One group per plugin: `telegram`, `whatsapp`, `ms365`, `memory`, `tesla`, … |

## Typical changes

- **Switch the default model or add an alias:** `config_set inference.defaultModel` / `config_set inference.aliases.fast "<provider>/<model>"`. The provider must have an API key under `inference.apiKeys` — if it doesn't, the reload fails and the user has to add the key.
- **Allow sending mail:** `config_set mail.allowSend true` (optionally `mail.recipientWhitelist` as a list). Ask before loosening safety settings.
- **Enable a plugin:** most plugins switch on when their group has the required keys. Example Telegram: the user enters `telegram.botToken` themselves; you may set `telegram.authorizedUserId` (a number). After `config_reload` the report shows the plugin as restarted — or as failed, with the reason.
- **Turn a plugin feature off:** e.g. `config_set ms365.mail.polling false`.
- **Remove a setting so the default applies:** `config_unset <key>`.

## Rules

- `config_set` takes JSON values: `true`, `42`, `"text"`, `["a", "b"]`, `{ "k": "v" }`. It keeps comments and refuses edits that make the file invalid.
- A change to a restart-only key is written but stays inactive until the user restarts the daemon — say so explicitly.
- A plugin listed under "daemon restart required" cannot reload in place; tell the user.
