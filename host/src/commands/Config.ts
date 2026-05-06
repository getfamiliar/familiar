import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { lintConfigFile } from "../config/ConfigLinter.js";

/**
 * `ea config` — root for config-related subcommands. Today only
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
                    "Validate config/config.yml: file is readable, parses, and contains the platform minimum.",
            },
            run() {
                const boot = bootstrap();
                const result = lintConfigFile(boot.configFile);
                for (const w of result.warnings) {
                    process.stdout.write(`warning: ${w}\n`);
                }
                if (!result.ok) {
                    for (const e of result.errors) {
                        process.stderr.write(`error: ${e}\n`);
                    }
                    process.exit(1);
                }
                process.stdout.write(`config/config.yml: ok\n`);
            },
        }),
    },
});
