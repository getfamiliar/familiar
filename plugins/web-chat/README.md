# Web chat plugin

Chat with familiar in the web UI. The page opens as the start page of the web UI (menu entry "Chat", weight -100) and runs on the chat channel `web`.

It is a core plugin (`familiar.bundled`, always loaded). It needs the web UI (`web-ui` plugin, `webserver.enabled: true`).

## Features

On par with `familiar cli-chat`, plus what a browser does better:

- **Messages** go to the handler `chat/web.md` (topic `chat:web`, shipped as a workspace template). They run `privileged`, because only logins in `webserver.auth.users` get in.
- **Direct handler calls**: `/topic/sub …` runs that handler exactly (`/mail/draft to the dentist`). Typing `/` suggests the handlers of your workspace: ↑/↓ to pick, Tab or Enter to complete, Esc to close. An unknown path is refused before anything is sent. A call whose handler writes no chat reply gets its result text as the reply, as in cli-chat.
- **Live progress** of every message you send, like cli-chat's spinner lines: agentruns (topic, model, state, subagents), each finished step with reasoning, intermediate text and every tool call with its arguments and result. While it runs the trace is open; afterwards it collapses into "Done in N steps, M tool calls" and can be expanded again. Progress is kept for a few minutes, so a reload still shows a turn in flight.
- **Proactive messages** (`send_chat`, cron handlers) show up live when `core.defaultChatChannel` is `web`. Messages that arrived while no tab was open are part of the history.
- **Failures** arrive as a chat message ("Something went wrong processing the chat message: …"), and the trace turns red.
- **History** of the `web` channel with "Earlier messages" paging. Replies are rendered as GitHub-flavored markdown with highlighted, copyable code blocks.
- **Files in both directions.**
  - Drop files anywhere on the chat, paste them, or pick them with the paperclip. They show as removable thumbnails above the input and go with the next message, at most 20 files and 50 MB per message.
  - They land in the event's scratch folder (`/scratch/<event-id>/`), where the assistant reads them. The message text records them as `[Attached: …]`, so the chat history keeps them.
  - Every file the assistant writes directly into that folder is offered as a download under its reply. Files the user attached are shown with their message instead.
  - Hidden files (leading `.`, e.g. spilled tool results) are never offered.
  - The handler `chat/web.md` tells the assistant about this.
- `/clear` hides the transcript in this view. The assistant keeps its history, as in cli-chat. ↑/↓ on a single-line input walks through your earlier messages. Several tabs stay in sync.

Not (yet) possible:
- **No stopping a reply.** The core has no cancel for a running event yet.
- **No voice input.**
- **No streaming.** A reply appears when it is complete; the progress is visible meanwhile.

## How it works

- `src/host/ChatHub.ts` holds the one chat-bus subscription for the channel `web` and fans it out to every browser tab. The bus marks a message delivered once, so tabs must not subscribe individually. It also sends your input as events (same rules as cli-chat) and tracks their agentruns and steps.
- `src/host/ChatController.ts` is mounted by the core at `/plugins/web-chat`, behind the web UI authentication:
  - `GET /api/messages?before=&limit=` returns a history page (`ctx.chat.listMessages`);
  - `POST /api/messages {text}` sends a line and answers `{ eventId }`, or 400 `{ error }`;
  - `GET /api/handlers` returns the slash paths for autocompletion;
  - `POST /api/messages` also takes `multipart/form-data` (`text` plus `files`), checked against the limits;
  - `GET /api/files/:eventId/:name` downloads a visible scratch file. Only raster images go out inline; everything else is an attachment as `application/octet-stream`, with `nosniff` and a sandboxing CSP, so an uploaded or generated HTML/SVG file can never run as a page of the web UI's origin;
  - `GET /api/events` is the server-sent events stream (`snapshot`, `message`, `turn`, `files`), with a keep-alive every 25 s;
  - `GET /page/*` serves the built page module.
- `src/host/ChatProtocol.ts` holds the wire types, which the page imports type-only.
- `src/host/ChatFiles.ts` sanitizes upload names and keeps track of which files were uploads: the hidden manifest `.web-chat-uploads.json` in the scratch folder lists them.
- `src/page.tsx` is the page module the web UI mounts (`mount(container, context)`). Its stylesheet is scoped to the page container with `@scope` (`src/lib/scoped-style.ts`). The web UI and the page each bring a Tailwind build, and unscoped, the page's utilities would override the web UI's (e.g. `.hidden` beating the sidebar's `md:block`). For the same reason the page renders no portals: no Radix tooltips/popovers, use `title` or inline elements instead. The UI is built from the shadcn chatbot template's primitives in `src/components/ui/` (`message`, `message-scroller`, `bubble`, `trace`, `input-group`, `code-block`, `empty`, `alert`; generated by shadcn, excluded from Biome together with `lib/highlighter.tsx` and `hooks/use-highlighted-code.ts`). Our own components live in `src/components/`, the data in `src/hooks/use-chat.ts`.

## Development

In a dev run (`npm run dev -- start`) the web UI loads `src/page.tsx` from source through its Vite server, so edits show up through hot module replacement without losing the chat state. Keep component files free of non-component exports (helpers go to `src/lib/`), or an edit falls back to a full reload. Host-side changes (`src/host/`) need a daemon restart.

`npm run build` compiles the host side to `build/` and bundles the page into `build/page/page.js` (React included; shiki grammars as lazily loaded chunks).
