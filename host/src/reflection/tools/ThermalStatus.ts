import { execFile as execFileCb } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** `vcgencmd` answers instantly; same budget as `df`. */
const VCGENCMD_TIMEOUT_MS = 1500;
/** A cold `powershell.exe` start through WSL interop took ~13 s in testing. */
const POWERSHELL_TIMEOUT_MS = 20_000;
/** The Pi firmware starts soft-throttling at 80 °C (hard limit 85 °C). */
const PI_SOFT_THROTTLE_CELSIUS = 80;
const PI_WARM_CELSIUS = 70;

/** Default location of Linux thermal zones. */
const THERMAL_SYSFS_DIR = "/sys/class/thermal";

/**
 * One PowerShell call that reads both CIM classes usable without admin
 * rights and prints them as compact JSON. `MSAcpi_ThermalZoneTemperature`
 * is deliberately not used — it needs elevation.
 */
const WINDOWS_THERMAL_SCRIPT = [
    "$z = @(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | Select-Object Name,HighPrecisionTemperature,PercentPassiveLimit,ThrottleReasons)",
    "$p = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation | Where-Object Name -eq '_Total' | Select-Object PercentPerformanceLimit,ProcessorFrequency",
    "[pscustomobject]@{ zones = $z; cpu = $p } | ConvertTo-Json -Depth 3 -Compress",
].join("; ");

/** Plain-language temperature and throttling lines for `system_status`. */
export interface ThermalStatus {
    readonly temperature: string;
    readonly throttling: string;
}

/**
 * Run an external program without a shell and resolve with its stdout.
 * Rejects on a non-zero exit, a timeout, or a missing binary (`ENOENT`).
 */
export type CommandRunner = (
    file: string,
    args: readonly string[],
    timeoutMs: number,
) => Promise<string>;

/** Injectable environment for {@link collectThermalStatus} (tests swap it). */
export interface ThermalProbeDeps {
    readonly run: CommandRunner;
    /** `os.release()` — contains `microsoft` under WSL. */
    readonly osRelease: string;
    /** Directory holding `thermal_zone*` entries. */
    readonly thermalSysfsDir: string;
}

const defaultDeps: ThermalProbeDeps = {
    run: async (file, args, timeoutMs) => {
        const { stdout } = await execFile(file, [...args], { timeout: timeoutMs });
        return stdout;
    },
    osRelease: os.release(),
    thermalSysfsDir: THERMAL_SYSFS_DIR,
};

/**
 * Read temperature and throttling state of the daemon host and render
 * both as plain-language text the agent can act on. Sources, first match
 * wins:
 *
 * 1. Raspberry Pi — `vcgencmd measure_temp` / `get_throttled`.
 * 2. Generic Linux — `/sys/class/thermal/thermal_zone*` (no throttling info).
 * 3. WSL2 — the Windows host's ACPI thermal zones and CPU performance
 *    limit via `powershell.exe` (WSL itself exposes no thermal zones).
 *
 * Never throws: a failing or missing source becomes an explanatory line.
 *
 * @param deps Environment probes; defaults to the real host.
 * @returns The two lines for the status table.
 */
export async function collectThermalStatus(
    deps: ThermalProbeDeps = defaultDeps,
): Promise<ThermalStatus> {
    const pi = await probeVcgencmd(deps.run);
    if (pi !== null) {
        return pi;
    }
    const zones = readLinuxThermalZones(deps.thermalSysfsDir);
    if (zones.length > 0) {
        return {
            temperature: describeLinuxZones(zones),
            throttling:
                "not reported (generic Linux has no throttling indicator; only the Raspberry Pi's vcgencmd provides one)",
        };
    }
    if (deps.osRelease.toLowerCase().includes("microsoft")) {
        return probeWindowsHost(deps.run);
    }
    return {
        temperature: "not available on this host (no vcgencmd, no Linux thermal zones, not WSL)",
        throttling: "not available on this host",
    };
}

/**
 * Raspberry Pi probe.
 *
 * @param run Command runner.
 * @returns The status, or `null` when `vcgencmd` is not installed.
 */
