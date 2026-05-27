/**
 * The root-anchored `*`-glob matcher now lives in `@getfamiliar/shared`
 * so the container fs tools (`core.writablePaths` allowlist), the
 * handler-resolution guards, and this plugin all share one grammar.
 * Re-exported here so existing in-plugin imports keep their local path.
 */
export { matchesAnyGlob, matchesGlob } from "@getfamiliar/shared";
