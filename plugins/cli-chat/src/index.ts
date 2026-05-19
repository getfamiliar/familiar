import path from "node:path";
import { definePlugin, type HostContext } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { runOneShot, runRepl } from "./Repl.js";

/**
 * cli-chat plugin.
 *
 * `./cli.sh cli-chat` (no message) launches an interactive REPL with
 * an inquirer-based prompt, tab-completion for direct handler calls
 * (`/topic/sub/handler …`), and an ora spinner that summarises the
 * active agentrun while permanent `↳` lines accumulate above it.
 *
 * `./cli.sh cli-chat "<message>"` emits one event and renders the
 * same spinner-driven output until the event settles. With
 * `--return`, the command suppresses the spinner and prints only the
 * final assistant text — handy for scripting.
 */
export default definePlugin({
    id: "cli-chat",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        main: (ctx) => cliChatCommand(ctx),
    },
});

function cliChatCommand(ctx: HostContext) {
    return defineCommand({
        meta: {
            name: "cli-chat",
            description: "Interactive chat, or one-shot send with a message argument.",
        },
        args: {
            message: {
                type: "positional",
                required: false,
                description: "Optional one-shot message; with this set, no REPL is started.",
            },
            return: {
                type: "boolean",
                default: false,
                description:
                    "One-shot only: print only the final assistant text and exit (for scripting).",
            },
        },
        async run({ args }) {
            const message = typeof args.message === "string" ? args.message : "";
            if (message.length > 0) {
                const code = await runOneShot(ctx, message, { returnOnly: args.return === true });
                process.exit(code);
            }
            if (args.return === true) {
                process.stderr.write("--return requires a message argument\n");
                process.exit(2);
            }
            await runRepl(ctx);
        },
    });
}
