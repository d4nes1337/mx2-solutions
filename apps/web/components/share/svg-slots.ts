// SVG-with-slots binder — the no-code handoff path for designers.
//
// A designer exports a Figma frame to SVG containing `{{token}}` placeholders in
// text nodes (e.g. <text>{{pnlPct}}</text>). At render time we substitute the
// model's values. This lets a purely visual template ship without React.
//
// Supported tokens: any scalar field on FlexCardModel plus `extra.<key>`, each
// pre-formatted for display. See AUTHORING.md for the full list.

import type { FlexCardModel } from "./types";

export function flexModelToSlots(model: FlexCardModel): Record<string, string> {
  const s = (n: number) => (n >= 0 ? "+" : "");
  const cents = (v?: number) => (v == null ? "" : `${(v * 100).toFixed(0)}¢`);

  const slots: Record<string, string> = {
    kind: model.kind,
    handle: model.handle ? `@${model.handle}` : "",
    brandLabel: model.brandLabel ?? "arima",
    title: model.title,
    subtitle: model.subtitle ?? "",
    outcome: model.outcome ?? "",
    tone: model.tone,
    pnlUsd:
      model.pnlUsd != null
        ? `${model.pnlUsd >= 0 ? "+$" : "-$"}${Math.abs(model.pnlUsd).toFixed(2)}`
        : "",
    pnlPct: model.pnlPct != null ? `${s(model.pnlPct)}${model.pnlPct.toFixed(1)}%` : "",
    entryPrice: cents(model.entryPrice),
    markPrice: cents(model.markPrice),
    size: model.size != null ? model.size.toLocaleString() : "",
    timeframe: model.timeframe ?? "",
    generatedAt: new Date(model.generatedAt).toLocaleDateString(),
  };

  for (const [k, v] of Object.entries(model.extra ?? {})) {
    if (v != null) slots[`extra.${k}`] = String(v);
  }
  return slots;
}

/** Replace `{{ token }}` placeholders in an SVG string with formatted values. */
export function fillSvgTemplate(svg: string, model: FlexCardModel): string {
  const slots = flexModelToSlots(model);
  return svg.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => slots[key] ?? "");
}
