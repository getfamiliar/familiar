import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeStorageProvider } from "@getfamiliar/shared/testing";
import { parseStorageSettings } from "./StorageConfig.js";
import { addCommandFor, discoverStorage } from "./StorageDiscovery.js";
import { StorageRegistry } from "./StorageRegistry.js";

describe("discoverStorage", () => {
    it("matches configured mounts against discovered drives, tolerating a failing account", async () => {
        const registry = new StorageRegistry();
        registry.registerProvider(
            new FakeStorageProvider({
                pluginId: "fake",
                accounts: {
                    "a@x": [
                        { selector: null, name: "OneDrive" },
                        { selector: "sites/Team/Docs", name: "Team / Docs" },
                    ],
                    "b@x": [{ selector: null, name: "OneDrive" }],
                    "c@x": [{ selector: null, name: "OneDrive" }],
                },
                brokenAccounts: ["b@x"],
                expiredAccounts: ["c@x"],
            }),
        );
        const settings = parseStorageSettings({
            mounts: {
                mine: { plugin: "fake", account: "a@x" },
                gone: { plugin: "fake", account: "a@x", drive: "sites/Nope/Docs" },
                stranger: { plugin: "fake", account: "z@x" },
                old: { plugin: "fake", account: "c@x" },
                other: { plugin: "nope", account: "a@x" },
            },
        });
        const rows = await discoverStorage(registry, settings.mounts, { limit: 50 });
        const byKey = (alias: string | null, account: string) =>
            rows.find((r) => r.alias === alias && r.account === account);
        assert.equal(byKey("mine", "a@x")?.status, "mounted");
        assert.equal(byKey("gone", "a@x")?.status, "unreachable");
        assert.equal(byKey("stranger", "z@x")?.status, "unknown-account");
        assert.match(byKey("stranger", "z@x")?.note ?? "", /familiar fake login z@x/);
        assert.equal(byKey("old", "c@x")?.status, "auth-expired");
        assert.match(byKey("other", "a@x")?.note ?? "", /provides no storage/);
        // the team drive is discovered but not configured
        const available = rows.filter((r) => r.status === "available");
        assert.deepEqual(
            available.map((r) => [r.account, r.selector]),
            [["a@x", "sites/Team/Docs"]],
        );
        assert.equal(
            addCommandFor(available[0] as never),
            "familiar storage add fake a@x --drive sites/Team/Docs --as <alias>",
        );
        // the broken account gets its own error row; the expired one is reported once (by its mount)
        assert.equal(byKey(null, "b@x")?.status, "error");
        assert.equal(rows.filter((r) => r.account === "c@x").length, 1);
    });

    it("narrows by plugin, account and drive name", async () => {
        const registry = new StorageRegistry();
        registry.registerProvider(
            new FakeStorageProvider({
                pluginId: "fake",
                accounts: {
                    "a@x": [
                        { selector: null, name: "OneDrive" },
                        { selector: "sites/Team/Docs", name: "Team / Docs" },
                    ],
                    "b@x": [{ selector: null, name: "OneDrive" }],
                },
            }),
        );
        const rows = await discoverStorage(registry, [], {
            account: "A@X",
            search: "team",
            limit: 50,
        });
        assert.deepEqual(
            rows.map((r) => r.driveName),
            ["Team / Docs"],
        );
        assert.deepEqual(await discoverStorage(registry, [], { plugin: "other", limit: 50 }), []);
    });
});
