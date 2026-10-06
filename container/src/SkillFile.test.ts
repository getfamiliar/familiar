import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HandlerFile } from "./HandlerFile.js";
import {
    combineToolEntries,
    formatPreloadedSkills,
    loadPreloadedSkills,
    SkillFile,
    SkillNotFoundError,
} from "./SkillFile.js";

let root: string;

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "skill-file-test-"));
    HandlerFile.setWorkspaceRoot(root);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** Write a file at a workspace-relative path, creating parents. */
function touch(rel: string, contents: string): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
}

/** Load the skill `id`, failing the test when it is missing. */
function readSkill(id: string): SkillFile {
    const skill = SkillFile.read(id);
    assert.ok(skill !== null);
    return skill;
}

test("read parses frontmatter and strips it from the body", () => {
    touch(
        "skills/jira/SKILL.md",
        "---\nname: jira\ndescription: Jira tickets.\nmodel: ignored\ntools: atlassian_*, core\n---\n\n# Jira\n\nBody.\n",
    );
    const skill = readSkill("jira");
    assert.equal(skill.relativePath, "skills/jira/SKILL.md");
    assert.equal(skill.header.description, "Jira tickets.");
    assert.deepEqual(skill.header.tools, ["atlassian_*", "core"]);
    assert.equal(skill.body, "# Jira\n\nBody.");
});

test("read returns null for a missing skill", () => {
    assert.equal(SkillFile.read("nope"), null);
});

test("loadPreloadedSkills keeps declared order, drops duplicates", () => {
    touch("skills/a/SKILL.md", "A");
    touch("skills/b/SKILL.md", "B");
    touch("mail/index.md", "---\nskills: b, a, b\n---\nbody\n");
    const skills = loadPreloadedSkills(HandlerFile.load("mail", "index"));
    assert.deepEqual(
        skills.map((skill) => skill.id),
        ["b", "a"],
    );
});

test("loadPreloadedSkills throws SkillNotFoundError for a missing skill", () => {
    touch("mail/index.md", "---\nskills: missing\n---\nbody\n");
    assert.throws(
        () => loadPreloadedSkills(HandlerFile.load("mail", "index")),
        (err: unknown) =>
            err instanceof SkillNotFoundError &&
            /skills\/missing\/SKILL\.md/.test(err.message) &&
            /mail\/index\.md/.test(err.message),
    );
});

test("combineToolEntries leaves handler tools untouched without skill tools", () => {
    touch("skills/plain/SKILL.md", "plain");
    assert.equal(combineToolEntries(undefined, [readSkill("plain")]), undefined);
    assert.deepEqual(combineToolEntries(["fs"], [readSkill("plain")]), ["fs"]);
});

test("combineToolEntries keeps the core default when the handler omits tools", () => {
    touch("skills/tesla/SKILL.md", "---\ntools: tesla_*\n---\nbody");
    assert.deepEqual(combineToolEntries(undefined, [readSkill("tesla")]), ["core", "tesla_*"]);
    assert.deepEqual(combineToolEntries([], [readSkill("tesla")]), ["core", "tesla_*"]);
});

test("combineToolEntries appends skill tools to explicit handler tools", () => {
    touch("skills/tesla/SKILL.md", "---\ntools: tesla_*, fs\n---\nbody");
    assert.deepEqual(combineToolEntries(["none"], [readSkill("tesla")]), ["none", "tesla_*", "fs"]);
    assert.deepEqual(combineToolEntries(["fs", "send_chat"], [readSkill("tesla")]), [
        "fs",
        "send_chat",
        "tesla_*",
    ]);
});

test("formatPreloadedSkills renders one h1 section per skill", () => {
    touch("skills/a/SKILL.md", "---\ndescription: A\n---\nAlpha body.");
    touch("skills/b/SKILL.md", "Beta body.");
    assert.equal(formatPreloadedSkills([]), "");
    assert.equal(
        formatPreloadedSkills([readSkill("a"), readSkill("b")]),
        "# Skill `a` (preloaded)\n\n" +
            "This is the complete content of `skills/a/SKILL.md`. It is already loaded — do not read the file again, just follow it.\n\n" +
            "Alpha body.\n\n" +
            "# Skill `b` (preloaded)\n\n" +
            "This is the complete content of `skills/b/SKILL.md`. It is already loaded — do not read the file again, just follow it.\n\n" +
            "Beta body.",
    );
});
