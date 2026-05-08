import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { proposeId } from "./RegistryEntry.js";

describe("proposeId", () => {
    it("passes a simple lowercase name through unchanged", () => {
        assert.equal(proposeId("fetch"), "fetch");
    });

    it("strips reverse-DNS prefixes and the trailing -mcp scaffolding", () => {
        assert.equal(proposeId("io.github.dgahagan/weather-mcp"), "weather");
    });

    it("strips npm scope prefixes and the trailing -mcp scaffolding", () => {
        assert.equal(proposeId("@dangahagan/weather-mcp"), "weather");
    });

    it("strips both mcp and server tokens, leaving the meaningful part", () => {
        assert.equal(proposeId("mcp-server-time"), "time");
    });

    it("strips a trailing -mcp suffix", () => {
        assert.equal(proposeId("pdf-mcp"), "pdf");
    });

    it("concatenates surviving tokens without dashes", () => {
        assert.equal(proposeId("time-tracker"), "timetracker");
    });

    it("lowercases mixed-case names", () => {
        assert.equal(proposeId("MyCoolMCP"), "mycoolmcp");
    });

    it("collapses non-alnum runs (dashes, dots, underscores)", () => {
        assert.equal(proposeId("--weather..mcp__"), "weather");
    });

    it("falls back to mcpserver when every token is filtered out", () => {
        assert.equal(proposeId("mcp-server"), "mcpserver");
    });

    it("falls back to mcpserver when the input has no usable characters", () => {
        assert.equal(proposeId("!!!"), "mcpserver");
    });

    it("falls back to mcpserver for an empty string", () => {
        assert.equal(proposeId(""), "mcpserver");
    });
});
