import { createTimelineHost } from "./timeline-host.js";
import type { TimelinePreviewData } from "./timeline-data.js";

interface TimelineHostApi {
  ready: Promise<void>;
  format: TimelinePreviewData["format"];
  durationInFrames: number;
  load(): Promise<void>;
  seek(frame: number): Promise<void>;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

declare global {
  interface Window {
    __fyTimeline?: TimelineHostApi;
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Timeline preview markup is missing #${id}.`);
  }
  return element as T;
}

async function fetchTimelineData(timelineId: string): Promise<TimelinePreviewData> {
  const response = await fetch(`/__frameyard/timeline/${encodeURIComponent(timelineId)}.json`, {
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `Could not load timeline data (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) {
        message = body.error.message;
      }
    } catch {
      // Keep the status message.
    }
    throw new Error(message);
  }
  return (await response.json()) as TimelinePreviewData;
}

function showError(error: unknown): void {
  if (document.body.dataset.embed === "1") {
    const message = error instanceof Error ? error.message : String(error);
    (window as Window & { __fyTimelineError?: { message: string } }).__fyTimelineError = { message };
  }
  const box = document.getElementById("error");
  const status = document.getElementById("monitor-status");
  if (status) {
    status.hidden = false;
  }
  if (!box) {
    console.error(error);
    return;
  }
  box.hidden = false;
  box.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}

async function main(): Promise<void> {
  const body = document.body;
  const timelineId = body.dataset.timelineId;
  if (!timelineId) {
    throw new Error("Missing timeline id.");
  }

  if (body.dataset.embed !== "1") {
    const { bootPreview } = await import("./app.js");
    await bootPreview();
    return;
  }

  const data = await fetchTimelineData(timelineId);
  const stage = byId<HTMLDivElement>("stage");
  stage.style.position = "absolute";
  stage.style.inset = "0";
  const host = createTimelineHost(stage, data, { background: data.background ?? "transparent" });
  window.__fyTimeline = {
    ready: host.ready,
    format: host.format,
    durationInFrames: host.durationInFrames,
    load: () => host.load(),
    seek: (frame) => host.seek(frame),
    settle: () => host.settle(),
    dispose: () => host.dispose(),
  };
}

window.addEventListener("error", (event) => {
  if (event.error) {
    showError(event.error);
  }
});
window.addEventListener("unhandledrejection", (event) => {
  showError(event.reason);
});

void main().catch(showError);
