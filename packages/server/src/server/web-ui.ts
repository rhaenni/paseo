import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RequestHandler, Response } from "express";
import type { Logger } from "pino";

const EXCLUDED_PATH_PREFIXES = ["/api/", "/mcp/", "/public/"];
const EXCLUDED_PATHS = new Set(["/api", "/mcp", "/public"]);

function isExcludedPath(requestPath: string): boolean {
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (requestPath.startsWith(prefix)) {
      return true;
    }
  }
  return EXCLUDED_PATHS.has(requestPath);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
};

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function selectEncoding(
  acceptEncoding: string | undefined,
): "br" | "gzip" | null {
  if (!acceptEncoding) {
    return null;
  }
  const normalized = acceptEncoding.toLowerCase();
  if (normalized.includes("br")) {
    return "br";
  }
  if (normalized.includes("gzip")) {
    return "gzip";
  }
  return null;
}

function isHashedAsset(filePath: string): boolean {
  const base = path.basename(filePath);
  // Match content hashes like index-abc123def456.js or main.abc123def456.css.
  return /[-.][0-9a-f]{16,}[-.]/i.test(base);
}

function isInsideDir(targetPath: string, dirPath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedTarget = path.resolve(targetPath);
  return (
    resolvedTarget === resolvedDir ||
    resolvedTarget.startsWith(resolvedDir + path.sep)
  );
}

interface ResolvedTarget {
  resolvedFile: string;
  isIndexHtml: boolean;
}

function resolveTargetFile(
  distDir: string,
  requestPath: string,
): ResolvedTarget | null {
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, safePath);

  const stat = safeStat(filePath);
  if (stat?.isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  const finalStat = safeStat(filePath);
  if (!finalStat?.isFile()) {
    filePath = path.join(distDir, "index.html");
    const fallbackStat = safeStat(filePath);
    if (!fallbackStat?.isFile()) {
      return null;
    }
  }

  if (!isInsideDir(filePath, distDir)) {
    return null;
  }

  const resolvedFile = path.resolve(filePath);
  const isIndexHtml =
    path.basename(resolvedFile).toLowerCase() === "index.html";
  return { resolvedFile, isIndexHtml };
}

function safeStat(filePath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

interface ContentEncodingResult {
  finalFile: string;
  contentEncoding: string | null;
}

function resolveContentEncoding(
  resolvedFile: string,
  acceptEncoding: string | undefined,
): ContentEncodingResult {
  const encoding = selectEncoding(acceptEncoding);
  if (!encoding) {
    return { finalFile: resolvedFile, contentEncoding: null };
  }
  const compressedFile = `${resolvedFile}.${encoding === "br" ? "br" : "gz"}`;
  const compressedStat = safeStat(compressedFile);
  if (compressedStat?.isFile()) {
    return { finalFile: compressedFile, contentEncoding: encoding };
  }
  return { finalFile: resolvedFile, contentEncoding: null };
}

function setResponseCacheHeaders(
  res: Response,
  isIndexHtml: boolean,
  resolvedFile: string,
): void {
  if (isIndexHtml) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  } else if (isHashedAsset(resolvedFile)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
}

export interface WebUiMiddlewareOptions {
  enabled: boolean;
  distDir: string | null;
  label: string;
  serverId?: string;
  logger: Logger;
}

export function createWebUiMiddleware(
  options: WebUiMiddlewareOptions,
): RequestHandler {
  const { enabled, distDir, label, serverId, logger } = options;
  const childLogger = logger.child({ module: "web-ui" });

  if (!enabled || !distDir) {
    childLogger.info(
      { enabled, hasDistDir: !!distDir },
      "Daemon web UI disabled or missing dist directory",
    );
  } else {
    childLogger.info({ distDir }, "Daemon web UI mounted");
  }

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    if (isExcludedPath(req.path)) {
      next();
      return;
    }

    if (!enabled || !distDir) {
      res.status(404).end();
      return;
    }

    serveWebUiFile({
      distDir,
      requestPath: req.path,
      label,
      serverId,
      req,
      res,
    });
  };
}

interface ServeWebUiFileOptions {
  distDir: string;
  requestPath: string;
  label: string;
  serverId?: string;
  req: Parameters<RequestHandler>[0];
  res: Parameters<RequestHandler>[1];
}

