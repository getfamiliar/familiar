# GPT voice plugin

Talk to familiar by voice. The web UI gets a menu entry "Voice" (weight -90) with a call screen in the style of a video-call app: call, mute, hang up, and an avatar that pulses while the assistant speaks (a face comes later). The voice is OpenAI's full-duplex model **GPT-Live** (`gpt-live-1`): you can interrupt it, and it keeps talking while work runs in the background.

Until its first npm release the plugin is `private` and not `familiar.bundled`; enable it by adding `@getfamiliar/plugin-gpt-voice` to `config/plugins`. It needs the web UI (`web-ui` plugin, `webserver.enabled: true`).

## Requirements

- **An OpenAI API key** in `inference.apiKeys.openai` (`familiar config set inference.apiKeys.openai`). It is read on every call, so no restart is needed. GPT-Live costs $0.05 per minute of call, billed per second; background work is billed by the assistant's own model.
- **HTTPS.** Browsers only allow the microphone on secure pages: open familiar over HTTPS, e.g. its Tailscale address (`tailscale` plugin), or on `localhost`.

Without either, the page shows what is missing instead of the call button.

## How a call works

```
Browser (Voice page)                   Host                                   OpenAI
AI SDK realtime session  ──WS──▶  /plugins/gpt-voice/socket ──▶ LiveCall ──WS──▶ /v1/live/sessions
(mic, playback, Live codec)        BrowserTransport (relay)      ├ LiveUpstream (API key)
                                                                 ├ CallTranscript → chat channel "voice"
                                                                 └ DelegationBroker → event voice:background
```

- **The browser never sees the API key.** The page runs the AI SDK's `Experimental_AbstractRealtimeSession` with the GPT-Live codec in relay mode. It speaks the OpenAI Live wire format to the plugin's WebSocket, which the core authenticates like every web UI request (plus a same-origin check). The host opens the real session with the key.
- **The host decides the session.** The page's `session.start` settings are ignored. The host starts the session with the settings from `workspace/voice/live.md`, client delegation and 24 kHz PCM audio. After that only audio and mute frames from the page are relayed; every server frame goes back to the page.
- **Background work is the normal assistant.** When GPT-Live delegates a task, it sends only an id, no task text. So each delegation becomes an event `voice:background` whose prompt is the recent conversation transcript.
  - The handler `voice/background.md` works out the request and does it with the usual tools.
  - Its result is sent back for the delegation (`session.commentary.append`), and GPT-Live says it in its own words.
  - Progress notes from `send_chat` on the channel `voice` are spoken too.
  - If the call ended before the task finished, the result goes to `core.defaultChatChannel` instead, so it is not lost.
- **Transcripts are chat history.** Every finished utterance of both sides is recorded on the chat channel `voice`, under one record-only event `voice:call` per call (created as `done`, no handler runs). So later chats know what was said on the phone.

## Customizing

Both files are shipped as workspace templates and are yours to edit:

- **`voice/live.md`** is the voice model's instructions, read at the start of every call.
  - Frontmatter `model` (default `gpt-live-1`) and `voice` (default `marin`).
  - The body is a prompt template like `PROMPT.md`: `{SOUL.md}` and other `{file.md}` includes are expanded.
  - It is not an agent handler, even though it lives in a topic folder.
  - Tell it here when to delegate. GPT-Live has no tools; delegating is how it gets anything done.
- **`voice/background.md`** is the handler of `voice:background`: how to read the transcript and how to phrase a result that will be spoken.

## Later: phone

The call core (`src/host/live/`) does not depend on the browser. `LiveCall` talks to a `CallTransport`, and the web page is just one of them (`src/host/web/BrowserTransport.ts`).

A phone line will be a second transport. OpenAI answers SIP calls itself, with G.711 audio and SRTP. The host accepts the call by webhook and attaches to the session as a sideband (`/v1/live/sessions/<id>/attach`) instead of starting it. Transcript, delegation and the `voice:background` flow stay the same.

## Development

- `npm run build` compiles the host code (`src/host` → `build/`), type-checks the page and builds it with Vite (`build/page/page.js`). In dev mode the web UI loads `src/page.tsx` from source.
- `npm test` runs the host tests (`node:test`): transcript turns, chunking of spoken results, and the full call flow against a fake OpenAI socket and a fake event bus.
