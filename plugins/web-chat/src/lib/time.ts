/**
 * Local time of a message (with the date when it is not today).
 *
 * @param iso ISO timestamp.
 * @returns The formatted time.
 */
export function formatTime(iso: string): string {
    const date = new Date(iso);
    const isToday = date.toDateString() === new Date().toDateString();
    return isToday
        ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
