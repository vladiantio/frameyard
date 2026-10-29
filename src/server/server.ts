import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FrameyardError } from "../errors.js";
import { loadProject, type Project } from "../project.js";
import { renderPreviewHtml } from "./preview-html.js";

export interface PreviewServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  readonly project: Project;
  close(): Promise<void>;
}

export interface PreviewServerOptions {
  projectRoot: string;
  port?: number;
  host?: string;
  /** Overrides the directory containing built framework browser modules. */
  frameworkDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".otf": "font/otf",
  ".png": "image/png",
  ".srt": "application/x-subrip; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function resolveInside(base: string, relativePath: string): string | null {
  if (relativePath.includes("\0")) {
    return null;
  }
  const absolute = path.resolve(base, relativePath);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) {
    return null;
  }
  return absolute;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return "invalid";
  }

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) {
      return "invalid";
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return "invalid";
  }

  return { start, end: Math.min(end, size - 1) };
}

async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  base: string,
  relativePath: string,
): Promise<void> {
  let filePath = resolveInside(base, relativePath);
  if (!filePath) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      fileStat = await stat(filePath);
    }
  } catch {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  if (!fileStat.isFile()) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const range = parseRange(request.headers.range, fileStat.size);
  if (range === "invalid") {
    response.writeHead(416, {
      "Content-Range": `bytes */${fileStat.size}`,
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  const headers: Record<string, string | number> = {
    "Content-Type": contentType(filePath),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };

  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${fileStat.size}`;
    headers["Content-Length"] = range.end - range.start + 1;
    response.writeHead(206, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath, { start: range.start, end: range.end })
      .on("error", () => response.destroy())
      .pipe(response);
    return;
  }

  headers["Content-Length"] = fileStat.size;
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath)
    .on("error", () => response.destroy())
    .pipe(response);
}

export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  const project = await loadProject(options.projectRoot);
  const frameworkDir = options.frameworkDir ?? path.join(fileURLToPath(new URL("../../", import.meta.url)), "dist");
  const host = options.host ?? "127.0.0.1";
  const html = renderPreviewHtml();
  const projectJson = {
    compositions: Array.from(project.compositions.values(), ({ id, entry }) => ({ id, entry })),
  };

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      } catch {
        sendJson(response, 400, { error: "Invalid URL" });
        return;
      }

      if (pathname === "/") {
        response.writeHead(302, { Location: "/__frameyard/", "Cache-Control": "no-store" });
        response.end();
        return;
      }

      if (pathname === "/__frameyard") {
        response.writeHead(302, { Location: "/__frameyard/", "Cache-Control": "no-store" });
        response.end();
        return;
      }

      if (pathname === "/__frameyard/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(html),
          "Cache-Control": "no-store",
        });
        response.end(request.method === "HEAD" ? undefined : html);
        return;
      }

      if (pathname === "/__frameyard/project.json") {
        sendJson(response, 200, projectJson);
        return;
      }

      if (pathname.startsWith("/__frameyard/framework/")) {
        await serveFile(request, response, frameworkDir, pathname.slice("/__frameyard/framework/".length));
        return;
      }

      await serveFile(request, response, project.root, pathname.slice(1));
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 5173, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new FrameyardError("INTERNAL", "Preview server did not expose a TCP address.");
  }

  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${address.port}/`;

  return {
    url,
    port: address.port,
    host,
    project,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}
