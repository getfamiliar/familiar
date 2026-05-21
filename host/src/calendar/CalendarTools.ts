import {
    type CalendarEventRow,
    type CalendarRow,
    type CreateEventInput,
    type PluginTool,
    parseCalendarEventId,
    runJsonLinesTool,
    runJsonTool,
    ToolError,
    type UpdateEventInput,
} from "@getfamiliar/shared";
import { DateTime } from "luxon";
import type { CalendarSafety } from "./CalendarSafety.js";
import type { CalendarService } from "./CalendarService.js";
import { type AgentEventView, readCoreTimezone, renderEventForAgent } from "./EventRenderer.js";

/**
 * Inline-attachment ceiling per Graph's `fileAttachment` resource —
 * larger uploads require a `createUploadSession` flow that is out of
 * scope for v1. Other providers may relax this, but a single shared
 * cap keeps the tool surface predictable. 3MB matches Graph; we use
 * the binary form (3 × 1024 × 1024) so the bound is exact in bytes.
 */
const INLINE_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024;

/**
 * Settings the calendar tools need beyond `CalendarService`.
 *
 * - `scratchDir` — absolute host path of `tmp/scratch/` (matches
 *   `Bootstrap.scratchDir`). Used by `cal_create_event` and
 *   `cal_attach_file` when the agent passes a `scratch_path` instead
 *   of inline base64.
 * - `safety` — cross-provider safety gate (attendee stripping today;
 *   future knobs land here as well). Applied before dispatching to a
 *   provider so every provider inherits the policy uniformly.
 */
export interface CalendarToolsDeps {
    readonly scratchDir: string;
    readonly safety: CalendarSafety;
}

/**
 * Build the core `cal_*` agent tools — plugin-agnostic read/write
 * surface over the calendar cache. Registered host-side under the
 * `core` DSL group; `tools: core` in a handler's frontmatter pulls
 * them in.
 *
 * Read tools (`cal_get_events`, `cal_get_event`) hit the cache
 * directly. Write tools (`cal_create_event`, `cal_attach_file`,
 * `cal_get_event_attachments`) dispatch through
 * {@link CalendarService.registry} to whichever provider owns the
 * target calendar.
 */
export function buildCalendarTools(
    service: CalendarService,
    deps: CalendarToolsDeps,
): readonly PluginTool[] {
    return [
        getEventsTool(service),
        getEventTool(service),
        getEventAttachmentsTool(service),
        createEventTool(service, deps),
        updateEventTool(service, deps),
        deleteEventTool(service),
        attachFileTool(service, deps),
    ];
}

interface GetEventsArgs {
    readonly day?: string;
    readonly from_day?: string;
    readonly to_day?: string;
    readonly calendar_id?: string;
}

function getEventsTool(service: CalendarService): PluginTool<GetEventsArgs, string> {
    return {
        name: "cal_get_events",
        description:
            "List calendar events for a single local day or a range of local days, interpreted " +
            'in your timezone (`core.timezone`). Use `day: "YYYY-MM-DD"` for one day, or ' +
            "`from_day` / `to_day` (both inclusive, YYYY-MM-DD) for a range. Optional " +
            "`calendar_id` accepts a calendar name ('Work') or qualified form ('ms365:Work'). " +
            "Returns a JSONL string with one compact summary per line; `start` and `end` are " +
            "wall-clock strings in your local timezone.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                day: {
                    type: "string",
                    description: "YYYY-MM-DD local day; events overlapping this day are returned.",
                },
                from_day: {
                    type: "string",
                    description: "Inclusive lower-bound local day (YYYY-MM-DD).",
                },
                to_day: {
                    type: "string",
                    description: "Inclusive upper-bound local day (YYYY-MM-DD).",
                },
                calendar_id: {
                    type: "string",
                    description: "Optional calendar reference (name or 'pluginId:name').",
                },
            },
        },
        execute: (args, callCtx) =>
            runJsonLinesTool(async () => {
                const coreTz = readCoreTimezone(callCtx.host.config);
                const { from, to } = resolveDayBounds(args, coreTz);
                let calendarId: string | undefined;
                if (args.calendar_id !== undefined) {
                    const cal = await service.resolveCalendarRef(args.calendar_id);
                    if (!cal) {
                        throw new ToolError(
                            "UnknownCalendar",
                            `unknown calendar reference "${args.calendar_id}" — ` +
                                "run `./cli.sh ms365 cal list` to see available calendars.",
                        );
                    }
                    calendarId = cal.id;
                }
                const rows = await service.findEvents({ calendarId, from, to });
                return rows.map((r) => {
                    const v = renderEventForAgent(r, coreTz);
                    return {
                        id: v.id,
                        subject: v.subject,
                        start: v.start,
                        end: v.end,
                        showAs: v.showAs,
                        responseStatus: v.responseStatus,
                        isAllDay: v.isAllDay,
                        location: v.location,
                    };
                });
            }, callCtx.toolRunContext),
    };
}

