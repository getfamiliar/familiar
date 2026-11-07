import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PluginManifest } from "@getfamiliar/shared";

/** Source id of the core workspace template shipped with the host package. */
export const CORE_TEMPLATE_SOURCE = "core";

/**
 * One contributor of default workspace files: the core package or a
 * plugin. Earlier sources win when two ship the same path.
 */
export interface TemplateSource {
    /** `core` or the plugin id. */
    readonly id: string;
    /** Absolute template folder, mirrored into the workspace. Absent → no files. */
    readonly templateDir?: string;
    /** Absolute folder of update notes (`*.md`). Absent → no notes. */
    readonly updatesDir?: string;
}

/** One file of the reference workspace (the merged templates). */
export interface ReferenceFile {
    /** Workspace-relative posix path. */
    readonly path: string;
    /** Source that contributes this file. */
    readonly source: string;
    /** File content (utf-8). */
    readonly content: string;
}

/** One update note: a one-off instruction for the update agent. */
export interface UpdateNote {
    /** `<source>/<file name without .md>`, e.g. `core/2026-11-07-banner-section`. */
    readonly id: string;
    /** Source that ships the note. */
    readonly source: string;
    /** Note text (markdown). */
    readonly content: string;
}

/**
 * The template sources of this daemon: the core template shipped with the
 * host package first, then every loaded plugin in load order.
 *
 * @param paths Core template and update-notes folders (from the bootstrap).
 * @param plugins Loaded plugin manifests.
 * @returns The sources.
 */
export function buildTemplateSources(
    paths: { readonly workspaceTemplateDir: string; readonly workspaceUpdatesDir: string },
    plugins: readonly PluginManifest[],
): TemplateSource[] {
    return [
        {
            id: CORE_TEMPLATE_SOURCE,
            templateDir: paths.workspaceTemplateDir,
            updatesDir: paths.workspaceUpdatesDir,
        },
        ...plugins.map((plugin) => ({
            id: plugin.id,
            templateDir: plugin.workspaceTemplate,
            updatesDir: plugin.workspaceUpdates,
        })),
    ];
}

/**
 * Build the reference workspace: every file of every source's template,
 * keyed by workspace-relative path. Sources are taken in order and the
 * first one to ship a path wins — the same rule the old copy-if-missing
 * seeding had (core before plugins).
 *
 * @param sources Template sources, core first.
 * @returns Reference files by workspace-relative path.
 */
export function buildWorkspaceReference(
    sources: readonly TemplateSource[],
): Map<string, ReferenceFile> {
    const reference = new Map<string, ReferenceFile>();
    for (const source of sources) {
        if (source.templateDir === undefined || !existsSync(source.templateDir)) {
            continue;
        }
        for (const relativePath of listFilesRecursively(source.templateDir)) {
            if (reference.has(relativePath)) {
                continue;
            }
            reference.set(relativePath, {
                path: relativePath,
                source: source.id,
                content: readFileSync(path.join(source.templateDir, relativePath), "utf8"),
            });
        }
    }
    return reference;
}

/**
 * List every update note of every source, oldest first per source (notes
 * are named `YYYY-MM-DD-<slug>.md`, so name order is date order).
 *
 * @param sources Template sources.
 * @returns The notes, grouped by source in source order.
 */
export function listUpdateNotes(sources: readonly TemplateSource[]): UpdateNote[] {
    const notes: UpdateNote[] = [];
    for (const source of sources) {
        if (source.updatesDir === undefined || !existsSync(source.updatesDir)) {
            continue;
        }
        const fileNames = readdirSync(source.updatesDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) => entry.name)
            .sort();
        for (const fileName of fileNames) {
            notes.push({
                id: `${source.id}/${fileName.slice(0, -".md".length)}`,
                source: source.id,
                content: readFileSync(path.join(source.updatesDir, fileName), "utf8"),
            });
        }
    }
    return notes;
}

/**
 * List the files below `root` as sorted, root-relative posix paths.
 *
 * @param root Absolute folder to walk.
 * @returns Relative paths of every regular file.
 */
function listFilesRecursively(root: string): string[] {
    const files: string[] = [];
    const walk = (relativeDir: string): void => {
        const entries = readdirSync(path.join(root, relativeDir), { withFileTypes: true });
        for (const entry of entries) {
            const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(relativePath);
            } else if (entry.isFile()) {
                files.push(relativePath);
            }
        }
    };
    walk("");
    return files.sort();
}
