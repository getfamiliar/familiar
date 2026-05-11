import { cpSync, existsSync } from "node:fs";
import { defineCommand } from "citty";
import type {
    AnyCommandDef,
    ConfigService,
    HostContext,
    Logger,
    PostgresConnection,
} from "effective-assistant-shared";
import type { Bootstrap } from "../Bootstrap.js";
import { HostConfigService } from "../config/ConfigService.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { HostContextImpl } from "./HostContextImpl.js";
import { plugins } from "./Registry.js";

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
    private readonly log: Logger;
    private readonly config: ConfigService;
    private connection: PostgresConnection | undefined;
    private prepared = false;

    constructor(boot: Bootstrap, log: Logger, config?: ConfigService) {
        this.boot = boot;
        this.log = log;
        this.config = config ?? new HostConfigService(boot.configFile);
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
        const map: Record<string, AnyCommandDef> = {};
        for (const plugin of plugins) {
            if (map[plugin.id]) {
                throw new Error(`Duplicate plugin id: ${plugin.id}`);
            }
            const host = plugin.host;
            if (!host?.commands && !host?.main) {
                continue;
            }
            const ctx = this.context(plugin.id);
            const subCmds = host.commands?.(ctx).map((cmd) => this.wrapForExit(cmd)) ?? [];
            const main = host.main ? this.wrapForExit(host.main(ctx)) : undefined;
            map[plugin.id] = pluginRoot(plugin.id, subCmds, main);
        }
        return map;
    }

    /**
     * Seed the workspace from templates. Two layers, copied in this
     * order so the first writer wins on overlaps (`force: false`):
     *
     *   1. Global template at `data/workspace-template/` — versioned
     *      with the repo, authored by the user. Authoritative for
     *      anything it ships (e.g. `SOUL.md`, `CONTEXT.md`).
     *   2. Plugin templates contributed via `plugin.workspaceTemplate`
     *      — fill in topic-specific defaults the global template
     *      didn't already cover.
     *
     * Idempotent and safe to call on every daemon start. Diff/merge on
     * plugin updates (when a plugin ships a newer default than the
     * user's local copy) is the open question already in CLAUDE.md and
     * is not handled here.
     */
    installWorkspaceTemplates(): void {
        if (existsSync(this.boot.workspaceTemplateDir)) {
            cpSync(this.boot.workspaceTemplateDir, this.boot.workspaceDir, {
                recursive: true,
                force: false,
                errorOnExist: false,
            });
        }
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
     * Run every plugin's synchronous `prepare(ctx)` hook once per
     * process. Idempotent — repeated calls are no-ops, so individual
     * command entry points can call this without coordinating.
     *
     * Called automatically before any plugin one-shot command's
     * `run` (see {@link wrapForExit}) and explicitly by the daemon
     * `start` command before {@link startDaemons}. Not invoked from
     * introspective paths (`--help`, `config lint`) so a broken
     * config still lets the user inspect / lint.
     *
     * Plugin failures here propagate — `prepare` is supposed to be
     * trivial setup, so a throw means the plugin is misconfigured
     * and refusing to proceed is the right behavior.
     */
    prepareAll(): void {
        if (this.prepared) {
            return;
        }
        for (const plugin of plugins) {
            if (!plugin.host?.prepare) {
                continue;
            }
            plugin.host.prepare(this.context(plugin.id));
        }
        this.prepared = true;
    }

    /**
     * Await each plugin's `start(ctx)` hook in registration order.
     * Used during daemon boot. Failures bubble up — the daemon
     * refuses to start if any plugin daemon fails to initialize.
     *
     * Callers must invoke {@link prepareAll} first; daemon `start`
     * does this explicitly so cross-plugin module state populated in
     * `prepare` is reliably visible by the time any `start` body
     * runs.
     */
    async startDaemons(): Promise<void> {
        for (const plugin of plugins) {
            if (!plugin.host?.start) {
                continue;
            }
            await plugin.host.start(this.context(plugin.id));
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
    private context(pluginId: string): HostContext {
        return new HostContextImpl({
            ensureConnection: () => this.ensureConnection(),
            config: this.config,
            log: this.log.child({ component: `plugin:${pluginId}` }),
            dataDir: this.boot.dataDir,
        });
    }

    /**
     * Open the postgres connection on demand. Reads
     * `core.postgresPassword` from the config service only when first
     * called, so commands that don't touch the bus don't trigger
     * config validation. Public so daemon-owned host services
     * (cron scheduler, future approval gate, etc.) can share the same
     * pool plugins already use.
     */
    async ensureConnection(): Promise<PostgresConnection> {
        if (this.connection) {
            return this.connection;
        }
        const password = this.config.getString("core.postgresPassword");
        const postgres = new PostgresContainer({
            dataPath: this.boot.dataDir,
            portFilePath: this.boot.postgresPortFile,
            password,
        });
        this.connection = postgres.getConnection();
        return this.connection;
    }

    /**
     * Wrap a plugin command's `run` so:
     *  - every plugin's `prepare(ctx)` fires once before the command
     *    body runs (matches the daemon-start invariant: any plugin
     *    can call into any other plugin's library without depending
     *    on `start` order);
     *  - the host's postgres connection is closed after the command
     *    returns. Without the close, the pool keeps the event loop
     *    alive and the CLI process hangs.
     */
    private wrapForExit(cmd: AnyCommandDef): AnyCommandDef {
        const original = cmd.run;
        if (!original) {
            return cmd;
        }
        return defineCommand({
            ...cmd,
            run: async (ctx) => {
                this.prepareAll();
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
 *
 * When `main` is provided, its `args` and `run` are lifted onto the
 * root so `cli.sh <plugin-id>` (no subcommand) executes that command
 * directly. Subcommands continue to work alongside it.
 */
function pluginRoot(
    id: string,
    cmds: readonly AnyCommandDef[],
    main?: AnyCommandDef,
): AnyCommandDef {
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
        args: main?.args,
        run: main?.run,
        subCommands,
    });
}
