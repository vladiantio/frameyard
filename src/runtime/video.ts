/**
 * Resolves after the browser has presented a video frame.
 *
 * `seeked` fires when the media element has decoded the target frame, but it can
 * still precede the compositor presenting that frame. `requestVideoFrameCallback`
 * runs after presentation; two animation frames are the fallback for browsers
 * without it, and the timeout keeps a paused or detached element from blocking a
 * seek forever.
 */
export function waitForVideoPaint(video: HTMLVideoElement, timeoutMs = 1_000): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== "function") {
    return nextPaint();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    let handle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (handle !== undefined) {
        video.cancelVideoFrameCallback(handle);
      }
      resolve();
    };

    handle = video.requestVideoFrameCallback(() => finish());
    timer = setTimeout(finish, timeoutMs);
  });
}

/** Resolves after two animation frames, the fallback paint barrier. */
export function nextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
