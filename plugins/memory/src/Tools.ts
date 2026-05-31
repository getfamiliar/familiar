import { createHash } from "node:crypto";
import { EVENT_PRIORITY, type PluginTool } from "@getfamiliar/shared";
import type { MemoryConfig } from "./Config.js";
import { formatHitsFlat } from "./ContextProvider.js";
import type { MemoryStore } from "./MemoryStore.js";

/**
 * The save handler's event topic. Chosen to resolve under
 * `workspace/skills/memory/save.md` via the container's handler
 * resolver (`<topic>` is split on `:` into directory segments). The
 * skill explainer at `skills/memory/SKILL.md` lives alongside the
 * handler so both ship together in the plugin's `workspace-template/`.
 */
const SAVE_TOPIC = "skills:memory";
const SAVE_HANDLER = "save";

const NOT_READY_MESSAGE =
    "memory search is temporarily disabled — index still warming up or backend misconfigured";

/**
 * Build the two memory tools the agent sees as `memory_search` and
 * `memory_save`. Closures over the shared {@link MemoryStore} handle
 * initialized in `start(ctx)` — `tools(ctx)` runs after `start`
 * resolves, so the handle is always set by the time `execute` runs.
 */
export function buildMemoryTools(store: MemoryStore, cfg: MemoryConfig): readonly PluginTool[] {
    const searchTool: PluginTool<{ query: string; limit?: number }, string> = {
        name: "search",
        // Long-term memory is meant to be ambient: every handler
        // benefits from being able to recall facts about people,
        // threads, places. Listing `core` here adds both memory
        // tools to the implicit-default tool set every handler
        // omitting `tools:` receives, alongside the container's
        // built-in `fs_read`, `send_chat`, `call_handler`,
        // `schedule_handler`, and `unschedule_handler`.
        groups: ["core"],
        description:
            "Search the long-term memory, including every markdown file in the workspace with a hybrid vector + BM25 approach. Returns a markdown report of found associations.",
        inputSchema: {
            type: "object",
            required: ["query"],
            properties: {
                query: {
                    type: "string",
                    description: "Natural-language search query.",
                },
                limit: {
                    type: "number",
                    description:
                        "Max number of hits to return. Defaults to the configured `maxToolMemoryResults`.",
                },
            },
            additionalProperties: false,
        },
        execute: async ({ query, limit }) => {
            if (!store.isReady()) {
                return NOT_READY_MESSAGE;
            }
            const k =
                typeof limit === "number" && limit > 0
                    ? Math.floor(limit)
                    : cfg.maxToolMemoryResults;
            const hits = await store.search(query, { limit: k });
            return formatHitsFlat(hits);
        },
    };

    const saveTool: PluginTool<{ content: string }, string> = {
        name: "save",
        // See `searchTool.groups` comment above — both memory tools
        // ride the same ambient `core` promotion.
        groups: ["core"],
        description:
            "Save facts, observations, notes into long-term memory. Content is handed to a dedicated reasoning agentrun, this toolcall does not wait and returns immediately. Remember to include identifying facts in the content (email addresses, names etc.)",
        inputSchema: {
            type: "object",
            required: ["content"],
            properties: {
                content: {
                    type: "string",
                    minLength: 4,
                    description: "The information to remember, as freeform text.",
                },
            },
            additionalProperties: false,
        },
        execute: async ({ content }, toolCtx) => {
            const trimmed = content.trim();
            if (trimmed.length < 4) {
                throw new Error("memory_save: content too short (min 4 chars after trimming)");
            }
            // Content-hashed idempotency key dedups repeated saves of
            // the same text within the bus's dedup window.
            const idempotencyKey = `memory-save-${createHash("sha256")
                .update(trimmed)
                .digest("hex")
                .slice(0, 16)}`;
            const handle = await toolCtx.host.events.emit({
                topic: SAVE_TOPIC,
                startHandler: SAVE_HANDLER,
                prompt: trimmed,
                payload: {
                    sourceEventId: toolCtx.event.id,
                    sourceAgentrunId: toolCtx.agentrun.id,
                },
                priority: EVENT_PRIORITY.BACKGROUND,
                idempotencyKey,
            });
            // Fire-and-forget: never await `settled` from inside the
            // tool call, but attach a no-op catch so a failed save
            // doesn't crash the daemon with an unhandled rejection.
            handle.settled.catch((err) => {
                toolCtx.log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    "memory: save event settled with failure",
                );
            });
            return `Queued (event ${handle.id}). The memory will be filed shortly.`;
        },
    };

    return [searchTool, saveTool];
}
