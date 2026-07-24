import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger, type Logger, type LogLevel, prettyStdoutStream } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import ora from "ora";
import { type Bootstrap, bootstrap } from "../Bootstrap.js";
import {
    isFamiliarPlugin,
    pluginSources,
    resolvePluginPackageJson,
} from "../plugins/PluginLoader.js";

/** Absolute path to the `config/plugins` whitelist for a home dir. */
function whitelistPath(boot: Bootstrap): string {
    return join(boot.homeDir, "config", "plugins");
}

/** Read the whitelist file's raw lines (empty array when absent). */
function readWhitelistLines(boot: Bootstrap): string[] {
    const path = whitelistPath(boot);
    if (!existsSync(path)) {
        return [];
    }
    return readFileSync(path, "utf8").split("\n");
}

/** The non-comment, non-blank package specifiers currently whitelisted. */
function whitelistedPackages(lines: readonly string[]): string[] {
    return lines
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Run npm in the project folder.
 *
 * npm is chatty, and for a normal user its raw output is noise. So by default
 * we hide it behind an `ora` spinner and *capture* stdout+stderr; the captured
 * text is printed in full only when npm exits non-zero, so failures stay
 * diagnosable. With `verbose` we stream npm's stdio live instead (no spinner).
 *
 * This has to be async: `execFileSync` would block the event loop and freeze
 * the spinner mid-frame — a `spawn` wrapped in a promise keeps the loop free so
 * the spinner animates while npm runs.
 *
 * @param boot Bootstrap context (provides the project `homeDir` as npm's cwd).
 * @param args npm argv, e.g. `["install", pkg]`.
 * @param opts `verbose` streams live; `label` is the spinner text.
 * @throws When npm exits non-zero or fails to spawn (after dumping captured output).
 */
async function runNpm(
    boot: Bootstrap,
    args: readonly string[],
    opts: { readonly verbose: boolean; readonly label: string },
): Promise<void> {
    if (opts.verbose) {
        await new Promise<void>((resolve, reject) => {
            const child = spawn("npm", [...args], { cwd: boot.homeDir, stdio: "inherit" });
            child.on("error", reject);
            child.on("close", (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(`npm ${args[0]} failed (exit ${code})`));
            });
        });
        return;
    }

    const spinner = ora(opts.label).start();
    const captured: Buffer[] = [];
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn("npm", [...args], {
                cwd: boot.homeDir,
                stdio: ["ignore", "pipe", "pipe"],
            });
            // Both streams land in one ordered buffer — arrival order is a
            // good-enough interleave for a diagnostic dump.
            child.stdout.on("data", (chunk: Buffer) => captured.push(chunk));
            child.stderr.on("data", (chunk: Buffer) => captured.push(chunk));
            child.on("error", reject);
            child.on("close", (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(`npm ${args[0]} failed (exit ${code})`));
            });
        });
    } catch (error) {
        spinner.fail(opts.label);
        process.stderr.write(Buffer.concat(captured).toString("utf8"));
        throw error;
    }
    spinner.stop();
}

/** Make a citty logger for the plugin subcommands; `verbose` enables debug output. */
function makeLog(verbose = false): Logger {
    const level: LogLevel = verbose ? "debug" : "info";
    return createLogger({ component: "plugin", level, streams: [prettyStdoutStream()] });
}

/**
 * `familiar plugin add <pkg>` — install a plugin package into the project
 * and add it to `config/plugins` so it loads on next start. A package
 * that's already a prebundled core plugin is installed as needed but not
 * appended (bundled plugins load automatically).
 */
