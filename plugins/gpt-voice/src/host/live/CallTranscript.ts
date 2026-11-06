/** Who said a turn. */
export type Speaker = "user" | "assistant";

/** One finished utterance of a call. */
export interface TranscriptTurn {
    readonly speaker: Speaker;
    readonly text: string;
    /** Session-audio offset of the first word (ms). */
    readonly startMs: number;
}

/** A transcript fragment as the Live codec parses it. */
export interface TranscriptFragment {
    readonly speaker: Speaker;
    readonly delta: string;
    readonly startMs: number;
    readonly endMs: number;
}

/** Silence after which a speaker's utterance counts as finished. */
export const TURN_PAUSE_MS = 1500;

/** An utterance still being spoken. */
interface OpenTurn {
    text: string;
    readonly startMs: number;
    endMs: number;
}

/**
 * Assembles the Live session's transcript fragments (a few words each,
 * both speakers interleaved — the model is full-duplex) into turns.
 *
 * Each speaker has an open utterance; it is finished when any fragment
 * arrives more than {@link TURN_PAUSE_MS} of session audio after that
 * speaker's last word, or on {@link flush}. Timing comes from the
 * fragments' audio offsets, not the wall clock, so the result is
 * deterministic.
 */
export class CallTranscript {
    private readonly turns: TranscriptTurn[] = [];
    private readonly open = new Map<Speaker, OpenTurn>();
    private readonly onTurn: (turn: TranscriptTurn) => void;

    /**
     * @param onTurn Called for every finished turn, in the order they finish.
     */
    constructor(onTurn: (turn: TranscriptTurn) => void) {
        this.onTurn = onTurn;
    }

    /**
     * Add a fragment.
     *
     * @param fragment Speaker, text delta and audio offsets.
     */
    add(fragment: TranscriptFragment): void {
        for (const speaker of [...this.open.keys()]) {
            const turn = this.open.get(speaker);
            if (turn !== undefined && fragment.startMs - turn.endMs > TURN_PAUSE_MS) {
                this.finish(speaker);
            }
        }
        const current = this.open.get(fragment.speaker);
        if (current === undefined) {
            this.open.set(fragment.speaker, {
                text: fragment.delta,
                startMs: fragment.startMs,
                endMs: fragment.endMs,
            });
            return;
        }
        current.text += fragment.delta;
        current.endMs = Math.max(current.endMs, fragment.endMs);
    }

    /** Finish every open utterance (end of call). */
    flush(): void {
        const speakers = [...this.open.entries()]
            .sort(([, a], [, b]) => a.startMs - b.startMs)
            .map(([speaker]) => speaker);
        for (const speaker of speakers) {
            this.finish(speaker);
        }
    }

    /**
     * The latest turns including the utterances still being spoken, in
     * the order they started.
     *
     * @param maxTurns How many turns at most.
     * @returns Oldest first.
     */
    recent(maxTurns: number): readonly TranscriptTurn[] {
        const openTurns: TranscriptTurn[] = [...this.open.entries()].map(([speaker, turn]) => ({
            speaker,
            text: turn.text.trim(),
            startMs: turn.startMs,
        }));
        return [...this.turns, ...openTurns]
            .filter((turn) => turn.text !== "")
            .sort((a, b) => a.startMs - b.startMs)
            .slice(-maxTurns);
    }

    /**
     * Close a speaker's open utterance and report it.
     *
     * @param speaker The speaker.
     */
    private finish(speaker: Speaker): void {
        const turn = this.open.get(speaker);
        this.open.delete(speaker);
        const text = turn?.text.trim() ?? "";
        if (turn === undefined || text === "") {
            return;
        }
        const finished: TranscriptTurn = { speaker, text, startMs: turn.startMs };
        this.turns.push(finished);
        this.onTurn(finished);
    }
}

/**
 * Render turns as plain text for a background prompt, one line per turn.
 *
 * @param turns Turns, oldest first.
 * @returns `User: …` / `Assistant: …` lines.
 */
export function formatTranscript(turns: readonly TranscriptTurn[]): string {
    return turns
        .map((turn) => `${turn.speaker === "user" ? "User" : "Assistant"}: ${turn.text}`)
        .join("\n");
}
