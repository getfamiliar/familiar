import { createLogger, jsonStdoutStream, prettyStdoutStream } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { lintConfigFile } from "../config/ConfigLinter.js";
import { HostConfigService } from "../config/ConfigService.js";
import { DEFAULT_PYTHON_PACKAGES } from "../container-runner/AgentContainer.js";
import { checkPackagesOnPyPI } from "../container-runner/PythonPackages.js";
import { validateConfiguredProviders } from "../models/ProviderResolution.js";
import { PluginHost } from "../plugins/PluginHost.js";
import { loadPlugins } from "../plugins/PluginLoader.js";

/** 24 hours in milliseconds — staleness window for the models.dev cache. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `cli.sh config` — root for config-related subcommands. Today only
 * `lint` is exposed; future additions (`get`, `set`, …) live under
 * the same root so the CLI surface stays organised.
 */
export const configCommand = defineCommand({
    meta: {
        name: "config",
        description: "Inspect and validate the system configuration.",
    },
    subCommands: {
        lint: defineCommand({
            meta: {
                name: "lint",
                description:
                    "Validate config/config.yml: structure, the platform minimum, and that every inference provider resolves.",
            },
            async run() {
                const boot = bootstrap();
                const result = lintConfigFile(boot.configFile);
                for (const w of result.warnings) {
                    process.stdout.write(`warning: ${w}\n`);
                }
                const errors = [...result.errors];

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
                    // the next `./cli.sh start` image build. Network-only;
                    // an unreachable PyPI degrades to a warning.
                    try {
                        const py = await validatePythonPackages(boot);
                        for (const w of py.warnings) {
                            process.stdout.write(`warning: ${w}\n`);
                        }
                        errors.push(...py.errors);
                    } catch (err) {
                        process.stdout.write(
                            `warning: could not validate python.packages: ${err instanceof Error ? err.message : String(err)}\n`,
                        );
                    }
                }

                if (errors.length > 0) {
                    for (const e of errors) {
                        process.stderr.write(`error: ${e}\n`);
                    }
                    process.exit(1);
                }
                process.stdout.write(`config/config.yml: ok\n`);
            },
        }),
    },
});

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
 * Prints a `python.packages: <N> ok` summary when nothing is wrong.
 *
 * @param boot Bootstrap paths (for the config file).
 * @returns Error and warning strings for the caller to aggregate.
 */
async function validatePythonPackages(
    boot: ReturnType<typeof bootstrap>,
): Promise<{ errors: string[]; warnings: string[] }> {
    const config = new HostConfigService(boot.configFile);
    const packages = config.getStringList("python.packages", DEFAULT_PYTHON_PACKAGES);
    if (packages.length === 0) {
        return { errors: [], warnings: [] };
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
    if (errors.length === 0) {
        process.stdout.write(`python.packages: ${okCount} ok\n`);
    }
    return { errors, warnings };
}
