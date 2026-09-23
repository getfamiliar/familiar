import { fetchWithRetry } from "../HttpRetry.js";
import { TeslaApiError } from "./TeslaApiError.js";

/** Base of the unofficial Owner API. */
const OWNER_API_BASE = "https://owner-api.teslamotors.com";

/**
 * The Owner API requires *some* `User-Agent` and asks callers to
 * identify themselves. Unlike the ownership/invoice hosts this one is
 * not version-sniffed, so a stable honest string is fine.
 */
const USER_AGENT = "familiar-tesla-plugin";

/** Token provider; async because the auth layer may refresh first. */
export type TokenProvider = () => Promise<string>;

/** One vehicle as the list endpoint reports it. */
export interface TeslaVehicle {
    /**
     * Vehicle id used by every state endpoint. Kept as the string
     * (`id_s`) because the numeric form exceeds 2^53 and would lose
     * precision as a JS number.
     */
    readonly id: string;
    /** Chassis / streaming id. Not usable for state endpoints. */
    readonly vehicleId: number | null;
    readonly vin: string;
    readonly displayName: string;
    /** `"online"`, `"asleep"`, `"offline"`, … */
    readonly state: string;
    /**
     * Tesla's own verdict on whether this car accepts unsigned
     * commands: `"required"` means it does not. Read-only here — the
     * plugin sends no commands — but it is the authoritative answer to
     * "could remote control ever work for this car", so it is surfaced
     * rather than dropped. `null` when the account payload omits it.
     */
    readonly commandSigning: string | null;
}

/** Slice of `vehicle_data` the location tool reads. */
export interface DriveState {
    readonly latitude?: number;
    readonly longitude?: number;
    readonly heading?: number;
    /** Epoch **seconds** the GPS fix was taken. */
    readonly gps_as_of?: number;
    /** Epoch **milliseconds** the payload was assembled. */
    readonly timestamp?: number;
    readonly shift_state?: string | null;
    readonly speed?: number | null;
}

/** The full `vehicle_data` rollup. Only the fields we read are named. */
export interface VehicleData {
    readonly drive_state?: DriveState;
    readonly [key: string]: unknown;
}

/**
 * Minimal REST client for the Owner API, built straight on `fetch` —
 * same reasoning as ms365's `GraphClient`: nothing between us and the
 * wire protocol, and no SDK to drift.
 *
 * The client is stateless and read-only. Remote **commands** are
 * deliberately absent: since 2024 every VCSEC-equipped vehicle (Model
 * 3/Y, S/X from 2021) rejects unsigned commands, which would require
 * Tesla's `vehicle-command` proxy and a key paired inside the car.
 * `wake_up` is not a VCSEC command and works unsigned, so it stays.
 */
export class OwnerApiClient {
    private readonly tokenProvider: TokenProvider;

    constructor(tokenProvider: TokenProvider) {
        this.tokenProvider = tokenProvider;
    }

