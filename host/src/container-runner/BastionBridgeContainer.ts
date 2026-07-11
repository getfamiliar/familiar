import type { Logger } from "@getfamiliar/shared";
import type { Bootstrap } from "../Bootstrap.js";
import {
    connectNetwork,
    dockerExec,
    hostGatewayArgs,
    ISOLATED_NETWORK_NAME,
    removeContainer,
    SHARED_NETWORK_NAME,
    stopContainer,
} from "../DockerTools.js";
import { pullImageIfNeeded } from "./Images.js";

/**
 * Name of the bastion-bridge sidecar container, and the hostname the
 * agent dials it by on the `familiar-isolated` network (resolved by
 * Docker's embedded DNS). Exported so the daemon can build the agent's
 * `BASTION_URL` against the same name.
 */
export const BASTION_BRIDGE_HOST = "familiar-bastion-bridge";

/** Name of the bastion-bridge sidecar container. */
const CONTAINER_NAME = BASTION_BRIDGE_HOST;

/**
 * Image tag for the socat relay sidecar. Built from
 * `container/bridge.Dockerfile` on demand by {@link ensureBridgeImage}.
 */
export const BRIDGE_IMAGE_TAG = "familiar-bastion-bridge-img";

/**
 * Ensure the bastion-bridge image is available under
 * {@link BRIDGE_IMAGE_TAG}. In `"pull"` mode the version-pinned image is
 * pulled and tagged locally; in `"build"` mode it's built from
 * `container/bridge.Dockerfile` with the checkout as context. Idempotent.
 * Mirrors {@link ensureAgentImage}. The `apk add socat` inside the
 * Dockerfile needs host internet on first build only; the result is
 * cached.
 *
 * @param boot Bootstrap providing image mode, registry/tag, and (build mode) the context root.
 * @param log Logger for the build/pull step.
 */
export async function ensureBridgeImage(boot: Bootstrap, log: Logger): Promise<void> {
    if (await pullImageIfNeeded(boot, BRIDGE_IMAGE_TAG, log)) {
        return;
    }
    const dockerfile = `${boot.homeDir}/container/bridge.Dockerfile`;
    log.info(`building ${BRIDGE_IMAGE_TAG} from ${dockerfile}`);
    await dockerExec(["build", "-t", BRIDGE_IMAGE_TAG, "-f", dockerfile, boot.homeDir]);
}

/** Configuration for the {@link BastionBridgeContainer}. */
export interface BastionBridgeContainerConfig {
    /** Docker image tag to run (e.g. {@link BRIDGE_IMAGE_TAG}). */
    readonly imageName: string;
    /**
     * Port the host bastion listens on (default 8788). The sidecar both
     * listens on this port (on its `familiar-isolated` interface, where
     * the agent dials it) and forwards to `host.docker.internal:<port>`.
     */
    readonly bastionPort: number;
}

/**
 * Build the `docker run` argument vector for the bridge sidecar. Pure
 * (no side effects) so it can be unit-tested without a daemon.
 *
 * The sidecar is launched on `familiar-net` (so `host.docker.internal`
 * resolves to the host bastion, exactly as the agent did before
 * lockdown) and later attached to `familiar-isolated` (see
 * {@link BastionBridgeContainer.start}). socat forks per connection so
 * the agent's many concurrent LLM-stream / MCP connections are served.
 *
 * @param config Sidecar configuration.
 * @returns The full docker CLI argv.
 */
export function buildBridgeRunArgs(config: BastionBridgeContainerConfig): string[] {
    const port = config.bastionPort;
    return [
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        "--network",
        SHARED_NETWORK_NAME,
        // Reach the host bastion via `host.docker.internal` just like the
        // pre-lockdown agent did — added on Linux, native on macOS/Windows.
        ...hostGatewayArgs(),
        config.imageName,
        "socat",
        `TCP-LISTEN:${port},fork,reuseaddr`,
        `TCP:host.docker.internal:${port}`,
    ];
}

/**
 * Manages the bastion-bridge sidecar (`familiar-bastion-bridge`).
 *
 * The agent runs on the egress-less `familiar-isolated` network and
 * cannot reach the host-process bastion directly. This sidecar straddles
 * both networks — `familiar-net` (where `host.docker.internal` routes to
 * the host) and `familiar-isolated` (where the agent dials it as
 * `familiar-bastion-bridge:<port>`) — and forwards the agent's bastion
 * TCP to the host. It is the agent's only path off the isolated network,
 * hardwired to the single bastion endpoint, so a bash-enabled agent
 * cannot repurpose it to reach anything else.
 */
export class BastionBridgeContainer {
    private readonly config: BastionBridgeContainerConfig;
    private running = false;

    constructor(config: BastionBridgeContainerConfig) {
        this.config = config;
    }

    /** True if `start()` has succeeded and `stop()` has not yet been called. */
    get isRunning(): boolean {
        return this.running;
    }

    /**
     * Start the sidecar detached on `familiar-net`, then attach it to
     * `familiar-isolated` so the agent can reach it by name. Removes any
     * previous container with the same name first so this is safe to call
     * after a crash.
     */
    async start(): Promise<void> {
        await removeContainer(CONTAINER_NAME);
        await dockerExec(buildBridgeRunArgs(this.config));
        await connectNetwork(ISOLATED_NETWORK_NAME, CONTAINER_NAME);
        this.running = true;
    }

    /** Stop and remove the sidecar. */
    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }
        await stopContainer(CONTAINER_NAME);
        await removeContainer(CONTAINER_NAME);
        this.running = false;
    }
}
