// Template registry — the single extension point for shareable cards.
//
// To add a designer template: build a component `(props: { model: FlexCardModel })
// => JSX` sized to your frame (see AUTHORING.md), then register it here (or call
// `registerFlexTemplate` at module load). No app code changes required.

import type { ComponentType } from "react";
import type { FlexCardModel, FlexTemplateMeta } from "../types";
import { DEFAULT_FLEX_SIZE, DefaultFlexTemplate } from "./DefaultFlexTemplate";

export interface FlexTemplate extends FlexTemplateMeta {
  Component: ComponentType<{ model: FlexCardModel }>;
}

export const FLEX_TEMPLATES: Record<string, FlexTemplate> = {
  default: {
    id: "default",
    label: "arima · Classic",
    aspect: "social",
    width: DEFAULT_FLEX_SIZE.width,
    height: DEFAULT_FLEX_SIZE.height,
    Component: DefaultFlexTemplate,
  },
  // Designer templates go here, e.g.:
  // "neon-square": {
  //   id: "neon-square", label: "Neon · Square", aspect: "square",
  //   width: 1080, height: 1080, Component: NeonSquareTemplate,
  // },
};

export function getFlexTemplate(id?: string): FlexTemplate {
  return (id && FLEX_TEMPLATES[id]) || FLEX_TEMPLATES.default!;
}

export function listFlexTemplates(): FlexTemplate[] {
  return Object.values(FLEX_TEMPLATES);
}

export function registerFlexTemplate(template: FlexTemplate): void {
  FLEX_TEMPLATES[template.id] = template;
}
