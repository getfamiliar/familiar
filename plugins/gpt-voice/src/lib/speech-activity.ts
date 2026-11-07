/**
 * Tells when the assistant is audibly speaking. GPT-Live is full duplex
 * and streams audio for the whole call, silence included, so the SDK's
 * `isPlaying` is true throughout. Instead, each received chunk is placed
 * on a model of the playback timeline (the SDK plays chunks back to back,
 * starting no earlier than now) and counts as speech when it is loud
 * enough.
 */

/** Sample rate of the call's output audio (`audio/pcm`, 24 kHz). */
const OUTPUT_SAMPLE_RATE = 24_000;

/** RMS (of samples in -1…1) above which a chunk counts as speech. */
const SPEECH_RMS_THRESHOLD = 0.01;

/** Speech continues across pauses shorter than this (between words). */
const HANGOVER_MS = 300;

/** How often the state is re-evaluated while speech is scheduled. */
const TICK_MS = 50;

/** A stretch of loud audio on the playback timeline. */
interface LoudSpan {
    readonly startMs: number;
    readonly endMs: number;
}

/** Clock and timers, replaceable in tests. */
export interface SpeechActivityClock {
    now(): number;
    setTimeout(action: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

/** The browser's clock. */
const BROWSER_CLOCK: SpeechActivityClock = {
    now: () => performance.now(),
    setTimeout: (action, delayMs) => window.setTimeout(action, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/**
 * Root mean square of base64-encoded little-endian PCM16 audio.
 *
 * @param base64Audio The chunk.
 * @returns RMS in 0…1, and the number of samples.
 */
export function measurePcm16(base64Audio: string): { rms: number; sampleCount: number } {
    const binary = atob(base64Audio);
    const sampleCount = Math.floor(binary.length / 2);
    let sumOfSquares = 0;
    for (let index = 0; index < sampleCount; index++) {
        const low = binary.charCodeAt(index * 2);
        const high = binary.charCodeAt(index * 2 + 1);
        const value = (((high << 8) | low) << 16) >> 16;
        const normalized = value / 32768;
        sumOfSquares += normalized * normalized;
    }
    return { rms: sampleCount === 0 ? 0 : Math.sqrt(sumOfSquares / sampleCount), sampleCount };
}

/** Derives "the assistant is speaking" from the output audio chunks. */
export class SpeechActivityDetector {
    private readonly onChange: (isSpeaking: boolean) => void;
    private readonly clock: SpeechActivityClock;
    private playbackEndMs = 0;
    private loudSpans: LoudSpan[] = [];
    private timer: unknown = null;
    private isSpeaking = false;

    /**
     * @param onChange Called when speaking starts or stops.
     * @param clock Clock and timers (default: the browser's).
     */
    constructor(
        onChange: (isSpeaking: boolean) => void,
        clock: SpeechActivityClock = BROWSER_CLOCK,
    ) {
        this.onChange = onChange;
        this.clock = clock;
    }

    /**
     * Account for one received output chunk.
     *
     * @param base64Audio PCM16 audio of the chunk.
     */
    addChunk(base64Audio: string): void {
        const { rms, sampleCount } = measurePcm16(base64Audio);
        const durationMs = (sampleCount / OUTPUT_SAMPLE_RATE) * 1000;
        const startMs = Math.max(this.playbackEndMs, this.clock.now());
        this.playbackEndMs = startMs + durationMs;
        if (rms >= SPEECH_RMS_THRESHOLD) {
            this.loudSpans.push({ startMs, endMs: this.playbackEndMs });
            this.evaluate();
        }
    }

    /** Forget scheduled audio (playback stopped, call ended). */
    reset(): void {
        this.playbackEndMs = 0;
        this.loudSpans = [];
        this.evaluate();
    }

    /** Release the timer. */
    dispose(): void {
        if (this.timer !== null) {
            this.clock.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Update the state from the spans and keep ticking while any are pending. */
    private evaluate(): void {
        const now = this.clock.now();
        this.loudSpans = this.loudSpans.filter((span) => span.endMs + HANGOVER_MS > now);
        const isSpeaking = this.loudSpans.some((span) => span.startMs <= now);
        if (isSpeaking !== this.isSpeaking) {
            this.isSpeaking = isSpeaking;
            this.onChange(isSpeaking);
        }
        if (this.loudSpans.length > 0 && this.timer === null) {
            this.timer = this.clock.setTimeout(() => {
                this.timer = null;
                this.evaluate();
            }, TICK_MS);
        }
    }
}
