import path from "node:path";
import type { CommandDef } from "citty";
import type { EventFile, HostContext, NewEvent } from "@getfamiliar/shared";
import { readO365Config } from "../../Config.js";
import type { MailProvider, MailProviderDeps, MailProviderPrepareResult } from "../MailProvider.js";
import { flatAddress, formatAddress, isSafeEmailAddress } from "./AddressFormat.js";
import { type AppRegistration, DEFAULT_APP } from "./AppRegistration.js";
import { DeltaCursorStore } from "./DeltaCursorStore.js";
import type { GraphAuth } from "./GraphAuth.js";
import {
    type DeltaPage,
    GraphClient,
    GraphError,
    type GraphMailMessage,
    type GraphAttachment as GraphRawAttachment,
} from "./GraphClient.js";
import { LoginStore, loginDirectory } from "./LoginStore.js";
import { buildO365Commands } from "./O365Commands.js";

/** Graph caps bodyPreview at 255 chars; equals → cap hit, more body upstream. */
const BODY_PREVIEW_TRUNCATION_LENGTH = 255;
/** Hard ceiling on delta pages per (mailbox, poll) so a runaway backlog can't park the loop. */
const MAX_PAGES_PER_POLL = 50;

/**
 * Microsoft 365 / Outlook mail provider. Owns its own auth (msal-node
 * device-code cache files under `data/mail/o365/`), its own Graph
 * client, and its own per-mailbox delta cursor store. No MCP in the
 * picture: every Graph call goes direct from this host-side plugin.
 *
 * The login → mailboxes map is computed once in {@link prepare} and
 * reused for every poll cycle; the user runs the daemon again to
 * pick up a new login or a changed whitelist.
 */
export class O365Provider implements MailProvider {
    readonly id = "o365";
    readonly displayName = "Microsoft 365";

    private loginStore: LoginStore | null = null;
    private cursorStore: DeltaCursorStore | null = null;
    private mailboxMap: ReadonlyArray<PollTarget> = [];
    private appRegistration: AppRegistration = DEFAULT_APP;

    async prepare(ctx: HostContext): Promise<MailProviderPrepareResult> {
        const config = readO365Config(ctx);
        this.appRegistration = resolveAppRegistration(config);
        this.loginStore = new LoginStore(loginDirectory(ctx.dataDir), this.appRegistration);
        this.cursorStore = new DeltaCursorStore(
            path.join(ctx.dataDir, "mail", "o365", "delta.json"),
        );
        await this.loginStore.refresh();
        await this.cursorStore.load();

        const tag = `mail/${this.id}`;
        const log = (msg: string) => ctx.log(`${tag}: ${msg}`);

        const validations = await this.loginStore.validateAll();
        const valid: { upn: string; auth: GraphAuth }[] = [];
        for (const v of validations) {
            if (v.ok) {
                log(`login ok: ${v.upn}`);
                valid.push({ upn: v.upn, auth: v.auth });
            } else {
                log(`login failed for ${v.upn}: ${v.reason ?? "(no reason)"}; skipping`);
            }
        }
        if (valid.length === 0) {
            return {
                ok: false,
                detail:
                    "no usable o365 logins; run `./cli.sh mail o365 login` to add one " +
                    "(or fix the failing logins above)",
            };
        }
        this.mailboxMap = await buildMailboxMap(valid, config.mailboxes, log);
        if (this.mailboxMap.length === 0) {
            return {
                ok: false,
                detail: "no reachable mailboxes for any active login; nothing to poll",
            };
        }
        const summary = this.mailboxMap
            .map((t) => `${t.mailbox} via ${t.upn}${t.isShared ? " (shared)" : ""}`)
            .join(", ");
        return { ok: true, detail: `polling ${summary}` };
    }

    async pollOnce(deps: MailProviderDeps): Promise<void> {
        if (!this.cursorStore || this.mailboxMap.length === 0) {
            return;
        }
        for (const target of this.mailboxMap) {
            try {
                await pollMailbox(deps, target, this.cursorStore);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deps.log(`mailbox ${target.mailbox} via ${target.upn}: poll error: ${message}`);
            }
        }
    }

    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
    buildCommands(ctx: HostContext): CommandDef<any> {
        return buildO365Commands(ctx, this);
    }

