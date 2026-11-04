import { setTimeout as sleep } from "node:timers/promises";
import { type HostContext, markdownTable, writeMarkdown } from "@getfamiliar/shared";
import { type CommandDef, defineCommand } from "citty";
import ora from "ora";
import { DEFAULT_TAILSCALE_HOSTNAME, readLoginOptions } from "./TailscaleDaemon.js";
import {
    isSidecarRunning,
    logoutSidecar,
    readStatus,
    requestLogin,
    TAILSCALE_CONTAINER_NAME,
    type TailscaleStatus,
} from "./TailscaleSidecar.js";

/** Poll interval of `familiar tailscale login` while waiting for the browser login. */
const LOGIN_POLL_INTERVAL_MS = 2_000;

/** How long `familiar tailscale login` waits for the login to complete. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Shared `--raw` flag of the human-facing commands. */
const RAW_ARG = {
    raw: { type: "boolean", description: "Print raw markdown instead of rendering it." },
} as const;

/**
 * Build the citty subcommands exposed under `familiar tailscale`.
 *
 * @param ctx Host context.
 * @returns The subcommands.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildCommands(ctx: HostContext): readonly CommandDef<any>[] {
    return [statusCommand(ctx), loginCommand(ctx), logoutCommand()];
}

/**
 * `familiar tailscale status` — state, device name, tailnet URL and
 * (while logged out) the login URL.
 *
 * @param ctx Host context.
 * @returns The command.
 */
function statusCommand(ctx: HostContext) {
    return defineCommand({
        meta: { name: "status", description: "Show the tailnet login state and the web UI URL." },
        args: RAW_ARG,
        async run({ args }) {
            await requireSidecar();
            const status = await readStatus();
            const hostname = ctx.config.getString("tailscale.hostname", DEFAULT_TAILSCALE_HOSTNAME);
            const rows = [
                ["State", status.backendState],
                ["Device name", hostname],
                ["Web UI", status.dnsName === null ? "(not known yet)" : webUiUrl(status)],
            ];
            if (status.authUrl !== null) {
                rows.push(["Login URL", status.authUrl]);
            }
            writeMarkdown(`# Tailscale\n\n${markdownTable(["", ""], rows)}\n`, {
                raw: args.raw === true,
            });
        },
    });
}

/**
 * `familiar tailscale login` — print the login URL and wait until the
 * node is logged in, then print the web UI URL.
 *
 * @param ctx Host context.
 * @returns The command.
 */
function loginCommand(ctx: HostContext) {
    return defineCommand({
        meta: { name: "login", description: "Log the familiar node into your tailnet." },
        args: RAW_ARG,
        async run({ args }) {
            await requireSidecar();
            let status = await readStatus();
            if (status.backendState === "NeedsLogin" && status.authUrl === null) {
                // Logged out and no login pending (e.g. after `logout`): start one.
                await requestLogin(readLoginOptions(ctx));
            }
            if (status.backendState !== "Running") {
                status = await waitForLogin(status);
            }
            writeMarkdown(`Logged in. The familiar web UI is reachable at ${webUiUrl(status)}\n`, {
                raw: args.raw === true,
            });
        },
    });
}

/**
 * `familiar tailscale logout` — remove the node from the tailnet; the
 * node waits for a new login.
 *
 * @returns The command.
 */
function logoutCommand() {
    return defineCommand({
        meta: { name: "logout", description: "Log the familiar node out of your tailnet." },
        args: RAW_ARG,
        async run({ args }) {
            await requireSidecar();
            await logoutSidecar();
            writeMarkdown(
                'Logged out. The node is no longer in your tailnet; run "familiar tailscale login" to join again.\n',
                { raw: args.raw === true },
            );
        },
    });
}

/**
 * Poll until the node is `Running`, showing the login URL once it is known.
 *
 * @param initial The status read before waiting.
 * @returns The `Running` status.
 * @throws {Error} When the login does not complete within {@link LOGIN_TIMEOUT_MS}.
 */
async function waitForLogin(initial: TailscaleStatus): Promise<TailscaleStatus> {
    const spinner = ora("Waiting for the tailscale node to request a login…").start();
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let status = initial;
    let shownAuthUrl: string | null = null;
    try {
        while (Date.now() < deadline) {
            if (status.backendState === "Running") {
                spinner.succeed("Logged in.");
                return status;
            }
            if (status.authUrl !== null && status.authUrl !== shownAuthUrl) {
                shownAuthUrl = status.authUrl;
                spinner.info(
                    `Open this URL to add the familiar node to your tailnet:\n  ${status.authUrl}`,
                );
                spinner.start("Waiting for the login to complete…");
            }
            await sleep(LOGIN_POLL_INTERVAL_MS);
            status = await readStatus();
        }
    } catch (err) {
        spinner.fail("Could not read the tailscale status.");
        throw err;
    }
    spinner.fail("Timed out.");
    throw new Error(`tailscale login did not complete within ${LOGIN_TIMEOUT_MS / 60_000} minutes`);
}

/**
 * @param status A status with a known DNS name.
 * @returns The web UI's tailnet URL.
 */
function webUiUrl(status: TailscaleStatus): string {
    return `https://${status.dnsName ?? "?"}/`;
}

/**
 * Fail with an actionable message when the sidecar is not running.
 *
 * @throws {Error} When the container is down.
 */
async function requireSidecar(): Promise<void> {
    if (await isSidecarRunning()) {
        return;
    }
    throw new Error(
        `container ${TAILSCALE_CONTAINER_NAME} is not running — start the daemon ("familiar start") with webserver.enabled: true and the tailscale plugin listed in config/plugins`,
    );
}
