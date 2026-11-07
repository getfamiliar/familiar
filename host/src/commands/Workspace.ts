import { markdownTable, type PluginManifest, writeMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { WorkspaceGit } from "../workspace/WorkspaceGit.js";
import { buildTemplateSources } from "../workspace/WorkspaceReference.js";
import { WorkspaceUpdater } from "../workspace/WorkspaceUpdater.js";

const RAW_ARG = {
    type: "boolean",
    description: "Skip terminal styling and emit the raw markdown verbatim.",
    default: false,
} as const;

/**
 * Updater over this home's workspace and the loaded plugins' templates.
 *
 * @param plugins Loaded plugin manifests.
 * @returns The updater.
 */
function buildUpdater(plugins: readonly PluginManifest[]): WorkspaceUpdater {
    const boot = bootstrap();
    return new WorkspaceUpdater({
        workspaceDir: boot.workspaceDir,
        baseDir: boot.workspaceBaseDir,
        sources: () => buildTemplateSources(boot, plugins),
        git: new WorkspaceGit(boot.workspaceDir),
    });
}

/**
 * Wrap a unified diff in a fenced block, or say there is none.
 *
 * @param diff Diff text or `null`.
 * @returns Markdown.
 */
function fencedDiff(diff: string | null): string {
    return diff === null ? "_(not available)_" : `\`\`\`diff\n${diff.trimEnd()}\n\`\`\``;
}

/**
 * `familiar workspace` — inspect and settle the template updates of the
 * workspace (the CLI side of the `workspace_update_*` agent tools). Works
 * without the daemon: it reads the templates, `data/workspace-base/` and
 * the workspace directly.
 *
 * @param plugins Loaded plugin manifests (their templates are sources).
 * @returns The command.
 */
export function buildWorkspaceCommand(plugins: readonly PluginManifest[]) {
    const statusCommand = defineCommand({
        meta: {
            name: "status",
            description: "List workspace files and update notes that still need a decision.",
        },
        args: { raw: RAW_ARG },
        run({ args }) {
            const { pending, pendingNotes } = buildUpdater(plugins).status();
            const parts: string[] = [];
            parts.push(
                pending.length === 0
                    ? "No workspace file needs a decision."
                    : markdownTable(
                          ["Path", "Workspace file", "Source", "Situation"],
                          pending.map((item) => [
                              item.path,
                              item.livePath ?? "(missing)",
                              item.source,
                              item.kind,
                          ]),
                      ),
            );
            parts.push(
                pendingNotes.length === 0
                    ? "No pending update notes."
                    : `Pending update notes:\n\n${pendingNotes.map((note) => `- ${note.id}`).join("\n")}`,
            );
            writeMarkdown(parts.join("\n\n"), { raw: args.raw });
        },
    });

    const diffCommand = defineCommand({
        meta: {
            name: "diff",
            description:
                "Show the template changes, your changes and the merge proposal for one pending file.",
        },
        args: {
            path: {
                type: "positional",
                required: true,
                description: "Path of a pending file, e.g. chat/web.md.",
            },
            raw: RAW_ARG,
        },
        run({ args }) {
            const details = buildUpdater(plugins).details(String(args.path));
            const sections = [
                `# ${details.livePath ?? details.path} (${details.kind}, ${details.source})`,
                `## Template changes since the last sync\n\n${fencedDiff(details.templateChanges)}`,
                `## Your changes since the last sync\n\n${fencedDiff(details.localChanges)}`,
                `## Workspace → current template\n\n${fencedDiff(details.liveToTemplate)}`,
            ];
            if (details.mergeProposal !== null) {
                sections.push(
                    `## Merge proposal${details.mergeProposal.hasConflicts ? " (with conflicts)" : ""}\n\n\`\`\`markdown\n${details.mergeProposal.content.trimEnd()}\n\`\`\``,
                );
            }
            writeMarkdown(sections.join("\n\n"), { raw: args.raw });
        },
    });

    const resolveCommand = defineCommand({
        meta: {
            name: "resolve",
            description:
                "Settle a pending file: take the template version or keep the workspace file.",
        },
        args: {
            path: {
                type: "positional",
                required: true,
                description: "Path of a pending file, e.g. chat/web.md.",
            },
            resolution: {
                type: "positional",
                required: true,
                description: "use_template or accept_live.",
            },
            summary: {
                type: "string",
                description: "One line for the commit message.",
                default: "resolved via familiar workspace resolve",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const resolution = String(args.resolution);
            if (resolution !== "use_template" && resolution !== "accept_live") {
                throw new Error(
                    `resolution must be use_template or accept_live, got "${resolution}"`,
                );
            }
            const result = await buildUpdater(plugins).resolve(
                String(args.path),
                resolution,
                String(args.summary),
            );
            writeMarkdown(
                `Resolved ${result.livePath ?? result.path} with ${result.resolution}: file ${result.action}` +
                    `${result.commit === null ? "" : `, commit ${result.commit}`}.`,
                { raw: args.raw },
            );
        },
    });

    return defineCommand({
        meta: {
            name: "workspace",
            description: "Template updates of the workspace: list, diff and settle open decisions.",
        },
        subCommands: {
            status: statusCommand,
            diff: diffCommand,
            resolve: resolveCommand,
        },
    });
}