function serveWebUiFile(options: ServeWebUiFileOptions): void {
  const { distDir, requestPath, label, serverId, req, res } = options;

  const target = resolveTargetFile(distDir, requestPath);
  if (!target) {
    res.status(404).end();
    return;
  }

  const { resolvedFile, isIndexHtml } = target;
  const acceptEncoding = isIndexHtml
    ? undefined
    : req.headers["accept-encoding"];
  const { finalFile, contentEncoding } = resolveContentEncoding(
    resolvedFile,
    acceptEncoding,
  );

  res.setHeader("Content-Type", getContentType(resolvedFile));
  if (contentEncoding) {
    res.setHeader("Content-Encoding", contentEncoding);
    res.setHeader("Vary", "Accept-Encoding");
  }
  setResponseCacheHeaders(res, isIndexHtml, resolvedFile);

  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  if (isIndexHtml) {
    sendIndexHtml(res, finalFile, req, label, serverId);
    return;
  }

  const stream = createReadStream(finalFile);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

function sendIndexHtml(
  res: Response,
  filePath: string,
  req: Parameters<RequestHandler>[0],
  label: string,
  serverId: string | undefined,
): void {
  try {
    const html = readFileSync(filePath, "utf-8");
    const injected = injectConnectionHint(html, req, label, serverId);
    res.status(200).send(injected);
  } catch {
    res.status(500).end();
  }
}

const HOST_REGISTRY_STORAGE_KEY = "@paseo:daemon-registry";
const EMBEDDED_SETTINGS_CSS =
  'div:has(> [data-testid="settings-detail-pane"]) > :not([data-testid="settings-detail-pane"]){display:none!important}';

/**
 * Removes saved hosts that reach `listen` directly but belong to another
 * server id. Returns null when nothing changes. Runs in the browser via
 * `toString()`, so it must stay self-contained.
 */
export function pruneStaleHosts(
  registry: unknown,
  listen: string,
  serverId: string,
): unknown[] | null {
  if (!Array.isArray(registry)) return null;
  const normalize = (endpoint: unknown) =>
    String(endpoint)
      .trim()
      .toLowerCase()
      .replace(/^(127\.0\.0\.1|\[::1\])(?=:\d+$)/, "localhost");
  const target = normalize(listen);
  const kept = registry.filter(
    (host: { serverId?: unknown; connections?: unknown } | null) =>
      !host ||
      host.serverId === serverId ||
      !Array.isArray(host.connections) ||
      !host.connections.some(
        (connection: { type?: unknown; endpoint?: unknown } | null) =>
          connection?.type === "directTcp" &&
          normalize(connection.endpoint) === target,
      ),
  );
  return kept.length === registry.length ? null : kept;
}

function serializeInlineScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026");
}

function injectConnectionHint(
  html: string,
  req: Parameters<RequestHandler>[0],
  label: string,
  serverId: string | undefined,
): string {
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const useTls = req.protocol === "https";
  const hint = {
    listen: host,
    useTls,
    label,
  };
  const json = serializeInlineScriptJson(hint);
  // Joyful fork: the app skips the hint when a saved host already uses this
  // endpoint, even when that host is an earlier daemon (another server id) that
  // listened on the same port, which then stays "Offline" forever. Drop such
  // stale entries before the app reads its registry.
  const prune = serverId
    ? `try{var k=${JSON.stringify(HOST_REGISTRY_STORAGE_KEY)},r=JSON.parse(localStorage.getItem(k)||"null"),n=(${pruneStaleHosts.toString()})(r,${json}.listen,${serializeInlineScriptJson(serverId)});if(n)localStorage.setItem(k,JSON.stringify(n))}catch(e){}`
    : "";
  // Joyful fork: embedded in an iframe (Joyful's Settings > Providers), show a
  // settings page without the settings sidebar next to it.
  const embedded = `if(window.top!==window.self){var s=document.createElement("style");s.textContent=${JSON.stringify(EMBEDDED_SETTINGS_CSS)};document.head.appendChild(s)}`;
  const script = `<script>window.__PASEO_INITIAL_DAEMON_CONNECTION__=${json};${prune}${embedded}</script>`;
  const headClose = /<\/head>/i;
  if (headClose.test(html)) {
    return html.replace(headClose, `${script}</head>`);
  }
  return script + html;
}
