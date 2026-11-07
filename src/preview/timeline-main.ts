import { createTimelineHost, type TimelineHost } from "./timeline-host.js";
import { keyframeChannelsAt, keyframeMarkerFrames } from "../timeline/keyframes.js";
import { transitionGain } from "../timeline/transitions.js";
import type { TimelinePreviewAudioClip, TimelinePreviewClip, TimelinePreviewData } from "./timeline-data.js";

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

function clampFrame(frame: number, duration: number): number {
  return Math.max(0, Math.min(duration - 1, Math.floor(frame)));
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
  if (!box) {
    console.error(error);
    return;
  }
  box.hidden = false;
  box.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}

function renderDiagnostics(data: TimelinePreviewData): void {
  const box = document.getElementById("diagnostics");
  if (!box) {
    return;
  }
  const diagnostics = data.diagnostics;
  box.hidden = diagnostics.length === 0;
  box.replaceChildren(
    ...diagnostics.map((diagnostic) => {
      const line = document.createElement("div");
      line.textContent = `${diagnostic.severity}: [${diagnostic.code}] ${diagnostic.message}`;
      return line;
    }),
  );
}

function renderRuler(scale: HTMLElement, duration: number): void {
  scale.replaceChildren();
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const tick = document.createElement("span");
    tick.className = "ruler-tick";
    tick.style.left = `${fraction * 100}%`;
    tick.textContent = String(Math.round((duration - 1) * fraction));
    scale.append(tick);
  }
}

function clipClass(clip: TimelinePreviewClip): string {
  if (clip.source.kind === "composition") {
    return "clip composition";
  }
  if (clip.source.kind === "timeline") {
    return "clip nested";
  }
  if (clip.source.kind === "audio") {
    return "clip audio";
  }
  return "clip";
}

function renderTracks(data: TimelinePreviewData): void {
  const container = byId<HTMLDivElement>("tracks");
  container.replaceChildren();

  for (const track of data.tracks) {
    const row = document.createElement("div");
    row.className = "track";
    const label = document.createElement("div");
    label.className = "track-label";
    const name = track.name ?? track.id;
    label.textContent = name;
    label.title = `${track.kind} ${track.id}`;
    const lane = document.createElement("div");
    lane.className = "lane";

    const clips = data.clips.filter((clip) => clip.track === track.id).sort((left, right) => left.start - right.start);
    for (const clip of clips) {
      const element = document.createElement("div");
      element.className = clipClass(clip);
      element.style.left = `${(clip.start / data.durationInFrames) * 100}%`;
      element.style.width = `${(clip.duration / data.durationInFrames) * 100}%`;
      const blend = clip.blend ?? "normal";
      const blendLabel = blend === "normal" ? "" : ` · ${blend}`;
      const label = document.createElement("span");
      label.className = "clip-label";
      label.textContent = `${clip.id}${blendLabel}`;
      element.append(label);
      const keyframeFrames = keyframeMarkerFrames(clip.keyframes);
      for (const frame of keyframeFrames) {
        const marker = document.createElement("span");
        marker.className = "keyframe-marker";
        marker.dataset.frame = String(clip.start + frame);
        marker.style.left = `${clip.duration > 0 ? (frame / clip.duration) * 100 : 0}%`;
        const channels = keyframeChannelsAt(clip.keyframes, frame)
          .map((entry) => `${entry.channel} ${entry.value}`)
          .join(", ");
        marker.title = `Keyframe ${frame}${channels.length > 0 ? ` · ${channels}` : ""}`;
        element.append(marker);
      }
      element.title = `${clip.id} · ${clip.source.kind} · ${clip.start}..${clip.end}${blendLabel}${keyframeFrames.length > 0 ? ` · ${keyframeFrames.length} keyframe${keyframeFrames.length === 1 ? "" : "s"}` : ""}`;
      lane.append(element);
    }

    for (const transition of data.transitions.filter((entry) => entry.track === track.id)) {
      const band = document.createElement("div");
      band.className = "transition";
      band.style.left = `${(transition.start / data.durationInFrames) * 100}%`;
      band.style.width = `${((transition.end - transition.start) / data.durationInFrames) * 100}%`;
      band.title = `${transition.kind} ${transition.from} → ${transition.to} · ${transition.start}..${transition.end}`;
      lane.append(band);
    }

    row.append(label, lane);
    container.append(row);
  }
}

function fitStage(
  stage: HTMLElement,
  wrap: HTMLElement,
  viewport: HTMLElement,
  format: TimelinePreviewData["format"],
): void {
  const availableWidth = Math.max(80, viewport.clientWidth - 40);
  const availableHeight = Math.max(60, viewport.clientHeight - 40);
  const scale = Math.min(availableWidth / format.width, availableHeight / format.height);
  stage.style.transform = `scale(${scale})`;
  stage.style.transformOrigin = "top left";
  wrap.style.width = `${format.width * scale}px`;
  wrap.style.height = `${format.height * scale}px`;
}

