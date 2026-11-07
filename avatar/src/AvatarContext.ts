import type { AvatarConfig } from "@getfamiliar/shared/avatar";
import { createContext, useContext } from "react";

/** The avatar being drawn, for parts that depend on other options (colors, facial hair). */
export const AvatarContext = createContext<AvatarConfig | null>(null);

/**
 * The avatar being drawn.
 *
 * @returns Its config.
 * @throws {Error} Outside of an avatar drawing.
 */
export function useAvatarConfig(): AvatarConfig {
    const config = useContext(AvatarContext);
    if (config === null) {
        throw new Error("avatar part rendered outside of an avatar");
    }
    return config;
}
