import type {
    LanguageModelV4,
    LanguageModelV4Middleware,
    LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { Logger } from "@getfamiliar/shared";
import { wrapLanguageModel } from "ai";
import { PassedConfig } from "../utils/PassedConfig.js";

/** Releases a slot taken by {@link InferenceConcurrencyLimiter.acquire}. Idempotent. */
export type ReleaseSlot = () => void;

/** One request parked in a limiter queue. */
interface QueuedRequest {
    readonly priority: number;
    /** Monotonic enqueue counter — FIFO tie-breaker within one priority. */
    readonly sequence: number;
    readonly grant: () => void;
}

/** Per-key bookkeeping: running requests and the priority-ordered queue. */
interface LimiterLane {
    running: number;
    readonly queue: QueuedRequest[];
}

/** Hooks an {@link InferenceConcurrencyLimiter.acquire} caller receives while it waits. */
export interface AcquireHooks {
    /** Fires once, synchronously, when the request has to queue (no slot was free). */
    readonly onWaitStart?: (position: number) => void;
    /** Fires once when a queued request got its slot (not called on abort). */
    readonly onWaitEnd?: (waitedMs: number) => void;
}

/**
 * In-process counting semaphore per limit key (`<provider>` or
 * `<provider>/<modelId>`), with a priority-ordered wait queue.
 *
 * The agent container is a single process, so concurrent model requests
 * of every agentrun pass through one instance ({@link inferenceLimiter}).
 * The limit is read per {@link acquire} / release from a supplier, so a
 * config reload that changes it applies to the next grant decision —
 * requests already running are never interrupted.
 */
export class InferenceConcurrencyLimiter {
    private readonly lanes = new Map<string, LimiterLane>();
    private sequenceCounter = 0;

    /**
     * @param readLimit Returns the current limit for a key; `undefined`
     *   (or a non-positive value) means "unlimited" for that key.
     * @param now Clock for wait-time measurement (tests inject a fake).
     */
    constructor(
        private readonly readLimit: (key: string) => number | undefined,
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * Take a slot for `key`, waiting in the priority queue when the key's
     * limit is reached. Higher `priority` is served first; equal
     * priorities are FIFO.
     *
     * @param key Limit key (`<provider>` or `<provider>/<modelId>`).
     * @param priority Priority of the calling agentrun (higher first).
     * @param signal Aborting it removes a queued request and rejects.
     * @param hooks Optional wait start / end callbacks.
     * @returns A release function; call it exactly when the request is done.
     * @throws The signal's abort reason when aborted while queued.
     */
    acquire(
        key: string,
        priority: number,
        signal: AbortSignal | undefined,
        hooks: AcquireHooks = {},
    ): Promise<ReleaseSlot> {
        signal?.throwIfAborted();
        // Let a limit raised by a config reload admit already queued
        // requests first, so the newcomer keeps its place behind them.
        const existingLane = this.lanes.get(key);
        if (existingLane !== undefined) {
            this.drain(key, existingLane);
        }
        const lane = this.laneFor(key);
        if (lane.queue.length === 0 && this.hasFreeSlot(key, lane)) {
            lane.running++;
            return Promise.resolve(this.releaseFor(key, lane));
        }

        const enqueuedAt = this.now();
        return new Promise<ReleaseSlot>((resolve, reject) => {
            const onAbort = () => {
                const index = lane.queue.indexOf(request);
                if (index >= 0) {
                    lane.queue.splice(index, 1);
                }
                reject(signal?.reason);
            };
            const request: QueuedRequest = {
                priority,
                sequence: this.sequenceCounter++,
                grant: () => {
                    signal?.removeEventListener("abort", onAbort);
                    hooks.onWaitEnd?.(this.now() - enqueuedAt);
                    resolve(this.releaseFor(key, lane));
                },
            };
            insertByPriority(lane.queue, request);
            signal?.addEventListener("abort", onAbort, { once: true });
            hooks.onWaitStart?.(lane.queue.indexOf(request) + 1);
        });
    }

    /**
     * Number of requests currently queued (not running) for `key`.
     *
     * @param key Limit key.
     * @returns Queue length; `0` for an unknown key.
     */
    queuedCount(key: string): number {
        return this.lanes.get(key)?.queue.length ?? 0;
    }

    /**
     * Number of requests currently holding a slot for `key`.
     *
     * @param key Limit key.
     * @returns Running count; `0` for an unknown key.
     */
    runningCount(key: string): number {
        return this.lanes.get(key)?.running ?? 0;
    }

    /** Get or create the lane for a key. */
    private laneFor(key: string): LimiterLane {
        const existing = this.lanes.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const lane: LimiterLane = { running: 0, queue: [] };
        this.lanes.set(key, lane);
        return lane;
    }

    /** Whether the lane may start one more request under the current limit. */
    private hasFreeSlot(key: string, lane: LimiterLane): boolean {
        const limit = this.readLimit(key);
        return limit === undefined || limit <= 0 || lane.running < limit;
    }

    /** Build the idempotent release function for one granted slot. */
    private releaseFor(key: string, lane: LimiterLane): ReleaseSlot {
        let isReleased = false;
        return () => {
            if (isReleased) {
                return;
            }
            isReleased = true;
            lane.running--;
            this.drain(key, lane);
        };
    }

    /** Grant queued requests while the (possibly reloaded) limit allows. */
    private drain(key: string, lane: LimiterLane): void {
        while (lane.queue.length > 0 && this.hasFreeSlot(key, lane)) {
            const next = lane.queue.shift();
            if (next === undefined) {
                return;
            }
            lane.running++;
            next.grant();
        }
        if (lane.running === 0 && lane.queue.length === 0) {
            this.lanes.delete(key);
        }
    }
}

/**
 * Insert keeping the queue sorted by priority (desc), then sequence (asc).
 *
 * @param queue The lane's queue, already sorted.
 * @param request The request to insert.
 */
function insertByPriority(queue: QueuedRequest[], request: QueuedRequest): void {
    const index = queue.findIndex((queued) => queued.priority < request.priority);
    if (index < 0) {
        queue.push(request);
        return;
    }
    queue.splice(index, 0, request);
}

/**
 * Read the passed config `inference.concurrency` map (limit key →
 * positive integer). Invalid entries are ignored (the host linter
 * reports them).
 *
 * @returns The configured limits; empty when the key is absent.
 */
export function readInferenceConcurrencyLimits(): Readonly<Record<string, number>> {
    const raw = PassedConfig.get<unknown>("inference.concurrency");
    if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const limits: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "number" && Number.isInteger(value) && value > 0) {
            limits[key] = value;
        }
    }
    return limits;
}

