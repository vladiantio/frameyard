import type { ResolvedAudioClip } from "../contracts.js";
import { FrameyardError } from "../errors.js";
import { frameToSeconds } from "./clock.js";

interface PreparedMedia {
  element: HTMLVideoElement;
  owner: HTMLElement;
  /** Project-relative source path without a leading slash. */
  source: string;
  objectUrl: string;
  /** Timeline position captured when the composition mounted. */
  spec: MediaSpec;
  /** Whether the composition explicitly muted the element before Frameyard prepared it. */
  authorMuted: boolean;
}

interface MediaSpec {
  startFrame: number;
  trimStart: number;
  trimDuration?: number;
  volume: number;
}

const MEDIA_TIMEOUT_MS = 30_000;
const TIME_EPSILON = 0.0005;
const preparedMedia = new WeakMap<HTMLVideoElement, PreparedMedia>();
const preparedStates = new Set<PreparedMedia>();
const pendingPreparation = new WeakMap<HTMLVideoElement, Promise<PreparedMedia>>();

const VIDEO_MIME_TYPES: Record<string, string> = {
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
};

function mediaSource(video: HTMLVideoElement): string {
  const direct = video.getAttribute("src");
  if (direct !== null && direct.trim().length > 0) {
    return direct.trim();
  }
  const source = video.querySelector("source[src]");
  const nested = source?.getAttribute("src");
  if (nested !== null && nested !== undefined && nested.trim().length > 0) {
    return nested.trim();
  }
  return "";
}

