import { createHash, randomBytes } from "node:crypto";
import { collectCookies, type TlsResponse, tlsRequest } from "./TlsHttp.js";
import type { TeslaTokens } from "./TokenStore.js";

/** Tesla's SSO host. Every call in this module targets it. */
const AUTH_BASE = "https://auth.tesla.com";
/**
 * The Tesla mobile app's public OAuth client id. The old second-stage
 * exchange against `81527cff…` is gone — the SSO access token minted
 * for this client is used directly as the Owner API bearer.
 */
const CLIENT_ID = "ownerapi";
/**
 * The **only** redirect URI currently registered for `ownerapi`.
 *
 * Every older guide (timdorr's included) uses
 * `https://auth.tesla.com/void/callback`, which Tesla retired: that
 * value now fails the whole flow up front with *"The 'redirect_uri'
 * supplied is not registered for this 'client_id'."* — before the
 * login form is even rendered.
 *
 * It is a custom scheme, so nothing serves it and no browser can
 * follow it. That is fine for the scripted path, which reads the code
 * out of the 302's `Location` header without following it. For the
 * browser fallback it means the user reads the URL out of devtools
 * rather than out of the address bar; see the login command.
 */
const REDIRECT_URI = "tesla://auth/callback";
const SCOPE = "openid email offline_access";

/**
 * Deliberately *not* browser-like. Tesla's WAF profiles the SSO host
 * and a spoofed browser UA makes a scripted login more likely to be
 * challenged, not less.
 */
const AUTH_USER_AGENT = "familiar-tesla-plugin";

/** A PKCE verifier / challenge pair, valid for one login attempt. */
export interface PkcePair {
    readonly verifier: string;
    readonly challenge: string;
}

/**
 * Thrown when Tesla's WAF refuses the scripted credential post
 * (captcha challenge, 403, or any unexpected non-302 HTML). The CLI
 * catches this and offers the browser fallback instead of failing the
 * command.
 */
export class LoginBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LoginBlockedError";
    }
}

/** Outcome of posting the e-mail / password form. */
export type CredentialResult =
    | { readonly kind: "code"; readonly code: string }
    | { readonly kind: "mfa"; readonly csrf: string | null };

/**
 * Opaque handle for one in-flight login: the PKCE pair, the hidden
 * form fields scraped from the authorize page, and the session cookie.
 * Created by {@link beginLogin} and threaded through the remaining
 * steps.
 */
export interface LoginSession {
    readonly pkce: PkcePair;
    readonly authorizeUrl: string;
    readonly hiddenFields: Readonly<Record<string, string>>;
    readonly cookie: string;
    readonly state: string;
}

/**
 * Generate a PKCE verifier (86 alphanumeric characters, as Tesla's app
 * does) and its S256 challenge.
 *
 * @returns The verifier / challenge pair.
 */
export function createPkcePair(): PkcePair {
    const verifier = randomBytes(64).toString("base64url").slice(0, 86);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

/**
 * Extract every `<input type="hidden">` name/value pair from an SSO
 * HTML page. Attribute order varies between Tesla's page revisions, so
 * each tag is matched first and its attributes parsed individually
 * rather than assuming a fixed layout.
 *
 * @param html The authorize page's HTML.
 * @returns Map of hidden field name to value (HTML entities decoded).
 */
export function parseHiddenInputs(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
        if (!/type\s*=\s*["']hidden["']/i.test(tag)) {
            continue;
        }
        const name = tag.match(/\bname\s*=\s*["']([^"']*)["']/i)?.[1];
        if (name === undefined || name.length === 0) {
            continue;
        }
        out[name] = decodeEntities(tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1] ?? "");
    }
    return out;
}

/**
 * Whether an SSO response is the multi-factor prompt rather than a
 * completed login. Tesla signals it by re-rendering the form with a
 * `passcode` field instead of issuing the 302.
 *
 * @param html The HTML body returned by the credential post.
 * @returns True when a passcode is being asked for.
 */
