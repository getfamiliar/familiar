import type { HostContext } from "@getfamiliar/shared";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import {
    buildAgentAccountAttacher,
    readAuthorizedNumber,
    subscribeAgentChat,
} from "./AgentAccount.js";
import { linkSubcommandFor, loadAuth, logoutSubcommandFor, type WhatsAppAuth } from "./Auth.js";
import { type MutableSocketRegistry, runConnectionLoop } from "./Connection.js";
import { buildUserAccountAttacher } from "./UserAccount.js";

/**
 * One socket registry per account, shared between the daemon (which
 * publishes the live sockets) and the tools (which read them).
 */
export interface WhatsAppSocketRegistries {
    readonly user: MutableSocketRegistry;
    readonly agent: MutableSocketRegistry;
}

/**
 * Start the WhatsApp daemon: one connection loop per linked account,
 * kicked off without awaiting.
 *
 * - **user** account → observes groups (`chat:whatsapp:group`) and
 *   direct messages (`chat:whatsapp:new`).
 * - **agent** account → the user's chat with the assistant
 *   (`chat:whatsapp` + the `whatsapp` chat channel).
 *
 * Each account self-disables (one log line) when it hasn't been linked
 * yet — there's no env-var enable flag; presence of complete baileys
 * credentials on disk *is* the on/off switch.
 *
 * @param ctx Host context.
 * @param registries Socket registries the loops publish to.
 */
export async function startWhatsAppDaemon(
    ctx: HostContext,
    registries: WhatsAppSocketRegistries,
): Promise<void> {
    const userAuth = await loadLinkedAuth(ctx, "user");
    const agentAuth = await loadLinkedAuth(ctx, "agent");

    if (agentAuth) {
        const authorizedNumber = readAuthorizedNumber(ctx);
        await subscribeAgentChat(ctx, registries.agent, authorizedNumber);
        // Long-lived; never resolves under normal operation. Detach so
        // the host's `startDaemons` chain doesn't block on it.
        void runConnectionLoop(
            ctx,
            agentAuth,
            registries.agent,
            buildAgentAccountAttacher(ctx, authorizedNumber),
        );
    }
    if (userAuth) {
        void runConnectionLoop(
            ctx,
            userAuth,
            registries.user,
            buildUserAccountAttacher(ctx, agentJidsOf(agentAuth)),
        );
    }
}

/**
 * Load the auth state of `account` and return it only when it holds a
 * complete pairing; logs why the account stays offline otherwise.
 */
async function loadLinkedAuth(
    ctx: HostContext,
    account: WhatsAppAuth["account"],
): Promise<WhatsAppAuth | null> {
    const auth = await loadAuth(ctx, account);
    const linkCommand = `familiar whatsapp ${linkSubcommandFor(account)}`;
    if (!auth.hasExistingCreds) {
        ctx.logger.info(
            `whatsapp[${account}] not linked yet; run \`${linkCommand}\` to pair this device`,
        );
        return null;
    }
    // `creds.json` exists but `me` is only populated after a *complete*
    // two-phase pair (QR scan + server-confirmed reconnect). Half-baked
    // creds — e.g. left over from a link command that exited on the
    // first 515 — would otherwise silently fall through to baileys'
    // "register a new device" path, which loops on QR timeouts forever
    // because no one is watching the daemon log to scan it.
    if (!auth.state.creds.me?.id) {
        const logoutCommand = `familiar whatsapp ${logoutSubcommandFor(account)}`;
        ctx.logger.info(
            `whatsapp[${account}] creds on disk are incomplete (no \`me\`); run \`${logoutCommand}\` and re-link`,
        );
        return null;
    }
    return auth;
}

/**
 * The agent account's own JIDs (phone number and LID, device suffix
 * stripped), so the user account can skip its conversation with the
 * agent.
 */
function agentJidsOf(agentAuth: WhatsAppAuth | null): ReadonlySet<string> {
    const me = agentAuth?.state.creds.me;
    const jids = new Set<string>();
    for (const jid of [me?.id, me?.lid]) {
        if (jid) {
            jids.add(jidNormalizedUser(jid));
        }
    }
    return jids;
}
