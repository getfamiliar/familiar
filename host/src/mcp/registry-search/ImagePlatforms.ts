import { dockerCapture } from "@getfamiliar/shared";
import {
    fetchJson,
    fetchWithTimeout,
    HttpStatusError,
    isMapping,
    optionalNumber,
    optionalString,
} from "./RegistryHttp.js";

/** A parsed image reference. */
export interface ImageReference {
    /** Registry host, `docker.io` for Docker Hub. */
    readonly registry: string;
    /** Repository path, `library/…` for official Docker Hub images. */
    readonly repository: string;
    readonly tag?: string;
    readonly digest?: string;
}

/** Accept header covering OCI and Docker manifest/index media types. */
const MANIFEST_ACCEPT = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * Parse an image reference like `ghcr.io/github/github-mcp-server@sha256:…`,
 * `armlimited/arm-mcp:2.4.0@sha256:…` or `mcp/fetch`.
 *
 * @param reference The reference.
 * @returns The parts.
 */
export function parseImageReference(reference: string): ImageReference {
    let rest = reference;
    let digest: string | undefined;
    const at = rest.indexOf("@");
    if (at >= 0) {
        digest = rest.slice(at + 1);
        rest = rest.slice(0, at);
    }
    let tag: string | undefined;
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > rest.lastIndexOf("/")) {
        tag = rest.slice(lastColon + 1);
        rest = rest.slice(0, lastColon);
    }
    const parts = rest.split("/");
    const first = parts[0] as string;
    const hasRegistry =
        parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
    let registry = hasRegistry ? first : "docker.io";
    if (registry === "index.docker.io" || registry === "registry-1.docker.io") {
        registry = "docker.io";
    }
    let repository = hasRegistry ? parts.slice(1).join("/") : rest;
    if (registry === "docker.io" && !repository.includes("/")) {
        repository = `library/${repository}`;
    }
    return { registry, repository, tag, digest };
}

/**
 * Namespace of an image (`ghcr.io/github`, `docker.io/hashicorp`).
 *
 * @param reference The image reference.
 * @returns Registry plus all repository segments but the last.
 */
export function imageNamespace(reference: string): string {
    const parsed = parseImageReference(reference);
    const segments = parsed.repository.split("/");
    return [parsed.registry, ...segments.slice(0, -1)].join("/");
}

/**
 * The platform MCP containers run on, as `os/arch`. Asks the docker
 * daemon (the engine's platform is what matters, not the CLI's) and
 * falls back to the Node process architecture.
 *
 * @returns E.g. `linux/amd64` or `linux/arm64`.
 */
export async function detectContainerPlatform(): Promise<string> {
    try {
        const { code, stdout } = await dockerCapture([
            "version",
            "--format",
            "{{.Server.Os}}/{{.Server.Arch}}",
        ]);
        const value = stdout.trim();
        if (code === 0 && /^[a-z0-9]+\/[a-z0-9]+$/.test(value)) {
            return value;
        }
    } catch {
        // docker CLI missing: fall back to the process architecture below.
    }
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    return `linux/${arch}`;
}

/**
 * Look up the `os/arch` platforms an image is published for. Docker Hub
 * images go through the Hub API (manifest GETs on Docker Hub count
 * against the anonymous pull rate limit); every other registry through
 * the OCI distribution API with an anonymous bearer token.
 *
 * @param reference The image reference.
 * @returns Distinct platforms (attestation entries `unknown/unknown` dropped).
 * @throws Error when the registry can't be queried.
 */
export async function fetchImagePlatforms(reference: string): Promise<string[]> {
    const parsed = parseImageReference(reference);
    if (parsed.registry === "docker.io") {
        return fetchDockerHubPlatforms(parsed);
    }
    return fetchOciPlatforms(parsed);
}

/**
 * Docker Hub stats of an image's repository.
 *
 * @param reference The image reference.
 * @returns Pull count, or `null` for images not on Docker Hub.
 * @throws Error when the Hub API fails.
 */
export async function fetchDockerHubPulls(reference: string): Promise<number | null> {
    const parsed = parseImageReference(reference);
    if (parsed.registry !== "docker.io") {
        return null;
    }
    const [namespace, ...name] = parsed.repository.split("/");
    const body = await fetchJson(
        `https://hub.docker.com/v2/namespaces/${namespace}/repositories/${name.join("/")}`,
    );
    return isMapping(body) ? (optionalNumber(body.pull_count) ?? null) : null;
}

/**
 * Platforms of a Docker Hub image via the Hub tags API: the tag whose
 * digest matches a pinned digest, else the named tag, else `latest`.
 *
 * @param image Parsed Docker Hub reference.
 * @returns The platforms.
 * @throws Error when no matching tag is found or the API fails.
 */
async function fetchDockerHubPlatforms(image: ImageReference): Promise<string[]> {
    const [namespace, ...name] = image.repository.split("/");
    const base = `https://hub.docker.com/v2/namespaces/${namespace}/repositories/${name.join("/")}/tags`;
    if (image.digest !== undefined) {
        const body = await fetchJson(`${base}?page_size=100`);
        const results = isMapping(body) && Array.isArray(body.results) ? body.results : [];
        const match = results.find((tag) => isMapping(tag) && tag.digest === image.digest);
        if (match !== undefined) {
            return hubTagPlatforms(match);
        }
    }
    const body = await fetchJson(`${base}/${encodeURIComponent(image.tag ?? "latest")}`);
    return hubTagPlatforms(body);
}

