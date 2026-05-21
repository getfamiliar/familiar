import type { ConfigService, CreateEventInput, UpdateEventInput } from "@getfamiliar/shared";

/**
 * Owner of cross-provider calendar safety policy. Currently a single
 * knob: `calendar.allowAttendees`. Lifted here from the ms365 provider
 * so every future calendar backend (caldav, google, etc.) inherits the
 * gate uniformly — providers can't forget to apply it because the gate
 * runs in core before their `createEvent` / `updateEvent` is called.
 *
 * Reads:
 *
 *   - `calendar.allowAttendees` (boolean, default `false`) — when
 *     `false`, attendees handed to {@link maybeStripAttendees} /
 *     {@link maybeStripAttendeesUpdate} are silently dropped so the
 *     agent never sends meeting invitations by accident.
 */
export class CalendarSafety {
    private readonly config: ConfigService;

    constructor(config: ConfigService) {
        this.config = config;
    }

    /**
     * Apply the attendee gate to a create-event input. Returns the
     * input untouched when attendees are allowed *or* when none were
     * provided; otherwise returns a copy with `attendees: []`.
     */
    maybeStripAttendees(input: CreateEventInput): CreateEventInput {
        if (this.allowAttendees()) {
            return input;
        }
        if (!input.attendees || input.attendees.length === 0) {
            return input;
        }
        return { ...input, attendees: [] };
    }

    /**
     * Same gate as {@link maybeStripAttendees} but for update patches.
     * Distinguishes "patch doesn't mention attendees" (leave the
     * provider's current list alone) from "patch sets attendees to
     * [a, b]" (when disallowed, force to empty so the agent never sends
     * invitations by accident).
     */
    maybeStripAttendeesUpdate(input: UpdateEventInput): UpdateEventInput {
        if (this.allowAttendees()) {
            return input;
        }
        if (input.attendees === undefined) {
            return input;
        }
        return { ...input, attendees: [] };
    }

    private allowAttendees(): boolean {
        return this.config.getBool("calendar.allowAttendees", false) === true;
    }
}
