import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    buildRunArgs,
    buildServeArgs,
    buildUpArgs,
    parseStatus,
    TAILSCALE_IMAGE,
} from "./TailscaleSidecar.js";

describe("buildRunArgs", () => {
    it("runs tailscaled directly in userspace mode, unprivileged", () => {
        const args = buildRunArgs({ stateDir: "/data/tailscale/state", uid: 1000, gid: 1000 });
        const imageIndex = args.indexOf(TAILSCALE_IMAGE);
        assert.equal(args[args.indexOf("--entrypoint") + 1], "tailscaled");
        assert.ok(args.slice(imageIndex).includes("--tun=userspace-networking"));
        assert.ok(args.includes("1000:1000"));
        assert.doesNotMatch(
            args.join(" "),
            /--privileged|NET_ADMIN|\/dev\/net\/tun|--socks5-server|--outbound-http-proxy/,
        );
    });
});

describe("buildUpArgs", () => {
    it("resets prefs to no routes, no DNS, no SSH, no advertisements", () => {
        const args = buildUpArgs({ hostname: "familiar", authKey: null });
        assert.deepEqual(args, [
            "up",
            "--reset",
            "--hostname=familiar",
            "--accept-dns=false",
            "--accept-routes=false",
        ]);
    });

    it("passes the auth key only when configured", () => {
        const args = buildUpArgs({ hostname: "familiar", authKey: "tskey-auth-123" });
        assert.ok(args.includes("--auth-key=tskey-auth-123"));
    });
});

describe("buildServeArgs", () => {
    it("serves HTTPS on :443 only, proxied to the webserver", () => {
        const args = buildServeArgs(8080);
        assert.ok(args.includes("--https=443"));
        assert.equal(args.at(-1), "http://host.docker.internal:8080");
        assert.ok(!args.some((arg) => arg.startsWith("--http=") || arg.startsWith("--tcp")));
    });
});

describe("parseStatus", () => {
    it("reads a node waiting for login", () => {
        const status = parseStatus(
            JSON.stringify({
                BackendState: "NeedsLogin",
                AuthURL: "https://login.tailscale.com/a/x",
                Self: { DNSName: "" },
            }),
        );
        assert.deepEqual(status, {
            backendState: "NeedsLogin",
            authUrl: "https://login.tailscale.com/a/x",
            dnsName: null,
        });
    });

    it("reads a running node and strips the trailing dot", () => {
        const status = parseStatus(
            JSON.stringify({
                BackendState: "Running",
                AuthURL: "",
                Self: { DNSName: "familiar.tail1234.ts.net." },
            }),
        );
        assert.deepEqual(status, {
            backendState: "Running",
            authUrl: null,
            dnsName: "familiar.tail1234.ts.net",
        });
    });
});
