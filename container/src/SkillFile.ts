import { readFileSync } from "node:fs";
import path from "node:path";
import {
    HandlerFile,
    optionalString,
    optionalStringList,
    splitFrontmatter,
} from "./HandlerFile.js";

/** Workspace folder holding the skills (`skills/<id>/SKILL.md`). */
const SKILLS_FOLDER = "skills";

/** File name of a skill inside its folder. */
const SKILL_FILE_NAME = "SKILL.md";

/** Tool entry a handler gets when its own `tools:` is omitted or empty. */
const DEFAULT_TOOL_ENTRY = "core";

/** Parsed shape of a SKILL.md frontmatter. Unknown keys are ignored. */
export interface SkillFileHeader {
    /** Self-documenting skill name. */
    readonly name?: string;
    /** One-line description, listed in `{SKILL_LIST}`. */
    readonly description?: string;
    /**
     * Tool entries (same grammar as a handler's `tools:`) added to the
     * toolset of every handler that preloads this skill.
     */
    readonly tools?: readonly string[];
}

/** Thrown when a handler preloads a skill whose SKILL.md does not exist. */
export class SkillNotFoundError extends Error {
    readonly skillId: string;

    /**
     * @param skillId The missing skill id.
     * @param handlerPath Workspace-relative handler path that preloads it.
     */
    constructor(skillId: string, handlerPath: string) {
        super(
            `skill "${skillId}" (preloaded by handler ${handlerPath} via its \`skills\` frontmatter) does not exist — ` +
                `expected ${skillRelativePath(skillId)} in the workspace`,
        );
        this.name = "SkillNotFoundError";
        this.skillId = skillId;
    }
}

/** One parsed `skills/<id>/SKILL.md`. */
export class SkillFile {
    /** Skill id — the folder name under `skills/`. */
    readonly id: string;
    /** Workspace-relative path, e.g. `skills/jira/SKILL.md`. */
    readonly relativePath: string;
    /** Parsed frontmatter. */
    readonly header: SkillFileHeader;
    /** Markdown body without the frontmatter. */
    readonly body: string;

    private constructor(id: string, header: SkillFileHeader, body: string) {
        this.id = id;
        this.relativePath = skillRelativePath(id);
        this.header = header;
        this.body = body;
    }

    /**
     * Read and parse `skills/<id>/SKILL.md` under the workspace root.
     *
     * @param id Skill id.
     * @returns The parsed skill, or `null` when the file does not exist.
     * @throws On malformed frontmatter or I/O errors other than a missing file.
     */
    static read(id: string): SkillFile | null {
        const absolute = path.join(HandlerFile.getWorkspaceRoot(), skillRelativePath(id));
        let source: string;
        try {
            source = readFileSync(absolute, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw err;
        }
        const { frontmatter, body } = splitFrontmatter(absolute, source);
        const header: SkillFileHeader =
            frontmatter === null
                ? {}
                : {
                      name: optionalString(absolute, frontmatter, "name"),
                      description: optionalString(absolute, frontmatter, "description"),
                      tools: optionalStringList(absolute, frontmatter, "tools"),
                  };
        return new SkillFile(id, header, body);
    }
}

/**
 * Workspace-relative path of a skill's SKILL.md.
 *
 * @param id Skill id.
 * @returns E.g. `skills/jira/SKILL.md`.
 */
function skillRelativePath(id: string): string {
    return `${SKILLS_FOLDER}/${id}/${SKILL_FILE_NAME}`;
}

/**
 * Load every skill a handler preloads via its `skills` frontmatter, in
 * declared order with duplicates dropped.
 *
 * @param handler The resolved handler.
 * @returns The parsed skills (empty when the handler declares none).
 * @throws {SkillNotFoundError} When a declared skill does not exist.
 * @throws On a malformed SKILL.md frontmatter.
 */
export function loadPreloadedSkills(handler: HandlerFile): readonly SkillFile[] {
    const ids = [...new Set(handler.header.skills ?? [])];
    return ids.map((id) => {
        const skill = SkillFile.read(id);
        if (skill === null) {
            throw new SkillNotFoundError(id, handler.relativePath);
        }
        return skill;
    });
}

/**
 * Combine a handler's `tools:` entries with the `tools` of its preloaded
 * skills. An omitted or empty handler list stands for the implicit
 * `core` default, which is kept when skill tools are added.
 *
 * @param handlerTools The handler's `tools:` entries.
 * @param skills The preloaded skills.
 * @returns The handler entries unchanged when no skill declares tools,
 *   else the handler entries (or `core`) followed by the skill entries.
 */
export function combineToolEntries(
    handlerTools: readonly string[] | undefined,
    skills: readonly SkillFile[],
): readonly string[] | undefined {
    const skillTools = skills.flatMap((skill) => skill.header.tools ?? []);
    if (skillTools.length === 0) {
        return handlerTools;
    }
    const base =
        handlerTools === undefined || handlerTools.length === 0
            ? [DEFAULT_TOOL_ENTRY]
            : handlerTools;
    return [...new Set([...base, ...skillTools])];
}

/**
 * Render the preloaded skills for `{PRELOADED_SKILLS}`: one h1 section
 * per skill, stating that the content is already loaded so the agent
 * does not read the file again.
 *
 * @param skills The preloaded skills.
 * @returns The rendered sections, or `""` when there are none.
 */
export function formatPreloadedSkills(skills: readonly SkillFile[]): string {
    return skills
        .map(
            (skill) =>
                `# Skill \`${skill.id}\` (preloaded)\n\n` +
                `This is the complete content of \`${skill.relativePath}\`. It is already loaded — do not read the file again, just follow it.\n\n` +
                skill.body,
        )
        .join("\n\n");
}
