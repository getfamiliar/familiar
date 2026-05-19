import type { HostContext } from "@getfamiliar/shared";
import { Boom } from "@hapi/boom";
import makeWASocket, { DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import { type CommandDef, defineCommand } from "citty";
import qrcodeTerminal from "qrcode-terminal";
import { clearAuth, loadAuth } from "./Auth.js";
import { buildBaileysLogger, resolveWaVersion } from "./WhatsAppDaemon.js";

const BROWSER_DESCRIPTION: [string, string, string] = ["familiar", "Chrome", "1.0"];

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
            const allowlist = ctx.config
                .getArray("whatsapp.groupAllowlist", [])
                .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
            if (allowlist.length > 0) {
                process.stdout.write(`Group allowlist: ${allowlist.join(", ")}\n`);
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
            const version = await resolveWaVersion(ctx);
            // Two-phase pairing per WhatsApp's protocol:
            // 1. Open socket, render QR, user scans → server saves the
            //    session and sends `restartRequired` (status 515).
            // 2. Reconnect with the just-persisted creds → server replies
            //    with `connection: open`, at which point WhatsApp's
            //    mobile UI confirms the device under "Linked devices".
            // If we exit after phase 1, the phone times out and shows
            // "Pairing failed" even though baileys logged success.
            let attempt = 0;
            while (true) {
                attempt += 1;
                const isFirstAttempt = attempt === 1;
                const result = await runLinkAttempt(
                    ctx,
                    auth,
                    version,
                    /*renderQR=*/ isFirstAttempt,
                );
                if (result === "open") {
                    // Flush the latest in-memory creds (especially
                    // `me`, set during phase 1) to disk before exiting.
                    // Without this `process.exit(0)` can race the async
                    // file write triggered by the last `creds.update`
                    // event, leaving creds.json with the pre-pairing
                    // snapshot and the daemon refusing to start.
                    await auth.saveCreds();
                    const me = auth.state.creds.me?.id ?? "unknown";
                    process.stdout.write(
                        `\nLinked successfully as ${me}. Run \`./cli.sh start\` to bring the daemon up.\n`,
                    );
                    process.exit(0);
                }
                if (result === "restartRequired") {
                    // First-attempt close right after the QR scan; loop
                    // back to the second attempt with the saved creds.
                    process.stdout.write("Pairing handshake completed; finalizing session…\n");
                    continue;
                }
                if (result === "loggedOut") {
                    throw new Error("pairing cancelled or rejected by phone");
                }
                // Anything else is a non-recoverable error during link.
                throw new Error(`connection closed before pairing completed (${result})`);
            }
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

/**
 * Outcome of one open-then-await-close cycle inside the pairing flow.
 *
 * - `open`: socket reached `connection: open`. For a fresh pair, this
 *   only happens on the *second* attempt (after restartRequired); the
 *   second `open` is what makes WhatsApp's mobile UI confirm the new
 *   linked device. Returning early on the first 515 leaves the phone
 *   waiting until it times out and shows "Pairing failed".
 * - `restartRequired`: server told us to reconnect (status 515) right
 *   after the QR scan. Creds were already persisted via `creds.update`,
 *   so the caller should loop and start another attempt.
 * - `loggedOut`: phone rejected/cancelled the pair (status 401). Hard
 *   stop.
 * - any other string: unexpected close; surfaced verbatim for logs.
 */
type LinkAttemptResult = "open" | "restartRequired" | "loggedOut" | string;

/**
 * Run one connection attempt during the pairing flow. On the first
 * attempt the QR is rendered to stdout (`renderQR=true`); on the
 * second attempt creds are already on disk so no QR is needed and we
 * just wait for `connection: open`.
 *
 * Resolves with the outcome shape described in {@link LinkAttemptResult}
 * — never rejects, so the caller can drive the retry loop with simple
 * pattern matching.
 */
async function runLinkAttempt(
    ctx: HostContext,
    auth: Awaited<ReturnType<typeof loadAuth>>,
    version: Awaited<ReturnType<typeof resolveWaVersion>>,
    renderQR: boolean,
): Promise<LinkAttemptResult> {
    const sock: WASocket = makeWASocket({
        auth: auth.state,
        printQRInTerminal: false,
        browser: BROWSER_DESCRIPTION,
        version,
        logger: buildBaileysLogger(ctx),
    });
    sock.ev.on("creds.update", auth.saveCreds);
    return await new Promise<LinkAttemptResult>((resolve) => {
        sock.ev.on("connection.update", (update) => {
            if (renderQR && update.qr) {
                process.stdout.write(
                    "\nScan this QR with your phone (Settings → Linked devices → Link a device):\n\n",
                );
                qrcodeTerminal.generate(update.qr, { small: true }, (rendered) => {
                    process.stdout.write(`${rendered}\n`);
                });
            }
            if (update.connection === "open") {
                resolve("open");
                return;
            }
            if (update.connection === "close") {
                const err = update.lastDisconnect?.error;
                const code = err instanceof Boom ? err.output?.statusCode : undefined;
                if (code === DisconnectReason.restartRequired) {
                    resolve("restartRequired");
                    return;
                }
                if (code === DisconnectReason.loggedOut) {
                    resolve("loggedOut");
                    return;
                }
                resolve(`statusCode=${code ?? "unknown"}`);
            }
        });
    });
}
