import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isSecretConfigKey, MASKED_SECRET_VALUE, maskSecrets } from "./SecretKeys.js";

describe("isSecretConfigKey", () => {
    it("flags every segment containing key/token/password/secret, case-insensitively", () => {
        assert.equal(isSecretConfigKey("inference.apiKeys.featherless"), true);
        assert.equal(isSecretConfigKey("telegram.botToken"), true);
        assert.equal(isSecretConfigKey("core.postgresPassword"), true);
        assert.equal(isSecretConfigKey("core.bastionToken"), true);
        assert.equal(isSecretConfigKey("foo.clientSecret"), true);
        assert.equal(isSecretConfigKey("GITHUB_TOKEN"), true);
    });

    it("leaves ordinary keys alone", () => {
        assert.equal(isSecretConfigKey("ms365.clientId"), false);
        assert.equal(isSecretConfigKey("mail.allowSend"), false);
        assert.equal(isSecretConfigKey("inference.defaultModel"), false);
        assert.equal(isSecretConfigKey("telegram.authorizedUserId"), false);
    });
});

describe("maskSecrets", () => {
    it("masks set secrets, nulls empty ones, and masks whole secret subtrees", () => {
        const masked = maskSecrets(
            {
                core: { postgresPassword: "pw", defaultChatChannel: "cli" },
                inference: { apiKeys: { featherless: "fk", openai: "" }, defaultModel: "m" },
                telegram: { botToken: "t", authorizedUserId: 42 },
            },
            "",
        );
        assert.deepEqual(masked, {
            core: { postgresPassword: MASKED_SECRET_VALUE, defaultChatChannel: "cli" },
            inference: {
                apiKeys: { featherless: MASKED_SECRET_VALUE, openai: null },
                defaultModel: "m",
            },
            telegram: { botToken: MASKED_SECRET_VALUE, authorizedUserId: 42 },
        });
    });

    it("masks a value read directly at a secret path", () => {
        assert.equal(maskSecrets("abc", "telegram.botToken"), MASKED_SECRET_VALUE);
        assert.deepEqual(maskSecrets({ a: "x" }, "inference.apiKeys"), { a: MASKED_SECRET_VALUE });
    });
});
