import type { Logger } from "@getfamiliar/shared";
import type { Bootstrap } from "../Bootstrap.js";
import { pullImageIfNeeded } from "../container-runner/Images.js";
import { dockerExec } from "../DockerTools.js";

/**
 * Tag for the generic node runtime image used by `source: npm`
 * entries. Built from `mcp-runtime/npm/Dockerfile` on demand by
 * {@link ensureRuntimeImage}.
 */
export const NPM_RUNTIME_IMAGE = "familiar-mcp-runtime-npm";

/**
 * Tag for the generic python runtime image used by `source: pypi`
 * entries. Built from `mcp-runtime/pypi/Dockerfile` on demand by
 * {@link ensureRuntimeImage}.
 */
export const PYPI_RUNTIME_IMAGE = "familiar-mcp-runtime-pypi";

/**
 * Absolute host path to the `mcp-runtime/<source>/` Dockerfile
 * directory, under the project's {@link Bootstrap.homeDir}. Only used in
 * build mode (a monorepo checkout, where `homeDir` is the repo root).
 */
function runtimeDockerfileDir(homeDir: string, source: "npm" | "pypi"): string {
    return `${homeDir}/mcp-runtime/${source}`;
}

/**
 * Ensure the runtime image for the given source is available under its
 * well-known local tag. In `"pull"` mode the version-pinned image is
 * pulled and tagged locally; in `"build"` mode it's built from
 * `mcp-runtime/<source>/Dockerfile`. Idempotent: the pull path skips when
 * the versioned image is already local, and docker's layer cache makes
 * the build path's no-change case ~1 s, so calling this on every daemon
 * start is cheap.
 *
 * @param source The MCP runtime flavor (`npm` or `pypi`).
 * @param boot Bootstrap providing image mode, registry/tag, and (build mode) the context root.
 * @param log Logger for the build/pull step.
 */
export async function ensureRuntimeImage(
    source: "npm" | "pypi",
    boot: Bootstrap,
    log: Logger,
): Promise<void> {
    const tag = source === "npm" ? NPM_RUNTIME_IMAGE : PYPI_RUNTIME_IMAGE;
    if (await pullImageIfNeeded(boot, tag, log)) {
        return;
    }
    const dir = runtimeDockerfileDir(boot.homeDir, source);
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
