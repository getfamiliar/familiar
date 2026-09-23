import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OwnerApiClient } from "./OwnerApiClient.js";

/**
 * Replace the global `fetch` with one answering a fixed body, recording
 * the URLs it saw. Returns a restore closure the test must call.
 */
function stubFetch(body: unknown): { restore: () => void; urls: string[] } {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof globalThis.fetch;
    return {
        restore: () => {
            globalThis.fetch = original;
        },
        urls,
    };
}

/** One `/api/1/products` entry for a car, trimmed to the fields we read. */
const VEHICLE_PRODUCT = {
    id: 930096031788957,
    id_s: "930096031788957",
    vehicle_id: 1689102173140124,
    vin: "LRWYGCEK2MC124394",
    display_name: "Nessy",
    state: "offline",
    command_signing: "required",
};

/** An energy product: same envelope, no VIN. */
const ENERGY_PRODUCT = {
    energy_site_id: 123456,
    resource_type: "battery",
    site_name: "Home",
};

describe("OwnerApiClient.listVehicles", () => {
    it("reads /api/1/products, not the withdrawn /api/1/vehicles", async () => {
        // `/api/1/vehicles` answers `412 Endpoint is only available on
        // fleetapi`. Pinning the path here means a revert to the old
        // endpoint fails in CI rather than in the user's terminal.
        const { restore, urls } = stubFetch({ response: [VEHICLE_PRODUCT] });
        try {
            await new OwnerApiClient(async () => "tok").listVehicles();
            assert.equal(urls.length, 1);
            assert.match(urls[0], /\/api\/1\/products$/);
        } finally {
            restore();
        }
    });

    it("normalises a product into a vehicle, preferring the string id", async () => {
        const { restore } = stubFetch({ response: [VEHICLE_PRODUCT] });
        try {
            const vehicles = await new OwnerApiClient(async () => "tok").listVehicles();
            assert.deepEqual(vehicles, [
                {
                    // `id_s`, because the numeric form exceeds 2^53.
                    id: "930096031788957",
                    vehicleId: 1689102173140124,
                    vin: "LRWYGCEK2MC124394",
                    displayName: "Nessy",
                    state: "offline",
                    commandSigning: "required",
                },
            ]);
        } finally {
            restore();
        }
    });

    it("drops energy products, which carry no VIN", async () => {
        const { restore } = stubFetch({ response: [ENERGY_PRODUCT, VEHICLE_PRODUCT] });
        try {
            const vehicles = await new OwnerApiClient(async () => "tok").listVehicles();
            assert.equal(vehicles.length, 1);
            assert.equal(vehicles[0].vin, "LRWYGCEK2MC124394");
        } finally {
            restore();
        }
    });

    it("tolerates an account with no products at all", async () => {
        const { restore } = stubFetch({ response: [] });
        try {
            assert.deepEqual(await new OwnerApiClient(async () => "tok").listVehicles(), []);
        } finally {
            restore();
        }
    });
});
