import crypto from "node:crypto";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendRoughdraftDocumentComment,
  extractRoughdraftReviewIndex,
} from "@roughdraft/rfm";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  hasNonLoopbackHost,
  ROUGHDRAFT_DEFAULT_PORT,
  ROUGHDRAFT_LOOPBACK_HOSTS,
  ROUGHDRAFT_PUBLIC_HOST,
  ROUGHDRAFT_TOKEN_ENV,
  resolveBindHosts,
} from "./network.js";

export { ROUGHDRAFT_TOKEN_ENV } from "./network.js";
import { ReviewEventQueue } from "./review-events.js";
import { resolveUpdateStatus } from "./update-status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, "../../app/dist");
const defaultServerRoot = path.resolve(__dirname, "../../..");

interface AssetPayload {
  filename?: string;
  mimeType?: string;
  dataBase64?: string;
}

interface CreateAppOptions {
  port?: number;
  projectDir?: string;
  serverRoot?: string;
  // The hosts the server was told to listen on. Any host outside loopback makes
  // every file-touching route reachable from another machine, so the token
  // guard switches on from this and never from a request header, which the
  // caller controls. Defaults to the loopback-only bind.
  bindHosts?: readonly string[];
  staticDirPath?: string;
  packageJsonPath?: string;
  fetchImpl?: typeof fetch;
  packageName?: string;
  remoteDocumentToken?: string;
}

interface CreateAppResult {
  app: Express;
  port: number;
}

// One connected tab. `path` is the document it has open (null on the
// homepage) and `sessionLabel` names the agent session that opened it; the
// tab reports both when it subscribes, and a delivered open request updates
// the label. `openedAt` is when the tab subscribed and `lastSavedAt` the last
// time this server wrote the document to disk while the tab was connected.
// Together the entries are the server's record of open documents.
interface OpenRequestClient {
  id: number;
  path: string | null;
  sessionLabel: string | null;
  openedAt: string;
  lastSavedAt: string | null;
  response: Response;
}

// What `/api/status` reports for each tab that has a document open.
export interface OpenDocumentRecord {
  path: string;
  sessionLabel: string | null;
  openedAt: string;
  lastSavedAt: string | null;
}

interface OpenRequestPayload {
  path?: string;
  url?: string;
  label?: string;
  reviewToken?: string;
}

interface RemoteSession {
  id: string;
  originPath: string;
  content: string;
  version: string;
  saveClient: Response | null;
  viewers: Set<Response>;
  disconnectedAt: number | null;
}

interface RemoteDocumentRegisterPayload {
  sessionId?: string;
  originPath?: string;
  content?: string;
}

interface RemoteDocumentSavePayload {
  content?: string;
  expectedVersion?: string;
}

const REMOTE_SESSION_TTL_MS = 5 * 60 * 1000;
const REMOTE_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const REMOTE_SESSION_KEEPALIVE_MS = 15 * 1000;
const MAX_OVERALL_COMMENT_LENGTH = 4_000;

let nextOpenRequestClientId = 1;

// The review round a request belongs to, as minted by `roughdraft open`.
function normalizeReviewToken(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function remoteSessionVersion(content: string): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return `${hash}:${crypto.randomUUID()}`;
}

function remoteSessionView(session: RemoteSession): {
  id: string;
  originPath: string;
  content: string;
  version: string;
} {
  return {
    id: session.id,
    originPath: session.originPath,
    content: session.content,
    version: session.version,
  };
}

