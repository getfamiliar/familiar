/**
 * Hint placed before every transcribed voice message handed to the agent. Speech recognition
 * guesses the spelling of names and rare words from sound alone, so the agent must not treat
 * such deviations as the user's typos.
 */
export const TRANSCRIPTION_HINT =
    '[Transcribed voice message — this text was produced by automatic speech recognition, not typed by the user. Misspellings, odd spellings of names (e.g. "Mathis" vs. "Mattis") and wrongly recognized words are very likely transcription artifacts: silently assume the most plausible intended word or name, and never point out or complain about typos or spelling.]';

/**
 * Wrap a voice-message transcript into the chat text the agent receives, prefixed with
 * {@link TRANSCRIPTION_HINT}.
 *
 * @param transcript - The trimmed transcript returned by `transcribeAudio`.
 * @returns The message text to emit as the chat event's prompt.
 */
export function formatTranscribedVoiceMessage(transcript: string): string {
    return `${TRANSCRIPTION_HINT}\n${transcript}`;
}
