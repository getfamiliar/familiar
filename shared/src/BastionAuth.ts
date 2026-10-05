/**
 * HTTP header carrying the shared secret every bastion caller must
 * present. The host daemon generates (or reads from `core.bastionToken`)
 * the token at startup; the agent container receives it through its
 * passed config, host-side CLI commands read it from
 * `tmp/.bastion-token`. Requests without a matching header are answered
 * with `401` before any route runs.
 *
 * Deliberately a custom header rather than `Authorization`: the LLM
 * SDKs already send `Authorization` / `x-api-key` placeholders on
 * `/llm/` that the reverse proxy replaces, and a non-simple header
 * forces a CORS preflight the bastion never answers, which keeps
 * browser pages on the host from reaching it.
 */
export const BASTION_TOKEN_HEADER = "x-familiar-bastion-token";
