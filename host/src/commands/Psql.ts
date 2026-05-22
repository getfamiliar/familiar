import { spawnSync } from "node:child_process";
import { POSTGRES_DB, POSTGRES_HOST, POSTGRES_USER } from "@getfamiliar/shared";
import { defineCommand } from "citty";

/**
 * `cli.sh psql` — drop into an interactive `psql` shell inside the
 * `familiar-postgres` container. Avoids needing a `psql` client on the host
 * and removes the need to look up the loopback port in
 * `tmp/.postgres-port`. Stdio is inherited so the shell behaves like
 * a normal terminal session; the host CLI exits with whatever `psql`
 * exits with.
 *
 * Assumes the daemon is already running (i.e. `familiar-postgres` exists).
 * If it isn't, `docker exec` reports a clear "no such container" error
 * directly to the user — no point shadowing that with a custom check.
 */
export const psqlCommand = defineCommand({
    meta: {
        name: "psql",
        description: "Open an interactive psql shell inside the familiar-postgres container.",
    },
    run() {
        const result = spawnSync(
            "docker",
            ["exec", "-it", POSTGRES_HOST, "psql", "-U", POSTGRES_USER, "-d", POSTGRES_DB],
            { stdio: "inherit" },
        );
        if (result.error) {
            process.stderr.write(`failed to launch docker: ${result.error.message}\n`);
            process.exit(1);
        }
        process.exit(result.status ?? 1);
    },
});
