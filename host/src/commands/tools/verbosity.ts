import type { Verbosity } from "./render.js";

/**
 * Derive the 0/1/2 verbosity level for `tools list` from the verbatim
 * argv. citty boolean flags don't count repeats — `-vv` parses to the
 * same `true` as `-v` — so the level is computed here by counting every
 * `v` across `-v`, `-vv`, stacked short clusters (`-vx`), and each
 * `--verbose`, capped at 2.
 *
 *   (none)            → 0   one-line, truncated descriptions
 *   -v / --verbose    → 1   full multiline descriptions
 *   -vv / -v -v       → 2   + argument / return schemas
 *
 * @param rawArgs The subcommand's verbatim argv (citty's `rawArgs`).
 * @returns The clamped verbosity level.
 */
export function verbosityFrom(rawArgs: readonly string[]): Verbosity {
    let count = 0;
    for (const arg of rawArgs) {
        if (arg === "--verbose") {
            count += 1;
            continue;
        }
        // A single-dash short cluster (`-v`, `-vv`, `-rv`) — count its
        // `v`s. Long options (`--x`) and positionals don't qualify.
        if (/^-[a-zA-Z]+$/.test(arg)) {
            for (const ch of arg.slice(1)) {
                if (ch === "v") {
                    count += 1;
                }
            }
        }
    }
    return count >= 2 ? 2 : count >= 1 ? 1 : 0;
}
