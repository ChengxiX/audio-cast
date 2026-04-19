import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocket, WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");
const defaultPasswordFile = path.join(projectRoot, "config", "broadcaster-password.txt");
const defaultIceConfigFile = path.join(projectRoot, "config", "ice-servers.json");
const sessionCookieName = "broadcaster_session";
const defaultRoomId = "main";
const localhostOrigins = new Set([
  "http://localhost:3000",
  "https://localhost:3000",
  "http://127.0.0.1:3000",
  "https://127.0.0.1:3000"
]);

function safeJsonParse(text, fallbackValue) {
  try {
    return JSON.parse(text);
  } catch {
    return fallbackValue;
  }
}

function parseCookies(headerValue = "") {
  return headerValue.split(";").reduce((cookies, part) => {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) {
      return cookies;
    }
    cookies[rawKey] = decodeURIComponent(rawValue.join("="));
    return cookies;
  }, {});
}

function json(res, status, payload) {
  res.status(status).json(payload);
}

function createSessionStore() {
  const sessions = new Map();

  return {
    create() {
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { createdAt: Date.now() });
      return token;
    },
    has(token) {
      return sessions.has(token);
    },
    delete(token) {
      sessions.delete(token);
    }
  };
}

function readPassword(passwordFile) {
  const raw = fs.readFileSync(passwordFile, "utf8");
  return raw.split(/\r?\n/, 1)[0].trim();
}

function readIceServers(iceConfigFile) {
  const raw = fs.readFileSync(iceConfigFile, "utf8");
  const config = safeJsonParse(raw, {});
  if (!Array.isArray(config.iceServers)) {
    return { iceServers: [] };
  }
  return { iceServers: config.iceServers };
}

function getRequestHost(req) {
  return req.headers["x-forwarded-host"] ?? req.headers.host ?? "";
}

function getAllowedOrigin(req) {
  const host = getRequestHost(req);
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto ?? (host.includes("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${protocol}://${host}`;
}

function isBroadcasterOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return false;
  }

  const allowedOrigin = getAllowedOrigin(req);
  if (origin === allowedOrigin) {
    return true;
  }

  return localhostOrigins.has(origin);
}

function setSessionCookie(res, token) {
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 12 * 60 * 60 * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/"
  });
}

function createBroadcasterState() {
  return {
    socket: null,
    peers: new Set()
  };
}

function createClientId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function closeWithError(ws, code, errorCode, message) {
  sendJson(ws, { type: "error", error: errorCode, message });
  ws.close(code, message);
}

