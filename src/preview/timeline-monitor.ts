import type { CompositionDiagnostic } from "../index.js";
import { keyframeChannelsAt, keyframeMarkerFrames } from "../timeline/keyframes.js";
import { transitionGain } from "../timeline/transitions.js";
import { createTimelineHost, type TimelineHost } from "./timeline-host.js";
import type { TimelinePreviewAudioClip, TimelinePreviewClip, TimelinePreviewData } from "./timeline-data.js";
import type { MonitorZoom } from "./source-monitor.js";

export interface TimelineTransportElements {
  play: HTMLButtonElement;
  stepBack: HTMLButtonElement;
  stepForward: HTMLButtonElement;
  jumpBack: HTMLButtonElement;
  jumpForward: HTMLButtonElement;
  scrub: HTMLInputElement;
  frame: HTMLElement;
  duration: HTMLElement;
  clock: HTMLElement;
  mute: HTMLInputElement;
  volume: HTMLInputElement;
}

export interface TimelineMonitorCallbacks {
  onFrame?(frame: number): void;
  onSelectClip?(clip: TimelinePreviewClip): void;
  onKey?(event: KeyboardEvent): void;
  onError?(error: unknown): void;
  onDiagnostics?(diagnostics: readonly CompositionDiagnostic[]): void;
  /** Called when this monitor starts playback, so the other monitor can pause. */
  onPlay?(): void;
  /** Called when a user seek should bring the program monitor forward. */
  onActivateProgram?(): void;
  onTimelineZoom?(zoom: number): void;
}

export interface TimelineMonitorOptions {
  stage: HTMLElement;
  stageWrap: HTMLElement;
  viewport: HTMLElement;
  scroll: HTMLElement;
  timelineInner: HTMLElement;
  timelineScroll: HTMLElement;
  tracks: HTMLElement;
  rulerScale: HTMLElement;
  playheadGrab: HTMLElement;
  empty: HTMLElement;
  transport: TimelineTransportElements;
  callbacks?: TimelineMonitorCallbacks;
}

export interface TimelineAudioDebug {
  playing: boolean;
  frame: number;
  outputLatency: number;
  entries: Array<{
    src: string;
    currentTime: number;
    paused: boolean;
    seeking: boolean;
    readyState: number;
    startFrame: number;
    trimStart: number;
    trimDuration?: number;
    mappedFrame: number | null;
  }>;
}

export interface TimelineMonitor {
  readonly data: TimelinePreviewData | null;
  readonly frame: number;
  readonly selectedClip: TimelinePreviewClip | null;
  readonly naturalSize: { width: number; height: number } | null;
  readonly zoom: MonitorZoom;
  readonly timelineZoom: number;
  load(data: TimelinePreviewData): Promise<void>;
  seek(frame: number): Promise<void>;
  step(delta: number): void;
  jump(deltaFrames: number): void;
  togglePlay(): void;
  pause(): void;
  dispose(): Promise<void>;
  setMuted(value: boolean): void;
  setVolume(value: number): void;
  /** Re-apply the current frame after the monitor becomes visible again. */
  refresh(): void;
  /** Program audio clock state for diagnosing A/V sync. */
  debugAudio(): TimelineAudioDebug;
  layout(): void;
  fit(): void;
  actualSize(): void;
  zoomIn(): void;
  zoomOut(): void;
  timelineZoomIn(): void;
  timelineZoomOut(): void;
  timelineZoomFit(): void;
}

function clampFrame(frame: number, duration: number): number {
  return Math.max(0, Math.min(duration - 1, Math.floor(frame)));
}

