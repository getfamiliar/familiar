import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { StorageError } from "@getfamiliar/shared";
import { FakeStorageProvider } from "@getfamiliar/shared/testing";
import { decodeCursor, encodeCursor } from "./StorageService.js";
import { hasCode, makeStorageHarness } from "./StorageTestHarness.js";

const RW = {
    allowWrite: true,
    mounts: { m: { plugin: "fake", account: "a@x", access: "readwrite" } },
};

describe("StorageService — ref resolution", () => {
    it("resolves path, root and id refs", async () => {
        const h = await makeStorageHarness(RW);
        const id = h.fake.seed("a@x", null, "/Docs/a.txt", { content: "A" });
        const byPath = await h.service.stat("m:/Docs/a.txt");
        assert.equal(byPath.item.realId, id);
        assert.equal(byPath.item.path, "/Docs/a.txt");
        const byId = await h.service.stat(`m#${id}`);
        assert.equal(byId.item.path, "/Docs/a.txt");
        const root = await h.service.stat("m:/");
        assert.equal(root.item.kind, "folder");
        assert.equal(root.item.path, "/");
    });

    it("rejects malformed refs", async () => {
        const h = await makeStorageHarness(RW);
        for (const bad of ["", "m", "m:Docs", ":/x", "m#", "m:/a/../b", "a b:/x"]) {
            await assert.rejects(
                h.service.stat(bad),
                hasCode("BadRef"),
                `ref ${JSON.stringify(bad)}`,
            );
        }
        await assert.rejects(h.service.stat("nope:/x"), hasCode("UnknownMount"));
        await assert.rejects(h.service.stat("m:/missing"), hasCode("NotFound"));
    });

    it("walks the tree for id-addressed providers and reports AmbiguousPath", async () => {
        const h = await makeStorageHarness(RW, { flavor: "gdrive" });
        const a = h.fake.seed("a@x", null, "/Tax/doc.pdf");
        h.fake.seed("a@x", null, "/Tax/doc.pdf");
        await assert.rejects(h.service.stat("m:/Tax/doc.pdf"), (err: Error) => {
            assert.ok(hasCode("AmbiguousPath")(err));
            assert.match(err.message, new RegExp(`m#${a}`));
            assert.match(err.message, /modified/);
            return true;
        });
        const other = h.fake.seed("a@x", null, "/Tax/other.pdf");
        const found = await h.service.stat("m:/Tax/other.pdf");
        assert.equal(found.item.realId, other);
        // id refs get their path from the parent walk
        assert.equal((await h.service.stat(`m#${other}`)).item.path, "/Tax/other.pdf");
    });
});