export function hasPasscodeField(html: string): boolean {
    return /name\s*=\s*["']passcode["']/i.test(html);
}

/**
 * Pull the authorization code out of a callback URL. Used for both the
 * scripted path (the `Location` header of the 302) and the browser
 * fallback (the address bar the user pastes back).
 *
 * @param callbackUrl Absolute `tesla://auth/callback?...` URL.
 * @returns The `code` query parameter.
 * @throws When the string is not a URL or carries no `code`.
 */
export function extractCode(callbackUrl: string): string {
    let parsed: URL;
    try {
        parsed = new URL(callbackUrl.trim());
    } catch {
        throw new Error(`not a URL: ${callbackUrl.trim().slice(0, 120)}`);
    }
    const code = parsed.searchParams.get("code");
    if (code === null || code.length === 0) {
        throw new Error("the pasted URL carries no `code` parameter — did the login complete?");
    }
    return code;
}

/**
 * Build the URL that starts a login, together with the PKCE pair the
 * eventual code must be redeemed with.
 *
 * Used twice: by {@link beginLogin} for the scripted path, and by the
 * CLI's browser fallback, which hands this URL to the user and asks
 * for the callback URL they land on. Separating it out means the
 * fallback still works when the scripted path cannot even fetch the
 * authorize page.
 *
 * @param email Account e-mail, sent as `login_hint`.
 * @returns The authorize URL, its PKCE pair, and the CSRF `state`.
 */
export function buildBrowserLogin(email: string): {
    authorizeUrl: string;
    pkce: PkcePair;
    state: string;
} {
    const pkce = createPkcePair();
    const state = randomBytes(16).toString("base64url");
    const url = new URL("/oauth2/v3/authorize", AUTH_BASE);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("state", state);
    url.searchParams.set("login_hint", email);
    return { authorizeUrl: url.toString(), pkce, state };
}

/**
 * Step 1: fetch the authorize page, scrape its hidden form fields and
 * keep the session cookie. The returned {@link LoginSession} is what
 * every subsequent step needs.
 *
 * @param email Account e-mail, sent as `login_hint` so Tesla pre-fills the form.
 * @returns The in-flight login session.
 * @throws When the authorize page cannot be fetched or carries no `transaction_id`.
 */
export async function beginLogin(email: string): Promise<LoginSession> {
    const { authorizeUrl, pkce, state } = buildBrowserLogin(email);

    const response = await tlsRequest({
        method: "GET",
        url: authorizeUrl,
        headers: { "User-Agent": AUTH_USER_AGENT, Accept: "text/html" },
    });
    if (response.status !== 200) {
        throw new LoginBlockedError(
            `the Tesla SSO authorize page answered with HTTP ${response.status}` +
                describePageError(response.body),
        );
    }
    const hiddenFields = parseHiddenInputs(response.body);
    if (hiddenFields.transaction_id === undefined) {
        throw new LoginBlockedError(
            "the Tesla SSO authorize page carried no login form" + describePageError(response.body),
        );
    }
    return {
        pkce,
        authorizeUrl,
        hiddenFields,
        cookie: collectCookies(response),
        state,
    };
}

/**
 * Step 2: post e-mail and password to the authorize endpoint.
 *
 * A successful login answers **302** and carries the authorization
 * code in `Location`; the redirect is deliberately not followed. A
 * re-rendered form containing a `passcode` field means the account has
 * multi-factor enabled and {@link verifyMfa} is next.
 *
 * @param session The session from {@link beginLogin}.
 * @param email Account e-mail.
 * @param password Account password. Never persisted.
 * @returns Either the authorization code or a request for the MFA code.
 * @throws {LoginBlockedError} When Tesla's WAF challenged or rejected the post.
 */
export async function submitCredentials(
    session: LoginSession,
    email: string,
    password: string,
): Promise<CredentialResult> {
    const form = new URLSearchParams(session.hiddenFields);
    form.set("identity", email);
    form.set("credential", password);

    const response = await tlsRequest({
        method: "POST",
        url: session.authorizeUrl,
        headers: {
            "User-Agent": AUTH_USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "text/html",
            ...cookieHeaderOf(session),
        },
        body: form.toString(),
    });

    if (response.status === 302 || response.status === 303) {
        return { kind: "code", code: extractCode(locationOf(response)) };
    }
    if (response.status === 200 && hasPasscodeField(response.body)) {
        return { kind: "mfa", csrf: parseHiddenInputs(response.body)._csrf ?? null };
    }
    throw new LoginBlockedError(describeBlock(response));
}

/**
 * Step 3: satisfy the multi-factor challenge and collect the
 * authorization code.
 *
 * Runs three requests: list the account's factors, verify the passcode
 * against the first one, then re-post the authorize form carrying only
 * the transaction id — which now answers with the 302 that step 2
 * would have produced for a non-MFA account.
 *
 * @param session The session from {@link beginLogin}.
 * @param csrf The CSRF token from the MFA page; distinct from the one in
 *   {@link LoginSession.hiddenFields}. Omitted when the page carried none.
 * @param passcode The six-digit authenticator code. Never persisted.
 * @returns The authorization code.
 * @throws When no factor is enrolled, the passcode is rejected, or the
 *   final authorize post does not redirect.
 */
export async function verifyMfa(
    session: LoginSession,
    csrf: string | null,
    passcode: string,
): Promise<string> {
    const transactionId = session.hiddenFields.transaction_id ?? "";
    const cookieHeader = cookieHeaderOf(session);

    const factorsUrl = new URL("/oauth2/v3/authorize/mfa/factors", AUTH_BASE);
    factorsUrl.searchParams.set("transaction_id", transactionId);
    const factorsResponse = await tlsRequest({
        method: "GET",
        url: factorsUrl.toString(),
        headers: { "User-Agent": AUTH_USER_AGENT, Accept: "application/json", ...cookieHeader },
    });
    const factorId = firstFactorId(factorsResponse.body);
    if (factorId === null) {
        throw new Error(
            "Tesla asked for a multi-factor code but reported no enrolled factor " +
                `(HTTP ${factorsResponse.status})`,
        );
    }

    const verifyResponse = await tlsRequest({
        method: "POST",
        url: `${AUTH_BASE}/oauth2/v3/authorize/mfa/verify`,
        headers: {
            "User-Agent": AUTH_USER_AGENT,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...cookieHeader,
        },
        body: JSON.stringify({
            transaction_id: transactionId,
            factor_id: factorId,
            passcode,
            ...(csrf === null ? {} : { _csrf: csrf }),
        }),
    });
    if (!isMfaApproved(verifyResponse.body)) {
        throw new Error("Tesla rejected the multi-factor code");
    }

    const finalResponse = await tlsRequest({
        method: "POST",
        url: session.authorizeUrl,
        headers: {
            "User-Agent": AUTH_USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "text/html",
            ...cookieHeader,
        },
        body: new URLSearchParams({ transaction_id: transactionId }).toString(),
    });
    if (finalResponse.status !== 302 && finalResponse.status !== 303) {
        throw new LoginBlockedError(describeBlock(finalResponse));
    }
    return extractCode(locationOf(finalResponse));
}

/**
 * Final step of a login: trade the authorization code for a token pair.
 *
 * @param code Authorization code from either the scripted or the browser path.
 * @param verifier The PKCE verifier the code was requested with.
 * @param email Account e-mail, stored alongside the tokens for display.
 * @returns The token set ready to persist.
 * @throws When Tesla refuses the exchange.
 */
export async function exchangeCode(
    code: string,
    verifier: string,
    email: string,
): Promise<TeslaTokens> {
    const response = await tlsRequest({
        method: "POST",
        url: `${AUTH_BASE}/oauth2/v3/token`,
        headers: {
            "User-Agent": AUTH_USER_AGENT,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
        }),
    });
    return toTokens(response, email, "code exchange");
}

