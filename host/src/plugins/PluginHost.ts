import { cpSync, existsSync } from "node:fs";
import { defineCommand } from "citty";
import type { AnyCommandDef, HostContext, PostgresConnection } from "effective-assistant-shared";
import type { Bootstrap } from "../Bootstrap";
import { PostgresContainer } from "../db/PostgresContainer";
import { HostContextImpl } from "./HostContextImpl";
import { plugins } from "./Registry";

/**
 * Loader and lifecycle owner for plugins inside the host process.
 *
 * One instance per CLI invocation. Lazily opens a postgres connection
 * on the first plugin call that needs it (e.g. `ctx.events.emit`), so
 * `--help` and other introspective paths stay free of side effects.
 *
 * Plugin commands are wrapped at registration time with a try/finally
 * that closes the connection after `run()` returns. Without this, a
 * one-shot CLI command would hang on the still-open postgres pool.
 */
export class PluginHost {
    private readonly boot: Bootstrap;
    private connection: PostgresConnection | undefined;

    constructor(boot: Bootstrap) {
        this.boot = boot;
    }

    /**
     * Build the citty `subCommands` map contributed by all plugins.
     * Each plugin's commands are nested under `subCommands[plugin.id]`,
     * so users invoke them as `cli.sh <plugin-id> <subcommand>`.
     *
     * @throws If two plugins declare the same id, or if a plugin
     *   command is missing `meta.name`.
     */
    buildSubCommands(): Record<string, AnyCommandDef> {
        const ctx = this.context();
        const map: Record<string, AnyCommandDef> = {};
        for (const plugin of plugins) {
            if (map[plugin.id]) {
                throw new Error(`Duplicate plugin id: ${plugin.id}`);
            }
            if (!plugin.host?.commands) {
                continue;
            }
            const cmds = plugin.host.commands(ctx).map((cmd) => this.wrapForExit(cmd));
            map[plugin.id] = pluginRoot(plugin.id, cmds);
        }
        return map;
    }

    /**
     * Copy any workspace-template files contributed by plugins into
     * the workspace directory, skipping files that already exist.
     * Idempotent and safe to call on every daemon start.
     *
     * Diff/merge on plugin updates (when a plugin ships a newer
     * default than the user's local copy) is the open question
     * already in CLAUDE.md and is not handled here.
     */
    installWorkspaceTemplates(): void {
        for (const plugin of plugins) {
            if (!plugin.workspaceTemplate) {
                continue;
            }
            if (!existsSync(plugin.workspaceTemplate)) {
                continue;
            }
            cpSync(plugin.workspaceTemplate, this.boot.workspaceDir, {
                recursive: true,
                force: false,
                errorOnExist: false,
            });
        }
    }

    /**
     * Await each plugin's `start(ctx)` hook in registration order.
     * Used during daemon boot. Failures bubble up — the daemon
     * refuses to start if any plugin daemon fails to initialize.
     */
    async startDaemons(): Promise<void> {
        const ctx = this.context();
        for (const plugin of plugins) {
            if (!plugin.host?.start) {
                continue;
            }
            await plugin.host.start(ctx);
        }
    }

    /** Close the underlying postgres connection, if it was opened. */
    async close(): Promise<void> {
        if (!this.connection) {
            return;
        }
        const conn = this.connection;
        this.connection = undefined;
        await conn.close();
    }

    /**
     * Build the {@link HostContext} that every plugin lifecycle
     * method receives. The contract — what plugins are allowed to do
     * — lives in {@link HostContextImpl}, not in this class.
     */
    private context(): HostContext {
        return new HostContextImpl({
            ensureConnection: () => this.ensureConnection(),
            defaultChatChannelId: () => this.boot.requireEnv("DEFAULT_CHAT_CHANNEL_ID"),
            log: (message) => {
                console.error(`[plugin] ${message}`);
            },
        });
    }

    /**
     * Open the postgres connection on demand. Reads
     * `POSTGRES_PASSWORD` only when first called, so commands that
     * don't touch the bus don't trigger env validation.
     */
    private async ensureConnection(): Promise<PostgresConnection> {
        if (this.connection) {
            return this.connection;
        }
        const password = this.boot.requireEnv("POSTGRES_PASSWORD");
        const postgres = new PostgresContainer({
            dataPath: this.boot.dataDir,
            portFilePath: this.boot.postgresPortFile,
            password,
        });
        this.connection = postgres.getConnection();
        return this.connection;
    }

    /**
     * Wrap a plugin command's `run` so the host's connection is
     * closed after the command returns. Without this the postgres
     * pool keeps the event loop alive and the CLI process hangs.
     */
    private wrapForExit(cmd: AnyCommandDef): AnyCommandDef {
        const original = cmd.run;
        if (!original) {
            return cmd;
        }
        return defineCommand({
            ...cmd,
            run: async (ctx) => {
                try {
                    return await (original as (c: typeof ctx) => unknown)(ctx);
                } finally {
                    await this.close();
                }
            },
        });
    }
}

/**
 * Wrap a plugin's commands in a parent command keyed by the plugin's
 * id, so they appear under `cli.sh <plugin-id> ...` in the CLI tree.
 */
function pluginRoot(id: string, cmds: readonly AnyCommandDef[]): AnyCommandDef {
    const subCommands: Record<string, AnyCommandDef> = {};
    for (const cmd of cmds) {
        const meta = cmd.meta;
        if (!meta || typeof meta !== "object") {
            throw new Error(`Plugin "${id}" contributed a command with non-static meta`);
        }
        const name = (meta as { name?: string }).name;
        if (!name) {
            throw new Error(`Plugin "${id}" contributed a command without meta.name`);
        }
        if (subCommands[name]) {
            throw new Error(`Plugin "${id}" contributed two commands named "${name}"`);
        }
        subCommands[name] = cmd;
    }
    return defineCommand({
        meta: { name: id, description: `Commands provided by the ${id} plugin` },
        subCommands,
    });
}
