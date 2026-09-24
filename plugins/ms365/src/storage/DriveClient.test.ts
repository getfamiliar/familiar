import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    DriveClient,
    extractSkipToken,
    SIMPLE_UPLOAD_LIMIT,
    UPLOAD_CHUNK_BYTES,
} from "./DriveClient.js";

interface Call {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly bodyLength: number;
}

const realFetch = globalThis.fetch;

/** Replace fetch with a scripted responder, recording every call. */
function mockFetch(respond: (call: Call, index: number) => Response): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body;
        const call: Call = {
            method: init?.method ?? "GET",
            url: String(input),
            headers: { ...(init?.headers as Record<string, string>) },
            bodyLength:
                body instanceof Uint8Array
                    ? body.length
                    : typeof body === "string"
                      ? body.length
                      : 0,
        };
        calls.push(call);
        return respond(call, calls.length - 1);
    }) as typeof fetch;
    return calls;
}

afterEach(() => {
    globalThis.fetch = realFetch;
});

const client = new DriveClient(async () => "TOKEN");

describe("DriveClient", () => {
    it("uploads large files in 320 KiB-aligned chunks without auth on the session URL", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "drive-client-"));
        const file = path.join(dir, "big.bin");
        const size = 2 * UPLOAD_CHUNK_BYTES + 12345;
        await writeFile(file, Buffer.alloc(size, 7));
        const calls = mockFetch((call) => {
            if (call.url.endsWith("/createUploadSession")) {
                return Response.json({ uploadUrl: "https://upload.example/session" });
            }
            const range = call.headers["Content-Range"] ?? "";
            if (range.endsWith(`-${size - 1}/${size}`)) {
                return Response.json({ id: "NEW", name: "big.bin" }, { status: 201 });
            }
            return new Response(null, { status: 202 });
        });
        const item = await client.uploadNew("D", "P", "big.bin", file, size, "fail");
        assert.equal(item.id, "NEW");
        const chunks = calls.filter((c) => c.url === "https://upload.example/session");
        assert.equal(chunks.length, 3);
        assert.deepEqual(
            chunks.map((c) => c.headers["Content-Range"]),
            [
                `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`,
                `bytes ${UPLOAD_CHUNK_BYTES}-${2 * UPLOAD_CHUNK_BYTES - 1}/${size}`,
                `bytes ${2 * UPLOAD_CHUNK_BYTES}-${size - 1}/${size}`,
            ],
        );
        assert.ok(chunks.every((c) => c.headers.Authorization === undefined));
        assert.equal(UPLOAD_CHUNK_BYTES % (320 * 1024), 0);
        assert.equal(calls[0]?.headers.Authorization, "Bearer TOKEN");
    });

    it("uses a single PUT with conflict behaviour for small files", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "drive-client-"));
        const file = path.join(dir, "small.txt");
        await writeFile(file, "hello");
        const calls = mockFetch(() =>
            Response.json({ id: "S", name: "small.txt" }, { status: 201 }),
        );
        await client.uploadNew("D", "P", "small.txt", file, 5, "rename");
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.method, "PUT");
        assert.match(
            calls[0]?.url ?? "",
            /items\/P:\/small\.txt:\/content\?%40microsoft\.graph\.conflictBehavior=rename$/,
        );
        assert.ok(5 <= SIMPLE_UPLOAD_LIMIT);
    });

    it("sends If-Match on guarded replaces", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "drive-client-"));
        const file = path.join(dir, "r.txt");
        await writeFile(file, "v2");
        const calls = mockFetch(() => Response.json({ id: "R", name: "r.txt" }));
        await client.uploadReplace("D", "R", file, 2, '"{E},1"');
        assert.equal(calls[0]?.headers["If-Match"], '"{E},1"');
    });

    it("retries throttled requests honouring Retry-After", async () => {
        const calls = mockFetch((_call, index) =>
            index === 0
                ? new Response("slow down", { status: 429, headers: { "Retry-After": "0" } })
                : Response.json({ id: "ROOT", name: "root", root: {} }),
        );
        const root = await client.getRoot("D");
        assert.equal(root.id, "ROOT");
        assert.equal(calls.length, 2);
    });

    it("streams downloads to disk", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "drive-client-"));
        const dest = path.join(dir, "out.bin");
        mockFetch(() => new Response(new Blob([Buffer.alloc(100_000, 1)]).stream()));
        const bytes = await client.downloadTo("D", "I", dest);
        assert.equal(bytes, 100_000);
        assert.equal((await readFile(dest)).length, 100_000);
    });

    it("keeps only the skiptoken of next links", async () => {
        assert.equal(
            extractSkipToken(
                "https://graph.microsoft.com/v1.0/drives/D/items/I/children?$top=2&$skiptoken=abc123",
            ),
            "abc123",
        );
        assert.equal(extractSkipToken(undefined), null);
        assert.throws(() => extractSkipToken("https://graph.microsoft.com/v1.0/x?$top=2"));
        const calls = mockFetch(() =>
            Response.json({
                value: [{ id: "A", name: "a" }],
                "@odata.nextLink":
                    "https://graph.microsoft.com/v1.0/drives/D/items/F/children?$skiptoken=tok",
            }),
        );
        const page = await client.listChildren("D", "F", 1, undefined);
        assert.equal(page.skipToken, "tok");
        await client.listChildren("D", "F", 1, "tok");
        assert.match(calls[1]?.url ?? "", /%24skiptoken=tok/);
    });
});