    /**
     * Expose the live login store so the CLI commands can list /
     * validate / add-to-it without re-deriving the directory path.
     * Returns a stub-instance store on first call before
     * {@link prepare} ran (e.g. the `login` CLI command, which runs
     * before any plugin lifecycle).
     */
    getLoginStore(ctx: HostContext): LoginStore {
        if (this.loginStore) {
            return this.loginStore;
        }
        const config = readO365Config(ctx);
        this.appRegistration = resolveAppRegistration(config);
        this.loginStore = new LoginStore(loginDirectory(ctx.dataDir), this.appRegistration);
        return this.loginStore;
    }

    /** Snapshot of the active mailbox map, for CLI / debug output. */
    get mailboxes(): ReadonlyArray<PollTarget> {
        return this.mailboxMap;
    }

    /** The app registration currently in use (default or overridden). */
    get registration(): AppRegistration {
        return this.appRegistration;
    }
}

/**
 * One concrete (login, mailbox) tuple. The `auth` reference is the
 * live `GraphAuth` token provider used by the poll loop.
 */
export interface PollTarget {
    readonly upn: string;
    readonly auth: GraphAuth;
    readonly mailbox: string;
    readonly isShared: boolean;
}

/**
 * Merge the optional config overrides into the default app registration.
 * An empty `clientId` from config means "keep default" — the field is
 * present in the example file but blank by default, so we don't want
 * a placeholder string to nuke the working hardcoded app id.
 */
function resolveAppRegistration(config: ReturnType<typeof readO365Config>): AppRegistration {
    return {
        clientId: config.clientId.length > 0 ? config.clientId : DEFAULT_APP.clientId,
        tenantId: config.tenantId.length > 0 ? config.tenantId : DEFAULT_APP.tenantId,
    };
}

/**
 * Decide which (login, mailbox) tuples to poll. Empty whitelist →
 * every login's primary mailbox. Non-empty whitelist → only listed
 * mailboxes; each listed address is probed against every valid login
 * (`GET /users/{addr}/mailFolders/inbox?$select=id`), and the first
 * login that can read it owns the mailbox.
 *
 * Every UPN and mailbox here is **lowercased** before it lands on a
 * {@link PollTarget}: logins come from {@link GraphAuth} (already
 * folded in `toSummary`), config-supplied mailboxes are folded
 * explicitly. Downstream consumers (event payload, rules-file
 * lookups, login-store keys) get the same form regardless of how the
 * upstream system cased the bytes.
 */
