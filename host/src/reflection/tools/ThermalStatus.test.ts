import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    type CommandRunner,
    collectThermalStatus,
    describeThrottledFlags,
    parseVcgencmdTemp,
    parseWindowsThermalJson,
    readLinuxThermalZones,
} from "./ThermalStatus.js";

/** Thermal zone + CPU counters as measured on a Surface under WSL2. */
const SURFACE_JSON = JSON.stringify({
    zones: [
        {
            Name: "\\_SB.TZ0B",
            HighPrecisionTemperature: 3088,
            PercentPassiveLimit: 100,
            ThrottleReasons: 0,
        },
        {
            Name: "\\_SB.TZ07",
            HighPrecisionTemperature: 3179,
            PercentPassiveLimit: 100,
            ThrottleReasons: 0,
        },
        {
            Name: "\\_SB.TZ05",
            HighPrecisionTemperature: 3046,
            PercentPassiveLimit: 100,
            ThrottleReasons: 0,
        },
        {
            Name: "\\TPOL",
            HighPrecisionTemperature: 0,
            PercentPassiveLimit: 100,
            ThrottleReasons: 0,
        },
    ],
    cpu: { PercentPerformanceLimit: 88, ProcessorFrequency: 1859 },
});

/** Runner that fails every call as if the binary were missing. */
const missingBinaries: CommandRunner = async (file) => {
    throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
};

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-thermal-"));
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

describe("parseVcgencmdTemp", () => {
    it("parses the temperature", () => {
        assert.equal(parseVcgencmdTemp("temp=48.3'C\n"), 48.3);
    });

    it("returns null for unexpected output", () => {
        assert.equal(parseVcgencmdTemp("VCHI initialization failed"), null);
    });
});

describe("describeThrottledFlags", () => {
    it("reports a clean state", () => {
        assert.equal(
            describeThrottledFlags("throttled=0x0\n"),
            "not throttled right now; no throttling or under-voltage since boot (raw 0x0)",
        );
    });

    it("separates past events from the current state", () => {
        assert.equal(
            describeThrottledFlags("throttled=0x50000"),
            "not throttled right now; since boot: under-voltage occurred, throttling occurred (raw 0x50000)",
        );
    });

    it("names active under-voltage and throttling", () => {
        assert.equal(
            describeThrottledFlags("throttled=0x50005"),
            "currently: under-voltage detected (check the power supply), CPU throttled; " +
                "since boot: under-voltage occurred, throttling occurred (raw 0x50005)",
        );
    });

    it("names the soft temperature limit", () => {
        assert.match(
            describeThrottledFlags("throttled=0x80008"),
            /currently: soft temperature limit active; since boot: soft temperature limit occurred/,
        );
    });
});

describe("parseWindowsThermalJson", () => {
    it("summarizes zones and flags a non-thermal performance cap", () => {
        const status = parseWindowsThermalJson(SURFACE_JSON);
        assert.match(
            status.temperature,
            /^44\.8 °C hottest \(\\_SB\.TZ07\), 31\.5 °C coolest across 3 ACPI thermal zones/,
        );
        assert.equal(
            status.throttling,
            "no thermal throttling; CPU performance capped at 88 % by firmware/power policy (e.g. battery saver), not thermal; current CPU frequency 1859 MHz",
        );
    });

    it("reports thermal throttling from the passive limit", () => {
        const status = parseWindowsThermalJson(
            JSON.stringify({
                zones: [
                    {
                        Name: "\\_SB.TZ01",
                        HighPrecisionTemperature: 3631,
                        PercentPassiveLimit: 60,
                        ThrottleReasons: 1,
                    },
                ],
                cpu: { PercentPerformanceLimit: 60, ProcessorFrequency: 900 },
            }),
        );
        assert.match(
            status.throttling,
            /^THERMALLY THROTTLED \(\\_SB\.TZ01 passive limit 60 %, throttle reason code 1\); CPU performance capped at 60 %; /,
        );
    });

    it("accepts a single zone serialized as an object", () => {
        const status = parseWindowsThermalJson(
            JSON.stringify({
                zones: {
                    Name: "\\_SB.TZ01",
                    HighPrecisionTemperature: 3132,
                    PercentPassiveLimit: 100,
                    ThrottleReasons: 0,
                },
                cpu: null,
            }),
        );
        assert.match(
            status.temperature,
            /^40\.1 °C \(\\_SB\.TZ01; ACPI thermal zone of the Windows host/,
        );
        assert.equal(status.throttling, "no thermal throttling; CPU performance limit unknown");
    });
});

describe("readLinuxThermalZones", () => {
    it("reads temperature and type of each zone", () => {
        mkdirSync(path.join(scratch, "thermal_zone0"));
        writeFileSync(path.join(scratch, "thermal_zone0", "temp"), "52123\n");
        writeFileSync(path.join(scratch, "thermal_zone0", "type"), "cpu-thermal\n");
        mkdirSync(path.join(scratch, "cooling_device0"));
        assert.deepEqual(readLinuxThermalZones(scratch), [
            { type: "cpu-thermal", celsius: 52.123 },
        ]);
    });
});

describe("collectThermalStatus", () => {
    it("prefers vcgencmd on a Raspberry Pi", async () => {
        const run: CommandRunner = async (_file, args) =>
            args[0] === "measure_temp" ? "temp=81.0'C\n" : "throttled=0x80008\n";
        const status = await collectThermalStatus({
            run,
            osRelease: "6.6.31+rpt-rpi-2712",
            thermalSysfsDir: scratch,
        });
        assert.match(status.temperature, /^81\.0 °C SoC \(hot;/);
        assert.match(status.throttling, /^currently: soft temperature limit active/);
    });

    it("falls back to Linux thermal zones without vcgencmd", async () => {
        mkdirSync(path.join(scratch, "thermal_zone0"));
        writeFileSync(path.join(scratch, "thermal_zone0", "temp"), "45000\n");
        const status = await collectThermalStatus({
            run: missingBinaries,
            osRelease: "6.8.0-generic",
            thermalSysfsDir: scratch,
        });
        assert.equal(status.temperature, "45.0 °C (thermal_zone0, only thermal zone)");
        assert.match(status.throttling, /^not reported/);
    });

    it("asks the Windows host under WSL", async () => {
        const run: CommandRunner = async (file) => {
            if (file === "powershell.exe") {
                return SURFACE_JSON;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        };
        const status = await collectThermalStatus({
            run,
            osRelease: "6.18.33.2-microsoft-standard-WSL2",
            thermalSysfsDir: path.join(scratch, "absent"),
        });
        assert.match(status.temperature, /^44\.8 °C hottest/);
    });

    it("explains when no source exists", async () => {
        const status = await collectThermalStatus({
            run: missingBinaries,
            osRelease: "6.8.0-generic",
            thermalSysfsDir: path.join(scratch, "absent"),
        });
        assert.match(status.temperature, /^not available on this host/);
    });
});
