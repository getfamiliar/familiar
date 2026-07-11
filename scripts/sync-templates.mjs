// Populate host/template/ from the canonical repo-root assets so the
// published @getfamiliar/host package carries everything `familiar init`
// needs to scaffold a project. The host package's `files` allowlist
// includes `template`, and this directory is gitignored (regenerated on
// every publish), so config/*.example.yml and data/workspace-template/
// stay the single source of truth.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "host", "template");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(root, "config", "config.example.yml"), join(dest, "config.example.yml"));
cpSync(join(root, "config", "mcp.example.yml"), join(dest, "mcp.example.yml"));
cpSync(join(root, "config", "plugins.example"), join(dest, "plugins"));
cpSync(join(root, "data", "workspace-template"), join(dest, "workspace-template"), {
    recursive: true,
});
console.log(`synced templates → ${dest}`);
