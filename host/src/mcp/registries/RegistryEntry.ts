import type { McpNetwork } from "../McpEntry.js";

/**
 * Normalized result of looking up an MCP in either the Docker MCP
 * registry or the official MCP registry. Both clients map their
 * native shapes into this intermediate so the `mcp add` dialogue
 * doesn't have to branch on which registry served the answer.
 *
 * `registryName` is preserved verbatim so {@link proposeId} can
 * derive a YAML-key-safe local id from it.
 */
export interface RegistryHit {
    /** Verbatim `name` from the registry — feeds {@link proposeId}. */
    readonly registryName: string;
    readonly title: string;
    readonly description: string;
    readonly candidates: readonly RegistryCandidate[];
    /** Optional pre-filled network constraints (Docker registry's `run.allowHosts`). */
    readonly network?: McpNetwork;
}

/**
 * One installable variant of an MCP. The official registry
 * commonly returns multiple (e.g. an OCI image alongside an npm
 * package); the Docker registry returns exactly one.
 */
export interface RegistryCandidate {
    readonly kind: "oci" | "npm" | "pypi";
    /** Image (for `oci`) or package name (for `npm`/`pypi`). */
    readonly identifier: string;
    /** Optional version pin. */
    readonly version?: string;
    /** True for OCI variants — UI labels them "(strongly preferred)". */
    readonly preferred: boolean;
    readonly envSlots: readonly EnvSlot[];
    /** Pre-filled args from the registry; user can append more. */
    readonly argSlots: readonly string[];
}

/**
 * One environment-variable slot a candidate package wants filled.
 * The dialogue presents `description` above the prompt and
 * `example` as the prompt's pre-filled default; secrets are
 * collected via the `password` prompt instead of `input`.
 */
export interface EnvSlot {
    readonly name: string;
    readonly description?: string;
    readonly example?: string;
    readonly isSecret: boolean;
    /** Default already chosen by the registry; user can accept or replace. */
    readonly defaultValue?: string;
}

/**
 * Derive a short, YAML-key-safe local id from a registry's `name`
 * field. The dialogue presents this as an editable default, so the
 * goal is "give the user something short and obvious"; they can
 * always type something else.
 *
 * Strategy:
 *   1. Take the trailing segment of the reverse-DNS / scope path
 *      (`io.github.foo/bar` → `bar`, `@scope/bar` → `bar`).
 *   2. Lowercase and split on every non-`[a-z0-9]` run — so dots,
 *      slashes, dashes, underscores, and capital-letter boundaries
 *      all become token separators in one pass.
 *   3. Drop the redundant `mcp` and `server` tokens; nearly every
 *      registry name carries one or both as scaffolding noise
 *      (`pdf-mcp`, `mcp-server-time`, …).
 *   4. Concatenate the surviving tokens with no separator. Dashes
 *      *are* legal in `mcp.yml` keys, but the proposal stays
 *      cleaner without them; the user can still type a dashed id.
 *   5. If everything got filtered, fall back to `mcpserver` so the
 *      prompt always has a starting value.
 *
 * Examples:
 * - `fetch` → `fetch`
 * - `pdf-mcp` → `pdf`
 * - `io.github.dgahagan/weather-mcp` → `weather`
 * - `@dangahagan/weather-mcp` → `weather`
 * - `mcp-server-time` → `time`
 * - `mcp-server` → `mcpserver`
 * - `!!!` → `mcpserver`
 */
export function proposeId(registryName: string): string {
    const segment = registryName.split("/").pop() ?? registryName;
    const tokens = segment
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 0 && t !== "mcp" && t !== "server");
    if (tokens.length === 0) {
        return "mcpserver";
    }
    return tokens.join("");
}
