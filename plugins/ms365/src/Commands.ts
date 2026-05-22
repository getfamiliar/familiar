import path from "node:path";
import type { HostContext } from "@getfamiliar/shared";
import { type CommandDef, defineCommand } from "citty";
import { GraphAuth } from "./auth/GraphAuth.js";
import { LoginStore, loginDirectory } from "./auth/LoginStore.js";
import { readMs365AuthConfig, readMs365MailConfig, resolveAppRegistration } from "./Config.js";
import { calendarTypeOf, ownerNameOf } from "./calendar/Mapping.js";
import { GraphClient } from "./graph/GraphClient.js";
import { FOLDER_IDS } from "./mail/Folders.js";
import { buildMailboxMap } from "./mail/MailboxMap.js";
import { classifyKind, type DebugSink } from "./mail/SentSampler.js";
import { TemplateExtractor } from "./mail/TemplateExtractor.js";

/**
 * Build the `./cli.sh ms365` subcommand tree: `status`, `login`, and
 * `logout`. All three work whether the daemon is running or not — they
 * talk directly to Microsoft Graph using the host-side token caches,
 * no bastion / MCP involvement. Each command is mounted as a
 * subcommand of the plugin's root by the host's CLI loader, so the
 * returned array is flat (no extra wrapper command).
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildMs365Commands(ctx: HostContext): readonly CommandDef<any>[] {
    return [
        statusCommand(ctx),
        loginCommand(ctx),
        logoutCommand(ctx),
        calCommand(ctx),
        mailCommand(ctx),
        extractFormattingCommand(ctx),
    ];
}

/**
 * `./cli.sh ms365 extract-formatting [--upn <mailbox>]` — manually
 * trigger the per-mailbox template extraction the daemon normally
 * fires from its boot pass and `refreshCron`. Useful to re-derive
 * templates after the user has changed their signature or font,
 * without waiting for tomorrow's 4am job.
 *
 * Requires the daemon to be running: the command emits events on the
 * bus and awaits their settlement, which only happens when the
 * agentrun scheduler inside the agent container picks them up. If
 * `./cli.sh start` isn't up, the command will hang waiting for a
 * settled promise; the user can Ctrl-C safely (the event row stays in
 * pending and gets processed once the daemon comes back).
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function extractFormattingCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "extract-formatting",
            description:
                "Re-derive per-mailbox HTML templates from each mailbox's Sent Items (reply / " +
                "forward / new). Requires the daemon to be running.",
        },
        args: {
            upn: {
                type: "string",
                required: false,
                description:
                    "Restrict extraction to one mailbox UPN. Default: every mailbox in the configured set.",
            },
            verbose: {
                type: "boolean",
                alias: "v",
                required: false,
                default: false,
                description:
                    "Dump every Sent message's raw headers and body to stdout before " +
                    "classification, plus the per-message decision. Useful when sampler " +
                    "results look wrong.",
            },
        },
        async run({ args }) {
            const log = (msg: string) => {
                process.stdout.write(`${msg}\n`);
            };
            const store = makeLoginStore(ctx);
            await store.refresh();
            const validations = await store.validateAll();
            const validLogins = validations
                .filter((v) => v.ok)
                .map((v) => ({ upn: v.upn, auth: v.auth }));
            if (validLogins.length === 0) {
                log("No active ms365 logins. Run `./cli.sh ms365 login` first.");
                return;
            }

            const mail = readMs365MailConfig(ctx);
            const mailboxMap = await buildMailboxMap(validLogins, mail.mailboxes, log);
            if (mailboxMap.length === 0) {
                log("No reachable mailboxes. Check your `ms365.mail.mailboxes` whitelist.");
                return;
            }

            const target = args.upn ? String(args.upn).toLowerCase() : null;
            const targeted = target
                ? mailboxMap.filter((m) => m.mailbox === target || m.upn === target)
                : mailboxMap;
            if (target && targeted.length === 0) {
                log(
                    `Mailbox "${target}" is not in the configured set ` +
                        `(${mailboxMap.map((m) => m.mailbox).join(", ")}).`,
                );
                return;
            }

            log(
                `Extracting per-kind templates for ${targeted.length} mailbox(es). ` +
                    `Daemon must be running. Press Ctrl-C to abort.`,
            );
            const debug: DebugSink | undefined = args.verbose
                ? (line) => {
                      process.stdout.write(`${line}\n`);
                  }
                : undefined;
            const extractor = new TemplateExtractor({
                ctx,
                mailboxMap: targeted,
                exampleCount: mail.extractFormatting.exampleCount,
                debug,
            });
            await extractor.refreshAll();
            log("Done.");
        },
    });
}

/**
 * `./cli.sh ms365 mail probe-sent <upn>` — diagnostic: list the first
 * N Sent Items messages of one mailbox and print the signals
 * `SentSampler.classifyKind` consults (subject, conversationIndex byte
 * length, whether `internetMessageHeaders` came back, and the final
 * classification). Use this when the template-extraction log claims
 * "no examples" for a kind the user knows exists.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function mailCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: { name: "mail", description: "Mail subcommands (probe-sent)." },
        subCommands: {
            "probe-sent": defineCommand({
                meta: {
                    name: "probe-sent",
                    description:
                        "Dump the first N Sent Items messages of <upn> with the signals " +
                        "`SentSampler` uses to classify reply / forward / new.",
                },
                args: {
                    upn: {
                        type: "positional",
                        required: true,
                        description: "Mailbox / login UPN to probe.",
                    },
                    n: {
                        type: "string",
                        required: false,
                        description: "How many messages to inspect (default 20).",
                    },
                },
                async run({ args }) {
                    const upn = String(args.upn);
                    const n = Math.max(
                        1,
                        Math.min(200, Number.parseInt(String(args.n ?? "20"), 10) || 20),
                    );
                    const store = makeLoginStore(ctx);
                    await store.refresh();
                    const auth = store.byUpn(upn);
                    if (!auth) {
                        process.stdout.write(
                            `No active ms365 login for ${upn}. Run \`./cli.sh ms365 login\`.\n`,
                        );
                        return;
                    }
                    const client = new GraphClient(() => auth.getAccessTokenSilent());
                    process.stdout.write(
                        `Probing first ${n} Sent Items of ${upn}\n` +
                            `Columns: kind | idxBytes | hdrCount | subject\n` +
                            `(idxBytes>22 ⇒ reply; hdrCount = internetMessageHeaders length)\n\n`,
                    );
                    let count = 0;
                    for await (const m of client.iterateFolderMessages(upn, FOLDER_IDS.sent, n)) {
                        count += 1;
                        const idxBytes =
                            typeof m.conversationIndex === "string" &&
                            m.conversationIndex.length > 0
                                ? Buffer.from(m.conversationIndex, "base64").byteLength
                                : 0;
                        const hdrCount = m.internetMessageHeaders?.length ?? 0;
                        const kind = classifyKind(m);
                        const subject = (m.subject ?? "").slice(0, 70);
                        process.stdout.write(
                            `${kind.padEnd(8)} | ${String(idxBytes).padStart(3)} | ` +
                                `${String(hdrCount).padStart(3)} | ${subject}\n`,
                        );
                    }
                    process.stdout.write(`\n${count} message(s) probed.\n`);
                },
            }),
        },
    });
}

/**
 * `./cli.sh ms365 cal list` — discover and print every calendar each
 * active login can reach. Operates entirely host-side (no agent
 * involvement), so the daemon does not need to be running.
 */
