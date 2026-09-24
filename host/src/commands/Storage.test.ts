import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectWriteRoots, lintExitCode, renderFindings } from "./Storage.js";

describe("storage lint exit codes", () => {
    it("maps severities to 0 / 1 / 2 and honours --strict", () => {
        assert.equal(lintExitCode([], false), 0);
        assert.equal(lintExitCode([{ severity: "info", alias: "a", message: "m" }], false), 0);
        assert.equal(lintExitCode([{ severity: "warning", alias: "a", message: "m" }], false), 1);
        assert.equal(lintExitCode([{ severity: "warning", alias: "a", message: "m" }], true), 2);
        assert.equal(
            lintExitCode(
                [
                    { severity: "warning", alias: "a", message: "m" },
                    { severity: "error", alias: null, message: "e" },
                ],
                false,
            ),
            2,
        );
    });

    it("renders one finding per line plus a summary", () => {
        const md = renderFindings(
            [
                { severity: "error", alias: "a", message: "bad" },
                { severity: "info", alias: null, message: "fyi" },
            ],
            [],
            false,
        );
        assert.ok(md.includes("- error a: bad\n- info storage: fyi\n"));
        assert.ok(md.includes("1 errors, 0 warnings, 1 infos."));
    });
});

describe("collectWriteRoots", () => {
    it("collects repeated and comma-separated --write-root flags", () => {
        assert.deepEqual(
            collectWriteRoots([
                "ms365",
                "a@x",
                "--write-root",
                "/A",
                "--write-root=/B,/C",
                "--as",
                "x",
            ]),
            ["/A", "/B", "/C"],
        );
        assert.deepEqual(collectWriteRoots(["--as", "x"]), []);
    });
});
