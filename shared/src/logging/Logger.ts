import { createRequire } from "node:module";
import pino, {
    type DestinationStream,
    type LoggerOptions,
    multistream,
    type Logger as PinoLogger,
} from "pino";

/**
 * `require` shim for the ESM build. {@link prettyStdoutStream} pulls
 * in `pino-pretty` lazily at call time so consumers (notably the
 * container) that never use pretty output don't have to ship the dep,
 * and `pino-pretty` is published as CommonJS — both reasons make a
 * dynamic ESM `import()` overkill compared with `createRequire`.
 */
const require = createRequire(import.meta.url);

/**
 * Structured logger used by both host and container.
 *
 * Thin shape over `pino.Logger` so call sites only see the small surface
 * we actually use, and so the streams plumbing (multistream, levels) is
 * owned in one place. Always create child loggers via {@link Logger.child}
 * so per-component tags (`component`, `source`, …) accumulate.
 */
export interface Logger {
    debug(obj: object, msg?: string): void;
    debug(msg: string): void;
    info(obj: object, msg?: string): void;
    info(msg: string): void;
    warn(obj: object, msg?: string): void;
    warn(msg: string): void;
    error(obj: object, msg?: string): void;
    error(msg: string): void;
    /**
     * Return a child logger that always includes `bindings` on every
     * record. Children share the underlying streams and level.
     */
    child(bindings: Record<string, unknown>): Logger;
}

/** Levels exposed to call sites. `debug` is what `--verbose` enables. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One sink for the logger. Wraps a pino-compatible {@link DestinationStream}
 * so {@link createLogger} can compose multiple sinks via `pino.multistream`.
 */
export interface LogStream {
    readonly stream: DestinationStream;
}

/** Options accepted by {@link createLogger}. */
export interface CreateLoggerOptions {
    /** Top-level component tag stamped on every record. */
    readonly component: string;
    /** Minimum level emitted. */
    readonly level: LogLevel;
    /**
     * One or more sinks. Multiple streams use `pino.multistream`. A
     * single stream is wired directly. Levels on individual streams
     * default to the logger's level.
     */
    readonly streams: readonly LogStream[];
}

/**
 * Build a {@link Logger}. Call once per process (host: in `Start.ts`;
 * container: in `index.ts`); pass children into subsystems.
 *
 * @throws If `streams` is empty — there's no useful default sink.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
    if (options.streams.length === 0) {
        throw new Error("createLogger requires at least one stream");
    }
    const opts: LoggerOptions = {
        level: options.level,
        base: { component: options.component },
        timestamp: pino.stdTimeFunctions.isoTime,
    };
    // pino.multistream defaults each stream's accept level to `info`
    // regardless of the parent logger's level, so debug records would
    // be silently dropped at the stream gate. Tag every entry with the
    // configured level so all streams accept it.
    const pinoLogger: PinoLogger =
        options.streams.length === 1
            ? pino(opts, options.streams[0].stream)
            : pino(
                  opts,
                  multistream(
                      options.streams.map((s) => ({ stream: s.stream, level: options.level })),
                      { dedupe: false },
                  ),
              );
    return wrap(pinoLogger);
}

/**
 * Pretty-printed stdout for interactive use. Imports `pino-pretty`
 * lazily so the container image — which never wants pretty output —
 * doesn't have to ship the dep.
 *
 * @throws If `pino-pretty` isn't installed in the current package.
 */
export function prettyStdoutStream(): LogStream {
    // Required at call time so callers that don't use it don't pay
    // the resolution cost (and the container build doesn't break).
    const pretty = require("pino-pretty") as (opts: Record<string, unknown>) => DestinationStream;
    const stream = pretty({
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
        messageFormat: "[{component}{if source}/{source}{end}] {msg}",
        // Suppress the trailing structured payload on stdout. Most
        // call sites bake the data they want a human to see into
        // the message itself (`postgres ready on 127.0.0.1:5432`,
        // not `{host:..., port:...} postgres ready`); the rolling
        // file sink still gets full JSON for grep / jq, so nothing
        // is actually lost. See `commands/Start.ts` and friends for
        // the conversion pattern.
        hideObject: true,
    });
    return { stream };
}

/**
 * Raw JSON to stdout. Used by the container (the host parses each line
 * back) and by the host when stdout isn't a TTY.
 */
export function jsonStdoutStream(): LogStream {
    return { stream: process.stdout as unknown as DestinationStream };
}

/** Wrap a pino instance behind the {@link Logger} surface. */
function wrap(p: PinoLogger): Logger {
    return {
        debug: (a: object | string, b?: string) => emit(p, "debug", a, b),
        info: (a: object | string, b?: string) => emit(p, "info", a, b),
        warn: (a: object | string, b?: string) => emit(p, "warn", a, b),
        error: (a: object | string, b?: string) => emit(p, "error", a, b),
        child: (bindings) => wrap(p.child(bindings)),
    };
}

/** Forward to pino's overloaded level method preserving the (obj, msg) form. */
function emit(p: PinoLogger, level: LogLevel, a: object | string, b: string | undefined): void {
    if (typeof a === "string") {
        p[level](a);
        return;
    }
    if (b === undefined) {
        p[level](a);
        return;
    }
    p[level](a, b);
}
