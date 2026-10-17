import type { EmittedEventDescriptor } from "@getfamiliar/shared";
import { CHAT_COMPACTION_TOPIC } from "../chat/ChatCompactor.js";

/**
 * Event topics the host itself emits, independent of any plugin. Listed
 * by `familiar events topics` next to the plugins' `getEmittedEvents`
 * declarations. Cron and deferred `schedule_subagent` events are not
 * here: their topics come from the workspace / the agent, not the host.
 */
export const CORE_EMITTED_EVENTS: readonly EmittedEventDescriptor[] = [
    {
        topic: CHAT_COMPACTION_TOPIC,
        description:
            "The chat history grew past the compaction threshold and should be summarized.",
    },
];