/** Converts a composition-relative media reference to a normalized project path. */
export function normalizeMediaSource(raw: string): string {
  if (raw.length === 0) {
    throw new FrameyardError("MEDIA_INVALID", "An embedded video must have a non-empty src attribute.");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith("//") || raw.startsWith("\\")) {
    throw new FrameyardError(
      "MEDIA_INVALID",
      `Embedded video source must be a local project-relative file, not "${raw}".`,
    );
  }

  let pathValue = raw.split(/[?#]/, 1)[0] ?? "";
  pathValue = pathValue.replace(/\\/g, "/").replace(/^\/+/, "");
  if (pathValue.startsWith("./")) {
    pathValue = pathValue.slice(2);
  }
  if (pathValue.length === 0 || pathValue.split("/").includes("..") || pathValue.includes("\0")) {
    throw new FrameyardError("MEDIA_INVALID", `Embedded video source must stay inside the project, not "${raw}".`);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathValue);
  } catch {
    throw new FrameyardError("MEDIA_INVALID", `Embedded video source is not a valid URL path: "${raw}".`);
  }
  if (decoded.length === 0 || decoded.split("/").includes("..") || decoded.includes("\0")) {
    throw new FrameyardError("MEDIA_INVALID", `Embedded video source must stay inside the project, not "${raw}".`);
  }
  return decoded;
}

function videoUrl(pathValue: string): URL {
  return new URL(`/${pathValue}`, window.location.origin);
}

function waitForEvent(
  video: HTMLVideoElement,
  event: "loadeddata" | "seeked",
  message: string,
  code: "MEDIA_INVALID" | "MEDIA_SEEK_FAILED" = "MEDIA_INVALID",
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;

    function finish(): void {
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
      clearTimeout(timer);
    }

    function onEvent(): void {
      finish();
      resolve();
    }

    function onError(): void {
      finish();
      reject(new FrameyardError(code, `${message}${video.error?.message ? `: ${video.error.message}` : ""}`));
    }

    timer = setTimeout(() => {
      finish();
      reject(new FrameyardError(code, `${message} Timed out after ${MEDIA_TIMEOUT_MS / 1000}s.`));
    }, MEDIA_TIMEOUT_MS);

    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function prepareVideo(video: HTMLVideoElement, owner: HTMLElement): Promise<PreparedMedia> {
  const raw = mediaSource(video);
  const source = normalizeMediaSource(raw);
  const spec = mediaSpec(video);
  const existing = preparedMedia.get(video);
  if (existing && existing.owner === owner && existing.source === source) {
    return existing;
  }
  if (existing) {
    preparedMedia.delete(video);
    preparedStates.delete(existing);
    URL.revokeObjectURL(existing.objectUrl);
  }

  let response: Response;
  try {
    response = await fetch(videoUrl(source), { cache: "no-store" });
  } catch (error) {
    throw new FrameyardError("ASSET_NOT_FOUND", `Could not load embedded video asset "${source}".`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new FrameyardError(
      "ASSET_NOT_FOUND",
      `Could not load embedded video asset "${source}" (HTTP ${response.status}).`,
    );
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new FrameyardError("MEDIA_INVALID", `Embedded video asset "${source}" is empty.`);
  }
  const extension = source.slice(source.lastIndexOf(".")).toLowerCase();
  const type = blob.type || VIDEO_MIME_TYPES[extension] || "video/webm";
  const videoBlob = blob.type === type ? blob : blob.slice(0, blob.size, type);
  const objectUrl = URL.createObjectURL(videoBlob);

  const authorMuted = video.muted;
  for (const nested of Array.from(video.querySelectorAll("source"))) {
    nested.remove();
  }

  const loaded = waitForEvent(video, "loadeddata", `Embedded video asset "${source}" could not be decoded.`);
  video.preload = "auto";
  video.playsInline = true;
  video.pause();
  video.muted = true;
  video.src = objectUrl;
  video.load();

  try {
    await loaded;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.seekable.length === 0) {
      throw new FrameyardError("MEDIA_INVALID", `Embedded video asset "${source}" is not seekable.`);
    }
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }

  const state: PreparedMedia = { element: video, owner, source, objectUrl, spec, authorMuted };
  preparedMedia.set(video, state);
  preparedStates.add(state);
  return state;
}

async function prepareOrGet(video: HTMLVideoElement, owner: HTMLElement): Promise<PreparedMedia> {
  const ready = preparedMedia.get(video);
  if (ready && ready.owner === owner) {
    return ready;
  }
  const pending = pendingPreparation.get(video);
  if (pending) {
    return pending;
  }
  const preparation = prepareVideo(video, owner);
  pendingPreparation.set(video, preparation);
  try {
    return await preparation;
  } finally {
    pendingPreparation.delete(video);
  }
}

/** Loads every embedded video into memory before frame production begins. */
export async function prepareMedia(container: HTMLElement): Promise<void> {
  const videos = Array.from(container.querySelectorAll("video"));
  await Promise.all(videos.map((video) => prepareOrGet(video, container)));
}

function integerAttribute(element: Element, name: string, fallback: number): number {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new FrameyardError("MEDIA_INVALID", `Embedded video ${name} must be a non-negative integer.`);
  }
  return value;
}

function secondsAttribute(element: Element, name: string, fallback: number, allowZero: boolean): number {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new FrameyardError(
      "MEDIA_INVALID",
      `Embedded video ${name} must be ${allowZero ? "a non-negative" : "a positive"} number of seconds.`,
    );
  }
  return value;
}

function volumeAttribute(element: Element): number {
  const raw = element.getAttribute("data-fy-volume");
  if (raw === null || raw.trim().length === 0) {
    return Math.max(0, Math.min(1, (element as HTMLVideoElement).volume));
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new FrameyardError("MEDIA_INVALID", "Embedded video data-fy-volume must be between 0 and 1.");
  }
  return value;
}

function mediaSpec(element: Element): MediaSpec {
  const startFrame = integerAttribute(element, "data-fy-start", 0);
  const trimStart = secondsAttribute(element, "data-fy-trim", 0, true);
  const durationRaw = element.getAttribute("data-fy-duration");
  const trimDuration =
    durationRaw === null || durationRaw.trim().length === 0
      ? undefined
      : secondsAttribute(element, "data-fy-duration", 0, false);
  const spec: MediaSpec = {
    startFrame,
    trimStart,
    volume: volumeAttribute(element),
  };
  if (trimDuration !== undefined) {
    spec.trimDuration = trimDuration;
  }
  return spec;
}

