import "dotenv/config";
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { closeFirestore, initializeFirestore } from "./firebase-storage.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const assetDirectory = join(root, "assets");
const productImageDirectory = join(root, "File_Anh_WebCNC");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const maxBodyBytes = 10 * 1024 * 1024;

let firestore = null;

async function initializeStorage() {
  const firebaseConfigured = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
  if (!firebaseConfigured) {
    throw new Error("Configure Firebase Firestore in .env before starting the application.");
  }
  firestore = await initializeFirestore();
  await firestore.collection("app_state").limit(1).get();
  console.log(`Firebase Firestore connected: ${process.env.FIREBASE_PROJECT_ID || "project from service account"}`);
}

async function getStateRecord() {
  const snapshot = await firestore.collection("app_state").doc("main").get();
  if (!snapshot.exists) return { state: null, updatedAt: null, revision: 0 };
  const record = snapshot.data();
  return { state: JSON.parse(record.payload), updatedAt: record.updatedAt, revision: record.revision };
}

async function saveStateRecord(payload, expectedRevision) {
  const nextRevision = expectedRevision + 1;
  const updatedAt = new Date().toISOString();
  const stateRef = firestore.collection("app_state").doc("main");
  return firestore.runTransaction(async transaction => {
    const current = await transaction.get(stateRef);
    const currentRevision = current.exists ? current.get("revision") ?? 0 : 0;
    if (currentRevision !== expectedRevision) return null;
    transaction.set(stateRef, {
      payload: JSON.stringify(payload),
      revision: nextRevision,
      updatedAt,
      updatedBy: "public"
    });
    return { revision: nextRevision, updatedAt };
  });
}

function sendJson(response, status, value, headers = {}) {
  const origin = corsOriginForRequest(response.req);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    request.on("data", chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        rejectBody(new Error("Request body exceeds the allowed size."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

function requestIsSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (origin === "null") return isLoopbackAddress(request.socket.remoteAddress);
  const protocol = request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted ? "https" : "http";
  return origin === `${protocol}://${request.headers.host}`;
}

function corsOriginForRequest(request) {
  const origin = request?.headers?.origin;
  if (origin === "null") return isLoopbackAddress(request.socket.remoteAddress) ? origin : null;
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin || "") ? origin : null;
}

function isLoopbackAddress(address) {
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function serveIndex(response) {
  const indexPath = resolve(root, "index.html");
  if (!existsSync(indexPath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("index.html not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  });
  createReadStream(indexPath).pipe(response);
}

function serveAsset(pathname, response) {
  let assetPath;
  try {
    assetPath = resolve(assetDirectory, decodeURIComponent(pathname.slice("/assets/".length)));
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid asset path");
    return;
  }
  const assetRelativePath = relative(assetDirectory, assetPath);
  const contentType = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  }[extname(assetPath).toLowerCase()];
  if (!assetRelativePath || assetRelativePath === ".." ||
      assetRelativePath.startsWith(`..${sep}`) || isAbsolute(assetRelativePath) ||
      !contentType || !existsSync(assetPath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  const stream = createReadStream(assetPath);
  stream.on("error", error => {
    console.error("Could not read application asset:", error);
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Could not read application asset");
    }
  });
  stream.pipe(response);
}

function serveProductImage(pathname, response) {
  let filename;
  const prefix = pathname.startsWith("/product-images/")
    ? "/product-images/"
    : "/File_Anh_WebCNC/";
  try {
    filename = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid image path");
    return;
  }
  const contentType = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  }[extname(filename).toLowerCase()];
  if (!filename || basename(filename) !== filename || !contentType) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const imagePath = join(productImageDirectory, filename);
  if (!existsSync(imagePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff"
  });
  const stream = createReadStream(imagePath);
  stream.on("error", error => {
    console.error("Could not read product image:", error);
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Could not read product image");
    }
  });
  stream.pipe(response);
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    const origin = corsOriginForRequest(request);
    response.writeHead(204, {
      ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600"
    });
    response.end();
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    serveIndex(response);
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    serveAsset(url.pathname, response);
    return;
  }
  if (request.method === "GET" && (url.pathname.startsWith("/product-images/") || url.pathname.startsWith("/File_Anh_WebCNC/"))) {
    serveProductImage(url.pathname, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, storageMode: "firestore" });
    return;
  }

  if (url.pathname === "/api/state" && request.method === "GET") {
    try {
      sendJson(response, 200, await getStateRecord());
    } catch (error) {
      console.error("Could not read the application state:", error);
      sendJson(response, 500, { error: "Không thể đọc dữ liệu đã lưu." });
    }
    return;
  }

  if (url.pathname === "/api/state" && request.method === "POST") {
    if (!requestIsSameOrigin(request)) {
      sendJson(response, 403, { error: "Yêu cầu không hợp lệ." });
      return;
    }
    try {
      const body = parseJsonBody(await readRequestBody(request));
      const payload = body?.state;
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.plans) ||
          !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
        sendJson(response, 400, { error: "Dữ liệu cập nhật không hợp lệ." });
        return;
      }
      const saved = await saveStateRecord(payload, body.expectedRevision);
      if (!saved) {
        sendJson(response, 409, { error: "Dữ liệu đã được cập nhật trên thiết bị khác. Tải lại trang để nhận bản mới nhất." });
        return;
      }
      sendJson(response, 200, { saved: true, ...saved });
    } catch (error) {
      if (!response.destroyed) {
        console.error("Could not save the application state:", error);
        sendJson(response, 500, { error: "Không thể lưu dữ liệu." });
      }
    }
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

const server = createServer((request, response) => {
  response.req = request;
  handleRequest(request, response).catch(error => {
    console.error("Request failed:", error);
    if (!response.headersSent && !response.destroyed) {
      sendJson(response, 500, { error: "Máy chủ gặp lỗi khi xử lý yêu cầu." });
    } else if (!response.destroyed) {
      response.destroy();
    }
  });
});

await initializeStorage();
server.listen(port, host, () => {
  console.log(`FORGE CNC is running at http://${host}:${port}`);
  console.log(`Firebase Firestore project: ${process.env.FIREBASE_PROJECT_ID || "project from service account"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await closeFirestore();
      process.exit(0);
    });
  });
}
