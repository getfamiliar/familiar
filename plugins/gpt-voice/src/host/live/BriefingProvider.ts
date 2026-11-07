import { formatRuntimeTime, type HostContext, type Logger } from "@getfamiliar/shared";
import { VOICE_BRIEFING_TOPIC, VOICE_CHAT_CHANNEL } from "../VoiceProtocol.js";

/** A briefing younger than this is reused for the next call. */
export const BRIEFING_CACHE_MS = 30 * 60 * 1000;

/**
 * Queue priority of `voice:briefing`: below direct chat (100), so a
 * delegation of the running call (`voice:background`, priority 100)
 * overtakes a briefing that has not started yet.
 */
export const BRIEFING_PRIORITY = 90;

/** Dependencies of a {@link BriefingProvider}. */
export interface BriefingProviderDeps {
    readonly events: Pick<HostContext["events"], "emit">;
    readonly log: Logger;
    /** IANA timezone for the prompt's timestamp, read per briefing. */
    readonly timezone: () => string;
    /** Clock (tests). */
    readonly now?: () => Date;
}

/** A cached briefing. */
interface CachedBriefing {
    readonly text: string;
    readonly builtAt: number;
}

/**
 * Builds the call briefing on demand: a `voice:briefing` run of the
 * normal assistant (policy in `workspace/voice/briefing.md`) whose result
 * the call feeds to the voice model as silent context.
 *
 * Built only when someone calls — never on a schedule — and shared across
 * calls: a briefing younger than {@link BRIEFING_CACHE_MS} is reused, and
 * calls that start while one is being built wait for the same run.
 */
export class BriefingProvider {
    private readonly deps: BriefingProviderDeps;
    private cached: CachedBriefing | null = null;
    private pending: Promise<string> | null = null;

    /**
     * @param deps Event bus, logger, timezone and clock.
     */
    constructor(deps: BriefingProviderDeps) {
        this.deps = deps;
    }

    /**
     * The current briefing: cached, in progress, or a newly started run.
     *
     * @param callId Call that asks (for the log line).
     * @returns The briefing text.
     * @throws {Error} When the run could not be started, failed, or
     *   returned nothing. Failures are not cached; the next call tries again.
     */
    get(callId: string): Promise<string> {
        const nowMs = this.now().getTime();
        if (this.cached !== null && nowMs - this.cached.builtAt < BRIEFING_CACHE_MS) {
            this.deps.log.info(
                `gpt-voice: call ${callId} reuses the briefing from ${Math.round((nowMs - this.cached.builtAt) / 60000)} min ago`,
            );
            return Promise.resolve(this.cached.text);
        }
        if (this.pending === null) {
            const run = this.build(callId);
            this.pending = run;
            const clear = (): void => {
                if (this.pending === run) {
                    this.pending = null;
                }
            };
            run.then(clear, clear);
        }
        return this.pending;
    }

    /** Forget the cached briefing (tests, or when it is known to be stale). */
    invalidate(): void {
        this.cached = null;
    }

    /**
     * Emit a `voice:briefing` event and wait for its result.
     *
     * @param callId Call that triggered it.
     * @returns The briefing text.
     * @throws {Error} When the event fails or its result is empty.
     */
    private async build(callId: string): Promise<string> {
        const startedAt = this.now();
        const handle = await this.deps.events.emit({
            topic: VOICE_BRIEFING_TOPIC,
            isExactTopic: true,
            prompt: `A voice call started at ${formatRuntimeTime(startedAt, this.deps.timezone())}. Build the briefing for the voice assistant.`,
            payload: { callId },
            priority: BRIEFING_PRIORITY,
            preferredChatChannelId: VOICE_CHAT_CHANNEL,
            privileged: true,
            idempotencyKey: `gpt-voice:briefing:${startedAt.toISOString()}`,
        });
        this.deps.log.info(
            `gpt-voice: call ${callId} started briefing event ${handle.id} (${VOICE_BRIEFING_TOPIC})`,
        );
        const text = (await handle.settled).trim();
        if (text === "") {
            throw new Error(`briefing event ${handle.id} returned no text`);
        }
        this.cached = { text, builtAt: this.now().getTime() };
        return text;
    }

    /**
     * Current time.
     *
     * @returns Now, from the injected clock if any.
     */
    private now(): Date {
        return this.deps.now?.() ?? new Date();
    }
}
