import { type CommandDef, defineCommand } from "citty";
import type { HostContext, McpClient } from "effective-assistant-shared";
import { getProviderConfig } from "../../Config.js";
import type { MailProvider } from "../MailProvider.js";
import { callJsonTool, type GraphAccount } from "./O365Tools.js";

/**
 * Early-exit guard called at the top of every CLI subcommand that
 * relies on MCP calls reaching the bastion. The bastion runs inside
 * the daemon (`./cli.sh start`); without a live daemon every MCP
 * call fails with a generic `fetch failed`, which we used to
 * misattribute to login state. Cheap to check (pidfile inspection
 * only), so doing it up-front keeps the error path tiny.
 */
function requireDaemonRunning(ctx: HostContext): void {
    if (ctx.isDaemonRunning()) {
        return;
    }
    process.stderr.write("✗ Daemon is not running. Start it first with: ./cli.sh start\n");
    process.exit(1);
}

/**
 * Build the `./cli.sh mail o365` subcommand tree: `status` and
 * `list-mailboxes`. The MCP key is captured at build time (it can
 * be `null` if the package isn't installed), and the leaf commands
 * print actionable hints rather than crashing in that case so
 * `--help` is always navigable.
 */
export function buildO365Commands(
    ctx: HostContext,
    mcpKey: string | null,
    provider: MailProvider,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: provider.id,
            description: `${provider.displayName} mail integration.`,
        },
        subCommands: {
            status: statusCommand(ctx, mcpKey, provider),
            "list-mailboxes": listMailboxesCommand(ctx, mcpKey, provider),
        },
    });
}

function statusCommand(
    ctx: HostContext,
    mcpKey: string | null,
    provider: MailProvider,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "status",
            description: `Show ${provider.displayName} login state.`,
        },
        async run() {
            requireDaemonRunning(ctx);
            if (mcpKey === null) {
                process.stdout.write(
                    `✗ ${provider.displayName}: MCP not installed.\n` +
                        `  Add an entry to config/mcp.yml with package "${provider.packageName}".\n`,
                );
                process.exit(1);
            }
            const client = ctx.mcp.getByKey(mcpKey);
            const result = await provider.isLoggedIn(client);
            if (result.ok) {
                process.stdout.write(
                    `✓ ${provider.displayName} (mcp key: ${mcpKey})\n` +
                        `  Logged-in accounts:\n` +
                        result.detail
                            .split(",")
                            .map((a) => `    - ${a.trim()}`)
                            .join("\n") +
                        "\n",
                );
                return;
            }
            process.stdout.write(
                `✗ ${provider.displayName} (mcp key: ${mcpKey}): not logged in.\n` +
                    `  ${result.detail}\n` +
                    `  Run: ./cli.sh mcp call ${mcpKey} -- --login\n`,
            );
            process.exit(1);
        },
    });
}

interface MailboxRow {
    readonly account: string;
    readonly mailbox: string;
    readonly type: "primary" | "shared";
    readonly accessible: "yes" | "no";
}

function listMailboxesCommand(
    ctx: HostContext,
    mcpKey: string | null,
    provider: MailProvider,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "list-mailboxes",
            description: `List mailboxes the ${provider.displayName} integration can reach.`,
        },
        async run() {
            requireDaemonRunning(ctx);
            await listMailboxesBody(ctx, mcpKey, provider);
        },
    });
}

async function listMailboxesBody(
    ctx: HostContext,
    mcpKey: string | null,
    provider: MailProvider,
): Promise<void> {
    if (mcpKey === null) {
        process.stderr.write(
            `✗ ${provider.displayName}: MCP not installed.\n` +
                `  Add an entry to config/mcp.yml with package "${provider.packageName}".\n`,
        );
        process.exit(1);
    }
    const client = ctx.mcp.getByKey(mcpKey);
    const config = getProviderConfig(ctx, provider.id);
    const accounts = await fetchAccounts(client);
    if (accounts.length === 0) {
        process.stderr.write(
            `No logged-in accounts. Run: ./cli.sh mcp call ${mcpKey} -- --login\n`,
        );
        process.exit(1);
    }
    const rows: MailboxRow[] = [];
    const discovered = new Set<string>(); // lowercase mailbox addresses already in rows

    for (const account of accounts) {
        rows.push({
            account: account.email,
            mailbox: account.email,
            type: "primary",
            accessible: "yes",
        });
        discovered.add(account.email.toLowerCase());

        const enumResult = await tryEnumerateSharedMailboxes(client);
        if (enumResult.note !== null) {
            process.stdout.write(
                `note: shared mailboxes for ${account.email} could not be enumerated.\n` +
                    `      ${enumResult.note}\n` +
                    `      Configured shared mailboxes from mail.${provider.id}.mailboxes are still probed below.\n\n`,
            );
        }
        for (const mailbox of enumResult.mailboxes) {
            const key = mailbox.toLowerCase();
            if (discovered.has(key)) {
                continue;
            }
            const probe = await probeSharedMailbox(client, mailbox);
            rows.push({
                account: account.email,
                mailbox,
                type: "shared",
                accessible: probe.ok ? "yes" : "no",
            });
            if (probe.ok) {
                discovered.add(key);
            }
        }
    }

    // Probe explicitly-configured shared mailboxes not already covered.
    for (const requested of config.mailboxes) {
        if (discovered.has(requested.toLowerCase())) {
            continue;
        }
        const owner = await findFirstReader(client, accounts, requested);
        if (owner === null) {
            rows.push({
                account: accounts[0]?.email ?? "—",
                mailbox: requested,
                type: "shared",
                accessible: "no",
            });
        } else {
            rows.push({
                account: owner,
                mailbox: requested,
                type: "shared",
                accessible: "yes",
            });
        }
    }

    renderGroupedTables(sortRows(rows));
    const anyAccessible = rows.some((r) => r.accessible === "yes");
    process.exit(anyAccessible ? 0 : 1);
}

