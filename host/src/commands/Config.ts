import { readFileSync } from "node:fs";
import {
    createLogger,
    jsonStdoutStream,
    prettyStdoutStream,
    writeMarkdown,
} from "@getfamiliar/shared";
import { confirm, input, password } from "@inquirer/prompts";
import { defineCommand } from "citty";
import { parse } from "yaml";
import { bootstrap } from "../Bootstrap.js";
import { isSecretConfigKey } from "../config/SecretKeys.js";
import { DEFAULT_PYTHON_PACKAGES } from "../container-bridge/AgentContainer.js";
import { checkPackagesOnPyPI } from "../container-bridge/PythonPackages.js";
import { validateConfiguredProviders } from "../models/ProviderResolution.js";
import { PluginHost } from "../plugins/PluginHost.js";
import { loadPlugins } from "../plugins/PluginLoader.js";
import { renderReloadReport } from "../reload/DaemonReloader.js";
import { requestDaemonReload } from "../reload/ReloadClient.js";
import { setConfigValue, writeConfigAtomically } from "../utils/ConfigDocument.js";
import { lintConfigFile } from "../utils/ConfigLinter.js";
import { HostConfigService } from "../utils/ConfigService.js";

/** 24 hours in milliseconds — staleness window for the models.dev cache. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Shared `--raw` flag of the markdown-reporting subcommands. */
const RAW_ARG = {
    type: "boolean",
    description:
        "Skip terminal styling and emit the raw markdown verbatim. Useful for piping into a file or a markdown viewer.",
    default: false,
} as const;

/**
 * `familiar config` — root for config-related subcommands: `lint`
 * validates the file, `set` edits one value, `reload` applies
 * `config.yml` and `mcp.yml` to the running daemon.
 */
