/**
 * Shared height budget for the builder's two columns. The workspace panel's
 * height = canvas height + the toolbar and validation strip beside it (~92px),
 * so the panel's bottom lines up with the left column instead of overshooting
 * it (the AI tab used to look disproportionately tall). Tune both together.
 */

/** Canvas fills the viewport below the fixed chrome on desktop; fixed on mobile. */
export const CANVAS_HEIGHT_CLASS = "h-[480px] lg:h-[max(420px,calc(100vh-360px))]";

export const PANEL_HEIGHT_CLASS = "lg:h-[max(512px,calc(100vh-268px))]";
