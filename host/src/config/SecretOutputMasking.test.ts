import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    collectConfiguredSecrets,
    MASKED_OUTPUT_SECRET,
    maskSecretSlice,
    maskSecretValues,
} from "./SecretOutputMasking.js";

let scratch: string;
let configFile: string;
let mcpConfigFile: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-secret-masking-"));
    configFile = path.join(scratch, "config.yml");
    mcpConfigFile = path.join(scratch, "mcp.yml");
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

describe("collectConfiguredSecrets", () => {
    it("collects config.yml secret leaves and mcp.yml secret env values", () => {
        writeFileSync(
            configFile,
            `core:
  postgresPassword: pg-secret-pw
  defaultChatChannel: cli
inference:
  apiKeys:
    openai: sk-openai-123
    deepseek: 98765432
telegram:
  botToken: abc
  allowedUsers: [alice]
`,
        );
        writeFileSync(
            mcpConfigFile,
            `github:
  source: npm
  env:
    - name: GITHUB_TOKEN
      value: ghp_token_value
    - name: ORG
      value: my-org
    - name: OPAQUE
      value: flagged-secret
      is_secret: true
`,
        );
        const secrets = collectConfiguredSecrets(configFile, mcpConfigFile).sort();
        assert.deepEqual(secrets, [
            "98765432",
            "flagged-secret",
            "ghp_token_value",
            "pg-secret-pw",
            "sk-openai-123",
        ]);
    });

    it("treats missing files as empty", () => {
        assert.deepEqual(collectConfiguredSecrets(configFile, mcpConfigFile), []);
    });

    it("throws when a file does not parse", () => {
        writeFileSync(configFile, "core: [unclosed");
        assert.throws(() => collectConfiguredSecrets(configFile, mcpConfigFile), /does not parse/);
    });
});

describe("maskSecretValues", () => {
    it("masks every occurrence, longest secret first", () => {
        const masked = maskSecretValues("token=abcd-efgh and abcd again", ["abcd", "abcd-efgh"]);
        assert.equal(masked, `token=${MASKED_OUTPUT_SECRET} and ${MASKED_OUTPUT_SECRET} again`);
    });

    it("masks URL-encoded and JSON-escaped forms", () => {
        const secret = 'p@ss/w"rd';
        const text = `url=${encodeURIComponent(secret)} json=${JSON.stringify({ secret })}`;
        assert.equal(
            maskSecretValues(text, [secret]),
            `url=${MASKED_OUTPUT_SECRET} json={"secret":"${MASKED_OUTPUT_SECRET}"}`,
        );
    });

    it("ignores secrets shorter than the minimum length", () => {
        assert.equal(maskSecretValues("abc abc", ["abc"]), "abc abc");
    });
});

describe("maskSecretSlice", () => {
    it("holds back a possible secret prefix while output is incomplete", () => {
        const secrets = ["SECRET-VALUE"];
        const first = maskSecretSlice("hello SECRET-", 0, false, secrets);
        assert.equal(first.text, "he");
        const raw = "hello SECRET-VALUE done";
        const second = maskSecretSlice(raw, first.end, true, secrets);
        assert.equal(first.text + second.text, `hello ${MASKED_OUTPUT_SECRET} done`);
    });

    it("releases a complete match that straddles the hold-back point", () => {
        const slice = maskSecretSlice("xx SECRET-VALUE", 0, false, ["SECRET-VALUE"]);
        assert.equal(slice.text, `xx ${MASKED_OUTPUT_SECRET}`);
        assert.equal(slice.end, "xx SECRET-VALUE".length);
    });
});
