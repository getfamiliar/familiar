import type { HostContext } from "effective-assistant-shared";
import { readMailConfig } from "./Config.js";
import { MailPollLoop } from "./PollLoop.js";
import { providers } from "./providers/Registry.js";

/**
 * Start the mail plugin: ask every registered provider to prepare
 * itself, register those that came up green with the poll loop. A
 * provider that fails to prepare is logged and skipped — the daemon
 * keeps running with whatever remains, per the memory rule
 * [[feedback_skip_broken_logins_over_exit]].
 */
export async function startMailDaemon(ctx: HostContext): Promise<void> {
    const mailConfig = readMailConfig(ctx);
    const loop = new MailPollLoop(
        mailConfig.pollingIntervalMinutes,
        mailConfig.pollingBackoffMinutes,
    );

    const registered: string[] = [];
    const skipped: string[] = [];

    for (const provider of providers) {
        const tag = `mail/${provider.id}`;
        const scopedLog = (msg: string) => ctx.log(`${tag}: ${msg}`);
        let result: Awaited<ReturnType<typeof provider.prepare>>;
        try {
            result = await provider.prepare(ctx);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            scopedLog(`prepare failed: ${message}; skipping`);
            skipped.push(`${provider.id} (prepare threw)`);
            continue;
        }
        if (!result.ok) {
            scopedLog(`not registered: ${result.detail}`);
            skipped.push(`${provider.id}`);
            continue;
        }
        scopedLog(result.detail);
        loop.register(provider, {
            ctx,
            mail: mailConfig,
            log: scopedLog,
            emit: (event) => ctx.events.emit(event),
        });
        registered.push(provider.id);
    }

    if (registered.length === 0) {
        ctx.log(
            `mail: no providers active (skipped: ${skipped.join(", ") || "none"}); ` +
                `idle until a login is added`,
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
