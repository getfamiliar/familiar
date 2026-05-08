import { resolve } from "node:path";
import type { Logger } from "effective-assistant-shared";
import { dockerExec } from "../DockerTools.js";

/**
 * Tag for the generic node runtime image used by `source: npm`
 * entries. Built from `mcp-runtime/npm/Dockerfile` on demand by
 * {@link ensureRuntimeImage}.
 */
export const NPM_RUNTIME_IMAGE = "ea-mcp-runtime-npm";

/**
 * Tag for the generic python runtime image used by `source: pypi`
 * entries. Built from `mcp-runtime/pypi/Dockerfile` on demand by
 * {@link ensureRuntimeImage}.
 */
export const PYPI_RUNTIME_IMAGE = "ea-mcp-runtime-pypi";

/**
 * Absolute host path to the `mcp-runtime/<source>/` Dockerfile
 * directory. Resolved relative to the compiled JS location so it
 * works the same in dev and from a packaged build:
 * `host/build/mcp/RuntimeImages.js` lives three levels under the
 * project root.
 */
function runtimeDockerfileDir(source: "npm" | "pypi"): string {
    return resolve(import.meta.dirname, "../../..", "mcp-runtime", source);
}

/**
 * Build the runtime image for the given source if it isn't already
 * up to date with its Dockerfile. Idempotent: docker's layer cache
 * makes the no-change case ~1 s, so calling this on every daemon
 * start is cheap and removes the need to track "did we already
 * build this".
 */
export async function ensureRuntimeImage(source: "npm" | "pypi", log: Logger): Promise<void> {
    const tag = source === "npm" ? NPM_RUNTIME_IMAGE : PYPI_RUNTIME_IMAGE;
    const dir = runtimeDockerfileDir(source);
    log.info(`building ${tag} from ${dir}`);
    await dockerExec(["build", "-t", tag, dir]);
}

/**
 * Per-MCP bind-mount directory on the host. The npm/pypi factories
 * mount this at `/work` inside the runtime container; the directory
 * doubles as `WORKDIR` and `HOME` so npx/uv caches persist across
 * cold-spawn cycles.
 *
 * The id is the MCP's `mcp.yml` key (matching `^[a-z0-9][a-z0-9-]*$`),
 * so no path-component sanitization is needed here.
 */
export function mcpMountDirFor(tmpDir: string, id: string): string {
    return `${tmpDir}/mcp-mount-${id}`;
}
