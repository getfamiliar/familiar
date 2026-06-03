import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    checkPackagesOnPyPI,
    isSafePipRequirement,
    parseDistributionName,
} from "./PythonPackages.js";

describe("parseDistributionName", () => {
    it("strips version specifiers", () => {
        assert.equal(parseDistributionName("pandas>=2,<3"), "pandas");
        assert.equal(parseDistributionName("numpy==2.4.6"), "numpy");
    });

    it("strips extras", () => {
        assert.equal(parseDistributionName("pillow[heif]"), "pillow");
        assert.equal(parseDistributionName("uvicorn[standard]>=0.30"), "uvicorn");
    });

    it("returns plain names unchanged (including hyphens)", () => {
        assert.equal(parseDistributionName("python-docx"), "python-docx");
        assert.equal(parseDistributionName("beautifulsoup4"), "beautifulsoup4");
    });
});

describe("isSafePipRequirement", () => {
    it("accepts names, extras, and version specifiers", () => {
        for (const ok of [
            "numpy",
            "pandas>=2,<3",
            "uvicorn[standard]",
            "python-docx",
            "pkg~=1.0",
        ]) {
            assert.equal(isSafePipRequirement(ok), true, ok);
        }
    });

    it("rejects whitespace and shell metacharacters", () => {
        for (const bad of ["numpy; rm -rf /", "$(touch x)", "a b", "pkg`id`", "&&evil", ""]) {
            assert.equal(isSafePipRequirement(bad), false, bad);
        }
    });
});

describe("checkPackagesOnPyPI", () => {
    /** Build a fake fetch that maps each looked-up URL to a status / throw. */
    function fakeFetch(byName: Record<string, number | "throw">): typeof globalThis.fetch {
        return (async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            const match = url.match(/pypi\/([^/]+)\/json/);
            const name = match ? decodeURIComponent(match[1]) : "";
            const outcome = byName[name];
            if (outcome === "throw" || outcome === undefined) {
                throw new Error("network down");
            }
            return new Response(null, { status: outcome });
        }) as typeof globalThis.fetch;
    }

    it("classifies 200 as ok, 404 as not-found, other status as unreachable", async () => {
        const checks = await checkPackagesOnPyPI(["numpy", "beautifulsoup", "pandas>=2,<3"], {
            fetch: fakeFetch({ numpy: 200, beautifulsoup: 404, pandas: 503 }),
        });
        assert.deepEqual(
            checks.map((c) => [c.name, c.status]),
            [
                ["numpy", "ok"],
                ["beautifulsoup", "not-found"],
                ["pandas", "unreachable"],
            ],
        );
    });

    it("treats a thrown fetch as unreachable rather than rejecting", async () => {
        const checks = await checkPackagesOnPyPI(["numpy"], {
            fetch: fakeFetch({ numpy: "throw" }),
        });
        assert.equal(checks[0].status, "unreachable");
    });

    it("preserves the original requirement string alongside the parsed name", async () => {
        const checks = await checkPackagesOnPyPI(["pillow[heif]"], {
            fetch: fakeFetch({ pillow: 200 }),
        });
        assert.equal(checks[0].requirement, "pillow[heif]");
        assert.equal(checks[0].name, "pillow");
    });
});
