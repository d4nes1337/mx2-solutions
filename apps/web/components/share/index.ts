// Public surface of the flex-card share module. Wired into the portfolio in M3.

export type { FlexCardModel, FlexCardKind, FlexTone, FlexAspect, FlexTemplateMeta } from "./types";
export { sampleFlexModel } from "./types";
export {
  FLEX_TEMPLATES,
  getFlexTemplate,
  listFlexTemplates,
  registerFlexTemplate,
  type FlexTemplate,
} from "./templates/registry";
export { DefaultFlexTemplate, DEFAULT_FLEX_SIZE } from "./templates/DefaultFlexTemplate";
export {
  svgNodeToPngBlob,
  flexCardFilename,
  downloadBlob,
  copyBlobToClipboard,
  canCopyImage,
  shareBlob,
  canShareImage,
} from "./export";
export { fillSvgTemplate, flexModelToSlots } from "./svg-slots";
export { flexModelFromPortfolio, flexModelFromPosition } from "./factories";
export { FlexCardSheet } from "./FlexCardSheet";
export { ShareButton } from "./ShareButton";
