import type { HostContext } from "@getfamiliar/shared";
import { setActiveLogins } from "./auth/ActiveLogins.js";
import { LoginStore, loginDirectory } from "./auth/LoginStore.js";
import { readMs365AuthConfig, readMs365MailConfig, resolveAppRegistration } from "./Config.js";
import { MailPoller } from "./mail/MailPoller.js";

/**
 * Boot the Microsoft 365 plugin: load logins, hand the live store to
 * the tools registry, prepare the mail poller, and start its poll
 * loop. Daemon stays up even when nothing is logged in — the user
 * runs `./cli.sh ms365 login` to add an account, then restarts.
 *
 * Calendar support lands as a sibling block here once the calendar
 * subdirectory exists. Auth is shared.
 */
export async function startMs365Daemon(ctx: HostContext): Promise<void> {
    const auth = readMs365AuthConfig(ctx);
    const mail = readMs365MailConfig(ctx);
    const log = (msg: string) => ctx.log(`ms365: ${msg}`);

    const logins = new LoginStore(loginDirectory(ctx.dataDir), resolveAppRegistration(auth));
    await logins.refresh();
    setActiveLogins(logins);

    const poller = await MailPoller.prepare({
        ctx,
        mail,
        logins,
        log,
        emit: (event) => ctx.events.emit(event),
    });

    if (poller === null) {
        log("mail: not active; idle until a login is added");
        return;
    }

    log(`mail: registered; polling every ${mail.pollingIntervalMinutes}m`);
    runPollLoop(poller, mail.pollingIntervalMinutes, mail.pollingBackoffMinutes, log);
}

/**
 * Per-poller setTimeout supervisor. Same backoff math as the old
 * `MailPollLoop` but reduced to one target since we no longer juggle
 * a list of providers: success → poll again after the interval,
 * failure → exponential backoff capped at 4× the interval. Timers
 * are unref'd so an idle poller doesn't keep the daemon alive on its
 * own.
 */
function runPollLoop(
    poller: MailPoller,
    intervalMinutes: number,
    backoffMinutes: number,
    log: (msg: string) => void,
): void {
    const intervalMs = intervalMinutes * 60_000;
    const backoffBaseMs = backoffMinutes * 60_000;
    // Cap backoff at 4× the interval so a stuck poll still retries
    // roughly every hour for the default 15-min cadence.
    const backoffCapMs = intervalMs * 4;
    let failures = 0;

    const schedule = (delayMs: number) => {
        const timer = setTimeout(tick, delayMs);
        timer.unref();
    };

    const tick = async (): Promise<void> => {
        try {
            await poller.pollOnce();
            failures = 0;
            schedule(intervalMs);
        } catch (err) {
            failures += 1;
            const message = err instanceof Error ? err.message : String(err);
            const exp = Math.min(2 ** (failures - 1), 1024);
            const delay = Math.min(backoffBaseMs * exp, backoffCapMs);
            log(
                `mail: poll error (#${failures}): ${message}; next try in ${Math.round(delay / 60_000)}m`,
            );
            schedule(delay);
        }
    };

    // Kick off the first poll asynchronously so `start(ctx)` returns
    // without doing I/O — host startup isn't blocked on the first
    // Graph round-trip.
    schedule(0);
}
