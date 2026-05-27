import { definePlugin } from "@getfamiliar/shared";
import { buildCommands } from "./Commands.js";
import { setApiKey } from "./Whisper.js";

/**
 * Re-export the plugin's public library API. Sibling plugins
 * consume it as `import { transcribeAudio } from "@getfamiliar/plugin-transcribe-whisper"`.
 *
 * Cross-plugin imports are wired the same way as the existing
 * `@getfamiliar/shared` package: the consuming plugin adds
 * `"@getfamiliar/plugin-transcribe-whisper": "*"` to its `dependencies`, and npm's
 * workspace resolution does the rest.
 *
 * Note: `setApiKey` is intentionally **not** re-exported. Callers
 * never see Whisper's auth — the plugin owns its own key, populated
 * here in `start(ctx)`.
 */
export { transcribeAudio } from "./Whisper.js";

/**
 * `transcribe-whisper` plugin manifest.
 *
 * "Library plugin": no event subscription, no workspace template;
 * its purpose is to expose {@link transcribeAudio} to other plugins.
 * The CLI subcommand (`./cli.sh transcribe-whisper test <path>`) is
 * a smoke test for the OpenAI API key.
 *
 * The `prepare(ctx)` hook reads the OpenAI key from the host config
 * and installs it into the module-private state in `Whisper.ts`, so
 * sibling plugins call `transcribeAudio(audio, name)` without
 * thinking about authentication. `prepare` runs before any plugin's
 * `start` and before any plugin one-shot CLI command, so the order
 * in `Registry.ts` doesn't matter for siblings that depend on this
 * plugin.
 *
 * A missing `inference.apiKeys.openai` is **not** fatal at boot —
 * the host stays up and `transcribeAudio` throws a clear
 * "not initialized" error at the first call site. This lets users
 * run the daemon for text-only flows (e.g. telegram without voice)
 * without configuring an OpenAI key.
 */
export default definePlugin({
    id: "transcribe-whisper",
    host: {
        prepare: (ctx) => {
            const key = ctx.config.getString("inference.apiKeys.openai", null);
            if (key !== null) {
                setApiKey(key);
            } else {
                ctx.logger.info(
                    "transcribe-whisper inactive: inference.apiKeys.openai not set in config/config.yml",
                );
            }
        },
        commands: (ctx) => buildCommands(ctx),
    },
});