function renderRuler(scale: HTMLElement, duration: number, zoom: number): void {
  scale.replaceChildren();
  const count = Math.min(10, Math.max(5, Math.round(5 * zoom)));
  for (let index = 0; index < count; index += 1) {
    const fraction = count === 1 ? 0 : index / (count - 1);
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

/**
 * Re-seek program audio once it drifts more than this from the frame clock.
 * The desired position includes the output latency, so this threshold is
 * device-independent.
 */
const AUDIO_DRIFT_SECONDS = 0.12;

/** Estimate the audible output latency without routing the media elements. */
const AUDIO_LATENCY_MAX_SECONDS = 0.5;
const AUDIO_LATENCY_REFRESH_MS = 1_000;

export function createTimelineMonitor(options: TimelineMonitorOptions): TimelineMonitor {
  const callbacks = options.callbacks ?? {};
  const transport = options.transport;
  const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const;
  let data: TimelinePreviewData | null = null;
  let host: TimelineHost | null = null;
  let selectedClip: TimelinePreviewClip | null = null;
  let currentFrame = 0;
  let playing = false;
  let animationFrame = 0;
  let playStartFrame = 0;
  let playStartClock = 0;
  let seeking = false;
  let pendingFrame: number | null = null;
  let masterVolume = Number(transport.volume.value) || 0.8;
  let muted = false;
  let activeAudio = new Set<HTMLAudioElement>();
  let audioEntries: Array<{ clip: TimelinePreviewAudioClip; audio: HTMLAudioElement }> = [];
  let audioHeldForSeek = false;
  let resumeAfterSeek = false;
  const audioPlayFailed = new Set<HTMLAudioElement>();
  let audioContext: AudioContext | null = null;
  let audioOutputLatency = 0;
  let audioLatencyCheckedAt = 0;
  let resumePlayback: () => void = () => undefined;
  let zoomMode: "fit" | "custom" = "fit";
  let customZoom = 1;
  let stripZoom = 1;

  const fps = (): number => data?.format.fps ?? 30;
  const framesPerSecond = (): number => Math.max(1, Math.round(fps()));
  const duration = (): number => data?.durationInFrames ?? 0;

  const naturalSize = (): { width: number; height: number } | null =>
    data === null ? null : { width: data.format.width, height: data.format.height };

  const fitScale = (): number => {
    const size = naturalSize();
    if (size === null) {
      return 1;
    }
    const availableWidth = Math.max(1, options.viewport.clientWidth - 32);
    const availableHeight = Math.max(1, options.viewport.clientHeight - 32);
    return Math.min(availableWidth / size.width, availableHeight / size.height, 1);
  };

  const effectiveScale = (): number => (zoomMode === "fit" ? fitScale() : customZoom);

  const layout = (): void => {
    const size = naturalSize();
    if (size === null) {
      return;
    }
    const scale = effectiveScale();
    options.stage.style.width = `${size.width}px`;
    options.stage.style.height = `${size.height}px`;
    options.stage.style.transform = `scale(${scale})`;
    options.stage.style.transformOrigin = "top left";
    options.stageWrap.style.width = `${size.width * scale}px`;
    options.stageWrap.style.height = `${size.height * scale}px`;
  };

  const resetMonitorZoom = (): void => {
    zoomMode = "fit";
    customZoom = 1;
    options.scroll.scrollLeft = 0;
    options.scroll.scrollTop = 0;
    layout();
  };

  const zoomTo = (scale: number): void => {
    zoomMode = "custom";
    customZoom = Math.max(0.05, Math.min(4, scale));
    layout();
  };

  const scrollToPlayhead = (): void => {
    if (!data || options.timelineScroll.clientWidth === 0) {
      return;
    }
    const total = duration();
    const fraction = total <= 1 ? 0 : currentFrame / (total - 1);
    const inner = options.timelineInner.getBoundingClientRect();
    const scroll = options.timelineScroll.getBoundingClientRect();
    const head = inner.left + 106 + (inner.width - 106) * fraction;
    if (head < scroll.left + 24) {
      options.timelineScroll.scrollLeft -= scroll.left + 24 - head;
    } else if (head > scroll.right - 24) {
      options.timelineScroll.scrollLeft += head - (scroll.right - 24);
    }
  };

  const applyStripZoom = (): void => {
    options.timelineInner.style.setProperty("--timeline-zoom", String(stripZoom));
    if (data !== null) {
      renderRuler(options.rulerScale, data.durationInFrames, stripZoom);
    }
    callbacks.onTimelineZoom?.(stripZoom);
  };

  const audioClipEndFrame = (clip: TimelinePreviewAudioClip, audio: HTMLAudioElement): number => {
    const remainingSourceDuration = Number.isFinite(audio.duration)
      ? Math.max(0, audio.duration - clip.trimStart)
      : Number.POSITIVE_INFINITY;
    const clipDuration =
      clip.trimDuration === undefined ? remainingSourceDuration : Math.min(clip.trimDuration, remainingSourceDuration);
    return Number.isFinite(clipDuration) ? clip.startFrame + clipDuration * fps() : Number.POSITIVE_INFINITY;
  };

  const seekAudio = (audio: HTMLAudioElement, time: number, exact = true): void => {
    if (!Number.isFinite(time)) {
      return;
    }
    // Re-setting currentTime is not free: some browsers (notably WebKit)
    // land a few milliseconds off on every seek, which accumulates across
    // pause/resume cycles. Skip identical seeks and preserve the exact paused
    // position so a tolerant resume does not accumulate error.
    const tolerance = exact ? 0.001 : 1 / Math.max(1, fps()) + 0.01;
    if (Number.isFinite(audio.currentTime) && Math.abs(audio.currentTime - time) <= tolerance) {
      return;
    }
    try {
      audio.currentTime = time;
    } catch {
      // Metadata may not be available yet; loadedmetadata and the next sync retry.
    }
  };

  const updateAudio = (forceSeek: boolean, alignAudio = true): void => {
    if (!data) {
      return;
    }
    if (seeking && playing) {
      // Do not start or continue audio while the visible layers are still
      // seeking. Playing the new position first makes the sound lead the
      // picture for the duration of the seek.
      for (const { audio } of audioEntries) {
        audio.pause();
      }
      audioHeldForSeek = true;
      return;
    }
    const nextActive = new Set<HTMLAudioElement>();
    for (const { clip, audio } of audioEntries) {
      const endFrame = audioClipEndFrame(clip, audio);
      const active = currentFrame >= clip.startFrame && currentFrame < endFrame;
      if (active) {
        nextActive.add(audio);
      }
      const wasActive = activeAudio.has(audio);
      // The element's media clock is ahead of the audible frame by the output
      // latency, so include it in the desired position.
      const desired = clip.trimStart + Math.max(0, (currentFrame - clip.startFrame) / fps()) + audioOutputLatency;
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
          seekAudio(audio, desired, alignAudio);
        }
      }
      if (playing && active) {
        // The loop follows the active audio clock; here audio follows the
        // playhead. Correct drift even while the element is already playing so
        // a seek during playback does not leave the old position audible. A
        // seek that held audio paused also forces an exact re-seek when it
        // completes.
        const drifted = audioHeldForSeek || !wasActive || Math.abs(audio.currentTime - desired) > AUDIO_DRIFT_SECONDS;
        if (drifted && Number.isFinite(desired)) {
          seekAudio(audio, desired);
        }
        if (audio.paused && (drifted || !audio.ended)) {
          audioPlayFailed.delete(audio);
          void audio.play().then(
            () => {
              audioPlayFailed.delete(audio);
            },
            (error: unknown) => {
              // Pause/seek aborts are expected; only a real block (autoplay,
              // unsupported source) should fall back to the wall clock.
              if (!(error instanceof DOMException) || error.name !== "AbortError") {
                audioPlayFailed.add(audio);
              }
            },
          );
        }
      } else {
        audio.pause();
      }
    }
    activeAudio = nextActive;
    audioHeldForSeek = false;
  };

  const updateUi = (): void => {
    const total = duration();
    transport.frame.textContent = String(currentFrame);
    transport.scrub.value = String(currentFrame);
    transport.clock.textContent = `${(currentFrame / fps()).toFixed(2)}s`;
    const fraction = total <= 1 ? 0 : currentFrame / (total - 1);
    transport.scrub.style.setProperty("--progress", `${fraction * 100}%`);
    options.timelineInner.style.setProperty("--playhead-factor", String(fraction));
    options.playheadGrab.setAttribute("aria-valuemax", String(Math.max(0, total - 1)));
    options.playheadGrab.setAttribute("aria-valuenow", String(currentFrame));
    if (playing) {
      scrollToPlayhead();
    }
    callbacks.onFrame?.(currentFrame);
  };

  const refreshAudioLatency = (): void => {
    if (!audioContext) {
      return;
    }
    const base = Number.isFinite(audioContext.baseLatency) ? audioContext.baseLatency : 0;
    const output = Number.isFinite(audioContext.outputLatency) ? audioContext.outputLatency : 0;
    audioOutputLatency = Math.max(0, Math.min(AUDIO_LATENCY_MAX_SECONDS, base + output));
  };

  const ensureAudioLatency = (): void => {
    if (audioEntries.length === 0) {
      return;
    }
    if (audioContext) {
      if (audioContext.state === "suspended") {
        void audioContext.resume().then(refreshAudioLatency, () => undefined);
      } else {
        refreshAudioLatency();
      }
      return;
    }
    try {
      audioContext = new AudioContext();
      void audioContext.resume().then(refreshAudioLatency, () => undefined);
      refreshAudioLatency();
    } catch {
      audioContext = null;
      audioOutputLatency = 0;
    }
  };

  /**
   * The playing audio element is the preview's master clock. Following it
   * keeps the picture with the sound across pause/resume and the output
   * pipeline's start latency instead of letting the wall clock run ahead.
   * The frame is offset by the estimated output latency, because `currentTime`
   * leads the sample the user actually hears.
   */
  const audioClockFrame = (): number | null => {
    let starting = false;
    for (const { clip, audio } of audioEntries) {
      const active = currentFrame >= clip.startFrame && currentFrame < audioClipEndFrame(clip, audio);
      if (!active) {
        continue;
      }
      if (audio.paused) {
        // A resume asks play() to start the element. Hold the picture until it
        // does so; an ended source or a rejected play (autoplay blocked) falls
        // back to the wall clock instead of freezing the preview.
        if (!audio.ended && !audioPlayFailed.has(audio)) {
          starting = true;
        }
        continue;
      }
      if (audio.seeking || !Number.isFinite(audio.currentTime)) {
        starting = true;
        continue;
      }
      const frame = clip.startFrame + (audio.currentTime - audioOutputLatency - clip.trimStart) * fps();
      if (frame < clip.startFrame) {
        starting = true;
        continue;
      }
      if (frame < audioClipEndFrame(clip, audio)) {
        return Math.max(currentFrame, Math.floor(frame));
      }
    }
    if (starting) {
      return currentFrame;
    }
    // The playhead may be just outside a clip while its element is still
    // playing; follow it only while the mapped frame is inside that clip.
    for (const { clip, audio } of audioEntries) {
      if (audio.paused || audio.seeking || !Number.isFinite(audio.currentTime)) {
        continue;
      }
      const frame = clip.startFrame + (audio.currentTime - audioOutputLatency - clip.trimStart) * fps();
      if (frame >= clip.startFrame && frame < audioClipEndFrame(clip, audio)) {
        return Math.max(currentFrame, Math.floor(frame));
      }
    }
    return null;
  };

  const renderFrame = async (target: number, resyncAudio = false): Promise<void> => {
    if (!host || !data) {
      return;
    }
    callbacks.onActivateProgram?.();
    if (seeking) {
      const next = clampFrame(target, duration());
      if (next !== currentFrame) {
        currentFrame = next;
        pendingFrame = next;
        updateUi();
      }
      return;
    }
    seeking = true;
    const requested = clampFrame(target, duration());
    currentFrame = requested;
    updateUi();
    if (resyncAudio) {
      // An explicit seek. While playing this holds audio paused until every
      // layer has settled; while paused it moves the source immediately.
      updateAudio(true);
    }
    let failed = false;
    try {
      await host.seek(requested);
    } catch (error) {
      failed = true;
      playing = false;
      resumeAfterSeek = false;
      pendingFrame = null;
      updateAudio(true);
      callbacks.onError?.(error);
    } finally {
      seeking = false;
    }
    updateAudio(resyncAudio || !playing);
    if (!failed && pendingFrame !== null) {
      const next = pendingFrame;
      pendingFrame = null;
      if (next !== requested) {
        await renderFrame(next);
      }
    }
    if (resumeAfterSeek && playing && !seeking) {
      resumeAfterSeek = false;
      resumePlayback();
    }
  };

  /**
   * An explicit seek. Unlike the playback loop's frames, it stops the frame
   * clock while every layer catches up, then restarts playback from the
   * settled frame. Audio is held by updateAudio during the seek.
   */
  const seekTo = (target: number): Promise<void> => {
    if (playing && data) {
      resumeAfterSeek = true;
      cancelAnimationFrame(animationFrame);
    }
    return renderFrame(target, true);
  };

  const stopPlayback = (): void => {
    resumeAfterSeek = false;
    playing = false;
    cancelAnimationFrame(animationFrame);
    transport.play.innerHTML = "&#9654;";
    transport.play.setAttribute("aria-label", "Play");
    updateAudio(false, false);
  };

  const loop = (): void => {
    if (!playing || !data) {
      return;
    }
    const now = performance.now();
    if (now - audioLatencyCheckedAt >= AUDIO_LATENCY_REFRESH_MS) {
      audioLatencyCheckedAt = now;
      refreshAudioLatency();
    }
    const total = duration();
    const fallback = playStartFrame + Math.floor(((now - playStartClock) / 1000) * fps());
    const target = audioClockFrame() ?? fallback;
    if (target >= total - 1) {
      currentFrame = total - 1;
      playing = false;
      resumeAfterSeek = false;
      transport.play.innerHTML = "&#9654;";
      transport.play.setAttribute("aria-label", "Play");
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

  resumePlayback = (): void => {
    ensureAudioLatency();
    cancelAnimationFrame(animationFrame);
    playStartFrame = currentFrame;
    playStartClock = performance.now();
    animationFrame = requestAnimationFrame(loop);
  };

  const setPlaying = (value: boolean): void => {
    if (!data) {
      return;
    }
    if (value) {
      if (playing) {
        return;
      }
      callbacks.onPlay?.();
      ensureAudioLatency();
      if (currentFrame >= duration() - 1) {
        currentFrame = 0;
        void renderFrame(0);
      }
      playing = true;
      transport.play.innerHTML = "&#10074;&#10074;";
      transport.play.setAttribute("aria-label", "Pause");
      if (seeking) {
        // The stage is still catching up. Keep audio held and let the render
        // completion start the clock from the settled frame.
        resumeAfterSeek = true;
        updateAudio(true, false);
        return;
      }
      playStartFrame = currentFrame;
      playStartClock = performance.now();
      updateAudio(true, false);
      animationFrame = requestAnimationFrame(loop);
    } else {
      stopPlayback();
    }
  };

  const step = (delta: number): void => {
    if (!data) {
      return;
    }
    stopPlayback();
    const target = clampFrame(currentFrame + delta, duration());
    if (target !== currentFrame) {
      void renderFrame(target);
    }
  };

  const selectClip = (clip: TimelinePreviewClip): void => {
    selectedClip = clip;
    for (const element of options.tracks.querySelectorAll<HTMLElement>(".clip")) {
      element.classList.toggle("selected", element.dataset.clipId === clip.id);
    }
    callbacks.onSelectClip?.(clip);
  };

  const selectClipFromElement = (element: Element | null): void => {
    const clipElement = element?.closest<HTMLElement>(".clip");
    if (!clipElement) {
      return;
    }
    const clip = data?.clips.find((candidate) => candidate.id === clipElement.dataset.clipId);
    if (clip) {
      selectClip(clip);
    }
  };

  const renderTracks = (next: TimelinePreviewData): void => {
    options.tracks.replaceChildren();
    for (const track of next.tracks) {
      const row = document.createElement("div");
      row.className = "track";
      const label = document.createElement("div");
      label.className = "track-label";
      const name = track.name ?? track.id;
      label.textContent = name;
      label.title = `${track.kind} ${track.id}`;
      const lane = document.createElement("div");
      lane.className = "lane";

      const clips = next.clips
        .filter((clip) => clip.track === track.id)
        .sort((left, right) => left.start - right.start);
      for (const clip of clips) {
        const element = document.createElement("div");
        element.className = clipClass(clip);
        element.dataset.clipId = clip.id;
        element.tabIndex = 0;
        element.setAttribute("role", "button");
        element.setAttribute("aria-label", `Select clip ${clip.id}`);
        element.style.left = `${(clip.start / next.durationInFrames) * 100}%`;
        element.style.width = `${(clip.duration / next.durationInFrames) * 100}%`;
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

      for (const transition of next.transitions.filter((entry) => entry.track === track.id)) {
        const band = document.createElement("div");
        band.className = "transition";
        band.style.left = `${(transition.start / next.durationInFrames) * 100}%`;
        band.style.width = `${((transition.end - transition.start) / next.durationInFrames) * 100}%`;
        band.title = `${transition.kind} ${transition.from} → ${transition.to} · ${transition.start}..${transition.end}`;
        lane.append(band);
      }

      row.append(label, lane);
      options.tracks.append(row);
    }
  };

  options.tracks.addEventListener("click", (event) => {
    selectClipFromElement(event.target as Element | null);
  });
  options.tracks.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLElement) {
      event.preventDefault();
      selectClipFromElement(event.target);
    }
  });

  const seekFromClientX = (clientX: number): void => {
    if (!data) {
      return;
    }
    const rect = options.rulerScale.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    stopPlayback();
    void renderFrame(Math.round(fraction * Math.max(0, duration() - 1)));
  };

  const beginDrag = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    seekFromClientX(event.clientX);
    const move = (next: PointerEvent): void => seekFromClientX(next.clientX);
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  options.rulerScale.addEventListener("pointerdown", beginDrag);
  options.playheadGrab.addEventListener("pointerdown", beginDrag);
  options.playheadGrab.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      stopPlayback();
      void renderFrame(0);
    } else if (event.key === "End") {
      event.preventDefault();
      stopPlayback();
      void renderFrame(Math.max(0, duration() - 1));
    }
  });

  transport.play.addEventListener("click", () => setPlaying(!playing));
  transport.stepBack.addEventListener("click", () => step(-1));
  transport.stepForward.addEventListener("click", () => step(1));
  transport.jumpBack.addEventListener("click", () => step(-framesPerSecond()));
  transport.jumpForward.addEventListener("click", () => step(framesPerSecond()));
  transport.scrub.addEventListener("input", () => {
    stopPlayback();
    void renderFrame(Number(transport.scrub.value));
  });
  transport.mute.addEventListener("change", () => {
    muted = transport.mute.checked;
    updateAudio(false, false);
  });
  transport.volume.addEventListener("input", () => {
    masterVolume = Number(transport.volume.value);
    updateAudio(false, false);
  });
  window.addEventListener("resize", layout);

  transport.mute.disabled = true;
  transport.volume.disabled = true;

  const dispose = async (): Promise<void> => {
    stopPlayback();
    for (const { audio } of audioEntries) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    audioEntries = [];
    audioPlayFailed.clear();
    if (audioContext) {
      const context = audioContext;
      audioContext = null;
      void context.close().catch(() => undefined);
    }
    audioOutputLatency = 0;
    audioLatencyCheckedAt = 0;
    activeAudio = new Set();
    if (host) {
      const active = host;
      host = null;
      try {
        await active.dispose();
      } catch {
        // Preview cleanup is best-effort.
      }
    }
    data = null;
    selectedClip = null;
    currentFrame = 0;
    stripZoom = 1;
    zoomMode = "fit";
    customZoom = 1;
    options.tracks.replaceChildren();
    options.rulerScale.replaceChildren();
    options.stage.replaceChildren();
    options.stage.style.transform = "";
    options.stage.style.width = "0px";
    options.stage.style.height = "0px";
    options.stageWrap.style.width = "0px";
    options.stageWrap.style.height = "0px";
    options.timelineInner.style.removeProperty("--timeline-zoom");
    options.timelineInner.style.setProperty("--playhead-factor", "0");
    options.empty.hidden = false;
    options.stageWrap.hidden = true;
    transport.frame.textContent = "0";
    transport.duration.textContent = "0";
    transport.clock.textContent = "0.00s";
    transport.scrub.max = "0";
    transport.scrub.value = "0";
    transport.scrub.style.setProperty("--progress", "0%");
    transport.mute.disabled = true;
    transport.volume.disabled = true;
    callbacks.onTimelineZoom?.(1);
  };

  const load = async (next: TimelinePreviewData): Promise<void> => {
    await dispose();
    data = next;
    const total = next.durationInFrames;
    options.empty.hidden = true;
    options.stageWrap.hidden = false;
    options.stage.replaceChildren();
    options.stage.style.width = `${next.format.width}px`;
    options.stage.style.height = `${next.format.height}px`;
    host = createTimelineHost(options.stage, next);
    renderTracks(next);
    applyStripZoom();
    for (const marker of options.tracks.querySelectorAll<HTMLElement>(".keyframe-marker")) {
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
    audioEntries = next.audioClips.map((clip) => {
      const audio = new Audio(clip.url);
      audio.preload = "auto";
      audio.volume = clip.volume;
      // A seek before metadata arrives is dropped by the element; retry once
      // the duration and seekable ranges are known.
      audio.addEventListener("loadedmetadata", () => updateAudio(true, false), { once: true });
      return { clip, audio };
    });
    transport.mute.disabled = audioEntries.length === 0;
    transport.volume.disabled = audioEntries.length === 0;
    transport.scrub.max = String(Math.max(0, total - 1));
    transport.duration.textContent = String(Math.max(0, total - 1));
    resetMonitorZoom();
    callbacks.onDiagnostics?.(next.diagnostics);
    host.setKeyHandler((event) => callbacks.onKey?.(event));
    await host.load();
    await renderFrame(0);
  };

  const setStripZoom = (value: number): void => {
    stripZoom = Math.max(1, Math.min(8, value));
    applyStripZoom();
  };

  return {
    get data() {
      return data;
    },
    get frame() {
      return currentFrame;
    },
    get selectedClip() {
      return selectedClip;
    },
    get naturalSize() {
      return naturalSize();
    },
    get zoom(): MonitorZoom {
      return { mode: zoomMode, scale: effectiveScale() };
    },
    get timelineZoom() {
      return stripZoom;
    },
    load,
    seek: seekTo,
    step,
    jump: step,
    togglePlay: () => setPlaying(!playing),
    pause() {
      if (playing) {
        stopPlayback();
      }
    },
    dispose,
    setMuted(value: boolean) {
      muted = value;
      transport.mute.checked = value;
      updateAudio(false, false);
    },
    setVolume(value: number) {
      masterVolume = value;
      transport.volume.value = String(value);
      updateAudio(false, false);
    },
    debugAudio() {
      return {
        playing,
        frame: currentFrame,
        outputLatency: audioOutputLatency,
        entries: audioEntries.map(({ clip, audio }) => {
          const frame = clip.startFrame + (audio.currentTime - audioOutputLatency - clip.trimStart) * fps();
          return {
            src: clip.src,
            currentTime: audio.currentTime,
            paused: audio.paused,
            seeking: audio.seeking,
            readyState: audio.readyState,
            startFrame: clip.startFrame,
            trimStart: clip.trimStart,
            ...(clip.trimDuration !== undefined ? { trimDuration: clip.trimDuration } : {}),
            mappedFrame: Number.isFinite(frame) ? Math.floor(frame) : null,
          };
        }),
      };
    },
    refresh() {
      if (host !== null && data !== null) {
        void host.seek(currentFrame).catch((error: unknown) => callbacks.onError?.(error));
      }
    },
    layout,
    fit() {
      zoomMode = "fit";
      layout();
    },
    actualSize() {
      zoomTo(1);
    },
    zoomIn() {
      const current = effectiveScale();
      const next = ZOOM_STEPS.find((step) => step > current + 0.0001);
      zoomTo(next ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 4);
    },
    zoomOut() {
      const current = effectiveScale();
      const previous = [...ZOOM_STEPS].reverse().find((step) => step < current - 0.0001);
      zoomTo(previous ?? ZOOM_STEPS[0] ?? 0.05);
    },
    timelineZoomIn() {
      setStripZoom(stripZoom * 1.5);
    },
    timelineZoomOut() {
      setStripZoom(stripZoom / 1.5);
    },
    timelineZoomFit() {
      setStripZoom(1);
      options.timelineScroll.scrollLeft = 0;
    },
  };
}