export const configCommand = defineCommand({
    meta: {
        name: "config",
        description: "Inspect, edit, validate and reload the system configuration.",
    },
    subCommands: {
        reload: defineCommand({
            meta: {
                name: "reload",
                description:
                    "Apply config/config.yml and config/mcp.yml to the running daemon without restarting it.",
            },
            args: { raw: RAW_ARG },
            async run({ args }) {
                const boot = bootstrap();
                const report = await requestDaemonReload(boot);
                if (report === null) {
                    process.stderr.write(
                        "daemon is not running; the config is read on the next `familiar start`.\n",
                    );
                    process.exit(1);
                }
                writeMarkdown(renderReloadReport(report), { raw: args.raw === true });
                if (report.errors.length > 0) {
                    process.exit(1);
                }
            },
        }),
        set: defineCommand({
            meta: {
                name: "set",
                description:
                    "Set one value in config/config.yml (comments are kept). Secret keys and an omitted value are asked for interactively, with hidden input for secrets.",
            },
            args: {
                key: {
                    type: "positional",
                    description: 'Dotted path, e.g. "mail.allowSend" or "telegram.botToken".',
                    required: true,
                },
                value: {
                    type: "positional",
                    description:
                        "New value, parsed as YAML (true, 42, [a, b], …). Omit to be prompted. Secret values are always prompted and stored as strings.",
                    required: false,
                },
                raw: RAW_ARG,
            },
            async run({ args }) {
                const boot = bootstrap();
                const key = String(args.key);
                const isSecret = isSecretConfigKey(key);
                const value = await readValueArgument(key, isSecret, args.value);
                const text = readFileSync(boot.configFile, "utf-8");
                writeConfigAtomically(boot.configFile, setConfigValue(text, key, value), () => {
                    const lint = lintConfigFile(boot.configFile);
                    if (!lint.ok) {
                        throw new Error(
                            `config.yml would become invalid, change rolled back:\n  - ${lint.errors.join("\n  - ")}`,
                        );
                    }
                });
                process.stdout.write(`${key} written to config/config.yml.\n`);
                const shouldReload =
                    process.stdin.isTTY === true &&
                    (await confirm({
                        message: "Reload the running daemon now (if it is running)?",
                        default: true,
                    }));
                if (!shouldReload) {
                    process.stdout.write("Apply it later with `familiar config reload`.\n");
                    return;
                }
                const report = await requestDaemonReload(boot);
                if (report === null) {
                    process.stdout.write(
                        "Daemon not running; the value applies on the next start.\n",
                    );
                    return;
                }
                writeMarkdown(renderReloadReport(report), { raw: args.raw === true });
            },
        }),
        lint: defineCommand({
            meta: {
                name: "lint",
                description:
                    "Validate config/config.yml: structure, the platform minimum, and that every inference provider resolves.",
            },
            args: { raw: RAW_ARG },
            async run({ args }) {
                const boot = bootstrap();
                const result = lintConfigFile(boot.configFile);
                const warnings = [...result.warnings];
                const errors = [...result.errors];
                const infos: string[] = [];

                // Provider-resolution check: every inference.apiKeys key
                // must resolve to a known provider (models.dev catalogue
                // or a plugin descriptor) with a supported npm package.
                // Only attempted once the structural lint is clean, so a
                // malformed file doesn't trigger a confusing second wave.
                if (result.ok) {
                    try {
                        errors.push(...(await validateProviders(boot)));
                    } catch (err) {
                        errors.push(
                            `could not validate inference providers: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }

                    // Python-package existence check: each python.packages
                    // entry must resolve to a real distribution on PyPI, so
                    // a typo surfaces here instead of as a buried failure in
                    // the next `familiar start` image build. Network-only;
                    // an unreachable PyPI degrades to a warning.
                    try {
                        const py = await validatePythonPackages(boot);
                        warnings.push(...py.warnings);
                        errors.push(...py.errors);
                        if (py.errors.length === 0 && py.checkedCount > 0) {
                            infos.push(`python.packages: ${py.okCount} ok`);
                        }
                    } catch (err) {
                        warnings.push(
                            `could not validate python.packages: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                }

                writeMarkdown(renderLintReport(warnings, errors, infos), {
                    raw: args.raw === true,
                });
                if (errors.length > 0) {
                    process.exit(1);
                }
            },
        }),
    },
});

/**
 * Resolve the value for `config set`: secrets are always prompted with
 * hidden input (a value on the command line would land in the shell
 * history) and stored as strings; other keys use the argument, or a
 * prompt when omitted, parsed as YAML so `true` / `42` / `[a, b]` keep
 * their types.
 *
 * @param key The dotted path being set.
 * @param isSecret Whether the key names a secret.
 * @param argument The positional value, if given.
 * @returns The value to write.
 * @throws If a secret is passed on the command line or the input is empty.
 */
async function readValueArgument(
    key: string,
    isSecret: boolean,
    argument: unknown,
): Promise<unknown> {
    if (isSecret) {
        if (argument !== undefined) {
            throw new Error(
                `${key} is a secret — omit the value and enter it at the hidden prompt (keeps it out of the shell history).`,
            );
        }
        const secret = await password({ message: `${key}:`, mask: "*" });
        if (secret.length === 0) {
            throw new Error(`${key}: empty value, nothing written.`);
        }
        return secret;
    }
    const raw = argument !== undefined ? String(argument) : await input({ message: `${key}:` });
    return parse(raw) as unknown;
}

/**
 * Resolve every `inference.apiKeys` key against the models.dev catalogue
 * + plugin provider descriptors, returning a list of error strings
 * (empty when all resolve). Refreshes the models.dev cache when stale so
 * a fresh checkout still validates.
 */
async function validateProviders(boot: ReturnType<typeof bootstrap>): Promise<string[]> {
    const log = createLogger({
        component: "config-lint",
        level: "warn",
        streams: [process.stdout.isTTY ? prettyStdoutStream() : jsonStdoutStream()],
    });
    const config = new HostConfigService(boot.configFile);
    const apiKeys = config.getMapping("inference.apiKeys", {});
    const keys = Object.keys(apiKeys);
    if (keys.length === 0) {
        return [];
    }
    const plugins = await loadPlugins(boot, log);
    const pluginHost = new PluginHost(boot, log, plugins, config);
    await pluginHost.modelMetadata.refreshIfStale(ONE_DAY_MS);
    return validateConfiguredProviders(keys, (key) => pluginHost.modelMetadata.lookupProvider(key));
}

/**
 * Check every `python.packages` entry against PyPI. A `not-found` is an
 * error (a typo that would otherwise fail the image build); an
 * `unreachable` PyPI is a warning so `config lint` still passes offline.
 *
 * @param boot Bootstrap paths (for the config file).
 * @returns Errors, warnings, the count of packages checked, and how many resolved.
 */
async function validatePythonPackages(
    boot: ReturnType<typeof bootstrap>,
): Promise<{ errors: string[]; warnings: string[]; checkedCount: number; okCount: number }> {
    const config = new HostConfigService(boot.configFile);
    const packages = config.getStringList("python.packages", DEFAULT_PYTHON_PACKAGES);
    if (packages.length === 0) {
        return { errors: [], warnings: [], checkedCount: 0, okCount: 0 };
    }
    const checks = await checkPackagesOnPyPI(packages);
    const errors: string[] = [];
    const warnings: string[] = [];
    let okCount = 0;
    for (const check of checks) {
        if (check.status === "ok") {
            okCount += 1;
        } else if (check.status === "not-found") {
            errors.push(`python.packages: '${check.name}' not found on PyPI`);
        } else {
            warnings.push(`python.packages: could not reach PyPI to validate '${check.name}'`);
        }
    }
    return { errors, warnings, checkedCount: packages.length, okCount };
}

/**
 * Assemble the `config lint` result as a markdown report: a heading, an
 * optional warnings section, an optional errors section, and a final
 * status line. On errors the status reads as a failure; otherwise it
 * confirms the file is ok and lists any info lines (e.g. the
 * python-package summary).
 *
 * @param warnings Collected warning strings.
 * @param errors Collected error strings (non-empty means the lint failed).
 * @param infos Neutral summary lines shown only on success.
 * @returns Markdown source for {@link writeMarkdown}.
 */
function renderLintReport(
    warnings: readonly string[],
    errors: readonly string[],
    infos: readonly string[],
): string {
    const parts: string[] = ["# config lint\n"];
    if (warnings.length > 0) {
        parts.push(`## Warnings\n${warnings.map((w) => `- ${w}`).join("\n")}\n`);
    }
    if (errors.length > 0) {
        parts.push(`## Errors\n${errors.map((e) => `- ${e}`).join("\n")}\n`);
        parts.push(
            `**config/config.yml: ${errors.length} error${errors.length === 1 ? "" : "s"}** — see above.\n`,
        );
        return parts.join("\n");
    }
    for (const info of infos) {
        parts.push(`${info}\n`);
    }
    parts.push("`config/config.yml`: ok\n");
    return parts.join("\n");
}
