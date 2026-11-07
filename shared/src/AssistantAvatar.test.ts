import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    DEFAULT_AVATAR,
    findAvatarConfigProblems,
    isAvatarOptionRelevant,
    normalizeAvatarConfig,
} from "./AssistantAvatar.js";

describe("normalizeAvatarConfig", () => {
    it("completes a partial avatar with defaults", () => {
        assert.deepEqual(normalizeAvatarConfig({ topType: "Hat", backgroundColor: "#ABCDEF" }), {
            ...DEFAULT_AVATAR,
            topType: "Hat",
            backgroundColor: "#abcdef",
        });
    });

    it("replaces invalid values and ignores unknown options", () => {
        assert.deepEqual(
            normalizeAvatarConfig({ topType: "Mohawk", backgroundColor: "blue", glasses: true }),
            DEFAULT_AVATAR,
        );
    });

    it("falls back to the default for anything but a mapping", () => {
        assert.equal(normalizeAvatarConfig(undefined), DEFAULT_AVATAR);
        assert.equal(normalizeAvatarConfig("Hat"), DEFAULT_AVATAR);
        assert.equal(normalizeAvatarConfig(["Hat"]), DEFAULT_AVATAR);
    });
});

describe("findAvatarConfigProblems", () => {
    it("accepts an absent or valid avatar", () => {
        assert.deepEqual(findAvatarConfigProblems(undefined), []);
        assert.deepEqual(findAvatarConfigProblems(DEFAULT_AVATAR), []);
        assert.deepEqual(findAvatarConfigProblems({ eyeType: "Wink" }), []);
    });

    it("names unknown options, bad values and bad colors", () => {
        const problems = findAvatarConfigProblems({
            eyeType: "Laser",
            glasses: true,
            backgroundColor: "#fff",
        });
        assert.equal(problems.length, 3);
        assert.match(problems.join("\n"), /eyeType must be one of .*\(got Laser\)/);
        assert.match(problems.join("\n"), /unknown option glasses/);
        assert.match(problems.join("\n"), /backgroundColor must be a #rrggbb color/);
    });

    it("refuses a non-mapping", () => {
        assert.deepEqual(findAvatarConfigProblems("Hat"), ["must be a mapping of avatar options"]);
    });
});

describe("isAvatarOptionRelevant", () => {
    it("ties colors and prints to the parts that show them", () => {
        assert.equal(
            isAvatarOptionRelevant("hatColor", { ...DEFAULT_AVATAR, topType: "Turban" }),
            true,
        );
        assert.equal(isAvatarOptionRelevant("hatColor", DEFAULT_AVATAR), false);
        assert.equal(
            isAvatarOptionRelevant("hairColor", { ...DEFAULT_AVATAR, topType: "NoHair" }),
            false,
        );
        assert.equal(isAvatarOptionRelevant("facialHairColor", DEFAULT_AVATAR), false);
        assert.equal(
            isAvatarOptionRelevant("graphicType", {
                ...DEFAULT_AVATAR,
                clotheType: "GraphicShirt",
            }),
            true,
        );
        assert.equal(
            isAvatarOptionRelevant("clotheColor", { ...DEFAULT_AVATAR, clotheType: "BlazerShirt" }),
            false,
        );
        assert.equal(isAvatarOptionRelevant("eyeType", DEFAULT_AVATAR), true);
    });
});
