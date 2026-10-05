import { BASTION_TOKEN_HEADER } from "@getfamiliar/shared";

/**
 * Request headers authenticating a call against the host bastion. Every
 * bastion client in the container merges these into its requests; the
 * bastion answers `401` to anything without the shared token.
 *
 * @param bastionToken The shared token from the passed config (`bastionToken`).
 * @returns A header map carrying the token.
 */
export function bastionAuthHeaders(bastionToken: string): Record<string, string> {
    return { [BASTION_TOKEN_HEADER]: bastionToken };
}
