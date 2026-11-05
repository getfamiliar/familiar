import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Directory of this plugin's package (the one holding its
 * `package.json`, `vite.config.ts` and `build/client`), found by walking
 * up from this module. Works both from `build/` (compiled) and from
 * `src/host/` (tests via tsx).
 *
 * @returns Absolute path of the plugin root.
 * @throws {Error} When no `package.json` is found above this module.
 */
export function findPluginRoot(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(path.join(dir, "package.json"))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`web-ui: no package.json above ${fileURLToPath(import.meta.url)}`);
        }
        dir = parent;
    }
}