async function main(): Promise<void> {
  const body = document.body;
  const timelineId = body.dataset.timelineId;
  if (!timelineId) {
    throw new Error("Missing timeline id.");
  }
  const data = await fetchTimelineData(timelineId);
  const stage = byId<HTMLDivElement>("stage");
  const embedded = body.dataset.embed === "1";

  if (embedded) {
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
    return;
  }

  const viewport = byId<HTMLElement>("viewport");
  const stageWrap = byId<HTMLDivElement>("stage-wrap");
  const host: TimelineHost = createTimelineHost(stage, data);
  const meta = byId<HTMLDivElement>("meta");
  const title = byId<HTMLSpanElement>("title");
  const playButton = byId<HTMLButtonElement>("play-button");
  const jumpBackButton = byId<HTMLButtonElement>("jump-back");
  const stepBackButton = byId<HTMLButtonElement>("step-back");
  const stepForwardButton = byId<HTMLButtonElement>("step-forward");
  const jumpForwardButton = byId<HTMLButtonElement>("jump-forward");
  const scrubber = byId<HTMLInputElement>("scrub");
  const frameLabel = byId<HTMLElement>("frame");
  const durationLabel = byId<HTMLElement>("duration");
  const clockLabel = byId<HTMLElement>("clock");
  const muteCheckbox = byId<HTMLInputElement>("mute");
  const volumeSlider = byId<HTMLInputElement>("volume");
  const rulerScale = byId<HTMLDivElement>("ruler-scale");
  const timelineInner = byId<HTMLDivElement>("timeline-inner");

  const audioEntries = data.audioClips.map((clip: TimelinePreviewAudioClip) => {
    const audio = new Audio(clip.url);
    audio.preload = "auto";
    audio.volume = clip.volume;
    return { clip, audio };
  });
  renderTracks(data);
  renderRuler(rulerScale, data.durationInFrames);
  const fps = data.format.fps;
  const framesPerSecond = Math.max(1, Math.round(fps));
  const duration = data.durationInFrames;
  let currentFrame = 0;
  let playing = false;
  let animationFrame = 0;
  let playStartFrame = 0;
  let playStartClock = 0;
  let seeking = false;
  let pendingFrame: number | null = null;
  let masterVolume = Number(volumeSlider.value) || 0.8;
  let muted = false;

  title.textContent = data.timeline;
  meta.textContent = `${data.format.width}×${data.format.height} · ${fps} fps · ${duration} frames · ${(duration / fps).toFixed(2)}s`;
  document.title = `${data.timeline} — Frameyard Timeline`;
  scrubber.max = String(Math.max(0, duration - 1));
  durationLabel.textContent = String(duration);

  let activeAudio = new Set<HTMLAudioElement>();

  const updateAudio = (forceSeek: boolean): void => {
    const nextActive = new Set<HTMLAudioElement>();
    for (const { clip, audio } of audioEntries) {
      // A composition's embedded audio without data-fy-duration is mapped to
      // the end of its timeline clip. Stop at the end of the source instead of
      // restarting it for the rest of that window.
      const remainingSourceDuration = Number.isFinite(audio.duration)
        ? Math.max(0, audio.duration - clip.trimStart)
        : Number.POSITIVE_INFINITY;
      const clipDuration =
        clip.trimDuration === undefined
          ? remainingSourceDuration
          : Math.min(clip.trimDuration, remainingSourceDuration);
      const endFrame = Number.isFinite(clipDuration) ? clip.startFrame + clipDuration * fps : Number.POSITIVE_INFINITY;
      const active = currentFrame >= clip.startFrame && currentFrame < endFrame;
      if (active) {
        nextActive.add(audio);
      }
      const wasActive = activeAudio.has(audio);
      const desired = clip.trimStart + Math.max(0, (currentFrame - clip.startFrame) / fps);
      const envelopeGain = (clip.envelopes ?? []).reduce(
        (gain, envelope) =>
          gain *
          transitionGain(
            {
              start: envelope.startFrame,
              end: envelope.endFrame,
              ...(envelope.easing !== undefined ? { easing: envelope.easing } : {}),
            },
            currentFrame,
            envelope.role,
          ),
        1,
      );
      audio.volume = Math.max(0, Math.min(1, clip.volume * envelopeGain * masterVolume * (muted ? 0 : 1)));
      if (forceSeek || !playing) {
        if (active && Number.isFinite(desired)) {
          audio.currentTime = desired;
        }
      }
      if (playing && active) {
        if (audio.paused) {
          // Re-entering the window restarts an ended source; staying inside it
          // leaves an ended source stopped.
          const needsSeek = !wasActive || Math.abs(audio.currentTime - desired) > 0.25;
          if (needsSeek) {
            audio.currentTime = desired;
          }
          if (needsSeek || !audio.ended) {
            void audio.play().catch(() => undefined);
          }
        }
      } else {
        audio.pause();
      }
    }
    activeAudio = nextActive;
  };

  const updateUi = (): void => {
    frameLabel.textContent = String(currentFrame);
    scrubber.value = String(currentFrame);
    clockLabel.textContent = `${(currentFrame / fps).toFixed(2)}s`;
    const fraction = duration <= 1 ? 0 : currentFrame / (duration - 1);
    scrubber.style.setProperty("--progress", `${fraction * 100}%`);
    timelineInner.style.setProperty("--playhead-factor", String(fraction));
  };

  const renderFrame = async (target: number): Promise<void> => {
    if (seeking) {
      const next = clampFrame(target, duration);
      if (next !== currentFrame) {
        currentFrame = next;
        pendingFrame = next;
        updateUi();
      }
      return;
    }
    seeking = true;
    const requested = clampFrame(target, duration);
    currentFrame = requested;
    updateUi();
    let failed = false;
    try {
      await host.seek(requested);
    } catch (error) {
      failed = true;
      playing = false;
      pendingFrame = null;
      updateAudio(true);
      showError(error);
    } finally {
      seeking = false;
    }
    updateAudio(!playing);
    if (!failed && pendingFrame !== null) {
      const next = pendingFrame;
      pendingFrame = null;
      if (next !== requested) {
        await renderFrame(next);
      }
    }
  };

  const stopPlayback = (): void => {
    playing = false;
    cancelAnimationFrame(animationFrame);
    playButton.innerHTML = "&#9654;";
    updateAudio(false);
  };

  const loop = (): void => {
    if (!playing) {
      return;
    }
    const target = playStartFrame + Math.floor(((performance.now() - playStartClock) / 1000) * fps);
    if (target >= duration - 1) {
      currentFrame = duration - 1;
      playing = false;
      playButton.innerHTML = "&#9654;";
      updateUi();
      void renderFrame(currentFrame);
      updateAudio(false);
      return;
    }
    if (target !== currentFrame) {
      void renderFrame(target);
    }
    animationFrame = requestAnimationFrame(loop);
  };

  const setPlaying = (value: boolean): void => {
    if (value) {
      if (playing) {
        return;
      }
      if (currentFrame >= duration - 1) {
        currentFrame = 0;
        void renderFrame(0);
      }
      playing = true;
      playStartFrame = currentFrame;
      playStartClock = performance.now();
      playButton.innerHTML = "&#10074;&#10074;";
      updateAudio(true);
      animationFrame = requestAnimationFrame(loop);
    } else {
      stopPlayback();
    }
  };

  const stepFrame = (delta: number): void => {
    stopPlayback();
    const target = clampFrame(currentFrame + delta, duration);
    if (target !== currentFrame) {
      void renderFrame(target);
    }
  };

  for (const marker of document.querySelectorAll<HTMLElement>(".keyframe-marker")) {
    marker.addEventListener("click", (event) => {
      event.stopPropagation();
      const frame = Number(marker.dataset.frame);
      if (!Number.isFinite(frame)) {
        return;
      }
      stopPlayback();
      void renderFrame(frame);
    });
  }

  const isTextEntry = (target: EventTarget | null): boolean => {
    // Keys forwarded from layer iframes carry elements from another realm,
    // where `instanceof HTMLElement` is false.
    if (!target || typeof (target as Element).tagName !== "string") {
      return false;
    }
    const element = target as HTMLElement;
    return (
      element.isContentEditable ||
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT"
    );
  };

  const handleTransportKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) {
      return;
    }
    const frames = event.shiftKey ? framesPerSecond : 1;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepFrame(-frames);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepFrame(frames);
    }
  };

  host.setKeyHandler(handleTransportKey);
  playButton.addEventListener("click", () => setPlaying(!playing));
  stepBackButton.addEventListener("click", () => stepFrame(-1));
  stepForwardButton.addEventListener("click", () => stepFrame(1));
  jumpBackButton.addEventListener("click", () => stepFrame(-framesPerSecond));
  jumpForwardButton.addEventListener("click", () => stepFrame(framesPerSecond));
  window.addEventListener("keydown", handleTransportKey);
  scrubber.addEventListener("input", () => {
    stopPlayback();
    void renderFrame(Number(scrubber.value));
  });
  muteCheckbox.addEventListener("change", () => {
    muted = muteCheckbox.checked;
    updateAudio(true);
  });
  volumeSlider.addEventListener("input", () => {
    masterVolume = Number(volumeSlider.value);
    updateAudio(true);
  });
  window.addEventListener("resize", () => fitStage(stage, stageWrap, viewport, data.format));

  fitStage(stage, stageWrap, viewport, data.format);
  renderDiagnostics(data);
  updateUi();
  await host.load();
  await renderFrame(0);
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
