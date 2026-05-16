import type { MailProvider } from "./MailProvider.js";
import { O365Provider } from "./o365/O365Provider.js";

/**
 * Singleton provider instance — exported separately so the plugin's
 * `tools` hook can hand the same instance to `buildMailTools` that
 * the poll loop drives. Node's module cache makes both reads return
 * the same object.
 */
export const o365Provider: O365Provider = new O365Provider();

/**
 * Static list of mail-provider implementations. To add a new
 * provider, drop an implementation under `src/providers/<id>/` and
 * append it here. The orchestration core
 * ({@link import("../MailDaemon.js")}) discovers which providers are
 * usable at runtime by asking each to {@link MailProvider.prepare}.
 */
export const providers: readonly MailProvider[] = [o365Provider];
