import { parse } from "yaml";
import type { EnvSlot, RegistryHit } from "./RegistryEntry.js";

/**
 * Base URL for Docker MCP registry server descriptors. Each server
 * lives at `<base>/<name>/server.yaml`. Public, no auth.
 */
const DOCKER_REGISTRY_BASE = "https://raw.githubusercontent.com/docker/mcp-registry/main/servers";

/**
 * Fetch a Docker MCP registry entry by name. Returns `null` on 404
 * (no such server) so the caller can fall through to the official
 * registry without try/catching. Other failures (network errors,
 * 5xx, malformed YAML) throw so they don't masquerade as
 * "not found".
 *
 * The registry's per-server YAML layout maps to our {@link RegistryHit}
 * as follows:
 * - `name` → `registryName` (also feeds {@link proposeId} downstream)
 * - `about.title` → `title`
 * - `about.description` → `description`
 * - `image` → single `oci` candidate's `identifier`
 * - `config.secrets[]` → env slots with `isSecret: true`
 * - `config.env[]` → env slots with `isSecret: false`
 *
 * Fields the Docker registry doesn't carry (`args`, `command`,
 * `version`) are left empty — the `mcp add` dialogue prompts for
 * them when the user wants to override.
 */
export async function fetchDockerRegistry(name: string): Promise<RegistryHit | null> {
    const url = `${DOCKER_REGISTRY_BASE}/${encodeURIComponent(name)}/server.yaml`;
    let response: Response;
    try {
        response = await fetch(url);
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`Docker MCP registry network error for "${name}": ${cause}`);
    }
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`Docker MCP registry returned ${response.status} for "${name}" (${url}).`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
        parsed = parse(text);
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`Docker MCP registry YAML parse error for "${name}": ${cause}`);
    }
    return mapServerYaml(name, parsed);
}

/**
 * Translate a parsed `server.yaml` document into a {@link RegistryHit}.
 * Tolerant of missing fields (the schema varies across servers); a
 * missing `image` is the only fatal omission.
 */
function mapServerYaml(name: string, raw: unknown): RegistryHit {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Docker MCP registry: "${name}" server.yaml root is not a mapping.`);
    }
    const root = raw as Record<string, unknown>;

    const registryName = typeof root.name === "string" && root.name.length > 0 ? root.name : name;

    const about = isMapping(root.about) ? root.about : {};
    const title = stringOr(about.title, registryName);
    const description = stringOr(about.description, "");

    const image = root.image;
    if (typeof image !== "string" || image.length === 0) {
        throw new Error(`Docker MCP registry: "${name}" server.yaml is missing "image".`);
    }

    const config = isMapping(root.config) ? root.config : {};
    const envSlots = [...mapSecretsBlock(config.secrets), ...mapEnvBlock(config.env)];

    return {
        registryName,
        title,
        description,
        candidates: [
            {
                kind: "oci",
                identifier: image,
                version: undefined,
                preferred: true,
                envSlots,
                argSlots: [],
            },
        ],
    };
}

/**
 * Map the Docker registry's `config.secrets[]` block into env slots
 * marked `isSecret: true`. Each entry's `env:` field carries the
 * actual environment variable name; `name:` is the human-facing
 * label which we ignore (the dialogue uses `description` for that).
 */
function mapSecretsBlock(value: unknown): EnvSlot[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const slots: EnvSlot[] = [];
    for (const item of value) {
        if (!isMapping(item)) {
            continue;
        }
        const envName = typeof item.env === "string" ? item.env : undefined;
        if (envName === undefined) {
            continue;
        }
        slots.push({
            name: envName,
            description: optionalString(item.description),
            example: optionalString(item.example),
            isSecret: true,
        });
    }
    return slots;
}

/**
 * Map the Docker registry's `config.env[]` block into env slots
 * marked `isSecret: false`. The registry's `value:` field is the
 * Docker-templated default expression (e.g. `{{config.url}}`); we
 * preserve it as `defaultValue` so the user sees what the upstream
 * suggests.
 */
function mapEnvBlock(value: unknown): EnvSlot[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const slots: EnvSlot[] = [];
    for (const item of value) {
        if (!isMapping(item)) {
            continue;
        }
        const name = typeof item.name === "string" ? item.name : undefined;
        if (name === undefined) {
            continue;
        }
        slots.push({
            name,
            description: optionalString(item.description),
            example: optionalString(item.example),
            isSecret: false,
            defaultValue: optionalString(item.value),
        });
    }
    return slots;
}

/** Type guard for plain-mapping YAML nodes. */
function isMapping(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Coerce to a string with a fallback when missing or wrong-shape. */
function stringOr(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
}

/** Coerce to a string only when present + string-typed; undefined otherwise. */
function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
