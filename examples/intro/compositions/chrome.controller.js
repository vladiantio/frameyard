const CHAPTERS = [
  { start: 0, label: "01 / author" },
  { start: 270, label: "02 / compose" },
  { start: 570, label: "03 / render" },
  { start: 870, label: "04 / frameyard" },
];
const CHAPTER_FADE = 12;

let frameLabel;
let timeLabel;
let totalLabel;
let chapterLabel;
let fps = 60;
let duration = 1200;

function chapterAt(frame) {
  let index = 0;
  for (let i = 0; i < CHAPTERS.length; i += 1) {
    if (frame >= CHAPTERS[i].start) {
      index = i;
    }
  }
  const entry = CHAPTERS[index];
  const end = index + 1 < CHAPTERS.length ? CHAPTERS[index + 1].start : duration;
  let alpha = 1;
  if (frame < entry.start + CHAPTER_FADE) {
    alpha = (frame - entry.start) / CHAPTER_FADE;
  } else if (frame > end - CHAPTER_FADE) {
    alpha = (end - frame) / CHAPTER_FADE;
  }
  return { label: entry.label, alpha: Math.min(1, Math.max(0, alpha)) };
}

export default {
  mount({ root }) {
    frameLabel = root.querySelector("#frame");
    timeLabel = root.querySelector("#time");
    totalLabel = root.querySelector("#total");
    chapterLabel = root.querySelector("#chapter");
    fps = Number(root.getAttribute("fps") ?? 60);
    duration = Number(root.getAttribute("duration-in-frames") ?? 1200);
    totalLabel.textContent = String(Math.max(0, duration - 1)).padStart(4, "0");
  },

  update({ frame }) {
    frameLabel.textContent = String(frame).padStart(4, "0");
    timeLabel.textContent = (frame / fps).toFixed(2) + " S";

    const chapter = chapterAt(frame);
    chapterLabel.textContent = chapter.label;
    chapterLabel.style.opacity = chapter.alpha.toFixed(3);
    chapterLabel.style.transform = `translateY(${((1 - chapter.alpha) * 4).toFixed(2)}px)`;
  },

  dispose() {
    frameLabel = undefined;
    timeLabel = undefined;
    totalLabel = undefined;
    chapterLabel = undefined;
    fps = 60;
    duration = 1200;
  },
};
