export default {
  format: { width: 1280, height: 720, fps: 30 },
  compositions: {
    backdrop: "./compositions/backdrop.html",
    card: "./compositions/card.html",
    overlay: "./compositions/overlay.html",
  },
  timelines: {
    "chapter-a": "./timelines/chapter-a.timeline.json",
    "chapter-b": "./timelines/chapter-b.timeline.json",
    "nested-reel": "./timelines/nested-reel.timeline.json",
  },
};
