/**
 * Microsoft Entra ID (formerly Azure AD) app registration used for
 * device-code login against Microsoft Graph. The plugin ships with a
 * hard-coded **multi-tenant Public Client** app the project owns;
 * users with tighter compliance needs can override `clientId` /
 * `tenantId` via `ms365.clientId` / `ms365.tenantId` in `config.yml`.
 *
 * The owner of a multi-tenant Public Client app cannot read tenant
 * data — tokens are minted against the user's home tenant and stay on
 * the device. See the plugin README for the security argument and the
 * step-by-step own-app registration guide.
 */
export interface AppRegistration {
    /** Entra ID application (client) id, a GUID. */
    readonly clientId: string;
    /**
     * Tenant slug for the OAuth authority URL. `"common"` works for
     * multi-tenant apps and accepts any work-or-school account; an own
     * single-tenant registration uses the tenant GUID instead.
     */
    readonly tenantId: string;
}

/**
 * The plugin's default app registration. **Placeholder GUID** — must
 * be replaced with the real registered app's client id before this
 * plugin ships. The tenant stays `"common"` so any work-or-school
 * account can sign in.
 *
 * Per the project's "hardcode proxy-placeholder API keys" memory rule,
 * non-secret identifiers like a multi-tenant client id belong in
 * source. Users who don't want to trust the project-owned app override
 * both fields via `config.yml`.
 */
export const DEFAULT_APP: AppRegistration = {
    clientId: "5e8776a5-df18-437e-9056-d714a7aa1210",
    tenantId: "common",
};

/**
 * Microsoft Graph permission scopes the plugin requests on every
 * sign-in. Mirrors the consent surface configured on the bundled
 * multi-tenant app — see the "App scopes" table in the plugin README
 * for what each one is used for. `offline_access` is what mints the
 * refresh token msal-node caches; without it every silent-acquire
 * eventually fails.
 *
 * Scope set covers mail (own + shared) today. Calendar scopes will be
 * appended here so a single login covers both features once calendar
 * lands. `MailboxSettings.ReadWrite` is included now for a future
 * out-of-office automation that needs read+write on mailbox settings.
 */
export const GRAPH_SCOPES: readonly string[] = [
    "email",
    "Mail.Read",
    "Mail.Read.Shared",
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    "MailboxFolder.Read",
    "MailboxSettings.ReadWrite",
    "offline_access",
    "User.Read",
];

/**
 * Build the OAuth authority URL the msal-node `PublicClientApplication`
 * authenticates against. Always `https://login.microsoftonline.com/<tenant>`.
 */
export function authorityUrl(tenantId: string): string {
    return `https://login.microsoftonline.com/${tenantId}`;
}
