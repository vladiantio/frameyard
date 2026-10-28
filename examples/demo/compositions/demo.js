import { defineComposition } from "frameyard";
import { random } from "frameyard/runtime";

let scene;
let title;
let subtitle;
let kaption;
let progress;
let signalPath;
let bars = [];
let starfield;
let stars;
let context;
let signalLength = 0;

const STAR_COUNT = 130;
const BAR_COUNT = 52;
const BASELINE = 858;

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

function buildBars() {
  const svg = document.querySelector("#signal");
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  bars = [];

  for (let index = 0; index < BAR_COUNT; index += 1) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const height = 24 + random("bar:" + index + ":height") * 176;
    const x = 168 + index * 31;
    rect.setAttribute("x", String(x));
    rect.setAttribute("width", "15");
    rect.setAttribute("rx", "7.5");
    rect.setAttribute("fill", "var(--accent)");
    rect.setAttribute("height", "0");
    rect.setAttribute("y", String(BASELINE));
    rect.setAttribute("opacity", "0");
    group.append(rect);
    bars.push({ element: rect, height });
  }

  svg.append(group);
  return group;
}

function buildSignalPath() {
  const points = [];
  for (let index = 0; index <= 120; index += 1) {
    const x = 160 + (index / 120) * 1600;
    const wave =
      Math.sin(index / 7) * 38 +
      Math.sin(index / 17 + 1.4) * 22 +
      (random("signal:" + index) - 0.5) * 12;
    points.push([x, 535 + wave]);
  }
  const d = points.map(([x, y], index) => (index === 0 ? "M" : "L") + x + " " + y).join(" ");
  signalPath.setAttribute("d", d);
  signalLength = signalPath.getTotalLength();
  signalPath.style.strokeDasharray = String(signalLength);
  signalPath.style.strokeDashoffset = String(signalLength);
}

