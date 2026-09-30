import type { GraphAuth } from "../auth/GraphAuth.js";
import { GraphClient, GraphError } from "../graph/GraphClient.js";
import { isSafeEmailAddress } from "./AddressFormat.js";

/**
 * One concrete (login, mailbox) tuple. The `auth` reference is the
 * live `GraphAuth` token provider used for both polling and search.
 *
 * - For a login's primary mailbox, `mailbox === upn` and
 *   `isShared === false`.
 * - For a shared mailbox, `mailbox` is the shared address and `upn`
 *   names the login that proved it can read the mailbox via
 *   {@link GraphClient.probeInbox}; `isShared` is `true`.
 */
export interface MailboxTarget {
    readonly upn: string;
    readonly auth: GraphAuth;
    readonly mailbox: string;
    readonly isShared: boolean;
}

/**
 * Resolve the set of (login, mailbox) tuples ms365 considers
 * configured. Used by the poller for its event-emission loop and by
 * `Ms365MailProvider.search` to fan a query out across every reachable
 * mailbox when the agent didn't pin one.
 *
 * Empty `whitelist` → every login's primary mailbox. Non-empty
 * whitelist → only listed mailboxes; each address is probed against
 * every valid login (`GET /users/{addr}/mailFolders/inbox?$select=id`)
 * and the first login that can read it owns the mailbox.
 *
 * Every UPN and mailbox is lowercased before it lands on a target so
 * downstream lookups (login-store keys, filename-style rule lookups,
 * event payload addresses) stay case-stable.
 *
 * Built once at daemon startup so search calls never pay the Graph
 * round-trip cost of re-probing shared mailboxes per request.
 */
export async function buildMailboxMap(
    logins: ReadonlyArray<{ upn: string; auth: GraphAuth }>,
    whitelist: readonly string[],
    log: (msg: string) => void,
): Promise<readonly MailboxTarget[]> {
    const safeLogins = logins
        .filter((entry) => {
            if (isSafeEmailAddress(entry.upn)) {
                return true;
            }
            log(`login upn "${entry.upn}" rejected by address validator; skipping`);
            return false;
        })
        .map((entry) => ({ upn: entry.upn.toLowerCase(), auth: entry.auth }));
    if (safeLogins.length === 0) {
        return [];
    }

    if (whitelist.length === 0) {
        return safeLogins.map((entry) => ({
            upn: entry.upn,
            auth: entry.auth,
            mailbox: entry.upn,
            isShared: false,
        }));
    }

    const out: MailboxTarget[] = [];
    for (const requested of whitelist) {
        if (!isSafeEmailAddress(requested)) {
            log(`mailbox "${requested}" in config rejected by address validator; skipping`);
            continue;
        }
        const lower = requested.toLowerCase();
        const ownerLogin = safeLogins.find((l) => l.upn === lower);
        if (ownerLogin) {
            out.push({
                upn: ownerLogin.upn,
                auth: ownerLogin.auth,
                mailbox: ownerLogin.upn,
                isShared: false,
            });
            continue;
        }
        const sharedOwner = await findReaderForShared(safeLogins, lower, log);
        if (sharedOwner) {
            out.push({
                upn: sharedOwner.upn,
                auth: sharedOwner.auth,
                mailbox: lower,
                isShared: true,
            });
        } else {
            log(
                `mailbox ${requested}: no active login can read it; ` +
                    `skipping (check delegation in Outlook admin)`,
            );
        }
    }
    return out;
}

/**
 * Find the first login that can read `mailbox` by probing its inbox
 * with each login's token in turn. Used both at boot (for whitelisted
 * shared mailboxes) and on demand by the mail provider when the agent
 * addresses a shared mailbox that isn't in the configured map.
 *
 * @param logins - Candidate logins, tried in order.
 * @param mailbox - Lowercased mailbox address to probe.
 * @param log - Sink for probe failures that aren't a plain "no access" (5xx, network).
 * @returns The first login that can read the mailbox, or `null` when none can.
 */
export async function findReaderForShared(
    logins: ReadonlyArray<{ upn: string; auth: GraphAuth }>,
    mailbox: string,
    log: (msg: string) => void,
): Promise<{ upn: string; auth: GraphAuth } | null> {
    for (const login of logins) {
        const client = new GraphClient(() => login.auth.getAccessTokenSilent());
        try {
            await client.probeInbox(mailbox);
            return login;
        } catch (err) {
            if (err instanceof GraphError && err.status < 500) {
                // Permission denied / not found: this login can't read it, try the next one.
                continue;
            }
            const reason = err instanceof Error ? err.message : String(err);
            log(
                `mailbox ${mailbox}: probe via login ${login.upn} failed (${reason}); trying next login`,
            );
        }
    }
    return null;
}
