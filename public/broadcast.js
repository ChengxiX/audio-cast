import { createSocket, fetchJson, setBanner } from "/common.js";

const loginCard = document.querySelector("#login-card");
const controlCard = document.querySelector("#control-card");
const loginForm = document.querySelector("#login-form");
const passwordInput = document.querySelector("#password");
const statusBanner = document.querySelector("#status-banner");
const liveIndicator = document.querySelector("#live-indicator");
const listenerCount = document.querySelector("#listener-count");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const logoutButton = document.querySelector("#logout-button");

let authenticated = false;
let socket = null;
let displayStream = null;
let audioStream = null;
let iceServers = [];
let stoppingManually = false;
const peers = new Map();

function renderAuthState() {
  loginCard.classList.toggle("hidden", authenticated);
  controlCard.classList.toggle("hidden", !authenticated);
}

function renderLiveState(isLive) {
  liveIndicator.textContent = isLive ? "Live" : "Offline";
  startButton.disabled = isLive;
  stopButton.disabled = !isLive;
}

function closePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) {
    return;
  }
  peer.close();
  peers.delete(peerId);
}

function resetPeers() {
  for (const peerId of peers.keys()) {
    closePeer(peerId);
  }
}

async function refreshStatus() {
  try {
    const [authStatus, broadcastStatus] = await Promise.all([
      fetchJson("/api/auth/status", { method: "GET" }),
      fetchJson("/api/broadcast/status", { method: "GET" })
    ]);

    authenticated = authStatus.authenticated;
    renderAuthState();
    renderLiveState(broadcastStatus.live);
    listenerCount.textContent = String(broadcastStatus.listeners);

    if (broadcastStatus.live) {
      setBanner(statusBanner, "Broadcast is live. Keep this tab open while sharing audio.", "success");
    } else if (authenticated) {
      setBanner(statusBanner, "Console unlocked. Start broadcasting when ready.", "neutral");
    } else {
      setBanner(statusBanner, "Broadcaster password required.", "neutral");
    }
  } catch (error) {
    setBanner(statusBanner, `Failed to load status: ${error.message}`, "error");
  }
}

async function ensureRtcConfig() {
  if (iceServers.length > 0) {
    return iceServers;
  }

  const config = await fetchJson("/api/rtc-config", { method: "GET" });
  iceServers = config.iceServers ?? [];
  return iceServers;
}

function cleanupCapture() {
  resetPeers();

  if (displayStream) {
    for (const track of displayStream.getTracks()) {
      track.stop();
    }
  }

  displayStream = null;
  audioStream = null;
  renderLiveState(false);

  if (socket) {
    const activeSocket = socket;
    socket = null;
    if (activeSocket.readyState < WebSocket.CLOSING) {
      activeSocket.close();
    }
  }
}

async function createPeerConnection(peerId) {
  if (!audioStream) {
    return null;
  }

  const peer = new RTCPeerConnection({ iceServers: await ensureRtcConfig() });

  for (const track of audioStream.getAudioTracks()) {
    peer.addTrack(track, audioStream);
  }

  peer.onicecandidate = (event) => {
    if (!event.candidate || !socket) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "ice-candidate",
        peerId,
        payload: event.candidate
      })
    );
  };

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed" || peer.connectionState === "closed") {
      closePeer(peerId);
    }
  };

  peers.set(peerId, peer);
  return peer;
}

async function handleListenerJoined(peerId) {
  closePeer(peerId);
  const peer = await createPeerConnection(peerId);
  if (!peer || !socket) {
    return;
  }

  const offer = await peer.createOffer({
    offerToReceiveAudio: false,
    offerToReceiveVideo: false
  });
  await peer.setLocalDescription(offer);

  socket.send(
    JSON.stringify({
      type: "offer",
      peerId,
      payload: peer.localDescription
    })
  );
}

function handleSocketMessage(event) {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case "joined":
      renderLiveState(true);
      setBanner(statusBanner, "Broadcast is live. Share audio from this browser prompt only.", "success");
      return;
    case "listener-joined":
      listenerCount.textContent = String(Number.parseInt(listenerCount.textContent, 10) + 1);
      handleListenerJoined(message.peerId).catch((error) => {
        setBanner(statusBanner, `Peer setup failed: ${error.message}`, "error");
      });
      return;
    case "listener-left":
      closePeer(message.peerId);
      listenerCount.textContent = String(Math.max(0, Number.parseInt(listenerCount.textContent, 10) - 1));
      return;
    case "answer":
      if (peers.has(message.peerId)) {
        peers.get(message.peerId).setRemoteDescription(message.payload);
      }
      return;
    case "ice-candidate":
      if (peers.has(message.peerId) && message.payload) {
        peers.get(message.peerId).addIceCandidate(message.payload).catch(() => {});
      }
      return;
    case "status":
      listenerCount.textContent = String(message.listeners);
      renderLiveState(message.live);
      return;
    case "error":
      setBanner(statusBanner, message.message ?? "Socket error.", "error");
      return;
    default:
      return;
  }
}

async function startBroadcast() {
  if (!authenticated) {
    setBanner(statusBanner, "Log in before starting a broadcast.", "error");
    return;
  }

  try {
    stoppingManually = false;
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      cleanupCapture();
      setBanner(statusBanner, "No audio track was shared. Re-open sharing and enable system audio.", "error");
      return;
    }

    audioStream = new MediaStream(audioTracks);
    socket = createSocket();
    socket.addEventListener("message", handleSocketMessage);
    socket.addEventListener("close", () => {
      const wasManual = stoppingManually;
      stoppingManually = false;
      cleanupCapture();
      if (wasManual) {
        return;
      }
      resetPeers();
      setBanner(statusBanner, "Broadcast socket closed.", "neutral");
    });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "join", role: "broadcaster" }));
    });

    const stopWhenEnded = () => {
      if (displayStream) {
        stopBroadcast();
      }
    };

    for (const track of displayStream.getTracks()) {
      track.addEventListener("ended", stopWhenEnded, { once: true });
    }
  } catch (error) {
    cleanupCapture();
    setBanner(statusBanner, `Broadcast could not start: ${error.message}`, "error");
  }
}

function stopBroadcast() {
  stoppingManually = true;
  cleanupCapture();
  setBanner(statusBanner, "Broadcast stopped.", "neutral");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await fetchJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: passwordInput.value })
    });
    passwordInput.value = "";
    authenticated = true;
    renderAuthState();
    setBanner(statusBanner, "Console unlocked. Ready to start broadcasting.", "success");
  } catch (error) {
    setBanner(statusBanner, `Login failed: ${error.message}`, "error");
  }
});

startButton.addEventListener("click", () => {
  startBroadcast();
});

stopButton.addEventListener("click", () => {
  stopBroadcast();
});

logoutButton.addEventListener("click", async () => {
  stopBroadcast();
  await fetchJson("/api/auth/logout", { method: "POST" });
  authenticated = false;
  renderAuthState();
  setBanner(statusBanner, "Logged out.", "neutral");
});

window.addEventListener("beforeunload", () => {
  cleanupCapture();
});

refreshStatus();
setInterval(refreshStatus, 5000);
