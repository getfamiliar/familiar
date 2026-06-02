import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildNetworkCreateArgs } from "./DockerTools.js";

describe("buildNetworkCreateArgs", () => {
    it("creates a plain bridge network by default", () => {
        assert.deepEqual(buildNetworkCreateArgs("familiar-net"), [
            "network",
            "create",
            "familiar-net",
        ]);
    });

    it("adds --internal for an egress-less network", () => {
        assert.deepEqual(buildNetworkCreateArgs("familiar-isolated", { internal: true }), [
            "network",
            "create",
            "--internal",
            "familiar-isolated",
        ]);
    });
});