/**
 * Translate the agent's day-resolution local-TZ inputs into the UTC
 * half-open `[from, to)` interval that {@link CalendarService.findEvents}
 * expects. Accepts either `day` alone or `from_day` + `to_day` together;
 * rejects mixed / missing combinations with an agent-readable error.
 *
 * `to_day` is **inclusive** at the user-facing layer (Mon–Wed includes
 * events on Wed), so the upper bound becomes `to_day + 1` at the
 * start-of-day in `coreTz` before converting to UTC.
 *
 * Exported for unit testing.
 */
export function resolveDayBounds(
    args: GetEventsArgs,
    coreTz: string,
): { from: string; to: string } {
    const hasDay = typeof args.day === "string" && args.day.length > 0;
    const hasFromDay = typeof args.from_day === "string" && args.from_day.length > 0;
    const hasToDay = typeof args.to_day === "string" && args.to_day.length > 0;
    if (hasDay && (hasFromDay || hasToDay)) {
        throw new Error("pass either `day` or `from_day`+`to_day`, not both");
    }
    if (!hasDay && hasFromDay !== hasToDay) {
        throw new Error("`from_day` and `to_day` must be set together");
    }
    if (!hasDay && !hasFromDay) {
        throw new Error("provide `day` (single day) or `from_day`+`to_day` (range)");
    }
    const fromDay = hasDay ? (args.day as string) : (args.from_day as string);
    const toDay = hasDay ? (args.day as string) : (args.to_day as string);
    const lower = DateTime.fromISO(fromDay, { zone: coreTz }).startOf("day");
    if (!lower.isValid) {
        throw new Error(`invalid day "${fromDay}" — expected YYYY-MM-DD`);
    }
    const upper = DateTime.fromISO(toDay, { zone: coreTz }).startOf("day").plus({ days: 1 });
    if (!upper.isValid) {
        throw new Error(`invalid day "${toDay}" — expected YYYY-MM-DD`);
    }
    if (upper <= lower) {
        throw new Error(`from_day "${fromDay}" must not be after to_day "${toDay}"`);
    }
    const from = lower.toUTC().toISO({ suppressMilliseconds: true });
    const to = upper.toUTC().toISO({ suppressMilliseconds: true });
    if (!from || !to) {
        throw new Error("failed to convert day bounds to UTC");
    }
    return { from, to };
}

interface GetEventArgs {
    readonly id: string;
}

function getEventTool(service: CalendarService): PluginTool<GetEventArgs, object> {
    return {
        name: "cal_get_event",
        description:
            "Fetch the full row of one calendar event by id, including body, location, " +
            "attendees, and attachment metadata. `start` and `end` are wall-clock strings in " +
            "your local timezone (`core.timezone`). Bytes for attachments are fetched " +
            "separately via cal_get_event_attachments.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string" } },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const event = await service.getEvent(args.id);
                if (!event) {
                    throw new ToolError("EventNotFound", `calendar event "${args.id}" not found`);
                }
                const coreTz = readCoreTimezone(callCtx.host.config);
                return { event: renderEventForAgent(event, coreTz) };
            }, callCtx.toolRunContext),
    };
}

