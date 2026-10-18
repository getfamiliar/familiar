import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HostConfigService } from "./ConfigService.js";

let scratch: string;
let file: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-config-service-"));
    file = path.join(scratch, "config.yml");
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

describe("HostConfigService.reload", () => {
    it("swaps the cached state so lazy readers see new values", () => {
        writeFileSync(file, "mail:\n  allowSend: false\n");
        const config = new HostConfigService(file);
        assert.equal(config.getBool("mail.allowSend"), false);
        writeFileSync(file, "mail:\n  allowSend: true\n");
        assert.equal(config.getBool("mail.allowSend"), false, "cached until reload");
        config.reload();
        assert.equal(config.getBool("mail.allowSend"), true);
    });

    it("keeps pinned keys at their previous value, including previously absent ones", () => {
        writeFileSync(file, "core:\n  postgresPassword: old\n");
        const config = new HostConfigService(file);
        assert.equal(config.getString("core.postgresPassword"), "old");
        writeFileSync(
            file,
            "core:\n  postgresPassword: new\n  bastionToken: tok\n  timezone: UTC\n",
        );
        const { previous, current } = config.reload(["core.postgresPassword", "core.bastionToken"]);
        assert.equal(config.getString("core.postgresPassword"), "old");
        assert.equal(config.getString("core.bastionToken", null), null);
        assert.equal(config.getString("core.timezone"), "UTC");
        assert.deepEqual(previous, { core: { postgresPassword: "old" } });
        assert.equal(current, config.snapshot());
    });

    it("throws on a malformed file and keeps the previous state", () => {
        writeFileSync(file, "a: 1\n");
        const config = new HostConfigService(file);
        assert.equal(config.getNumber("a"), 1);
        writeFileSync(file, "a: [unclosed\n");
        assert.throws(() => config.reload());
        assert.equal(config.getNumber("a"), 1);
    });
});