export default defineComposition({
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 900,
  defaultProps: {
    title: "Frameyard",
    subtitle: "Deterministic video, authored with the web platform.",
    accent: "#b8f36b",
  },
  validateProps(props) {
    const errors = [];
    if (typeof props.title !== "string" || props.title.length === 0) errors.push("title must be a non-empty string");
    if (typeof props.subtitle !== "string") errors.push("subtitle must be a string");
    if (typeof props.accent !== "string") errors.push("accent must be a string");
    return errors;
  },
  audio: [
    { src: "assets/chime.wav", startFrame: 18, volume: 0.5 },
    { src: "assets/chime.wav", startFrame: 300, volume: 0.38 },
    { src: "assets/chime.wav", startFrame: 600, volume: 0.42 },
    { src: "assets/chime.wav", startFrame: 840, volume: 0.55 },
  ],
  mount({ container, props }) {
    container.style.setProperty("--accent", props.accent);
    container.innerHTML =
      "<style>" +
      "@keyframes orbit { from { transform: rotate(0deg) translateX(210px) rotate(0deg); } to { transform: rotate(360deg) translateX(210px) rotate(-360deg); } }" +
      "@keyframes breathe { 0%, 100% { opacity: .35; transform: scale(1); } 50% { opacity: .7; transform: scale(1.12); } }" +
      "#scene { position: relative; width: 100%; height: 100%; overflow: hidden; background: #080a0d; color: #eef2f7; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }" +
      "#field { position: absolute; inset: 0; width: 100%; height: 100%; }" +
      "#orb { position: absolute; top: 46%; left: 38%; width: 460px; height: 460px; margin: -230px 0 0 -230px; border-radius: 50%; background: var(--accent); filter: blur(110px); opacity: .28; animation: orbit 30s linear infinite;" +
      " }" +
      "#glow { position: absolute; top: 8%; right: 6%; width: 280px; height: 280px; border-radius: 50%; background: var(--accent); filter: blur(90px); animation: breathe 9s ease-in-out infinite; }" +
      "#rail { position: absolute; top: 92px; left: 160px; right: 160px; height: 1px; background: rgba(255,255,255,.14); }" +
      "#eyebrow { position: absolute; top: 64px; left: 160px; font: 600 14px/1 ui-monospace, monospace; letter-spacing: .28em; text-transform: uppercase; color: var(--accent); }" +
      "#meta { position: absolute; top: 64px; right: 160px; font: 500 14px/1 ui-monospace, monospace; letter-spacing: .12em; color: #788595; }" +
      "#copy { position: absolute; left: 160px; top: 236px; width: 1320px; }" +
      "#title { margin: 0; font-size: 156px; line-height: .92; letter-spacing: -.055em; font-weight: 680; }" +
      "#subtitle { margin: 34px 0 0; max-width: 820px; font-size: 31px; line-height: 1.45; color: #96a2b2; font-weight: 420; }" +
      "#signal { position: absolute; left: 0; bottom: 0; width: 1920px; height: 1080px; overflow: visible; }" +
      "#caption { position: absolute; left: 160px; bottom: 92px; font: 500 13px/1 ui-monospace, monospace; letter-spacing: .16em; color: #7e8b9b; }" +
      "#caption strong { color: var(--accent); font-weight: 600; }" +
      "#progress-track { position: absolute; left: 160px; right: 160px; bottom: 72px; height: 2px; background: rgba(255,255,255,.1); }" +
      "#progress { position: absolute; inset: 0 auto 0 0; width: 0%; background: var(--accent); box-shadow: 0 0 18px var(--accent); }" +
      "#vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 48%, rgba(0,0,0,.42) 100%); pointer-events: none; }" +
      "</style>" +
      '<div id="scene">' +
      '<canvas id="field" width="1920" height="1080"></canvas>' +
      '<div id="orb"></div><div id="glow"></div><div id="vignette"></div>' +
      '<div id="rail"></div><div id="eyebrow">Frameyard / Field Notes</div><div id="meta">1920×1080 · 30 FPS · 30.00 S</div>' +
      '<div id="copy"><h1 id="title"></h1><p id="subtitle"></p></div>' +
      '<svg id="signal" viewBox="0 0 1920 1080" fill="none" aria-hidden="true">' +
      '<path id="signal-path" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".82"/>' +
      '</svg>' +
      '<div id="caption">FRAME <strong id="frame">000</strong> / 899 · SEEK-SAFE CANVAS + SVG + CSS</div>' +
      '<div id="progress-track"><div id="progress"></div></div>' +
      "</div>";

    scene = container.querySelector("#scene");
    title = container.querySelector("#title");
    subtitle = container.querySelector("#subtitle");
    kaption = container.querySelector("#frame");
    progress = container.querySelector("#progress");
    signalPath = container.querySelector("#signal-path");
    starfield = container.querySelector("#field");
    context = starfield.getContext("2d");
    makeStars();
    buildBars();
    buildSignalPath();
    title.textContent = props.title;
    subtitle.textContent = props.subtitle;
  },
  update({ frame, props }) {
    const intro = easeOut(frame / 52);
    const copyIntro = easeOut((frame - 26) / 62);
    const signalReveal = easeOut((frame - 96) / 260);
    const outro = 1 - clamp((frame - 824) / 70);
    const total = 899;

    scene.style.opacity = String(outro);
    title.textContent = props.title;
    subtitle.textContent = props.subtitle;
    title.style.opacity = String(intro);
    title.style.transform = "translateY(" + (1 - intro) * 46 + "px)";
    subtitle.style.opacity = String(copyIntro);
    subtitle.style.transform = "translateY(" + (1 - copyIntro) * 26 + "px)";
    kaption.textContent = String(frame).padStart(3, "0");
    progress.style.width = (frame / total) * 100 + "%";

    const width = starfield.width;
    const height = starfield.height;
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
  },
  dispose() {
    scene = undefined;
    title = undefined;
    subtitle = undefined;
    kaption = undefined;
    progress = undefined;
    signalPath = undefined;
    starfield = undefined;
    context = undefined;
    bars = [];
    stars = undefined;
    signalLength = 0;
  },
});
