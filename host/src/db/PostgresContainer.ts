import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
    POSTGRES_DB,
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_USER,
    PostgresConnection,
} from "effective-assistant-shared";
import {
    dockerCapture,
    dockerExec,
    removeContainer,
    SHARED_NETWORK_NAME,
    stopContainer,
} from "../DockerTools";
import { pickFreeLoopbackPort } from "./PortTools";

const IMAGE_NAME = "postgres:16-alpine";

/** Configuration for the postgres bus-state container. */
export interface PostgresContainerConfig {
    /** Absolute host path to the data directory; `postgres/` underneath is bind-mounted. */
    readonly dataPath: string;
    /** Path to the file where the chosen loopback port is persisted. */
    readonly portFilePath: string;
    /** Postgres password (`POSTGRES_PASSWORD` env on the container). */
    readonly password: string;
    /** Preferred host port to publish on 127.0.0.1; falls back if taken. */
    readonly preferredHostPort?: number;
    /** Max seconds to wait for `pg_isready` after start (default 30). */
    readonly readyTimeoutS?: number;
}

/**
 * Manages the singleton postgres container (`ea-postgres`).
 *
 * Joins `ea-net` so the agent container can reach it as `ea-postgres:5432`.
 * Publishes the postgres TCP port on `127.0.0.1:<host-port>:5432` so host
 * code (and `psql` from a host shell) can connect, but nothing on the LAN.
 *
 * Owns the port file at `portFilePath`: writes it on `start()`, removes it
 * on `stop()`, and exposes `getPort()` / `getConnection()` so out-of-process
 * callers (CLIs etc.) can construct an instance without `start()` and use
 * it purely as a config provider for the running container.
 *
 * Mounts `{dataPath}/postgres` → `/var/lib/postgresql/data`. Postgres in
 * the alpine image runs as uid 70, so files in `data/postgres/` will be
 * owned by that uid — `rm -rf` from the host needs `sudo`.
 */
export class PostgresContainer {
    private readonly config: PostgresContainerConfig;
    private hostPort: number | undefined;
    private running = false;

    constructor(config: PostgresContainerConfig) {
        this.config = config;
    }

    /** True if `start()` has succeeded and `stop()` has not yet been called. */
    get isRunning(): boolean {
        return this.running;
    }

    /**
     * Loopback host port the database is published on. Returns the
     * port chosen by this instance's `start()` if it ran, otherwise
     * reads the persisted port file (so out-of-process callers can
     * discover the port without owning the lifecycle).
     *
     * @throws If neither this instance has started nor the port file exists.
     */
    getPort(): number {
        if (this.hostPort !== undefined) {
            return this.hostPort;
        }
        let raw: string;
        try {
            raw = readFileSync(this.config.portFilePath, "utf-8");
        } catch {
            throw new Error(`Cannot read ${this.config.portFilePath} — is the daemon running?`);
        }
        const port = Number.parseInt(raw.trim(), 10);
        if (!Number.isFinite(port) || port <= 0) {
            throw new Error(`Invalid port in ${this.config.portFilePath}: ${raw}`);
        }
        return port;
    }

    /**
     * Build a {@link PostgresConnection} pointed at this container over
     * loopback. Caller is responsible for closing it.
     */
    getConnection(): PostgresConnection {
        return new PostgresConnection({
            host: "127.0.0.1",
            port: this.getPort(),
            user: POSTGRES_USER,
            password: this.config.password,
            database: POSTGRES_DB,
        });
    }

    /**
     * Start the container detached, picking a free loopback host port
     * starting at `preferredHostPort` (default 5432). Polls `pg_isready`
     * until postgres accepts connections, then writes the chosen port to
     * `portFilePath` and returns it.
     *
     * Removes any previous `ea-postgres` container with the same name
     * first so this is safe to call after a crash.
     *
     * @returns The host port that postgres is reachable on (`127.0.0.1:<port>`).
     */
    async start(): Promise<number> {
        await removeContainer(POSTGRES_HOST);

        const dataDir = `${this.config.dataPath}/postgres`;
        mkdirSync(dataDir, { recursive: true });

        const preferredPort = this.config.preferredHostPort ?? 5432;
        const hostPort = await pickFreeLoopbackPort(preferredPort);

        await dockerExec([
            "run",
            "-d",
            "--name",
            POSTGRES_HOST,
            "--network",
            SHARED_NETWORK_NAME,
            "-p",
            `127.0.0.1:${hostPort}:${POSTGRES_PORT}`,
            "-e",
            `POSTGRES_USER=${POSTGRES_USER}`,
            "-e",
            `POSTGRES_PASSWORD=${this.config.password}`,
            "-e",
            `POSTGRES_DB=${POSTGRES_DB}`,
            "-v",
            `${dataDir}:/var/lib/postgresql/data`,
            IMAGE_NAME,
        ]);

        this.hostPort = hostPort;
        this.running = true;

        await this.waitForReady(this.config.readyTimeoutS ?? 30);

        writeFileSync(this.config.portFilePath, `${hostPort}\n`, "utf-8");

        return hostPort;
    }

    /** Stop and remove the postgres container; remove the port file. */
    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }

        await stopContainer(POSTGRES_HOST);
        await removeContainer(POSTGRES_HOST);

        try {
            unlinkSync(this.config.portFilePath);
        } catch {
            // already gone
        }

        this.running = false;
        this.hostPort = undefined;
    }

    /**
     * Poll `pg_isready` inside the container until it returns success
     * or the timeout elapses.
     *
     * @throws If postgres is not ready within the timeout.
     */
    private async waitForReady(timeoutS: number): Promise<void> {
        const deadline = Date.now() + timeoutS * 1000;
        while (Date.now() < deadline) {
            const { code } = await dockerCapture([
                "exec",
                POSTGRES_HOST,
                "pg_isready",
                "-U",
                POSTGRES_USER,
                "-d",
                POSTGRES_DB,
            ]);
            if (code === 0) {
                return;
            }
            await sleep(250);
        }
        throw new Error(`postgres not ready within ${timeoutS}s`);
    }
}

/** Promise-based setTimeout. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
