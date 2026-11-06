export default {
  format: { width: 1920, height: 1080, fps: 30 },
  compositions: {
    video: "./compositions/video.html",
    "video-mp4": "./compositions/video-mp4.html",
    "video-overlay": "./compositions/video-overlay.html",
  },
  timelines: {
    "video-timeline": "./timelines/video-timeline.timeline.json",
    "video-timeline-mp4": "./timelines/video-timeline-mp4.timeline.json",
  },
};
