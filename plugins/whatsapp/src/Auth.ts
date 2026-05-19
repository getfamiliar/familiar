import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { HostContext } from "@getfamiliar/shared";
import { type AuthenticationState, useMultiFileAuthState } from "@whiskeysockets/baileys";

/**
 * Subdirectory under `<dataDir>/whatsapp/` where baileys' multi-file
 * auth state is persisted. Kept separate from any future on-disk state
 * the plugin might add (caches, group metadata snapshots, etc.) so the
 * `link` / `logout` flow can wipe credentials surgically.
 */
const AUTH_SUBDIR = path.join("whatsapp", "auth");

/**
 * Resolved baileys auth-state handle plus the metadata the daemon and
 * commands need to decide whether the device is already paired.
 *
 * Mirrors the shape of `useMultiFileAuthState`'s return value (`state`
 * + `saveCreds`) and adds:
 *
 * - `authDir`: absolute path so callers can log it / pass it to a fresh
 *   `useMultiFileAuthState` after a wipe, without re-deriving from
 *   `dataDir`.
 * - `hasExistingCreds`: `true` iff a `creds.json` was present *before*
 *   `useMultiFileAuthState` materialized an empty one. Drives the
 *   daemon's "do we need a fresh QR" decision and the `status` command.
 */
export interface WhatsAppAuth {
    readonly state: AuthenticationState;
    readonly saveCreds: () => Promise<void>;
    readonly authDir: string;
    readonly hasExistingCreds: boolean;
}

/**
 * Prepare the host-side auth directory and load any existing baileys
 * credentials from it. The directory is created on demand so callers
 * never need to mkdir it themselves.
 *
 * `hasExistingCreds` is captured *before* `useMultiFileAuthState` runs,
 * since that helper writes a placeholder `creds.json` on first call —
 * checking it after would always return `true`.
 */
export async function loadAuth(ctx: HostContext): Promise<WhatsAppAuth> {
    const authDir = path.join(ctx.dataDir, AUTH_SUBDIR);
    await mkdir(authDir, { recursive: true });
    const hasExistingCreds = existsSync(path.join(authDir, "creds.json"));
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    return { state, saveCreds, authDir, hasExistingCreds };
}

/**
 * Wipe all baileys credentials so the next `link` invocation starts a
 * fresh pairing flow. Used by the `logout` command and by the daemon
 * when WhatsApp reports the device was logged out (e.g. user removed
 * it via the phone's Linked Devices screen).
 *
 * Idempotent: a missing directory is treated as already-clean.
 */
export async function clearAuth(ctx: HostContext): Promise<void> {
    const authDir = path.join(ctx.dataDir, AUTH_SUBDIR);
    await rm(authDir, { recursive: true, force: true });
}