async function probeVcgencmd(run: CommandRunner): Promise<ThermalStatus | null> {
    let tempOutput: string;
    try {
        tempOutput = await run("vcgencmd", ["measure_temp"], VCGENCMD_TIMEOUT_MS);
    } catch (err) {
        if (isMissingBinaryError(err)) {
            return null;
        }
        const message = errorMessage(err);
        return {
            temperature: `unavailable: vcgencmd measure_temp failed (${message}); the daemon user may need to be in the "video" group`,
            throttling: "unavailable: vcgencmd failed",
        };
    }
    const celsius = parseVcgencmdTemp(tempOutput);
    const temperature =
        celsius === null
            ? `unavailable: unexpected vcgencmd output "${tempOutput.trim()}"`
            : describePiTemperature(celsius);

    let throttling: string;
    try {
        throttling = describeThrottledFlags(
            await run("vcgencmd", ["get_throttled"], VCGENCMD_TIMEOUT_MS),
        );
    } catch (err) {
        throttling = `unavailable: vcgencmd get_throttled failed (${errorMessage(err)})`;
    }
    return { temperature, throttling };
}

/**
 * Parse `vcgencmd measure_temp` output.
 *
 * @param output Raw stdout, e.g. `temp=48.3'C`.
 * @returns Degrees Celsius, or `null` when the output doesn't match.
 */
export function parseVcgencmdTemp(output: string): number | null {
    const match = /temp=(-?\d+(?:\.\d+)?)'C/.exec(output);
    return match === null ? null : Number.parseFloat(match[1]);
}

/**
 * Render a Pi SoC temperature with an assessment against the firmware's
 * throttle threshold.
 *
 * @param celsius SoC temperature.
 * @returns E.g. `48.3 °C (normal; the Pi starts throttling at 80 °C)`.
 */
export function describePiTemperature(celsius: number): string {
    const assessment =
        celsius >= PI_SOFT_THROTTLE_CELSIUS
            ? "hot"
            : celsius >= PI_WARM_CELSIUS
              ? "warm"
              : "normal";
    return `${celsius.toFixed(1)} °C SoC (${assessment}; the Pi starts throttling at ${PI_SOFT_THROTTLE_CELSIUS} °C)`;
}

/** `get_throttled` bits that describe the current state. */
const THROTTLED_NOW_BITS: ReadonlyArray<readonly [number, string]> = [
    [0, "under-voltage detected (check the power supply)"],
    [1, "ARM frequency capped"],
    [2, "CPU throttled"],
    [3, "soft temperature limit active"],
];

/** `get_throttled` sticky bits: what happened at any point since boot. */
const THROTTLED_SINCE_BOOT_BITS: ReadonlyArray<readonly [number, string]> = [
    [16, "under-voltage occurred"],
    [17, "ARM frequency capping occurred"],
    [18, "throttling occurred"],
    [19, "soft temperature limit occurred"],
];

/**
 * Translate `vcgencmd get_throttled` into plain language, separating the
 * current state (bits 0–3) from what happened since boot (bits 16–19).
 *
 * @param output Raw stdout, e.g. `throttled=0x50005`.
 * @returns A sentence like `currently: under-voltage detected (check the
 *   power supply), CPU throttled; since boot: under-voltage occurred,
 *   throttling occurred (raw 0x50005)`.
 */
export function describeThrottledFlags(output: string): string {
    const match = /throttled=(0x[0-9a-fA-F]+)/.exec(output);
    if (match === null) {
        return `unavailable: unexpected vcgencmd output "${output.trim()}"`;
    }
    const flags = Number.parseInt(match[1], 16);
    const now = THROTTLED_NOW_BITS.filter(([bit]) => (flags & (1 << bit)) !== 0).map(([, t]) => t);
    const sinceBoot = THROTTLED_SINCE_BOOT_BITS.filter(([bit]) => (flags & (1 << bit)) !== 0).map(
        ([, t]) => t,
    );
    const current = now.length === 0 ? "not throttled right now" : `currently: ${now.join(", ")}`;
    const history =
        sinceBoot.length === 0
            ? "no throttling or under-voltage since boot"
            : `since boot: ${sinceBoot.join(", ")}`;
    return `${current}; ${history} (raw ${match[1]})`;
}

