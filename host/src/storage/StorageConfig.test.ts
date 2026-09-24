import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    lintStorageStatic,
    parseStorageSettings,
    type StorageLintFinding,
} from "./StorageConfig.js";

/** Findings as `severity alias: message` strings for compact assertions. */
function lint(raw: unknown, knownPlugins?: readonly string[]): string[] {
    return lintStorageStatic(raw, knownPlugins ? { knownPlugins } : {}).map(
        (f: StorageLintFinding) => `${f.severity} ${f.alias ?? "-"}: ${f.message}`,
    );
}

const mount = (extra: Record<string, unknown> = {}) => ({
    plugin: "ms365",
    account: "a@x",
    ...extra,
});

describe("lintStorageStatic", () => {
    it("accepts a clean config and a missing group", () => {
        assert.deepEqual(lint(undefined), []);
        assert.deepEqual(
            lint({ allowWrite: true, mounts: { a: mount({ access: "readwrite" }) } }, ["ms365"]),
            [],
        );
    });

    it("reports schema errors", () => {
        const out = lint({
            allowWrite: "yes",
            bogus: 1,
            mounts: { a: mount({ access: "write", extra: 1, searchByDefault: "no" }) },
        });
        assert.ok(out.includes("error -: unknown key `storage.bogus`"));
        assert.ok(out.includes("error -: `storage.allowWrite` must be a boolean (true / false)"));
        assert.ok(out.some((l) => l.startsWith("error a: `access` must be")));
        assert.ok(out.includes("error a: unknown key `extra`"));
        assert.ok(out.includes("error a: `searchByDefault` must be a boolean"));
        assert.ok(
            lint({ mounts: { a: { account: "x" } } }).some((l) =>
                l.includes("`plugin` is required"),
            ),
        );
        assert.ok(
            lint({ mounts: { a: { plugin: "ms365" } } }).some((l) =>
                l.includes("`account` is required"),
            ),
        );
        assert.ok(lint({ mounts: [] }).some((l) => l.includes("must be a mapping")));
    });

    it("reports unknown plugins only when the plugin list is known", () => {
        assert.deepEqual(lint({ mounts: { a: mount({ plugin: "gdrive" }) } }), []);
        assert.ok(
            lint({ mounts: { a: mount({ plugin: "gdrive" }) } }, ["ms365"])[0]?.includes(
                'unknown storage plugin "gdrive"',
            ),
        );
    });

    it("rejects aliases that break ref parsing and case-duplicates", () => {
        for (const alias of ["a:b", "a#b", "a/b", "a b"]) {
            assert.ok(
                lint({ mounts: { [alias]: mount() } }).some((l) =>
                    l.startsWith(`error ${alias}: alias must not`),
                ),
                alias,
            );
        }
        assert.ok(
            lint({ mounts: { Work: mount(), work: mount({ drive: "x" }) } }).some((l) =>
                l.includes("duplicate alias"),
            ),
        );
    });

    it("explains ineffective access and write roots", () => {
        assert.ok(
            lint({ mounts: { a: mount({ access: "readwrite" }) } }).includes(
                "info a: `access: readwrite` has no effect while `storage.allowWrite` is false",
            ),
        );
        assert.ok(
            lint({ mounts: { a: mount({ writeRoots: ["/X"] }) } }).includes(
                "warning a: `writeRoots` has no effect with `access: read`",
            ),
        );
    });

    it("checks write roots", () => {
        const out = lint({
            allowWrite: true,
            mounts: {
                a: mount({
                    access: "readwrite",
                    writeRoots: ["rel", "/A/", "/A", "/B", "/B/c", "/x/../y", "/"],
                }),
            },
        });
        assert.ok(out.includes('error a: write root "rel" must be absolute (start with /)'));
        assert.ok(out.includes('warning a: write root "/A/" is not normalized (use "/A")'));
        assert.ok(out.includes('warning a: duplicate write root "/A"'));
        assert.ok(out.includes('warning a: write root "/B/c" is nested in "/B"'));
        assert.ok(out.includes('warning a: write root "/x/../y" contains ".."'));
        assert.ok(out.includes('warning a: write root "/" makes the whole drive writable'));
    });

    it("warns about the same drive under two aliases", () => {
        assert.ok(
            lint({ mounts: { a: mount(), b: mount({ account: "A@X" }) } }).includes(
                'warning b: same plugin / account / drive as mount "a"',
            ),
        );
    });
});

describe("parseStorageSettings", () => {
    it("applies the secure defaults", () => {
        const s = parseStorageSettings({ mounts: { a: mount() } });
        assert.equal(s.allowWrite, false);
        assert.deepEqual(s.mounts[0], {
            alias: "a",
            plugin: "ms365",
            account: "a@x",
            drive: null,
            access: "read",
            writeRoots: ["/Familiar"],
            searchByDefault: true,
        });
        assert.equal(s.searchTimeoutMs, 8000);
        assert.equal(s.runQuotaBytes, 200 * 1024 * 1024);
    });
});
