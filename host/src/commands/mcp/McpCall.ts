import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createLogger, prettyStdoutStream } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { parse } from "yaml";
import { bootstrap } from "../../Bootstrap.js";
import { dockerCapture, dockerInteractive } from "../../DockerTools.js";
import type {
    DockerArgsOptions,
    RuntimeContainerConfig,
} from "../../mcp/factories/DockerArgsOptions.js";
import { buildDockerRegistryArgs } from "../../mcp/factories/DockerMcpRegistryFactory.js";
import { buildNpmDockerArgs } from "../../mcp/factories/NpmFactory.js";
import { buildPypiDockerArgs } from "../../mcp/factories/PypiFactory.js";
import { lintMcpConfigFile } from "../../mcp/McpConfigLoader.js";
import {
    DEFAULT_IDLE_TIMEOUT_SECONDS,
    type McpEntry,
    type McpEnvVar,
    type McpNetwork,
    type McpSource,
} from "../../mcp/McpEntry.js";
import { ensureRuntimeImage, mcpMountDirFor } from "../../mcp/RuntimeImages.js";

/**
 * `cli.sh mcp call <id> -- <args...>` — one-shot interactive
 * invocation of an MCP's runtime container that uses the *same*
 * docker invocation the bastion would build for the same `mcp.yml`
 * entry. Mount, env, `--user`, network, and the entry's `args:`
 * block all flow through unchanged; the user's `-- <tail>` is
 * **appended** to the entry's args (it never replaces them), so a
 * call like `./cli.sh mcp call ms365 -- --login` runs with the
 * mcp.yml-declared flags first (e.g. `--org-mode`) and then
 * `--login`. The OAuth scopes the user authenticates with thus
 * match what the bastion will request silently later.
 *
 * Use case: `./cli.sh mcp call ms-365 -- --login` walks the user
 * through Microsoft's device-code OAuth flow, drops a token into
 * the bind mount, and exits — no daemon restart required.
 *
 * Uses `--` as the explicit boundary between citty's parsed args
 * and the user's verbatim command line so flags like `--login`
 * aren't misinterpreted as our own.
 *
 * Drops `--name` from the docker invocation so it doesn't collide
 * with the bastion's live `familiar-mcp-<id>` container (the daemon may
 * be running). `--rm` still cleans up the one-shot container.
 */
export const mcpCallCommand = defineCommand({
    meta: {
        name: "call",
        description:
            "Run a one-shot interactive command against an MCP's runtime container. Use `--` to separate the user's args from citty's flags.",
    },
    args: {
        id: {
            type: "positional",
            required: true,
            description: "MCP id from config/mcp.yml.",
        },
    },
    run({ args, rawArgs }) {
        const id = args.id;
        // citty puts every positional into `args._` (declared
        // ones included), so we can't use `_` to detect "extra
        // args after --". Look for the literal `--` token in
        // `rawArgs` instead — anything after it is the user's
        // command line, anything before isn't ours to forward.
        const dashIdx = rawArgs.indexOf("--");
        const extraArgs = dashIdx >= 0 ? rawArgs.slice(dashIdx + 1) : [];
        if (extraArgs.length === 0) {
            process.stderr.write(
                `usage: ./cli.sh mcp call <id> -- <args...>\n` +
                    `(at least one arg after \`--\` is required; the args are appended after the package or image)\n`,
            );
            process.exit(1);
        }

        const boot = bootstrap();
        if (!existsSync(boot.mcpConfigFile)) {
            process.stderr.write(
                `config/mcp.yml not present; declare the MCP entry first (see ./cli.sh mcp add)\n`,
            );
            process.exit(1);
        }

        const lint = lintMcpConfigFile(boot.mcpConfigFile);
        if (!lint.ok) {
            process.stderr.write(`config/mcp.yml is malformed; fix it before calling. Errors:\n`);
            for (const e of lint.errors) {
                process.stderr.write(`  - ${e}\n`);
            }
            process.exit(1);
        }

        const entry = loadEntry(boot.mcpConfigFile, id);
        if (entry === null) {
            process.stderr.write(`unknown mcp "${id}" (not declared in config/mcp.yml)\n`);
            process.exit(1);
        }

        if (entry.source === "external") {
            process.stderr.write(
                `mcp "${id}" has source: external — no container to call; reach the upstream URL directly\n`,
            );
            process.exit(1);
        }

        const log = createLogger({
            component: "cli",
            level: "info",
            streams: [prettyStdoutStream()],
        });
        const runtimeConfig: RuntimeContainerConfig = {
            tmpDir: boot.tmpDir,
            scratchDir: boot.scratchDir,
            hostUid: boot.hostUid,
            hostGid: boot.hostGid,
        };

        // Pre-create the per-id mount and ensure the runtime image
        // exists. The bastion does both at start; we replicate so
        // `mcp call` works even when the daemon has never run.
        if (entry.source === "npm" || entry.source === "pypi") {
            mkdirSync(mcpMountDirFor(boot.tmpDir, id), { recursive: true });
            void ensureRuntimeImage(entry.source, log).then(
                () => spawnAndExit(entry, runtimeConfig, extraArgs, id),
                (err: unknown) => {
                    const cause = err instanceof Error ? err.message : String(err);
                    process.stderr.write(`failed to build runtime image: ${cause}\n`);
                    process.exit(1);
                },
            );
            return;
        }

        // docker-mcp-registry: the image is pulled lazily by docker
        // on first use; nothing to do here.
        spawnAndExit(entry, runtimeConfig, extraArgs, id);
    },
});

