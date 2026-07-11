import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolLevel, ToolRunContext } from "@getfamiliar/shared";
import { jsonSchema, type Tool, type ToolSet, tool } from "ai";
import { HandlerFile } from "../HandlerFile.js";
import { buildToolDescribeTool } from "./toolDescribe.js";

/** A run context with a huge budget so results are never spilled. */
const NO_SPILL_CTX: ToolRunContext = {
    limit: 1_000_000,
    spill: async () => {
        throw new Error("spill must not be invoked in these tests");
    },
};

/**
 * A description longer than `tool_list`'s 200-char display cap, ending
 * in a marker so a test can prove `tool_describe` does not truncate.
 */
const LONG_DESCRIPTION = `${"lorem ipsum ".repeat(40)}END-MARKER`;

/** Build a small unwrapped pool with real AI-SDK tools for describe tests. */
function buildPool(): ToolSet {
    return {
        jira_create_issue: tool<{ project: string; summary: string }, string>({
            description: LONG_DESCRIPTION,
            inputSchema: jsonSchema({
                type: "object",
                additionalProperties: false,
                required: ["project", "summary"],
                properties: {
                    project: { type: "string", description: "Project key" },
                    summary: { type: "string" },
                },
            }),
            execute: async () => "unused",
        }),
        lonely_tool: tool<Record<string, never>, string>({
            description: "a tool no skill mentions",
            inputSchema: jsonSchema({
                type: "object",
                additionalProperties: false,
                properties: {},
            }),
            execute: async () => "unused",
        }),
    };
}

/** Invoke `tool_describe.execute` with the typed input shape. */
async function runDescribe(
    name: string,
    opts: {
        pool?: ToolSet;
        levels?: ReadonlyMap<string, ToolLevel>;
        loaded?: ReadonlySet<string>;
    } = {},
): Promise<string> {
    const t = buildToolDescribeTool(
        opts.pool ?? buildPool(),
        opts.levels ?? new Map(),
        opts.loaded ?? new Set(),
        NO_SPILL_CTX,
    );
    const exec = t.execute;
    if (!exec) {
        throw new Error("tool_describe has no execute");
    }
    // biome-ignore lint/suspicious/noExplicitAny: SDK options type isn't needed for these tests.
    return (await (exec as any)({ name }, {} as any)) as string;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe("tool_describe — detail rendering", () => {
    let workspaceDir: string;

    // An empty workspace (no skills/) so findSkillsMentioning is a no-op
    // for the detail-only assertions.
    before(() => {
        workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-describe-"));
        HandlerFile.setWorkspaceRoot(workspaceDir);
    });
    after(() => {
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("renders the full (untruncated) description and the JSON schema", async () => {
        const out = await runDescribe("jira_create_issue", {
            levels: new Map([["jira_create_issue", "approval"]]),
            loaded: new Set(["jira_create_issue"]),
        });
        assert.ok(out.includes("END-MARKER"), "full description must not be truncated");
        assert.ok(out.length > 200, "description longer than tool_list's display cap");
        assert.ok(out.includes("```json"), "schema rendered as a fenced json block");
        assert.ok(out.includes('"project"') && out.includes('"required"'), "schema fields present");
    });

    it("header reflects level and loaded=true (callable directly)", async () => {
        const out = await runDescribe("jira_create_issue", {
            levels: new Map([["jira_create_issue", "approval"]]),
            loaded: new Set(["jira_create_issue"]),
        });
        assert.ok(out.includes("Level: approval"), "level shown in header");
        assert.ok(out.includes("callable directly"), "loaded tool marked callable directly");
    });

    it("header marks an unloaded tool as invoke-via-tool_call, default level", async () => {
        const out = await runDescribe("jira_create_issue", { loaded: new Set() });
        assert.ok(out.includes("Level: default"), "missing level falls back to default");
        assert.ok(out.includes("invoke via `tool_call`"), "unloaded tool points at tool_call");
    });

    it("omits the skills section when no skill mentions the tool", async () => {
        const out = await runDescribe("lonely_tool");
        assert.ok(!out.includes("consider reading them"), "no skills preamble expected");
    });

    it("throws UnknownTool with a near-miss suggestion for an unknown name", async () => {
        await assert.rejects(runDescribe("jira_creat"), (err: Error) => {
            assert.ok(err.message.includes('No tool named "jira_creat"'));
            assert.ok(err.message.includes("jira_create_issue"), "suggests the close match");
            return true;
        });
    });

    it("degrades to a note when the schema cannot be read", async () => {
        const brokenTool = {
            description: "broken schema tool",
            inputSchema: new Proxy(
                {},
                {
                    get() {
                        throw new Error("boom");
                    },
                },
            ),
            execute: async () => "unused",
        } as unknown as Tool;
        const out = await runDescribe("broken", { pool: { broken: brokenTool } });
        assert.ok(out.includes("broken schema tool"), "description still rendered");
        assert.ok(out.includes("schema unavailable"), "schema read failure degrades gracefully");
    });
});

describe("tool_describe — skills mention", () => {
    let workspaceDir: string;

    before(() => {
        workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-describe-skills-"));
        HandlerFile.setWorkspaceRoot(workspaceDir);

        const writeSkill = (relative: string, body: string) => {
            const abs = path.join(workspaceDir, "skills", relative);
            mkdirSync(path.dirname(abs), { recursive: true });
            writeFileSync(abs, body, "utf8");
        };
        // Skill `a`: SKILL.md mentions the tool.
        writeSkill("a/SKILL.md", "# A\nUse `jira_create_issue` to file a ticket.");
        // Skill `b`: unrelated.
        writeSkill("b/SKILL.md", "# B\nNothing relevant here.");
        // Skill `c`: SKILL.md does NOT mention it, but two other .md files do
        // (proves non-SKILL.md files count, and that they dedupe to one entry).
        writeSkill("c/SKILL.md", "# C\nEntry point with no direct mention.");
        writeSkill("c/examples/usage.md", "Example: jira_create_issue payload …");
        writeSkill("c/notes.md", "See jira_create_issue for details.");
    });
    after(() => {
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("lists mentioning skills (incl. non-SKILL.md), sorted, deduped, pointing at SKILL.md", async () => {
        const out = await runDescribe("jira_create_issue");
        assert.ok(out.includes("consider reading them"), "skills preamble present");
        assert.ok(out.includes("skills/a/SKILL.md"), "skill a listed");
        assert.ok(out.includes("skills/c/SKILL.md"), "skill c listed via its non-SKILL.md files");
        assert.ok(!out.includes("skills/b/SKILL.md"), "unrelated skill b not listed");
        assert.equal(
            countOccurrences(out, "skills/c/SKILL.md"),
            1,
            "skill c deduped to a single entry despite two matching files",
        );
        assert.ok(
            out.indexOf("skills/a/SKILL.md") < out.indexOf("skills/c/SKILL.md"),
            "skills sorted by id (a before c)",
        );
    });
});
