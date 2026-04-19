import { createSocket, fetchJson, setBanner } from "/common.js";

const statusBanner = document.querySelector("#status-banner");
const liveIndicator = document.querySelector("#live-indicator");
const listenerCount = document.querySelector("#listener-count");
const listenButton = document.querySelector("#listen-button");
const disconnectButton = document.querySelector("#disconnect-button");
const audioPlayer = document.querySelector("#audio-player");

let socket = null;
let peer = null;
let currentPeerId = null;
let iceServers = [];

function renderLiveState(isLive) {
  liveIndicator.textContent = isLive ? "Live" : "Offline";
}

function renderConnectionState(connected) {
  listenButton.disabled = connected;
  disconnectButton.disabled = !connected;
}

async function refreshStatus() {
  try {
    const status = await fetchJson("/api/broadcast/status", { method: "GET" });
    renderLiveState(status.live);
    listenerCount.textContent = String(status.listeners);
    if (!socket) {
      setBanner(
        statusBanner,
        status.live ? "Broadcast is live. Click start listening to join." : "Broadcaster is offline. Waiting.",
        status.live ? "success" : "neutral"
      );
    }
  } catch (error) {
    setBanner(statusBanner, `Failed to load room status: ${error.message}`, "error");
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

function resetAudio() {
  if (audioPlayer.srcObject) {
    const stream = audioPlayer.srcObject;
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
  audioPlayer.srcObject = null;
}

function cleanupPeer() {
  if (peer) {
    peer.close();
    peer = null;
  }
  currentPeerId = null;
  resetAudio();
}

function disconnect() {
  cleanupPeer();
  if (socket) {
    socket.close();
    socket = null;
  }
  renderConnectionState(false);
}

async function createPeerConnection(peerId) {
  cleanupPeer();
  currentPeerId = peerId;
  peer = new RTCPeerConnection({ iceServers: await ensureRtcConfig() });

  peer.ontrack = (event) => {
    const [remoteStream] = event.streams;
    if (remoteStream) {
      audioPlayer.srcObject = remoteStream;
      audioPlayer.play().catch(() => {});
    }
  };

  peer.onicecandidate = (event) => {
    if (!event.candidate || !socket || !currentPeerId) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "ice-candidate",
        peerId: currentPeerId,
        payload: event.candidate
      })
    );
  };

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "connected") {
      setBanner(statusBanner, "Connected. Audio is playing from the active broadcaster.", "success");
      return;
    }

    if (peer.connectionState === "failed" || peer.connectionState === "disconnected" || peer.connectionState === "closed") {
      cleanupPeer();
      setBanner(statusBanner, "Peer connection dropped. Waiting for broadcaster.", "neutral");
    }
  };

  return peer;
}

async function handleOffer(message) {
  const connection = await createPeerConnection(message.peerId);
  await connection.setRemoteDescription(message.payload);
  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);

  socket.send(
    JSON.stringify({
      type: "answer",
      peerId: message.peerId,
      payload: connection.localDescription
    })
  );
}

function handleSocketMessage(event) {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case "joined":
      renderConnectionState(true);
      renderLiveState(message.live);
      setBanner(
        statusBanner,
        message.live ? "Connected to room. Waiting for the audio offer." : "Connected to room. Waiting for broadcaster.",
        message.live ? "success" : "neutral"
      );
      return;
    case "offer":
      handleOffer(message).catch((error) => {
        setBanner(statusBanner, `Offer handling failed: ${error.message}`, "error");
      });
      return;
    case "ice-candidate":
      if (peer && message.payload) {
        peer.addIceCandidate(message.payload).catch(() => {});
      }
      return;
    case "broadcast-stopped":
      cleanupPeer();
      renderLiveState(false);
      setBanner(statusBanner, "Broadcaster went offline. Waiting for the next session.", "neutral");
      return;
    case "status":
      renderLiveState(message.live);
      listenerCount.textContent = String(message.listeners);
      return;
    case "error":
      setBanner(statusBanner, message.message ?? "Socket error.", "error");
      disconnect();
      return;
    default:
      return;
  }
}

function connect() {
  if (socket) {
    return;
  }

  socket = createSocket();
  socket.addEventListener("message", handleSocketMessage);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "join", role: "listener" }));
  });
  socket.addEventListener("close", () => {
    renderConnectionState(false);
    cleanupPeer();
    socket = null;
  });
}

listenButton.addEventListener("click", () => {
  connect();
});

disconnectButton.addEventListener("click", () => {
  disconnect();
  setBanner(statusBanner, "Disconnected from room.", "neutral");
});

window.addEventListener("beforeunload", () => {
  disconnect();
});

refreshStatus();
setInterval(refreshStatus, 5000);
