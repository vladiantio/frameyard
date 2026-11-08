import { renderPreviewPage } from "./preview-page.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const IMPORT_MAP = JSON.stringify({
  imports: {
    frameyard: "/__frameyard/framework/index.js",
    "frameyard/runtime": "/__frameyard/framework/runtime/index.js",
  },
});

export function renderTimelinePreviewHtml(timelineId: string, options: { embed?: boolean } = {}): string {
  const id = escapeHtml(timelineId);
  if (options.embed) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Frameyard timeline ${id}</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
      #stage { position: relative; width: 100%; height: 100%; overflow: hidden; background: transparent; isolation: isolate; }
      .timeline-layer { position: absolute; left: 50%; top: 50%; transform-origin: center; }
      .timeline-layer iframe, .timeline-layer video, .timeline-layer img { display: block; border: 0; }
    </style>
    <script type="importmap" data-fy-host>${IMPORT_MAP}</script>
  </head>
  <body data-timeline-id="${id}" data-embed="1">
    <div id="stage"></div>
    <script type="module" src="/__frameyard/framework/preview/timeline-main.js"></script>
  </body>
</html>`;
  }

  return renderPreviewPage({
    mode: "timeline",
    initialTimeline: timelineId,
  });
}
