import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, LoaderCircleIcon } from "lucide-react";

/** Visual state of a trace line. */
export type TraceStatus = "running" | "error" | "pending" | "done";

/**
 * Icon of a trace line (from the chatbot template).
 *
 * @param props.status Line state.
 * @returns The icon.
 */
export function StatusIcon({ status }: { readonly status: TraceStatus }) {
    if (status === "running") {
        return <LoaderCircleIcon className="animate-spin" />;
    }
    if (status === "error") {
        return <CircleAlertIcon />;
    }
    if (status === "pending") {
        return <CircleDashedIcon />;
    }
    return <CircleCheckIcon />;
}
