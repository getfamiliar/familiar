import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, type Logger, prettyStdoutStream } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { type Bootstrap, bootstrap } from "../Bootstrap.js";
import { pluginSources } from "../plugins/PluginLoader.js";

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

/** Run npm in the project folder with inherited stdio. */
function runNpm(boot: Bootstrap, args: readonly string[]): void {
    execFileSync("npm", [...args], { cwd: boot.homeDir, stdio: "inherit" });
}

/** Make a citty logger for the plugin subcommands. */
function makeLog(): Logger {
    return createLogger({ component: "plugin", level: "info", streams: [prettyStdoutStream()] });
}

/**
 * `familiar plugin add <pkg>` — install a plugin package into the project
 * and add it to `config/plugins` so it loads on next start. A package
 * that's already a prebundled core plugin is installed as needed but not
 * appended (bundled plugins load automatically).
 */
const addCommand = defineCommand({
    meta: { name: "add", description: "Install a plugin and enable it in config/plugins" },
    args: { pkg: { type: "positional", required: true, description: "npm package name" } },
    run({ args }) {
        const boot = bootstrap();
        const log = makeLog();
        const pkg = args.pkg;
        runNpm(boot, ["install", pkg]);

        const { bundled } = pluginSources(boot, log);
        if (bundled.includes(pkg)) {
            log.info(`"${pkg}" is a prebundled core plugin; installed but not added to config/plugins`);
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
    },
});

/**
 * `familiar plugin remove <pkg>` — remove a plugin from `config/plugins`
 * and uninstall the package. Refuses to remove a prebundled core plugin
 * (those are managed by the `familiar` meta-package, not the whitelist).
 */
const removeCommand = defineCommand({
    meta: { name: "remove", description: "Disable a plugin (drop from config/plugins) and uninstall it" },
    args: { pkg: { type: "positional", required: true, description: "npm package name" } },
    run({ args }) {
        const boot = bootstrap();
        const log = makeLog();
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
        runNpm(boot, ["uninstall", pkg]);
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
