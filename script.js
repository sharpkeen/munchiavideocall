// ========================
// Ably Signaling Setup
// ========================
// Use your provided Ably API key.
const ablyApiKey = "SrWU1g.qV744Q:1ISLDPs2HaWIahxJwGkyFrVepUJSdKiL_n-o5Nh9J0Q";

// Create a new Ably Realtime instance.
const ably = new Ably.Realtime(ablyApiKey);

// Get (or create) a channel for signaling. All peers join this channel.
const channel = ably.channels.get("webrtc-demo");

// ========================
// Global Variables & Setup
// ========================
let localStream;
const peers = {}; // Stores RTCPeerConnection objects keyed by peer ID.
const myId = Math.floor(Math.random() * 1000000).toString(); // A random ID for this peer.
const room = "global"; // Using a single global room for all peers.

console.log("My Peer ID:", myId);

// --- Candidate Batching Setup ---
// We'll batch ICE candidates per peer to reduce message frequency.
const candidateBatches = {};      // Object keyed by peerId storing an array of ICE candidates.
const candidateFlushTimers = {};  // Timers for each peer's candidate batch.

function queueCandidate(peerId, candidate) {
  if (!candidateBatches[peerId]) {
    candidateBatches[peerId] = [];
  }
  candidateBatches[peerId].push(candidate);
  
  // If no flush timer is set for this peer, set one for 300ms.
  if (!candidateFlushTimers[peerId]) {
    candidateFlushTimers[peerId] = setTimeout(() => {
      flushCandidateBatch(peerId);
    }, 300);
  }
}

function flushCandidateBatch(peerId) {
  const candidates = candidateBatches[peerId];
  if (candidates && candidates.length > 0) {
    sendMessage({
      type: "candidates", // Note plural: this message carries an array of candidates.
      candidates: candidates,
      sender: myId,
      target: peerId
    });
    candidateBatches[peerId] = []; // Clear the batch.
  }
  candidateFlushTimers[peerId] = null;
}

// ========================
// Setup Local Media Stream
// ========================
async function setupLocalStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const localVideo = document.getElementById("localVideo");
    localVideo.srcObject = localStream;
    joinRoom();
  } catch (err) {
    console.error("Error accessing media devices:", err);
    alert("Error accessing your camera or microphone. Please check your device and permissions.");
  }
}

// ========================
// Signaling: Join the Room via Ably
// ========================
function joinRoom() {
  // Subscribe to all "signal" messages on the channel.
  channel.subscribe("signal", (message) => {
    const data = message.data;
    // Ignore messages sent by ourselves.
    if (data.sender === myId) return;
    // If the message is targeted and not for us, skip it.
    if (data.target && data.target !== myId) return;

    console.log("Received message:", data);
    if (data.type === "offer") {
      handleOffer(data.offer, data.sender);
    } else if (data.type === "answer") {
      handleAnswer(data.answer, data.sender);
    } else if (data.type === "candidate") {
      // Fallback for single candidate messages.
      handleCandidate(data.candidate, data.sender);
    } else if (data.type === "candidates") {
      // Handle batched candidates.
      data.candidates.forEach((cand) => {
        handleCandidate(cand, data.sender);
      });
    } else if (data.type === "announce") {
      // When a new peer announces, create an offer if not already connected.
      if (!peers[data.sender]) {
        createOffer(data.sender);
      }
    }
  });

  // Announce our presence on the channel.
  sendMessage({ type: "announce", sender: myId });
}

// ========================
// WebRTC Peer Connection Management
// ========================
function createPeerConnection(peerId) {
  const configuration = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  };
  const pc = new RTCPeerConnection(configuration);

  // When an ICE candidate is found, add it to the batch.
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      queueCandidate(peerId, event.candidate);
    }
  };

  // When a remote track is received, add it to the UI.
  pc.ontrack = (event) => {
    console.log("Received remote track from:", peerId);
    addRemoteStream(event.streams[0], peerId);
  };

  return pc;
}

function createOffer(peerId) {
  console.log("Creating offer for peer:", peerId);
  const pc = createPeerConnection(peerId);
  peers[peerId] = pc;

  // Add local tracks (video and audio) to the connection.
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // Create an SDP offer.
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => {
      // Send the offer to the target peer.
      sendMessage({
        type: "offer",
        offer: pc.localDescription,
        sender: myId,
        target: peerId
      });
    })
    .catch((err) => {
      console.error("Error creating offer for", peerId, err);
    });
}

function handleOffer(offer, senderId) {
  console.log("Handling offer from:", senderId);
  const pc = createPeerConnection(senderId);
  peers[senderId] = pc;

  // Add local tracks.
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // Set remote description from the received offer.
  pc.setRemoteDescription(new RTCSessionDescription(offer))
    .then(() => pc.createAnswer())
    .then((answer) => pc.setLocalDescription(answer))
    .then(() => {
      // Send the answer back to the sender.
      sendMessage({
        type: "answer",
        answer: pc.localDescription,
        sender: myId,
        target: senderId
      });
    })
    .catch((err) => {
      console.error("Error handling offer from", senderId, err);
    });
}

function handleAnswer(answer, senderId) {
  console.log("Handling answer from:", senderId);
  const pc = peers[senderId];
  if (pc) {
    pc.setRemoteDescription(new RTCSessionDescription(answer))
      .catch((err) => {
        console.error("Error setting remote description from answer (" + senderId + "):", err);
      });
  }
}

function handleCandidate(candidate, senderId) {
  console.log("Handling candidate from:", senderId);
  const pc = peers[senderId];
  if (pc) {
    pc.addIceCandidate(new RTCIceCandidate(candidate))
      .catch((err) => {
        console.error("Error adding ICE candidate from", senderId, err);
      });
  }
}

// ========================
// UI: Add Remote Video Element
// ========================
function addRemoteStream(stream, peerId) {
  // Prevent duplicate video elements.
  if (document.getElementById("video-" + peerId)) return;

  const videosDiv = document.getElementById("videos");
  const videoElem = document.createElement("video");
  videoElem.id = "video-" + peerId;
  videoElem.autoplay = true;
  videoElem.playsInline = true;
  videoElem.srcObject = stream;
  videosDiv.appendChild(videoElem);
}

// ========================
// Signaling: Send a Message via Ably
// ========================
function sendMessage(message) {
  channel.publish("signal", message, (err) => {
    if (err) {
      console.error("Ably publish error:", err);
    }
  });
}

// ========================
// Start the Application
// ========================
setupLocalStream();
