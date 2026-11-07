import {
    type AgentRunRow,
    BANNER_MAX_ACTIVE,
    BANNER_MAX_LIFETIME_DAYS,
    BANNER_MAX_TEXT_CHARS,
    type BannerBus,
    parseInZone,
    renderInZone,
    runJsonLinesTool,
    runJsonTool,
    ToolError,
    type ToolRunContext,
} from "@getfamiliar/shared";
import { jsonSchema, type Tool, tool } from "ai";
import type { NoToolContext } from "./NoToolContext.js";

/** Milliseconds per day, for the lifetime cap. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The subset of {@link BannerBus} the banner tools use. */
export type BannerStore = Pick<BannerBus, "create" | "remove" | "listActive">;

interface BannerCreateInput {
    readonly text: string;
    readonly expires_at: string;
}

interface BannerRemoveInput {
    readonly ids: readonly number[];
}

/**
 * Build the `banner_create` tool — leave a short-lived note that every
 * later agentrun sees in its prompt (`{BANNER_LIST}`) until it expires.
 *
 * Registered with level `privileged` (see `CONTAINER_TOOL_LEVELS`): a
 * banner reaches every future prompt, so only runs that stem from the
 * user may create one — a non-privileged mail run must not be able to
 * plant persistent instructions.
 *
 * @param store Banner persistence.
 * @param parent The calling agentrun, recorded as the banner's creator.
 * @param timezone IANA zone the agent's wall-clock input is read in.
 * @param ctx Tool-run context.
 * @param now Clock, injectable for tests.
 * @returns The tool.
 */
export function buildBannerCreateTool(
    store: BannerStore,
    parent: AgentRunRow,
    timezone: string,
    ctx: ToolRunContext,
    now: () => Date = () => new Date(),
): Tool<BannerCreateInput, object> {
    return tool<BannerCreateInput, object, NoToolContext>({
        description:
            "Create a banner: a short note every later agent run sees in its prompt until it " +
            "expires. Use it for temporary situations other handlers must know about, e.g. the " +
            "user is ill today, travelling this week, setting up a new phone (expect new-login " +
            "mails), or waiting for a parcel. Write it self-contained (who, what, why it " +
            `matters), max ${BANNER_MAX_TEXT_CHARS} characters. Choose a realistic expiry ` +
            `(max ${BANNER_MAX_LIFETIME_DAYS} days); for lasting facts use the long-term memory ` +
            "instead. Remove a banner early with `banner_remove` once it no longer applies.",
        inputSchema: jsonSchema<BannerCreateInput>({
            type: "object",
            additionalProperties: false,
            required: ["text", "expires_at"],
            properties: {
                text: {
                    type: "string",
                    description: `The note, self-contained, max ${BANNER_MAX_TEXT_CHARS} characters.`,
                },
                expires_at: {
                    type: "string",
                    description:
                        "When the banner disappears: ISO-8601 wall-clock in the user's local " +
                        "timezone, e.g. `2026-05-22T23:59:00`. Must be in the future, at most " +
                        `${BANNER_MAX_LIFETIME_DAYS} days ahead.`,
                },
            },
        }),
        execute: ({ text, expires_at }) =>
            runJsonTool(async () => {
                const trimmed = text.trim();
                if (trimmed.length === 0) {
                    throw new ToolError("BadText", "`text` must not be empty.");
                }
                if (trimmed.length > BANNER_MAX_TEXT_CHARS) {
                    throw new ToolError(
                        "BadText",
                        `\`text\` has ${trimmed.length} characters; the maximum is ${BANNER_MAX_TEXT_CHARS}. Shorten it.`,
                    );
                }
                const parsed = parseInZone(expires_at, timezone);
                if (!parsed.ok) {
                    throw new ToolError("BadExpiresAt", parsed.error);
                }
                const expiresMs = Date.parse(parsed.utcIso);
                const nowMs = now().getTime();
                if (expiresMs <= nowMs) {
                    throw new ToolError(
                        "BadExpiresAt",
                        `\`expires_at\` ${expires_at} is not in the future (now: ${renderInZone(new Date(nowMs).toISOString(), timezone)}).`,
                    );
                }
                if (expiresMs > nowMs + BANNER_MAX_LIFETIME_DAYS * MS_PER_DAY) {
                    throw new ToolError(
                        "BadExpiresAt",
                        `\`expires_at\` is more than ${BANNER_MAX_LIFETIME_DAYS} days ahead. Banners are for temporary situations; store lasting facts in the long-term memory instead.`,
                    );
                }
                const active = await store.listActive();
                if (active.length >= BANNER_MAX_ACTIVE) {
                    throw new ToolError(
                        "TooManyBanners",
                        `There are already ${active.length} active banners (maximum ${BANNER_MAX_ACTIVE}). Remove outdated ones with \`banner_remove\` first.`,
                    );
                }
                const row = await store.create({
                    text: trimmed,
                    expiresAt: parsed.utcIso,
                    createdByAgentrunId: parent.id,
                    createdByTopic: parent.topic,
                });
                return { id: Number(row.id), expires_at: renderInZone(row.expiresAt, timezone) };
            }, ctx),
    });
}