describe("StorageService — policy", () => {
    it("denies every mutation while storage.allowWrite is false, even on readwrite mounts", async () => {
        const h = await makeStorageHarness({ ...RW, allowWrite: false });
        const id = h.fake.seed("a@x", null, "/Familiar/x.txt");
        const denied = (err: Error) =>
            hasCode("PolicyDenied")(err) && /storage\.allowWrite/.test(err.message);
        await assert.rejects(
            h.service.write({ ref: "m:/Familiar/n.txt", content: "x" }, h.ctx),
            denied,
        );
        await assert.rejects(h.service.mkdir("m:/Familiar/d"), denied);
        await assert.rejects(h.service.move({ ref: `m#${id}`, newName: "y.txt" }), denied);
        await assert.rejects(
            h.service.copy({ ref: `m#${id}`, toFolder: "m:/Familiar" }, h.ctx),
            denied,
        );
        await assert.rejects(h.service.delete({ ref: `m#${id}` }), denied);
        const mounts = await h.service.listMounts();
        assert.equal(mounts[0]?.access, "read");
        assert.equal(mounts[0]?.writeRoots, undefined);
    });

    it("denies writes on read-only mounts and outside writeRoots", async () => {
        const h = await makeStorageHarness({
            allowWrite: true,
            mounts: { ro: { plugin: "fake", account: "a@x" } },
        });
        await assert.rejects(
            h.service.write({ ref: "ro:/Familiar/a.txt", content: "x" }, h.ctx),
            (err: Error) => hasCode("PolicyDenied")(err) && /read-only/.test(err.message),
        );
        h.raw = RW;
        await assert.rejects(
            h.service.write({ ref: "m:/Elsewhere/a.txt", content: "x" }, h.ctx),
            (err: Error) =>
                hasCode("PolicyDenied")(err) && /outside the writable roots/.test(err.message),
        );
        const ok = await h.service.write({ ref: "m:/Familiar/sub/a.txt", content: "x" }, h.ctx);
        assert.equal(ok.written.item.path, "/Familiar/sub/a.txt");
        assert.equal((await h.service.listMounts())[0]?.access, "readwrite");
    });

    it("denies a move whose destination leaves the writable roots", async () => {
        const h = await makeStorageHarness(RW);
        const id = h.fake.seed("a@x", null, "/Familiar/x.txt");
        h.fake.seed("a@x", null, "/Public", { kind: "folder" });
        await assert.rejects(
            h.service.move({ ref: `m#${id}`, toFolder: "m:/Public" }),
            hasCode("PolicyDenied"),
        );
        const src = h.fake.seed("a@x", null, "/Public/y.txt");
        await assert.rejects(
            h.service.move({ ref: `m#${src}`, toFolder: "m:/Familiar" }),
            hasCode("PolicyDenied"),
        );
        const moved = await h.service.move({ ref: `m#${id}`, newName: "renamed.txt" });
        assert.equal(moved.item.path, "/Familiar/renamed.txt");
    });

    it("checks only the target for copies, including cross-mount", async () => {
        const h = await makeStorageHarness(
            {
                allowWrite: true,
                mounts: {
                    src: { plugin: "fake", account: "a@x", access: "read" },
                    dst: { plugin: "fake", account: "a@x", drive: "team", access: "readwrite" },
                    ro: { plugin: "fake", account: "a@x", drive: "ro" },
                },
            },
            {
                accounts: {
                    "a@x": [
                        { selector: null, name: "Primary" },
                        { selector: "team", name: "Team" },
                        { selector: "ro", name: "RO" },
                    ],
                },
            },
        );
        const id = h.fake.seed("a@x", null, "/Private/report.pdf", { content: "PDF" });
        h.fake.seed("a@x", "team", "/Familiar", { kind: "folder" });
        h.fake.seed("a@x", "team", "/Other", { kind: "folder" });
        h.fake.seed("a@x", "ro", "/Familiar", { kind: "folder" });
        await assert.rejects(
            h.service.copy({ ref: `src#${id}`, toFolder: "ro:/Familiar" }, h.ctx),
            hasCode("PolicyDenied"),
        );
        await assert.rejects(
            h.service.copy({ ref: `src#${id}`, toFolder: "dst:/Other" }, h.ctx),
            hasCode("PolicyDenied"),
        );
        const copied = await h.service.copy({ ref: `src#${id}`, toFolder: "dst:/Familiar" }, h.ctx);
        assert.equal(copied.copied.item.path, "/Familiar/report.pdf");
        assert.equal(h.fake.contentOf("a@x", "team", copied.copied.item.realId), "PDF");
        assert.equal(copied.bytes, 3);
    });

    it("refuses cross-mount moves with a copy+delete hint", async () => {
        const h = await makeStorageHarness(
            {
                allowWrite: true,
                mounts: {
                    a: { plugin: "fake", account: "a@x", access: "readwrite" },
                    b: { plugin: "fake", account: "a@x", drive: "team", access: "readwrite" },
                },
            },
            {
                accounts: {
                    "a@x": [
                        { selector: null, name: "P" },
                        { selector: "team", name: "T" },
                    ],
                },
            },
        );
        const id = h.fake.seed("a@x", null, "/Familiar/x.txt");
        h.fake.seed("a@x", "team", "/Familiar", { kind: "folder" });
        await assert.rejects(
            h.service.move({ ref: `a#${id}`, toFolder: "b:/Familiar" }),
            (err: Error) => hasCode("CrossMountMove")(err) && /storage_copy/.test(err.message),
        );
    });

    it("trashes, never hard-deletes, and reports Unsupported without trash", async () => {
        const h = await makeStorageHarness(RW);
        const id = h.fake.seed("a@x", null, "/Familiar/x.txt");
        await h.service.delete({ ref: `m#${id}` });
        assert.equal(h.fake.isTrashed("a@x", null, id), true);
        const noTrash = await makeStorageHarness(RW, { trash: false });
        const id2 = noTrash.fake.seed("a@x", null, "/Familiar/x.txt");
        await assert.rejects(noTrash.service.delete({ ref: `m#${id2}` }), hasCode("Unsupported"));
        assert.equal(noTrash.fake.isTrashed("a@x", null, id2), false);
    });
});

