import { createLogger, jsonStdoutStream, prettyStdoutStream } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { lintConfigFile } from "../config/ConfigLinter.js";
import { HostConfigService } from "../config/ConfigService.js";
import { validateConfiguredProviders } from "../models/ProviderResolution.js";
import { PluginHost } from "../plugins/PluginHost.js";

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
        description: "Inspect and validate config/config.yml.",
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
    const pluginHost = new PluginHost(boot, log, config);
    await pluginHost.modelMetadata.refreshIfStale(ONE_DAY_MS);
    return validateConfiguredProviders(keys, (key) => pluginHost.modelMetadata.lookupProvider(key));
}
