import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { lintConfigFile } from "./ConfigLinter.js";

/** Per-test scratch directory; kept tiny to keep tests fast. */
let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-config-lint-"));
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
    it("accepts a minimal valid config with a native provider", () => {
        const file = write(`
core:
  postgresPassword: secret
  defaultChatChannel: cli
inference:
  defaultProvider: openai
  defaultModel: gpt-5
  apiKeys:
    openai: REAL_KEY
`);
        const result = lintConfigFile(file);
        assert.equal(result.ok, true, `unexpected errors: ${JSON.stringify(result.errors)}`);
        assert.deepEqual(result.errors, []);
    });

    it("accepts a minimal valid config with a custom provider", () => {
        const file = write(`
core:
  postgresPassword: secret
  defaultChatChannel: cli
inference:
  defaultProvider: featherless
  defaultModel: zai-org/GLM-5.1
  customProviders:
    featherless:
      baseUrl: https://api.featherless.ai
      apiKey: REAL_KEY
      type: openai-compatible
`);
        const result = lintConfigFile(file);
        assert.equal(result.ok, true, `unexpected errors: ${JSON.stringify(result.errors)}`);
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
        const file = write("inference: {}\n");
        const result = lintConfigFile(file);
        assert.equal(result.ok, false);
        // At minimum: core.postgresPassword, core.defaultChatChannel,
        // inference.defaultProvider, inference.defaultModel are all missing.
        assert.equal(result.errors.length >= 3, true);
        assert.ok(
            result.errors.some((e) => e.includes("core.postgresPassword")),
            `expected an error for core.postgresPassword in: ${JSON.stringify(result.errors)}`,
        );
    });

    it("flags defaultProvider when it doesn't match a configured provider", () => {
        const file = write(`
core:
  postgresPassword: secret
  defaultChatChannel: cli
inference:
  defaultProvider: openai
  defaultModel: gpt-5
`);
        const result = lintConfigFile(file);
        assert.equal(result.ok, false);
        assert.ok(
            result.errors.some(
                (e) => e.includes("inference.defaultProvider") && e.includes("openai"),
            ),
            `expected a defaultProvider mismatch error in: ${JSON.stringify(result.errors)}`,
        );
    });

    it("warns (not errors) when logRetentionDays is malformed", () => {
        const file = write(`
core:
  postgresPassword: secret
  defaultChatChannel: cli
  logRetentionDays: -3
inference:
  defaultProvider: openai
  defaultModel: gpt-5
  apiKeys:
    openai: REAL_KEY
`);
        const result = lintConfigFile(file);
        assert.equal(result.ok, true, `unexpected errors: ${JSON.stringify(result.errors)}`);
        assert.equal(
            result.warnings.some((w) => w.includes("logRetentionDays")),
            true,
        );
    });
});
