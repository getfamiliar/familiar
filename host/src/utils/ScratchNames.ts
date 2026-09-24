/**
 * Pick a basename safe to write under a scratch directory,
 * disambiguating against names already taken. Path separators become
 * `_`, leading dots are stripped (no hidden files, no `..`), and
 * collisions get a ` (2)`, ` (3)`, … suffix before the extension.
 *
 * @param name - Suggested file name (untrusted, e.g. from a provider).
 * @param used - Names already taken; the chosen name is added to it.
 * @returns A basename not yet in `used`.
 * @throws Error when no free name is found after 1000 attempts.
 */
export function dedupName(name: string, used: Set<string>): string {
    const cleaned = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
    let candidate = cleaned.length > 0 ? cleaned : "attachment";
    if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
    }
    const dot = candidate.lastIndexOf(".");
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
    const ext = dot > 0 ? candidate.slice(dot) : "";
    for (let i = 2; i < 1000; i++) {
        candidate = `${stem} (${i})${ext}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
    throw new Error("could not dedupe attachment name");
}
