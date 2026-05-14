import type { CommandDef } from "citty";
import type { HostContext, McpClient, NewEvent } from "effective-assistant-shared";
import type { LoginStatus, MailProvider, MailProviderDeps } from "../MailProvider.js";
import { buildO365Commands } from "./O365Commands.js";
import {
    callJsonTool,
    flatAddress,
    formatAddress,
    type GraphAccount,
    type GraphMailMessage,
    isSafeEmailAddress,
    type VerifyLoginResponse,
} from "./O365Tools.js";

/** Max page size for `list-mail-messages` per poll iteration. */
const PAGE_SIZE = 50;
/** Hard ceiling on pages per (mailbox, poll) so a runaway backlog can't park the loop. */
const MAX_PAGES_PER_POLL = 20;
/** Fields requested via Graph `$select`. Keep narrow to keep MCP responses small. */
const SELECT_FIELDS =
    "id,internetMessageId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview";
/** Graph caps bodyPreview at 255 chars; equals signal we hit the cap and the body has more. */
const BODY_PREVIEW_TRUNCATION_LENGTH = 255;

/**
 * Microsoft 365 / Outlook mail provider, backed by Softeria's
 * `@softeria/ms-365-mcp-server`. Calls Graph through the MCP tools
 * (`verify-login`, `list-accounts`, `list-mail-messages`,
 * `list-shared-mailbox-messages`). One-direction: read inbox, emit
 * events. Sending / mark-read live in handler tools, not here.
 */
export class O365Provider implements MailProvider {
    readonly id = "o365";
    readonly displayName = "Microsoft 365";
    readonly packageName = "@softeria/ms-365-mcp-server";

    async isLoggedIn(client: McpClient): Promise<LoginStatus> {
        try {
            const result = await callJsonTool<VerifyLoginResponse>(client, "verify-login");
            if (result.success === true) {
                return {
                    ok: true,
                    detail: result.userData?.userPrincipalName ?? result.message,
                };
            }
            return { ok: false, detail: result.message ?? "not logged in" };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, detail: message };
        }
    }

    async pollOnce(deps: MailProviderDeps): Promise<void> {
        const accounts = await listAccounts(deps.client);
        if (accounts.length === 0) {
            deps.log("no accounts returned by list-accounts; skipping poll");
            return;
        }
        const targets = await resolveMailboxes(deps, accounts);
        for (const target of targets) {
            try {
                await pollMailbox(deps, target);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deps.log(`mailbox ${target.mailbox} via ${target.account}: poll error: ${message}`);
            }
        }
    }

    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
    buildCommands(ctx: HostContext, mcpKey: string | null): CommandDef<any> {
        return buildO365Commands(ctx, mcpKey, this);
    }
}

/** One concrete (account, mailbox) pair the poll loop walks. */
interface PollTarget {
    readonly account: string;
    readonly mailbox: string;
    readonly isShared: boolean;
}

/**
 * Pull the list of currently authenticated accounts via the MCP
 * tool. ms365-mcp-server returns `{ accounts: [{ email, name,
 * isDefault }], count, tip }` (see github.com/softeria/ms-365-mcp-
 * server/blob/main/src/auth-tools.ts). We parse defensively and
 * drop any entry missing a safe-shaped `email`.
 */
async function listAccounts(client: McpClient): Promise<readonly GraphAccount[]> {
    const result = await callJsonTool<{
        accounts?: ReadonlyArray<{ email?: unknown; name?: unknown; isDefault?: unknown }>;
    }>(client, "list-accounts");
    const raw = result.accounts ?? [];
    const out: GraphAccount[] = [];
    for (const item of raw) {
        const email = item?.email;
        if (typeof email !== "string" || email.length === 0) {
            continue;
        }
        const name = typeof item.name === "string" && item.name.length > 0 ? item.name : null;
        const isDefault = item.isDefault === true;
        out.push({ email, name, isDefault });
    }
    return out;
}

/**
 * Decide which (account, mailbox, isShared) tuples to poll this
 * cycle. Empty whitelist → every account's primary mailbox. Non-
 * empty whitelist → only listed mailboxes; if a listed address
 * matches an account, it's that account's primary, otherwise we
 * find the first account that can read it as a shared mailbox.
 *
 * Mailboxes that can't be reached are skipped with a log line; the
 * next poll retries from scratch in case access was granted late.
 */
async function resolveMailboxes(
    deps: MailProviderDeps,
    accounts: readonly GraphAccount[],
): Promise<readonly PollTarget[]> {
    // Both `account` and `mailbox` may be embedded as filename
    // components by a handler (e.g. `workspace/people/<addr>.md`),
    // so reject anything that doesn't pass the strict address shape.
    // Accounts come from the MCP (trusted source) but we still
    // validate defensively; mailboxes come from user config and may
    // not be well-formed.
    const safeAccounts = accounts.filter((a) => {
        if (isSafeEmailAddress(a.email)) {
            return true;
        }
        deps.log(`account "${a.email}" rejected by address validator; skipping`);
        return false;
    });
    const whitelist = deps.provider.mailboxes;
    if (whitelist.length === 0) {
        return safeAccounts.map((a) => ({
            account: a.email,
            mailbox: a.email,
            isShared: false,
        }));
    }
    const targets: PollTarget[] = [];
    const accountSet = new Set(safeAccounts.map((a) => a.email.toLowerCase()));
    for (const requested of whitelist) {
        if (!isSafeEmailAddress(requested)) {
            deps.log(`mailbox "${requested}" in config rejected by address validator; skipping`);
            continue;
        }
        const lower = requested.toLowerCase();
        if (accountSet.has(lower)) {
            const account = safeAccounts.find((a) => a.email.toLowerCase() === lower);
            if (account) {
                targets.push({
                    account: account.email,
                    mailbox: account.email,
                    isShared: false,
                });
            }
            continue;
        }
        const owner = await findSharedMailboxOwner(deps.client, safeAccounts, requested);
        if (owner) {
            targets.push({ account: owner, mailbox: requested, isShared: true });
        } else {
            deps.log(
                `mailbox ${requested}: no logged-in account can read it; skipping (run './cli.sh mail o365 list-mailboxes' to diagnose)`,
            );
        }
    }
    return targets;
}