describe("StorageService — storage_write conflict matrix", () => {
    it("creates new files (and missing parents)", async () => {
        const h = await makeStorageHarness(RW);
        const r = await h.service.write({ ref: "m:/Familiar/a/b/new.md", content: "hi" }, h.ctx);
        assert.equal(r.bytes, 2);
        assert.equal(h.fake.contentOf("a@x", null, r.written.item.realId), "hi");
    });

    it("refuses to overwrite an existing file without if_revision", async () => {
        const h = await makeStorageHarness(RW);
        h.fake.seed("a@x", null, "/Familiar/r.md", { content: "old" });
        await assert.rejects(
            h.service.write({ ref: "m:/Familiar/r.md", content: "new" }, h.ctx),
            (err: Error) =>
                hasCode("NameConflict")(err) &&
                /exists \(rev 1\).*if_revision.*conflict=rename/.test(err.message),
        );
    });

    it("replaces with the correct revision and rejects a stale one", async () => {
        const h = await makeStorageHarness(RW);
        const id = h.fake.seed("a@x", null, "/Familiar/r.md", { content: "old" });
        const r = await h.service.write({ ref: `m#${id}`, content: "new", ifRevision: "1" }, h.ctx);
        assert.equal(r.written.item.realId, id);
        assert.equal(r.written.item.revision, "2");
        await assert.rejects(
            h.service.write({ ref: "m:/Familiar/r.md", content: "newer", ifRevision: "1" }, h.ctx),
            (err: Error) =>
                hasCode("RevisionMismatch")(err) && /re-read the item/.test(err.message),
        );
        assert.equal(h.fake.contentOf("a@x", null, id), "new");
    });

    it("keeps both with conflict=rename", async () => {
        const h = await makeStorageHarness(RW);
        const id = h.fake.seed("a@x", null, "/Familiar/r.md", { content: "old" });
        const r = await h.service.write(
            { ref: "m:/Familiar/r.md", content: "new", conflict: "rename" },
            h.ctx,
        );
        assert.notEqual(r.written.item.realId, id);
        assert.equal(r.written.item.name, "r 1.md");
        assert.equal(h.fake.contentOf("a@x", null, id), "old");
    });

    it("refuses to overwrite native docs", async () => {
        const h = await makeStorageHarness(RW, { flavor: "gdrive" });
        const id = h.fake.seed("a@x", null, "/Familiar/Doc", {
            kind: "native",
            mimeType: "application/vnd.google-apps.document",
        });
        await assert.rejects(
            h.service.write({ ref: `m#${id}`, content: "x", ifRevision: "1" }, h.ctx),
            (err: Error) => hasCode("Unsupported")(err) && /\.docx/.test(err.message),
        );
    });

    it("requires exactly one of content / scratch_path", async () => {
        const h = await makeStorageHarness(RW);
        await assert.rejects(h.service.write({ ref: "m:/Familiar/a" }, h.ctx), hasCode("BadArgs"));
        await assert.rejects(
            h.service.write(
                { ref: "m:/Familiar/a", content: "x", scratchPath: "/scratch/evt-1/a" },
                h.ctx,
            ),
            hasCode("BadArgs"),
        );
    });
});

