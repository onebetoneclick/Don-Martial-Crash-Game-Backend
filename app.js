const BACKEND_HTTP = "https://don-martial-crash-game-backend.onrender.com";
const BACKEND_WS = "wss://don-martial-crash-game-backend.onrender.com";

const $ = (id) => document.getElementById(id);
let socket = null;
let reconnectTimer = null;

function setConnection(online, text) {
  const badge = $("connectionBadge");
  const state = $("socketState");
  const stat = $("statSocket");
  badge.classList.toggle("online", online);
  badge.classList.toggle("offline", !online);
  badge.innerHTML = `<i></i>${text}`;
  state.textContent = text;
  stat.textContent = online ? "Online" : "Offline";
}

function formatTime(value) {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour12: false });
}

function renderGame(game = {}) {
  const round = game.roundId ?? "—";
  const multiplier = Number.isFinite(Number(game.multiplier)) ? Number(game.multiplier) : 1;
  const status = game.status || "STARTING";

  $("roundNumber").textContent = `Round ${round}`;
  $("statRound").textContent = round;
  $("multiplier").innerHTML = `${multiplier.toFixed(2)}<span>x</span>`;
  $("statMultiplier").textContent = `${multiplier.toFixed(2)}x`;
  $("gameStatus").textContent = status.replaceAll("_", " ");
  $("statStatus").textContent = status.replaceAll("_", " ");
  $("serverTime").textContent = formatTime(game.serverTime);

  if (status === "BETTING") {
    $("stageCaption").textContent = "Betting is open";
    $("gameNote").textContent = "The server is accepting bets for this round.";
    if (game.bettingEndsAt) {
      const remaining = Math.max(0, game.bettingEndsAt - Date.now());
      $("bettingTime").textContent = `${(remaining / 1000).toFixed(1)}s`;
    } else {
      $("bettingTime").textContent = "OPEN";
    }
  } else if (status === "RUNNING") {
    $("stageCaption").textContent = "Round is live";
    $("gameNote").textContent = "Watch the multiplier and cash out before the crash.";
    $("bettingTime").textContent = "CLOSED";
  } else if (status === "CRASHED") {
    $("stageCaption").textContent = `Crashed at ${Number(game.crashMultiplier || multiplier).toFixed(2)}x`;
    $("gameNote").textContent = "The round has ended. Preparing the next round…";
    $("bettingTime").textContent = "CLOSED";
  } else {
    $("stageCaption").textContent = status.replaceAll("_", " ");
    $("gameNote").textContent = "Waiting for the next game stage.";
    $("bettingTime").textContent = "CLOSED";
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  setConnection(false, "Connecting");

  try {
    socket = new WebSocket(BACKEND_WS);
  } catch (error) {
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    setConnection(true, "Live");
    $("gameNote").textContent = "Connected to the live game server.";
    socket.send(JSON.stringify({ type: "PING" }));
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      const data = message.data || {};

      if (message.type === "GAME_STATE" || message.type === "CONNECTED") {
        renderGame(data.game || data);
      }

      if (message.type === "ROUND_CREATED" || message.type === "BETTING_OPEN" || message.type === "BETTING_CLOSED" || message.type === "ROUND_STARTED") {
        renderGame(data);
      }

      if (message.type === "MULTIPLIER_UPDATE") {
        renderGame({
          ...data,
          status: "RUNNING"
        });
      }

      if (message.type === "ROUND_CRASHED") {
        renderGame(data);
      }
    } catch (error) {
      console.warn("Invalid WebSocket message", error);
    }
  });

  socket.addEventListener("close", () => {
    setConnection(false, "Offline");
    $("gameNote").textContent = "Connection lost. Reconnecting…";
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    setConnection(false, "Error");
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

async function loadInitialState() {
  try {
    const response = await fetch(`${BACKEND_HTTP}/api/game`, { cache: "no-store" });
    const json = await response.json();
    if (json.success && json.game) renderGame(json.game);
  } catch (error) {
    console.warn("Initial game state unavailable", error);
  }
}

setInterval(() => {
  const status = $("gameStatus").textContent;
  if (status === "BETTING" && socket && socket.readyState === WebSocket.OPEN) {
    const current = Number($("bettingTime").textContent.replace("s", ""));
    if (Number.isFinite(current)) $("bettingTime").textContent = `${Math.max(0, current - 0.05).toFixed(1)}s`;
  }
}, 50);

loadInitialState();
connect();
