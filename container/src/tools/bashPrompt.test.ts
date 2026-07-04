import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { HandlerFile } from "../HandlerFile.js";
import type { PromptContributorContext } from "../prompt-contributors.js";
import { bashPromptContributor } from "./bashPrompt.js";

/** Build a contributor context; the bash contributor ignores `handler`. */
function ctx(overrides: Partial<PromptContributorContext>): PromptContributorContext {
    return {
        handler: {} as unknown as HandlerFile,
        topic: "test",
        toolNames: ["bash"],
        privileged: true,
        ...overrides,
    };
}

describe("bashPromptContributor", () => {
    const CONFIG_VAR = "FAMILIAR_CONTAINER_CONFIG";
    const savedConfig = process.env[CONFIG_VAR];

    beforeEach(() => {
        delete process.env[CONFIG_VAR];
    });

    afterEach(() => {
        if (savedConfig === undefined) {
            delete process.env[CONFIG_VAR];
        } else {
            process.env[CONFIG_VAR] = savedConfig;
        }
    });

    /** Set the passed-config blob the contributor reads via `PassedConfig`. */
    function setConfig(values: Record<string, unknown>): void {
        process.env[CONFIG_VAR] = JSON.stringify(values);
    }

    it("returns null when bash is not in the active tool set", () => {
        assert.equal(bashPromptContributor(ctx({ toolNames: ["fs_read"] })), null);
    });

    it("renders the priv wording for a privileged run", () => {
        const out = bashPromptContributor(ctx({ privileged: true }));
        assert.ok(out !== null);
        assert.match(out, /^## The bash tool$/m);
        assert.match(out, /runs as the `priv` user/);
        assert.match(out, /write access to `\/workspace` and `\/scratch`/);
        assert.doesNotMatch(out, /unpriv/);
    });

    it("renders the unpriv wording with the writable-paths list", () => {
        setConfig({ "core.writablePaths": ["wiki/**", "files/**"] });
        const out = bashPromptContributor(ctx({ privileged: false }));
        assert.ok(out !== null);
        assert.match(out, /runs as the `unpriv` user/);
        assert.match(out, /write access to `\/scratch` and: `wiki\/\*\*`, `files\/\*\*`\./);
    });

    it("drops the writable-paths clause when none are configured", () => {
        const out = bashPromptContributor(ctx({ privileged: false }));
        assert.ok(out !== null);
        assert.match(out, /write access to `\/scratch`\./);
        assert.doesNotMatch(out, /and:/);
    });

    it("lists the installed python packages when present", () => {
        setConfig({ "python.packages": ["numpy", "pandas"] });
        const out = bashPromptContributor(ctx({}));
        assert.ok(out !== null);
        assert.match(out, /The following packages are installed: numpy, pandas\./);
    });

    it("falls back to a no-list sentence when no packages are configured", () => {
        const out = bashPromptContributor(ctx({}));
        assert.ok(out !== null);
        assert.doesNotMatch(out, /The following packages are installed/);
        assert.match(out, /install python packages via the config file/);
    });

    it("always notes that bash is offline", () => {
        const out = bashPromptContributor(ctx({}));
        assert.ok(out !== null);
        assert.match(out, /OFFLINE/);
    });
});