describe("StorageService — scratch", () => {
    it("uploads from scratch and rejects escapes", async () => {
        const h = await makeStorageHarness(RW);
        const eventDir = path.join(h.scratchDir, h.eventId);
        await writeFile(path.join(eventDir, "report.md"), "from scratch");
        const r = await h.service.write(
            { ref: "m:/Familiar/report.md", scratchPath: "/scratch/evt-1/report.md" },
            h.ctx,
        );
        assert.equal(h.fake.contentOf("a@x", null, r.written.item.realId), "from scratch");

        await mkdir(path.join(h.scratchDir, "evt-2"), { recursive: true });
        await writeFile(path.join(h.scratchDir, "evt-2", "secret"), "other event");
        await writeFile(path.join(h.scratchDir, "..", "outside"), "host file");
        await symlink(path.join(h.scratchDir, "..", "outside"), path.join(eventDir, "link"));
        await mkdir(path.join(eventDir, "dir"));
        for (const bad of [
            "/scratch/evt-1/../evt-2/secret",
            "/scratch/evt-2/secret",
            "/etc/passwd",
            "/scratch/evt-1/link",
            "/scratch/evt-1/dir",
            "/scratch/evt-1/missing",
        ]) {
            await assert.rejects(
                h.service.write({ ref: "m:/Familiar/x", scratchPath: bad }, h.ctx),
                hasCode("BadScratchPath"),
                bad,
            );
        }
    });

    it("downloads into storage/<mount>/ with dedup and partial success", async () => {
        const h = await makeStorageHarness(RW);
        const a = h.fake.seed("a@x", null, "/A/same.txt", { content: "one" });
        const b = h.fake.seed("a@x", null, "/B/same.txt", { content: "two" });
        h.fake.seed("a@x", null, "/Folder", { kind: "folder" });
        const out = await h.service.download([`m#${a}`, `m#${b}`, "m:/Folder", "m:/nope"], h.ctx);
        assert.equal(out.length, 4);
        assert.deepEqual(
            out.map((o) => (o.ok ? o.path : o.error.split(" ")[0])),
            [
                "/scratch/evt-1/storage/m/same.txt",
                "/scratch/evt-1/storage/m/same (2).txt",
                "m:/Folder",
                "m:/nope",
            ],
        );
        const hostPath = path.join(h.scratchDir, "evt-1", "storage", "m", "same (2).txt");
        assert.equal(await readFile(hostPath, "utf8"), "two");
    });
});

describe("StorageService — native docs", () => {
    it("exports mapped native types and reports Unsupported otherwise", async () => {
        const h = await makeStorageHarness(RW, { flavor: "gdrive" });
        const doc = h.fake.seed("a@x", null, "/Plan", {
            kind: "native",
            mimeType: "application/vnd.google-apps.spreadsheet",
        });
        const form = h.fake.seed("a@x", null, "/Form", {
            kind: "native",
            mimeType: "application/vnd.google-apps.form",
        });
        const [ok, bad] = await h.service.download([`m#${doc}`, `m#${form}`], h.ctx);
        assert.ok(ok?.ok && ok.path.endsWith("/Plan.xlsx"));
        assert.ok(bad && !bad.ok && /fake: native type/.test(bad.error));
    });
});

