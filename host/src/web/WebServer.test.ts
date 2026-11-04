import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MockLogger } from "@getfamiliar/shared/testing";
import { HostConfigService } from "../utils/ConfigService.js";
import { WebServer } from "./WebServer.js";

let scratch: string;
let servers: WebServer[];

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-webserver-"));
    servers = [];
});

afterEach(async () => {
    for (const server of servers) {
        await server.stop();
    }
    rmSync(scratch, { recursive: true, force: true });
});

/**
 * Build a WebServer over a real config file with the given `webserver` block.
 *
 * @param webserverYaml Indented body of the `webserver:` group, or "" for none.
 * @returns The server and the config file path.
 */
function build(webserverYaml: string): { server: WebServer; configFile: string } {
    const configFile = path.join(scratch, "config.yml");
    writeFileSync(configFile, configYaml(webserverYaml));
    const server = new WebServer({
        config: new HostConfigService(configFile),
        log: new MockLogger(),
    });
    servers.push(server);
    return { server, configFile };
}

/**
 * @param webserverYaml Indented body of the `webserver:` group, or "" for none.
 * @returns A config.yml text.
 */
function configYaml(webserverYaml: string): string {
    const group = webserverYaml === "" ? "" : `webserver:\n${webserverYaml}`;
    return `core:\n  postgresPassword: pw\n${group}`;
}

describe("WebServer", () => {
    it("does not listen when webserver.enabled is missing or false", async () => {
        const { server: missing } = build("");
        await missing.start();
        assert.equal(missing.listeningUrl, null);

        const { server: disabled } = build("  enabled: false\n  port: 0\n");
        await disabled.start();
        assert.equal(disabled.listeningUrl, null);
    });

    it("serves the hello-world page and 404s unknown routes", async () => {
        const { server } = build("  enabled: true\n  port: 0\n  host: 127.0.0.1\n");
        await server.start();
        const url = server.listeningUrl;
        assert.ok(url !== null);

        const res = await fetch(`${url}/`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/html/);
        assert.match(await res.text(), /<h1>Hello World<\/h1>/);

        const missing = await fetch(`${url}/nope`);
        assert.equal(missing.status, 404);
    });

    it("fails with a message naming the port when it is in use", async () => {
        const blocker: Server = createServer();
        await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
        const port = (blocker.address() as AddressInfo).port;
        try {
            const { server } = build(`  enabled: true\n  port: ${port}\n  host: 127.0.0.1\n`);
            await assert.rejects(server.start(), new RegExp(`127\\.0\\.0\\.1:${port}.*in use`));
            assert.equal(server.listeningUrl, null);
        } finally {
            await new Promise<void>((resolve) => blocker.close(() => resolve()));
        }
    });

    it("frees the port on stop and follows config on reload", async () => {
        const { server, configFile } = build("  enabled: true\n  port: 0\n  host: 127.0.0.1\n");
        await server.start();
        const firstUrl = server.listeningUrl;
        assert.ok(firstUrl !== null);

        await server.stop();
        assert.equal(server.listeningUrl, null);
        await assert.rejects(fetch(`${firstUrl}/`));

        const config = new HostConfigService(configFile);
        const reloadable = new WebServer({ config, log: new MockLogger() });
        servers.push(reloadable);
        await reloadable.start();
        assert.ok(reloadable.listeningUrl !== null);
        writeFileSync(configFile, configYaml("  enabled: false\n"));
        config.reload([]);
        await reloadable.reload();
        assert.equal(reloadable.listeningUrl, null);
    });
});