function calCommand(
    ctx: HostContext,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "cal",
            description: "Calendar subcommands (list).",
        },
        subCommands: {
            list: defineCommand({
                meta: {
                    name: "list",
                    description: "List every calendar visible to each active login.",
                },
                async run() {
                    const store = makeLoginStore(ctx);
                    await store.refresh();
                    const validations = await store.validateAll();
                    const okLogins = validations.filter((v) => v.ok);
                    if (okLogins.length === 0) {
                        process.stdout.write(
                            "No active Microsoft 365 logins. Run `./cli.sh ms365 login` first.\n",
                        );
                        return;
                    }
                    for (const v of okLogins) {
                        process.stdout.write(`\n${v.upn}\n`);
                        const client = new GraphClient(() => v.auth.getAccessTokenSilent());
                        try {
                            const calendars = await client.listCalendars(v.upn);
                            if (calendars.length === 0) {
                                process.stdout.write("  (no calendars visible)\n");
                                continue;
                            }
                            for (const c of calendars) {
                                const type = calendarTypeOf(c, v.upn);
                                const owner = ownerNameOf(c, type);
                                const tag = type === "own" ? "own" : `shared (${owner ?? "?"})`;
                                const def = c.isDefaultCalendar ? " [default]" : "";
                                process.stdout.write(`  - ${c.name} — ${tag}${def}\n`);
                                process.stdout.write(`      uniqueKey: ${c.id}\n`);
                            }
                        } catch (err) {
                            const reason = err instanceof Error ? err.message : String(err);
                            process.stdout.write(`  (listing failed: ${reason})\n`);
                        }
                    }
                },
            }),
        },
    });
}

function readCoreStringArray(ctx: HostContext, key: string): readonly string[] {
    const raw = ctx.config.getArray(key, []);
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry === "string" && entry.length > 0) {
            out.push(entry);
        }
    }
    return out;
}

function makeLoginStore(ctx: HostContext): LoginStore {
    const auth = readMs365AuthConfig(ctx);
    return new LoginStore(loginDirectory(ctx.dataDir), resolveAppRegistration(auth));
}

