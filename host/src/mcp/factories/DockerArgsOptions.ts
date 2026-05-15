/**
 * Inputs that the npm/pypi `build*DockerArgs` helpers actually need
 * from the surrounding host: the tmp-dir root for per-id bind
 * mounts, the shared scratch dir mounted at `/scratch` so MCPs can
 * read per-event files staged by `ctx.events.emit`, plus the daemon's
 * uid/gid for the `--user` flag. Both `NpmFactoryConfig` and
 * `PypiFactoryConfig` extend this so the factories' wider configs
 * (which also carry log + retention for the file sink) flow through
 * unchanged, while the args helper's signature stays minimal — easy
 * to satisfy from a one-shot CLI caller like `./cli.sh mcp call`.
 */
export interface RuntimeContainerConfig {
    readonly tmpDir: string;
    readonly scratchDir: string;
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
     * Args appended **after** `entry.args` (which always apply). Used
     * by `./cli.sh mcp call <id> -- <tail>` so the user's flags run
     * after whatever the mcp.yml `args:` block declares — never
     * replacing it. This keeps a one-shot CLI invocation in lockstep
     * with the bastion: same image, same env, same network, same
     * mcp.yml args, plus whatever extra flag (`--login`, `--version`,
     * …) the user wants on top.
     *
     * Default (omitted) → no extra args; the container runs with
     * exactly `entry.args`, matching bastion behavior.
     */
    readonly appendArgs?: readonly string[];
}
