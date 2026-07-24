#!/usr/bin/env node
// Thin launcher for the `familiar` command. The host CLI runs its citty
// entry point (an async main()) as a side effect of import, so importing
// its built entry is all that's needed. `@getfamiliar/host` resolves from
// this meta-package's dependencies; the bundled plugins ride along as the
// meta's CI-injected deps and are discovered at runtime by the host.
//
// `process.noDeprecation` is the runtime equivalent of node's
// `--no-deprecation` flag: it silences DeprecationWarnings from transitive
// dependencies we can't fix, which would otherwise print on every
// invocation. It must be set before host (and its deps) load — a static
// top-level `import` would be hoisted above this assignment, so the host is
// pulled in via a dynamic `import()` instead.
process.noDeprecation = true;
await import("@getfamiliar/host/build/index.js");
