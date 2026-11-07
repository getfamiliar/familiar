import type { EmittedEventDescriptor } from "@getfamiliar/shared";
import { CHAT_COMPACTION_TOPIC } from "../chat/ChatCompactor.js";
import {
    WORKSPACE_APPLY_NOTE_TOPIC,
    WORKSPACE_MERGE_FILE_TOPIC,
} from "../workspace/WorkspaceMergeCoordinator.js";

/**
 * Event topics the host itself emits, independent of any plugin. Listed
 * by `familiar events list-topics` next to the plugins' `getEmittedEvents`
 * declarations. Cron and deferred `schedule_subagent` events are not
 * here: their topics come from the workspace / the agent, not the host.
 */
export const CORE_EMITTED_EVENTS: readonly EmittedEventDescriptor[] = [
    {
        topic: CHAT_COMPACTION_TOPIC,
        isExactTopic: true,
        description:
            "The chat history grew past the compaction threshold and should be summarized.",
    },
    {
        topic: WORKSPACE_MERGE_FILE_TOPIC,
        isExactTopic: true,
        description:
            "After a daemon start: one workspace file that both its template and the user changed needs merging (one event per file).",
    },
    {
        topic: WORKSPACE_APPLY_NOTE_TOPIC,
        isExactTopic: true,
        description:
            "After a daemon start: one new workspace update note needs applying (one event per note).",
    },
];
