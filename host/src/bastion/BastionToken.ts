import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ConfigService } from "@getfamiliar/shared";
import type { Bootstrap } from "../Bootstrap.js";

/** Config key for an operator-pinned bastion token. */
const CONFIG_KEY = "core.bastionToken";

/** Random bytes behind a generated token (256 bits). */
const GENERATED_TOKEN_BYTES = 32;

/**
 * Resolve the shared secret the bastion requires on every request:
 * `core.bastionToken` from `config.yml` when set, otherwise a fresh
 * random token for this daemon run.
 *
 * @param config The host config service.
 * @returns The token string.
 */
export function resolveBastionToken(config: ConfigService): string {
    const configured = config.getString(CONFIG_KEY, null);
    if (configured !== null && configured !== "") {
        return configured;
    }
    return randomBytes(GENERATED_TOKEN_BYTES).toString("base64url");
}

/**
 * Persist the token to `tmp/.bastion-token` (mode `0600`) so host-side
 * CLI commands can authenticate against the running daemon's bastion.
 *
 * @param boot Bootstrap providing the token file path.
 * @param token The token to write.
 */
export function writeBastionTokenFile(boot: Bootstrap, token: string): void {
    writeFileSync(boot.bastionTokenFile, token, { mode: 0o600 });
    // `mode` only applies when the file is created; tighten a leftover
    // file from an earlier run too.
    chmodSync(boot.bastionTokenFile, 0o600);
}

/**
 * Remove `tmp/.bastion-token` on daemon shutdown. A missing file is not
 * an error.
 *
 * @param boot Bootstrap providing the token file path.
 */
export function removeBastionTokenFile(boot: Bootstrap): void {
    rmSync(boot.bastionTokenFile, { force: true });
}

/**
 * Read the running daemon's bastion token from `tmp/.bastion-token`.
 *
 * @param boot Bootstrap providing the token file path.
 * @returns The token, or `null` when the file does not exist (daemon not running).
 */
export function readBastionTokenFile(boot: Bootstrap): string | null {
    if (!existsSync(boot.bastionTokenFile)) {
        return null;
    }
    return readFileSync(boot.bastionTokenFile, "utf-8").trim();
}
