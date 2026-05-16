import path from "node:path";
import { type CommandDef, defineCommand } from "citty";
import type { HostContext } from "effective-assistant-shared";
import { readO365Config } from "../../Config.js";
import { type AppRegistration, DEFAULT_APP } from "./AppRegistration.js";
import { GraphAuth } from "./GraphAuth.js";
import { loginDirectory } from "./LoginStore.js";
import type { O365Provider } from "./O365Provider.js";

/**
 * Build the `./cli.sh mail o365` subcommand tree: `status` and
 * `login`. Both work whether the daemon is running or not — they talk
 * directly to Microsoft Graph using the host-side token caches, no
 * bastion / MCP involvement.
 */
export function buildO365Commands(
    ctx: HostContext,
    provider: O365Provider,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: provider.id,
            description: `${provider.displayName} mail integration.`,
        },
        subCommands: {
            status: statusCommand(ctx, provider),
            login: loginCommand(ctx, provider),
        },
    });
}

function statusCommand(
    ctx: HostContext,
    provider: O365Provider,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "status",
            description: `Show ${provider.displayName} logins and configured mailboxes.`,
        },
        async run() {
            const store = provider.getLoginStore(ctx);
            await store.refresh();
            const validations = await store.validateAll();
            if (validations.length === 0) {
                process.stdout.write(
                    `No ${provider.displayName} logins yet. Run: ./cli.sh mail o365 login\n`,
                );
                return;
            }
            process.stdout.write(`${provider.displayName} logins:\n`);
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
            const config = readO365Config(ctx);
            if (config.mailboxes.length === 0) {
                process.stdout.write(
                    "\nMailboxes: (none configured) — primary mailbox of each login is polled.\n",
                );
            } else {
                process.stdout.write("\nConfigured mailboxes (from config.yml):\n");
                for (const m of config.mailboxes) {
                    process.stdout.write(`  - ${m}\n`);
                }
            }
            process.stdout.write(
                `\nallowSend: ${config.allowSend ? "true" : "false"}` +
                    (config.allowSend && config.recipientWhitelist.length > 0
                        ? ` (whitelist: ${config.recipientWhitelist.join(", ")})`
                        : "") +
                    "\n",
            );
        },
    });
}

function loginCommand(
    ctx: HostContext,
    provider: O365Provider,
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "login",
            description: `Run device-code login for ${provider.displayName}.`,
        },
        async run() {
            const config = readO365Config(ctx);
            const registration: AppRegistration = {
                clientId: config.clientId.length > 0 ? config.clientId : DEFAULT_APP.clientId,
                tenantId: config.tenantId.length > 0 ? config.tenantId : DEFAULT_APP.tenantId,
            };

            const store = provider.getLoginStore(ctx);
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
