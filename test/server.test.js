import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocket } from "ws";

import { createAudioCastServer } from "../src/app.js";

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function createMessageCollector(ws) {
  const queue = [];
  const waiters = [];

  ws.on("message", (data) => {
    const message = JSON.parse(String(data));
    const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
    if (waiterIndex >= 0) {
      const [{ resolve }] = waiters.splice(waiterIndex, 1);
      resolve(message);
      return;
    }

    queue.push(message);
  });

  return {
    waitForType(type) {
      const queuedIndex = queue.findIndex((message) => message.type === type);
      if (queuedIndex >= 0) {
        const [message] = queue.splice(queuedIndex, 1);
        return Promise.resolve(message);
      }

      return new Promise((resolve) => {
        waiters.push({ type, resolve });
      });
    }
  };
}

async function startFixtureServer(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-audio-cast-"));
  const passwordFile = path.join(tempDir, "broadcaster-password.txt");
  const iceConfigFile = path.join(tempDir, "ice-servers.json");
  fs.writeFileSync(passwordFile, "secret\n", "utf8");
  fs.writeFileSync(
    iceConfigFile,
    JSON.stringify({
      iceServers: [{ urls: ["stun:example.org:3478"] }]
    }),
    "utf8"
  );

  const fixture = createAudioCastServer({ passwordFile, iceConfigFile });
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  const address = fixture.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    for (const client of fixture.wss.clients) {
      client.terminate();
    }
    await new Promise((resolve) => fixture.wss.close(resolve));
    await new Promise((resolve) => fixture.server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { ...fixture, baseUrl };
}

test("login, auth status, and rtc config work", async (t) => {
  const { baseUrl } = await startFixtureServer(t);

  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong" })
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "secret" })
  });

  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /broadcaster_session=/);

  const authStatus = await fetch(`${baseUrl}/api/auth/status`, {
    headers: {
      cookie
    }
  });
  assert.deepEqual(await authStatus.json(), { authenticated: true });

  const rtcConfig = await fetch(`${baseUrl}/api/rtc-config`);
  assert.deepEqual(await rtcConfig.json(), {
    iceServers: [{ urls: ["stun:example.org:3478"] }]
  });
});

test("broadcaster websocket requires auth and routes offers to listeners", async (t) => {
  const { baseUrl } = await startFixtureServer(t);
  const wsBase = baseUrl.replace("http", "ws");

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "secret" })
  });
  const cookie = login.headers.get("set-cookie");

  const listener = new WebSocket(`${wsBase}/ws`);
  await waitForOpen(listener);
  const listenerMessages = createMessageCollector(listener);
  listener.send(JSON.stringify({ type: "join", role: "listener" }));
  const listenerJoined = await listenerMessages.waitForType("joined");
  assert.equal(listenerJoined.type, "joined");
  const listenerPeerId = listenerJoined.peerId;

  const broadcaster = new WebSocket(`${wsBase}/ws`, {
    headers: {
      cookie,
      origin: baseUrl
    }
  });
  await waitForOpen(broadcaster);
  const broadcasterMessages = createMessageCollector(broadcaster);
  broadcaster.send(JSON.stringify({ type: "join", role: "broadcaster" }));

  const broadcasterJoined = await broadcasterMessages.waitForType("joined");
  assert.equal(broadcasterJoined.type, "joined");

  const listenerAppeared = await broadcasterMessages.waitForType("listener-joined");
  assert.deepEqual(listenerAppeared, { type: "listener-joined", peerId: listenerPeerId });

  broadcaster.send(
    JSON.stringify({
      type: "offer",
      peerId: listenerPeerId,
      payload: { type: "offer", sdp: "test-sdp" }
    })
  );

  const offer = await listenerMessages.waitForType("offer");
  assert.deepEqual(offer, {
    type: "offer",
    peerId: listenerPeerId,
    payload: { type: "offer", sdp: "test-sdp" }
  });

  broadcaster.close();
  const stopped = await listenerMessages.waitForType("broadcast-stopped");
  assert.equal(stopped.type, "broadcast-stopped");

  listener.terminate();
  broadcaster.terminate();
});
