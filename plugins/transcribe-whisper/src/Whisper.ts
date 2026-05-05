import OpenAI, { toFile } from "openai";

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
 * @throws If `OPENAI_API_KEY` is unset or the API call fails.
 */
export async function transcribeAudio(audio: Buffer, filename: string): Promise<string> {
    const client = new OpenAI({ apiKey: readApiKey() });
    const file = await toFile(audio, filename);
    const result = await client.audio.transcriptions.create({
        file,
        model: "whisper-1",
    });
    return result.text;
}

/**
 * Read `OPENAI_API_KEY` from the environment, throwing a clear
 * actionable error if it's missing. Read on every call rather than
 * cached at module load: the daemon is long-running, and `.env`
 * edits should take effect on the next transcription without a
 * restart.
 */
function readApiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
        throw new Error("OPENAI_API_KEY is not set. Add it to .env at the repo root.");
    }
    return key;
}
