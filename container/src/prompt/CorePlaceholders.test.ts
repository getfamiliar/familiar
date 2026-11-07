import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { CORE_PROMPT_PLACEHOLDERS } from "@getfamiliar/shared";
import { HandlerFile } from "../HandlerFile.js";
import {
    CORE_PLACEHOLDER_RESOLVERS,
    type CorePlaceholderContext,
    isContainerCorePlaceholder,
    listSkills,
} from "./CorePlaceholders.js";

describe("core placeholder registry", () => {
    it("covers every shared core definition", () => {
        for (const definition of CORE_PROMPT_PLACEHOLDERS) {
            assert.ok(
                isContainerCorePlaceholder(definition.name),
                `core placeholder {${definition.name}} has no container resolver`,
            );
        }
    });

    it("has no resolver without a shared definition", () => {
        const defined = new Set(CORE_PROMPT_PLACEHOLDERS.map((d) => d.name));
        for (const name of Object.keys(CORE_PLACEHOLDER_RESOLVERS)) {
            assert.ok(
                defined.has(name),
                `resolver {${name}} is missing from CORE_PROMPT_PLACEHOLDERS`,
            );
        }
    });
});

describe("config-backed placeholders", () => {
    const CONFIG_VAR = "FAMILIAR_CONTAINER_CONFIG";
    const savedConfig = process.env[CONFIG_VAR];
    const ctx = {} as CorePlaceholderContext;

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

    it("lists python packages comma-separated", () => {
        process.env[CONFIG_VAR] = JSON.stringify({ "python.packages": ["pandas", "openpyxl"] });
        assert.equal(CORE_PLACEHOLDER_RESOLVERS.PYTHON_PACKAGE_LIST?.(ctx), "pandas, openpyxl");
    });

    it("lists writable paths as code", () => {
        process.env[CONFIG_VAR] = JSON.stringify({ "core.writablePaths": ["wiki/**", "notes/*"] });
        assert.equal(CORE_PLACEHOLDER_RESOLVERS.WRITABLE_PATH_LIST?.(ctx), "`wiki/**`, `notes/*`");
    });

    it("renders (none) for empty lists", () => {
        assert.equal(CORE_PLACEHOLDER_RESOLVERS.PYTHON_PACKAGE_LIST?.(ctx), "(none)");
        assert.equal(CORE_PLACEHOLDER_RESOLVERS.WRITABLE_PATH_LIST?.(ctx), "(none)");
    });

    it("renders the configured assistant name, trimmed", () => {
        process.env[CONFIG_VAR] = JSON.stringify({ "core.assistantName": "  Jeeves " });
        assert.equal(CORE_PLACEHOLDER_RESOLVERS.ASSISTANT_NAME?.(ctx), "Jeeves");
    });

    it("falls back to Familiar when the assistant name is unset or blank", () => {
        assert.equal(CORE_PLACEHOLDER_RESOLVERS.ASSISTANT_NAME?.(ctx), "Familiar");
        process.env[CONFIG_VAR] = JSON.stringify({ "core.assistantName": "   " });
        assert.equal(CORE_PLACEHOLDER_RESOLVERS.ASSISTANT_NAME?.(ctx), "Familiar");
    });
});

describe("listSkills", () => {
    let workspaceRoot: string;
    let previousWorkspaceRoot: string;

    before(() => {
        previousWorkspaceRoot = HandlerFile.getWorkspaceRoot();
        workspaceRoot = mkdtempSync(path.join(tmpdir(), "familiar-skills-test-"));
        HandlerFile.setWorkspaceRoot(workspaceRoot);
    });

    after(() => {
        HandlerFile.setWorkspaceRoot(previousWorkspaceRoot);
        rmSync(workspaceRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
        rmSync(path.join(workspaceRoot, "skills"), { recursive: true, force: true });
    });

    /** Write a skill at `skills/<id>/SKILL.md` with the given source. */
    function writeSkill(id: string, source: string): void {
        const dir = path.join(workspaceRoot, "skills", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "SKILL.md"), source, "utf8");
    }

    it("returns null when skills/ does not exist", () => {
        assert.equal(listSkills(), null);
    });

    it("lists skills by id and description, sorted by id", () => {
        writeSkill("zeta", "---\ndescription: z.\ntools: jira_create\n---\nbody\n");
        writeSkill("alpha", "---\ndescription: a.\n---\nbody\n");
        assert.equal(listSkills(), "- `alpha`: a.\n- `zeta`: z.");
    });

    it("skips malformed or non-compliant entries", () => {
        writeSkill("good", "---\ndescription: A real skill.\n---\nbody\n");
        mkdirSync(path.join(workspaceRoot, "skills", "empty-folder"), { recursive: true });
        writeFileSync(path.join(workspaceRoot, "skills", "loose.md"), "loose\n", "utf8");
        writeSkill("malformed", "---\ndescription: : : :\n  bad\n---\nbody\n");
        writeSkill("no-frontmatter", "# just a body\n");
        writeSkill("empty-desc", '---\ndescription: "   "\n---\nbody\n');
        assert.equal(listSkills(), "- `good`: A real skill.");
    });

    it("truncates descriptions longer than 256 chars with an ellipsis", () => {
        writeSkill("long", `---\ndescription: ${"x".repeat(300)}\n---\nbody\n`);
        assert.equal(listSkills(), `- \`long\`: ${"x".repeat(256)}…`);
    });
});