function getEventAttachmentsTool(service: CalendarService): PluginTool<GetEventArgs, object> {
    return {
        name: "cal_get_event_attachments",
        description:
            "Download every attachment of one calendar event into this agentrun's scratch " +
            "directory (`/scratch/<event-id>/`). Returns the absolute paths.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string" } },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const event = await service.getEvent(args.id);
                if (!event) {
                    throw new ToolError("EventNotFound", `calendar event "${args.id}" not found`);
                }
                const calendar = await calendarFor(service, event);
                const provider = service.registry.forCalendar(calendar);
                const { realId } = parseCalendarEventId(event.id);
                const fetched = await provider.getAttachments(calendar, realId);
                if (fetched.length === 0) {
                    return { paths: [] as readonly string[] };
                }
                const used = new Set<string>();
                const files = fetched.map((f) => ({
                    name: dedupName(f.name, used),
                    contents: f.contents,
                }));
                const paths = await callCtx.host.scratch.addFiles(callCtx.event.id, files);
                return { paths };
            }, callCtx.toolRunContext),
    };
}

interface AttendeeInput {
    readonly email: string;
    readonly name?: string;
}

interface CreateEventArgs {
    readonly subject: string;
    readonly start: string;
    readonly end: string;
    readonly body?: string;
    readonly location?: string;
    readonly attendees?: ReadonlyArray<string | AttendeeInput>;
    readonly showAs?: CreateEventInput["showAs"];
    readonly sensitivity?: CreateEventInput["sensitivity"];
    readonly reminderMinutesBeforeStart?: number;
    readonly attachments?: ReadonlyArray<
        { name: string; contents_b64: string } | { name: string; scratch_path: string }
    >;
    readonly calendar_id?: string;
    readonly is_videocall?: boolean;
}

