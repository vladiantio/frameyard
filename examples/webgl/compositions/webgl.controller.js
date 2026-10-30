const VERTEX_SHADER = `
  attribute vec2 a_position;

  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  uniform vec2 u_resolution;
  uniform float u_frame;
  uniform float u_duration;
  uniform vec3 u_accent;

  const float TAU = 6.28318530718;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    vec2 p = (gl_FragCoord.xy * 2.0 - u_resolution) / u_resolution.y;
    float phase = (u_frame / max(u_duration, 1.0)) * TAU;

    // A slow domain warp turns the contour field into a liquid surface.
    vec2 q = p;
    q.x += 0.045 * sin(p.y * 3.4 - phase * 0.8);
    q.y += 0.10 * sin(p.x * 2.2 + phase * 0.55) + 0.035 * sin(p.x * 5.7 - phase * 0.9);

    float terrain = q.y + 0.07 * sin(q.x * 3.6 + phase * 0.7) + 0.025 * sin(q.x * 8.4 - phase * 1.1);
    float contour = abs(fract(terrain * 14.0 + phase * 0.5) - 0.5);
    float line = smoothstep(0.455, 0.5, contour);
    float glow = smoothstep(0.26, 0.5, contour);

    vec3 ink = mix(vec3(0.016, 0.026, 0.038), vec3(0.035, 0.078, 0.085), uv.y);
    vec3 color = ink;

    float right = smoothstep(0.14, 0.66, uv.x);
    color += u_accent * line * (0.10 + 0.38 * right);
    color += u_accent * glow * 0.045 * right;

    // A soft moving light and one thin orbit ring anchor the right side.
    vec2 light = vec2(0.34 + 0.05 * cos(phase * 0.6), 0.06 + 0.04 * sin(phase * 0.45));
    float radius = length(p - light);
    float halo = 0.035 / (radius + 0.035);
    vec3 white = mix(u_accent, vec3(0.92, 1.0, 0.98), 0.7);
    color += white * halo * 0.42;

    float ring = 1.0 - smoothstep(0.0, 0.007, abs(radius - 0.27 - 0.012 * sin(phase * 1.4)));
    color += white * ring * 0.22;

    // Static grain keeps the gradient from banding without adding temporal noise.
    color += (hash(gl_FragCoord.xy) - 0.5) * 0.02;
    float vignette = 1.0 - smoothstep(0.62, 1.28, length(p * vec2(0.86, 1.0)));
    color *= 0.58 + 0.42 * vignette;

    gl_FragColor = vec4(color, 1.0);
  }
`;

let gl;
let program;
let buffer;
let uniforms;
let labels;
let durationFrames = 360;
let fps = 30;

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log ?? "Could not compile the WebGL shader.");
  }
  return shader;
}

function linkProgram() {
  const vertex = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const next = gl.createProgram();
  gl.attachShader(next, vertex);
  gl.attachShader(next, fragment);
  gl.linkProgram(next);
  gl.detachShader(next, vertex);
  gl.detachShader(next, fragment);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(next, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(next);
    gl.deleteProgram(next);
    throw new Error(log ?? "Could not link the WebGL program.");
  }
  return next;
}

function hexToRgb(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(typeof value === "string" ? value : "");
  if (!match) {
    return [0.47, 0.94, 0.78];
  }
  const number = Number.parseInt(match[1], 16);
  return [((number >> 16) & 0xff) / 255, ((number >> 8) & 0xff) / 255, (number & 0xff) / 255];
}

export default {
  validateProps(props) {
    const errors = [];
    for (const key of ["kicker", "title", "subtitle"]) {
      if (typeof props[key] !== "string") {
        errors.push(key + " must be a string");
      }
    }
    if (typeof props.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(props.accent)) {
      errors.push("accent must be a #rrggbb color");
    }
    return errors;
  },

  mount({ root, props }) {
    const canvas = root.querySelector("#field");
    fps = Number(root.getAttribute("fps") ?? 30);
    durationFrames = Number(root.getAttribute("duration-in-frames") ?? 360);

    gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error("WebGL is unavailable. The production renderer pins SwiftShader.");
    }

    program = linkProgram();
    gl.useProgram(program);

    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    uniforms = {
      frame: gl.getUniformLocation(program, "u_frame"),
      resolution: gl.getUniformLocation(program, "u_resolution"),
      duration: gl.getUniformLocation(program, "u_duration"),
      accent: gl.getUniformLocation(program, "u_accent"),
    };

    const accent = hexToRgb(props.accent);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.duration, durationFrames);
    gl.uniform3f(uniforms.accent, accent[0], accent[1], accent[2]);
    gl.clearColor(0.016, 0.026, 0.038, 1);

    labels = {
      frame: root.querySelector("#frame"),
      total: root.querySelector("#total"),
      clock: root.querySelector("#clock"),
    };
    labels.total.textContent = String(durationFrames - 1).padStart(3, "0");
  },

  update({ frame }) {
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uniforms.frame, frame);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    labels.frame.textContent = String(frame).padStart(3, "0");
    labels.clock.textContent = (frame / fps).toFixed(2) + " S";
  },

  dispose() {
    if (gl) {
      if (buffer) {
        gl.deleteBuffer(buffer);
      }
      if (program) {
        gl.deleteProgram(program);
      }
    }
    gl = undefined;
    program = undefined;
    buffer = undefined;
    uniforms = undefined;
    labels = undefined;
    durationFrames = 360;
    fps = 30;
  },
};
