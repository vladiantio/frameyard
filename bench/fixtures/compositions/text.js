import { defineComposition } from "frameyard";

let line;

export default defineComposition({
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 90,
  mount({ container }) {
    const words = Array.from({ length: 90 }, (_, index) => `frame ${String(index + 1).padStart(2, "0")}`);
    container.innerHTML =
      '<div style="position:absolute;inset:0;background:#f4efe6;color:#101820;' +
      'font:700 42px/1.4 ui-monospace,monospace;padding:64px">' +
      words.map((word) => `<span style="display:inline-block;margin:0 14px 18px 0">${word}</span>`).join("") +
      "</div>" +
      '<div id="line" style="position:absolute;left:0;top:0;height:12px;background:#e4572e"></div>';
    line = container.querySelector("#line");
  },
  update({ frame }) {
    const t = frame / 89;
    line.style.width = `${120 + t * 1600}px`;
    line.style.transform = `translate(${64 + t * 120}px, ${880 - t * 300}px)`;
  },
});
