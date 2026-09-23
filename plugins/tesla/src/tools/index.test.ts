import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTeslaTools } from "./index.js";

/**
 * The host registers each tool as `tesla_<name>`, and the registry
 * rejects names it cannot fold into a tool key. Keeping the contract
 * pinned here means a rename shows up as a failing test instead of a
 * daemon that refuses to boot.
 */
describe("buildTeslaTools", () => {
    const tools = buildTeslaTools();

    it("contributes exactly the five read-only tools", () => {
        assert.deepEqual(tools.map((t) => t.name).sort(), [
            "info",
            "invoices",
            "location",
            "set_default_vehicle",
            "vehicles_list",
        ]);
    });

    it("uses names the tool registry can namespace", () => {
        for (const tool of tools) {
            assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `bad tool name: ${tool.name}`);
        }
    });

    it("leaves every tool at the default level — nothing here mutates the car", () => {
        for (const tool of tools) {
            assert.equal(tool.level, undefined, `${tool.name} should not be privileged`);
        }
    });

    it("declares a closed object schema with a description for every tool", () => {
        for (const tool of tools) {
            const schema = tool.inputSchema as {
                type?: string;
                additionalProperties?: boolean;
                properties?: Record<string, { description?: string }>;
            };
            assert.equal(schema.type, "object", `${tool.name} schema must be an object`);
            assert.equal(
                schema.additionalProperties,
                false,
                `${tool.name} must reject unknown arguments`,
            );
            assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
            for (const [arg, spec] of Object.entries(schema.properties ?? {})) {
                assert.ok(
                    (spec.description ?? "").length > 0,
                    `${tool.name}.${arg} needs a description`,
                );
            }
        }
    });
});
