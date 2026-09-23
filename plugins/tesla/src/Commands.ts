import { type HostContext, markdownTable, renderInZone, writeMarkdown } from "@getfamiliar/shared";
import { input, password as passwordPrompt } from "@inquirer/prompts";
import { type CommandDef, defineCommand } from "citty";
import {
    beginLogin,
    buildBrowserLogin,
    exchangeCode,
    extractCode,
    LoginBlockedError,
    type LoginSession,
    submitCredentials,
    verifyMfa,
} from "./auth/PkceLogin.js";
import { TokenStore, tokenFile } from "./auth/TokenStore.js";
import { readTimezone } from "./Config.js";
import { describeError } from "./ErrorText.js";
import { buildTeslaSession } from "./TeslaDaemon.js";

/**
 * Build the `familiar tesla` subcommand tree: `login`, `logout`,
 * `status`, `vehicles`. All four work whether the daemon is running or
 * not — they talk to Tesla directly using the host-side token file, no
 * bastion involved. The host's CLI loader mounts the returned array as
 * subcommands of the plugin root, so it stays flat.
 *
 * @param ctx Plugin host context.
 * @returns The plugin's CLI commands.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildTeslaCommands(ctx: HostContext): readonly CommandDef<any>[] {
    return [loginCommand(ctx), logoutCommand(ctx), statusCommand(ctx), vehiclesCommand(ctx)];
}

/**
 * `familiar tesla login` — obtain and store a refresh token.
 *
 * Prompts for e-mail, password and (when the account has it) the
 * multi-factor code, and posts them to Tesla's SSO. **Nothing but the
 * resulting tokens is written to disk.**
 *
 * Tesla's SSO sits behind a WAF that frequently challenges scripted
 * credential posts. Rather than failing, the command then prints the
 * authorize URL and asks for the callback URL the user lands on after
 * signing in with a browser; the authorization code is parsed out of
 * it and redeemed with the same PKCE verifier.
 *
 * @param ctx Plugin host context.
 * @returns The citty command.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function loginCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "login",
            description: "Sign in to Tesla and cache the refresh token.",
        },
        async run() {
            const store = new TokenStore(tokenFile(ctx.dataDir));
            const existing = await store.read();
            if (existing !== null) {
                writeMarkdown(
                    `Already signed in as \`${existing.email || "(unknown account)"}\`. ` +
                        "Continuing replaces that login.\n\n",
                );
            }

            const email = await input({ message: "Tesla account e-mail" });
            const secret = await passwordPrompt({ message: "Password" });

            const { code, verifier } = await obtainCode(email, secret);
            const tokens = await exchangeCode(code, verifier, email);
            await store.write(tokens);

            writeMarkdown(
                `Signed in as \`${email}\`.\n\n` +
                    `Token cache: \`${store.filePath}\` (mode 0600).\n\n` +
                    "Restart the daemon (`familiar start`) so the running agent picks it up.\n",
            );
        },
    });
}

/**
 * Run the interactive half of the login and come back with an
 * authorization code plus the verifier it must be redeemed with.
 *
 * @param email Account e-mail.
 * @param secret Account password. Never persisted.
 * @returns The authorization code and its PKCE verifier.
 * @throws When the browser fallback's pasted URL carries no code, or
 *   the failure was not a WAF refusal.
 */
async function obtainCode(
    email: string,
    secret: string,
): Promise<{ code: string; verifier: string }> {
    let session: LoginSession | null = null;
    try {
        session = await beginLogin(email);
        return {
            code: await submitWithMfa(session, email, secret),
            verifier: session.pkce.verifier,
        };
    } catch (err) {
        if (!(err instanceof LoginBlockedError)) {
            throw err;
        }
        writeMarkdown(`\n**Scripted login was refused:** ${err.message}.\n\n`);
        // Reuse the started session's PKCE pair when we got that far,
        // so the code the browser hands back matches the verifier we
        // redeem it with. Only mint a fresh pair when even the
        // authorize page was unreachable.
        const fallback =
            session === null
                ? buildBrowserLogin(email)
                : { authorizeUrl: session.authorizeUrl, pkce: session.pkce };
        writeMarkdown(
            "**Falling back to the browser.**\n\n" +
                "Tesla redirects the finished login to `tesla://auth/callback?code=…`, a " +
                "custom scheme no browser can open — so the code has to be read out of " +
                "devtools rather than the address bar.\n\n" +
                "1. Open a browser and press `F12` to open devtools, go to the **Network** " +
                "tab and tick **Preserve log** (Firefox: **Persist logs**). Without that the " +
                "entries are wiped on each navigation and the one you need disappears.\n" +
                "2. Open this URL in that tab and sign in:\n\n" +
                `   ${fallback.authorizeUrl}\n\n` +
                '3. The page will end on an error or an "open an app?" prompt — that is ' +
                "the expected outcome, not a failure.\n" +
                "4. In the Network list find the **last** `authorize` request (status `302`), " +
                "open **Headers → Response Headers**, and copy the full `location:` value. " +
                "It starts with `tesla://auth/callback?code=`.\n" +
                "5. Paste it below.\n\n",
        );
        const callbackUrl = await input({ message: "Callback URL" });
        return { code: extractCode(callbackUrl), verifier: fallback.pkce.verifier };
    }
}

