const COLS = 7;
const ROWS = 5;
const LAYERS = 14;
const SPACING_X = 1.95;
const SPACING_Y = 1.15;
const SPACING_Z = 3.3;
const SPAN = SPACING_Z * LAYERS;
const FOCAL = 1480;
const CAMERA = 7.2;

let canvas;
let ctx;
let fps = 60;
let width = 1920;
let height = 1080;

const nodes = [];
const paper = [242, 245, 238];
const accent = [184, 243, 107];

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function rgba(color, alpha) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha.toFixed(3)})`;
}

function clearNodes() {
  nodes.length = 0;
}

function draw(frame) {
  if (!ctx) {
    return;
  }

  const time = frame / fps;
  const travel = time * 2.05;
  const yaw = -0.075 + Math.sin(time * 0.29) * 0.075;
  const pitch = Math.sin(time * 0.22 + 0.8) * 0.032;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const centerX = 1214;
  const centerY = 524;

  ctx.clearRect(0, 0, width, height);
  clearNodes();

  for (let k = 0; k < LAYERS; k += 1) {
    const depth = (((k * SPACING_Z - travel) % SPAN) + SPAN) % SPAN;

    for (let i = 0; i < COLS; i += 1) {
      const worldX = (i - (COLS - 1) / 2) * SPACING_X;

      for (let j = 0; j < ROWS; j += 1) {
        const worldY = (j - (ROWS - 1) / 2) * SPACING_Y;
        const x1 = worldX * cosYaw - depth * sinYaw;
        const z1 = worldX * sinYaw + depth * cosYaw;
        const y1 = worldY * cosPitch - z1 * sinPitch;
        const z2 = worldY * sinPitch + z1 * cosPitch;
        const perspective = FOCAL / (z2 + CAMERA);

        if (perspective <= 0) {
          continue;
        }

        const halfW = 0.9 * perspective;
        const halfH = 0.58 * perspective;
        const x = centerX + x1 * perspective;
        const y = centerY + y1 * perspective;

        if (x + halfW < -80 || x - halfW > width + 80 || y + halfH < -80 || y - halfH > height + 80) {
          continue;
        }

        const reveal = smoothstep(0, 2.1, depth);
        const near = 1 - depth / SPAN;
        const alpha = reveal * (0.06 + 0.5 * near * near);
        const signal = Math.sin(time * 1.12 + i * 0.92 + j * 1.37 + k * 0.47 - 0.6);
        const selected = signal > 0.86 || (i * 11 + j * 7 + k * 5) % 31 === 0;

        nodes.push({
          x,
          y,
          halfW,
          halfH,
          z: z2,
          alpha,
          selected,
          lineWidth: Math.max(0.55, Math.min(1.9, 0.35 + perspective * 0.01)),
        });
      }
    }
  }

  nodes.sort((a, b) => b.z - a.z);

  for (const node of nodes) {
    const color = node.selected ? accent : paper;
    const strength = node.selected ? Math.min(1, node.alpha * 1.9 + 0.16) : node.alpha;
    ctx.strokeStyle = rgba(color, strength);
    ctx.lineWidth = node.selected ? node.lineWidth * 1.12 : node.lineWidth;

    if (node.selected && node.z < 18) {
      ctx.shadowColor = rgba(accent, 0.7);
      ctx.shadowBlur = Math.min(22, 8 + node.halfW * 0.08);
    }

    ctx.strokeRect(node.x - node.halfW, node.y - node.halfH, node.halfW * 2, node.halfH * 2);
    ctx.shadowBlur = 0;

    if (node.selected && node.halfW > 38) {
      ctx.fillStyle = rgba(accent, Math.min(0.9, node.alpha * 2.4));
      ctx.fillRect(node.x - 1.5, node.y - 1.5, 3, 3);
    }
  }
}

export default {
  mount({ root }) {
    canvas = root.querySelector("#lattice");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("lattice composition requires a #lattice canvas");
    }
    ctx = canvas.getContext("2d", { alpha: true });
    fps = Number(root.getAttribute("fps") ?? 60);
    width = canvas.width;
    height = canvas.height;
    draw(0);
  },

  update({ frame }) {
    draw(frame);
  },

  dispose() {
    clearNodes();
    canvas = undefined;
    ctx = undefined;
    fps = 60;
    width = 1920;
    height = 1080;
  },
};