function createEventTool(
    service: CalendarService,
    deps: CalendarToolsDeps,
): PluginTool<CreateEventArgs, object> {
    return {
        name: "cal_create_event",
        description:
            "Create a calendar event. Required: subject, start, end (both wall-clock in your " +
            'local timezone, e.g. "2026-05-21T10:00:00" — no `Z`, no offset suffix). ' +
            "Optional: body (markdown), location, attendees (bare email or {email, name?}), " +
            "showAs (busy|free|tentative|oof|workingElsewhere; default busy), sensitivity, " +
            "reminderMinutesBeforeStart, attachments (≤3MB inline), calendar_id (name or " +
            "'pluginId:name'; defaults to core.defaultCalendar), is_videocall (provider hint).",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["subject", "start", "end"],
            properties: {
                subject: { type: "string" },
                start: {
                    type: "string",
                    description:
                        "Local wall-clock start (YYYY-MM-DDTHH:mm:ss) in your `core.timezone`.",
                },
                end: {
                    type: "string",
                    description:
                        "Local wall-clock end (YYYY-MM-DDTHH:mm:ss) in your `core.timezone`.",
                },
                body: { type: "string", description: "Markdown body (rendered to HTML)." },
                location: { type: "string" },
                attendees: {
                    type: "array",
                    items: {
                        oneOf: [
                            { type: "string", description: "Bare email address." },
                            {
                                type: "object",
                                additionalProperties: false,
                                required: ["email"],
                                properties: {
                                    email: { type: "string" },
                                    name: { type: "string" },
                                },
                            },
                        ],
                    },
                },
                showAs: {
                    type: "string",
                    enum: ["busy", "free", "tentative", "oof", "workingElsewhere"],
                },
                sensitivity: {
                    type: "string",
                    enum: ["normal", "personal", "private", "confidential"],
                },
                reminderMinutesBeforeStart: { type: "integer", minimum: 0 },
                attachments: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["name"],
                        properties: {
                            name: { type: "string" },
                            contents_b64: { type: "string" },
                            scratch_path: { type: "string" },
                        },
                    },
                },
                calendar_id: { type: "string" },
                is_videocall: { type: "boolean" },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const calendar = await resolveTargetCalendar(service, args.calendar_id);
                const provider = service.registry.forCalendar(calendar);
                const coreTz = readCoreTimezone(callCtx.host.config);
                const notes: string[] = [];
                const input: CreateEventInput = {
                    subject: args.subject,
                    start: normalizeAgentWallClock(args.start, coreTz),
                    end: normalizeAgentWallClock(args.end, coreTz),
                    body: args.body,
                    location: args.location,
                    attendees: normaliseAttendees(args.attendees),
                    showAs: args.showAs ?? "busy",
                    sensitivity: args.sensitivity,
                    reminderMinutesBeforeStart: args.reminderMinutesBeforeStart,
                    isVideocall: args.is_videocall === true,
                };
                const safe = deps.safety.maybeStripAttendees(input);
                const attachments = await resolveAttachments(args.attachments, deps.scratchDir);
                if (attachments.dropped.length > 0) {
                    notes.push(`attachments dropped: ${attachments.dropped.join(", ")}`);
                }
                const created = await provider.createEvent(calendar, {
                    ...safe,
                    attachments: attachments.kept,
                });
                await service.addEvent(
                    {
                        id: created.id,
                        calendarId: created.calendarId,
                        seriesMasterId: created.seriesMasterId,
                        type: created.type,
                        subject: created.subject,
                        startDt: created.startDt,
                        endDt: created.endDt,
                        eventTz: created.eventTz,
                        isAllDay: created.isAllDay,
                        isCancelled: created.isCancelled,
                        showAs: created.showAs,
                        sensitivity: created.sensitivity,
                        importance: created.importance,
                        location: created.location,
                        isOnlineMeeting: created.isOnlineMeeting,
                        onlineMeetingUrl: created.onlineMeetingUrl,
                        organizerName: created.organizerName,
                        organizerEmail: created.organizerEmail,
                        responseStatus: created.responseStatus,
                        attendees: created.attendees,
                        body: created.body,
                        attachments: created.attachments,
                        scanGeneration: created.scanGeneration,
                    },
                    { seed: false },
                );
                return {
                    created: true as const,
                    event: renderEventForAgent(created, coreTz),
                    notes,
                };
            }, callCtx.toolRunContext),
    };
}

interface UpdateEventArgs {
    readonly id: string;
    readonly patch: {
        readonly subject?: string;
        readonly start?: string;
        readonly end?: string;
        readonly timezone?: string;
        readonly body?: string;
        readonly location?: string;
        readonly attendees?: ReadonlyArray<string | AttendeeInput>;
        readonly showAs?: CreateEventInput["showAs"];
        readonly sensitivity?: CreateEventInput["sensitivity"];
        readonly reminderMinutesBeforeStart?: number;
    };
}

