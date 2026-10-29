import { defineComposition } from "frameyard";

let panel;
let orb;

export default defineComposition({
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 90,
  mount({ container }) {
    container.innerHTML =
      '<div id="panel" style="position:absolute;inset:0"></div>' +
      '<div id="orb" style="position:absolute;left:0;top:0;width:520px;height:520px;' +
      'border-radius:50%;background:rgba(255,255,255,.16);mix-blend-mode:screen"></div>';
    panel = container.querySelector("#panel");
    orb = container.querySelector("#orb");
  },
  update({ frame }) {
    const t = frame / 89;
    const hue = Math.round(t * 360);
    panel.style.background = `linear-gradient(135deg, hsl(${hue} 70% 24%), hsl(${(hue + 120) % 360} 80% 58%))`;
    orb.style.transform = `translate(${900 + Math.cos(t * Math.PI * 2) * 520}px, ${300 + Math.sin(t * Math.PI * 2) * 220}px)`;
  },
});
