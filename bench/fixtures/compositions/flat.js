import { defineComposition } from "frameyard";

let box;

export default defineComposition({
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 90,
  mount({ container }) {
    container.innerHTML =
      '<div style="position:absolute;inset:0;background:#101820"></div>' +
      '<div id="box" style="position:absolute;left:0;top:0;width:280px;height:280px;' +
      'border-radius:36px;background:#f2aa4c"></div>';
    box = container.querySelector("#box");
  },
  update({ frame }) {
    const t = frame / 89;
    box.style.transform = `translate(${200 + t * 1200}px, ${300 + Math.sin(t * Math.PI) * 200}px)`;
  },
});
