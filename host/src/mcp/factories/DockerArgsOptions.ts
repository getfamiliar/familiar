/**
 * Inputs that the npm/pypi `build*DockerArgs` helpers actually need
 * from the surrounding host: the tmp-dir root for per-id bind
 * mounts, plus the daemon's uid/gid for the `--user` flag. Both
 * `NpmFactoryConfig` and `PypiFactoryConfig` extend this so the
 * factories' wider configs (which also carry log + retention for
 * the file sink) flow through unchanged, while the args helper's
 * signature stays minimal — easy to satisfy from a one-shot CLI
 * caller like `./cli.sh mcp call`.
 */
export interface RuntimeContainerConfig {
    readonly tmpDir: string;
    readonly hostUid: number;
    readonly hostGid: number;
}

/**
 * Knobs that vary between bastion-spawned MCP children and one-shot
 * CLI invocations of the same container (e.g. `./cli.sh mcp call`).
 * Each factory's `build*DockerArgs` exported helper accepts this
 * options bag — omitted fields fall back to bastion defaults so the
 * gateway-side caller can keep passing nothing.
 */
export interface DockerArgsOptions {
    /**
     * Whether to allocate a TTY. Bastion children are non-TTY
     * (stdin/out are JSON-RPC pipes); interactive CLI calls (`mcp
     * call`) want a TTY when one is available so the user sees
     * curses-style prompts and OAuth device flows render correctly.
     *
     * Default: `false` → docker is invoked with `-i`. When `true`,
     * docker gets `-it`.
     */
    readonly interactive?: boolean;

    /**
     * `--name` value for the container. The bastion uses
     * `ea-mcp-<id>` so it can `docker rm -f` precisely on shutdown.
     * One-shot CLI calls pass `null` to omit `--name` entirely,
     * which lets docker auto-generate one and avoids colliding with
     * a live bastion-managed container of the same id.
     *
     * Default (omitted) → `ea-mcp-<entry.id>`. Pass `null` to skip.
     */
    readonly containerName?: string | null;

    /**
     * Args appended after the package/image. Bastion mode uses
     * `entry.args` from `mcp.yml` (the package's normal CLI). One-
     * shot calls override with the user's command line, e.g.
     * `["--login"]` for an OAuth setup invocation.
     *
     * Default (omitted) → `entry.args`.
     */
    readonly extraArgs?: readonly string[];
}
