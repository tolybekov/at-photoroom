import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PHOTO_DIR = path.join(PUBLIC_DIR, "photos");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "photos.json");
const PORT = Number(process.env.PORT || 4173);
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;
const ADMIN_PASSWORD = process.env.ALBUM_ADMIN_PASSWORD || "at-photoroom";
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml; charset=utf-8"
};
const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/avif", ".avif"],
  ["image/svg+xml", ".svg"]
]);

await mkdir(PHOTO_DIR, { recursive: true });
await mkdir(DATA_DIR, { recursive: true });
await ensureDataFile();

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await routeApi(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal_error" });
  }
});

server.listen(PORT, () => {
  console.log(`AT Photoroom is running at http://localhost:${PORT}`);
  if (!process.env.ALBUM_ADMIN_PASSWORD) {
    console.log("Owner password: at-photoroom");
  }
});

async function routeApi(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/session") {
    sendJson(res, 200, { authenticated: isAuthenticated(req) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const { password } = await readJsonBody(req);
    if (typeof password !== "string" || password !== ADMIN_PASSWORD) {
      sendJson(res, 401, { error: "invalid_password" });
      return;
    }

    sendJson(res, 200, { authenticated: true }, { "Set-Cookie": makeSessionCookie() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    sendJson(res, 200, { authenticated: false }, { "Set-Cookie": expireSessionCookie() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/photos") {
    sendJson(res, 200, { photos: await readPhotos(), authenticated: isAuthenticated(req) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/photos") {
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { error: "not_authenticated" });
      return;
    }

    await handleUpload(req, res);
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/photos\/([A-Za-z0-9_-]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { error: "not_authenticated" });
      return;
    }

    await deletePhoto(deleteMatch[1]);
    sendJson(res, 200, { ok: true, photos: await readPhotos() });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function handleUpload(req, res) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, { error: "file_too_large" });
    return;
  }

  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half"
  });
  const formData = await request.formData();
  const file = formData.get("photo");

  if (!(file instanceof File) || file.size === 0) {
    sendJson(res, 400, { error: "missing_photo" });
    return;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, { error: "file_too_large" });
    return;
  }

  const extension = IMAGE_EXTENSIONS.get(file.type) || extensionFromName(file.name);
  if (!extension) {
    sendJson(res, 415, { error: "unsupported_image" });
    return;
  }

  const id = randomUUID();
  const filename = `${Date.now()}-${id.slice(0, 8)}${extension}`;
  const destination = path.join(PHOTO_DIR, filename);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(destination, bytes);

  const photos = await readPhotos();
  const title = cleanText(formData.get("title")) || nameWithoutExtension(file.name) || "Untitled";
  const photo = {
    id,
    title,
    place: cleanText(formData.get("place")),
    date: cleanText(formData.get("date")),
    note: cleanText(formData.get("note")),
    src: `/photos/${filename}`,
    uploadedAt: new Date().toISOString()
  };

  photos.unshift(photo);
  await writePhotos(photos);
  sendJson(res, 201, { photo, photos });
}

async function deletePhoto(id) {
  const photos = await readPhotos();
  const target = photos.find((photo) => photo.id === id);
  const nextPhotos = photos.filter((photo) => photo.id !== id);
  await writePhotos(nextPhotos);

  if (target?.src?.startsWith("/photos/")) {
    const photoPath = path.join(PHOTO_DIR, path.basename(target.src));
    await unlink(photoPath).catch(() => undefined);
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const requestedPath = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relativePath = path.relative(PUBLIC_DIR, requestedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const fileStat = await stat(requestedPath).catch(() => null);
  if (!fileStat?.isFile()) {
    const fallbackPath = path.join(PUBLIC_DIR, "index.html");
    streamFile(res, fallbackPath);
    return;
  }

  streamFile(res, requestedPath);
}

function streamFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const cacheControl = extension === ".html" || path.basename(filePath) === "photos.json"
    ? "no-store"
    : "public, max-age=3600";
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "Cache-Control": cacheControl
  });
  createReadStream(filePath).pipe(res);
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) {
      throw new Error("JSON body is too large");
    }
  }
  return body ? JSON.parse(body) : {};
}

async function ensureDataFile() {
  await readFile(DATA_FILE, "utf8").catch(async () => {
    await writeFile(DATA_FILE, "[]\n");
  });
}

async function readPhotos() {
  const raw = await readFile(DATA_FILE, "utf8");
  const photos = JSON.parse(raw);
  return Array.isArray(photos) ? photos : [];
}

async function writePhotos(photos) {
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(photos, null, 2)}\n`);
  await rename(tempFile, DATA_FILE);
  await writeStaticManifest(photos);
}

async function writeStaticManifest(photos) {
  const staticPhotos = photos.map((photo) => ({
    ...photo,
    src: typeof photo.src === "string" ? photo.src.replace(/^\/+/, "") : photo.src
  }));
  const manifest = {
    photos: staticPhotos,
    generatedAt: new Date().toISOString()
  };
  await writeFile(path.join(PUBLIC_DIR, "photos.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function makeSessionCookie() {
  const payload = JSON.stringify({
    exp: Date.now() + 1000 * 60 * 60 * 24 * 14,
    nonce: randomBytes(8).toString("hex")
  });
  const token = `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
  return `at_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`;
}

function expireSessionCookie() {
  return "at_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

function isAuthenticated(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((cookie) => {
      const [key, ...value] = cookie.trim().split("=");
      return [key, value.join("=")];
    })
  );
  const token = cookies.at_session;
  if (!token) return false;

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return false;

  let payload;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    return false;
  }

  const expected = sign(payload);
  if (!safeEqual(signature, expected)) return false;

  try {
    const parsed = JSON.parse(payload);
    return Number(parsed.exp) > Date.now();
  } catch {
    return false;
  }
}

function sign(payload) {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function extensionFromName(name = "") {
  const extension = path.extname(name).toLowerCase();
  return [...IMAGE_EXTENSIONS.values()].includes(extension) ? extension : "";
}

function nameWithoutExtension(name = "") {
  return path.basename(name, path.extname(name)).replace(/[-_]+/g, " ").trim();
}
