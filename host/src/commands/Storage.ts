import { readFileSync } from "node:fs";
import { markdownTable, writeMarkdown } from "@getfamiliar/shared";
import { input, select } from "@inquirer/prompts";
import { defineCommand } from "citty";
import { parse, stringify } from "yaml";
import { bootstrap } from "../Bootstrap.js";
import type { PluginHost } from "../plugins/PluginHost.js";
import {
    DEFAULT_WRITE_ROOTS,
    isValidAlias,
    lintStorageStatic,
    normalizeRoot,
    parseStorageSettings,
    type StorageLintFinding,
} from "../storage/StorageConfig.js";
import { addCommandFor, type DiscoveryRow, discoverStorage } from "../storage/StorageDiscovery.js";
import { lintStorageOnline, writeRootNormalizations } from "../storage/StorageLint.js";
import {
    insertMapEntry,
    removeMapEntry,
    setConfigValue,
    writeConfigAtomically,
} from "../utils/ConfigDocument.js";
import { lintConfigFile } from "../utils/ConfigLinter.js";

const MOUNTS_PATH = ["storage", "mounts"] as const;
const DEFAULT_DISCOVERY_LIMIT = 50;

const RAW_ARG = {
    type: "boolean",
    description: "Skip terminal styling and emit the raw markdown verbatim.",
    default: false,
} as const;

const JSON_ARG = {
    type: "boolean",
    description: "Emit machine-readable JSON instead of markdown.",
    default: false,
} as const;

/**
 * `familiar storage` — discover drives, add / remove mounts and lint the
 * `storage` config. Commands that talk to providers say so; `lint`
 * without `--online` and `remove` work offline.
 *
 * @param pluginHost - Gives access to the storage providers plugins
 *   register in `prepare()`.
 * @returns The citty command tree.
 */
export function buildStorageCommand(pluginHost: PluginHost) {
    return defineCommand({
        meta: {
            name: "storage",
            description:
                "Cloud storage mounts: discover drives, add / remove mounts, lint the config.",
        },
        subCommands: {
            list: listCommand(pluginHost),
            add: addCommand(pluginHost),
            remove: removeCommand(),
            lint: lintCommand(pluginHost),
        },
    });
}

// ---- list ----------------------------------------------------------------

function listCommand(pluginHost: PluginHost) {
    return defineCommand({
        meta: {
            name: "list",
            description:
                "Show configured mounts and discovered-but-unconfigured drives (queries every storage provider live).",
        },
        args: {
            configured: { type: "boolean", description: "Only configured mounts.", default: false },
            available: {
                type: "boolean",
                description: "Only drives not configured yet.",
                default: false,
            },
            plugin: { type: "string", description: "Only this provider plugin." },
            account: { type: "string", description: "Only this account." },
            search: { type: "string", description: "Filter discovered drives by name." },
            limit: {
                type: "string",
                description: `Max drives discovered per account (default ${DEFAULT_DISCOVERY_LIMIT}).`,
            },
            json: JSON_ARG,
            raw: RAW_ARG,
        },
        async run({ args }) {
            pluginHost.prepareAll();
            const settings = pluginHost.storage.settings();
            const limit = parseLimit(args.limit);
            const rows = (
                await discoverStorage(pluginHost.storageProviders, settings.mounts, {
                    plugin: args.plugin,
                    account: args.account,
                    search: args.search,
                    limit,
                })
            ).filter((r) =>
                args.available
                    ? r.status === "available"
                    : args.configured
                      ? r.status !== "available"
                      : true,
            );
            if (args.json) {
                process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
                return;
            }
            const providers = pluginHost.storageProviders.pluginIds();
            writeMarkdown(renderList(rows, providers, settings.allowWrite, limit), {
                raw: args.raw === true,
            });
        },
    });
}

/** Markdown for `storage list`. */
export function renderList(
    rows: readonly DiscoveryRow[],
    providers: readonly string[],
    allowWrite: boolean,
    limit: number,
): string {
    const parts = [
        "# storage",
        "",
        providers.length > 0
            ? `Queried live: ${providers.join(", ")} (up to ${limit} drives per account).`
            : "No storage provider is installed or enabled.",
        "",
    ];
    if (rows.length === 0) {
        parts.push("Nothing to show.", "");
        return parts.join("\n");
    }
    parts.push(
        markdownTable(
            ["STATUS", "ALIAS", "PLUGIN", "ACCOUNT", "DRIVE", "SELECTOR", "KIND", "ACCESS"],
            rows.map((r) => [
                r.status,
                r.alias ?? "",
                r.plugin,
                r.account,
                r.driveName ?? "",
                r.selector ??
                    (r.status === "error" || r.status === "auth-expired" ? "" : "(primary)"),
                r.kind ?? "",
                r.access === "readwrite" && !allowWrite ? "readwrite (inactive)" : (r.access ?? ""),
            ]),
        ),
        "",
    );
    const problems = rows.filter((r) => r.note !== null);
    if (problems.length > 0) {
        parts.push(
            "## Problems",
            "",
            ...problems.map(
                (r) =>
                    `- ${r.alias !== null ? `\`${r.alias}\`` : `${r.plugin} ${r.account}`}: ${r.note}`,
            ),
            "",
        );
    }
    const available = rows.filter((r) => r.status === "available");
    if (available.length > 0) {
        parts.push(
            "## Add an available drive",
            "",
            ...available.map((r) => `- ${r.driveName}: \`${addCommandFor(r)}\``),
            "",
        );
    }
    if (!allowWrite && rows.some((r) => r.access === "readwrite")) {
        parts.push(
            "`storage.allowWrite` is false: every mount is read-only until you turn it on.",
            "",
        );
    }
    return parts.join("\n");
}