/** One Linux thermal zone reading. */
export interface LinuxThermalZone {
    readonly type: string;
    readonly celsius: number;
}

/**
 * Read every `thermal_zone*` that reports a temperature.
 *
 * @param sysfsDir Usually `/sys/class/thermal`.
 * @returns Zones with a readable temperature; empty when none exist.
 */
export function readLinuxThermalZones(sysfsDir: string): LinuxThermalZone[] {
    if (!existsSync(sysfsDir)) {
        return [];
    }
    const zones: LinuxThermalZone[] = [];
    for (const name of readdirSync(sysfsDir)) {
        if (!name.startsWith("thermal_zone")) {
            continue;
        }
        const zoneDir = path.join(sysfsDir, name);
        let milliCelsius: number;
        try {
            milliCelsius = Number.parseInt(readFileSync(path.join(zoneDir, "temp"), "utf8"), 10);
        } catch {
            // Some zones exist but refuse reads (sensor powered down); skip them.
            continue;
        }
        if (!Number.isFinite(milliCelsius)) {
            continue;
        }
        let type = name;
        try {
            type = readFileSync(path.join(zoneDir, "type"), "utf8").trim() || name;
        } catch {
            // The zone name is a fine fallback label.
        }
        zones.push({ type, celsius: milliCelsius / 1000 });
    }
    return zones;
}

/**
 * Summarize Linux thermal zones as their hottest reading.
 *
 * @param zones Non-empty list of zones.
 * @returns E.g. `52.1 °C (cpu-thermal, hottest of 2 thermal zones)`.
 */
function describeLinuxZones(zones: readonly LinuxThermalZone[]): string {
    const hottest = zones.reduce((a, b) => (b.celsius > a.celsius ? b : a));
    const scope =
        zones.length === 1 ? "only thermal zone" : `hottest of ${zones.length} thermal zones`;
    return `${hottest.celsius.toFixed(1)} °C (${hottest.type}, ${scope})`;
}

/**
 * WSL2 probe: ask the Windows host through `powershell.exe`.
 *
 * @param run Command runner.
 * @returns The status; failures become `unavailable` lines.
 */
async function probeWindowsHost(run: CommandRunner): Promise<ThermalStatus> {
    try {
        const json = await run(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_THERMAL_SCRIPT],
            POWERSHELL_TIMEOUT_MS,
        );
        return parseWindowsThermalJson(json);
    } catch (err) {
        return {
            temperature: `unavailable: querying the Windows host via powershell.exe failed (${errorMessage(err)})`,
            throttling: "unavailable: powershell.exe query failed",
        };
    }
}

/** Shape of one thermal zone in the PowerShell JSON. */
interface WindowsThermalZone {
    readonly Name?: string;
    /** Tenths of a Kelvin. */
    readonly HighPrecisionTemperature?: number;
    /** 100 = no passive (thermal) throttling. */
    readonly PercentPassiveLimit?: number;
    readonly ThrottleReasons?: number;
}

/** Shape of the `_Total` processor counters in the PowerShell JSON. */
interface WindowsCpuCounters {
    readonly PercentPerformanceLimit?: number;
    readonly ProcessorFrequency?: number;
}

/**
 * Translate the PowerShell JSON (thermal zones + CPU counters) into
 * plain language. PowerShell serializes a single zone as an object
 * instead of an array; both are accepted.
 *
 * @param json Stdout of {@link WINDOWS_THERMAL_SCRIPT}.
 * @returns Temperature and throttling lines.
 */
export function parseWindowsThermalJson(json: string): ThermalStatus {
    let parsed: { zones?: unknown; cpu?: unknown };
    try {
        parsed = JSON.parse(json) as { zones?: unknown; cpu?: unknown };
    } catch {
        return {
            temperature: `unavailable: unexpected powershell.exe output "${json.trim().slice(0, 200)}"`,
            throttling: "unavailable: unexpected powershell.exe output",
        };
    }
    const rawZones = Array.isArray(parsed.zones)
        ? parsed.zones
        : parsed.zones
          ? [parsed.zones]
          : [];
    const zones = (rawZones as WindowsThermalZone[]).filter(
        (z) => typeof z.HighPrecisionTemperature === "number" && z.HighPrecisionTemperature > 0,
    );
    const cpu = (parsed.cpu ?? null) as WindowsCpuCounters | null;
    return {
        temperature: describeWindowsZones(zones),
        throttling: describeWindowsThrottling(zones, cpu),
    };
}