/**
 * Find an account that can read a shared mailbox by probing each
 * with a 1-item `list-shared-mailbox-folder-messages` call. The
 * first account that doesn't error wins. Returns `null` when no
 * account can read it.
 */
async function findSharedMailboxOwner(
    client: McpClient,
    accounts: readonly GraphAccount[],
    mailbox: string,
): Promise<string | null> {
    for (const account of accounts) {
        try {
            await callJsonTool<unknown>(client, "list-shared-mailbox-folder-messages", {
                userId: mailbox,
                mailFolderId: "inbox",
                top: 1,
                select: "id",
            });
            return account.email;
        } catch {
            // Try next account.
        }
    }
    return null;
}

/**
 * Walk one mailbox forward from its current watermark, emit one
 * event per message, and persist the new watermark when done. On
 * first run for a fresh mailbox honours the provider's `onlyNew`:
 * `true` → stamp watermark = now, exit; `false` → walk the whole
 * inbox.
 */
async function pollMailbox(deps: MailProviderDeps, target: PollTarget): Promise<void> {
    const watermark = deps.watermark.get("o365", target.account, target.mailbox);
    if (watermark === null && deps.provider.onlyNew) {
        const now = new Date().toISOString();
        await deps.watermark.set("o365", target.account, target.mailbox, now);
        deps.log(
            `mailbox ${target.mailbox} via ${target.account}: onlyNew=true; watermark set to ${now}, no historical mail`,
        );
        return;
    }

    let nextFilter: string | null = watermark ? `receivedDateTime gt ${watermark}` : null;
    let pages = 0;
    let highestSeen: string | null = watermark;

    while (pages < MAX_PAGES_PER_POLL) {
        pages += 1;
        // Scope to the inbox explicitly. The non-folder list tools
        // (`list-mail-messages`, `list-shared-mailbox-messages`) span
        // every folder including Sent, Archive, and ancient sub-folders
        // from years ago — which surfaces a flood of old mail on first
        // poll. Graph supports well-known folder names; `"inbox"` is
        // the canonical id for the user's primary inbox.
        const args: Record<string, unknown> = {
            mailFolderId: "inbox",
            top: PAGE_SIZE,
            orderby: "receivedDateTime asc",
            select: SELECT_FIELDS,
        };
        if (nextFilter !== null) {
            args.filter = nextFilter;
        }
        if (target.isShared) {
            args.userId = target.mailbox;
        }
        const toolName = target.isShared
            ? "list-shared-mailbox-folder-messages"
            : "list-mail-folder-messages";
        const response = await callJsonTool<{
            value?: readonly GraphMailMessage[];
            "@odata.nextLink"?: string;
        }>(deps.client, toolName, args);
        const messages = response.value ?? [];
        if (messages.length === 0) {
            break;
        }
        for (const message of messages) {
            await emitMailEvent(deps, target, message);
            if (highestSeen === null || message.receivedDateTime > highestSeen) {
                highestSeen = message.receivedDateTime;
            }
        }
        // Advance the filter for the next page using the latest
        // receivedDateTime we just saw; this works even if the MCP
        // doesn't expose nextLink continuation.
        if (messages.length < PAGE_SIZE) {
            break;
        }
        nextFilter = `receivedDateTime gt ${highestSeen}`;
    }

    if (highestSeen !== null && highestSeen !== watermark) {
        await deps.watermark.set("o365", target.account, target.mailbox, highestSeen);
    }
}

/** Build the NewEvent for one message and hand it to the host. */
async function emitMailEvent(
    deps: MailProviderDeps,
    target: PollTarget,
    message: GraphMailMessage,
): Promise<void> {
    // Every address that ends up in the payload goes through
    // `flatAddress` → `sanitizeAddress`. The result has an `address`
    // field that is ALWAYS safe to interpolate into a filesystem
    // path (e.g. `workspace/people/<address>.md`) — see Sanitize.ts.
    const from = message.from
        ? flatAddress(message.from)
        : { name: null, address: "", rawAddress: null };
    const fromDisplay = formatAddress(message.from ? flatAddress(message.from) : null);
    const subject = message.subject ?? "(no subject)";
    const preview = message.bodyPreview ?? "";
    const truncated = preview.length === BODY_PREVIEW_TRUNCATION_LENGTH;
    const prompt =
        `A new e-mail was received from ${fromDisplay} with subject "${subject}", see payload for metadata. ` +
        `The body starts with: ${preview}` +
        (truncated
            ? " Body is truncated. If needed get full body with get-mail-message tool."
            : "");

    const event: NewEvent = {
        topic: "mail:o365",
        prompt,
        idempotencyKey: `mail:o365:${message.internetMessageId}`,
        payload: {
            provider: "o365",
            account: target.account,
            mailbox: target.mailbox,
            isShared: target.isShared,
            from,
            to: message.toRecipients.map(flatAddress),
            cc: message.ccRecipients.map(flatAddress),
            subject,
            date: message.receivedDateTime,
            messageId: message.id,
            internetMessageId: message.internetMessageId,
        },
    };
    await deps.emit(event);
}
