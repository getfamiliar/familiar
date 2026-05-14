import type { MailProvider } from "./MailProvider.js";
import { O365Provider } from "./o365/O365Provider.js";

/**
 * Static list of mail-provider implementations. To add a new
 * provider, drop an implementation under `src/providers/<id>/` and
 * append it here. The orchestration core
 * ({@link import("../MailDaemon.js")}) discovers which providers are
 * usable at runtime by matching each provider's `packageName`
 * against the installed MCPs in `mcp.yml`.
 */
export const providers: readonly MailProvider[] = [new O365Provider()];