// ---- add / remove ------------------------------------------------------------

function addCommand(pluginHost: PluginHost) {
    return defineCommand({
        meta: {
            name: "add",
            description:
                "Add a mount to config.yml (checks the login and drive live). Without arguments: pick from the available drives.",
        },
        args: {
            plugin: {
                type: "positional",
                required: false,
                description: "Provider plugin id, e.g. ms365.",
            },
            account: {
                type: "positional",
                required: false,
                description: "Account key (e-mail / UPN).",
            },
            as: { type: "string", description: "Mount alias." },
            drive: { type: "string", description: "Drive selector (see `familiar storage list`)." },
            access: { type: "string", description: "read (default) or readwrite." },
            "write-root": {
                type: "string",
                description:
                    'Writable path prefix (repeatable or comma-separated; default "/Familiar").',
            },
            "dry-run": {
                type: "boolean",
                description: "Print the block without writing it.",
                default: false,
            },
            raw: RAW_ARG,
        },
        async run({ args, rawArgs }) {
            pluginHost.prepareAll();
            const boot = bootstrap();
            const settings = pluginHost.storage.settings();
            let plugin = args.plugin;
            let account = args.account;
            let drive: string | null = args.drive ?? null;
            let alias = args.as;
            let access = args.access;
            if (plugin === undefined) {
                const picked = await pickAvailableDrive(pluginHost);
                if (!picked) {
                    return;
                }
                plugin = picked.plugin;
                account = picked.account;
                drive = picked.selector;
                alias = await input({
                    message: "Mount alias:",
                    validate: (v) => aliasProblem(v, settings) ?? true,
                });
                access = await select({
                    message: "Access:",
                    choices: [
                        { name: "read (recommended)", value: "read" },
                        { name: "readwrite (inside write roots only)", value: "readwrite" },
                    ],
                });
            }
            if (account === undefined || alias === undefined) {
                fail(
                    "usage: familiar storage add <plugin> <account> --as <alias> [--drive <selector>] [--access read|readwrite] [--write-root <path>]…",
                );
                return;
            }
            const problem = aliasProblem(alias, settings);
            if (problem) {
                fail(problem);
                return;
            }
            if (access !== undefined && access !== "read" && access !== "readwrite") {
                fail(`--access must be "read" or "readwrite" (got "${access}")`);
                return;
            }
            const writeRoots = collectWriteRoots(rawArgs);
            for (const root of writeRoots) {
                if (!root.startsWith("/")) {
                    fail(`--write-root must be an absolute path (got "${root}")`);
                    return;
                }
            }
            const provider = pluginHost.storageProviders.byPluginId(plugin);
            if (!provider) {
                const known = pluginHost.storageProviders.pluginIds().join(", ") || "none";
                fail(`plugin "${plugin}" provides no storage (installed: ${known})`);
                return;
            }
            const accountKey = account.toLowerCase();
            const accounts = await provider.listAccounts();
            if (!accounts.includes(accountKey)) {
                fail(
                    `no ${plugin} login for ${account} — run \`${provider.loginCommand(accountKey)}\` first`,
                );
                return;
            }
            let driveName: string;
            try {
                driveName = (await provider.openDrive(accountKey, drive)).name;
            } catch (err) {
                fail(
                    `drive ${drive ?? "(primary)"} not reachable: ${err instanceof Error ? err.message : String(err)}`,
                );
                return;
            }
            const effectiveAccess = access === "readwrite" ? "readwrite" : "read";
            const mount: Record<string, unknown> = { plugin, account: accountKey };
            if (drive !== null) {
                mount.drive = drive;
            }
            mount.access = effectiveAccess;
            if (effectiveAccess === "readwrite" || writeRoots.length > 0) {
                mount.writeRoots =
                    writeRoots.length > 0
                        ? [...new Set(writeRoots.map(normalizeRoot))]
                        : [...DEFAULT_WRITE_ROOTS];
            }
            const block = stringify({ [alias]: mount }, { lineWidth: 0 });
            const notes = [`Drive: ${driveName}`];
            if (effectiveAccess === "readwrite" && !settings.allowWrite) {
                notes.push(
                    "Note: `storage.allowWrite` is false, so this mount stays read-only until you set it to true.",
                );
            }
            if (args["dry-run"]) {
                writeMarkdown(
                    `# storage add (dry run)\n\n\`\`\`yaml\n${block}\`\`\`\n\n${notes.join("\n\n")}\n`,
                    {
                        raw: args.raw === true,
                    },
                );
                return;
            }
            const text = readFileSync(boot.configFile, "utf-8");
            writeConfigAtomically(
                boot.configFile,
                insertMapEntry(text, MOUNTS_PATH, alias, mount),
                () => assertLintClean(boot.configFile),
            );
            writeMarkdown(
                `# storage add\n\nAdded to \`storage.mounts\` in ${boot.configFile}:\n\n\`\`\`yaml\n${block}\`\`\`\n\n${notes.join("\n\n")}\n\nRestart the daemon to apply.\n`,
                { raw: args.raw === true },
            );
        },
    });
}

