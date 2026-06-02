import { strict as assert } from "node:assert";
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { canonicalMode, isWritablePath, normalizeAll } from "./PermissionNormalizer.js";

const GLOBS = ["wiki/**", "files/**"];

describe("isWritablePath", () => {
    it("treats writable-glob directories (tested as rel + '/') as writable", () => {
        assert.equal(isWritablePath("files", true, GLOBS), true);
        assert.equal(isWritablePath("wiki", true, GLOBS), true);
        assert.equal(isWritablePath("files/sub", true, GLOBS), true);
    });

    it("treats files under writable globs as writable, others as protected", () => {
        assert.equal(isWritablePath("files/data.txt", false, GLOBS), true);
        assert.equal(isWritablePath("wiki/a.md", false, GLOBS), true);
        assert.equal(isWritablePath("mail/index.md", false, GLOBS), false);
        assert.equal(isWritablePath("data.json", false, GLOBS), false);
    });

    it("treats non-writable directories and the workspace root as protected", () => {
        assert.equal(isWritablePath("mail", true, GLOBS), false);
        assert.equal(isWritablePath("", true, GLOBS), false);
    });

    it("does not let a glob prefix-match an unrelated sibling", () => {
        assert.equal(isWritablePath("files-secret/x", false, GLOBS), false);
    });
});

describe("canonicalMode", () => {
    it("maps (writable, isDir) → octal mode", () => {
        assert.equal(canonicalMode(false, true), 0o2750);
        assert.equal(canonicalMode(true, true), 0o2770);
        assert.equal(canonicalMode(false, false), 0o640);
        assert.equal(canonicalMode(true, false), 0o660);
    });
});

describe("normalizeAll", () => {
    let root: string;
    let workspaceDir: string;
    let scratchDir: string;
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;

    before(() => {
        root = mkdtempSync(path.join(tmpdir(), "familiar-normalize-"));
        workspaceDir = path.join(root, "workspace");
        scratchDir = path.join(root, "scratch");
        mkdirSync(path.join(workspaceDir, "mail"), { recursive: true });
        mkdirSync(path.join(workspaceDir, "files"), { recursive: true });
        mkdirSync(path.join(scratchDir, "evt1"), { recursive: true });
        writeFileSync(path.join(workspaceDir, "mail", "index.md"), "handler", "utf8");
        writeFileSync(path.join(workspaceDir, "files", "data.txt"), "data", "utf8");
        writeFileSync(path.join(scratchDir, "evt1", "tmp.json"), "{}", "utf8");
        // An unpriv-style symlink from a writable dir into a protected file.
        symlinkSync(
            path.join(workspaceDir, "mail", "index.md"),
            path.join(workspaceDir, "files", "evil-link"),
        );

        normalizeAll(
            { ownerUid: uid, ownerGid: gid, writablePaths: GLOBS },
            { workspaceRoot: workspaceDir, scratchRoot: scratchDir },
        );
    });

    after(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("stamps protected dirs 2750 / files 640", () => {
        assert.equal(statSync(path.join(workspaceDir, "mail")).mode & 0o7777, 0o2750);
        assert.equal(statSync(path.join(workspaceDir, "mail", "index.md")).mode & 0o7777, 0o640);
    });

    it("stamps writable dirs 2770 / files 660", () => {
        assert.equal(statSync(path.join(workspaceDir, "files")).mode & 0o7777, 0o2770);
        assert.equal(statSync(path.join(workspaceDir, "files", "data.txt")).mode & 0o7777, 0o660);
    });

    it("treats the whole scratch tree as writable", () => {
        assert.equal(statSync(scratchDir).mode & 0o7777, 0o2770);
        assert.equal(statSync(path.join(scratchDir, "evt1", "tmp.json")).mode & 0o7777, 0o660);
    });

    it("does not follow symlinks: the link stays a link, its target keeps its own mode", () => {
        const link = path.join(workspaceDir, "files", "evil-link");
        assert.equal(lstatSync(link).isSymbolicLink(), true);
        // The protected target was normalized via its real path (640), NOT
        // re-permissioned through the writable-dir symlink.
        assert.equal(statSync(path.join(workspaceDir, "mail", "index.md")).mode & 0o7777, 0o640);
    });
});