    /**
     * List every vehicle on the account.
     *
     * Reads `/api/1/products`, **not** `/api/1/vehicles`: Tesla closed
     * the latter with `412 "Endpoint is only available on fleetapi"`,
     * while `products` still answers and carries the same fields
     * (`id_s`, `vin`, `display_name`, `state`). Everything under
     * `/api/1/vehicles/{id}/…` keeps working — it is only the
     * collection route that was withdrawn.
     *
     * `products` also returns energy products (Powerwall, solar), which
     * have no VIN; those are filtered out.
     *
     * @returns The vehicles, in the order Tesla reports them.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    async listVehicles(): Promise<readonly TeslaVehicle[]> {
        const body = await this.getJson<{ response?: readonly RawProduct[] }>("/api/1/products");
        return (body.response ?? [])
            .filter((raw) => typeof raw.vin === "string" && raw.vin.length > 0)
            .map(toVehicle);
    }

    /**
     * Fetch one vehicle's list-level summary — notably its `state`,
     * which is what the wake-up poll watches.
     *
     * @param vehicleId The vehicle's `id_s`.
     * @returns The vehicle summary.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    async getVehicle(vehicleId: string): Promise<TeslaVehicle> {
        const body = await this.getJson<{ response?: RawProduct }>(
            `/api/1/vehicles/${encodeURIComponent(vehicleId)}`,
        );
        if (body.response === undefined) {
            throw new TeslaApiError(
                200,
                `${OWNER_API_BASE}/api/1/vehicles/${vehicleId}`,
                "empty response",
            );
        }
        return toVehicle(body.response);
    }

    /**
     * Ask a sleeping vehicle to wake. Returns immediately with the
     * vehicle summary — the car is **not** ready yet; poll
     * {@link getVehicle} until `state === "online"`.
     *
     * @param vehicleId The vehicle's `id_s`.
     * @returns The (still probably asleep) vehicle summary.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    async wakeUp(vehicleId: string): Promise<TeslaVehicle> {
        const body = await this.postJson<{ response?: RawProduct }>(
            `/api/1/vehicles/${encodeURIComponent(vehicleId)}/wake_up`,
        );
        if (body.response === undefined) {
            throw new TeslaApiError(
                200,
                `${OWNER_API_BASE}/api/1/vehicles/${vehicleId}/wake_up`,
                "empty response",
            );
        }
        return toVehicle(body.response);
    }

    /**
     * Fetch the full state rollup for one vehicle. Requires the car to
     * be awake; a sleeping vehicle answers `408`, surfaced as a
     * {@link TeslaApiError} with `isVehicleUnavailable`.
     *
     * Note the Owner API has no `endpoints` query parameter — that is a
     * Fleet API feature — so this always returns everything.
     *
     * @param vehicleId The vehicle's `id_s`.
     * @returns The `vehicle_data` object verbatim.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    async getVehicleData(vehicleId: string): Promise<VehicleData> {
        const body = await this.getJson<{ response?: VehicleData }>(
            `/api/1/vehicles/${encodeURIComponent(vehicleId)}/vehicle_data`,
        );
        if (body.response === undefined) {
            throw new TeslaApiError(
                200,
                `${OWNER_API_BASE}/api/1/vehicles/${vehicleId}/vehicle_data`,
                "empty response",
            );
        }
        return body.response;
    }

    /**
     * Issue a GET and parse the JSON envelope.
     *
     * @param path Path below {@link OWNER_API_BASE}, leading slash included.
     * @returns The parsed body.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    private getJson<T>(path: string): Promise<T> {
        return this.requestJson<T>("GET", path);
    }

    /**
     * Issue a POST with an empty body and parse the JSON envelope.
     *
     * @param path Path below {@link OWNER_API_BASE}, leading slash included.
     * @returns The parsed body.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    private postJson<T>(path: string): Promise<T> {
        return this.requestJson<T>("POST", path);
    }

    /**
     * Shared request path: inject the bearer token (refreshing it if
     * the auth layer says so), send, and turn a non-2xx into a
     * {@link TeslaApiError}.
     *
     * @param method HTTP method.
     * @param path Path below {@link OWNER_API_BASE}, leading slash included.
     * @returns The parsed JSON body.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    private async requestJson<T>(method: "GET" | "POST", path: string): Promise<T> {
        const url = `${OWNER_API_BASE}${path}`;
        const token = await this.tokenProvider();
        const response = await fetchWithRetry(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                "User-Agent": USER_AGENT,
            },
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new TeslaApiError(response.status, url, text);
        }
        return (await response.json()) as T;
    }
}

/**
 * One entry of `/api/1/products` (or of a single-vehicle GET), before
 * normalisation. Energy products share the envelope but carry no
 * `vin`, which is how {@link OwnerApiClient.listVehicles} tells them
 * apart.
 */
interface RawProduct {
    readonly id_s?: unknown;
    readonly id?: unknown;
    readonly vehicle_id?: unknown;
    readonly vin?: unknown;
    readonly display_name?: unknown;
    readonly state?: unknown;
    readonly command_signing?: unknown;
}

/**
 * Normalise a raw product into {@link TeslaVehicle}, preferring the
 * string id so the 64-bit value survives.
 *
 * @param raw The endpoint's product object.
 * @returns The normalised vehicle.
 */
function toVehicle(raw: RawProduct): TeslaVehicle {
    const id =
        typeof raw.id_s === "string" && raw.id_s.length > 0
            ? raw.id_s
            : typeof raw.id === "number"
              ? String(raw.id)
              : "";
    return {
        id,
        vehicleId: typeof raw.vehicle_id === "number" ? raw.vehicle_id : null,
        vin: typeof raw.vin === "string" ? raw.vin : "",
        displayName: typeof raw.display_name === "string" ? raw.display_name : "",
        state: typeof raw.state === "string" ? raw.state : "unknown",
        commandSigning: typeof raw.command_signing === "string" ? raw.command_signing : null,
    };
}