function removeCommand() {
    return defineCommand({
        meta: {
            name: "remove",
            description: "Remove a mount from config.yml (offline; keeps comments).",
        },
        args: {
            alias: { type: "positional", required: true, description: "Mount alias." },
            "dry-run": {
                type: "boolean",
                description: "Show what would be removed.",
                default: false,
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const boot = bootstrap();
            const text = readFileSync(boot.configFile, "utf-8");
            let updated: string;
            try {
                updated = removeMapEntry(text, MOUNTS_PATH, args.alias);
            } catch (err) {
                fail(err instanceof Error ? err.message : String(err));
                return;
            }
            if (args["dry-run"]) {
                writeMarkdown(
                    `# storage remove (dry run)\n\nWould remove mount \`${args.alias}\`.\n`,
                    {
                        raw: args.raw === true,
                    },
                );
                return;
            }
            writeConfigAtomically(boot.configFile, updated, () => assertLintClean(boot.configFile));
            writeMarkdown(
                `# storage remove\n\nRemoved mount \`${args.alias}\`. Restart the daemon to apply.\n`,
                {
                    raw: args.raw === true,
                },
            );
        },
    });
}

// ---- lint ------------------------------------------------------------------

function lintCommand(pluginHost: PluginHost) {
    return defineCommand({
        meta: {
            name: "lint",
            description:
                "Validate the storage config. Static checks by default; --online also checks logins, drives and write roots (queries providers).",
        },
        args: {
            online: {
                type: "boolean",
                description: "Also run the provider checks.",
                default: false,
            },
            fix: {
                type: "boolean",
                description:
                    "Apply safe fixes: normalize write roots; with --online, create missing write-root folders.",
                default: false,
            },
            strict: { type: "boolean", description: "Treat warnings as errors.", default: false },
            json: JSON_ARG,
            raw: RAW_ARG,
        },
        async run({ args }) {
            pluginHost.prepareAll();
            const boot = bootstrap();
            const changes: string[] = [];
            if (args.fix) {
                changes.push(
                    ...applyNormalizations(boot.configFile, readStorageGroup(boot.configFile)),
                );
            }
            // Lint the (possibly just fixed) file.
            const findings: StorageLintFinding[] = lintStorageStatic(
                readStorageGroup(boot.configFile),
                {
                    knownPlugins: pluginHost.storageProviders.pluginIds(),
                },
            );
            if (args.online) {
                const settings = parseStorageSettings(readStorageGroup(boot.configFile));
                const online = await lintStorageOnline(
                    pluginHost.storage,
                    pluginHost.storageProviders,
                    settings,
                );
                findings.push(...online.findings);
                if (args.fix) {
                    for (const missing of online.missingRoots) {
                        changes.push(`create folder ${missing.alias}:${missing.root}`);
                        await pluginHost.storage.createFolderPathAsUser(
                            missing.alias,
                            missing.root,
                        );
                    }
                }
            }
            const exitCode = lintExitCode(findings, args.strict === true);
            if (args.json) {
                process.stdout.write(
                    `${JSON.stringify({ findings, changes, exitCode }, null, 2)}\n`,
                );
            } else {
                writeMarkdown(renderFindings(findings, changes, args.online === true), {
                    raw: args.raw === true,
                });
            }
            process.exitCode = exitCode;
        },
    });
}

/**
 * Exit code for a lint run: 0 clean / info only, 1 warnings, 2 errors
 * (warnings count as errors with `strict`).
 */
export function lintExitCode(findings: readonly StorageLintFinding[], strict: boolean): number {
    if (findings.some((f) => f.severity === "error")) {
        return 2;
    }
    if (findings.some((f) => f.severity === "warning")) {
        return strict ? 2 : 1;
    }
    return 0;
}

/** Markdown for `storage lint`: one finding per line plus a summary. */
export function renderFindings(
    findings: readonly StorageLintFinding[],
    changes: readonly string[],
    online: boolean,
): string {
    const count = (s: StorageLintFinding["severity"]) =>
        findings.filter((f) => f.severity === s).length;
    const parts = [
        "# storage lint",
        "",
        online
            ? "Static and online checks."
            : "Static checks only (add --online to query providers).",
        "",
    ];
    if (changes.length > 0) {
        parts.push("## Applied fixes", "", ...changes.map((c) => `- ${c}`), "");
    }
    if (findings.length > 0) {
        parts.push(
            ...findings.map((f) => `- ${f.severity} ${f.alias ?? "storage"}: ${f.message}`),
            "",
        );
    }
    parts.push(
        `${count("error")} errors, ${count("warning")} warnings, ${count("info")} infos.`,
        "",
    );
    return parts.join("\n");
}

/** Rewrite non-normalized write roots. @returns Human-readable change descriptions. */
function applyNormalizations(configFile: string, rawGroup: unknown): string[] {
    const normalizations = writeRootNormalizations(rawGroup);
    const changes: string[] = [];
    for (const [alias, roots] of normalizations) {
        changes.push(`normalize ${alias}.writeRoots → ${JSON.stringify(roots)}`);
        const text = readFileSync(configFile, "utf-8");
        writeConfigAtomically(
            configFile,
            setConfigValue(text, `storage.mounts.${alias}.writeRoots`, roots),
            () => assertLintClean(configFile),
        );
    }
    return changes;
}

// ---- helpers -----------------------------------------------------------------

/** Interactive picker over `available` drives. @returns The chosen row, or `null` when there is none. */
async function pickAvailableDrive(pluginHost: PluginHost): Promise<DiscoveryRow | null> {
    const rows = (
        await discoverStorage(pluginHost.storageProviders, pluginHost.storage.settings().mounts, {
            limit: DEFAULT_DISCOVERY_LIMIT,
        })
    ).filter((r) => r.status === "available");
    if (rows.length === 0) {
        writeMarkdown(
            "No unconfigured drives found. Log in to a provider first, or check `familiar storage list`.\n",
        );
        return null;
    }
    return select({
        message: "Drive to mount:",
        choices: rows.map((r) => ({
            name: `${r.plugin} · ${r.account} · ${r.driveName}${r.selector ? ` (${r.selector})` : ""}`,
            value: r,
        })),
    });
}

/** @returns Why `alias` cannot be used, or `null`. */
function aliasProblem(
    alias: string,
    settings: ReturnType<PluginHost["storage"]["settings"]>,
): string | null {
    if (!isValidAlias(alias)) {
        return `alias "${alias}" must not be empty or contain ":", "#", "/" or whitespace`;
    }
    if (settings.mounts.some((m) => m.alias.toLowerCase() === alias.toLowerCase())) {
        return `alias "${alias}" is already in use`;
    }
    return null;
}

/**
 * Every `--write-root` value from argv (citty keeps only the last of a
 * repeated flag), splitting comma-separated lists.
 */
export function collectWriteRoots(rawArgs: readonly string[]): string[] {
    const roots: string[] = [];
    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i] as string;
        let value: string | undefined;
        if (arg === "--write-root" || arg === "--writeRoot") {
            value = rawArgs[i + 1];
            i++;
        } else if (arg.startsWith("--write-root=")) {
            value = arg.slice("--write-root=".length);
        }
        if (value !== undefined) {
            roots.push(
                ...value
                    .split(",")
                    .map((v) => v.trim())
                    .filter((v) => v.length > 0),
            );
        }
    }
    return roots;
}

/** Raw `storage` group of the config file (undefined when absent). */
function readStorageGroup(configFile: string): unknown {
    const root = parse(readFileSync(configFile, "utf-8")) as Record<string, unknown> | null;
    return root?.storage;
}

/**
 * Throw when the (just written) config has lint errors, so the caller
 * rolls back.
 */
function assertLintClean(configFile: string): void {
    const result = lintConfigFile(configFile);
    if (!result.ok) {
        throw new Error(
            `config lint failed after the edit (rolled back):\n  - ${result.errors.join("\n  - ")}`,
        );
    }
}

function parseLimit(value: string | undefined): number {
    if (value === undefined) {
        return DEFAULT_DISCOVERY_LIMIT;
    }
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--limit must be a positive integer (got "${value}")`);
    }
    return n;
}

/** Report a usage error and set exit code 1. */
function fail(message: string): void {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}
