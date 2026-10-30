import { random } from "frameyard/runtime";

const STAR_COUNT = 130;
const BAR_COUNT = 52;
const BASELINE = 858;

let context;
let signalPath;
let signalBars;
let frameLabel;
let stars;
let bars = [];
let signalLength = 0;

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function easeOut(value) {
  const t = clamp(value);
  return 1 - Math.pow(1 - t, 3);
}

function makeStars() {
  stars = Array.from({ length: STAR_COUNT }, (_, index) => ({
    x: random("star:" + index + ":x"),
    y: random("star:" + index + ":y"),
    radius: 0.6 + random("star:" + index + ":r") * 1.8,
    speed: 6 + random("star:" + index + ":speed") * 34,
    alpha: 0.12 + random("star:" + index + ":alpha") * 0.65,
  }));
}

function buildBars(root) {
  signalBars = root.querySelector("#signal-bars");
  bars = [];

  for (let index = 0; index < BAR_COUNT; index += 1) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const height = 24 + random("bar:" + index + ":height") * 176;
    const x = 168 + index * 31;
    rect.setAttribute("x", String(x));
    rect.setAttribute("width", "15");
    rect.setAttribute("rx", "7.5");
    rect.setAttribute("fill", "var(--fy-prop-accent)");
    rect.setAttribute("height", "0");
    rect.setAttribute("y", String(BASELINE));
    rect.setAttribute("opacity", "0");
    signalBars.append(rect);
    bars.push({ element: rect, height });
  }
}

function buildSignalPath(root) {
  signalPath = root.querySelector("#signal-path");
  const points = [];
  for (let index = 0; index <= 120; index += 1) {
    const x = 160 + (index / 120) * 1600;
    const wave = Math.sin(index / 7) * 38 + Math.sin(index / 17 + 1.4) * 22 + (random("signal:" + index) - 0.5) * 12;
    points.push([x, 535 + wave]);
  }
  const d = points.map(([x, y], index) => (index === 0 ? "M" : "L") + x + " " + y).join(" ");
  signalPath.setAttribute("d", d);
  signalLength = signalPath.getTotalLength();
  signalPath.style.strokeDasharray = String(signalLength);
  signalPath.style.strokeDashoffset = String(signalLength);
}

export default {
  mount({ root }) {
    context = root.querySelector("#field").getContext("2d");
    frameLabel = root.querySelector("#frame");
    makeStars();
    buildBars(root);
    buildSignalPath(root);
  },

  update({ frame }) {
    const intro = easeOut(frame / 52);
    const signalReveal = easeOut((frame - 96) / 260);
    const width = context.canvas.width;
    const height = context.canvas.height;

    context.clearRect(0, 0, width, height);
    for (const star of stars) {
      const drift = (frame * star.speed) % width;
      const x = (star.x * width + drift) % width;
      const y = star.y * height;
      context.beginPath();
      context.fillStyle = "rgba(214, 236, 255, " + star.alpha * (0.45 + 0.55 * intro) + ")";
      context.arc(x, y, star.radius, 0, Math.PI * 2);
      context.fill();
    }

    signalPath.style.strokeDashoffset = String(signalLength * (1 - signalReveal));
    signalPath.style.opacity = String(0.18 + signalReveal * 0.64);

    const barReveal = clamp((frame - 120) / 240);
    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index];
      const local = clamp(barReveal * BAR_COUNT - index);
      const height = bar.height * local;
      bar.element.setAttribute("height", height.toFixed(2));
      bar.element.setAttribute("y", String(BASELINE - height));
      bar.element.setAttribute("opacity", (0.25 + local * 0.62).toFixed(3));
    }

    frameLabel.textContent = String(frame).padStart(3, "0");
  },

  dispose() {
    context = undefined;
    signalPath = undefined;
    signalBars = undefined;
    frameLabel = undefined;
    stars = undefined;
    bars = [];
    signalLength = 0;
  },
};
