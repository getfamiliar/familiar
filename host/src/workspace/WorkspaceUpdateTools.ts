import { type PluginTool, runJsonTool, ToolError } from "@getfamiliar/shared";
import {
    type Resolution,
    WorkspaceUpdateError,
    type WorkspaceUpdater,
} from "./WorkspaceUpdater.js";

/** Tool group of the workspace update tools. */
export const WORKSPACE_TOOL_GROUP = "workspace";

/** Skill the tool descriptions point to. */
const SKILL_PATH = "skills/workspace-update/SKILL.md";

interface PathArgs {
    readonly path: string;
}

interface ResolveArgs {
    readonly path: string;
    readonly resolution: Resolution;
    readonly summary: string;
}

interface NoteDoneArgs {
    readonly id: string;
    readonly summary: string;
}

/** Dependencies of {@link buildWorkspaceUpdateTools}. */
export interface WorkspaceUpdateToolsDeps {
    readonly updater: WorkspaceUpdater;
    /** Reads `core.autoUpdate` per call (default `true`). */
    readonly isAutoUpdateEnabled: () => boolean;
}

/**
 * Build the workspace update tools — the agent's side of the template
 * 3-way merge (`host/src/workspace/WorkspaceUpdater.ts`). The writing
 * tools stay registered when `core.autoUpdate` is off and refuse at call
 * time with an error naming the switch.
 *
 * @param deps Updater and the `core.autoUpdate` switch.
 * @returns The tools, registered by the host under `pluginId = "core"`.
 */
export function buildWorkspaceUpdateTools(deps: WorkspaceUpdateToolsDeps): readonly PluginTool[] {
    return [
        buildStatusTool(deps.updater),
        buildDiffTool(deps.updater),
        buildResolveTool(deps),
        buildNoteDoneTool(deps),
    ];
}

/**
 * Refuse a writing call when `core.autoUpdate` is off.
 *
 * @param deps Tool dependencies.
 * @throws {ToolError} `AutoUpdateDisabled` when the switch is off.
 */
function requireAutoUpdate(deps: WorkspaceUpdateToolsDeps): void {
    if (!deps.isAutoUpdateEnabled()) {
        throw new ToolError(
            "AutoUpdateDisabled",
            "Workspace updates are switched off on this machine (core.autoUpdate is false), usually because its workspace is maintained by another familiar and synced in. Settle the decision on that machine, or ask the user to set core.autoUpdate to true.",
        );
    }
}

/**
 * Run `fn`, mapping {@link WorkspaceUpdateError} to a {@link ToolError}.
 *
 * @param fn Work to do.
 * @returns What `fn` returns.
 * @throws {ToolError} For every updater error.
 */
async function mapUpdateErrors<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof WorkspaceUpdateError) {
            throw new ToolError(err.code, err.message);
        }
        throw err;
    }
}

/**
 * Trim a required string argument.
 *
 * @param value Argument value.
 * @param name Argument name, for the error.
 * @returns The trimmed value.
 * @throws {ToolError} When empty or not a string.
 */
function requireText(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ToolError("InvalidArgument", `\`${name}\` must be a non-empty string`);
    }
    return value.trim();
}

/**
 * `workspace_update_status` — open template decisions and update notes.
 *
 * @param updater Workspace updater.
 * @returns The tool.
 */
function buildStatusTool(updater: WorkspaceUpdater): PluginTool<Record<string, never>, object> {
    return {
        name: "workspace_update_status",
        level: "default",
        groups: [WORKSPACE_TOOL_GROUP],
        description:
            "List what is still open from updating the workspace to new templates of familiar and its plugins. " +
            "`pending`: workspace files that need a decision — `path` (template path), `livePath` (workspace file, " +
            "null when missing; can be the twin handler form x/index.md), `source` (core or plugin id) and `kind`: " +
            "both-changed (template and workspace both changed since the last sync), unknown-base (no earlier sync " +
            "known, file differs from the template), live-deleted (user deleted it, template changed it since), " +
            "template-deleted (template dropped it, user had changed it). `pendingNotes`: update notes not yet " +
            `applied, with id and full text. Files nobody customized are updated automatically. Read ${SKILL_PATH} ` +
            "before acting on the result.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        execute: (_args, callCtx) =>
            runJsonTool(() => mapUpdateErrors(() => updater.status()), callCtx.toolRunContext),
    };
}

/**
 * `workspace_update_diff` — the material to decide one pending file.
 *
 * @param updater Workspace updater.
 * @returns The tool.
 */
