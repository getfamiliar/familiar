import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { lintConfigFile } from "./ConfigLinter.js";

/** Per-test scratch directory; kept tiny to keep tests fast. */
let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "ea-config-lint-"));
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

function write(content: string): string {
    const filePath = path.join(scratch, "config.yml");
    writeFileSync(filePath, content, "utf-8");
    return filePath;
}

describe("ConfigLinter — happy path", () => {
    it("accepts a minimal valid config", () => {
        const file = write(`
core:
  postgresPassword: secret
  defaultChatChannel: cli
inference:
  provider: featherless
  defaultModel: zai-org/GLM-5.1
  apiKeys:
    featherless: REAL_KEY
`);
        const result = lintConfigFile(file);
        assert.equal(result.ok, true);
        assert.deepEqual(result.errors, []);
    });
});

describe("ConfigLinter — failure modes", () => {
    it("flags a missing file with a copy-the-example hint", () => {
        const result = lintConfigFile(path.join(scratch, "nope.yml"));
        assert.equal(result.ok, false);
        assert.match(result.errors[0] ?? "", /Config file not found/);
        assert.match(result.errors[0] ?? "", /config\.example\.yml/);
    });

    it("flags malformed YAML", () => {
        const file = write("core: [::: broken");
        const result = lintConfigFile(file);
        assert.equal(result.ok, false);
        assert.match(result.errors[0] ?? "", /YAML parse error/);
    });

    it("flags a YAML root that isn't a mapping", () => {
        const file = write("- one\n- two\n");
        const result = lintConfigFile(file);
        assert.equal(result.ok, false);
        assert.match(result.errors[0] ?? "", /must be a YAML mapping/);
    });

    it("collects every missing required key in a single pass", () => {
        const file = write("inference:\n  provider: featherless\n");
        const result = lintConfigFile(file);
        assert.equal(result.ok, false);
        // Three keys missing: core.postgresPassword, core.defaultChatChannel,
        // inference.defaultModel, inference.apiKeys.featherless.
        assert.equal(result.errors.length >= 3, true);
        assert.ok(
            result.errors.some((e) => e.includes("core.postgresPassword")),
            `expected an error for core.postgresPassword in: ${JSON.stringify(result.errors)}`,
        );
    });

    it("flags inference.apiKeys.<provider> when provider is set but key missing", () => {
        const file = write(`
core:
  postgresPassword: secret
  defaultChatChannel: cli
inference:
  provider: featherless
  defaultModel: zai-org/GLM-5.1
`);
        const result = lintConfigFile(file);
        assert.equal(result.ok, false);
        assert.ok(
            result.errors.some((e) => e.includes("inference.apiKeys.featherless")),
            `expected api-key error in: ${JSON.stringify(result.errors)}`,
        );
    });

    it("warns (not errors) when logRetentionDays is malformed", () => {
        const file = write(`
core:
  postgresPassword: secret
  defaultChatChannel: cli
  logRetentionDays: -3
inference:
  provider: featherless
  defaultModel: zai-org/GLM-5.1
  apiKeys:
    featherless: REAL_KEY
`);
        const result = lintConfigFile(file);
        assert.equal(result.ok, true);
        assert.equal(
            result.warnings.some((w) => w.includes("logRetentionDays")),
            true,
        );
    });
});