function writeRemoteSessionEvent(
  response: Response,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function listMdFiles(projectDir: string): string[] {
  try {
    return fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

function titleFromContent(content: string, fallback: string): string {
  const firstLine = content.split("\n")[0] || "";
  return firstLine.replace(/^#*\s*/, "").trim() || fallback;
}

function fileVersionFromContent(
  stats: fs.Stats,
  content: string | Buffer,
): string {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  return `${stats.mtimeMs}:${stats.size}:${contentHash}`;
}

function fileVersionFromFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  const stats = fs.statSync(filePath);
  return fileVersionFromContent(stats, content);
}

function normalizeOverallComment(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function markdownPageFromFile(
  relativePath: string,
  absolutePath: string,
): {
  id: string;
  title: string;
  content: string;
  version: string;
} {
  const content = fs.readFileSync(absolutePath, "utf-8");
  const stats = fs.statSync(absolutePath);
  const fallbackTitle = path.basename(relativePath, ".md");

  return {
    id: pageIdFromRelativePath(relativePath),
    title: titleFromContent(content, fallbackTitle),
    content,
    version: fileVersionFromContent(stats, content),
  };
}

function pageIdFromRelativePath(relativePath: string): string {
  return relativePath.replace(/\.md$/i, "").split(path.sep).join("/");
}

function nextUntitledId(projectDir: string): string {
  const existing = listMdFiles(projectDir);
  let i = 1;
  while (existing.includes(`untitled-${i}`)) i++;
  return `untitled-${i}`;
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim() || "attachment";
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function ensureProjectPath(
  projectDir: string,
  relativePath: string,
): string | null {
  const normalized = relativePath.replace(/^\.?\//, "");
  const absolute = path.resolve(projectDir, normalized);
  const relative = path.relative(projectDir, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return absolute;
}

function pageFilePathFromId(projectDir: string, id: string): string | null {
  return ensureProjectPath(projectDir, `${id}.md`);
}

function nextAssetPath(projectDir: string, filename: string): string {
  const assetsDir = path.join(projectDir, ".roughdraft-assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const safeName = sanitizeFilename(filename);
  const extensionIndex = safeName.lastIndexOf(".");
  const basename =
    extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
  const extension = extensionIndex > 0 ? safeName.slice(extensionIndex) : "";

  let counter = 0;
  while (true) {
    const suffix = counter === 0 ? "" : `-${counter}`;
    const relativePath = `.roughdraft-assets/${basename}${suffix}${extension}`;
    const absolutePath = path.join(projectDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return relativePath;
    }
    counter += 1;
  }
}

function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function createApp(options: CreateAppOptions = {}): CreateAppResult {
  const port = options.port ?? ROUGHDRAFT_DEFAULT_PORT;
  const serverRoot = path.resolve(options.serverRoot ?? defaultServerRoot);
  const staticDirPath = options.staticDirPath ?? staticDir;
  const fetchImpl = options.fetchImpl ?? fetch;
  const remoteDocumentToken =
    typeof options.remoteDocumentToken === "string" &&
    options.remoteDocumentToken.length > 0
      ? options.remoteDocumentToken
      : null;
  const bindIsNonLoopback = hasNonLoopbackHost(
    options.bindHosts ?? ROUGHDRAFT_LOOPBACK_HOSTS,
  );
  const app = express();
  const openRequestClients = new Set<OpenRequestClient>();
  const reviewEvents = new ReviewEventQueue();
  const remoteSessions = new Map<string, RemoteSession>();
  const instanceId = crypto.randomUUID();

  // A tab records the instance id it loaded from. When the id it sends back
  // belongs to an earlier server, that tab is stale and must not write.
  function rejectStaleServerInstance(req: Request, res: Response): boolean {
    const suppliedInstanceId = req.body?.serverInstanceId;
    if (
      typeof suppliedInstanceId !== "string" ||
      suppliedInstanceId === instanceId
    ) {
      return false;
    }

    res.status(410).json({
      error:
        "This tab was opened by a Roughdraft server that is no longer running. Reopen the file to keep editing.",
    });
    return true;
  }

  function hasValidBearerToken(req: Request): boolean {
    if (!remoteDocumentToken) return false;

    const header =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : "";
    if (!header.startsWith("Bearer ")) return false;

    return header.slice("Bearer ".length).trim() === remoteDocumentToken;
  }

  function isAuthorizedRemoteDocumentRequest(req: Request): boolean {
    if (!remoteDocumentToken) return true;
    if (hasValidBearerToken(req)) return true;

    const acceptsQueryToken =
      req.method === "GET" &&
      req.path.startsWith("/api/remote-document/") &&
      req.path.endsWith("/events");
    const queryToken =
      acceptsQueryToken && typeof req.query.token === "string"
        ? req.query.token
        : "";
    return queryToken === remoteDocumentToken;
  }

  function rejectUnauthorizedRemoteDocumentRequest(res: Response): void {
    res.status(401).json({
      error:
        "Remote document endpoints require a valid token. Set ROUGHDRAFT_TOKEN on the client; browser event streams may include ?token=... in the URL.",
    });
  }

  const remoteSessionSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of remoteSessions) {
      if (
        session.disconnectedAt !== null &&
        now - session.disconnectedAt > REMOTE_SESSION_TTL_MS
      ) {
        remoteSessions.delete(id);
      }
    }
  }, REMOTE_SESSION_SWEEP_INTERVAL_MS);
  remoteSessionSweeper.unref?.();

  app.use(express.json({ limit: "50mb" }));

  function requestedProjectPath(req: Request): string | null {
    const queryPath =
      typeof req.query.projectPath === "string"
        ? req.query.projectPath.trim()
        : "";
    const bodyPath =
      typeof req.body?.projectPath === "string"
        ? req.body.projectPath.trim()
        : "";
    const nextPath = queryPath || bodyPath;
    return nextPath.length > 0 ? nextPath : null;
  }

  function projectDirFromRequest(
    req: Request,
    res: Response,
    options?: { mustExist?: boolean },
  ): string | null {
    const nextProjectPath = requestedProjectPath(req);
    if (!nextProjectPath) {
      res.status(400).json({ error: "projectPath is required" });
      return null;
    }

    const resolvedProjectDir = path.resolve(nextProjectPath);
    const mustExist = options?.mustExist ?? true;

    if (mustExist && !isExistingDirectory(resolvedProjectDir)) {
      res.status(404).json({ error: "Project directory not found" });
      return null;
    }

    return resolvedProjectDir;
  }

  function markdownPathFromRequest(
    req: Request,
    res: Response,
  ): { relativePath: string; absolutePath: string; projectDir: string } | null {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return null;

    const relativePath =
      typeof req.query.path === "string"
        ? req.query.path
        : typeof req.body?.path === "string"
          ? req.body.path
          : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return null;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return null;
    }

    return { relativePath, absolutePath, projectDir };
  }

  // --- Non-loopback bind guard ---

  // Every route below reads or writes a file the caller names through
  // `projectPath`, so on a bind another machine can reach, each one is a remote
  // file-read or file-write primitive. Mounted as prefixes, so subpaths such as
  // `/api/pages/:id` and `/api/markdown-file/events` are covered with the
  // parents. The remote-document routes carry their own token check and are not
  // listed here.
  const FILE_TOUCHING_ROUTE_PREFIXES = [
    "/api/pages",
    "/api/markdown-file",
    "/api/review-index",
    "/api/review-events",
    "/api/files",
    "/api/assets",
  ];

  // On the loopback default this is a pass-through, so no existing workflow
  // gains a token or a setting. On a non-loopback bind the token is required;
  // when none is configured nothing can satisfy it, and refusing every request
  // is the safe end of that.
  function requireTokenOnNonLoopbackBind(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!bindIsNonLoopback || hasValidBearerToken(req)) {
      next();
      return;
    }

    res.status(401).json({
      error:
        "Roughdraft is bound to a non-loopback address, so routes that read or write files require a token. Send Authorization: Bearer <ROUGHDRAFT_TOKEN>, or unset ROUGHDRAFT_BIND_HOST to return to the loopback-only bind.",
    });
  }

  for (const prefix of FILE_TOUCHING_ROUTE_PREFIXES) {
    app.use(prefix, requireTokenOnNonLoopbackBind);
  }

  // --- API routes ---

  app.get("/api/pages", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const ids = listMdFiles(projectDir);
    const pages = ids.map((id) => {
      const content = fs.readFileSync(
        path.join(projectDir, `${id}.md`),
        "utf-8",
      );
      return { id, title: titleFromContent(content, id), content };
    });
    res.json(pages);
  });

  app.get("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ id, title: titleFromContent(content, id), content });
  });

  app.get("/api/markdown-file", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    res.json(markdownPageFromFile(relativePath, absolutePath));
  });

  app.get("/api/markdown-file/events", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");

    const sendChange = (stats: fs.Stats) => {
      const exists = stats.nlink > 0;
      res.write(
        `event: change\ndata: ${JSON.stringify({
          path: relativePath,
          exists,
          version: exists ? fileVersionFromFile(absolutePath) : null,
        })}\n\n`,
      );
    };

    const listener = (current: fs.Stats, previous: fs.Stats) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size &&
        current.nlink === previous.nlink
      ) {
        return;
      }

      sendChange(current);
    };

    fs.watchFile(absolutePath, { interval: 500 }, listener);

    req.on("close", () => {
      fs.unwatchFile(absolutePath, listener);
    });
  });

  app.get("/api/review-index", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const markdown = fs.readFileSync(target.absolutePath, "utf-8");
    res.json({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      fileVersion: fileVersionFromFile(target.absolutePath),
      ...extractRoughdraftReviewIndex(markdown),
    });
  });

  app.post("/api/review-events", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const overallComment = normalizeOverallComment(req.body?.overallComment);
    if (
      overallComment !== undefined &&
      overallComment.length > MAX_OVERALL_COMMENT_LENGTH
    ) {
      res.status(400).json({
        error: `overallComment must be ${MAX_OVERALL_COMMENT_LENGTH} characters or fewer`,
      });
      return;
    }

    if (rejectStaleServerInstance(req, res)) return;

    const markdown = fs.readFileSync(target.absolutePath, "utf-8");
    const persistedMarkdown = overallComment
      ? appendRoughdraftDocumentComment(markdown, {
          message: overallComment,
          author: "user",
        })
      : markdown;
    if (persistedMarkdown !== markdown) {
      fs.writeFileSync(target.absolutePath, persistedMarkdown);
      recordDocumentSave(target.absolutePath);
    }

    const index = extractRoughdraftReviewIndex(persistedMarkdown);
    const result = reviewEvents.emit({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      version: fileVersionFromFile(target.absolutePath),
      summary: index.summary,
      overallComment,
    });

    res.status(201).json(result);
  });

  app.post("/api/review-events/watch", async (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const fromNow = req.body?.fromNow !== false;
    const timeoutSeconds =
      typeof req.body?.timeoutSeconds === "number"
        ? req.body.timeoutSeconds
        : undefined;
    const batchWindowSeconds =
      typeof req.body?.batchWindowSeconds === "number"
        ? req.body.batchWindowSeconds
        : 0.25;
    const afterSequence =
      typeof req.body?.afterSequence === "number" ? req.body.afterSequence : 0;
    const reviewToken = normalizeReviewToken(req.body?.reviewToken);

    const result = await reviewEvents.wait({
      documentPath: target.absolutePath,
      ...(reviewToken ? { reviewToken } : {}),
      afterSequence: fromNow ? reviewEvents.latestSequence() : afterSequence,
      timeoutMs:
        timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined,
      batchWindowMs: batchWindowSeconds * 1000,
    });

    // The CLI learns which instance it is watching from the priming poll, so
    // a later reconnect can tell a restart from a dropped connection.
    res.json({ ...result, instanceId });
  });

  app.get("/api/review-events/status", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const watcherCount = reviewEvents.waiterCountForDocument(
      target.absolutePath,
    );
    // A tab that was opened for one review round asks about that round, so it
    // hears only about the watch its own agent registered.
    const reviewToken = normalizeReviewToken(req.query.reviewToken);
    const watcherCountForReview = reviewToken
      ? reviewEvents.waiterCountForReview(target.absolutePath, reviewToken)
      : undefined;
    // The tab polls this while a document is open, so the answering instance
    // is how it learns the server was replaced while it had nothing to write.
    res.json({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      watching: watcherCount > 0,
      watcherCount,
      ...(watcherCountForReview !== undefined ? { watcherCountForReview } : {}),
      instanceId,
    });
  });

  app.put("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const { content } = req.body as { content: string };
    fs.writeFileSync(filePath, content);
    res.json({ id, title: titleFromContent(content, id), content });
  });

  app.put("/api/markdown-file", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (rejectStaleServerInstance(req, res)) return;

    const { content, expectedVersion } = req.body as {
      content: string;
      expectedVersion?: string;
    };
    const currentVersion = fileVersionFromFile(absolutePath);

    if (expectedVersion && expectedVersion !== currentVersion) {
      res.status(409).json({
        error: "Markdown file changed on disk",
        current: markdownPageFromFile(relativePath, absolutePath),
      });
      return;
    }

    // An unchanged body is not a write: rewriting it would only bump the
    // mtime and turn every other open tab's version stale.
    if (fs.readFileSync(absolutePath, "utf-8") !== content) {
      fs.writeFileSync(absolutePath, content);
      recordDocumentSave(absolutePath);
    }
    res.json(markdownPageFromFile(relativePath, absolutePath));
  });

  app.post("/api/pages", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const { title, content: bodyContent } = req.body as {
      title?: string;
      content?: string;
    };
    const id = nextUntitledId(projectDir);
    const content = bodyContent || `# ${title || "Untitled"}\n`;
    const filePath = path.join(projectDir, `${id}.md`);
    fs.writeFileSync(filePath, content);

    res.status(201).json(markdownPageFromFile(`${id}.md`, filePath));
  });

  app.delete("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    fs.unlinkSync(filePath);

    res.json({ ok: true });
  });

  function openDocuments(): OpenDocumentRecord[] {
    const documents: OpenDocumentRecord[] = [];
    for (const client of openRequestClients) {
      if (client.path === null) continue;
      documents.push({
        path: client.path,
        sessionLabel: client.sessionLabel,
        openedAt: client.openedAt,
        lastSavedAt: client.lastSavedAt,
      });
    }
    return documents;
  }

  function recordDocumentSave(absolutePath: string): void {
    const savedAt = new Date().toISOString();
    for (const client of openRequestClients) {
      if (client.path !== null && path.resolve(client.path) === absolutePath) {
        client.lastSavedAt = savedAt;
      }
    }
  }

  app.get("/api/status", (_req, res) => {
    res.json({
      backend: "local-files",
      pid: process.pid,
      instanceId,
      port,
      projectDir: options.projectDir
        ? path.resolve(options.projectDir)
        : undefined,
      serverRoot,
      stateless: true,
      documents: openDocuments(),
      capabilities: {
        projectPathRequired: true,
        remoteDocuments: true,
        remoteDocumentTokenRequired: remoteDocumentToken !== null,
      },
    });
  });

  function normalizeSessionLabel(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }

  function writeOpenRequestEvent(
    client: OpenRequestClient,
    event: {
      path: string;
      url: string;
      label: string | null;
      reviewToken: string | null;
    },
  ) {
    client.response.write(
      `event: open-request\ndata: ${JSON.stringify({
        ...event,
        instanceId,
      })}\n\n`,
    );
  }

  app.get("/api/open-requests", (req, res) => {
    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? req.query.path.trim()
        : null;
    const client: OpenRequestClient = {
      id: nextOpenRequestClientId,
      path: requestedPath,
      sessionLabel: normalizeSessionLabel(req.query.label),
      openedAt: new Date().toISOString(),
      lastSavedAt: null,
      response: res,
    };
    nextOpenRequestClientId += 1;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(
      `event: connected\ndata: ${JSON.stringify({ id: client.id })}\n\n`,
    );

    openRequestClients.add(client);
    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 15_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      openRequestClients.delete(client);
    });
  });

  app.post("/api/open-request", (req, res) => {
    const payload = req.body as OpenRequestPayload;
    const targetPath =
      typeof payload.path === "string" && payload.path.trim().length > 0
        ? payload.path.trim()
        : null;
    const targetUrl =
      typeof payload.url === "string" && payload.url.trim().length > 0
        ? payload.url.trim()
        : null;

    if (!targetPath || !targetUrl) {
      res.status(400).json({ error: "path and url are required" });
      return;
    }

    const sessionLabel = normalizeSessionLabel(payload.label);
    // The tab keeps this token until the next open replaces it, and lets only
    // the watch that carries it end the block a delivered handoff put on it.
    const reviewToken = normalizeReviewToken(payload.reviewToken);
    const event = {
      path: targetPath,
      url: targetUrl,
      label: sessionLabel,
      reviewToken,
    };
    const matchingClient = Array.from(openRequestClients)
      .reverse()
      .find((client) => client.path === targetPath);

    if (!matchingClient) {
      // No window has this document, so the CLI opens a new one. Tabs
      // reviewing other documents hear about it so they can warn instead of
      // the reviewer finding a second window stacked on theirs unannounced.
      for (const client of openRequestClients) {
        if (client.path !== null) writeOpenRequestEvent(client, event);
      }
      res.json({ delivered: false });
      return;
    }

    matchingClient.sessionLabel = sessionLabel;
    writeOpenRequestEvent(matchingClient, event);
    res.json({ delivered: true });
  });

  app.post("/api/remote-document", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const payload = req.body as RemoteDocumentRegisterPayload;
    const sessionId =
      typeof payload.sessionId === "string" &&
      payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : null;
    const originPath =
      typeof payload.originPath === "string" &&
      payload.originPath.trim().length > 0
        ? payload.originPath.trim()
        : null;
    const content =
      typeof payload.content === "string" ? payload.content : null;

    if (!sessionId || !originPath || content === null) {
      res
        .status(400)
        .json({ error: "sessionId, originPath, and content are required" });
      return;
    }

    if (remoteSessions.has(sessionId)) {
      res.status(409).json({ error: "session already exists" });
      return;
    }

    const session: RemoteSession = {
      id: sessionId,
      originPath,
      content,
      version: remoteSessionVersion(content),
      saveClient: null,
      viewers: new Set<Response>(),
      disconnectedAt: null,
    };
    remoteSessions.set(sessionId, session);

    const host = req.get("host");
    const viewerUrl =
      host !== undefined
        ? `${req.protocol}://${host}/?session=${encodeURIComponent(sessionId)}`
        : null;

    res.status(201).json({
      id: session.id,
      version: session.version,
      viewerUrl,
    });
  });

  app.get("/api/remote-document/:id", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const session = remoteSessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Remote document session not found" });
      return;
    }
    res.json(remoteSessionView(session));
  });

  app.put("/api/remote-document/:id", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const session = remoteSessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Remote document session not found" });
      return;
    }

    const payload = req.body as RemoteDocumentSavePayload;
    const content =
      typeof payload.content === "string" ? payload.content : null;

    if (content === null) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    if (
      typeof payload.expectedVersion === "string" &&
      payload.expectedVersion !== session.version
    ) {
      res.status(409).json({
        error: "Remote document changed",
        current: remoteSessionView(session),
      });
      return;
    }

    session.content = content;
    session.version = remoteSessionVersion(content);

    let deliveredToClient = true;
    if (session.saveClient) {
      try {
        writeRemoteSessionEvent(session.saveClient, "save", {
          content: session.content,
          version: session.version,
        });
      } catch {
        deliveredToClient = false;
        session.saveClient = null;
        session.disconnectedAt = Date.now();
      }
    } else {
      deliveredToClient = false;
    }

    if (!deliveredToClient) {
      res.status(503).json({
        error: "No active CLI session; save not delivered to disk.",
        version: session.version,
      });
      return;
    }

    res.json({ id: session.id, version: session.version });
  });

  app.get("/api/remote-document/:id/events", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const session = remoteSessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Remote document session not found" });
      return;
    }

    const role = req.query.role === "viewer" ? "viewer" : "cli";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (role === "cli") {
      if (session.saveClient) {
        session.saveClient.end();
      }

      session.saveClient = res;
      session.disconnectedAt = null;

      writeRemoteSessionEvent(res, "connected", {
        id: session.id,
        role,
        version: session.version,
      });
      for (const viewer of session.viewers) {
        writeRemoteSessionEvent(viewer, "connected", {
          id: session.id,
          role: "viewer",
          version: session.version,
        });
      }
    } else {
      session.viewers.add(res);
      writeRemoteSessionEvent(
        res,
        session.saveClient ? "connected" : "disconnected",
        {
          id: session.id,
          role,
          version: session.version,
        },
      );
    }

    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, REMOTE_SESSION_KEEPALIVE_MS);

    req.on("close", () => {
      clearInterval(keepAlive);
      if (role === "cli" && session.saveClient === res) {
        session.saveClient = null;
        session.disconnectedAt = Date.now();
        for (const viewer of session.viewers) {
          writeRemoteSessionEvent(viewer, "disconnected", {
            id: session.id,
            role: "viewer",
            version: session.version,
          });
        }
      } else if (role === "viewer") {
        session.viewers.delete(res);
      }
    });
  });

  app.get("/api/update-status", async (_req, res) => {
    const updateStatus = await resolveUpdateStatus({
      fetchImpl,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
    });
    res.json(updateStatus);
  });

  app.get("/api/files", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    res.sendFile(absolutePath);
  });

  app.post("/api/assets", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const payload = req.body as AssetPayload;
    if (!payload.filename || !payload.dataBase64) {
      res.status(400).json({ error: "filename and dataBase64 are required" });
      return;
    }

    const relativePath = nextAssetPath(projectDir, payload.filename);
    const absolutePath = ensureProjectPath(projectDir, relativePath);
    if (!absolutePath) {
      res.status(400).json({ error: "Invalid asset path" });
      return;
    }

    const buffer = Buffer.from(payload.dataBase64, "base64");
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, buffer);

    res.status(201).json({
      markdownPath: `./${relativePath}`,
      previewUrl: `/api/files?projectPath=${encodeURIComponent(projectDir)}&path=${encodeURIComponent(relativePath)}`,
      mimeType: payload.mimeType || "application/octet-stream",
    });
  });

  // --- Static files & SPA fallback ---

  app.use(express.static(staticDirPath));

  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(staticDirPath, "index.html"));
  });

  return { app, port };
}

