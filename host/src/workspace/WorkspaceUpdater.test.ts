import assert from "node:assert/strict";
import fs, {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import git from "isomorphic-git";
import { WorkspaceGit } from "./WorkspaceGit.js";
import type { TemplateSource } from "./WorkspaceReference.js";
import { WorkspaceUpdateError, WorkspaceUpdater } from "./WorkspaceUpdater.js";

let root: string;
let workspaceDir: string;
let baseDir: string;
let coreDir: string;
let pluginDir: string;
let coreUpdatesDir: string;
let sources: TemplateSource[];

/**
 * Write a file below `dir`, creating parent folders.
 *
 * @param dir Root folder.
 * @param relativePath Path below it.
 * @param content File content.
 */
function put(dir: string, relativePath: string, content: string): void {
    const file = path.join(dir, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
}

/**
 * @param relativePath Workspace-relative path.
 * @returns The workspace file content, or `null` when missing.
 */
function live(relativePath: string): string | null {
    const file = path.join(workspaceDir, relativePath);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * @param withGit Whether to give the updater a repository.
 * @returns A fresh updater over the test folders.
 */
function updater(withGit = false): WorkspaceUpdater {
    return new WorkspaceUpdater({
        workspaceDir,
        baseDir,
        sources: () => sources,
        git: withGit ? new WorkspaceGit(workspaceDir) : null,
    });
}

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "workspace-updater-"));
    workspaceDir = path.join(root, "workspace");
    baseDir = path.join(root, "data", "workspace-base");
    coreDir = path.join(root, "core-template");
    pluginDir = path.join(root, "plugin-template");
    coreUpdatesDir = path.join(root, "core-updates");
    mkdirSync(workspaceDir, { recursive: true });
    sources = [
        { id: "core", templateDir: coreDir, updatesDir: coreUpdatesDir },
        { id: "demo", templateDir: pluginDir },
    ];
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceUpdater.sync", () => {
    it("seeds missing files and records them as base", async () => {
        put(coreDir, "PROMPT.md", "prompt v1\n");
        put(pluginDir, "chat/demo.md", "demo v1\n");
        const report = await updater().sync("1.0.0");
        assert.deepEqual(
            report.applied.map((change) => [change.kind, change.path, change.source]),
            [
                ["seeded", "PROMPT.md", "core"],
                ["seeded", "chat/demo.md", "demo"],
            ],
        );
        assert.equal(live("chat/demo.md"), "demo v1\n");
        assert.deepEqual(report.pending, []);
    });

    it("lets the earlier source win when two ship the same path", async () => {
        put(coreDir, "SOUL.md", "core soul\n");
        put(pluginDir, "SOUL.md", "plugin soul\n");
        await updater().sync("1.0.0");
        assert.equal(live("SOUL.md"), "core soul\n");
    });

    it("fast-forwards an untouched file and leaves an unchanged template alone", async () => {
        put(coreDir, "a.md", "v1\n");
        put(coreDir, "b.md", "same\n");
        await updater(true).sync("1.0.0");
        put(coreDir, "a.md", "v2\n");
        const report = await updater(true).sync("1.1.0");
        assert.deepEqual(
            report.applied.map((change) => [change.kind, change.path]),
            [["fast-forwarded", "a.md"]],
        );
        assert.equal(live("a.md"), "v2\n");
        assert.notEqual(report.updateCommit, null);
    });

    it("does not overwrite without git (no undo possible)", async () => {
        put(coreDir, "a.md", "v1\n");
        await updater().sync("1.0.0");
        put(coreDir, "a.md", "v2\n");
        const report = await updater().sync("1.1.0");
        assert.deepEqual(report.applied, []);
        assert.equal(live("a.md"), "v1\n");
        // Still open for the next run with git.
        assert.equal(updater().status().pending.length, 0);
    });

    it("reports both-changed when template and workspace diverged", async () => {
        put(coreDir, "a.md", "line1\nline2\nline3\n");
        await updater(true).sync("1.0.0");
        put(workspaceDir, "a.md", "line1 mine\nline2\nline3\n");
        put(coreDir, "a.md", "line1\nline2\nline3 new\n");
        const report = await updater(true).sync("1.1.0");
        assert.deepEqual(
            report.pending.map((item) => [item.kind, item.path]),
            [["both-changed", "a.md"]],
        );
        const details = updater().details("a.md");
        assert.equal(details.mergeProposal?.hasConflicts, false);
        assert.equal(details.mergeProposal?.content, "line1 mine\nline2\nline3 new\n");
        assert.match(details.templateChanges ?? "", /\+line3 new/);
        assert.match(details.localChanges ?? "", /\+line1 mine/);
    });

    it("records the base when the workspace already equals the new template", async () => {
        put(coreDir, "a.md", "v1\n");
        await updater().sync("1.0.0");
        put(coreDir, "a.md", "v2\n");
        put(workspaceDir, "a.md", "v2\n");
        const report = await updater().sync("1.1.0");
        assert.deepEqual(report.pending, []);
        assert.deepEqual(report.applied, []);
        put(coreDir, "a.md", "v3\n");
        // Base advanced to v2, so the untouched v2 is now a fast-forward case.
        assert.deepEqual(updater().status().pending, []);
    });

    it("treats a differing file without base as unknown-base", async () => {
        put(workspaceDir, "a.md", "mine\n");
        put(coreDir, "a.md", "template\n");
        const report = await updater().sync("1.0.0");
        assert.deepEqual(
            report.pending.map((item) => item.kind),
            ["unknown-base"],
        );
        const details = updater().details("a.md");
        assert.equal(details.templateChanges, null);
        assert.equal(details.mergeProposal, null);
        assert.match(details.liveToTemplate ?? "", /-mine\n\+template/);
    });

    it("compares against the twin handler form", async () => {
        put(workspaceDir, "chat/compaction/index.md", "v1\n");
        put(coreDir, "chat/compaction.md", "v1\n");
        await updater(true).sync("1.0.0");
        assert.equal(live("chat/compaction.md"), null);
        put(coreDir, "chat/compaction.md", "v2\n");
        await updater(true).sync("1.1.0");
        assert.equal(live("chat/compaction/index.md"), "v2\n");
        assert.equal(live("chat/compaction.md"), null);
    });

    it("removes a dropped template file only when untouched", async () => {
        put(coreDir, "old.md", "old\n");
        put(coreDir, "custom.md", "custom\n");
        await updater(true).sync("1.0.0");
        put(workspaceDir, "custom.md", "custom edited\n");
        rmSync(path.join(coreDir, "old.md"));
        rmSync(path.join(coreDir, "custom.md"));
        const report = await updater(true).sync("1.1.0");
        assert.equal(live("old.md"), null);
        assert.deepEqual(
            report.applied.map((change) => [change.kind, change.path]),
            [["removed", "old.md"]],
        );
        assert.deepEqual(
            report.pending.map((item) => [item.kind, item.path]),
            [["template-deleted", "custom.md"]],
        );
    });

    it("treats a template moving to the twin form as a move, not a deletion", async () => {
        put(coreDir, "chat/group.md", "v1\n");
        await updater(true).sync("1.0.0");
        rmSync(path.join(coreDir, "chat/group.md"));
        put(coreDir, "chat/group/index.md", "v2\n");
        put(workspaceDir, "chat/group.md", "mine\n");
        const report = await updater(true).sync("1.1.0");
        // The old base is dropped; the moved template is compared against the live twin.
        assert.deepEqual(
            report.pending.map((item) => [item.kind, item.path, item.livePath]),
            [["unknown-base", "chat/group/index.md", "chat/group.md"]],
        );
        assert.equal(live("chat/group.md"), "mine\n");
    });

    it("leaves the files of an uninstalled plugin alone", async () => {
        put(pluginDir, "chat/demo.md", "demo\n");
        await updater(true).sync("1.0.0");
        sources = sources.filter((source) => source.id !== "demo");
        const report = await updater(true).sync("1.1.0");
        assert.equal(live("chat/demo.md"), "demo\n");
        assert.deepEqual(report.applied, []);
        assert.deepEqual(report.pending, []);
    });

    it("reports a template change to a file the user deleted", async () => {
        put(coreDir, "a.md", "v1\n");
        await updater().sync("1.0.0");
        rmSync(path.join(workspaceDir, "a.md"));
        assert.deepEqual(updater().status().pending, []);
        put(coreDir, "a.md", "v2\n");
        assert.deepEqual(
            updater()
                .status()
                .pending.map((item) => item.kind),
            ["live-deleted"],
        );
    });
});

