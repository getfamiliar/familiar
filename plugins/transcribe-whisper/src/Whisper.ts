import OpenAI, { toFile } from "openai";

/**
 * Module-private OpenAI key. Populated once when the plugin is
 * initialized (see {@link setApiKey} and the `start(ctx)` hook in
 * `index.ts`); read on every {@link transcribeAudio} call.
 *
 * Module-level rather than parameter-passed so callers in other
 * plugins don't have to know about — or read — Whisper's
 * authentication: `transcribeAudio(audio, name)` is the entire
 * surface they see.
 */
let apiKey: string | undefined;

/**
 * Install the OpenAI API key. Called once by the plugin manifest's
 * `start(ctx)` hook with `ctx.config.getString("inference.apiKeys.openai")`,
 * and from the plugin's own CLI commands before they run (because
 * one-shot CLI invocations don't go through `startDaemons`).
 *
 * Idempotent — safe to call multiple times. Empty strings are
 * rejected so a misconfigured field surfaces here instead of as an
 * opaque OpenAI auth failure on the next transcription.
 */
export function setApiKey(key: string): void {
    if (!key) {
        throw new Error("setApiKey requires a non-empty key.");
    }
    apiKey = key;
}

/**
 * Transcribe a buffered audio file using OpenAI's Whisper API
 * (model `whisper-1`).
 *
 * `filename` is used only so OpenAI can infer the audio format from
 * the extension (e.g. `.ogg`, `.m4a`, `.mp3`, `.wav`, `.webm`,
 * `.flac`); the `audio` Buffer holds the actual bytes. Whisper
 * auto-detects the spoken language, so no language hint is needed.
 *
 * Errors propagate to the caller as plain `Error`s — the SDK throws
 * `OpenAI.APIError` for HTTP failures, which carries enough context
 * (`status`, `message`) for the caller to handle. Whisper's per-
 * request limit is 25 MB; we don't pre-validate, so an oversize file
 * surfaces as a clear API error.
 *
 * @param audio The raw audio bytes.
 * @param filename The original filename (only the extension matters).
 * @returns The transcribed text.
 * @throws If the plugin has not been initialized via {@link setApiKey}
 *   or the API call fails.
 */
export async function transcribeAudio(audio: Buffer, filename: string): Promise<string> {
    if (!apiKey) {
        throw new Error(
            "transcribe-whisper is not initialized: call setApiKey, or run inside the host daemon so the plugin's start(ctx) hook fires.",
        );
    }
    const client = new OpenAI({ apiKey });
    const file = await toFile(audio, filename);
    const result = await client.audio.transcriptions.create({
        file,
        model: "whisper-1",
    });
    return result.text;
}