function statusCommand(
    ctx: HostContext,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "status",
            description: "Show Microsoft 365 logins and configured mailboxes.",
        },
        async run() {
            const store = makeLoginStore(ctx);
            await store.refresh();
            const validations = await store.validateAll();
            if (validations.length === 0) {
                process.stdout.write("No Microsoft 365 logins yet. Run: ./cli.sh ms365 login\n");
                return;
            }
            process.stdout.write("Microsoft 365 logins:\n");
            for (const v of validations) {
                if (v.ok) {
                    process.stdout.write(
                        `  ✓ ${v.upn}` +
                            (v.account?.displayName ? ` (${v.account.displayName})` : "") +
                            "\n",
                    );
                } else {
                    process.stdout.write(`  ✗ ${v.upn}: ${v.reason ?? "(no reason)"}\n`);
                }
            }
            const mail = readMs365MailConfig(ctx);
            if (mail.mailboxes.length === 0) {
                process.stdout.write(
                    "\nMail mailboxes: (none configured) — primary mailbox of each login is polled.\n",
                );
            } else {
                process.stdout.write("\nConfigured mail mailboxes (from config.yml):\n");
                for (const m of mail.mailboxes) {
                    process.stdout.write(`  - ${m}\n`);
                }
            }
            const allowSend = ctx.config.getBool("mail.allowSend", false) === true;
            const whitelist = readCoreStringArray(ctx, "mail.recipientWhitelist");
            process.stdout.write(
                `\nmail.allowSend: ${allowSend ? "true" : "false"}` +
                    (allowSend && whitelist.length > 0
                        ? ` (whitelist: ${whitelist.join(", ")})`
                        : "") +
                    "\n",
            );
        },
    });
}

function loginCommand(
    ctx: HostContext,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "login",
            description: "Run device-code login for Microsoft 365.",
        },
        async run() {
            const authConfig = readMs365AuthConfig(ctx);
            const registration = resolveAppRegistration(authConfig);

            const store = makeLoginStore(ctx);
            await store.refresh();
            const existing = store.list();
            if (existing.length > 0) {
                process.stdout.write("Already logged in:\n");
                for (const { upn } of existing) {
                    process.stdout.write(`  - ${upn}\n`);
                }
                process.stdout.write(
                    "Add another account by continuing the device flow below.\n\n",
                );
            } else {
                process.stdout.write("No existing logins. Starting device-code flow…\n\n");
            }

            const tmpCachePath = path.join(loginDirectory(ctx.dataDir), `.new-${Date.now()}.json`);
            const auth = new GraphAuth(tmpCachePath, registration);
            const summary = await auth.loginByDeviceCode((message) => {
                process.stdout.write(`${message}\n`);
            });
            process.stdout.write(`\n✓ Signed in as ${summary.upn}\n`);
            if (summary.displayName) {
                process.stdout.write(`  (${summary.displayName})\n`);
            }

            // The cache plugin wrote to the temp path; rename to the
            // canonical UPN-stem path. msal-node's cache contents are
            // independent of filename, so a rename keeps the same
            // login addressable by UPN.
            const { rename } = await import("node:fs/promises");
            const finalPath = path.join(loginDirectory(ctx.dataDir), `${summary.upn}.json`);
            await rename(tmpCachePath, finalPath);
            const finalAuth = new GraphAuth(finalPath, registration);
            store.add(summary.upn, finalAuth);
            process.stdout.write(`  Token cache: ${finalPath}\n`);
        },
    });
}

function logoutCommand(
    ctx: HostContext,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "logout",
            description: "Remove Microsoft 365 login(s). Omit UPN to remove all.",
        },
        args: {
            upn: {
                type: "positional",
                required: false,
                description: "UPN to log out. Omit to log out all accounts.",
            },
        },
        async run({ args }) {
            const store = makeLoginStore(ctx);
            await store.refresh();
            const logins = store.list();
            const requestedUpn = typeof args.upn === "string" ? args.upn : undefined;

            if (requestedUpn) {
                const auth = store.byUpn(requestedUpn);
                if (!auth) {
                    process.stderr.write(`error: not logged in as ${requestedUpn}\n`);
                    if (logins.length === 0) {
                        process.stderr.write("Known logins: (none)\n");
                    } else {
                        process.stderr.write("Known logins:\n");
                        for (const { upn } of logins) {
                            process.stderr.write(`  - ${upn}\n`);
                        }
                    }
                    process.exitCode = 1;
                    return;
                }
                const cachePath = auth.cacheFile;
                await store.remove(requestedUpn);
                process.stdout.write(`✓ Logged out ${requestedUpn.toLowerCase()}\n`);
                process.stdout.write(`  Removed: ${cachePath}\n`);
                return;
            }

            if (logins.length === 0) {
                process.stdout.write("No logins to remove.\n");
                return;
            }

            for (const { upn } of logins) {
                await store.remove(upn);
                process.stdout.write(`✓ Logged out ${upn}\n`);
            }
            process.stdout.write(`Removed ${logins.length} login(s).\n`);
        },
    });
}
