import { definePlugin } from "effective-assistant-shared";
import { buildCommands } from "./Commands.js";

/**
 * Re-export the plugin's public library API. Sibling plugins
 * consume it as `import { transcribeAudio } from "transcribe-whisper"`.
 *
 * Cross-plugin imports are wired the same way as the existing
 * `effective-assistant-shared` package: the consuming plugin adds
 * `"transcribe-whisper": "*"` to its `dependencies`, and npm's
 * workspace resolution does the rest.
 */
export { transcribeAudio } from "./Whisper.js";

/**
 * `transcribe-whisper` plugin manifest.
 *
 * No daemon, no event subscription, no workspace template — this is
 * a "library plugin" that exists primarily to expose
 * {@link transcribeAudio} to other plugins. The CLI subcommand
 * (`./cli.sh transcribe-whisper test <path>`) is a smoke test for
 * the OpenAI API key.
 *
 * Failures (missing `OPENAI_API_KEY`, Whisper API errors) surface at
 * the first call site, not at host boot — keeps the host's startup
 * path independent of an optional capability.
 */
export default definePlugin({
    id: "transcribe-whisper",
    host: {
        commands: (ctx) => buildCommands(ctx),
    },
});
