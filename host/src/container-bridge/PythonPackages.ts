/**
 * Shared logic for the Python packages baked into the agent image's
 * `bash` tool (`config.python.packages`). One source of truth for both
 * the image builder ({@link ./AgentContainer}) and `config lint`
 * ({@link ../commands/Config}): syntactic validation, bare-name parsing,
 * and a PyPI existence check.
 */

/**
 * Safe shape for a single pip requirement: starts alphanumeric, then only
 * characters that appear in a name, `[extras]`, or version specifiers. The
 * point is to forbid shell metacharacters — the value is interpolated
 * unquoted into `pip install $PYTHON_PACKAGES` in the Dockerfile, so a
 * crafted entry must not be able to smuggle in extra shell.
 */
const SAFE_PIP_REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._+\-[\]<>=!~,]*$/;

/** PyPI JSON metadata endpoint; `<name>` is filled in per package. */
const PYPI_JSON_URL = (name: string) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;

/**
 * Browser-like User-Agent. node's default fetch UA is rejected by some
 * WAFs (see the Featherless /v1/models case); PyPI sits behind Fastly, so
 * a real UA keeps the existence check from being throttled or blocked.
 */
const PYPI_USER_AGENT =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) familiar-config-lint";

/**
 * Whether a string is a plain pip requirement (name, optional `[extras]`,
 * optional version specifier) with no shell metacharacters or whitespace.
 *
 * @param entry A single `python.packages` entry.
 * @returns `true` if safe to interpolate unquoted into the pip command.
 */
export function isSafePipRequirement(entry: string): boolean {
    return SAFE_PIP_REQUIREMENT.test(entry);
}

/**
 * Recover the bare distribution name from a pip requirement by stripping
 * any `[extras]` and version specifier, e.g. `pandas>=2,<3` → `pandas`,
 * `pillow[heif]` → `pillow`. Used to build the PyPI lookup URL.
 *
 * @param requirement A pip requirement (assumed already syntactically safe).
 * @returns The bare distribution name.
 */
export function parseDistributionName(requirement: string): string {
    // The name runs until the first extras bracket or version operator.
    const match = requirement.match(/^[A-Za-z0-9._-]+/);
    return match ? match[0] : requirement;
}

/** Outcome of checking a single requirement against PyPI. */
export interface PackageCheck {
    /** The original requirement string from config. */
    readonly requirement: string;
    /** The bare distribution name that was looked up. */
    readonly name: string;
    /**
     * `ok` — PyPI returned 200 for the name.
     * `not-found` — PyPI returned 404 (typo / nonexistent distribution).
     * `unreachable` — network error or unexpected status; existence is
     * unknown, so callers should warn rather than hard-fail.
     */
    readonly status: "ok" | "not-found" | "unreachable";
}

/** Injectable dependencies for {@link checkPackagesOnPyPI} (testing seam). */
export interface PyPiCheckDeps {
    /** Defaults to the global `fetch`. */
    readonly fetch: typeof globalThis.fetch;
}

/**
 * Check each requirement's distribution name against the PyPI JSON API,
 * concurrently. Never throws — a network failure for one package surfaces
 * as `unreachable` for that entry, so an offline `config lint` degrades to
 * warnings instead of crashing.
 *
 * @param packages Requirement strings from `config.python.packages`.
 * @param deps Injectable `fetch` for tests; defaults to global `fetch`.
 * @returns One {@link PackageCheck} per input, in the same order.
 */
export async function checkPackagesOnPyPI(
    packages: readonly string[],
    deps: PyPiCheckDeps = { fetch: globalThis.fetch },
): Promise<PackageCheck[]> {
    return Promise.all(
        packages.map(async (requirement): Promise<PackageCheck> => {
            const name = parseDistributionName(requirement);
            try {
                const response = await deps.fetch(PYPI_JSON_URL(name), {
                    method: "GET",
                    headers: { "User-Agent": PYPI_USER_AGENT, Accept: "application/json" },
                });
                if (response.status === 200) {
                    return { requirement, name, status: "ok" };
                }
                if (response.status === 404) {
                    return { requirement, name, status: "not-found" };
                }
                return { requirement, name, status: "unreachable" };
            } catch {
                return { requirement, name, status: "unreachable" };
            }
        }),
    );
}