describe("update notes", () => {
    it("marks existing notes done on the first run, reports later ones", async () => {
        put(coreUpdatesDir, "2026-01-01-old.md", "old note\n");
        const first = await updater().sync("1.0.0");
        assert.deepEqual(first.pendingNotes, []);
        put(coreUpdatesDir, "2026-02-01-new.md", "new note\n");
        const second = await updater().sync("1.1.0");
        assert.deepEqual(
            second.pendingNotes.map((note) => note.id),
            ["core/2026-02-01-new"],
        );
        await updater().markNoteDone("core/2026-02-01-new", "applied");
        assert.deepEqual(updater().status().pendingNotes, []);
        await assert.rejects(
            updater().markNoteDone("core/2026-02-01-new", "again"),
            WorkspaceUpdateError,
        );
    });
});

describe("WorkspaceUpdater.resolve", () => {
    beforeEach(async () => {
        put(coreDir, "a.md", "base\n");
        await updater(true).sync("1.0.0");
        put(workspaceDir, "a.md", "mine\n");
        put(coreDir, "a.md", "theirs\n");
    });

    it("use_template writes the template and commits", async () => {
        const result = await updater(true).resolve("a.md", "use_template", "take new wording");
        assert.equal(result.action, "written");
        assert.equal(live("a.md"), "theirs\n");
        assert.notEqual(result.commit, null);
        const [last] = await git.log({ fs, dir: workspaceDir, depth: 1 });
        assert.match(last.commit.message, /a\.md \(use_template\) — take new wording/);
        assert.deepEqual(updater().status().pending, []);
    });

    it("accept_live keeps the file and advances the base", async () => {
        const result = await updater(true).resolve("a.md", "accept_live", "keep customization");
        assert.equal(result.action, "unchanged");
        assert.equal(live("a.md"), "mine\n");
        assert.deepEqual(updater().status().pending, []);
    });

    it("refuses a path without an open decision", async () => {
        await assert.rejects(
            updater().resolve("nope.md", "accept_live", "x"),
            (err: unknown) => err instanceof WorkspaceUpdateError && err.code === "NotPending",
        );
    });
});

describe("WorkspaceGit", () => {
    it("lists .git in .stignore for a Syncthing folder and snapshots edits", async () => {
        put(workspaceDir, ".stfolder/.keep", "");
        put(workspaceDir, "notes.md", "hello\n");
        const repo = new WorkspaceGit(workspaceDir);
        assert.equal(await repo.ensureRepository(), true);
        assert.match(readFileSync(path.join(workspaceDir, ".stignore"), "utf8"), /^\.git$/m);
        assert.notEqual(await repo.commitAll("snapshot"), null);
        assert.equal(await repo.commitAll("nothing"), null);
        rmSync(path.join(workspaceDir, "notes.md"));
        assert.notEqual(await repo.commitPaths(["notes.md"], "delete"), null);
    });
});
