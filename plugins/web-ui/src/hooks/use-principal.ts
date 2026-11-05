import { useEffect, useState } from "react";

/** The signed-in user, as the core webserver resolved it (`GET /api/me`). */
export interface Principal {
    /** Login as listed in `webserver.auth.users`. */
    readonly login: string;
    /** Display name from the trusted proxy, else the login. */
    readonly displayName: string;
    /** `session`, or the id of the trusted proxy that vouched for the login. */
    readonly via: string;
}

/**
 * Load the signed-in user once. A 401 (session expired) sends the
 * browser to the core login page.
 *
 * @returns The principal, or null while loading or on error.
 */
export function usePrincipal(): Principal | null {
    const [principal, setPrincipal] = useState<Principal | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        fetch("/api/me", { signal: controller.signal, headers: { accept: "application/json" } })
            .then(async (res) => {
                if (res.status === 401) {
                    window.location.assign("/login");
                    return;
                }
                if (!res.ok) {
                    throw new Error(`GET /api/me answered ${res.status}`);
                }
                setPrincipal((await res.json()) as Principal);
            })
            .catch((err: unknown) => {
                if (!controller.signal.aborted) {
                    console.error("could not load the signed-in user", err);
                }
            });
        return () => controller.abort();
    }, []);
    return principal;
}
