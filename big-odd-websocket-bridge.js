"use strict";

const WebSocket = require("ws");
const bigOddEngine = require("./big-odd-engine");

let installed = false;
let socket = null;
let reconnectTimer = null;

const PORT = Number(process.env.PORT || 3000);
const BRIDGE_URL = `ws://127.0.0.1:${PORT}`;
const RECONNECT_DELAY = 1000;

function numberFrom(value) {
    const number = Number(typeof value === "string" ? value.trim().replace(/x$/i, "") : value);
    return Number.isFinite(number) ? number : NaN;
}

function payloadOf(message) {
    if (!message || typeof message !== "object") return null;
    return message.data && typeof message.data === "object" ? message.data : null;
}

function oddOf(payload) {
    if (!payload) return NaN;
    return numberFrom(payload.crashMultiplier ?? payload.bigOdd ?? payload.odd ?? payload.multiplier);
}

function findRound(roundId) {
    const id = Number(roundId);
    if (!Number.isFinite(id)) return null;
    return bigOddEngine.getHistory().find(item => Number(item.roundId) === id) || null;
}

function publish(payload) {
    if (!payload || payload.roundId === undefined) return null;

    const odd = oddOf(payload);
    if (!Number.isFinite(odd) || odd < bigOddEngine.BIG_ODD_MINIMUM) return null;

    const existing = findRound(payload.roundId);
    if (existing) return existing;

    const record = bigOddEngine.publishFromRound({
        roundId: payload.roundId,
        odd,
        crashMultiplier: odd,
        status: payload.status || "WAITING",
        createdAt: payload.createdAt || payload.serverTime,
        serverTime: payload.serverTime,
        startedAt: payload.startedAt || null,
        crashedAt: payload.crashedAt || null
    });

    if (record) {
        console.log(`[BIG ODD] Published round ${payload.roundId} -> ${record.odd.toFixed(2)}x`);
    }

    return record;
}

function ensurePublished(payload) {
    return findRound(payload.roundId) || publish(payload);
}

function processMessage(message) {
    const payload = payloadOf(message);
    if (!payload) return;

    if (message.type === "CONNECTED" && payload.game) {
        processMessage({ type: "GAME_STATE", data: payload.game });
        return;
    }

    if (message.type === "GAME_STATE") {
        const odd = oddOf(payload);
        if (!Number.isFinite(odd) || odd < bigOddEngine.BIG_ODD_MINIMUM) return;
        if (payload.status === "RUNNING") {
            const record = ensurePublished(payload);
            if (record) bigOddEngine.updateRoundStatus(payload.roundId, "RUNNING", { runningAt: payload.startedAt || payload.serverTime });
        } else if (payload.status === "CRASHED") {
            const record = ensurePublished(payload);
            if (record) bigOddEngine.updateRoundStatus(payload.roundId, "PLAYED", { playedAt: payload.crashedAt || payload.serverTime });
        } else {
            publish(payload);
        }
        return;
    }

    if (message.type === "ROUND_CREATED") {
        publish(payload);
        return;
    }

    if (message.type === "ROUND_STARTED") {
        const record = ensurePublished(payload);
        if (record) bigOddEngine.updateRoundStatus(payload.roundId, "RUNNING", { runningAt: payload.startedAt || payload.serverTime });
        return;
    }

    if (message.type === "ROUND_CRASHED") {
        const record = ensurePublished(payload);
        if (record) bigOddEngine.updateRoundStatus(payload.roundId, "PLAYED", { playedAt: payload.crashedAt || payload.serverTime });
    }
}

function scheduleReconnect() {
    if (!installed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_DELAY);
}

function connect() {
    if (!installed) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    console.log(`[BIG ODD] Connecting bridge to ${BRIDGE_URL}`);

    try {
        socket = new WebSocket(BRIDGE_URL);
    } catch (error) {
        console.error("[BIG ODD] Bridge connection failed:", error.message);
        scheduleReconnect();
        return;
    }

    socket.on("open", () => console.log("[BIG ODD] Bridge connected to crash WebSocket"));

    socket.on("message", raw => {
        try {
            processMessage(JSON.parse(raw.toString()));
        } catch (error) {
            console.warn("[BIG ODD] Invalid bridge message:", error.message);
        }
    });

    socket.on("error", error => console.error("[BIG ODD] Bridge error:", error.message));

    socket.on("close", () => {
        socket = null;
        scheduleReconnect();
    });
}

function install() {
    if (installed) return;
    installed = true;
    setTimeout(connect, 1000);
    console.log(`[BIG ODD] WebSocket bridge installed. Minimum: ${bigOddEngine.BIG_ODD_MINIMUM}x`);
}

module.exports = { install, processMessage };
