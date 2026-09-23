import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TeslaAuth } from "../auth/TeslaAuth.js";
import { TokenStore, tokenFile } from "../auth/TokenStore.js";
import { OwnerApiClient } from "./OwnerApiClient.js";

/**
 * Live smoke test against the real Owner API. It runs only when this
 * checkout actually holds a Tesla login (`data/tesla/auth.json`) — on
 * CI and on a fresh clone it skips, so `npm test` stays hermetic.
 *
 * Assertions are structural and about durable properties of the
 * account (a VIN is 17 characters, ids are non-empty), never about a
 * specific car, because the fixture is whatever the developer's
 * account happens to hold today.
 *
 * Only the vehicle *list* is touched: it answers for sleeping cars,
 * so running the suite never wakes anything or costs battery.
 */
const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");

describe("OwnerApiClient (live)", () => {
    it("lists the account's vehicles", async (t) => {
        const file = tokenFile(DATA_DIR);
        if (!existsSync(file)) {
            t.skip(`no Tesla login at ${file} — run \`familiar tesla login\``);
            return;
        }
        const auth = new TeslaAuth(new TokenStore(file));
        if ((await auth.load()) === null) {
            t.skip("Tesla token file is unreadable or malformed");
            return;
        }

        const client = new OwnerApiClient(() => auth.getAccessToken());
        const vehicles = await client.listVehicles();
        assert.ok(Array.isArray(vehicles));
        for (const vehicle of vehicles) {
            assert.ok(vehicle.id.length > 0, "every vehicle must carry a usable id");
            assert.equal(vehicle.vin.length, 17, `VIN should be 17 chars, got "${vehicle.vin}"`);
            assert.ok(vehicle.state.length > 0);
        }
    });
});