/**
 * Final step shared by all source paths: warn if the bastion is
 * already running this MCP (shared `/work` mount), build the
 * source-specific argv, and hand the terminal to docker. Exits the
 * process with the docker child's status — never returns.
 */
function spawnAndExit(
    entry: McpEntry,
    runtimeConfig: RuntimeContainerConfig,
    extraArgs: readonly string[],
    id: string,
): never {
    void warnIfBastionAlive(id);
    const options: DockerArgsOptions = {
        interactive: process.stdin.isTTY === true,
        containerName: null,
        appendArgs: extraArgs,
    };
    let argv: string[];
    if (entry.source === "npm") {
        argv = buildNpmDockerArgs(entry, runtimeConfig, options);
    } else if (entry.source === "pypi") {
        argv = buildPypiDockerArgs(entry, runtimeConfig, options);
    } else {
        argv = buildDockerRegistryArgs(entry, runtimeConfig, options);
    }
    try {
        process.exit(dockerInteractive(argv));
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${cause}\n`);
        process.exit(1);
    }
}

/**
 * Best-effort probe: if the bastion's `familiar-mcp-<id>` container is
 * currently running, print a one-line warning that this call's
 * one-shot container will share `/work` with it. Doesn't refuse —
 * for the OAuth-setup use case the user wants to log in *while*
 * the daemon is up so the next request finds the token.
 */
async function warnIfBastionAlive(id: string): Promise<void> {
    try {
        const result = await dockerCapture([
            "ps",
            "--filter",
            `name=familiar-mcp-${id}`,
            "--format",
            "{{.Names}}",
        ]);
        if (result.code === 0 && result.stdout.includes(`familiar-mcp-${id}`)) {
            process.stderr.write(
                `note: bastion-managed familiar-mcp-${id} is currently running; this one-shot call will share its /work mount\n`,
            );
        }
    } catch {
        // ignore — docker probe failure isn't worth blocking the call
    }
}

/**
 * Pull a single entry from `mcp.yml` by id. Mirrors the projection
 * `McpList.ts` does: parse the YAML, walk to the named key,
 * shape the fields we need without going through the
 * logger-requiring `loadMcpEntries` path.
 */
function loadEntry(filePath: string, id: string): McpEntry | null {
    const raw = readFileSync(filePath, "utf-8");
    const root = parse(raw);
    if (root === null || root === undefined || typeof root !== "object" || Array.isArray(root)) {
        return null;
    }
    const value = (root as Record<string, unknown>)[id];
    if (
        value === undefined ||
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value)
    ) {
        return null;
    }
    const e = value as Record<string, unknown>;
    const network: McpNetwork = {
        disable: Boolean((e.network as Record<string, unknown> | undefined)?.disable ?? false),
    };
    return {
        id,
        title: (e.title as string) ?? id,
        description: (e.description as string) ?? "",
        source: e.source as McpSource,
        env: ((e.env as McpEnvVar[] | undefined) ?? []).map((env) => ({
            name: env.name,
            value: env.value,
            is_secret: env.is_secret,
            example: env.example,
            description: env.description,
        })),
        volumes: (e.volumes as string[] | undefined) ?? [],
        args: (e.args as string[] | undefined) ?? [],
        command: typeof e.command === "string" ? e.command : null,
        network,
        image: typeof e.image === "string" ? e.image : undefined,
        package: typeof e.package === "string" ? e.package : undefined,
        version: typeof e.version === "string" ? e.version : undefined,
        url: typeof e.url === "string" ? e.url : undefined,
        idleTimeoutSeconds:
            typeof e.idleTimeoutSeconds === "number"
                ? e.idleTimeoutSeconds
                : DEFAULT_IDLE_TIMEOUT_SECONDS,
    };
}
