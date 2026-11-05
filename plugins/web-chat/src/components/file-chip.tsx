import { DownloadIcon, FileIcon, XIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import type { ChatFileDto } from "@/host/ChatProtocol";
import { formatBytes, isPreviewableImage } from "@/lib/files";

/**
 * A file attached to the message being written: thumbnail for images,
 * icon otherwise, name, size and a remove button.
 *
 * @param props.file The local file.
 * @param props.onRemove Remove it from the message.
 * @returns The chip.
 */
export function PendingFileChip({
    file,
    onRemove,
}: {
    readonly file: File;
    readonly onRemove: () => void;
}) {
    const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!isPreviewableImage(file)) {
            return;
        }
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [file]);
    return (
        <div className="group/chip relative flex h-14 max-w-56 items-center gap-2 rounded-lg border bg-background p-1.5 pr-7">
            <Thumbnail imageUrl={previewUrl} />
            <FileLabel name={file.name} size={file.size} />
            <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${file.name}`}
                className="absolute top-1 right-1"
                onClick={onRemove}
            >
                <XIcon />
            </Button>
        </div>
    );
}

/**
 * A stored file of a chat event, as a download link (images with a thumbnail).
 *
 * @param props.file The file.
 * @returns The link.
 */
export function StoredFileChip({ file }: { readonly file: ChatFileDto }) {
    return (
        <a
            href={file.url}
            target={file.isImage ? "_blank" : undefined}
            rel="noreferrer"
            download={file.isImage ? undefined : file.name}
            className="group/chip flex h-14 max-w-64 items-center gap-2 rounded-lg border bg-background p-1.5 pr-3 transition-colors hover:bg-accent"
            title={`Download ${file.name}`}
        >
            <Thumbnail imageUrl={file.isImage ? file.url : null} />
            <FileLabel name={file.name} size={file.size} />
            <DownloadIcon className="ml-1 size-4 shrink-0 text-muted-foreground" />
        </a>
    );
}

/**
 * A row of stored files.
 *
 * @param props.files The files.
 * @param props.align Which side of the transcript.
 * @returns The row, or nothing for no files.
 */
export function StoredFiles({
    files,
    align,
}: {
    readonly files: readonly ChatFileDto[];
    readonly align: "start" | "end";
}) {
    if (files.length === 0) {
        return null;
    }
    return (
        <div
            className={`flex flex-wrap gap-2 ${align === "end" ? "justify-end" : "justify-start"}`}
        >
            {files.map((file) => (
                <StoredFileChip key={file.url} file={file} />
            ))}
        </div>
    );
}

/**
 * Square preview: the image, or a file icon.
 *
 * @param props.imageUrl Image URL, or null for the icon.
 * @returns The thumbnail.
 */
function Thumbnail({ imageUrl }: { readonly imageUrl: string | null }) {
    return (
        <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            {imageUrl === null ? (
                <FileIcon className="size-5 text-muted-foreground" />
            ) : (
                <img src={imageUrl} alt="" className="size-full object-cover" />
            )}
        </div>
    );
}

/**
 * Name and size of a file, truncated.
 *
 * @param props.name File name.
 * @param props.size Size in bytes.
 * @returns The label.
 */
function FileLabel({ name, size }: { readonly name: string; readonly size: number }) {
    return (
        <div className="grid min-w-0 text-left text-xs leading-tight">
            <span className="truncate font-medium">{name}</span>
            <span className="text-muted-foreground">{formatBytes(size)}</span>
        </div>
    );
}
