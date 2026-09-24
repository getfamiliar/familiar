import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { insertMapEntry, removeMapEntry, setConfigValue } from "./ConfigDocument.js";

const FIXTURE = `# Familiar config — hand-written, keep my comments!
core:
  postgresPassword: "s3cret"   # quoted on purpose
  defaultChatChannel: telegram

# ---- storage ----
storage:
  allowWrite: false
  mounts:
    # the private drive
    privat:
      plugin: ms365
      account: me@example.com

# trailing section
inference:
  defaultProvider: featherless
`;

const MOUNT = { plugin: "ms365", account: "work@example.com", access: "read" };

describe("insertMapEntry / removeMapEntry", () => {
    it("appends a mount under existing mounts and removes it byte-for-byte", () => {
        const added = insertMapEntry(FIXTURE, ["storage", "mounts"], "work", MOUNT);
        assert.ok(
            added.includes(
                "    work:\n      plugin: ms365\n      account: work@example.com\n      access: read\n",
            ),
        );
        assert.deepEqual(parse(added).storage.mounts.work, MOUNT);
        assert.equal(parse(added).storage.mounts.privat.plugin, "ms365");
        // everything before and after the inserted block is untouched
        const idx = added.indexOf("    work:");
        assert.equal(added.slice(0, idx), FIXTURE.slice(0, idx));
        assert.equal(removeMapEntry(added, ["storage", "mounts"], "work"), FIXTURE);
    });

    it("removes a middle entry without touching its neighbours", () => {
        const withTwo = insertMapEntry(FIXTURE, ["storage", "mounts"], "work", MOUNT);
        const removed = removeMapEntry(withTwo, ["storage", "mounts"], "privat");
        assert.deepEqual(Object.keys(parse(removed).storage.mounts), ["work"]);
        assert.ok(removed.startsWith(FIXTURE.slice(0, FIXTURE.indexOf("    privat:"))));
        assert.ok(
            removed.endsWith("\n# trailing section\ninference:\n  defaultProvider: featherless\n"),
        );
    });

    it("creates the storage group when missing", () => {
        const base = "core:\n  postgresPassword: x # c\n";
        const out = insertMapEntry(base, ["storage", "mounts"], "a", MOUNT);
        assert.ok(out.startsWith(base));
        assert.deepEqual(parse(out).storage.mounts.a, MOUNT);
    });

    it("creates mounts under an existing storage group and under an empty mounts key", () => {
        const noMounts = "storage:\n  allowWrite: true\nother: 1\n";
        const a = insertMapEntry(noMounts, ["storage", "mounts"], "a", MOUNT);
        assert.deepEqual(parse(a), {
            storage: { allowWrite: true, mounts: { a: MOUNT } },
            other: 1,
        });
        const emptyMounts = "storage:\n  mounts:\nother: 1\n";
        const b = insertMapEntry(emptyMounts, ["storage", "mounts"], "a", MOUNT);
        assert.deepEqual(parse(b), { storage: { mounts: { a: MOUNT } }, other: 1 });
    });

    it("refuses duplicates and missing entries", () => {
        assert.throws(
            () => insertMapEntry(FIXTURE, ["storage", "mounts"], "privat", MOUNT),
            /already exists/,
        );
        assert.throws(
            () => removeMapEntry(FIXTURE, ["storage", "mounts"], "nope"),
            /does not exist/,
        );
    });
});

describe("setConfigValue", () => {
    it("keeps comments", () => {
        const out = setConfigValue(FIXTURE, "core.defaultChatChannel", "whatsapp");
        assert.equal(parse(out).core.defaultChatChannel, "whatsapp");
        assert.ok(out.includes("# the private drive"));
        assert.ok(out.includes("# quoted on purpose"));
    });
});

describe("setConfigValue — collection style", () => {
    it("keeps a flow sequence flow", () => {
        const out = setConfigValue('a:\n  roots: ["/A/", "/A"] # keep\n', "a.roots", ["/A"]);
        assert.match(out, /roots: \[ "?\/A"? \]/);
        assert.ok(out.includes("# keep"));
    });
});
