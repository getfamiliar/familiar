import { markdownTable, writeMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { HostConfigService } from "../utils/ConfigService.js";
import { createLoginLink } from "../web/auth/LoginLinks.js";
import { LOGIN_TOKEN_TTL_MS } from "../web/auth/WebAuth.js";
import { PostgresWebSessionStore, type WebSession } from "../web/auth/WebSessionStore.js";

const RAW_ARG = {
    type: "boolean",
    description: "Skip terminal styling and emit the raw markdown verbatim.",
    default: false,
} as const;

/**
 * Run `fn` with a session store on the running daemon's postgres and
 * close the connection afterwards.
 *
 * @param fn Work to do.
 * @returns What `fn` returns.
 * @throws {Error} When postgres is not reachable (daemon not running).
 */
async function withSessionStore<T>(
    fn: (store: PostgresWebSessionStore, config: HostConfigService) => Promise<T>,
): Promise<T> {
    const boot = bootstrap();
    const config = new HostConfigService(boot.configFile);
    const postgres = new PostgresContainer({
        dataPath: boot.dataDir,
        portFilePath: boot.postgresPortFile,
        password: config.getString("core.postgresPassword"),
    });
    const connection = postgres.getConnection();
    try {
        return await fn(new PostgresWebSessionStore(async () => connection), config);
    } finally {
        await connection.close();
    }
}

/** `familiar web login` — mint a one-time login link. */
const loginCommand = defineCommand({
    meta: {
        name: "login",
        description:
            "Print a one-time link that signs a browser in to the web UI (valid 10 minutes).",
    },
    args: {
        user: {
            type: "string",
            description:
                "Login to sign in as; must be listed in webserver.auth.users (default: the first one).",
        },
        url: {
            type: "string",
            description:
                "Base URL the browser uses to reach the web UI (default: http://localhost:<webserver.port>).",
        },
        raw: RAW_ARG,
    },
    async run({ args }) {
        await withSessionStore(async (store, config) => {
            const link = await createLoginLink({
                config,
                sessions: store,
                user: args.user,
                baseUrl: args.url,
            });
            writeMarkdown(
                [
                    `Open one of these links to sign in as **${link.login}** (one-time, valid ${LOGIN_TOKEN_TTL_MS / 60_000} minutes):`,
                    "",
                    ...link.loginLinks.map((entry) => `- ${entry.url} (${entry.via})`),
                    "",
                    ...link.notes.map((note) => `> ${note}`),
                    "",
                    "Behind a proxy with its own login (e.g. the tailscale plugin's tailnet URL) you are signed in without a link. Pass `--url` to print the link for another address.",
                ].join("\n"),
                { raw: args.raw },
            );
        });
    },
});

/**
 * Render the session table.
 *
 * @param sessions Live sessions.
 * @returns Markdown.
 */
function renderSessions(sessions: readonly WebSession[]): string {
    if (sessions.length === 0) {
        return "No active web sessions.";
    }
    return markdownTable(
        ["Id", "Login", "Created", "Last seen", "Expires", "User agent"],
        sessions.map((session) => [
            session.id,
            session.login,
            session.createdAt.toISOString(),
            session.lastSeenAt.toISOString(),
            session.expiresAt.toISOString(),
            session.userAgent ?? "",
        ]),
    );
}

/** `familiar web sessions list|revoke`. */
const sessionsCommand = defineCommand({
    meta: { name: "sessions", description: "List or revoke web UI sessions." },
    subCommands: {
        list: defineCommand({
            meta: { name: "list", description: "List active web UI sessions." },
            args: { raw: RAW_ARG },
            async run({ args }) {
                await withSessionStore(async (store) => {
                    writeMarkdown(renderSessions(await store.listSessions()), { raw: args.raw });
                });
            },
        }),
        revoke: defineCommand({
            meta: {
                name: "revoke",
                description:
                    "Revoke one session (id or unique id prefix from `web sessions list`) or `all`.",
            },
            args: {
                id: {
                    type: "positional",
                    required: true,
                    description: "Session id, unique prefix, or `all`.",
                },
                raw: RAW_ARG,
            },
            async run({ args }) {
                await withSessionStore(async (store) => {
                    const target = await resolveSessionTarget(store, String(args.id));
                    const count = await store.revokeSessions(target);
                    writeMarkdown(`Revoked ${count} web session${count === 1 ? "" : "s"}.`, {
                        raw: args.raw === true,
                    });
                });
            },
        }),
    },
});

/**
 * Resolve an id prefix to exactly one session id.
 *
 * @param store Session store.
 * @param spec Full id, unique prefix, or `all`.
 * @returns A full id or `all`.
 * @throws {Error} When the prefix matches no or several sessions.
 */
async function resolveSessionTarget(store: PostgresWebSessionStore, spec: string): Promise<string> {
    if (spec === "all") {
        return spec;
    }
    const matches = (await store.listSessions()).filter((session) => session.id.startsWith(spec));
    if (matches.length !== 1) {
        throw new Error(
            matches.length === 0
                ? `no active web session id starts with "${spec}" — see \`familiar web sessions list\``
                : `"${spec}" matches ${matches.length} sessions (${matches.map((m) => m.id).join(", ")}) — give a longer prefix`,
        );
    }
    return matches[0]?.id ?? spec;
}

/** `familiar web` — web UI sign-in links and sessions. Needs the running daemon (postgres). */
export const webCommand = defineCommand({
    meta: { name: "web", description: "Web UI access: one-time login links and sessions." },
    subCommands: {
        login: loginCommand,
        sessions: sessionsCommand,
    },
});
