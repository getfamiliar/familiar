import { ReverseProxy } from "./ReverseProxy.js";

/**
 * Reverse-proxy entry point. Owns the singleton {@link ReverseProxy}, wires it
 * to env-supplied upstream credentials, and shuts down cleanly on
 * SIGTERM/SIGINT.
 *
 * Required env:
 *   - `UPSTREAM_BASE`     — e.g. `https://api.featherless.ai`
 *   - `UPSTREAM_API_KEY`  — the real API key (never reaches the agent)
 *
 * Optional env:
 *   - `LISTEN_PORT`       — defaults to 8788
 */
async function main(): Promise<void> {
    const upstreamBase = requireEnv("UPSTREAM_BASE");
    const upstreamApiKey = requireEnv("UPSTREAM_API_KEY");
    const listenPort = Number(process.env.LISTEN_PORT ?? "8788");
    if (!Number.isInteger(listenPort) || listenPort <= 0) {
        throw new Error(`LISTEN_PORT must be a positive integer, got ${process.env.LISTEN_PORT}`);
    }

    const proxy = new ReverseProxy({ listenPort, upstreamBase, upstreamApiKey });
    await proxy.start();

    const shutdown = async (signal: string) => {
        console.error(`Received ${signal}, draining…`);
        try {
            await proxy.stop();
        } finally {
            process.exit(0);
        }
    };
    process.on("SIGTERM", () => {
        void shutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
        void shutdown("SIGINT");
    });
}

/**
 * Read a required environment variable.
 *
 * @throws If the variable is unset or empty.
 */
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not set in the reverse-proxy container env.`);
    }
    return value;
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