describe("StorageService — search fan-out", () => {
    it("reports a timed-out and a throwing mount while returning the others", async () => {
        const registryFakes = {
            fast: new FakeStorageProvider({ pluginId: "fast" }),
            slow: new FakeStorageProvider({ pluginId: "slow", searchDelayMs: 500 }),
            broken: new FakeStorageProvider({
                pluginId: "broken",
                searchError: new StorageError("ProviderUnavailable", "boom"),
            }),
        };
        const h = await makeStorageHarness({
            searchTimeoutMs: 50,
            mounts: {
                fast: { plugin: "fast", account: "a@x" },
                slow: { plugin: "slow", account: "a@x" },
                broken: { plugin: "broken", account: "a@x" },
            },
        });
        for (const p of Object.values(registryFakes)) {
            h.registry.registerProvider(p);
        }
        registryFakes.fast.seed("a@x", null, "/Budget 2026.xlsx");
        const result = await h.service.search({ text: "budget", limit: 25 });
        assert.deepEqual(
            result.hits.map((x) => x.mount),
            ["fast"],
        );
        assert.equal(result.hits[0]?.matchedIn, "name");
        const reasons = Object.fromEntries(result.failed.map((f) => [f.mount, f.reason]));
        assert.match(reasons.slow ?? "", /timed out/);
        assert.match(reasons.broken ?? "", /boom/);
    });

    it("round-trips the composite cursor and applies post-filters", async () => {
        const h = await makeStorageHarness({
            mounts: {
                m: { plugin: "fake", account: "a@x" },
                hidden: { plugin: "fake", account: "a@x", searchByDefault: false },
            },
        });
        for (let i = 0; i < 5; i++) {
            h.fake.seed("a@x", null, `/Reports/report-${i}.pdf`, { mimeType: "application/pdf" });
        }
        h.fake.seed("a@x", null, "/Reports/report-notes.txt", { mimeType: "text/plain" });
        const first = await h.service.search({
            text: "report",
            limit: 4,
            mimePrefix: "application/pdf",
        });
        assert.deepEqual(first.searched, ["m"]);
        assert.ok(first.nextCursor);
        assert.deepEqual(Object.keys(decodeCursor(first.nextCursor)), ["m"]);
        const second = await h.service.search({
            text: "report",
            limit: 4,
            cursor: first.nextCursor,
            mimePrefix: "application/pdf",
        });
        const all = [...first.hits, ...second.hits].map((x) => x.item.name);
        assert.ok(all.every((n) => n.endsWith(".pdf")));
        assert.equal(new Set(all).size, 5);
        assert.equal(second.nextCursor, null);
        assert.throws(() => decodeCursor("not-a-cursor"), hasCode("BadCursor"));
        assert.deepEqual(decodeCursor(encodeCursor({ a: "1", b: "x" })), { a: "1", b: "x" });
    });

    it("filters by modified range", async () => {
        const h = await makeStorageHarness({ mounts: { m: { plugin: "fake", account: "a@x" } } });
        h.fake.seed("a@x", null, "/old-note.txt");
        h.fake.seed("a@x", null, "/new-note.txt");
        const stat = await h.service.stat("m:/new-note.txt");
        const result = await h.service.search({
            text: "note",
            limit: 10,
            modifiedFromUtc: stat.item.modifiedUtc ?? undefined,
        });
        assert.deepEqual(
            result.hits.map((x) => x.item.name),
            ["new-note.txt"],
        );
    });
});

describe("StorageService — quota", () => {
    it("rejects transfers beyond the per-run budget", async () => {
        const h = await makeStorageHarness({ ...RW, runQuotaMb: 0.00001 }); // ~10 bytes
        const id = h.fake.seed("a@x", null, "/big.txt", { content: "0123456789ABCDEF" });
        const [out] = await h.service.download([`m#${id}`], h.ctx);
        assert.ok(out && !out.ok && /budget/.test(out.error));
        await assert.rejects(
            h.service.write({ ref: "m:/Familiar/x", content: "0123456789ABCDEF" }, h.ctx),
            hasCode("QuotaExceeded"),
        );
        // another run has its own budget
        await h.service.write(
            { ref: "m:/Familiar/y", content: "tiny" },
            { ...h.ctx, agentrunId: "run-2" },
        );
        assert.equal(h.service.bytesUsed("run-2"), 4);
    });
});

describe("StorageService — mounts", () => {
    it("reports unavailable mounts with the login hint", async () => {
        const h = await makeStorageHarness(
            {
                mounts: {
                    ok: { plugin: "fake", account: "a@x" },
                    gone: { plugin: "fake", account: "b@x" },
                    noplug: { plugin: "nope", account: "a@x" },
                },
            },
            {
                accounts: {
                    "a@x": [{ selector: null, name: "P" }],
                    "b@x": [{ selector: null, name: "P" }],
                },
                expiredAccounts: ["b@x"],
            },
        );
        const rows = await h.service.listMounts();
        assert.equal(rows.find((r) => r.mount === "ok")?.available, true);
        assert.match(rows.find((r) => r.mount === "gone")?.error ?? "", /familiar fake login b@x/);
        assert.match(rows.find((r) => r.mount === "noplug")?.error ?? "", /provides no storage/);
    });
});
