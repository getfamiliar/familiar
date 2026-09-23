import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The vehicle every tool acts on when the caller doesn't name one.
 * VIN and display name are stored alongside the id purely so
 * `familiar tesla status` can name the car without a network call.
 */
export interface DefaultVehicle {
    readonly id: string;
    readonly vin: string;
    readonly displayName: string;
}

/**
 * Resolve the default-vehicle file: `<dataDir>/tesla/default-vehicle.json`.
 *
 * @param dataDir Absolute path of the project's `data/` directory.
 * @returns Absolute path of the file.
 */
export function defaultVehicleFile(dataDir: string): string {
    return path.join(dataDir, "tesla", "default-vehicle.json");
}

/**
 * Remembers which vehicle the agent's tools should act on.
 *
 * Set explicitly by the `tesla_set_default_vehicle` tool, or silently
 * by {@link import("../tools/ResolveVehicle.js").resolveVehicle} when
 * the account holds exactly one car — there is nothing to ask about in
 * that case.
 */
export class DefaultVehicleStore {
    private readonly file: string;

    constructor(file: string) {
        this.file = file;
    }

    /** Absolute path of the backing file. Used by CLI messages. */
    get filePath(): string {
        return this.file;
    }

    /**
     * Read the remembered vehicle.
     *
     * @returns The default vehicle, or `null` when none is set or the
     *   file is unreadable / malformed.
     */
    async read(): Promise<DefaultVehicle | null> {
        let raw: string;
        try {
            raw = await fs.readFile(this.file, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw err;
        }
        try {
            const parsed = JSON.parse(raw) as Partial<DefaultVehicle>;
            if (typeof parsed.id !== "string" || parsed.id.length === 0) {
                return null;
            }
            return {
                id: parsed.id,
                vin: typeof parsed.vin === "string" ? parsed.vin : "",
                displayName: typeof parsed.displayName === "string" ? parsed.displayName : "",
            };
        } catch {
            return null;
        }
    }

    /**
     * Persist the default vehicle atomically.
     *
     * @param vehicle The vehicle to remember.
     */
    async write(vehicle: DefaultVehicle): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(vehicle, null, 2)}\n`);
        await fs.rename(tmp, this.file);
    }
}
