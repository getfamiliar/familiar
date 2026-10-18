import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { HostContext } from "@getfamiliar/shared";
import { type AuthenticationState, useMultiFileAuthState } from "@whiskeysockets/baileys";

/**
 * The two WhatsApp accounts the plugin can pair:
 *
 * - `user`: the user's personal number, linked as a device so the
 *   plugin can observe groups and direct messages in their name.
 * - `agent`: a second number owned exclusively by the assistant. The
 *   user chats with it like with the Telegram bot.
 */
export type WhatsAppAccount = "user" | "agent";

/**
 * Subdirectory under `<dataDir>/` where baileys' multi-file auth state
 * of each account is persisted. Kept separate from any future on-disk
 * state the plugin might add (caches, group metadata snapshots, etc.)
 * so the `link` / `logout` flow can wipe credentials surgically.
 */
const AUTH_SUBDIRS: Readonly<Record<WhatsAppAccount, string>> = {
    user: path.join("whatsapp", "auth"),
    agent: path.join("whatsapp", "agent-auth"),
};

/**
 * Name of the `familiar whatsapp` subcommand that pairs `account`.
 *
 * @param account The account to pair.
 * @returns `link` for the user account, `link-agent` for the agent.
 */
export function linkSubcommandFor(account: WhatsAppAccount): string {
    return account === "agent" ? "link-agent" : "link";
}

/**
 * Name of the `familiar whatsapp` subcommand that wipes `account`'s creds.
 *
 * @param account The account to log out.
 * @returns `logout` for the user account, `logout-agent` for the agent.
 */
export function logoutSubcommandFor(account: WhatsAppAccount): string {
    return account === "agent" ? "logout-agent" : "logout";
}

/**
 * Resolved baileys auth-state handle plus the metadata the daemon and
 * commands need to decide whether the device is already paired.
 *
 * Mirrors the shape of `useMultiFileAuthState`'s return value (`state`
 * + `saveCreds`) and adds:
 *
 * - `account`: which of the two accounts this state belongs to.
 * - `authDir`: absolute path so callers can log it / pass it to a fresh
 *   `useMultiFileAuthState` after a wipe, without re-deriving from
 *   `dataDir`.
 * - `hasExistingCreds`: `true` iff a `creds.json` was present *before*
 *   `useMultiFileAuthState` materialized an empty one. Drives the
 *   daemon's "do we need a fresh QR" decision and the `status` command.
 */
export interface WhatsAppAuth {
    readonly account: WhatsAppAccount;
    readonly state: AuthenticationState;
    readonly saveCreds: () => Promise<void>;
    readonly authDir: string;
    readonly hasExistingCreds: boolean;
}

/**
 * Prepare the host-side auth directory of `account` and load any
 * existing baileys credentials from it. The directory is created on
 * demand so callers never need to mkdir it themselves.
 *
 * `hasExistingCreds` is captured *before* `useMultiFileAuthState` runs,
 * since that helper writes a placeholder `creds.json` on first call —
 * checking it after would always return `true`.
 *
 * @param ctx Host context providing `dataDir`.
 * @param account Which account's credentials to load.
 * @returns The loaded auth state.
 */
export async function loadAuth(ctx: HostContext, account: WhatsAppAccount): Promise<WhatsAppAuth> {
    const authDir = path.join(ctx.dataDir, AUTH_SUBDIRS[account]);
    await mkdir(authDir, { recursive: true });
    const hasExistingCreds = existsSync(path.join(authDir, "creds.json"));
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    return { account, state, saveCreds, authDir, hasExistingCreds };
}

/**
 * Wipe all baileys credentials of `account` so the next `link`
 * invocation starts a fresh pairing flow. Used by the `logout` command
 * and by the daemon when WhatsApp reports the device was logged out
 * (e.g. user removed it via the phone's Linked Devices screen).
 *
 * Idempotent: a missing directory is treated as already-clean.
 *
 * @param ctx Host context providing `dataDir`.
 * @param account Which account's credentials to wipe.
 */
export async function clearAuth(ctx: HostContext, account: WhatsAppAccount): Promise<void> {
    const authDir = path.join(ctx.dataDir, AUTH_SUBDIRS[account]);
    await rm(authDir, { recursive: true, force: true });
}
