# Flex-card templates — designer authoring guide

Shareable "flex" cards (screenshot a win, post it) are decoupled into **data** and
**template** so you can design freely without touching app code.

- **Data** — every card is a `FlexCardModel` (`components/share/types.ts`). App code
  produces it; templates consume it. You never edit this.
- **Template** — a component (or an SVG) that turns a `FlexCardModel` into a picture.
  You add these.
- **Registry** — `components/share/templates/registry.ts`. Register a template and it
  shows up in the picker automatically.

Export renders your template to PNG by serializing the `<svg>` and rasterizing it on a
canvas (`components/share/export.ts`). Two rules follow from that:

1. **Use literal colours** (`#2a36ff`), not CSS `var(--…)` — the exported SVG has no
   document stylesheet.
2. **No cross-origin `<image>`** — embed images as **data-URLs** or omit them, or the
   PNG export will fail (tainted canvas).

Recommended export sizes: **1200×675** (social/OG) and **1080×1080** (square).

---

## Path A — React/SVG template (recommended)

Build a component sized to your frame and register it. Best fidelity; full control.

```tsx
// components/share/templates/NeonSquareTemplate.tsx
import type { FlexCardModel } from "../types";

export function NeonSquareTemplate({ model }: { model: FlexCardModel }) {
  const tone = model.tone === "pos" ? "#2bd98c" : "#ff4d5e";
  return (
    <svg width={1080} height={1080} viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
      {/* …your design, reading fields off `model`… */}
    </svg>
  );
}
```

```ts
// register (in registry.ts, or call registerFlexTemplate at load)
import { NeonSquareTemplate } from "./NeonSquareTemplate";
FLEX_TEMPLATES["neon-square"] = {
  id: "neon-square",
  label: "Neon · Square",
  aspect: "square",
  width: 1080,
  height: 1080,
  Component: NeonSquareTemplate,
};
```

Coming from Figma? Export the frame to SVG and paste it into the component's return,
then swap static text for `model` fields. (This repo also has Figma MCP / Code Connect
tooling if you want to generate the component from a frame.)

## Path B — SVG-with-slots (no React)

Hand off a **static SVG** whose text nodes contain `{{token}}` placeholders. We fill
them at render with `fillSvgTemplate(svg, model)` (`components/share/svg-slots.ts`).

```xml
<text x="64" y="500" font-family="JetBrains Mono" font-size="132" fill="#2bd98c">{{pnlPct}}</text>
<text x="64" y="150">{{outcome}}</text>
<text x="64" y="214">{{title}}</text>
```

### Available `{{tokens}}` (pre-formatted)

`{{handle}}` `{{brandLabel}}` `{{title}}` `{{subtitle}}` `{{outcome}}`
`{{pnlUsd}}` (`+$342.18`) `{{pnlPct}}` (`+142.8%`) `{{entryPrice}}` (`32¢`)
`{{markPrice}}` (`78¢`) `{{size}}` `{{timeframe}}` `{{generatedAt}}` `{{tone}}`
plus any custom `{{extra.<key>}}` you and the app agree on.

---

## Checklist

- [ ] Renders correctly at the declared `width`×`height`.
- [ ] Literal hex colours; system/websafe fonts (`Inter, system-ui, …`, mono for numbers).
- [ ] No external images (or data-URLs only).
- [ ] Reads real fields off `FlexCardModel`; degrades gracefully when optional fields are absent.
- [ ] Registered in `registry.ts` with a clear `label`.
