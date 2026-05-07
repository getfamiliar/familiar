/**
 * Source classifier for an MCP entry. Drives which factory builds the
 * `McpServer` instance and which source-specific fields are required.
 *
 * - `docker-mcp-registry` — image pulled from the Docker MCP registry
 *   (https://github.com/docker/mcp-registry). Implemented.
 * - `npm` — npm package run inside a node container. Stub.
 * - `pypi` — pypi package run inside a python container. Stub.
 * - `external` — remote MCP reachable over HTTP; no container started.
 *   Stub (placeholder until the agent's tool wiring lands).
 */
export type McpSource = "docker-mcp-registry" | "npm" | "pypi" | "external";

/**
 * A single environment variable injected into the MCP container at
 * runtime. The shape is shared across all source types so that future
 * UI/CLI helpers don't have to special-case per source.
 *
 * `is_secret` is informational today (no code branches on it) but is
 * the contract for log masking once that lands. `example` and
 * `description` are user-facing helpers for the future "add MCP" CLI.
 */
export interface McpEnvVar {
    readonly name: string;
    readonly value: string;
    readonly is_secret?: boolean;
    readonly example?: string;
    readonly description?: string;
}

/**
 * Networking constraints declared on an MCP entry. Both fields are
 * **parsed but not yet enforced** — egress filtering needs a sidecar
 * proxy that is out of scope for the initial runtime support. They
 * exist now so users can declare intent and we can wire enforcement
 * later without a schema change.
 */
export interface McpNetwork {
    readonly disable: boolean;
    readonly allowHosts: readonly string[];
}

/**
 * One validated MCP entry as parsed from `config/mcp.yml`. Source-
 * specific fields (`image`, `package`/`version`, `url`) are optional
 * at the type level and required by the loader on a per-source basis.
 *
 * Factories receive this shape directly and decide which source-
 * specific fields they need; the discriminator is `source`.
 */
export interface McpEntry {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly source: McpSource;
    readonly env: readonly McpEnvVar[];
    readonly volumes: readonly string[];
    readonly args: readonly string[];
    readonly command: string | null;
    readonly network: McpNetwork;
    /** Required when `source === "docker-mcp-registry"`. */
    readonly image?: string;
    /** Required when `source === "npm"` or `source === "pypi"`. */
    readonly package?: string;
    /** Optional package version pin for `npm`/`pypi` sources. */
    readonly version?: string;
    /** Required when `source === "external"`. Endpoint URL. */
    readonly url?: string;
    /**
     * Seconds of inactivity after which a stdio-transport MCP child is
     * stopped and reaped. The next request cold-spawns it again.
     * Materialized to {@link DEFAULT_IDLE_TIMEOUT_SECONDS} when omitted
     * from `mcp.yml`. Has no effect on HTTP/external transports.
     */
    readonly idleTimeoutSeconds: number;
}

/**
 * Default idle timeout for stdio MCP children when an entry does not set
 * `idleTimeoutSeconds`. Thirty minutes is long enough that a working
 * conversation keeps the child warm; short enough that idle catalogs
 * don't tie up a docker container per declared MCP indefinitely.
 */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

/** Map of mcp id → entry. The YAML key is the id. */
export type McpEntries = ReadonlyMap<string, McpEntry>;
