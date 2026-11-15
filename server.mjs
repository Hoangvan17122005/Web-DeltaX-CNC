import "dotenv/config";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { MongoClient } from "mongodb";
import { closeFirestore, initializeFirestore } from "./firebase-storage.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(root, "data");
const productImageDirectory = join(root, "File_Anh_WebCNC");
const databasePath = process.env.DATABASE_PATH
  ? resolve(process.env.DATABASE_PATH)
  : join(dataDirectory, "forge.sqlite");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const adminEmail = String(process.env.ADMIN_EMAIL || "hoangnguyenkhac1712@gmail.com").trim().toLowerCase();
const adminBootstrapCode = process.env.ADMIN_BOOTSTRAP_CODE || randomBytes(24).toString("base64url");
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const maxBodyBytes = 10 * 1024 * 1024;
const scryptAsync = promisify(scrypt);

mkdirSync(dirname(databasePath), { recursive: true });

const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
    edit_request_status TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL,
    edit_requested_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
`);

const stateColumns = database.prepare("PRAGMA table_info(app_state)").all().map(column => column.name);
if (!stateColumns.includes("revision")) {
  database.exec("ALTER TABLE app_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
}
if (!stateColumns.includes("updated_by")) {
  database.exec("ALTER TABLE app_state ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''");
}

const readLocalState = database.prepare("SELECT payload, updated_at, revision FROM app_state WHERE id = 1");
const writeLocalState = database.prepare(`
  INSERT INTO app_state (id, payload, updated_at, revision, updated_by)
  VALUES (1, ?, CURRENT_TIMESTAMP, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    payload = excluded.payload,
    updated_at = excluded.updated_at,
    revision = excluded.revision,
    updated_by = excluded.updated_by
`);

let mongoClient = null;
let mongoDb = null;
let collections = null;
let firestore = null;

function storageMode() {
  if (firestore) return "firestore";
  if (collections) return "mongodb";
  return "sqlite";
}

async function initializeStorage() {
  const firebaseConfigured = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
  if (process.env.MONGODB_URI && firebaseConfigured) {
    throw new Error("Configure only one cloud storage provider: MongoDB or Firebase Firestore.");
  }
  if (process.env.MONGODB_URI) {
    mongoClient = new MongoClient(process.env.MONGODB_URI, {
      appName: "FORGE-CNC",
      serverSelectionTimeoutMS: 10000
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db(process.env.MONGODB_DB || "forge_cnc");
    collections = {
      state: mongoDb.collection("app_state"),
      users: mongoDb.collection("users"),
      sessions: mongoDb.collection("sessions")
    };
    await collections.users.createIndex({ emailNormalized: 1 }, { unique: true });
    await collections.sessions.createIndex({ expiresAt: 1 });
    console.log(`MongoDB connected: ${mongoDb.databaseName}`);
    return;
  }
  if (firebaseConfigured) {
    firestore = await initializeFirestore();
    await firestore.collection("app_state").limit(1).get();
    console.log(`Firebase Firestore connected: ${process.env.FIREBASE_PROJECT_ID || "project from service account"}`);
  }
}

function normalizeUser(row) {
  if (!row) return null;
  return {
    id: row.id || row._id,
    email: row.email,
    passwordSalt: row.passwordSalt ?? row.password_salt,
    passwordHash: row.passwordHash ?? row.password_hash,
    role: row.role,
    editRequestStatus: row.editRequestStatus ?? row.edit_request_status ?? "none",
    createdAt: row.createdAt ?? row.created_at,
    editRequestedAt: row.editRequestedAt ?? row.edit_requested_at ?? null
  };
}

function emailDocumentId(email) {
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    editRequestStatus: user.editRequestStatus,
    createdAt: user.createdAt,
    editRequestedAt: user.editRequestedAt
  };
}

async function findUserByEmail(email) {
  if (collections) {
    return normalizeUser(await collections.users.findOne({ emailNormalized: email }));
  }
  if (firestore) {
    const emailRef = firestore.collection("user_emails").doc(emailDocumentId(email));
    const emailSnapshot = await emailRef.get();
    return emailSnapshot.exists ? findUserById(emailSnapshot.get("userId")) : null;
  }
  return normalizeUser(database.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email));
}

async function findUserById(id) {
  if (collections) return normalizeUser(await collections.users.findOne({ _id: id }));
  if (firestore) {
    const snapshot = await firestore.collection("users").doc(id).get();
    return snapshot.exists ? normalizeUser({ id: snapshot.id, ...snapshot.data() }) : null;
  }
  return normalizeUser(database.prepare("SELECT * FROM users WHERE id = ?").get(id));
}

async function hasAdmin() {
  if (collections) return Boolean(await collections.users.findOne({ role: "admin" }, { projection: { _id: 1 } }));
  if (firestore) {
    const snapshot = await firestore.collection("users").where("role", "==", "admin").limit(1).get();
    return !snapshot.empty;
  }
  return Boolean(database.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get());
}

async function insertUser(user) {
  if (collections) {
    await collections.users.insertOne({
      _id: user.id,
      email: user.email,
      emailNormalized: user.email.toLowerCase(),
      passwordSalt: user.passwordSalt,
      passwordHash: user.passwordHash,
      role: user.role,
      editRequestStatus: user.editRequestStatus,
      createdAt: user.createdAt,
      editRequestedAt: null
    });
    return;
  }
  if (firestore) {
    const userRef = firestore.collection("users").doc(user.id);
    const emailRef = firestore.collection("user_emails").doc(emailDocumentId(user.email));
    await firestore.runTransaction(async transaction => {
      const emailSnapshot = await transaction.get(emailRef);
      if (emailSnapshot.exists) {
        const error = new Error("Email already exists.");
        error.code = "already-exists";
        throw error;
      }
      transaction.create(emailRef, { userId: user.id, emailNormalized: user.email.toLowerCase() });
      transaction.create(userRef, {
        email: user.email,
        emailNormalized: user.email.toLowerCase(),
        passwordSalt: user.passwordSalt,
        passwordHash: user.passwordHash,
        role: user.role,
        editRequestStatus: user.editRequestStatus,
        createdAt: user.createdAt,
        editRequestedAt: null
      });
    });
    return;
  }
  database.prepare(`
    INSERT INTO users (id, email, password_salt, password_hash, role, edit_request_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, user.email, user.passwordSalt, user.passwordHash, user.role, user.editRequestStatus, user.createdAt);
}

