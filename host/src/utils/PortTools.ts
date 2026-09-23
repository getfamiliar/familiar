import { createServer } from "node:net";

/**
 * Probe whether a TCP port can be bound on the loopback interface.
 *
 * @param port - Port number to test.
 * @returns True if a server could bind and was released cleanly; false on EADDRINUSE.
 * @throws For any binding error other than `EADDRINUSE` (e.g. permission denied).
 */
function isLoopbackPortFree(port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                resolve(false);
                return;
            }
            reject(err);
        });
        server.listen(port, "127.0.0.1", () => {
            server.close(() => resolve(true));
        });
    });
}

/**
 * Find a free TCP port on `127.0.0.1`, starting at `preferred` and
 * incrementing on `EADDRINUSE`.
 *
 * Note: a port can be claimed between the time this function returns
 * and the time the caller binds it. Acceptable for local daemon
 * startup where the user can simply restart on a clash.
 *
 * @param preferred - First port to try.
 * @param attempts - Maximum number of consecutive ports to probe (default 100).
 * @returns The first free port number found.
 * @throws If no free port is found within `attempts` tries.
 */
export async function pickFreeLoopbackPort(preferred: number, attempts = 100): Promise<number> {
    for (let offset = 0; offset < attempts; offset += 1) {
        const candidate = preferred + offset;
        if (await isLoopbackPortFree(candidate)) {
            return candidate;
        }
    }
    throw new Error(
        `No free loopback port found in range ${preferred}..${preferred + attempts - 1}`,
    );
}