/**
 * Pick the limit key that governs a model: the most specific configured
 * entry wins — `<provider>/<modelId>` before `<provider>`.
 *
 * @param provider Resolved provider id.
 * @param modelId Resolved model id under that provider.
 * @param limits The configured limits.
 * @returns The governing key, or `null` when neither is configured.
 */
export function resolveConcurrencyKey(
    provider: string,
    modelId: string,
    limits: Readonly<Record<string, number>>,
): string | null {
    const modelKey = `${provider}/${modelId}`;
    if (Object.hasOwn(limits, modelKey)) {
        return modelKey;
    }
    if (Object.hasOwn(limits, provider)) {
        return provider;
    }
    return null;
}

/** The container-wide limiter every agentrun's model requests share. */
export const inferenceLimiter = new InferenceConcurrencyLimiter(
    (key) => readInferenceConcurrencyLimits()[key],
);

/** Inputs of {@link limitModelConcurrency}. */
export interface LimitModelOptions {
    readonly provider: string;
    readonly modelId: string;
    /** Agentrun priority; orders the wait queue. */
    readonly priority: number;
    readonly log: Logger;
    /** Called when a request starts waiting (the caller pauses its step timer). */
    readonly onWaitStart: () => void;
    /** Called when a waiting request got its slot (the caller re-arms its step timer). */
    readonly onWaitEnd: () => void;
    /** Limiter to use; defaults to the container-wide {@link inferenceLimiter}. */
    readonly limiter?: InferenceConcurrencyLimiter;
}

/**
 * Wrap a model so every request (generate or stream) holds a slot of the
 * governing `inference.concurrency` key while it runs. The key is
 * resolved per request, so a config reload applies to the next request.
 * Without a configured key the request passes straight through.
 *
 * @param model The provider model built by `ModelFactory`.
 * @param options Provider / model identity, priority, logger and wait hooks.
 * @returns The wrapped model.
 */
export function limitModelConcurrency(
    model: LanguageModelV4,
    options: LimitModelOptions,
): LanguageModelV4 {
    const limiter = options.limiter ?? inferenceLimiter;

    const acquireSlot = async (signal: AbortSignal | undefined): Promise<ReleaseSlot | null> => {
        const key = resolveConcurrencyKey(
            options.provider,
            options.modelId,
            readInferenceConcurrencyLimits(),
        );
        if (key === null) {
            return null;
        }
        let isWaiting = false;
        try {
            return await limiter.acquire(key, options.priority, signal, {
                onWaitStart: (position) => {
                    isWaiting = true;
                    options.onWaitStart();
                    options.log.info(
                        { concurrencyKey: key, queuePosition: position },
                        `inference request for ${options.provider}/${options.modelId} waiting for a free "${key}" slot (queue position ${position})`,
                    );
                },
                onWaitEnd: (waitedMs) => {
                    isWaiting = false;
                    options.onWaitEnd();
                    options.log.info(
                        { concurrencyKey: key, waitedMs },
                        `inference request for ${options.provider}/${options.modelId} got a "${key}" slot after ${Math.round(waitedMs / 1000)}s`,
                    );
                },
            });
        } catch (err) {
            if (isWaiting) {
                options.onWaitEnd();
            }
            throw err;
        }
    };

    const middleware: LanguageModelV4Middleware = {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, params }) => {
            const release = await acquireSlot(params.abortSignal);
            try {
                return await doGenerate();
            } finally {
                release?.();
            }
        },
        wrapStream: async ({ doStream, params }) => {
            const release = await acquireSlot(params.abortSignal);
            if (release === null) {
                return doStream();
            }
            try {
                const result = await doStream();
                return {
                    ...result,
                    stream: releaseWhenStreamEnds(result.stream, release),
                };
            } catch (err) {
                release();
                throw err;
            }
        },
    };
    return wrapLanguageModel({ model, middleware });
}

/**
 * Pass the stream through and release the slot when it ends, errors or
 * is cancelled by the consumer.
 *
 * @param source The provider's stream.
 * @param release The slot's release function (idempotent).
 * @returns A stream with the same parts.
 */
function releaseWhenStreamEnds(
    source: ReadableStream<LanguageModelV4StreamPart>,
    release: ReleaseSlot,
): ReadableStream<LanguageModelV4StreamPart> {
    const reader = source.getReader();
    return new ReadableStream<LanguageModelV4StreamPart>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    release();
                    controller.close();
                    return;
                }
                controller.enqueue(value);
            } catch (err) {
                release();
                controller.error(err);
            }
        },
        async cancel(reason) {
            release();
            await reader.cancel(reason);
        },
    });
}