const addCommand = defineCommand({
    meta: { name: "add", description: "Install a plugin and enable it in config/plugins" },
    args: {
        pkg: { type: "positional", required: true, description: "npm package name" },
        verbose: {
            type: "boolean",
            alias: "v",
            description: "Stream npm's output live instead of a spinner.",
            default: false,
        },
    },
    async run({ args }) {
        const boot = bootstrap();
        const verbose = Boolean(args.verbose);
        const log = makeLog(verbose);
        const pkg = args.pkg;
        try {
            await runNpm(boot, ["install", pkg], { verbose, label: `Installing "${pkg}"…` });

            // Confirm the installed package actually declares itself a Familiar
            // plugin *before* whitelisting it — a statically-read check that never
            // imports the package, so a hijacking module top-level can't run. If it
            // isn't a plugin, roll the install back and fail loudly.
            const req = createRequire(pathToFileURL(join(boot.homeDir, "package.json")));
            if (!isFamiliarPlugin(resolvePluginPackageJson(pkg, req))) {
                await runNpm(boot, ["uninstall", pkg], {
                    verbose,
                    label: `Uninstalling "${pkg}"…`,
                });
                const isBareName = !pkg.startsWith("@") && !pkg.includes("/");
                const hint = isBareName
                    ? ` Did you mean "@getfamiliar/plugin-${pkg}"? Plugins must be added by their full package name.`
                    : "";
                log.error(
                    `"${pkg}" is not a Familiar plugin (missing \`familiar.plugin\` in its package.json) — uninstalled it, nothing was enabled.${hint}`,
                );
                process.exit(1);
            }

            const { bundled } = pluginSources(boot, log);
            if (bundled.includes(pkg)) {
                log.info(
                    `"${pkg}" is a prebundled core plugin; installed but not added to config/plugins`,
                );
                return;
            }
            const lines = readWhitelistLines(boot);
            if (whitelistedPackages(lines).includes(pkg)) {
                log.info(`"${pkg}" is already listed in config/plugins`);
                return;
            }
            const body = lines.join("\n").replace(/\n+$/, "");
            const next = `${body.length > 0 ? `${body}\n` : ""}${pkg}\n`;
            writeFileSync(whitelistPath(boot), next);
            log.info(`added "${pkg}" to config/plugins — it will load on next \`familiar start\``);
        } catch (error) {
            // runNpm has already dumped npm's full output; log a clean one-line
            // summary and exit non-zero instead of letting citty print a stack.
            log.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    },
});

/**
 * `familiar plugin remove <pkg>` — remove a plugin from `config/plugins`
 * and uninstall the package. Refuses to remove a prebundled core plugin
 * (those are managed by the `@getfamiliar/cli` meta-package, not the whitelist).
 */
const removeCommand = defineCommand({
    meta: {
        name: "remove",
        description: "Disable a plugin (drop from config/plugins) and uninstall it",
    },
    args: {
        pkg: { type: "positional", required: true, description: "npm package name" },
        verbose: {
            type: "boolean",
            alias: "v",
            description: "Stream npm's output live instead of a spinner.",
            default: false,
        },
    },
    async run({ args }) {
        const boot = bootstrap();
        const verbose = Boolean(args.verbose);
        const log = makeLog(verbose);
        const pkg = args.pkg;

        const { bundled } = pluginSources(boot, log);
        if (bundled.includes(pkg)) {
            log.warn(`"${pkg}" is a prebundled core plugin and can't be removed via the whitelist`);
            return;
        }
        const lines = readWhitelistLines(boot);
        const kept = lines.filter((line) => line.trim() !== pkg);
        if (kept.length !== lines.length) {
            writeFileSync(whitelistPath(boot), kept.join("\n"));
            log.info(`removed "${pkg}" from config/plugins`);
        }
        try {
            await runNpm(boot, ["uninstall", pkg], { verbose, label: `Uninstalling "${pkg}"…` });
        } catch (error) {
            // runNpm has already dumped npm's full output; log a clean one-line
            // summary and exit non-zero instead of letting citty print a stack.
            log.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    },
});

/**
 * `familiar plugin list` — print the prebundled core plugins and the
 * whitelisted optional/third-party plugins for this project.
 */
const listCommand = defineCommand({
    meta: { name: "list", description: "List active plugins (bundled core + whitelisted)" },
    run() {
        const boot = bootstrap();
        const { bundled, whitelisted } = pluginSources(boot, makeLog());
        process.stdout.write("Bundled (core, always on):\n");
        for (const name of bundled.length > 0 ? bundled : ["(none)"]) {
            process.stdout.write(`  ${name}\n`);
        }
        process.stdout.write("Whitelisted (config/plugins):\n");
        for (const name of whitelisted.length > 0 ? whitelisted : ["(none)"]) {
            process.stdout.write(`  ${name}\n`);
        }
    },
});

/** Parent `familiar plugin` command grouping add/remove/list. */
export const pluginCommand = defineCommand({
    meta: { name: "plugin", description: "Manage installed plugins (add, remove, list)" },
    subCommands: {
        add: addCommand,
        remove: removeCommand,
        list: listCommand,
    },
});
