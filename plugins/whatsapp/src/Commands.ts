import { Boom } from "@hapi/boom";
import makeWASocket, { DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import { type CommandDef, defineCommand } from "citty";
import type { HostContext } from "effective-assistant-shared";
import qrcodeTerminal from "qrcode-terminal";
import { clearAuth, loadAuth } from "./Auth.js";

const BROWSER_DESCRIPTION: [string, string, string] = ["effective-assistant", "Chrome", "1.0"];

/**
 * Build the citty subcommands exposed under `./cli.sh whatsapp`.
 *
 * Subcommands:
 * - `status` — read-only summary of pairing state.
 * - `link` — interactive pairing flow (renders a QR until WhatsApp
 *   reports the connection is open, then exits).
 * - `logout` — wipes credentials so the next `link` starts fresh.
 *
 * Each subcommand re-loads auth from `<dataDir>/whatsapp/auth/` on
 * invocation rather than capturing a snapshot, since CLI processes
 * are short-lived and run in a separate process from the daemon.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildCommands(ctx: HostContext): readonly CommandDef<any>[] {
    return [statusCommand(ctx), linkCommand(ctx), logoutCommand(ctx)];
}

/**
 * `./cli.sh whatsapp status` — print whether the device is linked,
 * which auth dir the creds live in, and the current group allowlist
 * (if any). Read-only; no socket connection is opened.
 */
function statusCommand(ctx: HostContext) {
    return defineCommand({
        meta: {
            name: "status",
            description: "Show WhatsApp plugin pairing state and configuration.",
        },
        async run() {
            const auth = await loadAuth(ctx);
            if (auth.hasExistingCreds) {
                process.stdout.write(`Linked. Auth state: ${auth.authDir}\n`);
            } else {
                process.stdout.write(
                    `Not linked. Run \`./cli.sh whatsapp link\` to pair this device.\nAuth dir (will be created on link): ${auth.authDir}\n`,
                );
            }
            const allowlist = process.env.WHATSAPP_GROUP_ALLOWLIST?.trim();
            if (allowlist) {
                process.stdout.write(`Group allowlist: ${allowlist}\n`);
            } else {
                process.stdout.write(
                    "Group allowlist: (unset — all groups the linked account is in are observed)\n",
                );
            }
        },
    });
}

/**
 * `./cli.sh whatsapp link` — connect to WhatsApp, render every QR
 * code baileys produces to the terminal, and exit when the connection
 * reaches `open` (success) or fails terminally.
 *
 * Run this once per device. The user opens WhatsApp on their phone,
 * goes to *Settings → Linked devices → Link a device*, scans the QR.
 * Baileys persists creds to `<dataDir>/whatsapp/auth/` via
 * `creds.update`, so the next `./cli.sh start` reuses them silently.
 *
 * Multiple QR codes may appear because baileys rotates them every ~20
 * seconds; just scan whichever is currently displayed.
 */
function linkCommand(ctx: HostContext) {
    return defineCommand({
        meta: {
            name: "link",
            description:
                "Pair the host with a WhatsApp account by displaying a QR for the user's phone to scan.",
        },
        async run() {
            const auth = await loadAuth(ctx);
            if (auth.hasExistingCreds) {
                process.stdout.write(
                    "Already linked. Run `./cli.sh whatsapp logout` first if you want to re-pair.\n",
                );
                return;
            }
            const sock: WASocket = makeWASocket({
                auth: auth.state,
                printQRInTerminal: false,
                browser: BROWSER_DESCRIPTION,
            });
            sock.ev.on("creds.update", auth.saveCreds);
            await new Promise<void>((resolve, reject) => {
                sock.ev.on("connection.update", (update) => {
                    if (update.qr) {
                        process.stdout.write(
                            "\nScan this QR with your phone (Settings → Linked devices → Link a device):\n\n",
                        );
                        qrcodeTerminal.generate(update.qr, { small: true }, (rendered) => {
                            process.stdout.write(`${rendered}\n`);
                        });
                    }
                    if (update.connection === "open") {
                        process.stdout.write(
                            `\nLinked successfully as ${sock.user?.id ?? "unknown"}.\n`,
                        );
                        resolve();
                    }
                    if (update.connection === "close") {
                        const err = update.lastDisconnect?.error;
                        const code = err instanceof Boom ? err.output?.statusCode : undefined;
                        if (code === DisconnectReason.loggedOut) {
                            // Treat user-cancelled scan as a hard stop;
                            // a second `link` invocation starts fresh.
                            reject(new Error("pairing cancelled or rejected by phone"));
                            return;
                        }
                        // Other closes during pairing are non-recoverable
                        // here — the daemon's reconnect loop is what
                        // handles transient closes after pairing.
                        reject(
                            new Error(
                                `connection closed before pairing completed (statusCode=${code ?? "unknown"})`,
                            ),
                        );
                    }
                });
            });
            // Give baileys a tick to flush the final `creds.update` to
            // disk before we exit. `saveCreds` is fire-and-forget on
            // the event listener side, so without this brief yield the
            // process can exit mid-write.
            await new Promise((r) => setTimeout(r, 250));
            process.exit(0);
        },
    });
}

/**
 * `./cli.sh whatsapp logout` — wipe local creds. The next `./cli.sh
 * whatsapp link` will start a fresh pairing flow. Does NOT remove the
 * device from the user's phone — that has to be done in WhatsApp's
 * Linked Devices UI. Local-only state is the host's only concern.
 */
function logoutCommand(ctx: HostContext) {
    return defineCommand({
        meta: {
            name: "logout",
            description: "Wipe local WhatsApp credentials (does not unlink from the phone side).",
        },
        async run() {
            await clearAuth(ctx);
            process.stdout.write(
                "Local WhatsApp credentials wiped. Don't forget to remove the device on your phone too (Settings → Linked devices).\n",
            );
        },
    });
}
