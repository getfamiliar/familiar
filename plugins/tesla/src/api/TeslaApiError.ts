/**
 * A non-2xx answer from any Tesla host. Carries the status, the URL
 * that produced it and a body excerpt, so a caller can both branch on
 * the status (401 → re-login, 408 → asleep) and surface something
 * readable to the agent.
 */
export class TeslaApiError extends Error {
    readonly status: number;
    readonly url: string;
    readonly body: string;

    constructor(status: number, url: string, body: string) {
        super(`Tesla API ${status} at ${url}${body.length > 0 ? ` — ${body.slice(0, 300)}` : ""}`);
        this.name = "TeslaApiError";
        this.status = status;
        this.url = url;
        this.body = body;
    }

    /**
     * Whether this is the "vehicle is asleep and did not answer in
     * time" case. The Owner API reports it as `408 vehicle unavailable`
     * rather than a distinct code.
     *
     * @returns True when the vehicle was unreachable rather than the request bad.
     */
    get isVehicleUnavailable(): boolean {
        return this.status === 408 || /vehicle unavailable/i.test(this.body);
    }
}
