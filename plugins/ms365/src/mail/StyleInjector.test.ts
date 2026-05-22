import assert from "node:assert/strict";
import { test } from "node:test";
import { injectStyle, STYLED_TAGS } from "./StyleInjector.js";

const CSS = "font-family: Calibri; font-size: 11pt";

test("injectStyle decorates a bare <p>", () => {
    assert.equal(injectStyle("<p>hi</p>", CSS, ["p"]), `<p style="${CSS}">hi</p>`);
});

test("injectStyle decorates every element of each kind", () => {
    const html = "<p>a</p><div>b</div><span>c</span><li>d</li>";
    const out = injectStyle(html, CSS, ["p", "div", "span", "li"]);
    assert.equal(
        out,
        `<p style="${CSS}">a</p><div style="${CSS}">b</div><span style="${CSS}">c</span><li style="${CSS}">d</li>`,
    );
});

test("injectStyle decorates headings h1 through h6", () => {
    const html = "<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6>";
    const out = injectStyle(html, CSS, ["h1", "h2", "h3", "h4", "h5", "h6"]);
    for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
        assert.ok(
            out.includes(`<${tag} style="${CSS}">`),
            `expected <${tag} style="…"> in: ${out}`,
        );
    }
});

test("injectStyle decorates table cells", () => {
    const html = "<td>a</td><th>b</th>";
    const out = injectStyle(html, CSS, ["td", "th"]);
    assert.equal(out, `<td style="${CSS}">a</td><th style="${CSS}">b</th>`);
});

test("injectStyle preserves existing style= attribute (no double-injection)", () => {
    const html = `<p style="color: red">hi</p>`;
    assert.equal(injectStyle(html, CSS, ["p"]), html);
});

test("injectStyle preserves other attributes alongside the new style", () => {
    const html = `<p class="lead" id="x">hi</p>`;
    assert.equal(injectStyle(html, CSS, ["p"]), `<p class="lead" id="x" style="${CSS}">hi</p>`);
});

test("injectStyle is case-insensitive on the tag name", () => {
    const html = "<P>hi</P>";
    assert.equal(injectStyle(html, CSS, ["p"]), `<P style="${CSS}">hi</P>`);
});

test("injectStyle survives nested tags of the same kind", () => {
    const html = "<div><div>nested</div></div>";
    const out = injectStyle(html, CSS, ["div"]);
    assert.equal(out, `<div style="${CSS}"><div style="${CSS}">nested</div></div>`);
});

test("injectStyle no-ops on empty CSS string", () => {
    const html = "<p>hi</p>";
    assert.equal(injectStyle(html, "", ["p"]), html);
});

test("injectStyle no-ops on empty tag list", () => {
    const html = "<p>hi</p>";
    assert.equal(injectStyle(html, CSS, []), html);
});

test("injectStyle leaves tags not in the list untouched", () => {
    const html = `<p>hi</p><script>alert(1)</script><a href="x">y</a>`;
    const out = injectStyle(html, CSS, ["p"]);
    assert.equal(out, `<p style="${CSS}">hi</p><script>alert(1)</script><a href="x">y</a>`);
});

test("STYLED_TAGS contains the documented set", () => {
    assert.deepEqual(STYLED_TAGS, [
        "p",
        "li",
        "div",
        "span",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "td",
        "th",
    ]);
});
