import { type PluginTool, renderInZone, runJsonTool, ToolError } from "@getfamiliar/shared";
import type { HostConfigService } from "../utils/ConfigService.js";
import { createLoginLink } from "./auth/LoginLinks.js";
import type { TrustedProxyRegistry } from "./auth/TrustedProxyRegistry.js";
import type { WebSessionStore } from "./auth/WebSessionStore.js";

/** Tool group of the web UI tools. */
export const WEB_TOOL_GROUP = "web";

/** Dependencies of {@link buildWebTools}. */
export interface WebToolsDeps {
    readonly config: HostConfigService;
    readonly sessions: WebSessionStore;
    readonly proxies: TrustedProxyRegistry;
}

interface WebLoginLinkArgs {
    readonly user?: string;
    readonly baseUrl?: string;
}

/**
 * Build the web UI agent tools: `web_login_link`, the agent's
 * `familiar web login`.
 *
 * @param deps Config, session store and proxy registry.
 * @returns The tools, registered by the host under `pluginId = "core"`.
 */
export function buildWebTools(deps: WebToolsDeps): readonly PluginTool[] {
    return [buildWebLoginLinkTool(deps)];
}

/**
 * `web_login_link` — mint a one-time sign-in link for the web UI.
 * Privileged: whoever holds the link gets a session, so only runs that
 * descend from trusted user input may create one.
 *
 * @param deps Tool dependencies.
 * @returns The tool.
 */
function buildWebLoginLinkTool(deps: WebToolsDeps): PluginTool<WebLoginLinkArgs, object> {
    return {
        name: "web_login_link",
        level: "privileged",
        groups: [WEB_TOOL_GROUP],
        description:
            "Create a one-time link that signs the user in to the familiar web UI (valid 10 minutes, usable once), and " +
            "list every address the web UI is reachable under. `autoSignIn`: URLs of proxies such as Tailscale that sign " +
            "the user in by themselves — give these plainly, no link needed. `loginLinks`: the one-time link under each " +
            "direct address, by `via`: configured (webserver.lanUrls, confirmed), custom (your baseUrl), a proxy id, " +
            "detected (guessed LAN addresses, may not work), local (only on the familiar machine). `notes` hold " +
            "reachability caveats (e.g. WSL2). Before answering, read skills/configuration/web-interface.md. Send links only " +
            "to the user who asked, in the current chat; never store them. `user` defaults to the first login in " +
            "webserver.auth.users; `baseUrl` adds an address the user named.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                user: {
                    type: "string",
                    description: "Login to sign in as; must be listed in webserver.auth.users.",
                },
                baseUrl: {
                    type: "string",
                    description: "Extra base URL, e.g. http://192.168.1.20:8080.",
                },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                if (deps.config.getBool("webserver.enabled", false) !== true) {
                    throw new ToolError(
                        "WebServerDisabled",
                        "The web UI is off (webserver.enabled is not true), so a login link would not work.",
                    );
                }
                let link: Awaited<ReturnType<typeof createLoginLink>>;
                try {
                    link = await createLoginLink({
                        config: deps.config,
                        sessions: deps.sessions,
                        proxies: deps.proxies,
                        user: args.user,
                        baseUrl: args.baseUrl,
                    });
                } catch (err) {
                    throw new ToolError("InvalidArgument", (err as Error).message);
                }
                return {
                    login: link.login,
                    expiresAt: renderInZone(
                        link.expiresAt.toISOString(),
                        deps.config.getString("core.timezone", "UTC"),
                    ),
                    autoSignIn: link.autoSignIn,
                    loginLinks: link.loginLinks,
                    notes: link.notes,
                };
            }, callCtx.toolRunContext),
    };
}