/**
 * Try `list-users` (the ms365 enumeration tool gated by `--org-mode`
 * + admin scope). On error, return the error message so the CLI can
 * surface the well-known "needs --org-mode and admin" guidance.
 */
async function tryEnumerateSharedMailboxes(
    client: McpClient,
): Promise<{ mailboxes: readonly string[]; note: string | null }> {
    try {
        const result = (await callJsonTool<unknown>(client, "list-users", { top: 200 })) as {
            value?: ReadonlyArray<{ mail?: string; userPrincipalName?: string }>;
        };
        const value = result.value ?? [];
        const out: string[] = [];
        for (const user of value) {
            const addr = user.mail ?? user.userPrincipalName;
            if (typeof addr === "string" && addr.length > 0) {
                out.push(addr);
            }
        }
        return { mailboxes: out, note: null };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/forbidden|insufficient|permission/i.test(message)) {
            return {
                mailboxes: [],
                note: "The ms365 MCP needs --org-mode and the signed-in account needs admin scope.",
            };
        }
        return { mailboxes: [], note: message };
    }
}

async function probeSharedMailbox(
    client: McpClient,
    mailbox: string,
): Promise<{ ok: boolean; note: string | null }> {
    try {
        await callJsonTool<unknown>(client, "list-shared-mailbox-folder-messages", {
            userId: mailbox,
            mailFolderId: "inbox",
            top: 1,
            select: "id",
        });
        return { ok: true, note: null };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, note: message };
    }
}

/**
 * Probe a shared mailbox once and return the first account that's
 * eligible (any account in the MCP cache, since the MCP picks the
 * effective identity itself). Returns `null` when no account is
 * logged in or the probe fails.
 *
 * Per-account scoping isn't possible with the ms365 MCP today — its
 * `list-shared-mailbox-*` tools don't take an account-id arg; the
 * default account (set via `select-account`) is used. We attribute
 * the mailbox to the first logged-in account for display purposes.
 */
async function findFirstReader(
    client: McpClient,
    accounts: readonly GraphAccount[],
    mailbox: string,
): Promise<string | null> {
    if (accounts.length === 0) {
        return null;
    }
    const probe = await probeSharedMailbox(client, mailbox);
    return probe.ok ? accounts[0].email : null;
}

/** Same payload-shape as `O365Provider.listAccounts` but standalone for CLI use. */
async function fetchAccounts(client: McpClient): Promise<readonly GraphAccount[]> {
    try {
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
    } catch {
        return [];
    }
}

function sortRows(rows: readonly MailboxRow[]): readonly MailboxRow[] {
    return [...rows].sort((a, b) => {
        if (a.account !== b.account) {
            return a.account < b.account ? -1 : 1;
        }
        if (a.type !== b.type) {
            return a.type === "primary" ? -1 : 1;
        }
        return a.mailbox < b.mailbox ? -1 : a.mailbox > b.mailbox ? 1 : 0;
    });
}

/**
 * Render rows grouped by account, one markdown `## <account>` header
 * per group followed by a small `MAILBOX | TYPE | ACCESSIBLE` table.
 * Within each group, primary first, then shared alphabetically — the
 * sort order is already imposed by {@link sortRows} on the input.
 */
function renderGroupedTables(rows: readonly MailboxRow[]): void {
    const groups = new Map<string, MailboxRow[]>();
    for (const row of rows) {
        const bucket = groups.get(row.account);
        if (bucket === undefined) {
            groups.set(row.account, [row]);
        } else {
            bucket.push(row);
        }
    }
    let first = true;
    for (const [account, groupRows] of groups) {
        if (!first) {
            process.stdout.write("\n");
        }
        first = false;
        process.stdout.write(`## ${account}\n\n`);
        renderTable(groupRows);
    }
}

/** Print one mailbox table (no account column — that's the group header). */
function renderTable(rows: readonly MailboxRow[]): void {
    const header = ["MAILBOX", "TYPE", "ACCESSIBLE"];
    const data = rows.map((r) => [r.mailbox, r.type, r.accessible]);
    const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));
    const padRow = (row: readonly string[]) =>
        row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
    process.stdout.write(`${padRow(header)}\n`);
    for (const row of data) {
        process.stdout.write(`${padRow(row)}\n`);
    }
}
