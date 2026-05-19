/**
 * Folder aliases the agent passes to the `move` tool, mapped to
 * Graph's well-known folder ids. Three options is deliberate —
 * anything more exotic is a knob the user doesn't need today.
 *
 * Source for the well-known names:
 * https://learn.microsoft.com/graph/api/resources/mailfolder#well-known-folder-names
 */
export const FOLDER_IDS = {
    inbox: "inbox",
    archive: "archive",
    trash: "deleteditems",
} as const;

/** The set of aliases the agent is allowed to use. */
export type FolderAlias = keyof typeof FOLDER_IDS;

/**
 * Type-narrowing guard: `true` exactly when `value` is one of the
 * three exposed folder aliases. Used by the `move` tool to validate
 * the agent's input before dispatching to Graph.
 */
export function isFolderAlias(value: unknown): value is FolderAlias {
    return value === "inbox" || value === "archive" || value === "trash";
}
