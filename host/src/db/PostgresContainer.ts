import { spawn } from "node:child_process";
import { SHARED_NETWORK_NAME } from "../proxy/AnthropicProxyManager";
import { pickFreeLoopbackPort } from "./freePort";

const CONTAINER_NAME = "ea-postgres";
const IMAGE_NAME = "postgres:16-alpine";
const INTERNAL_PORT = 5432;

/** Hardcoded dev credentials for the bus-state database. */
export const POSTGRES_USER = "ea";
export const POSTGRES_PASSWORD = "ea";
export const POSTGRES_DB = "ea";

/** Configuration for the postgres bus-state container. */
export interface PostgresContainerConfig {
    /** Absolute host path to the data directory; `postgres/` underneath is bind-mounted. */
    readonly dataPath: string;
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
 * Mounts `{dataPath}/postgres` → `/var/lib/postgresql/data` so cluster
 * state survives container restarts. Note that postgres in the image runs
 * as uid 70 (alpine), so files in `data/postgres/` will be owned by that
 * uid — `rm -rf` from the host needs `sudo`.
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

    /** Loopback host port the database is published on, once `start()` has run. */
    get publishedPort(): number {
        if (this.hostPort === undefined) {
            throw new Error("PostgresContainer is not running");
        }
        return this.hostPort;
    }

    /**
     * Start the container detached, picking a free loopback host port
     * starting at `preferredHostPort` (default 5432). Polls `pg_isready`
     * until postgres accepts connections, then returns the chosen port.
     *
     * Removes any previous `ea-postgres` container with the same name
     * first so this is safe to call after a crash.
     *
     * @returns The host port that postgres is reachable on (`127.0.0.1:<port>`).
     */
    async start(): Promise<number> {
        await this.dockerExec(["rm", "-f", CONTAINER_NAME], { allowFailure: true });

        const preferredPort = this.config.preferredHostPort ?? 5432;
        const hostPort = await pickFreeLoopbackPort(preferredPort);

        const dataDir = `${this.config.dataPath}/postgres`;

        await this.dockerExec([
            "run",
            "-d",
            "--name",
            CONTAINER_NAME,
            "--network",
            SHARED_NETWORK_NAME,
            "-p",
            `127.0.0.1:${hostPort}:${INTERNAL_PORT}`,
            "-e",
            `POSTGRES_USER=${POSTGRES_USER}`,
            "-e",
            `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
            "-e",
            `POSTGRES_DB=${POSTGRES_DB}`,
            "-v",
            `${dataDir}:/var/lib/postgresql/data`,
            IMAGE_NAME,
        ]);

        this.hostPort = hostPort;
        this.running = true;

        await this.waitForReady(this.config.readyTimeoutS ?? 30);
        return hostPort;
    }

    /** Stop and remove the postgres container. */
    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }

        try {
            await this.dockerExec(["stop", CONTAINER_NAME]);
        } catch {
            // already gone
        }
        try {
            await this.dockerExec(["rm", "-f", CONTAINER_NAME]);
        } catch {
            // already removed
        }

        this.running = false;
        this.hostPort = undefined;
    }

    /**
     * Poll `pg_isready` inside the container until it returns success
     * or the timeout elapses.
     *
     * @param timeoutS - Maximum seconds to wait.
     * @throws If postgres is not ready within the timeout.
     */
    private async waitForReady(timeoutS: number): Promise<void> {
        const deadline = Date.now() + timeoutS * 1000;
        while (Date.now() < deadline) {
            const { code } = await this.dockerCapture([
                "exec",
                CONTAINER_NAME,
                "pg_isready",
                "-U",
                POSTGRES_USER,
                "-d",
                POSTGRES_DB,
            ]);
            if (code === 0) {
                return;
            }
            await this.sleep(250);
        }
        throw new Error(`postgres not ready within ${timeoutS}s`);
    }

    /** Promise-based setTimeout. */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** Run a docker CLI command and discard output. */
    private dockerExec(
        args: readonly string[],
        options: { allowFailure?: boolean } = {},
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn("docker", [...args], { stdio: "ignore" });
            proc.on("close", (code) => {
                if (code === 0 || options.allowFailure) {
                    resolve();
                } else {
                    reject(new Error(`docker ${args.join(" ")} exited with code ${code}`));
                }
            });
            proc.on("error", reject);
        });
    }

    /**
     * Run a docker CLI command and capture its exit code (stdout discarded).
     * Never throws on non-zero exit; callers inspect `code`.
     */
    private dockerCapture(
        args: readonly string[],
    ): Promise<{ readonly code: number | null }> {
        return new Promise((resolve, reject) => {
            const proc = spawn("docker", [...args], { stdio: "ignore" });
            proc.on("close", (code) => {
                resolve({ code });
            });
            proc.on("error", reject);
        });
    }
}
