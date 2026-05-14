import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger, McpInfo } from "effective-assistant-shared";
import type { McpEntry } from "./McpEntry.js";
import type { McpRegistry } from "./McpRegistry.js";

/** Constructor dependencies for {@link PluginMcpService}. */
export interface PluginMcpServiceDeps {
    /** Shared, already-parsed MCP registry. */
    readonly registry: McpRegistry;
    /**
     * Host-side base URL of the bastion (the loopback variant, e.g.
     * `http://127.0.0.1:8788`). Used to dial `/mcp/<key>/`. Plugins
     * dial through the same handlers the agent container uses, just
     * via the loopback DNS instead of `host.docker.internal`.
     */
    readonly bastionBaseUrl: string;
    /** Logger used for connect / close lifecycle lines. */
    readonly log: Logger;
}

/**
 * Singleton host-side MCP client pool plugins reach through
 * `ctx.mcp`. One {@link Client} per `mcp.yml` key, instantiated
 * lazily on the first method invocation and reused thereafter.
 *
 * `getByKey` / `getByPackage` return synchronously — a `Proxy<Client>`
 * that defers connect to the first method call. This keeps the
 * `HostContext` shape ergonomic (no `await ctx.mcp.getByKey(...)`)
 * while avoiding cold-spawning every declared MCP at daemon boot
 * just because plugins might want one.
 *
 * Lifecycle: connections persist for the life of the host process.
 * {@link close} tears them all down (called from
 * `PluginHost.close()` on graceful shutdown).
 */
export class PluginMcpService {
    private readonly registry: McpRegistry;
    private readonly log: Logger;
    private bastionBaseUrl: string;
    private readonly clients = new Map<string, Promise<Client>>();

    constructor(deps: PluginMcpServiceDeps) {
        this.registry = deps.registry;
        this.log = deps.log;
        this.bastionBaseUrl = deps.bastionBaseUrl;
    }

    /**
     * Replace the bastion base URL. Has no effect on already-cached
     * connections (none are open until first call); the next
     * `connect` uses the new URL. Daemon mode calls this once the
     * bastion's actual listen port is known.
     */
    setBastionBaseUrl(url: string): void {
        this.bastionBaseUrl = url;
    }

    /** Metadata view of every declared MCP. Opens no connections. */
    getList(): readonly McpInfo[] {
        return this.registry.list().map((entry) => this.registry.info(entry));
    }

    /**
     * Return a `Client` for the entry with this `mcp.yml` key. Throws
     * when the key is unknown. The returned object is a `Proxy` that
     * connects on the first method call and forwards subsequent
     * calls to the underlying cached client.
     */
    getByKey(key: string): Client {
        const entry = this.registry.get(key);
        if (entry === undefined) {
            throw new Error(`ctx.mcp.getByKey: unknown MCP key "${key}"`);
        }
        return this.proxy(entry);
    }

    /**
     * Return a `Client` for the entry whose combined package field
     * exactly matches `pkg`, narrowed first by `source` if given.
     * Throws when zero or multiple entries match — callers must be
     * unambiguous.
     */
    getByPackage(pkg: string, source?: string): Client {
        const matches = this.registry.findByPackage(pkg, source);
        if (matches.length === 0) {
            const where = source ? ` (source "${source}")` : "";
            throw new Error(`ctx.mcp.getByPackage: no MCP matches package "${pkg}"${where}`);
        }
        if (matches.length > 1) {
            const keys = matches.map((m) => m.id).join(", ");
            const where = source ? ` (source "${source}")` : "";
            throw new Error(
                `ctx.mcp.getByPackage: package "${pkg}"${where} is ambiguous — matches: ${keys}`,
            );
        }
        return this.proxy(matches[0]);
    }

    /**
     * Close every cached client in parallel. Per-client errors are
     * logged and swallowed so one stuck close doesn't block the
     * rest. Safe to call multiple times.
     */
    async close(): Promise<void> {
        const pending = [...this.clients.values()];
        this.clients.clear();
        await Promise.allSettled(
            pending.map(async (clientPromise) => {
                try {
                    const client = await clientPromise;
                    await client.close();
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.log.error(`plugin-mcp close error: ${message}`);
                }
            }),
        );
    }

    /**
     * Open (or return the cached) connect promise for one MCP key.
     * Multiple concurrent first-callers share the same promise so
     * one connect roundtrip suffices.
     */
    private connect(key: string): Promise<Client> {
        const existing = this.clients.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const promise = this.openClient(key);
        this.clients.set(key, promise);
        // Don't poison the cache on first-attempt failure — let a
        // future `callTool` retry. If the failure was permanent (bad
        // mcp.yml entry, bastion down), the next call surfaces the
        // same error anyway.
        promise.catch(() => {
            if (this.clients.get(key) === promise) {
                this.clients.delete(key);
            }
        });
        return promise;
    }

    /** Construct an MCP SDK client and connect it to the bastion. */
    private async openClient(key: string): Promise<Client> {
        const url = new URL(`${this.bastionBaseUrl.replace(/\/$/, "")}/mcp/${key}/`);
        const client = new Client(
            { name: "effective-assistant-host", version: "0.1.0" },
            { capabilities: {} },
        );
        await client.connect(new StreamableHTTPClientTransport(url));
        return client;
    }

    /**
     * Build a `Proxy<Client>` whose member access returns a wrapper
     * that first awaits the (cached) connect, then delegates to the
     * real client's method. Non-function members fall back to the
     * underlying value once the connection has resolved.
     */
    private proxy(entry: McpEntry): Client {
        const key = entry.id;
        return new Proxy({} as Client, {
            get: (_target, prop) => {
                if (prop === "then") {
                    // Avoid being mistaken for a thenable when a
                    // caller accidentally `await`s the proxy itself.
                    return undefined;
                }
                return (...args: unknown[]) => {
                    return this.connect(key).then((client) => {
                        const member = Reflect.get(client, prop, client);
                        if (typeof member !== "function") {
                            return member;
                        }
                        return (member as (...a: unknown[]) => unknown).apply(client, args);
                    });
                };
            },
        });
    }
}
