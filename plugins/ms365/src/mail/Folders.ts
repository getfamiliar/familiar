/**
 * Folder aliases the agent can name, mapped to Graph's well-known
 * folder ids. The `mail_move` tool exposes only `inbox`/`archive`/
 * `trash` (moving items *into* `sent` is not something the agent does
 * today), but `mail_search` accepts all four — including `sent`, which
 * resolves to Graph's `sentitems` folder so the agent can find mails
 * the user has already sent out.
 *
 * Source for the well-known names:
 * https://learn.microsoft.com/graph/api/resources/mailfolder#well-known-folder-names
 */
export const FOLDER_IDS = {
    inbox: "inbox",
    archive: "archive",
    trash: "deleteditems",
    sent: "sentitems",
} as const;

/** The set of aliases the agent is allowed to use. */
export type FolderAlias = keyof typeof FOLDER_IDS;

/**
 * Type-narrowing guard: `true` exactly when `value` is one of the
 * exposed folder aliases. Used by mail tools to validate the agent's
 * input before dispatching to Graph.
 */
export function isFolderAlias(value: unknown): value is FolderAlias {
    return value === "inbox" || value === "archive" || value === "trash" || value === "sent";
}

/**
 * Resolved alias surfaced to the agent on each mail search hit.
 * Mirrors `MailSearchHit.folder` from shared/: one of the three
 * exposed aliases, or `"other"` for any folder we don't have a verb
 * for today, or `null` when the provider couldn't determine the
 * folder at all.
 */
export type ResolvedFolderAlias = FolderAlias | "other" | null;

/**
 * Per-mailbox cache that maps Graph's opaque `parentFolderId` values
 * back to the agent-facing aliases (`inbox`/`archive`/`trash`).
 *
 * Graph returns `parentFolderId` on every message as an opaque base64
 * id specific to the mailbox; the well-known names (`inbox` etc.) are
 * only accepted as *path components* in API URLs, not in message
 * payloads. So we resolve the well-known names to their opaque ids
 * once per mailbox via the supplied `lookup` callback (typically
 * `GraphClient.getWellKnownFolderId`) and consult the reverse map for
 * every hit afterwards.
 *
 * A failed lookup for a given well-known name (mailbox doesn't expose
 * that folder, transient Graph error, etc.) is cached as a miss so we
 * don't retry on every hit; the affected hits surface as `"other"`,
 * which is a strictly safer default than blocking the whole search.
 */
export class FolderAliasResolver {
    private readonly idToAlias = new Map<string, FolderAlias>();
    private readonly lookup: (wellKnownName: string) => Promise<string | null>;
    private ready: Promise<void> | undefined;

    constructor(lookup: (wellKnownName: string) => Promise<string | null>) {
        this.lookup = lookup;
    }

    /**
     * Resolve a Graph `parentFolderId` to an agent-facing alias.
     * Lazily warms the cache on first call. Subsequent calls reuse
     * the same map without further Graph round-trips.
     */
    async resolve(parentFolderId: string | null | undefined): Promise<ResolvedFolderAlias> {
        if (parentFolderId === null || parentFolderId === undefined) {
            return null;
        }
        await this.ensureWarmed();
        return this.idToAlias.get(parentFolderId) ?? "other";
    }

    private async ensureWarmed(): Promise<void> {
        if (this.ready) {
            await this.ready;
            return;
        }
        this.ready = (async () => {
            const entries: Array<[FolderAlias, string]> = [
                ["inbox", FOLDER_IDS.inbox],
                ["archive", FOLDER_IDS.archive],
                ["trash", FOLDER_IDS.trash],
                ["sent", FOLDER_IDS.sent],
            ];
            for (const [alias, wellKnownName] of entries) {
                const id = await this.lookup(wellKnownName).catch(() => null);
                if (id !== null) {
                    this.idToAlias.set(id, alias);
                }
            }
        })();
        await this.ready;
    }
}
