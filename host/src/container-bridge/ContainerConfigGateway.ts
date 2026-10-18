import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "@getfamiliar/shared";
import type { Bastion, BastionModule } from "../bastion/Bastion.js";

/** URL prefix the gateway claims on the bastion's HTTP server. */
const PREFIX = "/container-config/";

/** Response body of `GET /container-config/`. */
export interface ContainerConfigResponse {
    /** Bumped on every {@link ContainerConfigGateway.publish}; the first is 1. */
    readonly version: number;
    /** The flat config map the container reads through `PassedConfig`. */
    readonly values: Readonly<Record<string, unknown>>;
}

/** Configuration for the {@link ContainerConfigGateway} bastion module. */
export interface ContainerConfigGatewayConfig {
    /** Logger child for lifecycle lines. */
    readonly log: Logger;
}

/**
 * Bastion module serving the agent container's current passed config.
 * The daemon {@link publish}es the map once before starting the container
 * (which also gets it in its `FAMILIAR_CONTAINER_CONFIG` env var) and
 * again after every config reload; the container fetches it once per
 * agentrun and overlays it on the env blob. So reloadable container settings (model aliases,
 * retries, timeouts, …) apply from the next agentrun on without a
 * container restart; runs in progress keep their snapshot.
 *
 * Wire: `GET /container-config/` → 200 `{ version, values }`, 503 before
 * the first publish, 405 for other methods. Authentication is the
 * bastion's shared-token check.
 */
export class ContainerConfigGateway implements BastionModule {
    readonly name = "container-config-gateway";

    private readonly log: Logger;
    private current: ContainerConfigResponse | undefined;

    constructor(config: ContainerConfigGatewayConfig) {
        this.log = config.log;
    }

    async start(bastion: Bastion): Promise<void> {
        bastion.registerPrefix(PREFIX, (req, res) => this.dispatch(req, res));
        this.log.info(`container-config-gateway registered ${PREFIX}`);
    }

    async stop(): Promise<void> {
        // No resources of our own.
    }

    /**
     * Replace the served map and bump the version (the first publish is
     * version 1).
     *
     * @param values The rebuilt flat config map.
     * @returns The new version.
     */
    publish(values: Readonly<Record<string, unknown>>): number {
        const version = (this.current?.version ?? 0) + 1;
        this.current = { version, values };
        this.log.info(`container config published (version ${version})`);
        return version;
    }

    /** Single-route dispatch: only `GET /container-config/`. */
    private dispatch(req: IncomingMessage, res: ServerResponse): void {
        if (req.method !== "GET") {
            res.writeHead(405, { "content-type": "text/plain" });
            res.end("GET /container-config/ only");
            return;
        }
        if (this.current === undefined) {
            res.writeHead(503, { "content-type": "text/plain" });
            res.end("container config not published yet");
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.current));
    }
}
