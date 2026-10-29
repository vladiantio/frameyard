import { defineComposition } from "frameyard";

let a;
let b;
let c;

export default defineComposition({
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 90,
  mount({ container }) {
    const orb = (id, color) =>
      `<div id="${id}" style="position:absolute;left:0;top:0;width:720px;height:720px;` +
      `border-radius:50%;background:${color};filter:blur(110px)"></div>`;
    container.innerHTML =
      '<div style="position:absolute;inset:0;background:#070b14"></div>' +
      orb("a", "#e4572e") +
      orb("b", "#17bebb") +
      orb("c", "#ffc914");
    a = container.querySelector("#a");
    b = container.querySelector("#b");
    c = container.querySelector("#c");
  },
  update({ frame }) {
    const t = frame / 89;
    a.style.transform = `translate(${400 + Math.sin(t * Math.PI * 2) * 420}px, ${200 + Math.cos(t * Math.PI * 2) * 180}px)`;
    b.style.transform = `translate(${700 + Math.cos(t * Math.PI * 2) * 380}px, ${500 + Math.sin(t * Math.PI * 2) * 260}px)`;
    c.style.transform = `translate(${1000 + Math.sin(t * Math.PI * 2 + 1) * 300}px, ${300 + Math.cos(t * Math.PI * 2 + 1) * 220}px)`;
  },
});
