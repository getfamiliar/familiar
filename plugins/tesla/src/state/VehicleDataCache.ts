import { promises as fs } from "node:fs";
import path from "node:path";
import type { VehicleData } from "../api/OwnerApiClient.js";

/** A cached `vehicle_data` rollup plus when it was taken. */
export interface CachedVehicleData {
    /** Epoch milliseconds the cache entry was written. */
    readonly fetchedAt: number;
    readonly data: VehicleData;
}

/**
 * Resolve the cache directory: `<dataDir>/tesla/cache/`.
 *
 * @param dataDir Absolute path of the project's `data/` directory.
 * @returns Absolute path of the cache directory.
 */
export function cacheDirectory(dataDir: string): string {
    return path.join(dataDir, "tesla", "cache");
}

/**
 * Last-known-good `vehicle_data` per vehicle, written on every
 * successful fetch and read back when the car refuses to wake inside
 * the timeout.
 *
 * `tesla_info` and `tesla_location` share one entry — location is a
 * slice of the same rollup, so caching them separately would let the
 * two answers disagree about when the car was last seen.
 */
export class VehicleDataCache {
    private readonly directory: string;

    constructor(directory: string) {
        this.directory = directory;
    }

    /**
     * Read the cached rollup for one vehicle.
     *
     * @param vehicleId The vehicle's `id_s`.
     * @returns The cache entry, or `null` when nothing is cached or the
     *   file is unreadable / malformed.
     */
    async read(vehicleId: string): Promise<CachedVehicleData | null> {
        let raw: string;
        try {
            raw = await fs.readFile(this.fileFor(vehicleId), "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw err;
        }
        try {
            const parsed = JSON.parse(raw) as Partial<CachedVehicleData>;
            if (typeof parsed.fetchedAt !== "number" || typeof parsed.data !== "object") {
                return null;
            }
            return { fetchedAt: parsed.fetchedAt, data: (parsed.data ?? {}) as VehicleData };
        } catch {
            return null;
        }
    }

    /**
     * Replace the cached rollup for one vehicle, atomically.
     *
     * @param vehicleId The vehicle's `id_s`.
     * @param data The freshly fetched rollup.
     */
    async write(vehicleId: string, data: VehicleData): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true });
        const file = this.fileFor(vehicleId);
        const tmp = `${file}.tmp`;
        const entry: CachedVehicleData = { fetchedAt: Date.now(), data };
        await fs.writeFile(tmp, JSON.stringify(entry));
        await fs.rename(tmp, file);
    }

    /**
     * Cache-file path for one vehicle. The id is sanitised to a bare
     * basename so a hostile id can never escape the cache directory.
     *
     * @param vehicleId The vehicle's `id_s`.
     * @returns Absolute path of that vehicle's cache file.
     */
    private fileFor(vehicleId: string): string {
        return path.join(this.directory, `${vehicleId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
    }
}
