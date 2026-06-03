import { existsSync, readFileSync } from "node:fs";
import { confirm, input, password, select } from "@inquirer/prompts";
import { defineCommand } from "citty";
import { parse, stringify } from "yaml";
import { bootstrap } from "../../Bootstrap.js";
import { lintMcpConfigFile } from "../../mcp/McpConfigLoader.js";
import type { McpSource } from "../../mcp/McpEntry.js";
import { appendEntry } from "../../mcp/McpYamlAppender.js";
import { fetchDockerRegistry } from "../../mcp/registries/DockerRegistryClient.js";
import { fetchOfficialRegistry } from "../../mcp/registries/OfficialRegistryClient.js";
import {
    proposeId,
    type RegistryCandidate,
    type RegistryHit,
} from "../../mcp/registries/RegistryEntry.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `cli.sh tools add-mcp <package>` — interactive dialogue that finds an MCP
 * by name in the Docker MCP registry first, falls back to the
 * official MCP registry, lets the user fill in env vars and any
 * extra args, and appends a validated entry to `config/mcp.yml`.
 *
 * The positional `<package>` is the **search term** fed to the
 * registries (e.g. `fetch`, `io.github.dgahagan/weather-mcp`,
 * `mcp-server-time`). The local `mcp.yml` key is always *derived*
 * from the registry's `name` field via {@link proposeId} and
 * proposed to the user as an editable default — search term and
 * local id are intentionally distinct concepts.
 */
export const addMcpCommand = defineCommand({
    meta: {
        name: "add-mcp",
        description:
            "Interactively add an MCP from the Docker MCP registry (preferred) or the official MCP registry. Appends to config/mcp.yml.",
    },
    args: {
        package: {
            type: "positional",
            required: false,
            description:
                "Package name to search for (e.g. fetch, mcp-server-time, io.github.foo/bar). Prompts when omitted.",
        },
    },
    async run({ args }) {
        try {
            await runDialogue(args.package);
        } catch (err) {
            // `@inquirer/prompts` doesn't re-export its
            // `ExitPromptError` from `@inquirer/core`, and adding a
            // direct dep on `@inquirer/core` just to instanceof-check
            // it isn't worth the coupling — name-match is reliable
            // (the class name is stable across versions) and keeps
            // our import surface minimal.
            if (err instanceof Error && err.name === "ExitPromptError") {
                process.stderr.write("cancelled; mcp.yml unchanged\n");
                process.exit(130);
            }
            throw err;
        }
    },
});

/**
 * Top-level orchestration. Each step is small and named so the
 * flow reads top-down: pick search term → resolve registry hit →
 * pick variant → collect id+title+description+env+args+network →
 * preview → append → re-lint.
 */