/**
 * Render the Windows thermal zones' hottest and coolest reading.
 *
 * @param zones Zones with a positive temperature.
 * @returns E.g. `44.8 °C hottest (\_SB.TZ07), 31.4 °C coolest across 11
 *   ACPI thermal zones of the Windows host (board/chassis sensors, not a
 *   CPU core sensor)`.
 */
function describeWindowsZones(zones: readonly WindowsThermalZone[]): string {
    if (zones.length === 0) {
        return "unavailable: the Windows host reports no ACPI thermal zone temperatures";
    }
    const celsius = (z: WindowsThermalZone): number =>
        (z.HighPrecisionTemperature ?? 0) / 10 - 273.15;
    const hottest = zones.reduce((a, b) => (celsius(b) > celsius(a) ? b : a));
    const coolest = zones.reduce((a, b) => (celsius(b) < celsius(a) ? b : a));
    const source =
        "ACPI thermal zone" +
        (zones.length === 1 ? "" : "s") +
        " of the Windows host (board/chassis sensors, not a CPU core sensor)";
    if (zones.length === 1) {
        return `${celsius(hottest).toFixed(1)} °C (${hottest.Name ?? "zone"}; ${source})`;
    }
    return `${celsius(hottest).toFixed(1)} °C hottest (${hottest.Name ?? "zone"}), ${celsius(coolest).toFixed(1)} °C coolest across ${zones.length} ${source}`;
}

/**
 * Render thermal throttling (per zone) and the CPU performance cap.
 *
 * @param zones Thermal zones.
 * @param cpu `_Total` processor counters, or `null` when unavailable.
 * @returns E.g. `no thermal throttling; CPU performance capped at 88 %
 *   by firmware/power policy (e.g. battery saver), not thermal; current
 *   CPU frequency 1859 MHz`.
 */
function describeWindowsThrottling(
    zones: readonly WindowsThermalZone[],
    cpu: WindowsCpuCounters | null,
): string {
    const parts: string[] = [];
    const throttledZones = zones.filter(
        (z) =>
            (typeof z.PercentPassiveLimit === "number" && z.PercentPassiveLimit < 100) ||
            (typeof z.ThrottleReasons === "number" && z.ThrottleReasons !== 0),
    );
    if (throttledZones.length === 0) {
        parts.push("no thermal throttling");
    } else {
        const details = throttledZones
            .map(
                (z) =>
                    `${z.Name ?? "zone"} passive limit ${z.PercentPassiveLimit ?? "?"} %, throttle reason code ${z.ThrottleReasons ?? "?"}`,
            )
            .join("; ");
        parts.push(`THERMALLY THROTTLED (${details})`);
    }
    if (cpu === null || typeof cpu.PercentPerformanceLimit !== "number") {
        parts.push("CPU performance limit unknown");
    } else if (cpu.PercentPerformanceLimit < 100) {
        parts.push(
            `CPU performance capped at ${cpu.PercentPerformanceLimit} %` +
                (throttledZones.length === 0
                    ? " by firmware/power policy (e.g. battery saver), not thermal"
                    : ""),
        );
    } else {
        parts.push("CPU performance not capped");
    }
    if (cpu !== null && typeof cpu.ProcessorFrequency === "number") {
        parts.push(`current CPU frequency ${cpu.ProcessorFrequency} MHz`);
    }
    return parts.join("; ");
}

/**
 * `true` when a spawn failed because the binary doesn't exist.
 *
 * @param err Whatever the runner rejected with.
 * @returns Whether the error is `ENOENT`.
 */
function isMissingBinaryError(err: unknown): boolean {
    return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Extract a printable message from an unknown error.
 *
 * @param err Anything thrown.
 * @returns The message text.
 */
function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