/**
 * Mint a fresh access token from a stored refresh token.
 *
 * @param refreshToken The stored refresh token.
 * @param email Account e-mail, carried through to the new token set.
 * @returns The refreshed token set.
 * @throws When the refresh token is dead or Tesla refuses the refresh.
 */
export async function refreshTokens(refreshToken: string, email: string): Promise<TeslaTokens> {
    const response = await tlsRequest({
        method: "POST",
        url: `${AUTH_BASE}/oauth2/v3/token`,
        headers: {
            "User-Agent": AUTH_USER_AGENT,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: refreshToken,
            scope: SCOPE,
        }),
    });
    const tokens = toTokens(response, email, "token refresh");
    // Tesla does not always rotate the refresh token; keep the old one
    // when the response omits it, or the next refresh has nothing to
    // present.
    return tokens.refreshToken.length > 0 ? tokens : { ...tokens, refreshToken };
}

/**
 * Build the `Cookie` header for a follow-up SSO request, or nothing
 * when the authorize page set no cookie.
 *
 * @param session The in-flight login session.
 * @returns A spreadable header fragment.
 */
function cookieHeaderOf(session: LoginSession): Record<string, string> {
    return session.cookie.length > 0 ? { Cookie: session.cookie } : {};
}

/**
 * Parse a `/oauth2/v3/token` response into a {@link TeslaTokens}.
 *
 * @param response The raw SSO response.
 * @param email Account e-mail to embed.
 * @param what Short label naming the operation, used in the error message.
 * @returns The parsed token set.
 * @throws When the status is not 2xx or the body carries no access token.
 */