function seekTarget(video: HTMLVideoElement, spec: MediaSpec, frame: number, fps: number): number {
  const localSeconds = frameToSeconds(frame, fps) - spec.startFrame / fps;
  const usedSeconds =
    spec.trimDuration === undefined
      ? Math.max(0, localSeconds)
      : Math.min(spec.trimDuration, Math.max(0, localSeconds));
  const target = spec.trimStart + usedSeconds;
  const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : target;
  return Math.min(target, Math.max(0, duration - TIME_EPSILON));
}

async function seekVideo(video: HTMLVideoElement, frame: number, fps: number): Promise<void> {
  const state = preparedMedia.get(video);
  if (!state) {
    throw new FrameyardError(
      "MEDIA_INVALID",
      "Embedded video elements must be created in mount(); videos added during update() cannot be prepared without network access.",
    );
  }
  if (!video.paused) {
    video.pause();
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForEvent(video, "loadeddata", "Embedded video is not ready for frame production.");
  }

  const target = seekTarget(video, state.spec, frame, fps);
  if (video.seeking) {
    await waitForEvent(video, "seeked", "Embedded video could not finish an earlier seek.", "MEDIA_SEEK_FAILED");
  }
  if (!video.seeking && Math.abs(video.currentTime - target) < TIME_EPSILON) {
    return;
  }

  const seeked = waitForEvent(
    video,
    "seeked",
    "Embedded video could not seek to the requested frame.",
    "MEDIA_SEEK_FAILED",
  );
  try {
    video.currentTime = target;
  } catch (error) {
    throw new FrameyardError(
      "MEDIA_SEEK_FAILED",
      `Embedded video could not seek to ${target.toFixed(3)}s: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  await seeked;
}

async function nextPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Seeks every embedded video to the requested composition frame and waits for
 * the browser to present the result. This is the asynchronous half of a seek;
 * composition update() stays synchronous.
 */
export async function settleMedia(container: HTMLElement, frame: number, fps: number): Promise<void> {
  const videos = Array.from(container.querySelectorAll("video"));
  if (videos.length === 0) {
    return;
  }
  await Promise.all(videos.map((video) => seekVideo(video, frame, fps)));
  await nextPaint();
}

/** Describes the audio contributed by unmuted embedded videos for preview and FFmpeg. */
export function describeMediaAudio(container: HTMLElement): readonly ResolvedAudioClip[] {
  const clips: ResolvedAudioClip[] = [];
  for (const video of Array.from(container.querySelectorAll("video"))) {
    const state = preparedMedia.get(video);
    if (!state || state.authorMuted || video.getAttribute("data-fy-audio") === "off") {
      continue;
    }
    const spec = state.spec;
    if (spec.volume === 0) {
      continue;
    }

    const clip: ResolvedAudioClip = {
      src: state.source,
      startFrame: spec.startFrame,
      trimStart: spec.trimStart,
      volume: spec.volume,
    };
    if (spec.trimDuration !== undefined) {
      clip.trimDuration = spec.trimDuration;
    }
    clips.push(Object.freeze(clip));
  }
  return Object.freeze(clips);
}

/** Releases object URLs and media resources owned by the runtime. */
export function releaseMedia(container: HTMLElement): void {
  for (const state of Array.from(preparedStates)) {
    if (state.owner !== container) {
      continue;
    }
    preparedStates.delete(state);
    preparedMedia.delete(state.element);
    state.element.pause();
    URL.revokeObjectURL(state.objectUrl);
    state.element.removeAttribute("src");
    state.element.load();
  }
}
