import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BuiltAuthPages } from "./BuiltAuthPages.js";

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-web-ui-ssr-"));
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

describe("BuiltAuthPages", () => {
    it("renders through the bundle's renderAuthPage export", async () => {
        const bundle = path.join(scratch, "render-auth-page.js");
        writeFileSync(
            bundle,
            "export async function renderAuthPage(view) { return 'page ' + view.kind; }",
        );
        const pages = new BuiltAuthPages(bundle);
        assert.equal(
            await pages.renderAuthPage({ kind: "signedOut", loginCommand: "familiar web login" }),
            "page signedOut",
        );
    });

    it("explains a missing bundle and retries once it exists", async () => {
        const bundle = path.join(scratch, "render-auth-page.js");
        const pages = new BuiltAuthPages(bundle);
        const view = { kind: "invalidLoginLink", loginCommand: "familiar web login" } as const;
        await assert.rejects(pages.renderAuthPage(view), /npm run build/);
        writeFileSync(bundle, "export async function renderAuthPage() { return 'late'; }");
        assert.equal(await pages.renderAuthPage(view), "late");
    });

    it("rejects a bundle without the export", async () => {
        const bundle = path.join(scratch, "render-auth-page.js");
        writeFileSync(bundle, "export const nothing = 1;");
        await assert.rejects(
            new BuiltAuthPages(bundle).renderAuthPage({ kind: "signedOut", loginCommand: "x" }),
            /does not export renderAuthPage/,
        );
    });
});
