import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { runStorageProviderContract } from "@getfamiliar/shared/testing";
import { DEFAULT_APP } from "../auth/AppRegistration.js";
import { LoginStore, loginDirectory } from "../auth/LoginStore.js";
import { GraphError } from "../graph/GraphHttp.js";
import {
    Ms365StorageProvider,
    parentPathOf,
    siteSelectorPrefix,
    toStorageError,
    toStorageItem,
} from "./Ms365StorageProvider.js";

describe("toStorageItem", () => {
    it("maps a file with hashes, path and revision", () => {
        const item = toStorageItem({
            id: "F1",
            name: "Bescheid.pdf",
            size: 1234,
            file: {
                mimeType: "application/pdf",
                hashes: { quickXorHash: "qx==", sha1Hash: "abc" },
            },
            parentReference: { id: "P1", driveId: "D", path: "/drives/D/root:/Steuer/2025" },
            createdDateTime: "2026-01-01T10:00:00Z",
            lastModifiedDateTime: "2026-03-14T08:12:04Z",
            lastModifiedBy: { user: { displayName: "Steffen" } },
            eTag: '"{ABC},3"',
            webUrl: "https://example/Bescheid.pdf",
            shared: {},
        });
        assert.deepEqual(item, {
            realId: "F1",
            parentRealId: "P1",
            name: "Bescheid.pdf",
            path: "/Steuer/2025/Bescheid.pdf",
            kind: "file",
            mimeType: "application/pdf",
            size: 1234,
            createdUtc: "2026-01-01T10:00:00Z",
            modifiedUtc: "2026-03-14T08:12:04Z",
            modifiedBy: "Steffen",
            revision: '"{ABC},3"',
            contentHash: { algo: "quickXor", value: "qx==" },
            webUrl: "https://example/Bescheid.pdf",
            isShared: true,
        });
    });

    it("maps the root, top-level folders and packages", () => {
        const root = toStorageItem({ id: "R", name: "root", root: {}, folder: {} });
        assert.equal(root.path, "/");
        assert.equal(root.kind, "folder");
        assert.equal(root.parentRealId, null);
        const top = toStorageItem({
            id: "T",
            name: "Familiar",
            folder: { childCount: 0 },
            parentReference: { id: "R", path: "/drive/root:" },
        });
        assert.equal(top.path, "/Familiar");
        assert.equal(top.size, null);
        const notebook = toStorageItem({ id: "N", name: "Notes", package: { type: "oneNote" } });
        assert.equal(notebook.kind, "native");
        assert.equal(notebook.path, null);
    });
});

describe("path and selector helpers", () => {
    it("parses parentReference paths, decoding percent escapes", () => {
        assert.equal(parentPathOf("/drive/root:"), "/");
        assert.equal(parentPathOf("/drives/b!x/root:/A%20B/C"), "/A B/C");
        assert.equal(parentPathOf(undefined), null);
        assert.equal(parentPathOf("/drives/x/items/y"), null);
    });

    it("derives site selector prefixes from web URLs", () => {
        assert.equal(
            siteSelectorPrefix({ id: "1", webUrl: "https://t.sharepoint.com/sites/Verwaltung" }),
            "sites/Verwaltung",
        );
        assert.equal(
            siteSelectorPrefix({ id: "2", webUrl: "https://t.sharepoint.com/teams/Sales%20DE" }),
            "teams/Sales DE",
        );
        assert.equal(siteSelectorPrefix({ id: "3", webUrl: "https://t.sharepoint.com" }), "root");
        assert.equal(
            siteSelectorPrefix({ id: "4", webUrl: "https://t.sharepoint.com/sites/a/sub" }),
            null,
        );
    });
});

describe("toStorageError", () => {
    it("maps Graph statuses onto normalized codes", () => {
        const cases: [number, string][] = [
            [401, "AuthExpired"],
            [404, "NotFound"],
            [409, "NameConflict"],
            [412, "RevisionMismatch"],
            [429, "RateLimited"],
            [507, "QuotaExceeded"],
            [503, "ProviderUnavailable"],
            [403, "ProviderUnavailable"],
        ];
        for (const [status, code] of cases) {
            const body = JSON.stringify({ error: { code: "x", message: `status ${status}` } });
            assert.equal(
                toStorageError(new GraphError(status, "https://g", body)).code,
                code,
                String(status),
            );
        }
        assert.equal(toStorageError(new Error("socket hang up")).code, "ProviderUnavailable");
    });
});

describe("Ms365StorageProvider without login", () => {
    it("reports a missing login as AuthExpired", async () => {
        const provider = new Ms365StorageProvider(
            () => new LoginStore(path.join("/nonexistent", "auth"), DEFAULT_APP),
        );
        assert.deepEqual(await provider.listAccounts(), []);
        await assert.rejects(
            provider.openDrive("nobody@example.com", null),
            (err: Error & { code?: string }) => err.code === "AuthExpired",
        );
    });
});

// Live contract run: FAMILIAR_LIVE_MS365=<upn> [FAMILIAR_LIVE_MS365_DATA_DIR=<data dir>]
// [FAMILIAR_LIVE_MS365_BASE=/Familiar]. Writes into a throwaway folder
// under the base path and trashes it afterwards. Uses the default app
// registration.
const liveUpn = process.env.FAMILIAR_LIVE_MS365;
if (liveUpn) {
    const dataDir =
        process.env.FAMILIAR_LIVE_MS365_DATA_DIR ??
        path.resolve(import.meta.dirname, "../../../../data");
    runStorageProviderContract(
        `ms365 live (${liveUpn})`,
        () => new Ms365StorageProvider(() => new LoginStore(loginDirectory(dataDir), DEFAULT_APP)),
        {
            account: liveUpn.toLowerCase(),
            selector: process.env.FAMILIAR_LIVE_MS365_DRIVE ?? null,
            basePath: process.env.FAMILIAR_LIVE_MS365_BASE ?? "/",
            largeFileBytes: 9 * 1024 * 1024,
        },
    );
}
