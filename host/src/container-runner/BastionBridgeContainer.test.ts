import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ISOLATED_NETWORK_NAME, SHARED_NETWORK_NAME } from "../DockerTools.js";
import { BRIDGE_IMAGE_TAG, buildBridgeRunArgs } from "./BastionBridgeContainer.js";

describe("buildBridgeRunArgs", () => {
    it("runs on familiar-net so host.docker.internal reaches the host bastion", () => {
        const argv = buildBridgeRunArgs({ imageName: BRIDGE_IMAGE_TAG, bastionPort: 8788 });
        const netFlag = argv.indexOf("--network");
        assert.equal(argv[netFlag + 1], SHARED_NETWORK_NAME);
        // It is NOT launched directly on the isolated net (it's attached
        // there afterwards via connectNetwork, not at run time).
        assert.ok(!argv.includes(ISOLATED_NETWORK_NAME));
    });

    it("forwards its listen port to the host bastion via socat", () => {
        const argv = buildBridgeRunArgs({ imageName: BRIDGE_IMAGE_TAG, bastionPort: 8788 });
        const tail = argv.slice(argv.indexOf(BRIDGE_IMAGE_TAG) + 1);
        assert.deepEqual(tail, [
            "socat",
            "TCP-LISTEN:8788,fork,reuseaddr",
            "TCP:host.docker.internal:8788",
        ]);
    });

    it("respects a custom bastion port on both sides of the relay", () => {
        const argv = buildBridgeRunArgs({ imageName: BRIDGE_IMAGE_TAG, bastionPort: 9999 });
        assert.ok(argv.includes("TCP-LISTEN:9999,fork,reuseaddr"));
        assert.ok(argv.includes("TCP:host.docker.internal:9999"));
    });
});