function updateEventTool(
    service: CalendarService,
    deps: CalendarToolsDeps,
): PluginTool<UpdateEventArgs, object> {
    return {
        name: "cal_update_event",
        description:
            "Apply a partial update to an existing calendar event. `id` is the event id " +
            "returned by cal_get_events / cal_create_event. `patch` carries only the fields to " +
            "change: subject, start, end (local wall-clock in your `core.timezone`, " +
            "YYYY-MM-DDTHH:mm:ss — no Z or offset), timezone (only when authoring the event " +
            "in a non-local zone), body (markdown), location, attendees, showAs, sensitivity, " +
            "reminderMinutesBeforeStart. Fields omitted from the patch are left untouched. " +
            "Toggling videocall on/off is not supported — recreate the event instead.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id", "patch"],
            properties: {
                id: { type: "string" },
                patch: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        subject: { type: "string" },
                        start: { type: "string" },
                        end: { type: "string" },
                        timezone: { type: "string" },
                        body: { type: "string" },
                        location: { type: "string" },
                        attendees: {
                            type: "array",
                            items: {
                                oneOf: [
                                    { type: "string" },
                                    {
                                        type: "object",
                                        additionalProperties: false,
                                        required: ["email"],
                                        properties: {
                                            email: { type: "string" },
                                            name: { type: "string" },
                                        },
                                    },
                                ],
                            },
                        },
                        showAs: {
                            type: "string",
                            enum: ["busy", "free", "tentative", "oof", "workingElsewhere"],
                        },
                        sensitivity: {
                            type: "string",
                            enum: ["normal", "personal", "private", "confidential"],
                        },
                        reminderMinutesBeforeStart: { type: "integer", minimum: 0 },
                    },
                },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const existing = await service.getEvent(args.id);
                if (!existing) {
                    throw new ToolError("EventNotFound", `calendar event "${args.id}" not found`);
                }
                const calendar = await calendarFor(service, existing);
                const provider = service.registry.forCalendar(calendar);
                const coreTz = readCoreTimezone(callCtx.host.config);
                const notes: string[] = [];
                const patch: UpdateEventInput = {
                    subject: args.patch.subject,
                    start:
                        args.patch.start !== undefined
                            ? normalizeAgentWallClock(args.patch.start, coreTz)
                            : undefined,
                    end:
                        args.patch.end !== undefined
                            ? normalizeAgentWallClock(args.patch.end, coreTz)
                            : undefined,
                    timezone: args.patch.timezone,
                    body: args.patch.body,
                    location: args.patch.location,
                    attendees: normaliseAttendees(args.patch.attendees),
                    showAs: args.patch.showAs,
                    sensitivity: args.patch.sensitivity,
                    reminderMinutesBeforeStart: args.patch.reminderMinutesBeforeStart,
                };
                const safe = deps.safety.maybeStripAttendeesUpdate(patch);
                const { realId } = parseCalendarEventId(existing.id);
                const updated = await provider.updateEvent(calendar, realId, safe);
                // Persist the post-patch row. Agent-driven mutations
                // intentionally skip the standardized
                // `calendar:update:<pluginId>` emission — the agent is
                // the originator, re-notifying it would be circular.
                // `seed: true` is retained as the honest tag for the
                // call site.
                await service.addEvent(
                    {
                        id: updated.id,
                        calendarId: updated.calendarId,
                        seriesMasterId: updated.seriesMasterId,
                        type: updated.type,
                        subject: updated.subject,
                        startDt: updated.startDt,
                        endDt: updated.endDt,
                        eventTz: updated.eventTz,
                        isAllDay: updated.isAllDay,
                        isCancelled: updated.isCancelled,
                        showAs: updated.showAs,
                        sensitivity: updated.sensitivity,
                        importance: updated.importance,
                        location: updated.location,
                        isOnlineMeeting: updated.isOnlineMeeting,
                        onlineMeetingUrl: updated.onlineMeetingUrl,
                        organizerName: updated.organizerName,
                        organizerEmail: updated.organizerEmail,
                        responseStatus: updated.responseStatus,
                        attendees: updated.attendees,
                        body: updated.body,
                        attachments: updated.attachments,
                        scanGeneration: updated.scanGeneration,
                    },
                    { seed: true },
                );
                return {
                    updated: true as const,
                    event: renderEventForAgent(updated, coreTz),
                    notes,
                };
            }, callCtx.toolRunContext),
    };
}

interface DeleteEventArgs {
    readonly id: string;
}

function deleteEventTool(service: CalendarService): PluginTool<DeleteEventArgs, object> {
    return {
        name: "cal_delete_event",
        description:
            "Delete a calendar event by id. The provider is asked first; the local cache row " +
            "is removed only after the provider confirms (so a transient failure leaves the " +
            "cache untouched). No-op when the event no longer exists locally.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string" } },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const existing = await service.getEvent(args.id);
                if (!existing) {
                    throw new ToolError("EventNotFound", `calendar event "${args.id}" not found`);
                }
                const calendar = await calendarFor(service, existing);
                const provider = service.registry.forCalendar(calendar);
                const { realId } = parseCalendarEventId(existing.id);
                await provider.deleteEvent(calendar, realId);
                await service.removeEvent(existing.id);
                return { deleted: true as const };
            }, callCtx.toolRunContext),
    };
}

