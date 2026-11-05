import { readFile } from "node:fs/promises";
import { type EventFile, type HostContext, isHiddenScratchFile } from "@getfamiliar/shared";
import type { ChatFileDto } from "./ChatProtocol.js";

/**
 * Bookkeeping file in an event's scratch folder: which files the user
 * attached (hidden, so neither the model's file listing nor the downloads
 * show it).
 */
export const UPLOAD_MANIFEST = ".web-chat-uploads.json";

/** Longest file name kept (characters, extension included). */
const MAX_NAME_LENGTH = 120;

/** Extensions the browser may show inline (raster images only — no SVG, it can carry script). */
const INLINE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);

/** A file the user attached to a message. */
export interface ChatUpload {
    readonly name: string;
    readonly contents: Buffer;
}

/**
 * Turn a browser-supplied file name into a safe scratch basename: no
 * path separators or control characters, no leading dots (those are
 * internal files), at most {@link MAX_NAME_LENGTH} characters with the
 * extension kept.
 *
 * @param raw Name from the upload.
 * @returns A non-empty basename.
 */
export function sanitizeUploadName(raw: string): string {
    const base = raw.split(/[/\\]/).pop() ?? "";
    let name = [...base]
        .filter((char) => !isControlCharacter(char))
        .join("")
        .trim()
        .replace(/^\.+/, "");
    if (name === "") {
        name = "file";
    }
    if (name.length > MAX_NAME_LENGTH) {
        const dot = name.lastIndexOf(".");
        const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
        name = name.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
    }
    return name;
}

/**
 * Whether a character is an ASCII control character (C0 or DEL).
 *
 * @param char One character.
 * @returns True for control characters.
 */
function isControlCharacter(char: string): boolean {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
}

/**
 * The event files for a message's uploads: sanitized, de-duplicated names
 * (`photo.jpg`, `photo-2.jpg`) plus the upload manifest.
 *
 * @param uploads The attached files.
 * @returns Files for `NewEvent.files` and the final names (in input order).
 */
export function buildUploadFiles(uploads: readonly ChatUpload[]): {
    files: EventFile[];
    names: string[];
} {
    const taken = new Set<string>();
    const names = uploads.map((upload) => {
        const name = sanitizeUploadName(upload.name);
        let unique = name;
        for (let counter = 2; taken.has(unique.toLowerCase()); counter++) {
            const dot = name.lastIndexOf(".");
            unique =
                dot > 0
                    ? `${name.slice(0, dot)}-${counter}${name.slice(dot)}`
                    : `${name}-${counter}`;
        }
        taken.add(unique.toLowerCase());
        return unique;
    });
    if (uploads.length === 0) {
        return { files: [], names };
    }
    const files: EventFile[] = uploads.map((upload, index) => ({
        name: names[index] as string,
        contents: upload.contents,
    }));
    files.push({
        name: UPLOAD_MANIFEST,
        contents: Buffer.from(JSON.stringify({ uploads: names })),
    });
    return { files, names };
}

/**
 * Whether a file may be shown inline in the browser.
 *
 * @param name File name.
 * @returns True for raster images.
 */
export function isInlineImage(name: string): boolean {
    const dot = name.lastIndexOf(".");
    return dot > 0 && INLINE_IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * Download URL of an event file.
 *
 * @param apiBase Mount of the chat API (`/plugins/web-chat/api`).
 * @param eventId Event id.
 * @param name File name.
 * @returns The URL.
 */
export function fileUrl(apiBase: string, eventId: string, name: string): string {
    return `${apiBase}/files/${eventId}/${encodeURIComponent(name)}`;
}

/**
 * The files of an event for the chat: every visible file of its scratch
 * folder, marked as upload when the manifest lists it.
 *
 * @param scratch Host scratch API.
 * @param apiBase Mount of the chat API, for the download URLs.
 * @param eventId Event id.
 * @returns The files, uploads first, each group by name.
 */
export async function listChatFiles(
    scratch: Pick<HostContext["scratch"], "listFiles" | "resolveFile">,
    apiBase: string,
    eventId: string,
): Promise<ChatFileDto[]> {
    const all = await scratch.listFiles(eventId);
    const uploads = all.some((file) => file.name === UPLOAD_MANIFEST)
        ? await readManifest(scratch.resolveFile(eventId, UPLOAD_MANIFEST))
        : new Set<string>();
    return all
        .filter((file) => !isHiddenScratchFile(file.name))
        .map((file) => ({
            name: file.name,
            size: file.size,
            url: fileUrl(apiBase, eventId, file.name),
            isImage: isInlineImage(file.name),
            isUpload: uploads.has(file.name),
        }))
        .sort((a, b) => Number(b.isUpload) - Number(a.isUpload) || a.name.localeCompare(b.name));
}

/**
 * Read the upload manifest.
 *
 * @param file Host path of the manifest.
 * @returns The uploaded names (empty for a missing or malformed manifest).
 */
async function readManifest(file: string): Promise<Set<string>> {
    try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as { uploads?: unknown };
        return new Set(
            Array.isArray(parsed.uploads)
                ? parsed.uploads.filter((name): name is string => typeof name === "string")
                : [],
        );
    } catch {
        return new Set();
    }
}
