export default {
  format: { width: 1920, height: 1080, fps: 30 },
  compositions: {
    backdrop: "./compositions/backdrop.html",
    aurora: "./compositions/aurora.html",
    labels: "./compositions/labels.html",
  },
  timelines: {
    "blend-timeline": "./timelines/blend.timeline.json",
  },
};
