/**
 * Defaults of the core `webserver.*` config keys. Shared because both
 * the host's `WebServer` and plugins that front it (tailscale) must
 * resolve the same effective port and bind address.
 */

/** Port the webserver listens on when `webserver.port` is unset. */
export const DEFAULT_WEBSERVER_PORT = 8080;

/** Address the webserver binds on when `webserver.host` is unset. */
export const DEFAULT_WEBSERVER_HOST = "0.0.0.0";
