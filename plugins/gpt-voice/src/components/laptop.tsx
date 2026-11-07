import { cn } from "@/lib/utils";

/**
 * A laptop seen from behind (lid and front edge of the base), drawn in
 * front of the assistant while it works in the background. Slides in
 * from below when `isVisible`.
 *
 * @param props.isVisible Whether the laptop is in the picture.
 * @param props.className Size and position.
 * @returns The laptop.
 */
export function Laptop({
    isVisible,
    className,
}: {
    readonly isVisible: boolean;
    readonly className?: string;
}) {
    return (
        <svg
            viewBox="0 0 200 100"
            aria-hidden="true"
            className={cn(
                "transition-transform duration-500 ease-out",
                isVisible ? "translate-y-0" : "translate-y-[110%]",
                className,
            )}
        >
            <defs>
                <linearGradient id="familiar-voice-laptop-lid" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#e3e6eb" />
                    <stop offset="1" stopColor="#c3c8d0" />
                </linearGradient>
            </defs>
            <rect
                x="12"
                y="2"
                width="176"
                height="92"
                rx="7"
                fill="url(#familiar-voice-laptop-lid)"
            />
            <rect
                x="12"
                y="2"
                width="176"
                height="92"
                rx="7"
                fill="none"
                stroke="#aeb4bd"
                strokeWidth="1.5"
            />
            <circle cx="100" cy="46" r="8" fill="#ffffff" fillOpacity="0.75" />
            <rect x="0" y="92" width="200" height="8" rx="3" fill="#8e959f" />
            <rect x="84" y="92" width="32" height="3" rx="1.5" fill="#757c86" />
        </svg>
    );
}
