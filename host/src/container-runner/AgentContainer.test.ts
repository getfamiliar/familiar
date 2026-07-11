import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ISOLATED_NETWORK_NAME, SHARED_NETWORK_NAME } from "../DockerTools.js";
import {
    type AgentContainerConfig,
    buildAgentImageArgs,
    buildAgentRunArgs,
    buildPythonPackagesArg,
} from "./AgentContainer.js";

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
        mountSource: true,
        scratchPath: "/scratch",
        containerConfigJson: JSON.stringify({ bastionUrl: "http://familiar-bastion-bridge:8788" }),
        writablePaths: [],
        hostUid: 1000,
        hostGid: 1000,
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

    it("forwards the container config blob as the single FAMILIAR_CONTAINER_CONFIG env var", () => {
        const json = JSON.stringify({ bastionUrl: "http://familiar-bastion-bridge:8788" });
        const argv = buildAgentRunArgs(configFixture({ containerConfigJson: json }));
        assert.ok(argv.includes(`FAMILIAR_CONTAINER_CONFIG=${json}`));
    });

    it("forwards host uid/gid as env, not as a docker --user flag", () => {
        // Ownership sync happens via the entrypoint provisioning `priv` at
        // HOST_UID and gosu-dropping to it — NOT `--user`, which would make
        // the whole container one user and block the in-container drop to the
        // unprivileged bash user.
        const argv = buildAgentRunArgs(configFixture({ hostUid: 1007, hostGid: 1009 }));
        assert.ok(argv.includes("HOST_UID=1007"), "HOST_UID env expected");
        assert.ok(argv.includes("HOST_GID=1009"), "HOST_GID env expected");
        assert.ok(!argv.includes("--user"), "agent container must not pin --user");
    });

    it("forwards writablePaths as the discrete CORE_WRITABLE_PATHS env var (for the shell entrypoint)", () => {
        // The shell entrypoint reads CORE_WRITABLE_PATHS before Node, so it
        // stays a discrete env var rather than riding in the JSON blob.
        const argv = buildAgentRunArgs(configFixture({ writablePaths: ["wiki/**", "files/**"] }));
        assert.ok(
            argv.includes(`CORE_WRITABLE_PATHS=${JSON.stringify(["wiki/**", "files/**"])}`),
            "CORE_WRITABLE_PATHS env expected",
        );
    });
});

describe("buildAgentRunArgs — source mounts follow mountSource", () => {
    it("overlays container/src and shared/build in build mode (mountSource: true)", () => {
        const argv = buildAgentRunArgs(configFixture({ mountSource: true }));
        assert.ok(argv.includes("/src:/app/src:ro"), "container/src overlay expected");
        assert.ok(argv.includes("/shared/build:/shared/build:ro"), "shared/build overlay expected");
        // The workspace and scratch mounts are always present.
        assert.ok(argv.includes("/data/workspace:/workspace"));
        assert.ok(argv.includes("/scratch:/scratch"));
    });

    it("omits the source overlays in pull mode (mountSource: false) — image is baked", () => {
        const argv = buildAgentRunArgs(configFixture({ mountSource: false }));
        assert.ok(!argv.some((a) => a === "/src:/app/src:ro"), "no container/src overlay");
        assert.ok(!argv.some((a) => a.endsWith(":/shared/build:ro")), "no shared/build overlay");
        // Workspace and scratch mounts remain.
        assert.ok(argv.includes("/data/workspace:/workspace"));
        assert.ok(argv.includes("/scratch:/scratch"));
        // The image is still the last positional arg.
        assert.equal(argv[argv.length - 1], "familiar-agent");
    });
});

describe("buildPythonPackagesArg", () => {
    it("joins valid pip requirements (name, extras, version specifiers) with spaces", () => {
        assert.equal(
            buildPythonPackagesArg(["numpy", "pandas>=2,<3", "uvicorn[standard]"]),
            "numpy pandas>=2,<3 uvicorn[standard]",
        );
    });

    it("returns an empty string for an empty list", () => {
        assert.equal(buildPythonPackagesArg([]), "");
    });

    it("rejects entries with shell metacharacters or whitespace", () => {
        for (const bad of ["numpy; rm -rf /", "$(touch x)", "a b", "pkg`id`", "&&evil"]) {
            assert.throws(() => buildPythonPackagesArg([bad]), /Invalid python\.packages entry/);
        }
    });
});

describe("buildAgentImageArgs", () => {
    it("passes the python packages as a single PYTHON_PACKAGES build-arg", () => {
        const argv = buildAgentImageArgs("/p/container/Dockerfile", "/p", ["numpy", "ics"]);
        const i = argv.indexOf("--build-arg");
        assert.notEqual(i, -1, "expected a --build-arg");
        assert.equal(argv[i + 1], "PYTHON_PACKAGES=numpy ics");
        assert.equal(argv[0], "build");
        assert.equal(argv[argv.length - 1], "/p", "build context is the last arg");
    });
});
