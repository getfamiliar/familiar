/** Note the server appends to the text of a message with attachments (`[Attached: a.pdf, b.png]`). */
const ATTACHMENT_NOTE = /\n*\[Attached: [^\]\n]*\]$/;

/**
 * The message text without the attachment note (the attachments are
 * shown as files instead).
 *
 * @param text Stored message text.
 * @returns The text the user typed.
 */
export function stripAttachmentNote(text: string): string {
    return text.replace(ATTACHMENT_NOTE, "");
}

/**
 * Human-readable file size.
 *
 * @param bytes Size in bytes.
 * @returns E.g. `820 B`, `14 KB`, `3.2 MB`.
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Whether a local file can get an image thumbnail.
 *
 * @param file The file.
 * @returns True for raster images.
 */
export function isPreviewableImage(file: File): boolean {
    return /^image\/(png|jpe?g|gif|webp|avif)$/.test(file.type);
}

/**
 * Whether a drag carries files (not text or links).
 *
 * @param event Drag event.
 * @returns True when files are dragged.
 */
export function isFileDrag(event: { dataTransfer: DataTransfer | null }): boolean {
    return event.dataTransfer?.types.includes("Files") ?? false;
}
