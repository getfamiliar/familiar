import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OwnerApiClient, TeslaVehicle, VehicleData } from "../api/OwnerApiClient.js";
import { TeslaApiError } from "../api/TeslaApiError.js";
import type { TeslaSession } from "../auth/ActiveSession.js";
import type { DefaultVehicle } from "../state/DefaultVehicleStore.js";
import type { CachedVehicleData } from "../state/VehicleDataCache.js";
import { fetchVehicleData, resolveVehicle } from "./ResolveVehicle.js";

function vehicle(id: string, state = "online"): TeslaVehicle {
    return {
        id,
        vehicleId: 1,
        vin: `VIN${id}`,
        displayName: `Car ${id}`,
        state,
        commandSigning: "required",
    };
}

/**
 * Build a session whose API client and stores are in-memory stubs.
 * `writes` records what the default-vehicle store was asked to persist
 * so the "adopt the only car" path is observable.
 */
function fakeSession(options: {
    vehicles: readonly TeslaVehicle[];
    stored?: DefaultVehicle | null;
    cached?: CachedVehicleData | null;
    vehicleData?: VehicleData;
    /** States `getVehicle` reports on successive polls. */
    pollStates?: readonly string[];
    wakeTimeoutSeconds?: number;
}): {
    session: TeslaSession;
    writes: DefaultVehicle[];
    cacheWrites: { id: string; data: VehicleData }[];
} {
    const writes: DefaultVehicle[] = [];
    const cacheWrites: { id: string; data: VehicleData }[] = [];
    let stored = options.stored ?? null;
    const polls = [...(options.pollStates ?? [])];

    const owner = {
        listVehicles: async () => options.vehicles,
        getVehicle: async (id: string) => vehicle(id, polls.shift() ?? "asleep"),
        wakeUp: async (id: string) => vehicle(id, polls.shift() ?? "asleep"),
        getVehicleData: async () => {
            if (options.vehicleData === undefined) {
                throw new TeslaApiError(408, "/vehicle_data", "vehicle unavailable");
            }
            return options.vehicleData;
        },
    } as unknown as OwnerApiClient;

    const session = {
        owner,
        defaults: {
            read: async () => stored,
            write: async (v: DefaultVehicle) => {
                stored = v;
                writes.push(v);
            },
        },
        cache: {
            read: async () => options.cached ?? null,
            write: async (id: string, data: VehicleData) => {
                cacheWrites.push({ id, data });
            },
        },
        config: { wakeTimeoutSeconds: options.wakeTimeoutSeconds ?? 0 },
    } as unknown as TeslaSession;

    return { session, writes, cacheWrites };
}

describe("resolveVehicle", () => {
    it("adopts the only vehicle without asking", async () => {
        const { session, writes } = fakeSession({ vehicles: [vehicle("1")] });
        const result = await resolveVehicle(session);
        assert.equal(result.kind, "vehicle");
        assert.equal(writes.length, 1);
        assert.equal(writes[0].id, "1");
    });

    it("asks the user to choose when several vehicles and no default", async () => {
        const { session, writes } = fakeSession({ vehicles: [vehicle("1"), vehicle("2")] });
        const result = await resolveVehicle(session);
        assert.equal(result.kind, "needs-choice");
        if (result.kind !== "needs-choice") {
            return;
        }
        assert.match(result.message, /tesla_set_default_vehicle/);
        // The table must carry every id so the agent can relay the choice.
        assert.match(result.message, /\| 1 \|/);
        assert.match(result.message, /\| 2 \|/);
        assert.equal(writes.length, 0, "must not guess a default");
    });

    it("uses the remembered vehicle", async () => {
        const { session, writes } = fakeSession({
            vehicles: [vehicle("1"), vehicle("2")],
            stored: { id: "2", vin: "VIN2", displayName: "Car 2" },
        });
        const result = await resolveVehicle(session);
        assert.equal(result.kind, "vehicle");
        if (result.kind !== "vehicle") {
            return;
        }
        assert.equal(result.vehicle.id, "2");
        assert.equal(writes.length, 0);
    });

    it("treats a remembered vehicle that left the account as unset", async () => {
        const { session } = fakeSession({
            vehicles: [vehicle("1"), vehicle("2")],
            stored: { id: "gone", vin: "VINgone", displayName: "Old car" },
        });
        const result = await resolveVehicle(session);
        assert.equal(result.kind, "needs-choice");
    });

    it("fails when the account has no vehicles", async () => {
        const { session } = fakeSession({ vehicles: [] });
        await assert.rejects(() => resolveVehicle(session), /no vehicles/);
    });
});

