import { type Client, type Pool, type PoolConfig, default as pg } from "pg";

const { Pool: PgPool, Client: PgClient } = pg;

/**
 * Hardcoded user / database / network coordinates for the dev bus-state
 * DB. Both ends of the bus import these so they don't drift.
 *
 * - {@link POSTGRES_HOST} is both the docker container `--name` (used by
 *   `PostgresContainer` on the host) and the DNS name the agent
 *   container resolves over `ea-net`.
 * - {@link POSTGRES_PORT} is the in-container postgres port — the
 *   *internal* side of the host's loopback `-p` mapping, and the port
 *   the agent container connects to over `ea-net`.
 *
 * The password is *not* a constant — it lives in `.env`
 * (`POSTGRES_PASSWORD`) and is passed explicitly to
 * `PostgresConnection`.
 */
export const POSTGRES_HOST = "ea-postgres";
export const POSTGRES_PORT = 5432;
export const POSTGRES_USER = "ea";
export const POSTGRES_DB = "ea";

/** Connection coordinates for a postgres database. */
export interface PostgresConnectionConfig {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly database: string;
}

/** Callback fired when a NOTIFY arrives on a subscribed channel. */
export type NotificationHandler = (payload: string) => void;

/**
 * Wraps a postgres pool plus an optional dedicated `LISTEN` client.
 *
 * - `getPool()` lazily builds a normal connection pool for queries.
 * - `listen()`/`unlisten()` lazily open a single long-lived client
 *   dedicated to receiving asynchronous NOTIFYs. Multiple consumers can
 *   subscribe to the same channel; each registered handler is invoked
 *   for every notification on that channel.
 *
 * Domain classes (e.g. `EventBus`) take a `PostgresConnection` rather
 * than connection coordinates so they can share one pool / one listen
 * client across the process.
 */
export class PostgresConnection {
    private readonly poolConfig: PoolConfig;
    private pool: Pool | undefined;
    private listenClient: Client | undefined;
    private listenClientReady: Promise<Client> | undefined;
    private readonly handlersByChannel = new Map<string, Set<NotificationHandler>>();

    constructor(config: PostgresConnectionConfig) {
        this.poolConfig = {
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
        };
    }

    /** Lazily build (and reuse) the connection pool for normal queries. */
    getPool(): Pool {
        if (!this.pool) {
            this.pool = new PgPool(this.poolConfig);
        }
        return this.pool;
    }

    /**
     * Subscribe to a postgres NOTIFY channel. The dedicated LISTEN
     * connection is opened on first call. Multiple handlers per channel
     * are supported; the same handler can be registered only once.
     *
     * @param channel - SQL identifier for the channel. Must already be
     *   safe to interpolate (validated to avoid injection).
     * @param handler - Callback invoked with each notification's payload.
     */
    async listen(channel: string, handler: NotificationHandler): Promise<void> {
        validateChannelName(channel);
        const client = await this.ensureListenClient();

        let handlers = this.handlersByChannel.get(channel);
        const isFirstSubscriber = !handlers;
        if (!handlers) {
            handlers = new Set();
            this.handlersByChannel.set(channel, handlers);
        }
        handlers.add(handler);

        if (isFirstSubscriber) {
            await client.query(`LISTEN ${channel}`);
        }
    }

    /**
     * Remove a previously registered handler. Issues `UNLISTEN` once the
     * last handler for a channel is removed.
     */
    async unlisten(channel: string, handler: NotificationHandler): Promise<void> {
        validateChannelName(channel);
        const handlers = this.handlersByChannel.get(channel);
        if (!handlers) {
            return;
        }
        handlers.delete(handler);
        if (handlers.size === 0) {
            this.handlersByChannel.delete(channel);
            if (this.listenClient) {
                await this.listenClient.query(`UNLISTEN ${channel}`);
            }
        }
    }

    /** End the pool and the LISTEN client. Idempotent. */
    async close(): Promise<void> {
        this.handlersByChannel.clear();

        if (this.listenClient) {
            try {
                await this.listenClient.end();
            } catch {
                // best-effort
            }
            this.listenClient = undefined;
            this.listenClientReady = undefined;
        }

        if (this.pool) {
            await this.pool.end();
            this.pool = undefined;
        }
    }

    /**
     * Ensure the dedicated LISTEN client is connected and dispatch
     * notifications to all registered handlers for the channel.
     */
    private async ensureListenClient(): Promise<Client> {
        if (!this.listenClientReady) {
            this.listenClientReady = (async () => {
                const client = new PgClient(this.poolConfig);
                await client.connect();
                client.on("notification", (msg) => {
                    if (!msg.channel) {
                        return;
                    }
                    const handlers = this.handlersByChannel.get(msg.channel);
                    if (!handlers) {
                        return;
                    }
                    for (const handler of handlers) {
                        try {
                            handler(msg.payload ?? "");
                        } catch (err) {
                            console.error(
                                `PostgresConnection notification handler error: ${err instanceof Error ? err.message : String(err)}`,
                            );
                        }
                    }
                });
                client.on("error", (err) => {
                    console.error(`PostgresConnection listen client error: ${err.message}`);
                });
                this.listenClient = client;
                return client;
            })();
        }
        return this.listenClientReady;
    }
}

const CHANNEL_NAME_RE = /^[a-z_][a-z0-9_]*$/i;

/**
 * Reject channel names that aren't safe to interpolate into a `LISTEN`
 * statement. Postgres identifiers can be quoted, but for simplicity we
 * restrict to plain `[a-z_][a-z0-9_]*`.
 */
function validateChannelName(channel: string): void {
    if (!CHANNEL_NAME_RE.test(channel)) {
        throw new Error(`Invalid channel name: ${channel}`);
    }
}
