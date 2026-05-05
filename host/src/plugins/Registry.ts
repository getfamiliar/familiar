import cliChat from "cli-chat";
import type { PluginManifest } from "effective-assistant-shared";
import telegram from "telegram";
import transcribeWhisper from "transcribe-whisper";
import whatsapp from "whatsapp";

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
export const plugins: readonly PluginManifest[] = [cliChat, telegram, transcribeWhisper, whatsapp];
