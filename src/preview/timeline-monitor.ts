import type { CompositionDiagnostic } from "../index.js";
import { keyframeChannelsAt, keyframeMarkerFrames } from "../timeline/keyframes.js";
import { transitionGain } from "../timeline/transitions.js";
import { createTimelineHost, type TimelineHost } from "./timeline-host.js";
import type { TimelinePreviewAudioClip, TimelinePreviewClip, TimelinePreviewData } from "./timeline-data.js";

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
}

export interface TimelineMonitorOptions {
  stage: HTMLElement;
  stageWrap: HTMLElement;
  viewport: HTMLElement;
  timelineInner: HTMLElement;
  tracks: HTMLElement;
  rulerScale: HTMLElement;
  empty: HTMLElement;
  transport: TimelineTransportElements;
  callbacks?: TimelineMonitorCallbacks;
}

export interface TimelineMonitor {
  readonly data: TimelinePreviewData | null;
  readonly frame: number;
  readonly selectedClip: TimelinePreviewClip | null;
  load(data: TimelinePreviewData): Promise<void>;
  seek(frame: number): Promise<void>;
  step(delta: number): void;
  jump(deltaFrames: number): void;
  togglePlay(): void;
  dispose(): Promise<void>;
  setMuted(value: boolean): void;
  setVolume(value: number): void;
  fit(): void;
}

function clampFrame(frame: number, duration: number): number {
  return Math.max(0, Math.min(duration - 1, Math.floor(frame)));
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

export function createTimelineMonitor(options: TimelineMonitorOptions): TimelineMonitor {
  const callbacks = options.callbacks ?? {};
  const transport = options.transport;
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

  const fps = (): number => data?.format.fps ?? 30;
  const framesPerSecond = (): number => Math.max(1, Math.round(fps()));
  const duration = (): number => data?.durationInFrames ?? 0;

  const fit = (): void => {
    if (!data) {
      return;
    }
    const availableWidth = Math.max(80, options.viewport.clientWidth - 40);
    const availableHeight = Math.max(60, options.viewport.clientHeight - 40);
    const scale = Math.min(availableWidth / data.format.width, availableHeight / data.format.height);
    options.stage.style.transform = `scale(${scale})`;
    options.stage.style.transformOrigin = "top left";
    options.stageWrap.style.width = `${data.format.width * scale}px`;
    options.stageWrap.style.height = `${data.format.height * scale}px`;
  };

  const updateAudio = (forceSeek: boolean): void => {
    if (!data) {
      return;
    }
    const nextActive = new Set<HTMLAudioElement>();
    for (const { clip, audio } of audioEntries) {
      const remainingSourceDuration = Number.isFinite(audio.duration)
        ? Math.max(0, audio.duration - clip.trimStart)
        : Number.POSITIVE_INFINITY;
      const clipDuration =
        clip.trimDuration === undefined
          ? remainingSourceDuration
          : Math.min(clip.trimDuration, remainingSourceDuration);
      const endFrame = Number.isFinite(clipDuration)
        ? clip.startFrame + clipDuration * fps()
        : Number.POSITIVE_INFINITY;
      const active = currentFrame >= clip.startFrame && currentFrame < endFrame;
      if (active) {
        nextActive.add(audio);
      }
      const wasActive = activeAudio.has(audio);
      const desired = clip.trimStart + Math.max(0, (currentFrame - clip.startFrame) / fps());
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
    const total = duration();
    transport.frame.textContent = String(currentFrame);
    transport.scrub.value = String(currentFrame);
    transport.clock.textContent = `${(currentFrame / fps()).toFixed(2)}s`;
    const fraction = total <= 1 ? 0 : currentFrame / (total - 1);
    transport.scrub.style.setProperty("--progress", `${fraction * 100}%`);
    options.timelineInner.style.setProperty("--playhead-factor", String(fraction));
    callbacks.onFrame?.(currentFrame);
  };

  const renderFrame = async (target: number): Promise<void> => {
    if (!host || !data) {
      return;
    }
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
    let failed = false;
    try {
      await host.seek(requested);
    } catch (error) {
      failed = true;
      playing = false;
      pendingFrame = null;
      updateAudio(true);
      callbacks.onError?.(error);
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
    transport.play.innerHTML = "&#9654;";
    transport.play.setAttribute("aria-label", "Play");
    updateAudio(false);
  };

  const loop = (): void => {
    if (!playing || !data) {
      return;
    }
    const total = duration();
    const target = playStartFrame + Math.floor(((performance.now() - playStartClock) / 1000) * fps());
    if (target >= total - 1) {
      currentFrame = total - 1;
      playing = false;
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

  const setPlaying = (value: boolean): void => {
    if (!data) {
      return;
    }
    if (value) {
      if (playing) {
        return;
      }
      if (currentFrame >= duration() - 1) {
        currentFrame = 0;
        void renderFrame(0);
      }
      playing = true;
      playStartFrame = currentFrame;
      playStartClock = performance.now();
      transport.play.innerHTML = "&#10074;&#10074;";
      transport.play.setAttribute("aria-label", "Pause");
      updateAudio(true);
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
    updateAudio(true);
  });
  transport.volume.addEventListener("input", () => {
    masterVolume = Number(transport.volume.value);
    updateAudio(true);
  });
  window.addEventListener("resize", fit);

  const dispose = async (): Promise<void> => {
    stopPlayback();
    for (const { audio } of audioEntries) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    audioEntries = [];
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
    options.tracks.replaceChildren();
    options.rulerScale.replaceChildren();
    options.stage.replaceChildren();
    options.stage.style.transform = "";
    options.stageWrap.style.width = "0px";
    options.stageWrap.style.height = "0px";
    options.empty.hidden = false;
    options.stageWrap.hidden = true;
    transport.frame.textContent = "0";
    transport.duration.textContent = "0";
    transport.clock.textContent = "0.00s";
    transport.scrub.max = "0";
    transport.scrub.value = "0";
    transport.scrub.style.setProperty("--progress", "0%");
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
    renderRuler(options.rulerScale, total);
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
      return { clip, audio };
    });
    transport.scrub.max = String(Math.max(0, total - 1));
    transport.duration.textContent = String(total);
    fit();
    callbacks.onDiagnostics?.(next.diagnostics);
    host.setKeyHandler((event) => callbacks.onKey?.(event));
    await host.load();
    await renderFrame(0);
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
    load,
    seek: renderFrame,
    step,
    jump: step,
    togglePlay: () => setPlaying(!playing),
    dispose,
    setMuted(value: boolean) {
      muted = value;
      transport.mute.checked = value;
      updateAudio(true);
    },
    setVolume(value: number) {
      masterVolume = value;
      transport.volume.value = String(value);
      updateAudio(true);
    },
    fit,
  };
}
