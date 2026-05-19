import type { HostContext } from "@getfamiliar/shared";
import { setActiveLogins } from "./auth/ActiveLogins.js";
import { LoginStore, loginDirectory } from "./auth/LoginStore.js";
import {
    readMs365AuthConfig,
    readMs365CalendarConfig,
    readMs365MailConfig,
    resolveAppRegistration,
} from "./Config.js";
import { CalendarPoller } from "./calendar/CalendarPoller.js";
import { Ms365CalendarProvider } from "./calendar/Ms365CalendarProvider.js";
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
    const calendar = readMs365CalendarConfig(ctx);
    const log = (msg: string) => ctx.log(`ms365: ${msg}`);

    const logins = new LoginStore(loginDirectory(ctx.dataDir), resolveAppRegistration(auth));
    await logins.refresh();
    setActiveLogins(logins);

    if (!mail.enabled) {
        log("mail: disabled via ms365.mail.enabled=false; skipping");
    } else {
        const mailPoller = await MailPoller.prepare({
            ctx,
            mail,
            logins,
            log,
            emit: (event) => ctx.events.emit(event),
        });
        if (mailPoller === null) {
            log("mail: not active; idle until a login is added");
        } else {
            log(`mail: registered; polling every ${mail.pollingIntervalMinutes}m`);
            runPollLoop(
                (): Promise<void> => mailPoller.pollOnce(),
                mail.pollingIntervalMinutes,
                mail.pollingBackoffMinutes,
                "mail",
                log,
            );
        }
    }

    if (!calendar.enabled) {
        log("calendar: disabled via ms365.calendar.enabled=false; skipping");
        return;
    }

    // Register the calendar provider before the poller starts, so a
    // tool call that arrives during the initial seed walk still
    // resolves to a registered provider (writes are rare during boot
    // but the wiring should be safe regardless).
    ctx.calendar.registerProvider(
        new Ms365CalendarProvider({
            config: ctx.config,
            calendarApi: ctx.calendar,
            calendarConfig: calendar,
        }),
    );

    const calendarPoller = await CalendarPoller.prepare({
        ctx,
        calendarConfig: calendar,
        logins,
        calendarApi: ctx.calendar,
        log,
        refreshExpression: calendar.refreshCron,
    });

    if (calendarPoller === null) {
        log("calendar: not active; idle until a login + calendar are reachable");
        return;
    }

    log(`calendar: registered; polling every ${calendar.pollingIntervalMinutes}m`);
    runPollLoop(
        () => calendarPoller.pollOnce(),
        calendar.pollingIntervalMinutes,
        calendar.pollingBackoffMinutes,
        "calendar",
        log,
    );
    calendarPoller.startRefreshCron(log);
}

/**
 * Per-poller setTimeout supervisor. Same backoff math for both mail
 * and calendar polling: success → poll again after the interval,
 * failure → exponential backoff capped at 4× the interval. Timers are
 * unref'd so an idle poller doesn't keep the daemon alive on its own.
 */
function runPollLoop(
    pollOnce: () => Promise<void>,
    intervalMinutes: number,
    backoffMinutes: number,
    label: string,
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
            await pollOnce();
            failures = 0;
            schedule(intervalMs);
        } catch (err) {
            failures += 1;
            const message = err instanceof Error ? err.message : String(err);
            const exp = Math.min(2 ** (failures - 1), 1024);
            const delay = Math.min(backoffBaseMs * exp, backoffCapMs);
            log(
                `${label}: poll error (#${failures}): ${message}; next try in ${Math.round(delay / 60_000)}m`,
            );
            schedule(delay);
        }
    };

    // Kick off the first poll asynchronously so `start(ctx)` returns
    // without doing I/O — host startup isn't blocked on the first
    // Graph round-trip.
    schedule(0);
}