async function updateUser(userId, changes) {
  if (collections) {
    const result = await collections.users.updateOne({ _id: userId }, { $set: changes });
    return result.matchedCount === 1;
  }
  if (firestore) {
    const userRef = firestore.collection("users").doc(userId);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return false;
    await userRef.update(changes);
    return true;
  }
  const allowedFields = {
    role: "role",
    editRequestStatus: "edit_request_status",
    editRequestedAt: "edit_requested_at"
  };
  const entries = Object.entries(changes).filter(([key]) => allowedFields[key]);
  if (!entries.length) return false;
  const assignments = entries.map(([key]) => `${allowedFields[key]} = ?`).join(", ");
  const result = database.prepare(`UPDATE users SET ${assignments} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), userId);
  return result.changes === 1;
}

async function listUsersForAccess() {
  if (collections) {
    const users = await collections.users.find(
      { $or: [{ role: "editor" }, { editRequestStatus: "pending" }] },
      { projection: { passwordSalt: 0, passwordHash: 0, emailNormalized: 0 } }
    ).sort({ createdAt: 1 }).toArray();
    return users.map(normalizeUser).map(publicUser);
  }
  if (firestore) {
    const usersCollection = firestore.collection("users");
    const [editors, pending] = await Promise.all([
      usersCollection.where("role", "==", "editor").get(),
      usersCollection.where("editRequestStatus", "==", "pending").get()
    ]);
    const usersById = new Map();
    for (const document of [...editors.docs, ...pending.docs]) {
      usersById.set(document.id, normalizeUser({ id: document.id, ...document.data() }));
    }
    return [...usersById.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicUser);
  }
  return database.prepare(`
    SELECT id, email, role, edit_request_status, created_at, edit_requested_at
    FROM users
    WHERE role = 'editor' OR edit_request_status = 'pending'
    ORDER BY created_at ASC
  `).all().map(normalizeUser).map(publicUser);
}

async function setEditRequest(userId, status) {
  const editRequestedAt = status === "pending" ? new Date().toISOString() : null;
  return updateUser(userId, { editRequestStatus: status, editRequestedAt });
}

async function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const expiresAt = now + sessionLifetimeMs;
  if (collections) {
    await collections.sessions.deleteMany({ expiresAt: { $lte: now } });
    await collections.sessions.insertOne({ tokenHash, userId, expiresAt, createdAt: now });
  } else if (firestore) {
    const expiredSessions = await firestore.collection("sessions").where("expiresAt", "<=", now).limit(450).get();
    if (!expiredSessions.empty) {
      const batch = firestore.batch();
      expiredSessions.docs.forEach(document => batch.delete(document.ref));
      await batch.commit();
    }
    await firestore.collection("sessions").doc(tokenHash).create({
      userId,
      expiresAt,
      createdAt: new Date(now).toISOString()
    });
  } else {
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, userId, expiresAt, new Date(now).toISOString());
  }
  return { token, expiresAt };
}

async function findSession(token) {
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  let session;
  if (collections) {
    session = await collections.sessions.findOne({ tokenHash, expiresAt: { $gt: now } });
  } else if (firestore) {
    const sessionRef = firestore.collection("sessions").doc(tokenHash);
    const snapshot = await sessionRef.get();
    session = snapshot.exists && snapshot.get("expiresAt") > now
      ? snapshot.data()
      : null;
    if (snapshot.exists && !session) await sessionRef.delete();
  } else {
    session = database.prepare("SELECT user_id AS userId FROM sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, now);
  }
  return session ? findUserById(session.userId ?? session.user_id) : null;
}

async function deleteSession(token) {
  if (!token) return;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  if (collections) await collections.sessions.deleteOne({ tokenHash });
  else if (firestore) await firestore.collection("sessions").doc(tokenHash).delete();
  else database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

async function getStateRecord() {
  if (collections) {
    const row = await collections.state.findOne({ _id: "main" });
    return row
      ? { state: JSON.parse(row.payload), updatedAt: row.updatedAt, revision: row.revision }
      : { state: null, updatedAt: null, revision: 0 };
  }
  if (firestore) {
    const snapshot = await firestore.collection("app_state").doc("main").get();
    if (!snapshot.exists) return { state: null, updatedAt: null, revision: 0 };
    const row = snapshot.data();
    return { state: JSON.parse(row.payload), updatedAt: row.updatedAt, revision: row.revision };
  }
  const row = readLocalState.get();
  return row
    ? { state: JSON.parse(row.payload), updatedAt: row.updated_at, revision: row.revision }
    : { state: null, updatedAt: null, revision: 0 };
}

async function saveStateRecord(payload, expectedRevision, email) {
  const nextRevision = expectedRevision + 1;
  const updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(payload);
  if (collections) {
    const current = await collections.state.findOne({ _id: "main" }, { projection: { revision: 1 } });
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) return null;
    if (!current) {
      try {
        await collections.state.insertOne({
          _id: "main", payload: serialized, revision: nextRevision, updatedAt, updatedBy: email
        });
      } catch (error) {
        if (error?.code === 11000) return null;
        throw error;
      }
    } else {
      const result = await collections.state.updateOne(
        { _id: "main", revision: expectedRevision },
        { $set: { payload: serialized, revision: nextRevision, updatedAt, updatedBy: email } }
      );
      if (result.matchedCount !== 1) return null;
    }
    return { revision: nextRevision, updatedAt };
  }
  if (firestore) {
    const stateRef = firestore.collection("app_state").doc("main");
    return firestore.runTransaction(async transaction => {
      const current = await transaction.get(stateRef);
      const currentRevision = current.exists ? current.get("revision") ?? 0 : 0;
      if (currentRevision !== expectedRevision) return null;
      transaction.set(stateRef, {
        payload: serialized,
        revision: nextRevision,
        updatedAt,
        updatedBy: email
      });
      return { revision: nextRevision, updatedAt };
    });
  }
  const row = readLocalState.get();
  const currentRevision = row?.revision ?? 0;
  if (currentRevision !== expectedRevision) return null;
  writeLocalState.run(serialized, nextRevision, email);
  return { revision: nextRevision, updatedAt };
}

function sendJson(response, status, value, headers = {}) {
  const origin = response.req?.headers?.origin;
  const allowedOrigin = origin === "null" || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin || "");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
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

function parseCookies(request) {
  const cookieHeader = request.headers.cookie || "";
  return Object.fromEntries(cookieHeader.split(";").map(cookie => {
    const separator = cookie.indexOf("=");
    return separator < 0
      ? [cookie.trim(), ""]
      : [cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

function sessionCookie(request, token, maxAge) {
  const secure = process.env.NODE_ENV === "production" || request.headers["x-forwarded-proto"] === "https";
  return `forge_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function requestIsSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const protocol = request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted ? "https" : "http";
  return origin === `${protocol}://${request.headers.host}`;
}

function isLoopbackAddress(address) {
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

const authAttempts = new Map();
function authRateLimited(request) {
  const key = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (authAttempts.get(key) || []).filter(timestamp => now - timestamp < 15 * 60 * 1000);
  recent.push(now);
  authAttempts.set(key, recent);
  return recent.length > 10;
}

async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = await scryptAsync(password, salt, 64);
  return { salt, hash: derived.toString("hex") };
}

async function passwordMatches(password, user) {
  const derived = await scryptAsync(password, user.passwordSalt, 64);
  const expected = Buffer.from(user.passwordHash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function validEmail(email) {
  return typeof email === "string" && email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

async function authenticatedUser(request) {
  const token = parseCookies(request).forge_session;
  return findSession(token);
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
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
  if (request.method === "GET" && (url.pathname.startsWith("/product-images/") || url.pathname.startsWith("/File_Anh_WebCNC/"))) {
    serveProductImage(url.pathname, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, storageMode: storageMode() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/setup") {
    const requiresAdminSetup = !(await hasAdmin());
    sendJson(response, 200, {
      adminEmail,
      requiresAdminSetup,
      localBootstrapCode: isLoopbackAddress(request.socket.remoteAddress) && requiresAdminSetup
        ? adminBootstrapCode : null,
      storageMode: storageMode()
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    const user = await authenticatedUser(request);
    sendJson(response, 200, { user: user ? publicUser(user) : null, storageMode: storageMode() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    if (!requestIsSameOrigin(request)) {
      sendJson(response, 403, { error: "Yêu cầu không hợp lệ." });
      return;
    }
    if (authRateLimited(request)) {
      sendJson(response, 429, { error: "Bạn thử quá nhiều lần. Vui lòng chờ 15 phút rồi thử lại." });
      return;
    }
    const body = parseJsonBody(await readRequestBody(request));
    if (!body || !validEmail(body.email) || typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128) {
      sendJson(response, 400, { error: "Email không hợp lệ hoặc mật khẩu phải có ít nhất 8 ký tự." });
      return;
    }
    const email = body.email.trim().toLowerCase();
    const alreadyAdmin = await hasAdmin();
    const isAdminAddress = email === adminEmail;
    if (isAdminAddress && alreadyAdmin) {
      sendJson(response, 409, { error: "Email quản trị viên này đã được đăng ký." });
      return;
    }
    if (isAdminAddress && body.adminCode !== adminBootstrapCode) {
      sendJson(response, 403, { error: "Mã thiết lập quản trị không đúng." });
      return;
    }
    const password = await hashPassword(body.password);
    const user = {
      id: randomBytes(16).toString("hex"),
      email,
      passwordSalt: password.salt,
      passwordHash: password.hash,
      role: isAdminAddress ? "admin" : "viewer",
      editRequestStatus: "none",
      createdAt: new Date().toISOString()
    };
    try {
      await insertUser(user);
    } catch (error) {
      if (error?.code === 11000 || error?.code === 6 || error?.code === "already-exists" ||
          String(error?.code || "").startsWith("ERR_SQLITE_CONSTRAINT")) {
        sendJson(response, 409, { error: "Email này đã có tài khoản." });
        return;
      }
      throw error;
    }
    const session = await createSession(user.id);
    sendJson(response, 201, { user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(request, session.token, Math.floor(sessionLifetimeMs / 1000))
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    if (!requestIsSameOrigin(request)) {
      sendJson(response, 403, { error: "Yêu cầu không hợp lệ." });
      return;
    }
    if (authRateLimited(request)) {
      sendJson(response, 429, { error: "Bạn thử quá nhiều lần. Vui lòng chờ 15 phút rồi thử lại." });
      return;
    }
    const body = parseJsonBody(await readRequestBody(request));
    if (!body || !validEmail(body.email) || typeof body.password !== "string") {
      sendJson(response, 400, { error: "Vui lòng nhập email và mật khẩu hợp lệ." });
      return;
    }
    const user = await findUserByEmail(body.email.trim().toLowerCase());
    if (!user) await scryptAsync(body.password, "forge-cnc-login-dummy-salt", 64);
    if (!user || !(await passwordMatches(body.password, user))) {
      sendJson(response, 401, { error: "Email hoặc mật khẩu không đúng." });
      return;
    }
    const session = await createSession(user.id);
    sendJson(response, 200, { user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(request, session.token, Math.floor(sessionLifetimeMs / 1000))
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = parseCookies(request).forge_session;
    await deleteSession(token);
    sendJson(response, 200, { signedOut: true }, {
      "Set-Cookie": sessionCookie(request, "", 0)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/access-request") {
    if (!requestIsSameOrigin(request)) {
      sendJson(response, 403, { error: "Yêu cầu không hợp lệ." });
      return;
    }
    const user = await authenticatedUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Vui lòng đăng nhập lại." });
      return;
    }
    if (user.role !== "viewer") {
      sendJson(response, 409, { error: "Tài khoản này đã có quyền chỉnh sửa hoặc đang chờ xử lý." });
      return;
    }
    if (user.editRequestStatus === "pending") {
      sendJson(response, 409, { error: "Yêu cầu chỉnh sửa của bạn đang chờ duyệt." });
      return;
    }
    await setEditRequest(user.id, "pending");
    sendJson(response, 200, { requested: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/access-requests") {
    const user = await authenticatedUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Vui lòng đăng nhập lại." });
      return;
    }
    if (user.role !== "admin") {
      sendJson(response, 403, { error: "Chỉ quản trị viên mới được quản lý quyền truy cập." });
      return;
    }
    sendJson(response, 200, { users: await listUsersForAccess() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/access-requests") {
    if (!requestIsSameOrigin(request)) {
      sendJson(response, 403, { error: "Yêu cầu không hợp lệ." });
      return;
    }
    const admin = await authenticatedUser(request);
    if (!admin || admin.role !== "admin") {
      sendJson(response, admin ? 403 : 401, { error: "Chỉ quản trị viên mới được quản lý quyền truy cập." });
      return;
    }
    const body = parseJsonBody(await readRequestBody(request));
    if (!body || typeof body.userId !== "string" || !["approve", "reject", "revoke"].includes(body.action)) {
      sendJson(response, 400, { error: "Thao tác quyền truy cập không hợp lệ." });
      return;
    }
    const target = await findUserById(body.userId);
    if (!target || target.role === "admin") {
      sendJson(response, 404, { error: "Không tìm thấy tài khoản cần cập nhật." });
      return;
    }
    if (body.action === "approve" && target.editRequestStatus !== "pending") {
      sendJson(response, 409, { error: "Yêu cầu này không còn ở trạng thái chờ duyệt." });
      return;
    }
    const changes = body.action === "approve"
      ? { role: "editor", editRequestStatus: "approved", editRequestedAt: null }
      : body.action === "reject"
        ? { role: "viewer", editRequestStatus: "rejected", editRequestedAt: null }
        : { role: "viewer", editRequestStatus: "none", editRequestedAt: null };
    if (!(await updateUser(target.id, changes))) {
      sendJson(response, 404, { error: "Không thể cập nhật tài khoản." });
      return;
    }
    sendJson(response, 200, { updated: true });
    return;
  }

  if (url.pathname === "/api/state" && request.method === "GET") {
    const user = await authenticatedUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Vui lòng đăng nhập để xem dữ liệu." });
      return;
    }
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
    const user = await authenticatedUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Vui lòng đăng nhập để cập nhật dữ liệu." });
      return;
    }
    if (user.role !== "editor" && user.role !== "admin") {
      sendJson(response, 403, { error: "Tài khoản chỉ xem; hãy gửi yêu cầu quyền chỉnh sửa." });
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
      const saved = await saveStateRecord(payload, body.expectedRevision, user.email);
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
if (!(await hasAdmin())) {
  console.warn(`Admin account ${adminEmail} has not been created.`);
  if (process.env.ADMIN_BOOTSTRAP_CODE) {
    console.warn("Set-up code is configured through the environment.");
  } else {
    console.warn(`Temporary admin setup code (keep server logs private): ${adminBootstrapCode}`);
  }
}
server.listen(port, host, () => {
  console.log(`FORGE CNC is running at http://${host}:${port}`);
  console.log(storageMode() === "mongodb"
    ? `MongoDB database: ${mongoDb.databaseName}`
    : storageMode() === "firestore"
      ? `Firebase Firestore project: ${process.env.FIREBASE_PROJECT_ID || "project from service account"}`
      : `SQLite database: ${databasePath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      database.close();
      if (mongoClient) await mongoClient.close();
      await closeFirestore();
      process.exit(0);
    });
  });
}