export function createAudioCastServer(options = {}) {
  const passwordFile = options.passwordFile ?? defaultPasswordFile;
  const iceConfigFile = options.iceConfigFile ?? defaultIceConfigFile;
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const sessions = createSessionStore();
  const broadcaster = createBroadcasterState();
  const listeners = new Map();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use(express.static(publicDir, { extensions: ["html"] }));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/broadcast", (_req, res) => {
    res.sendFile(path.join(publicDir, "broadcast.html"));
  });

  app.get("/listen", (_req, res) => {
    res.sendFile(path.join(publicDir, "listen.html"));
  });

  app.get("/api/auth/status", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    json(res, 200, { authenticated: sessions.has(cookies[sessionCookieName]) });
  });

  app.post("/api/auth/login", (req, res) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    let storedPassword = "";
    try {
      storedPassword = readPassword(passwordFile);
    } catch (error) {
      console.error("Failed to read password file", error);
      json(res, 500, { ok: false, error: "password_file_unavailable" });
      return;
    }

    if (!storedPassword || password !== storedPassword) {
      json(res, 401, { ok: false, error: "invalid_password" });
      return;
    }

    const token = sessions.create();
    setSessionCookie(res, token);
    json(res, 200, { ok: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[sessionCookieName];
    if (token) {
      sessions.delete(token);
    }
    clearSessionCookie(res);
    json(res, 200, { ok: true });
  });

  app.get("/api/broadcast/status", (_req, res) => {
    json(res, 200, {
      live: Boolean(broadcaster.socket),
      listeners: listeners.size,
      roomId: defaultRoomId
    });
  });

  app.get("/api/rtc-config", (_req, res) => {
    try {
      json(res, 200, readIceServers(iceConfigFile));
    } catch (error) {
      console.error("Failed to read ICE config", error);
      json(res, 500, { iceServers: [], error: "ice_config_unavailable" });
    }
  });

  function broadcastStatusUpdate() {
    const payload = {
      type: "status",
      live: Boolean(broadcaster.socket),
      listeners: listeners.size
    };

    if (broadcaster.socket) {
      sendJson(broadcaster.socket, payload);
    }

    for (const listener of listeners.values()) {
      sendJson(listener.ws, payload);
    }
  }

  function handleBroadcasterDisconnect() {
    if (!broadcaster.socket) {
      return;
    }

    broadcaster.socket = null;
    broadcaster.peers.clear();

    for (const listener of listeners.values()) {
      sendJson(listener.ws, { type: "broadcast-stopped" });
    }

    broadcastStatusUpdate();
  }

  function cleanupListener(listenerId) {
    const listener = listeners.get(listenerId);
    if (!listener) {
      return;
    }

    listeners.delete(listenerId);
    broadcaster.peers.delete(listenerId);

    if (broadcaster.socket) {
      sendJson(broadcaster.socket, { type: "listener-left", peerId: listenerId });
    }

    broadcastStatusUpdate();
  }

  function routeSignal(sender, message) {
    if (typeof message.peerId !== "string") {
      return;
    }

    if (sender.role === "broadcaster") {
      const listener = listeners.get(message.peerId);
      if (!listener) {
        return;
      }
      sendJson(listener.ws, {
        type: message.type,
        peerId: message.peerId,
        payload: message.payload ?? null
      });
      return;
    }

    if (!broadcaster.socket) {
      return;
    }

    sendJson(broadcaster.socket, {
      type: message.type,
      peerId: sender.id,
      payload: message.payload ?? null
    });
  }

  function handleJoin(ws, req, client, message) {
    if (client.role) {
      closeWithError(ws, 1008, "already_joined", "Connection already joined.");
      return;
    }

    if (message.role === "broadcaster") {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[sessionCookieName];

      if (!sessions.has(token)) {
        closeWithError(ws, 1008, "not_authenticated", "Broadcaster authentication required.");
        return;
      }

      if (!isBroadcasterOriginAllowed(req)) {
        closeWithError(ws, 1008, "invalid_origin", "Broadcaster origin rejected.");
        return;
      }

      if (broadcaster.socket) {
        closeWithError(ws, 1008, "broadcaster_exists", "A broadcaster is already live.");
        return;
      }

      client.role = "broadcaster";
      broadcaster.socket = ws;
      sendJson(ws, {
        type: "joined",
        role: "broadcaster",
        roomId: defaultRoomId,
        listeners: listeners.size
      });

      for (const listenerId of listeners.keys()) {
        broadcaster.peers.add(listenerId);
        sendJson(ws, { type: "listener-joined", peerId: listenerId });
      }

      broadcastStatusUpdate();
      return;
    }

    if (message.role === "listener") {
      client.role = "listener";
      listeners.set(client.id, { id: client.id, ws });
      sendJson(ws, {
        type: "joined",
        role: "listener",
        roomId: defaultRoomId,
        peerId: client.id,
        live: Boolean(broadcaster.socket)
      });

      if (broadcaster.socket) {
        broadcaster.peers.add(client.id);
        sendJson(broadcaster.socket, { type: "listener-joined", peerId: client.id });
      }

      broadcastStatusUpdate();
      return;
    }

    closeWithError(ws, 1008, "invalid_role", "Unsupported role.");
  }

  wss.on("connection", (ws, req) => {
    const client = {
      id: createClientId("peer"),
      role: null
    };

    ws.on("message", (raw) => {
      const message = safeJsonParse(String(raw), null);
      if (!message || typeof message.type !== "string") {
        return;
      }

      switch (message.type) {
        case "join":
          handleJoin(ws, req, client, message);
          return;
        case "offer":
        case "answer":
        case "ice-candidate":
          routeSignal(client, message);
          return;
        default:
          return;
      }
    });

    ws.on("close", () => {
      if (client.role === "broadcaster") {
        handleBroadcasterDisconnect();
        return;
      }

      if (client.role === "listener") {
        cleanupListener(client.id);
      }
    });
  });

  return {
    app,
    server,
    wss,
    sessions,
    state: {
      broadcaster,
      listeners
    }
  };
}
