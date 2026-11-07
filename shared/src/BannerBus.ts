import { DateTime } from "luxon";
import type { PostgresConnection } from "./PostgresConnection.js";
import { SCHEMA_SQL } from "./Schema.js";

/** Longest banner text accepted, in characters. Keeps every prompt bounded. */
export const BANNER_MAX_TEXT_CHARS = 500;

/** Most banners that may be active at the same time. */
export const BANNER_MAX_ACTIVE = 20;

/**
 * Longest lifetime of a banner, in days. Anything that stays true longer
 * belongs into the long-term memory (wiki), not into every prompt.
 */
export const BANNER_MAX_LIFETIME_DAYS = 30;

/** One persisted banner. */
export interface BannerRow {
    /** Numeric id as string (`bigserial`, as `pg` returns it). */
    readonly id: string;
    /** The note itself. */
    readonly text: string;
    /** UTC ISO-8601 instant at which the banner disappears. */
    readonly expiresAt: string;
    /** UTC ISO-8601 creation instant. */
    readonly createdAt: string;
    /** Agentrun that created the banner, or `null` (CLI, deleted run). */
    readonly createdByAgentrunId: string | null;
    /** Topic of the creating agentrun, or `null`. */
    readonly createdByTopic: string | null;
}

/** Input to {@link BannerBus.create}. */
export interface NewBanner {
    readonly text: string;
    /** UTC ISO-8601 expiry instant. */
    readonly expiresAt: string;
    readonly createdByAgentrunId?: string | null;
    readonly createdByTopic?: string | null;
}

/** Raw row shape returned by SELECT. `pg` returns timestamps as `Date`. */
interface RawRow {
    id: string;
    text: string;
    expires_at: Date;
    created_at: Date;
    created_by_agentrun_id: string | null;
    created_by_topic: string | null;
}

/**
 * Domain client for the `banners` table — short-lived notes the agent
 * leaves for every later agentrun. Used by the container (the
 * `banner_*` tools and the `{BANNER_LIST}` prompt placeholder) and by the
 * host CLI (`familiar banners`).
 *
 * Expiry is enforced on read: every listing deletes expired rows first,
 * so a banner "disappears" without a dedicated sweep job. All times are
 * stored and returned as UTC; agent-facing surfaces project them into
 * `core.timezone` (see {@link formatBannerList}).
 */
export class BannerBus {
    private readonly connection: PostgresConnection;

    constructor(connection: PostgresConnection) {
        this.connection = connection;
    }

    /**
     * Apply the bus-state schema (idempotent). Same SQL bundle every
     * other bus client installs.
     */
    async installSchema(): Promise<void> {
        await this.connection.getPool().query(SCHEMA_SQL);
    }

    /**
     * Insert a banner. Validation (length, lifetime, active count) is the
     * caller's job — see the `banner_create` tool.
     *
     * @param banner The banner to persist.
     * @returns The persisted row.
     */
    async create(banner: NewBanner): Promise<BannerRow> {
        await this.purgeExpired();
        const result = await this.connection.getPool().query<RawRow>(
            `INSERT INTO banners (text, expires_at, created_by_agentrun_id, created_by_topic)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [
                banner.text,
                banner.expiresAt,
                banner.createdByAgentrunId ?? null,
                banner.createdByTopic ?? null,
            ],
        );
        return mapRow(result.rows[0]);
    }

    /**
     * Delete banners by id.
     *
     * @param ids Banner ids (numeric strings).
     * @returns The ids that existed and were deleted.
     */
    async remove(ids: readonly string[]): Promise<string[]> {
        if (ids.length === 0) {
            return [];
        }
        const result = await this.connection
            .getPool()
            .query<{ id: string }>(
                `DELETE FROM banners WHERE id = ANY($1::bigint[]) RETURNING id`,
                [ids],
            );
        return result.rows.map((row) => row.id);
    }

    /**
     * List every banner that has not expired yet, oldest first. Deletes
     * expired banners before reading.
     *
     * @returns The active banners.
     */
    async listActive(): Promise<BannerRow[]> {
        await this.purgeExpired();
        const result = await this.connection
            .getPool()
            .query<RawRow>(
                `SELECT * FROM banners WHERE expires_at > now() ORDER BY created_at ASC, id ASC`,
            );
        return result.rows.map(mapRow);
    }

    /**
     * Delete every banner whose expiry has passed.
     *
     * @returns Number of deleted rows.
     */
    async purgeExpired(): Promise<number> {
        const result = await this.connection
            .getPool()
            .query(`DELETE FROM banners WHERE expires_at <= now()`);
        return result.rowCount ?? 0;
    }
}

/** Convert a snake_case raw row into the camelCase domain shape. */
function mapRow(raw: RawRow): BannerRow {
    return {
        id: String(raw.id),
        text: raw.text,
        expiresAt: raw.expires_at.toISOString(),
        createdAt: raw.created_at.toISOString(),
        createdByAgentrunId:
            raw.created_by_agentrun_id === null ? null : String(raw.created_by_agentrun_id),
        createdByTopic: raw.created_by_topic,
    };
}

/**
 * Render a UTC instant as compact local wall-clock `YYYY-MM-DD HH:mm`.
 * Falls back to the input on an unparsable instant or unknown zone.
 *
 * @param utcIso UTC ISO-8601 instant.
 * @param zone IANA zone (typically `core.timezone`).
 * @returns The local wall-clock string.
 */
export function formatBannerTime(utcIso: string, zone: string): string {
    const local = DateTime.fromISO(utcIso, { zone: "utc" }).setZone(zone);
    return local.isValid ? local.toFormat("yyyy-MM-dd HH:mm") : utcIso;
}

/**
 * Render banners as the markdown bullet list the prompt shows, one
 * `* [ID:<id>] <created> (until <expires>): <text>` line each. Newlines
 * inside a banner text are collapsed so one banner stays one bullet.
 *
 * @param banners Active banners, in display order.
 * @param zone IANA zone the times are shown in.
 * @returns The list, or `(none)` when there are no banners.
 */
export function formatBannerList(banners: readonly BannerRow[], zone: string): string {
    if (banners.length === 0) {
        return "(none)";
    }
    return banners
        .map(
            (banner) =>
                `* [ID:${banner.id}] ${formatBannerTime(banner.createdAt, zone)} (until ${formatBannerTime(banner.expiresAt, zone)}): ${banner.text.replace(/\s*\n\s*/g, " ").trim()}`,
        )
        .join("\n");
}