/**
 * Build the `banner_remove` tool — delete banners before they expire.
 * Level `default`: removing a note can't inject anything.
 *
 * @param store Banner persistence.
 * @param ctx Tool-run context.
 * @returns The tool.
 */
export function buildBannerRemoveTool(
    store: BannerStore,
    ctx: ToolRunContext,
): Tool<BannerRemoveInput, object> {
    return tool<BannerRemoveInput, object, NoToolContext>({
        description:
            "Remove one or more banners by their id (the `[ID:<id>]` shown in the banner list) " +
            "once they no longer apply.",
        inputSchema: jsonSchema<BannerRemoveInput>({
            type: "object",
            additionalProperties: false,
            required: ["ids"],
            properties: {
                ids: {
                    type: "array",
                    minItems: 1,
                    items: { type: "integer" },
                    description: "Banner ids to remove, e.g. `[12]`.",
                },
            },
        }),
        execute: ({ ids }) =>
            runJsonTool(async () => {
                const requested = [...new Set(ids.map((id) => String(id)))];
                const removed = await store.remove(requested);
                const notFound = requested.filter((id) => !removed.includes(id));
                if (removed.length === 0) {
                    throw new ToolError(
                        "BannerNotFound",
                        `No active banner with id ${notFound.join(", ")} (already expired or removed).`,
                    );
                }
                return { removed: removed.map(Number), notFound: notFound.map(Number) };
            }, ctx),
    });
}

/**
 * Build the `banner_list` tool — the active banners as JSONL, for
 * handlers whose prompt template doesn't render `{BANNER_LIST}`.
 *
 * @param store Banner persistence.
 * @param timezone IANA zone the times are rendered in.
 * @param ctx Tool-run context.
 * @returns The tool.
 */
export function buildBannerListTool(
    store: BannerStore,
    timezone: string,
    ctx: ToolRunContext,
): Tool<Record<string, never>, string> {
    return tool<Record<string, never>, string, NoToolContext>({
        description:
            "List the active banners (short-lived notes for every agent run), one JSONL line " +
            "each with id, text, creation and expiry time in the user's local timezone. The " +
            "default prompt already shows them; use this when yours does not.",
        inputSchema: jsonSchema<Record<string, never>>({
            type: "object",
            additionalProperties: false,
            properties: {},
        }),
        execute: () =>
            runJsonLinesTool(async () => {
                const rows = await store.listActive();
                return rows.map((row) => ({
                    id: Number(row.id),
                    text: row.text,
                    created_at: renderInZone(row.createdAt, timezone),
                    expires_at: renderInZone(row.expiresAt, timezone),
                    created_by_topic: row.createdByTopic,
                }));
            }, ctx),
    });
}