interface AttachFileArgs {
    readonly event_id: string;
    readonly name: string;
    readonly contents_b64?: string;
    readonly scratch_path?: string;
}

function attachFileTool(
    service: CalendarService,
    deps: CalendarToolsDeps,
): PluginTool<AttachFileArgs, object> {
    return {
        name: "cal_attach_file",
        description:
            "Attach a file to an existing calendar event. Provide either `contents_b64` " +
            "(base64-encoded inline bytes) or `scratch_path` (a `/scratch/<event-id>/...` path " +
            "the agent already has). 3MB inline ceiling per attachment.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["event_id", "name"],
            properties: {
                event_id: { type: "string" },
                name: { type: "string" },
                contents_b64: { type: "string" },
                scratch_path: { type: "string" },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const event = await service.getEvent(args.event_id);
                if (!event) {
                    throw new ToolError(
                        "EventNotFound",
                        `calendar event "${args.event_id}" not found`,
                    );
                }
                const calendar = await calendarFor(service, event);
                const provider = service.registry.forCalendar(calendar);
                const bytes = await resolveAttachmentBytes(args, deps.scratchDir);
                if (bytes.length > INLINE_ATTACHMENT_LIMIT_BYTES) {
                    throw new ToolError(
                        "AttachmentTooLarge",
                        `attachment ${args.name} is ${bytes.length} bytes; the v1 inline ` +
                            `limit is ${INLINE_ATTACHMENT_LIMIT_BYTES} bytes — large-file upload ` +
                            "sessions are not yet implemented.",
                    );
                }
                const { realId } = parseCalendarEventId(event.id);
                await provider.attachFile(calendar, realId, args.name, bytes);
                return { attached: true as const };
            }, callCtx.toolRunContext),
    };
}

/**
 * Resolve `cal_create_event`'s `calendar_id` argument, falling back to
 * `core.defaultCalendar` when omitted. Throws with a clear,
 * agent-readable message on miss / ambiguity so the failure surfaces
 * as a `ToolFailure` rather than a hang.
 */
async function resolveTargetCalendar(
    service: CalendarService,
    explicit: string | undefined,
): Promise<CalendarRow> {
    if (explicit !== undefined && explicit.length > 0) {
        const cal = await service.resolveCalendarRef(explicit);
        if (!cal) {
            throw new Error(
                `unknown calendar reference "${explicit}" — ` +
                    "run `./cli.sh ms365 cal list` to see available calendars.",
            );
        }
        return cal;
    }
    const def = await service.resolveDefaultCalendar();
    if (!def) {
        throw new Error(
            "core.defaultCalendar is unset or its target calendar has not been discovered " +
                "yet by its provider — set it in config.yml and wait for the next poll.",
        );
    }
    return def;
}

async function calendarFor(
    service: CalendarService,
    event: CalendarEventRow,
): Promise<CalendarRow> {
    const calendars = await service.listCalendars();
    const cal = calendars.find((c) => c.id === event.calendarId);
    if (!cal) {
        throw new Error(`calendar ${event.calendarId} not found for event ${event.id}`);
    }
    return cal;
}

/**
 * Coerce an agent-supplied date-time string into the local wall-clock
 * form (`YYYY-MM-DDTHH:mm:ss`, no offset) the provider expects to pair
 * with `core.timezone`. The agent is documented to pass local wall-clock,
 * but tolerant handling of `Z` / `±HH:MM` suffixes means a stray UTC
 * input gets the right meaning ("interpret in coreTz, drop the offset")
 * instead of silently being mislabelled.
 *
 * Returns the input untouched when the string already has no offset, or
 * when it can't be parsed (let the provider throw with a clearer error
 * than a generic `Invalid date`).
 */
function normalizeAgentWallClock(value: string, coreTz: string): string {
    if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)) {
        return value;
    }
    const dt = DateTime.fromISO(value, { setZone: true });
    if (!dt.isValid) {
        return value;
    }
    const local = dt.setZone(coreTz);
    return local.toISO({ suppressMilliseconds: true, includeOffset: false }) ?? value;
}

