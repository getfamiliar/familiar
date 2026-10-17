import type { EmittedEventDescriptor, HostContext } from "@getfamiliar/shared";
import { readMs365CalendarConfig, readMs365MailConfig } from "./Config.js";

/** Topic of the event the mail poller emits per new inbox message. */
export const MAIL_NEW_TOPIC = "mail:new:ms365";
/** Topic of the event the calendar poller emits per new calendar entry. */
export const CALENDAR_NEW_TOPIC = "calendar:new:ms365";
/** Topic of the event the calendar poller emits per substantively changed entry. */
export const CALENDAR_UPDATE_TOPIC = "calendar:update:ms365";
/**
 * Topic of the event the host's calendar service emits on ms365's behalf
 * when the periodic refresh finds an entry gone.
 */
export const CALENDAR_DELETE_TOPIC = "calendar:delete:ms365";

/**
 * The topics ms365 emits under the current config: mail only while the
 * mail feature and its poller are on, calendar only while the calendar
 * feature is on.
 *
 * @param ctx Host context, for the plugin's config slices.
 * @returns The emitted-event descriptors.
 */
export function listMs365EmittedEvents(ctx: HostContext): EmittedEventDescriptor[] {
    const out: EmittedEventDescriptor[] = [];
    const mail = readMs365MailConfig(ctx);
    if (mail.enabled && mail.polling) {
        out.push({
            topic: MAIL_NEW_TOPIC,
            description: "A new message arrived in a polled inbox.",
        });
    }
    if (readMs365CalendarConfig(ctx).enabled) {
        out.push(
            {
                topic: CALENDAR_NEW_TOPIC,
                description: "A new entry appeared in a subscribed calendar.",
            },
            {
                topic: CALENDAR_UPDATE_TOPIC,
                description: "A calendar entry's time, title, location or attendees changed.",
            },
            {
                topic: CALENDAR_DELETE_TOPIC,
                description: "The periodic full refresh found a calendar entry deleted.",
            },
        );
    }
    return out;
}
