/**
 * Token usage counters reported by the Claude Code CLI per assistant turn
 * and aggregated on the terminal `result` event.
 */
export interface UsageCounters {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
}

/** MCP server entry reported in the `system` init event. */
export interface McpServerInfo {
    readonly name: string;
    readonly status: string;
}

/**
 * First event emitted by `claude -p --output-format stream-json`. Describes
 * the session environment: model, tools, MCP servers, permission mode, cwd.
 */
export interface SystemInitEvent {
    readonly type: "system";
    readonly subtype: "init";
    readonly session_id: string;
    readonly model: string;
    readonly cwd: string;
    readonly tools: readonly string[];
    readonly mcp_servers: readonly McpServerInfo[];
    readonly permissionMode: string;
    readonly [key: string]: unknown;
}

/**
 * A single content block inside an `assistant` or `user` event's message.
 * Covers the block types we care about and falls through to an unknown shape
 * for any future types.
 */
export type ContentBlock =
    | { readonly type: "text"; readonly text: string }
    | {
          readonly type: "tool_use";
          readonly id: string;
          readonly name: string;
          readonly input: unknown;
      }
    | {
          readonly type: "tool_result";
          readonly tool_use_id: string;
          readonly content: unknown;
          readonly is_error?: boolean;
      }
    | { readonly type: string; readonly [key: string]: unknown };

/** An assistant turn: text, tool_use blocks, and per-turn token usage. */
export interface AssistantEvent {
    readonly type: "assistant";
    readonly session_id: string;
    readonly parent_tool_use_id?: string | null;
    readonly message: {
        readonly id: string;
        readonly role: "assistant";
        readonly model: string;
        readonly stop_reason: string | null;
        readonly content: readonly ContentBlock[];
        readonly usage: UsageCounters;
    };
}

/** A user turn, typically carrying tool_result blocks. */
export interface UserEvent {
    readonly type: "user";
    readonly session_id: string;
    readonly parent_tool_use_id?: string | null;
    readonly message: {
        readonly role: "user";
        readonly content: readonly ContentBlock[];
    };
}

/**
 * Terminal event summarising the run. `subtype` is "success" on clean
 * completion or one of the documented error subtypes otherwise.
 */
export interface ResultEvent {
    readonly type: "result";
    readonly subtype: string;
    readonly session_id: string;
    readonly duration_ms: number;
    readonly duration_api_ms: number;
    readonly num_turns: number;
    readonly total_cost_usd: number;
    readonly usage: UsageCounters;
    readonly is_error: boolean;
    readonly result?: string;
    readonly permission_denials?: readonly unknown[];
}

/**
 * Payload of a `rate_limit_event`. `resetsAt` is a Unix timestamp in seconds
 * marking when the current window resets. Field names match the CLI's
 * camelCase output verbatim.
 */
export interface RateLimitInfo {
    readonly status: string;
    readonly resetsAt: number;
    readonly rateLimitType: string;
    readonly overageStatus: string;
    readonly overageDisabledReason?: string;
    readonly isUsingOverage: boolean;
}

/**
 * Emitted by the CLI to report current rate-limit state (remaining quota,
 * window reset time, overage eligibility).
 */
export interface RateLimitEvent {
    readonly type: "rate_limit_event";
    readonly session_id: string;
    readonly rate_limit_info: RateLimitInfo;
    readonly uuid?: string;
}

/** Fallback for event subtypes we don't (yet) model explicitly. */
export interface UnknownEvent {
    readonly type: string;
    readonly [key: string]: unknown;
}

/** Discriminated union of every event emitted on the stream-json channel. */
export type StreamEvent =
    | SystemInitEvent
    | AssistantEvent
    | UserEvent
    | ResultEvent
    | RateLimitEvent
    | UnknownEvent;
