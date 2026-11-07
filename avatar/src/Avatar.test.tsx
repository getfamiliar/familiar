/** @jsxRuntime automatic @jsxImportSource react */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    AVATAR_OPTION_VALUES,
    type AvatarConfig,
    type AvatarOptionField,
    DEFAULT_AVATAR,
} from "@getfamiliar/shared/avatar";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "./Avatar.js";
import { AvatarSvg } from "./AvatarSvg.js";
import { avatarToDataUrl, avatarToSvgMarkup } from "./StaticMarkup.js";

describe("AvatarSvg", () => {
    it("renders every value of every option", () => {
        for (const field of Object.keys(AVATAR_OPTION_VALUES) as AvatarOptionField[]) {
            for (const value of AVATAR_OPTION_VALUES[field]) {
                const config = { ...DEFAULT_AVATAR, [field]: value } as AvatarConfig;
                const markup = avatarToSvgMarkup(config);
                assert.match(
                    markup,
                    /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
                    `${field}=${value}`,
                );
            }
        }
    });

    it("draws hair, hat and facial hair colors only where they apply", () => {
        const withHat = avatarToSvgMarkup({
            ...DEFAULT_AVATAR,
            topType: "WinterHat1",
            hatColor: "Pink",
        });
        assert.match(withHat, /#FF488E/);
        const withBeard = avatarToSvgMarkup({
            ...DEFAULT_AVATAR,
            facialHairType: "BeardMedium",
            facialHairColor: "Platinum",
        });
        assert.match(withBeard, /#ECDCBF/);
    });

    it("keeps references unique when two avatars share a page", () => {
        const markup = renderToStaticMarkup(
            <div>
                <AvatarSvg config={DEFAULT_AVATAR} />
                <AvatarSvg config={DEFAULT_AVATAR} />
            </div>,
        );
        const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
        assert.ok(ids.length > 0);
        assert.equal(new Set(ids).size, ids.length);
        for (const reference of markup.matchAll(/(?:href="#|url\(#)([^")]+)/g)) {
            assert.ok(ids.includes(reference[1]), `dangling reference ${reference[1]}`);
        }
    });

    it("applies the expression over the configured face", () => {
        const plain = avatarToSvgMarkup(DEFAULT_AVATAR);
        const closed = avatarToSvgMarkup(DEFAULT_AVATAR, { eyes: "Close" });
        assert.notEqual(plain, closed);
    });
});

describe("avatarToDataUrl", () => {
    it("encodes the SVG with its background", () => {
        const url = avatarToDataUrl({ ...DEFAULT_AVATAR, backgroundColor: "#123456" });
        assert.ok(url.startsWith("data:image/svg+xml;charset=utf-8,%3Csvg"));
        assert.match(decodeURIComponent(url), /fill="#123456"/);
    });
});

describe("Avatar", () => {
    it("renders the animation stylesheet only when animated", () => {
        assert.match(renderToStaticMarkup(<Avatar config={DEFAULT_AVATAR} />), /fa-animated/);
        assert.doesNotMatch(
            renderToStaticMarkup(<Avatar config={DEFAULT_AVATAR} animated={false} />),
            /class="fa-animated/,
        );
    });
});