async function buildMailboxMap(
    logins: ReadonlyArray<{ upn: string; auth: GraphAuth }>,
    whitelist: readonly string[],
    log: (msg: string) => void,
): Promise<readonly PollTarget[]> {
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

    const out: PollTarget[] = [];
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
        const sharedOwner = await findReaderForShared(safeLogins, lower);
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

async function findReaderForShared(
    logins: ReadonlyArray<{ upn: string; auth: GraphAuth }>,
    mailbox: string,
): Promise<{ upn: string; auth: GraphAuth } | null> {
    for (const login of logins) {
        const client = new GraphClient(() => login.auth.getAccessTokenSilent());
        try {
            await client.probeInbox(mailbox);
            return login;
        } catch (err) {
            if (err instanceof GraphError && err.status < 500) {
            }
        }
    }
    return null;
}

/**
 * Walk one mailbox forward from its current delta cursor, emit one
 * event per message, and persist the new delta link. On a 410 Gone
 * the cursor is dropped and the next poll starts fresh from "now" —
 * the bus-level idempotency-key dedup keeps re-walks safe.
 */
async function pollMailbox(
    deps: MailProviderDeps,
    target: PollTarget,
    cursorStore: DeltaCursorStore,
): Promise<void> {
    const client = new GraphClient(() => target.auth.getAccessTokenSilent());
    let cursor: string | null = cursorStore.get(target.upn, target.mailbox);
    let pages = 0;
    let nextDeltaLink: string | null = null;

    while (pages < MAX_PAGES_PER_POLL) {
        pages += 1;
        let page: DeltaPage;
        try {
            page = await client.listInboxDelta(target.mailbox, cursor);
        } catch (err) {
            if (err instanceof GraphError && err.status === 410) {
                deps.log(
                    `mailbox ${target.mailbox} via ${target.upn}: delta cursor expired (410); ` +
                        `resetting and re-walking from now`,
                );
                await cursorStore.drop(target.upn, target.mailbox);
                cursor = null;
                continue;
            }
            throw err;
        }

        for (const message of page.value) {
            await emitMailEvent(deps, target, client, message);
        }

        if (page.deltaLink !== null) {
            nextDeltaLink = page.deltaLink;
            break;
        }
        if (page.nextLink === null) {
            // No more pages in this poll cycle and no fresh delta link —
            // shouldn't happen for a healthy delta walk, but guard so we
            // don't loop forever.
            break;
        }
        cursor = page.nextLink;
    }

    if (nextDeltaLink !== null) {
        await cursorStore.set(target.upn, target.mailbox, nextDeltaLink);
    }
}

/** Build the NewEvent for one message and hand it to the host. */
async function emitMailEvent(
    deps: MailProviderDeps,
    target: PollTarget,
    client: GraphClient,
    message: GraphMailMessage,
): Promise<void> {
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
        (truncated ? " Body is truncated. Use the mail_fetch_body tool to get the full body." : "");

    const fetched = await fetchAttachmentsForEvent(deps, target, client, message);

    const event: NewEvent = {
        topic: "mail:o365",
        prompt,
        idempotencyKey: `mail:o365:${message.internetMessageId}`,
        payload: {
            provider: "o365",
            upn: target.upn,
            mailbox: target.mailbox,
            isShared: target.isShared,
            from,
            to: message.toRecipients.map(flatAddress),
            cc: message.ccRecipients.map(flatAddress),
            subject,
            date: message.receivedDateTime,
            messageId: message.id,
            internetMessageId: message.internetMessageId,
            hasAttachments: message.hasAttachments,
            attachments: fetched?.metadata ?? null,
        },
        files: fetched?.files,
    };
    await deps.emit(event);
}

interface FetchedAttachments {
    readonly metadata: ReadonlyArray<{
        id: string;
        name: string;
        contentType: string;
        size: number;
        isInline: boolean;
    }>;
    readonly files: readonly EventFile[];
}

async function fetchAttachmentsForEvent(
    deps: MailProviderDeps,
    target: PollTarget,
    client: GraphClient,
    message: GraphMailMessage,
): Promise<FetchedAttachments | null> {
    if (!message.hasAttachments) {
        return { metadata: [], files: [] };
    }
    try {
        const raw = await client.getAttachments(target.mailbox, message.id);
        return normalizeAttachments(raw);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.log(
            `attachment fetch for ${target.mailbox}/${message.id} failed: ${reason}; ` +
                `emitting with attachments=null`,
        );
        return null;
    }
}

function normalizeAttachments(raw: readonly GraphRawAttachment[]): FetchedAttachments {
    if (raw.length === 0) {
        return { metadata: [], files: [] };
    }
    const meta: Array<{
        id: string;
        name: string;
        contentType: string;
        size: number;
        isInline: boolean;
    }> = [];
    const files: EventFile[] = [];
    const usedNames = new Set<string>();
    for (const item of raw) {
        if (item.id.length === 0 || item.name.length === 0) {
            continue;
        }
        meta.push({
            id: item.id,
            name: item.name,
            contentType: item.contentType,
            size: item.size,
            isInline: item.isInline,
        });
        if (item.isInline) {
            continue;
        }
        if (typeof item.contentBytes !== "string" || item.contentBytes.length === 0) {
            continue;
        }
        const safeName = sanitizeAttachmentName(item.name, item.id, usedNames);
        files.push({ name: safeName, contents: Buffer.from(item.contentBytes, "base64") });
    }
    return { metadata: meta, files };
}

/**
 * Make an attachment filename safe to land at `/scratch/<event-id>/`.
 * The host's emit guard rejects any name containing `/`, `\`, or `..`
 * outright. We replace separators with `_` and strip hidden-file
 * leading dots; empty results fall back to `attachment-<id>`.
 * Collisions get a `(2)`/`(3)`/… suffix before the extension.
 */
function sanitizeAttachmentName(name: string, id: string, used: Set<string>): string {
    let cleaned = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
    if (cleaned === "." || cleaned === "..") {
        cleaned = "";
    }
    if (cleaned.length === 0) {
        cleaned = `attachment-${id.replace(/[/\\]/g, "_")}`;
    }
    if (!used.has(cleaned)) {
        used.add(cleaned);
        return cleaned;
    }
    const dot = cleaned.lastIndexOf(".");
    const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
    const ext = dot > 0 ? cleaned.slice(dot) : "";
    for (let i = 2; i < 1000; i++) {
        const candidate = `${stem} (${i})${ext}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
    const fallback = `${stem}-${id.replace(/[/\\]/g, "_")}${ext}`;
    used.add(fallback);
    return fallback;
}