/**
 * Platforms listed in one Hub tag object's `images[]`.
 *
 * @param tag Hub tag JSON.
 * @returns The platforms.
 */
function hubTagPlatforms(tag: unknown): string[] {
    const images = isMapping(tag) && Array.isArray(tag.images) ? tag.images : [];
    return distinctPlatforms(
        images.map((image) =>
            isMapping(image) ? { os: image.os, architecture: image.architecture } : {},
        ),
    );
}

/**
 * Platforms of an image on an OCI registry: an index lists them per
 * manifest; a single manifest needs its config blob.
 *
 * @param image Parsed reference.
 * @returns The platforms.
 * @throws Error when the registry can't be queried.
 */
async function fetchOciPlatforms(image: ImageReference): Promise<string[]> {
    const reference = image.digest ?? image.tag ?? "latest";
    const manifestUrl = `https://${image.registry}/v2/${image.repository}/manifests/${reference}`;
    const token = { value: undefined as string | undefined };
    const manifest = await fetchRegistryJson(manifestUrl, image, token, MANIFEST_ACCEPT);
    if (!isMapping(manifest)) {
        throw new Error(`${manifestUrl}: manifest is not an object`);
    }
    if (Array.isArray(manifest.manifests)) {
        return distinctPlatforms(
            manifest.manifests.map((entry) =>
                isMapping(entry) && isMapping(entry.platform) ? entry.platform : {},
            ),
        );
    }
    const config = isMapping(manifest.config) ? optionalString(manifest.config.digest) : undefined;
    if (config === undefined) {
        throw new Error(`${manifestUrl}: manifest has neither "manifests" nor "config"`);
    }
    const blob = await fetchRegistryJson(
        `https://${image.registry}/v2/${image.repository}/blobs/${config}`,
        image,
        token,
        "application/json",
    );
    return distinctPlatforms([isMapping(blob) ? blob : {}]);
}

/**
 * GET a registry URL as JSON, doing the anonymous bearer-token dance on
 * a 401 (`WWW-Authenticate: Bearer realm=…,service=…,scope=…`).
 *
 * @param url Registry URL.
 * @param image The image (for the default pull scope).
 * @param token Token cache shared by the calls for one image.
 * @param accept Accept header.
 * @returns Parsed JSON.
 * @throws Error on a non-2xx answer.
 */
async function fetchRegistryJson(
    url: string,
    image: ImageReference,
    token: { value: string | undefined },
    accept: string,
): Promise<unknown> {
    const send = (): Promise<Response> =>
        fetchWithTimeout(url, {
            accept,
            ...(token.value !== undefined ? { authorization: `Bearer ${token.value}` } : {}),
        });
    let response = await send();
    if (response.status === 401 && token.value === undefined) {
        token.value = await fetchAnonymousToken(
            response.headers.get("www-authenticate") ?? "",
            image,
        );
        response = await send();
    }
    if (!response.ok) {
        throw new HttpStatusError(url, response.status, response.statusText);
    }
    return response.json();
}

/**
 * Fetch an anonymous pull token from a registry's token realm.
 *
 * @param challenge The `WWW-Authenticate` header value.
 * @param image The image (scope fallback).
 * @returns The token.
 * @throws Error when the challenge is not a Bearer challenge or no token comes back.
 */
async function fetchAnonymousToken(challenge: string, image: ImageReference): Promise<string> {
    if (!/^bearer\s/i.test(challenge)) {
        throw new Error(
            `registry ${image.registry} wants "${challenge || "unknown"}" auth, not an anonymous bearer token`,
        );
    }
    const params = new Map<string, string>();
    for (const match of challenge.matchAll(/(\w+)="([^"]*)"/g)) {
        params.set((match[1] as string).toLowerCase(), match[2] as string);
    }
    const realm = params.get("realm");
    if (realm === undefined) {
        throw new Error(`registry ${image.registry}: bearer challenge without realm`);
    }
    const url = new URL(realm);
    const service = params.get("service");
    if (service !== undefined) {
        url.searchParams.set("service", service);
    }
    url.searchParams.set("scope", params.get("scope") ?? `repository:${image.repository}:pull`);
    const body = await fetchJson(url.toString());
    const value = isMapping(body)
        ? (optionalString(body.token) ?? optionalString(body.access_token))
        : undefined;
    if (value === undefined) {
        throw new Error(`registry ${image.registry}: token endpoint returned no token`);
    }
    return value;
}

/**
 * Normalize `{os, architecture}` objects to distinct `os/arch` strings,
 * dropping attestation entries (`unknown/unknown`).
 *
 * @param entries Platform-like objects.
 * @returns The platforms.
 */
function distinctPlatforms(entries: readonly Record<string, unknown>[]): string[] {
    const platforms = new Set<string>();
    for (const entry of entries) {
        const os = optionalString(entry.os);
        const arch = optionalString(entry.architecture);
        if (os === undefined || arch === undefined || os === "unknown" || arch === "unknown") {
            continue;
        }
        platforms.add(`${os}/${arch}`);
    }
    return [...platforms];
}