function normaliseAttendees(
    attendees: ReadonlyArray<string | AttendeeInput> | undefined,
): readonly { email: string; name?: string }[] | undefined {
    if (!attendees) {
        return undefined;
    }
    const out: { email: string; name?: string }[] = [];
    for (const entry of attendees) {
        if (typeof entry === "string") {
            if (entry.length > 0) {
                out.push({ email: entry });
            }
            continue;
        }
        if (entry && typeof entry === "object" && typeof entry.email === "string") {
            out.push(
                entry.name ? { email: entry.email, name: entry.name } : { email: entry.email },
            );
        }
    }
    return out;
}

interface ResolvedAttachments {
    readonly kept: readonly { name: string; contents: Buffer }[];
    readonly dropped: readonly string[];
}

async function resolveAttachments(
    items: CreateEventArgs["attachments"],
    scratchDir: string,
): Promise<ResolvedAttachments> {
    if (!items || items.length === 0) {
        return { kept: [], dropped: [] };
    }
    const kept: { name: string; contents: Buffer }[] = [];
    const dropped: string[] = [];
    for (const entry of items) {
        try {
            const bytes = await readAttachment(entry, scratchDir);
            if (bytes.length > INLINE_ATTACHMENT_LIMIT_BYTES) {
                dropped.push(`${entry.name} (>${INLINE_ATTACHMENT_LIMIT_BYTES} bytes)`);
                continue;
            }
            kept.push({ name: entry.name, contents: bytes });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            dropped.push(`${entry.name} (${message})`);
        }
    }
    return { kept, dropped };
}

async function readAttachment(
    entry: { name: string; contents_b64?: string } | { name: string; scratch_path?: string },
    scratchDir: string,
): Promise<Buffer> {
    if ("contents_b64" in entry && typeof entry.contents_b64 === "string") {
        return Buffer.from(entry.contents_b64, "base64");
    }
    if ("scratch_path" in entry && typeof entry.scratch_path === "string") {
        return readFromScratch(entry.scratch_path, scratchDir);
    }
    throw new Error("attachment requires either contents_b64 or scratch_path");
}

async function resolveAttachmentBytes(args: AttachFileArgs, scratchDir: string): Promise<Buffer> {
    if (typeof args.contents_b64 === "string") {
        return Buffer.from(args.contents_b64, "base64");
    }
    if (typeof args.scratch_path === "string") {
        return readFromScratch(args.scratch_path, scratchDir);
    }
    throw new Error("cal_attach_file requires contents_b64 or scratch_path");
}

/**
 * Read bytes from a `/scratch/<event-id>/<name>` path the agent has.
 * The path is the agent-container-visible absolute path; on the host
 * it maps to `<scratchDir>/<event-id>/<name>` (same `tmp/scratch/`
 * bind mount). Rejects `..` segments and paths outside `/scratch/`.
 */
async function readFromScratch(scratchPath: string, scratchDir: string): Promise<Buffer> {
    if (!scratchPath.startsWith("/scratch/")) {
        throw new Error(`scratch_path must start with /scratch/ (got ${scratchPath})`);
    }
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const trimmed = scratchPath.replace(/^\/scratch\//, "");
    if (trimmed.includes("..")) {
        throw new Error(`scratch_path must not contain '..' segments: ${scratchPath}`);
    }
    const absolute = path.join(scratchDir, trimmed);
    return fs.readFile(absolute);
}

function dedupName(name: string, used: Set<string>): string {
    const cleaned = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
    let candidate = cleaned.length > 0 ? cleaned : "attachment";
    if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
    }
    const dot = candidate.lastIndexOf(".");
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
    const ext = dot > 0 ? candidate.slice(dot) : "";
    for (let i = 2; i < 1000; i++) {
        candidate = `${stem} (${i})${ext}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
    throw new Error("could not dedupe attachment name");
}
