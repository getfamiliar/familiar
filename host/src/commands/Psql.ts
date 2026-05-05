import { spawnSync } from "node:child_process";
import { defineCommand } from "citty";
import { POSTGRES_DB, POSTGRES_HOST, POSTGRES_USER } from "effective-assistant-shared";

/**
 * `ea psql` — drop into an interactive `psql` shell inside the
 * `ea-postgres` container. Avoids needing a `psql` client on the host
 * and removes the need to look up the loopback port in
 * `data/.postgres-port`. Stdio is inherited so the shell behaves like
 * a normal terminal session; the host CLI exits with whatever `psql`
 * exits with.
 *
 * Assumes the daemon is already running (i.e. `ea-postgres` exists).
 * If it isn't, `docker exec` reports a clear "no such container" error
 * directly to the user — no point shadowing that with a custom check.
 */
export const psqlCommand = defineCommand({
    meta: {
        name: "psql",
        description: "Open an interactive psql shell inside the ea-postgres container.",
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
