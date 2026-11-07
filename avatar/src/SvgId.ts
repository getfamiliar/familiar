import { useState } from "react";

/**
 * Prefix unique to this copy of the module. Every plugin page bundles its
 * own copy and renders into its own React root, so neither `useId` nor a
 * plain counter would be unique within the document.
 */
const MODULE_PREFIX = `fa${Math.random().toString(36).slice(2, 8)}`;

/** Ids handed out by this copy of the module. */
let issuedIds = 0;

/**
 * A document-unique id for an SVG `mask` / `path` / `filter` reference,
 * stable for the lifetime of the component.
 *
 * @returns An id made of letters, digits and `-`.
 */
export function useSvgId(): string {
    const [id] = useState(() => {
        issuedIds += 1;
        return `${MODULE_PREFIX}-${issuedIds.toString(36)}`;
    });
    return id;
}