function toTokens(response: TlsResponse, email: string, what: string): TeslaTokens {
    if (response.status < 200 || response.status >= 300) {
        throw new Error(
            `Tesla ${what} failed with HTTP ${response.status}: ${response.body.slice(0, 300)}`,
        );
    }
    let parsed: {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
    };
    try {
        parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
        throw new Error(`Tesla ${what} returned a non-JSON body: ${response.body.slice(0, 300)}`);
    }
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
        throw new Error(`Tesla ${what} returned no access token`);
    }
    // `expires_in` has been observed as both 300 and 28800 depending on
    // the endpoint's mood; treat anything implausible as 8 hours and
    // let the 401-triggered refresh catch the rest.
    const expiresIn =
        typeof parsed.expires_in === "number" && parsed.expires_in > 0
            ? parsed.expires_in
            : 8 * 60 * 60;
    return {
        accessToken: parsed.access_token,
        refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : "",
        expiresAt: Date.now() + expiresIn * 1000,
        email,
    };
}

/**
 * Read the `Location` header of a redirect response.
 *
 * @param response The redirect response.
 * @returns The location value.
 * @throws When the redirect carries no location.
 */
function locationOf(response: TlsResponse): string {
    const location = response.headers.location;
    const value = Array.isArray(location) ? location[0] : location;
    if (value === undefined || value.length === 0) {
        throw new Error("Tesla redirected without a Location header");
    }
    return value;
}

/**
 * Render whatever the SSO page actually said as a trailing clause for
 * an error message.
 *
 * Tesla states its refusals in plain prose on an HTML page (*"The
 * 'redirect_uri' supplied is not registered for this 'client_id'."*),
 * so quoting a stripped excerpt beats guessing at markers — the reason
 * reaches the user verbatim even when it is one we have never seen.
 *
 * @param html The page body.
 * @returns `" — Tesla said: …"`, or the empty string when the page had no text.
 */
function describePageError(html: string): string {
    const text = html
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
    return text.length === 0 ? "" : ` — Tesla said: ${text.slice(0, 200)}`;
}

/**
 * Build the human-readable reason a scripted login was refused. Tesla
 * does not return a machine-readable marker, so this leans on the
 * status plus a peek at the body for the tell-tale captcha markup.
 *
 * @param response The refusing response.
 * @returns A sentence suitable for a {@link LoginBlockedError}.
 */
function describeBlock(response: TlsResponse): string {
    if (/captcha/i.test(response.body)) {
        return "Tesla answered the login with a captcha challenge";
    }
    if (response.status === 401 || response.status === 403) {
        return `Tesla refused the login with HTTP ${response.status}`;
    }
    return `Tesla answered the login with an unexpected HTTP ${response.status}`;
}

/**
 * Pick the id of the first enrolled MFA factor out of the factors
 * response. Tesla wraps the list in `{"data": [...]}`.
 *
 * @param body Raw JSON body of the factors call.
 * @returns The factor id, or `null` when none is present.
 */
function firstFactorId(body: string): string | null {
    try {
        const parsed = JSON.parse(body) as { data?: readonly { id?: unknown }[] };
        const id = parsed.data?.[0]?.id;
        return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
        return null;
    }
}

/**
 * Whether the MFA verify response reports the passcode as accepted.
 * Tesla answers HTTP 200 either way and puts the verdict in the body.
 *
 * @param body Raw JSON body of the verify call.
 * @returns True only when the factor was both valid and approved.
 */
function isMfaApproved(body: string): boolean {
    try {
        const parsed = JSON.parse(body) as {
            data?: { approved?: unknown; valid?: unknown };
        };
        return parsed.data?.approved === true && parsed.data?.valid === true;
    } catch {
        return false;
    }
}

/**
 * Decode the handful of HTML entities Tesla's form values actually
 * contain. A full entity table would be overkill for CSRF tokens and
 * transaction ids.
 *
 * @param value Raw attribute value.
 * @returns The decoded value.
 */
function decodeEntities(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}
