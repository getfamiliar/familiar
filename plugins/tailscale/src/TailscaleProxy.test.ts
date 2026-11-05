import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PROXY_SECRET_HEADER } from "@getfamiliar/shared";
import {
    buildCaddyfile,
    buildProxyRunArgs,
    CADDY_IMAGE,
    PROXY_CONTAINER_NAME,
    PROXY_LISTEN_PORT,
    readOrCreateProxySecret,
} from "./TailscaleProxy.js";
import { TAILSCALE_CONTAINER_NAME } from "./TailscaleSidecar.js";

describe("buildCaddyfile", () => {
    it("listens on loopback only and injects the secret towards the webserver", () => {
        const text = buildCaddyfile("s3cret", 8080);
        assert.match(text, new RegExp(`^:${PROXY_LISTEN_PORT} \\{$`, "m"));
        assert.match(text, /^\tbind 127\.0\.0\.1$/m);
        assert.match(text, /reverse_proxy host\.docker\.internal:8080 \{/);
        assert.match(text, new RegExp(`header_up ${PROXY_SECRET_HEADER} "s3cret"`));
        assert.match(text, /admin off/);
        assert.match(text, /auto_https off/);
    });
});

describe("buildProxyRunArgs", () => {
    it("joins the sidecar's network namespace instead of familiar-net", () => {
        const args = buildProxyRunArgs({ caddyfilePath: "/d/Caddyfile", uid: 1000, gid: 1000 });
        assert.equal(args[args.indexOf("--name") + 1], PROXY_CONTAINER_NAME);
        assert.equal(args[args.indexOf("--network") + 1], `container:${TAILSCALE_CONTAINER_NAME}`);
        assert.ok(args.includes("1000:1000"));
        assert.ok(args.includes("/d/Caddyfile:/etc/caddy/Caddyfile:ro"));
        assert.ok(args.includes(CADDY_IMAGE));
        assert.doesNotMatch(args.join(" "), /-p |--publish|--add-host/);
    });
});

describe("readOrCreateProxySecret", () => {
    it("creates a long 0600 secret once and returns it again", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "familiar-tailscale-"));
        try {
            const first = readOrCreateProxySecret(dir);
            assert.ok(first.length >= 32);
            assert.equal(statSync(path.join(dir, "proxy-secret")).mode & 0o777, 0o600);
            assert.equal(readOrCreateProxySecret(dir), first);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