function buildDiffTool(updater: WorkspaceUpdater): PluginTool<PathArgs, object> {
    return {
        name: "workspace_update_diff",
        level: "default",
        groups: [WORKSPACE_TOOL_GROUP],
        description:
            "Show what changed for one pending workspace update file (see workspace_update_status). " +
            "`templateChanges`: unified diff of the template since the last sync (what familiar changed). " +
            "`localChanges`: unified diff of the workspace file against that same last-synced template (what the " +
            "user changed). `liveToTemplate`: workspace file → current template (the only diff for unknown-base). " +
            "`mergeProposal`: automatic 3-way merge of both change sets; with `hasConflicts` true it contains " +
            "<<<<<<< workspace / ======= / >>>>>>> new template blocks you must resolve by hand. `templateContent`: " +
            "the current template file. Read-only.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
                path: {
                    type: "string",
                    description:
                        "Template path or workspace path of a pending file, e.g. chat/web.md.",
                },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(
                () => mapUpdateErrors(() => updater.details(requireText(args.path, "path"))),
                callCtx.toolRunContext,
            ),
    };
}

/**
 * `workspace_update_resolve` — settle one pending file.
 *
 * @param deps Tool dependencies.
 * @returns The tool.
 */
function buildResolveTool(deps: WorkspaceUpdateToolsDeps): PluginTool<ResolveArgs, object> {
    return {
        name: "workspace_update_resolve",
        level: "privileged",
        groups: [WORKSPACE_TOOL_GROUP],
        description:
            "Settle one pending workspace update file and commit the result to the workspace git history. " +
            "`use_template`: replace the workspace file with the current template (removes it for " +
            "template-deleted). `accept_live`: keep the workspace file exactly as it is now — use it after you " +
            "wrote a merged version with fs_write, to keep the user's customization, or to keep a deletion. Either " +
            "way the file counts as synced to the current template, so later template changes are measured from " +
            "here. Returns the short commit id; the change can be undone from the workspace git history. " +
            `\`summary\`: one line on what you decided and why. Read ${SKILL_PATH} first.`,
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["path", "resolution", "summary"],
            properties: {
                path: {
                    type: "string",
                    description:
                        "Template path or workspace path of a pending file, e.g. chat/web.md.",
                },
                resolution: {
                    type: "string",
                    enum: ["use_template", "accept_live"],
                    description: "use_template or accept_live (see the tool description).",
                },
                summary: {
                    type: "string",
                    description:
                        "One line, e.g. 'merged new banner section, kept the user's tone rules'.",
                },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                if (args.resolution !== "use_template" && args.resolution !== "accept_live") {
                    throw new ToolError(
                        "InvalidArgument",
                        `\`resolution\` must be use_template or accept_live, got ${JSON.stringify(args.resolution)}`,
                    );
                }
                const path = requireText(args.path, "path");
                const summary = requireText(args.summary, "summary");
                requireAutoUpdate(deps);
                return mapUpdateErrors(() => deps.updater.resolve(path, args.resolution, summary));
            }, callCtx.toolRunContext),
    };
}

/**
 * `workspace_update_note_done` — record an update note as applied.
 *
 * @param deps Tool dependencies.
 * @returns The tool.
 */
function buildNoteDoneTool(deps: WorkspaceUpdateToolsDeps): PluginTool<NoteDoneArgs, object> {
    return {
        name: "workspace_update_note_done",
        level: "privileged",
        groups: [WORKSPACE_TOOL_GROUP],
        description:
            "Record a workspace update note (see workspace_update_status) as applied, after you carried out its " +
            "instructions. Commits every pending workspace change with the note id and your summary, so the edits " +
            "you made for the note can be undone from the workspace git history. A done note is never offered " +
            "again. Returns the short commit id (null when nothing changed).",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id", "summary"],
            properties: {
                id: {
                    type: "string",
                    description:
                        "Note id from workspace_update_status, e.g. core/2026-11-07-banner-section.",
                },
                summary: {
                    type: "string",
                    description:
                        "One line on what you changed, e.g. 'renamed {BANNERS} in 3 handlers'.",
                },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const id = requireText(args.id, "id");
                const summary = requireText(args.summary, "summary");
                requireAutoUpdate(deps);
                const commit = await mapUpdateErrors(() => deps.updater.markNoteDone(id, summary));
                return { id, commit };
            }, callCtx.toolRunContext),
    };
}