export async function createServer(
  port = ROUGHDRAFT_DEFAULT_PORT,
  projectDir?: string,
): Promise<void> {
  const bindHosts = resolveBindHosts();
  const remoteDocumentToken = process.env[ROUGHDRAFT_TOKEN_ENV] ?? "";

  if (hasNonLoopbackHost(bindHosts) && remoteDocumentToken.length === 0) {
    throw new Error(
      [
        `Roughdraft refuses to bind ${bindHosts.join(", ")} without a token.`,
        "Non-loopback bindings expose every route that reads or writes files on",
        "this host, including the remote-document endpoints. Set ROUGHDRAFT_TOKEN",
        "to a strong secret and pass the same value to your CLI before retrying,",
        "or remove ROUGHDRAFT_BIND_HOST to keep loopback-only.",
      ].join(" "),
    );
  }

  const { app } = createApp({
    port,
    projectDir,
    bindHosts,
    remoteDocumentToken:
      remoteDocumentToken.length > 0 ? remoteDocumentToken : undefined,
  });
  const listeningHosts: string[] = [];

  await Promise.all(
    bindHosts.map(
      (host) =>
        new Promise<void>((resolve, reject) => {
          const server = createHttpServer(app);

          server.once("error", (error: NodeJS.ErrnoException) => {
            if (
              error.code === "EAFNOSUPPORT" ||
              error.code === "EADDRNOTAVAIL"
            ) {
              resolve();
              return;
            }

            reject(error);
          });

          server.listen(port, host, () => {
            listeningHosts.push(host);
            resolve();
          });
        }),
    ),
  );

  if (listeningHosts.length === 0) {
    throw new Error(
      `Roughdraft could not bind to any host (tried: ${bindHosts.join(", ")}).`,
    );
  }

  console.log(
    `\n  Roughdraft running at http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`,
  );
  console.log("  No active project is stored on the server.\n");
}