/**
 * Post the credentials and, when Tesla asks for one, the multi-factor
 * code.
 *
 * @param session The in-flight login session.
 * @param email Account e-mail.
 * @param secret Account password.
 * @returns The authorization code.
 */
async function submitWithMfa(
    session: LoginSession,
    email: string,
    secret: string,
): Promise<string> {
    const result = await submitCredentials(session, email, secret);
    if (result.kind === "code") {
        return result.code;
    }
    const passcode = await passwordPrompt({ message: "Multi-factor code" });
    return verifyMfa(session, result.csrf, passcode);
}

/**
 * `familiar tesla logout` — delete the cached tokens.
 *
 * @param ctx Plugin host context.
 * @returns The citty command.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function logoutCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: { name: "logout", description: "Remove the cached Tesla login." },
        async run() {
            const store = new TokenStore(tokenFile(ctx.dataDir));
            const removed = await store.clear();
            writeMarkdown(
                removed
                    ? `Logged out. Removed \`${store.filePath}\`.\n`
                    : "No Tesla login to remove.\n",
            );
        },
    });
}

/**
 * `familiar tesla status` — is there a working login, and which car do
 * the tools act on?
 *
 * Proves the refresh token by actually using it, so a silently expired
 * login shows up here rather than on the agent's next tool call.
 *
 * @param ctx Plugin host context.
 * @returns The citty command.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function statusCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "status",
            description: "Show the Tesla login state and the default vehicle.",
        },
        args: {
            raw: {
                type: "boolean",
                description:
                    "Skip terminal styling and emit the raw markdown verbatim. Useful for " +
                    "piping into a file or a markdown viewer.",
            },
        },
        async run({ args }) {
            const raw = args.raw === true;
            const session = buildTeslaSession(ctx);
            const tokens = await session.auth.load();
            if (tokens === null) {
                writeMarkdown("No Tesla login yet. Run: `familiar tesla login`\n", { raw });
                return;
            }

            const zone = readTimezone(ctx);
            let health: string;
            try {
                const refreshed = await session.auth.forceRefresh();
                health = `OK — access token valid until ${renderInZone(
                    new Date(refreshed.expiresAt).toISOString(),
                    zone,
                )}`;
            } catch (err) {
                health = `FAILED — ${describeError(err)}`;
            }

            const current = await session.defaults.read();
            writeMarkdown(
                "# Tesla\n\n" +
                    `- Account: \`${tokens.email || "(unknown)"}\`\n` +
                    `- Refresh: ${health}\n` +
                    `- Default vehicle: ${
                        current === null
                            ? "not set (resolved on first tool call)"
                            : `${current.displayName || current.id} — \`${current.vin}\``
                    }\n`,
                { raw },
            );
        },
    });
}

/**
 * `familiar tesla vehicles` — the same list the agent's
 * `tesla_vehicles_list` tool returns, as a table.
 *
 * @param ctx Plugin host context.
 * @returns The citty command.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function vehiclesCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: { name: "vehicles", description: "List the vehicles on the Tesla account." },
        args: {
            raw: {
                type: "boolean",
                description:
                    "Skip terminal styling and emit the raw markdown verbatim. Useful for " +
                    "piping into a file or a markdown viewer.",
            },
        },
        async run({ args }) {
            const raw = args.raw === true;
            const session = buildTeslaSession(ctx);
            if ((await session.auth.load()) === null) {
                writeMarkdown("No Tesla login yet. Run: `familiar tesla login`\n", { raw });
                return;
            }
            const vehicles = await session.owner.listVehicles();
            if (vehicles.length === 0) {
                writeMarkdown("This Tesla account has no vehicles on it.\n", { raw });
                return;
            }
            const current = await session.defaults.read();
            writeMarkdown(
                markdownTable(
                    ["id", "vin", "name", "state", "signed commands", "default"],
                    vehicles.map((v) => [
                        v.id,
                        v.vin,
                        v.displayName,
                        v.state,
                        // Tesla's own verdict on whether this car would
                        // accept unsigned remote commands. `required`
                        // is why the plugin ships none.
                        v.commandSigning ?? "unknown",
                        current !== null && current.id === v.id ? "yes" : "",
                    ]),
                ),
                { raw },
            );
        },
    });
}
