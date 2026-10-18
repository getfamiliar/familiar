import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "@getfamiliar/shared";
import type { Bastion, BastionModule } from "../bastion/Bastion.js";
import type { DaemonReloader } from "./DaemonReloader.js";

/** URL prefix the gateway claims on the bastion's HTTP server. */
export const RELOAD_PREFIX = "/config-reload/";

/** Configuration for the {@link ReloadGateway} bastion module. */
export interface ReloadGatewayConfig {
    /** The daemon's reloader. */
    readonly reloader: DaemonReloader;
    /** Logger child for lifecycle lines. */
    readonly log: Logger;
}

/**
 * Bastion module behind `familiar config reload`: `POST /config-reload/`
 * runs {@link DaemonReloader.reload} and answers 200 with the
 * {@link import("./DaemonReloader.js").ReloadReport} as JSON (validation
 * errors are part of the report, not an HTTP error). 405 for other
 * methods. Authentication is the bastion's shared-token check — the CLI
 * reads the token from `tmp/.bastion-token`.
 */
export class ReloadGateway implements BastionModule {
    readonly name = "reload-gateway";

    private readonly reloader: DaemonReloader;
    private readonly log: Logger;

    constructor(config: ReloadGatewayConfig) {
        this.reloader = config.reloader;
        this.log = config.log;
    }

    async start(bastion: Bastion): Promise<void> {
        bastion.registerPrefix(RELOAD_PREFIX, (req, res) => this.dispatch(req, res));
        this.log.info(`reload-gateway registered ${RELOAD_PREFIX}`);
    }

    async stop(): Promise<void> {
        // No resources of our own.
    }

    /** Single-route dispatch: only `POST /config-reload/`. */
    private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method !== "POST") {
            res.writeHead(405, { "content-type": "text/plain" });
            res.end("POST /config-reload/ only");
            return;
        }
        const report = await this.reloader.reload();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(report));
    }
}
