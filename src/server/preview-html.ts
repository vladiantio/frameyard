import { renderPreviewPage } from "./preview-page.js";

export interface PreviewHtmlOptions {
  composition?: string;
  timeline?: string;
}

export function renderPreviewHtml(options: PreviewHtmlOptions = {}): string {
  return renderPreviewPage({
    mode: "composition",
    ...(options.composition !== undefined ? { initialComposition: options.composition } : {}),
    ...(options.timeline !== undefined ? { initialTimeline: options.timeline } : {}),
  });
}
