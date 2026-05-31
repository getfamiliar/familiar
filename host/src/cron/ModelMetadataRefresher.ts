import type { Logger } from "@getfamiliar/shared";
import { Cron } from "croner";
import type { ModelMetadataService } from "../models/ModelMetadataService.js";

/**
 * Daily, a few minutes past 04:00 — off the top-of-hour boundary the
 * other core jobs use (e.g. {@link import("./ScratchGc.js").ScratchGc}),
 * so the morning refetch doesn't pile onto an hourly sweep.
 */
const REFRESH_SCHEDULE = "5 4 * * *";

export interface ModelMetadataRefresherConfig {
    /** The service whose models.dev cache is refreshed. */
    readonly service: ModelMetadataService;
    /** Logger; lifecycle lines at `info`. */
    readonly log: Logger;
}

/**
 * Daily Croner job that refetches the models.dev catalogue into the
 * service's on-disk cache. Symmetric with {@link ScratchGc}: a thin
 * wrapper that owns the `Cron` handle and a `start`/`stop` pair, keeping
 * the refresh cadence out of {@link ModelMetadataService} (which only
 * knows how to fetch) and out of the daemon bootstrap.
 *
 * The refresh-if-stale on daemon start is done separately by the caller;
 * this job is the steady-state 24h cadence while the daemon runs.
 */
export class ModelMetadataRefresher {
    private readonly service: ModelMetadataService;
    private readonly log: Logger;
    private job: Cron | undefined;

    constructor(config: ModelMetadataRefresherConfig) {
        this.service = config.service;
        this.log = config.log;
    }

    /** Schedule the daily refresh. Safe to call once at daemon startup. */
    start(): void {
        if (this.job) {
            return;
        }
        this.job = new Cron(REFRESH_SCHEDULE, () => {
            void this.service.refresh();
        });
        this.log.info({ schedule: REFRESH_SCHEDULE }, "models.dev refresh scheduled");
    }

    /** Cancel the cron and forget the handle. */
    stop(): void {
        if (!this.job) {
            return;
        }
        this.job.stop();
        this.job = undefined;
    }
}
