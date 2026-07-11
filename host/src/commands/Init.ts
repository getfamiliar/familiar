import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, type Logger, prettyStdoutStream } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";

/**
 * Copy a single template file to its destination only when the
 * destination doesn't already exist, so re-running `init` never clobbers
 * a user's edited config. Logs what it wrote (or skipped).
 *
 * @param src Absolute path to the template file.
 * @param dest Absolute destination path.
 * @param log Logger for progress lines.
 */
function copyIfMissing(src: string, dest: string, log: Logger): void {
    if (existsSync(dest)) {
        log.info(`kept existing ${dest}`);
        return;
    }
    if (!existsSync(src)) {
        log.warn(`template ${src} is missing — skipped`);
        return;
    }
    cpSync(src, dest);
    log.info(`wrote ${dest}`);
}

/**
 * `familiar init` — scaffold a Familiar project in the current folder so
 * a user can run an instance out of any directory (e.g. `~/familiar`).
 * Idempotent: existing files are kept, never overwritten. The one command
 * that does not require an already-initialized home dir.
 *
 * Writes `package.json` (pinning the `familiar` dependency), creates
 * `config/`, `data/`, `tmp/`, and seeds `config/config.yml`,
 * `config/mcp.yml`, `config/plugins`, and `data/workspace-template/` from
 * the packaged `template/` assets.
 */
export const initCommand = defineCommand({
    meta: {
        name: "init",
        description: "Scaffold a Familiar project (config/, data/, tmp/) in the current folder",
    },
    run() {
        const boot = bootstrap();
        const log = createLogger({
            component: "init",
            level: "info",
            streams: [prettyStdoutStream()],
        });
        const home = boot.homeDir;
        const templateDir = join(boot.assetRoot, "template");

        const pkgPath = join(home, "package.json");
        if (existsSync(pkgPath)) {
            log.info(`kept existing ${pkgPath}`);
        } else {
            const pkg = {
                name: "familiar-home",
                private: true,
                type: "module",
                dependencies: { "@getfamiliar/cli": `^${boot.version}` },
            };
            writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
            log.info(`wrote ${pkgPath}`);
        }

        for (const dir of ["config", "data", "tmp"]) {
            mkdirSync(join(home, dir), { recursive: true });
        }

        copyIfMissing(
            join(templateDir, "config.example.yml"),
            join(home, "config", "config.yml"),
            log,
        );
        copyIfMissing(join(templateDir, "mcp.example.yml"), join(home, "config", "mcp.yml"), log);
        copyIfMissing(join(templateDir, "plugins"), join(home, "config", "plugins"), log);
        cpSync(join(templateDir, "workspace-template"), join(home, "data", "workspace-template"), {
            recursive: true,
            force: false,
            errorOnExist: false,
        });
        log.info(`seeded ${join(home, "data", "workspace-template")}`);

        log.info(
            "Familiar project initialized. Next: `npm install`, fill in config/config.yml, then `familiar start`.",
        );
    },
});