describe("fetchVehicleData", () => {
    it("reads live data from an online car and refreshes the cache", async () => {
        const data: VehicleData = { drive_state: { latitude: 1, longitude: 2 } };
        const { session, cacheWrites } = fakeSession({
            vehicles: [vehicle("1")],
            vehicleData: data,
        });
        const result = await fetchVehicleData(session, vehicle("1"));
        assert.equal(result.fromCache, false);
        assert.equal(result.cachedAt, null);
        assert.deepEqual(result.data, data);
        assert.equal(cacheWrites.length, 1);
    });

    it("falls back to the cache when the car will not wake", async () => {
        const fetchedAt = Date.parse("2026-09-20T08:00:00Z");
        const { session, cacheWrites } = fakeSession({
            vehicles: [vehicle("1", "asleep")],
            cached: { fetchedAt, data: { drive_state: { latitude: 3 } } },
        });
        const result = await fetchVehicleData(session, vehicle("1", "asleep"));
        assert.equal(result.fromCache, true);
        assert.equal(result.cachedAt, new Date(fetchedAt).toISOString());
        assert.equal(cacheWrites.length, 0, "a cache read must not rewrite the cache");
    });

    it("fails clearly when the car will not wake and nothing is cached", async () => {
        const { session } = fakeSession({ vehicles: [vehicle("1", "asleep")], cached: null });
        await assert.rejects(
            () => fetchVehicleData(session, vehicle("1", "asleep")),
            /did not wake within 0s and no earlier data is cached/,
        );
    });

    it("wakes a sleeping car that comes online and then reads live", async () => {
        const data: VehicleData = { drive_state: { latitude: 9 } };
        const { session } = fakeSession({
            vehicles: [vehicle("1", "asleep")],
            vehicleData: data,
            // wake_up itself reports online on the first call.
            pollStates: ["online"],
        });
        const result = await fetchVehicleData(session, vehicle("1", "asleep"));
        assert.equal(result.fromCache, false);
        assert.deepEqual(result.data, data);
    });
});

describe("fetchVehicleData — stale state", () => {
    it("wakes a car the list called online but that answers 408", async () => {
        const data: VehicleData = { drive_state: { latitude: 7 } };
        let reads = 0;
        const owner = {
            listVehicles: async () => [vehicle("1")],
            getVehicle: async (id: string) => vehicle(id, "online"),
            wakeUp: async (id: string) => vehicle(id, "online"),
            getVehicleData: async () => {
                reads += 1;
                // Asleep on the optimistic first read, awake after the wake.
                if (reads === 1) {
                    throw new TeslaApiError(408, "/vehicle_data", "vehicle unavailable");
                }
                return data;
            },
        } as unknown as OwnerApiClient;
        const session = {
            owner,
            defaults: { read: async () => null, write: async () => {} },
            cache: { read: async () => null, write: async () => {} },
            config: { wakeTimeoutSeconds: 0 },
        } as unknown as TeslaSession;

        const result = await fetchVehicleData(session, vehicle("1"));
        assert.equal(reads, 2, "must retry the read after waking");
        assert.equal(result.fromCache, false);
        assert.deepEqual(result.data, data);
    });

    it("propagates a non-availability error instead of reporting a stale answer", async () => {
        const owner = {
            listVehicles: async () => [vehicle("1")],
            getVehicle: async (id: string) => vehicle(id, "online"),
            wakeUp: async (id: string) => vehicle(id, "online"),
            getVehicleData: async () => {
                throw new TeslaApiError(401, "/vehicle_data", "invalid bearer token");
            },
        } as unknown as OwnerApiClient;
        const session = {
            owner,
            defaults: { read: async () => null, write: async () => {} },
            cache: {
                read: async () => ({ fetchedAt: Date.now(), data: {} }),
                write: async () => {},
            },
            config: { wakeTimeoutSeconds: 0 },
        } as unknown as TeslaSession;

        // A dead token must surface as a dead token, not as "the car is
        // asleep, here is yesterday's position".
        await assert.rejects(() => fetchVehicleData(session, vehicle("1")), /401/);
    });
});
