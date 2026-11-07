# @getfamiliar/avatar

The assistant's face for the familiar web UI and plugin pages: an [Avataaars](https://getavataaars.com/) avatar as a React component — static, animated, or as a `data:` URL.

The avatar is configured in `config.yml` under `core.assistantAvatar` (usually through the web UI's **Settings → Avatar** editor). The data model — option values, defaults, validation — lives in `@getfamiliar/shared/avatar`; this package only draws.

## Usage in a plugin page

Add the package as a **devDependency** (it is bundled into your page like React). The page's mount context carries the configured identity:

```tsx
import { Avatar, EXPRESSION_PRESETS, useTalkingMouth } from "@getfamiliar/avatar";

const mount: MountWebPage = (container, context) => {
    const root = createRoot(container);
    root.render(<Face assistant={context.assistant} />);
    return () => root.unmount();
};

function Face({ assistant, isSpeaking }: { assistant: WebAssistantIdentity; isSpeaking: boolean }) {
    const mouth = useTalkingMouth(isSpeaking);
    const expression = isSpeaking ? { ...EXPRESSION_PRESETS.speaking, mouth } : EXPRESSION_PRESETS.listening;
    return <Avatar config={assistant.avatar} expression={expression} title={assistant.name} className="size-64 rounded-3xl" />;
}
```

## API

| Export | What it does |
| --- | --- |
| `Avatar` | The live avatar. `expression` (`{ eyes?, eyebrows?, mouth? }`) overrides the configured face parts; changes crossfade. With `animated` (default `true`) it idles like someone watching: slight head sway, glances, blinks, brow lifts. Off under `prefers-reduced-motion`. `gaze` (`{ x, y }`, about ±4) pins the look, e.g. down at a laptop; the head follows a little. |
| `AvatarSvg` | The same drawing, static — for small icons. `viewBox` shows a section of the 264×280 drawing (e.g. a face close-up). |
| `EXPRESSION_PRESETS` | `listening`, `speaking`, `thinking`. They only set the mouth, so the configured eye and eyebrow style stays. |
| `useTalkingMouth(isTalking)` | A mouth that keeps changing while talking (no lip sync). Combine with `EXPRESSION_PRESETS.speaking`. |
| `avatarToSvgMarkup(config)` / `avatarToDataUrl(config)` | The avatar as SVG markup or `data:image/svg+xml` URL (favicon, `<img>`). |
| `SKIN_COLORS`, `HAIR_COLORS`, `FACIAL_HAIR_COLORS`, `FABRIC_COLORS` | Palettes per option value (editors show them as swatches). |

Several avatars can share a page, also across separately bundled plugin pages: SVG ids are unique per module copy.

## Credits

The SVG artwork is [Avataaars](https://avataaars.com/) by Pablo Stanley. The parts were ported from [fangpenlin/avataaars](https://github.com/fangpenlin/avataaars) (MIT, © 2017 Pablo Stanley, Fang-Pen Lin; see `LICENSE`), which is no longer maintained: class components became function components, lodash ids became `useSvgId`, the option selectors became plain maps.
