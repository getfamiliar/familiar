import { readFileSync } from "node:fs";
import path from "node:path";
import { type CommandDef, defineCommand } from "citty";
import type { HostContext } from "effective-assistant-shared";
import { transcribeAudio } from "./Whisper.js";

/**
 * Build the citty subcommands exposed under
 * `./cli.sh transcribe-whisper`. Currently a single smoke-test
 * command; future operational commands (e.g. `cost`, `models`) land
 * here.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildCommands(_ctx: HostContext): readonly CommandDef<any>[] {
    return [testCommand()];
}

/**
 * `./cli.sh transcribe-whisper test <path>` — read a local audio
 * file, send it through {@link transcribeAudio}, and print the
 * transcript. The operator's smoke test for
 * "is `inference.apiKeys.openai` set up correctly?" without needing
 * a live channel plugin.
 *
 * No explicit init call here — the host wraps every plugin command's
 * `run` so `prepare(ctx)` has already fired by the time we land in
 * the body, populating the module-level API key.
 */
function testCommand() {
    return defineCommand({
        meta: {
            name: "test",
            description:
                "Transcribe a local audio file with Whisper and print the result. Useful for verifying inference.apiKeys.openai.",
        },
        args: {
            path: {
                type: "positional",
                required: true,
                description: "Path to a local audio file (.ogg, .m4a, .mp3, .wav, .webm, .flac).",
            },
        },
        async run({ args }) {
            const absolute = path.resolve(args.path);
            let audio: Buffer;
            try {
                audio = readFileSync(absolute);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`failed to read ${absolute}: ${msg}\n`);
                process.exit(1);
            }

            try {
                const transcript = await transcribeAudio(audio, path.basename(absolute));
                process.stdout.write(`${transcript}\n`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`transcription failed: ${msg}\n`);
                process.exit(1);
            }
        },
    });
}
