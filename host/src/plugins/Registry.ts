import cliChat from "@getfamiliar/plugin-cli-chat";
import featherless from "@getfamiliar/plugin-featherless";
import memory from "@getfamiliar/plugin-memory";
import ms365 from "@getfamiliar/plugin-ms365";
import telegram from "@getfamiliar/plugin-telegram";
import transcribeWhisper from "@getfamiliar/plugin-transcribe-whisper";
import whatsapp from "@getfamiliar/plugin-whatsapp";
import type { PluginManifest } from "@getfamiliar/shared";

/**
 * Static list of installed plugins. Each entry is the manifest
 * returned by a plugin's `definePlugin(...)` default export.
 *
 * Migration path: replace this static list with config-driven
 * dynamic loading (e.g. a `config/plugins.yml` of package names that
 * the host iterates with `await import(name)`) when manual edits
 * here become annoying. That trades compile-time safety on the
 * plugin contract for runtime flexibility.
 */
export const plugins: readonly PluginManifest[] = [
    cliChat,
    featherless,
    memory,
    ms365,
    telegram,
    transcribeWhisper,
    whatsapp,
];
