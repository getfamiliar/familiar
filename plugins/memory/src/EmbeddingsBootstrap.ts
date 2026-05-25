import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "@getfamiliar/shared";
import { type EmbeddingModel, embed } from "ai";

/**
 * Identity snapshot persisted at `data/memory/embedding.json` after a
 * successful trial. Lets the next daemon start avoid a redundant
 * trial-embed when nothing changed, and tells us when we have to throw
 * the old index away because the vector dimension would no longer match.
 */
export interface EmbeddingIdentity {
    readonly provider: string;
    readonly model: string;
    readonly dimension: number;
}

/** Filename inside the memory data dir for the persisted identity. */
const IDENTITY_FILENAME = "embedding.json";
/** Filename of the Orama-persisted index inside the memory data dir. */
const INDEX_FILENAME = "memory.msp";

/** Trial text used to discover the embedding dimension. Short, neutral. */
const TRIAL_TEXT = "memory bootstrap probe";

/** Outcome of {@link handshakeEmbeddings} — only `ready=true` carries an identity. */
export type HandshakeResult =
    | {
          readonly ready: true;
          readonly identity: EmbeddingIdentity;
          readonly indexInvalidated: boolean;
      }
    | { readonly ready: false; readonly reason: string };

/**
 * Confirm the configured embedding model works and resolve its vector
 * dimension. Side effects, ordered:
 *
 *  1. Make sure `dataDir` exists.
 *  2. Read any prior identity from `embedding.json`.
 *  3. If the prior identity matches the live `provider`+`model`, trust
 *     the recorded dimension and return — no API call, no index churn.
 *  4. Otherwise embed {@link TRIAL_TEXT}. On failure, return `ready=false`
 *     with a human-readable reason (the plugin stays loaded but
 *     disabled).
 *  5. If a prior identity existed and the trial returned a different
 *     dimension (or the model changed), delete `memory.msp` so the
 *     fresh index is built from scratch — flag this via
 *     `indexInvalidated: true` so the caller can log the reason.
 *  6. Write the new `embedding.json`.
 */
export async function handshakeEmbeddings(opts: {
    readonly dataDir: string;
    readonly provider: string;
    readonly model: string;
    readonly embeddingModel: EmbeddingModel;
    readonly log: Logger;
}): Promise<HandshakeResult> {
    const identityPath = path.join(opts.dataDir, IDENTITY_FILENAME);
    const indexPath = path.join(opts.dataDir, INDEX_FILENAME);
    await fs.mkdir(opts.dataDir, { recursive: true });

    const prior = await readIdentity(identityPath);
    if (prior && prior.provider === opts.provider && prior.model === opts.model) {
        return { ready: true, identity: prior, indexInvalidated: false };
    }

    let dimension: number;
    try {
        const result = await embed({
            model: opts.embeddingModel,
            value: TRIAL_TEXT,
            maxRetries: 1,
        });
        dimension = result.embedding.length;
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ready: false, reason };
    }

    let indexInvalidated = false;
    if (prior) {
        opts.log.info(
            {
                priorProvider: prior.provider,
                priorModel: prior.model,
                priorDimension: prior.dimension,
                newProvider: opts.provider,
                newModel: opts.model,
                newDimension: dimension,
            },
            "memory: embedding identity changed — discarding persisted index",
        );
        await fs.rm(indexPath, { force: true });
        indexInvalidated = true;
    }

    const identity: EmbeddingIdentity = {
        provider: opts.provider,
        model: opts.model,
        dimension,
    };
    await fs.writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");

    return { ready: true, identity, indexInvalidated };
}

/**
 * Best-effort read of the persisted identity. Returns `undefined` on
 * missing-file, malformed JSON, or wrong shape — every such case
 * forces a fresh trial-embed, which is the safe behavior.
 */
async function readIdentity(file: string): Promise<EmbeddingIdentity | undefined> {
    let raw: string;
    try {
        raw = await fs.readFile(file, "utf8");
    } catch {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { provider: unknown }).provider !== "string" ||
        typeof (parsed as { model: unknown }).model !== "string" ||
        typeof (parsed as { dimension: unknown }).dimension !== "number"
    ) {
        return undefined;
    }
    const obj = parsed as EmbeddingIdentity;
    if (!Number.isInteger(obj.dimension) || obj.dimension <= 0) {
        return undefined;
    }
    return obj;
}

/** Re-exported for the {@link MemoryStore} and CLI to locate the index file. */
export function indexFilePath(dataDir: string): string {
    return path.join(dataDir, INDEX_FILENAME);
}
