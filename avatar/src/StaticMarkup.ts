import type { AvatarConfig } from "@getfamiliar/shared/avatar";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type AvatarExpression, AvatarSvg } from "./AvatarSvg.js";

/**
 * The avatar as standalone SVG markup.
 *
 * @param config The avatar.
 * @param expression Optional face parts overriding the configured ones.
 * @returns An `<svg>` document fragment with its namespace.
 */
export function avatarToSvgMarkup(config: AvatarConfig, expression?: AvatarExpression): string {
    return renderToStaticMarkup(createElement(AvatarSvg, { config, expression }));
}

/**
 * The avatar as a `data:` URL, e.g. for a favicon or an `<img>`.
 *
 * @param config The avatar.
 * @returns `data:image/svg+xml;…` URL.
 */
export function avatarToDataUrl(config: AvatarConfig): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarToSvgMarkup(config))}`;
}
