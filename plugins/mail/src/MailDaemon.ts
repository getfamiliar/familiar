import path from "node:path";
import type { HostContext, McpInfo } from "effective-assistant-shared";
import { getProviderConfig, readMailConfig } from "./Config.js";
import { MailPollLoop } from "./PollLoop.js";
import type { MailProvider } from "./providers/MailProvider.js";
import { providers } from "./providers/Registry.js";
import { WatermarkStore } from "./Watermark.js";

/**
 * Start the mail plugin: discover which providers are usable,
 * verify they're logged in, kick off polling for the ones that are.
 *
 * No early return on "missing config" — defaults are operational.
 * Real enablement is gated on (a) the provider's MCP being declared
 * in `mcp.yml` and (b) the user being logged in. Either gate
 * failing produces a warn-level log line and that provider is
 * skipped; other providers keep running.
 *
 * Returns a `stop` function the plugin host can call on shutdown.
 */
export async function startMailDaemon(ctx: HostContext): Promise<void> {
    const mailConfig = readMailConfig(ctx);
    const watermark = new WatermarkStore(path.join(ctx.dataDir, "mail", "watermarks.json"));
    await watermark.load();

    const installed = ctx.mcp.getList();
    const loop = new MailPollLoop(
        mailConfig.pollingIntervalMinutes,
        mailConfig.pollingBackoffMinutes,
    );

    const registered: string[] = [];
    const skipped: string[] = [];

    for (const provider of providers) {
        const mcpKey = findMcpKey(installed, provider.packageName);
        const tag = `mail/${provider.id}`;
        const scopedLog = (msg: string) => ctx.log(`${tag}: ${msg}`);

        if (mcpKey === null) {
            scopedLog(
                `MCP not installed (looking for package "${provider.packageName}"); skipping`,
            );
            skipped.push(`${provider.id} (no MCP)`);
            continue;
        }
        const client = ctx.mcp.getByKey(mcpKey);
        const login = await provider.isLoggedIn(client);
        if (!login.ok) {
            scopedLog(
                `MCP found (${mcpKey}) but not logged in (${login.detail}). ` +
                    `Run: ./cli.sh mcp call ${mcpKey} -- --login`,
            );
            skipped.push(`${provider.id} (not logged in)`);
            continue;
        }
        scopedLog(`logged in: ${login.detail}`);
        loop.register(provider, {
            ctx,
            mcpKey,
            client,
            mail: mailConfig,
            provider: getProviderConfig(ctx, provider.id),
            watermark,
            log: scopedLog,
            emit: (event) => ctx.events.emit(event),
        });
        registered.push(`${provider.id} (${mcpKey})`);
    }

    if (registered.length === 0) {
        ctx.log(
            `mail: no providers active (skipped: ${skipped.join(", ") || "none"}); idle until an MCP is installed and logged in`,
        );
    } else {
        ctx.log(
            `mail: registered providers: ${registered.join(", ")}; ` +
                `polling every ${mailConfig.pollingIntervalMinutes}m` +
                (skipped.length > 0 ? ` (skipped: ${skipped.join(", ")})` : ""),
        );
    }

    // The loop's timers are unref'd, so they don't keep the event
    // loop alive on their own. The host doesn't expose a per-plugin
    // shutdown hook today — `process.exit` from the daemon's
    // SIGTERM handler clears the timers and aborts any in-flight
    // poll. If/when per-plugin shutdown lands, `loop.stop()` is the
    // entry point.
    void loop;
}

/**
 * Map a provider's `packageName` to a `mcp.yml` key. The user is
 * free to name their MCP key anything (e.g. `ms365`, `softeria`),
 * so we match by the npm/pypi package field — that's stable.
 */
function findMcpKey(installed: readonly McpInfo[], packageName: string): string | null {
    for (const info of installed) {
        if (info.package === packageName) {
            return info.key;
        }
    }
    return null;
}

/** Pluck a provider by id; exported for use by the CLI command builder. */
export function findProvider(id: string): MailProvider | undefined {
    return providers.find((p) => p.id === id);
}