async function runDialogue(positional: string | undefined): Promise<void> {
    const boot = bootstrap();

    // Preflight lint: bail before asking the user a single question
    // if the existing `mcp.yml` is already broken. Walking through
    // the whole dialogue only to fail on the post-append lint would
    // waste their time, and a corrupted file is a problem the user
    // needs to fix by hand anyway — we can't safely append into it.
    const preLint = lintMcpConfigFile(boot.mcpConfigFile);
    if (!preLint.ok) {
        process.stderr.write(
            `config/mcp.yml is malformed; clean it up before adding new entries. Errors:\n`,
        );
        for (const e of preLint.errors) {
            process.stderr.write(`  - ${e}\n`);
        }
        process.exit(1);
    }

    const existingIds = loadExistingIds(boot.mcpConfigFile);

    const searchTerm =
        positional && positional.length > 0
            ? positional
            : await input({ message: "Package name to search for:" });

    if (searchTerm.length === 0) {
        process.stderr.write("no search term provided; aborting\n");
        process.exit(1);
    }

    const hit = await resolveHit(searchTerm);
    if (hit === null) {
        process.stdout.write(
            `not found in either registry; declare manually in config/mcp.yml or see docs/mcp.md\n`,
        );
        return;
    }

    const candidate = await chooseCandidate(hit);
    if (candidate === null) {
        process.stderr.write(
            `no installable package variants for "${hit.registryName}" (only nuget/mcpb available); aborting\n`,
        );
        process.exit(1);
    }

    const id = await chooseId(hit, existingIds);
    // Title and description come straight from the registry — they're
    // already written for the package and rarely worth re-typing. The
    // user can hand-edit `mcp.yml` afterwards if they want a custom
    // wording.
    const title = hit.title;
    const description = hit.description;

    const envValues = await collectEnv(candidate);
    const extraArgs = await collectExtraArgs();
    const networkDisabled = await confirm({
        message: "Disable network for this MCP?",
        default: false,
    });

    const entryYaml = renderEntry({
        id,
        title,
        description,
        candidate,
        env: envValues,
        extraArgs,
        networkDisabled,
    });

    process.stdout.write("\nProposed entry:\n");
    process.stdout.write("----------------------------------------\n");
    process.stdout.write(entryYaml);
    process.stdout.write("----------------------------------------\n");

    const ok = await confirm({
        message: "Append to config/mcp.yml?",
        default: true,
    });
    if (!ok) {
        process.stdout.write("aborted; mcp.yml unchanged\n");
        return;
    }

    try {
        appendEntry(boot.mcpConfigFile, entryYaml);
    } catch (err) {
        // `appendEntry` already rolled back the file before
        // throwing; surface the lint diagnostics so the user can
        // see why the entry was rejected.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    }
    process.stdout.write(`appended "${id}" to ${boot.mcpConfigFile}\n`);

    // Surface any post-append warnings that aren't lint errors.
    // The hard errors are handled by `appendEntry`'s rollback path
    // above.
    const lintResult = lintMcpConfigFile(boot.mcpConfigFile);
    for (const w of lintResult.warnings) {
        process.stdout.write(`warning: ${w}\n`);
    }
    process.stdout.write(
        "\nRestart the daemon to load the new MCP: ./cli.sh stop && ./cli.sh start\n",
    );
}

/**
 * Try the Docker MCP registry first; fall back to the official
 * registry if the Docker side returns 404. Network errors against
 * the Docker registry are surfaced as warnings (not fatal) so a
 * transient hiccup doesn't block a fallback path.
 */
async function resolveHit(searchTerm: string): Promise<RegistryHit | null> {
    process.stdout.write(`searching Docker MCP registry for "${searchTerm}"...\n`);
    let dockerHit: RegistryHit | null = null;
    try {
        dockerHit = await fetchDockerRegistry(searchTerm);
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        process.stderr.write(`warning: Docker registry lookup failed: ${cause}\n`);
    }
    if (dockerHit !== null) {
        process.stdout.write(`found in Docker MCP registry: ${dockerHit.registryName}\n`);
        return dockerHit;
    }

    process.stdout.write(`not in Docker MCP registry; searching official MCP registry...\n`);
    let officialHits: RegistryHit[] = [];
    try {
        officialHits = await fetchOfficialRegistry(searchTerm);
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        process.stderr.write(`warning: official registry lookup failed: ${cause}\n`);
        return null;
    }
    if (officialHits.length === 0) {
        return null;
    }
    if (officialHits.length === 1) {
        const only = officialHits[0] as RegistryHit;
        process.stdout.write(`found in official MCP registry: ${only.registryName}\n`);
        return only;
    }
    return await select<RegistryHit>({
        message: `Multiple servers match "${searchTerm}":`,
        choices: officialHits.map((h) => ({
            name: `${h.registryName} — ${h.description || h.title}`,
            value: h,
        })),
    });
}

/**
 * Always prompt the user to pick a candidate, even when only one
 * exists. The OCI option is labelled `(strongly preferred)` and set
 * as the default; the dialogue makes the preference visible without
 * silently choosing for the user.
 *
 * Returns null when the registry hit had no installable candidates
 * (every package was a non-supported registry type).
 */
async function chooseCandidate(hit: RegistryHit): Promise<RegistryCandidate | null> {
    if (hit.candidates.length === 0) {
        return null;
    }
    // Skip the prompt when there's nothing to choose between —
    // most servers publish exactly one variant. Print the auto-pick
    // so the user sees what we landed on.
    if (hit.candidates.length === 1) {
        const only = hit.candidates[0] as RegistryCandidate;
        process.stdout.write(`using ${candidateLabel(only)}\n`);
        return only;
    }
    const preferredIndex = hit.candidates.findIndex((c) => c.preferred);
    const defaultIndex = preferredIndex >= 0 ? preferredIndex : 0;
    const choice = await select<number>({
        message: "Pick a package variant:",
        default: defaultIndex,
        choices: hit.candidates.map((c, i) => ({
            name: candidateLabel(c),
            value: i,
        })),
    });
    return hit.candidates[choice] ?? null;
}

/**
 * Human-readable line for a candidate in the variant select. OCI
 * gets the preferred suffix; npm/pypi show their version separator
 * (`@` and `==`) so the user sees what would land in the YAML.
 */
function candidateLabel(c: RegistryCandidate): string {
    if (c.kind === "oci") {
        return `oci: ${c.identifier}${c.version ? `:${c.version}` : ""} (strongly preferred)`;
    }
    const sep = c.kind === "npm" ? "@" : "==";
    const ver = c.version ? `${sep}${c.version}` : "";
    return `${c.kind}: ${c.identifier}${ver}`;
}

/**
 * Prompt for the local YAML key. Default is the slug derived from
 * the registry name; the user can edit. On an invalid id (regex
 * fail) or a collision with an already-declared key, re-prompt
 * with a hint so the user can finish without restarting.
 */
async function chooseId(hit: RegistryHit, existing: ReadonlySet<string>): Promise<string> {
    let suggestion = proposeId(hit.registryName);
    while (true) {
        const id = await input({ message: "Local ID:", default: suggestion });
        if (!ID_PATTERN.test(id)) {
            process.stderr.write(
                `id must match ${ID_PATTERN} (lowercase alnum + dash, leading alnum)\n`,
            );
            suggestion = id;
            continue;
        }
        if (existing.has(id)) {
            process.stderr.write(`id "${id}" already declared in mcp.yml — pick another\n`);
            suggestion = id;
            continue;
        }
        return id;
    }
}

/**
 * Walk the candidate's env slots, prompting for each. Secrets use
 * `password` (no echo); non-secrets use `input` with the slot's
 * `defaultValue` or `example` as the prompt default. Empty answers
 * for non-required slots are dropped from the resulting YAML so
 * the file stays clean.
 */
async function collectEnv(
    candidate: RegistryCandidate,
): Promise<Array<{ slot: (typeof candidate)["envSlots"][number]; value: string }>> {
    const collected: Array<{ slot: (typeof candidate)["envSlots"][number]; value: string }> = [];
    if (candidate.envSlots.length === 0) {
        return collected;
    }
    process.stdout.write(`\nEnvironment variables (${candidate.envSlots.length}):\n`);
    for (const slot of candidate.envSlots) {
        if (slot.description) {
            process.stdout.write(`\n  ${slot.description}\n`);
        }
        const promptDefault = slot.defaultValue ?? slot.example;
        const value = slot.isSecret
            ? await password({ message: `${slot.name}:` })
            : await input({
                  message: `${slot.name}:`,
                  default: promptDefault,
              });
        if (value.length > 0) {
            collected.push({ slot, value });
        }
    }
    return collected;
}

/** Optional free-form arg loop: empty input ends the loop. */
async function collectExtraArgs(): Promise<string[]> {
    const want = await confirm({ message: "Add custom args?", default: false });
    if (!want) {
        return [];
    }
    const args: string[] = [];
    while (true) {
        const arg = await input({ message: "arg (blank to finish):" });
        if (arg.length === 0) {
            return args;
        }
        args.push(arg);
    }
}

/** Read existing ids out of `mcp.yml` into a set. Empty if the file is absent. */
function loadExistingIds(filePath: string): ReadonlySet<string> {
    if (!existsSync(filePath)) {
        return new Set();
    }
    const raw = readFileSync(filePath, "utf-8");
    let root: unknown;
    try {
        root = parse(raw);
    } catch {
        return new Set();
    }
    if (root === null || typeof root !== "object" || Array.isArray(root)) {
        return new Set();
    }
    return new Set(Object.keys(root as Record<string, unknown>));
}

/**
 * Render the user's choices as a YAML block keyed by `id`. Output
 * goes both to the preview and (on confirm) to the appender, so
 * the user sees exactly what gets written. Source-specific fields
 * (`image` vs `package`/`version`) are populated from the chosen
 * candidate.
 */
function renderEntry(input: {
    id: string;
    title: string;
    description: string;
    candidate: RegistryCandidate;
    env: ReadonlyArray<{
        slot: { name: string; isSecret: boolean; description?: string; example?: string };
        value: string;
    }>;
    extraArgs: readonly string[];
    networkDisabled: boolean;
}): string {
    const source: McpSource =
        input.candidate.kind === "oci" ? "docker-mcp-registry" : input.candidate.kind; // "npm" | "pypi"

    const body: Record<string, unknown> = {
        title: input.title,
        description: input.description,
        source,
    };
    if (input.candidate.kind === "oci") {
        body.image = input.candidate.identifier;
    } else {
        body.package = input.candidate.identifier;
        if (input.candidate.version) {
            body.version = input.candidate.version;
        }
    }
    if (input.env.length > 0) {
        body.env = input.env.map((e) => {
            const entry: Record<string, unknown> = {
                name: e.slot.name,
                value: e.value,
            };
            if (e.slot.isSecret) {
                entry.is_secret = true;
            }
            if (e.slot.description) {
                entry.description = e.slot.description;
            }
            if (e.slot.example) {
                entry.example = e.slot.example;
            }
            return entry;
        });
    }
    const args = [...input.candidate.argSlots, ...input.extraArgs];
    if (args.length > 0) {
        body.args = args;
    }
    // Only emit `network` when the user opted into `disable: true`.
    // `disable: false` is already the default at runtime, so leaving
    // the key out keeps the file clean.
    if (input.networkDisabled) {
        body.network = { disable: true };
    }
    return stringify({ [input.id]: body });
}
