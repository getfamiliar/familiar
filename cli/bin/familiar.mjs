#!/usr/bin/env node
// Thin launcher for the `familiar` command. The host CLI runs its citty
// entry point (an async main()) as a side effect of import, so importing
// its built entry is all that's needed. `@getfamiliar/host` resolves from
// this meta-package's dependencies; the bundled plugins ride along as the
// meta's CI-injected deps and are discovered at runtime by the host.
import "@getfamiliar/host/build/index.js";
