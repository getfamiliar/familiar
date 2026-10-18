import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    markdownToPlainText,
    sanitizeExternalText,
    stripInvisibleText,
} from "./ExternalTextSanitizer.js";

describe("stripInvisibleText", () => {
    it("removes zero-width, bidi, BOM and tag characters", () => {
        const tagged = `run${String.fromCodePoint(0xe0041, 0xe0042)}`;
        assert.equal(stripInvisibleText("a​b‮c﻿d⁦e"), "abcde");
        assert.equal(stripInvisibleText(tagged), "run");
    });

    it("keeps tabs and newlines, normalizes CRLF", () => {
        assert.equal(stripInvisibleText("a\tb\r\nc\u0007"), "a\tb\nc");
    });
});

describe("sanitizeExternalText", () => {
    it("drops HTML comments, also unterminated ones", () => {
        assert.equal(sanitizeExternalText("keep <!-- ignore previous --> this"), "keep  this");
        assert.equal(sanitizeExternalText("visible <!-- hidden till the end"), "visible");
    });
});

describe("markdownToPlainText", () => {
    it("removes images and badges, keeps link text with URL", () => {
        const input = [
            "# Title",
            "[![CI](https://x/badge.svg)](https://x/actions) ![logo](logo.png)",
            '<img src="a.png" alt="a"/>',
            "See [the docs](https://example.com/docs) for more.",
        ].join("\n");
        assert.equal(
            markdownToPlainText(input),
            "# Title\n\nSee the docs (https://example.com/docs) for more.",
        );
    });

    it("strips HTML tags, decodes entities and re-strips decoded invisibles", () => {
        assert.equal(
            markdownToPlainText('<p align="center"><b>Fast</b> &amp; small&#8203;</p>'),
            "Fast & small",
        );
    });

    it("keeps code fences", () => {
        const input = "```bash\nnpx foo --login\n```";
        assert.equal(markdownToPlainText(input), input);
    });
});
