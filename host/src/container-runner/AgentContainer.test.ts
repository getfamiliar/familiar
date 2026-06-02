import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ISOLATED_NETWORK_NAME, SHARED_NETWORK_NAME } from "../DockerTools.js";
import { type AgentContainerConfig, buildAgentRunArgs } from "./AgentContainer.js";

/**
 * Minimal {@link AgentContainerConfig} fixture. Callers override only
 * the fields they assert against.
 */
function configFixture(overrides: Partial<AgentContainerConfig> = {}): AgentContainerConfig {
    return {
        imageName: "familiar-agent",
        dataPath: "/data",
        containerSrcPath: "/src",
        sharedBuildPath: "/shared/build",
        scratchPath: "/scratch",
        postgresPassword: "pw",
        bastionUrl: "http://familiar-bastion-bridge:8788",
        defaultProvider: "featherless",
        defaultModel: "zai-org/GLM-5.1",
        inferenceMaxRetries: 3,
        inferenceOutputFallbackPercentage: 0.7,
        toolCallOffloadingLimit: 16000,
        inferenceKeptToolResultCount: 4,
        inferenceSlidingWindowPercentage: 0.8,
        agentStepTimeoutSeconds: 120,
        captureRawStepResultToDatabase: false,
        logSystemPromptMode: "off",
        providerNpmPackages: { featherless: "@ai-sdk/openai-compatible" },
        verbose: false,
        coreTimezone: "Europe/Berlin",
        writablePaths: [],
        ...overrides,
    };
}

describe("buildAgentRunArgs — egress lockdown invariant", () => {
    it("joins ONLY the egress-less isolated network", () => {
        const argv = buildAgentRunArgs(configFixture());
        const netFlag = argv.indexOf("--network");
        assert.notEqual(netFlag, -1, "expected a --network flag");
        assert.equal(argv[netFlag + 1], ISOLATED_NETWORK_NAME);
        // Exactly one --network flag, and never the shared (internet-capable) net.
        assert.equal(argv.filter((a) => a === "--network").length, 1);
        assert.ok(!argv.includes(SHARED_NETWORK_NAME), "agent must not touch familiar-net");
    });

    it("does NOT grant any path to the host (no host-gateway, no add-host)", () => {
        const argv = buildAgentRunArgs(configFixture());
        assert.ok(!argv.includes("--add-host"), "no --add-host");
        assert.ok(
            !argv.some((a) => a.includes("host.docker.internal")),
            "no host.docker.internal mapping",
        );
        assert.ok(!argv.some((a) => a.includes("host-gateway")), "no host-gateway");
    });

    it("does NOT override DNS (embedded resolver kills external names on the internal net)", () => {
        const argv = buildAgentRunArgs(configFixture());
        assert.ok(!argv.includes("--dns"), "no --dns override");
    });

    it("points BASTION_URL at the bridge sidecar", () => {
        const argv = buildAgentRunArgs(
            configFixture({ bastionUrl: "http://familiar-bastion-bridge:8788" }),
        );
        assert.ok(argv.includes("BASTION_URL=http://familiar-bastion-bridge:8788"));
    });
});
