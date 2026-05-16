import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { lintMcpConfigFile } from "./McpConfigLoader.js";

/**
 * Header comment used when `mcp add` creates `config/mcp.yml` from
 * scratch. Mirrors the example file's intent at a smaller scale —
 * mostly so the user sees what the file is for the first time they
 * open it.
 */
const FRESH_FILE_HEADER =
    "# Familiar — MCP servers (see config/mcp.example.yml).\n" +
    "# Edited by `./cli.sh mcp add`; you can hand-edit too.\n";

/**
 * Append a single rendered YAML entry block (already
 * `yaml.stringify`'d for the new key) to `mcp.yml` at `filePath`,
 * then re-lint the resulting file. **If the lint fails the write
 * is rolled back** — the file is restored to whatever it was
 * before the append, or removed entirely when no file existed —
 * and an error is thrown describing what went wrong. This way
 * a malformed entry can never leave the user's config in a
 * half-broken state that the next `mcp add` would refuse on the
 * preflight check.
 *
 * Always inserts a `\n\n` separator before the new entry so the
 * new key never collides with the previous entry's last line.
 * Writes go through tempfile + rename so a crash mid-write can't
 * leave the user with a half-written config.
 *
 * Pure: never logs, never spawns. The dialogue layer prints what
 * happened.
 *
 * @throws If the existing file is unreadable, the rename fails,
 *   or the post-append lint detects errors (in which case the
 *   error message lists them and the file has been rolled back).
 */
export function appendEntry(filePath: string, yamlBlock: string): void {
    const trimmedBlock = yamlBlock.endsWith("\n") ? yamlBlock : `${yamlBlock}\n`;

    const existedBefore = existsSync(filePath);
    let previousContent: string | null = null;
    let next: string;
    if (!existedBefore) {
        next = `${FRESH_FILE_HEADER}\n${trimmedBlock}`;
    } else {
        try {
            previousContent = readFileSync(filePath, "utf-8");
        } catch (err) {
            const cause = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to read existing ${filePath}: ${cause}`);
        }
        // Ensure exactly one blank line between the existing file
        // and the new entry — readers shouldn't have to count
        // newlines.
        const withSeparator = previousContent.endsWith("\n\n")
            ? previousContent
            : previousContent.endsWith("\n")
              ? `${previousContent}\n`
              : `${previousContent}\n\n`;
        next = `${withSeparator}${trimmedBlock}`;
    }

    const tmp = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, next, "utf-8");
    try {
        renameSync(tmp, filePath);
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to atomically replace ${filePath}: ${cause}`);
    }

    const lint = lintMcpConfigFile(filePath);
    if (!lint.ok) {
        rollback(filePath, previousContent, existedBefore);
        throw new Error(
            `Lint failed after append — change rolled back. Errors:\n  - ${lint.errors.join("\n  - ")}`,
        );
    }
}

/**
 * Restore `filePath` to its pre-append state. When the file
 * didn't exist before the append, the freshly-created file is
 * removed; otherwise the previous bytes are written back.
 * Uses a plain `writeFileSync` rather than tempfile+rename for
 * the restore — the rollback path is short, and a tempfile that
 * fails to rename here would leave the user worse off than just
 * overwriting in place.
 */
function rollback(filePath: string, previousContent: string | null, existedBefore: boolean): void {
    if (!existedBefore || previousContent === null) {
        try {
            unlinkSync(filePath);
        } catch {
            // ignore — best-effort
        }
        return;
    }
    try {
        writeFileSync(filePath, previousContent, "utf-8");
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(
            `CRITICAL: lint failed AND rollback also failed — ${filePath} may be in a broken state. Original content was ${previousContent.length} bytes. Underlying error: ${cause}`,
        );
    }
}
