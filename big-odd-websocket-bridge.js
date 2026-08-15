"use strict";

const WebSocket = require("ws");
const bigOddEngine = require("./big-odd-engine");

let installed = false;
let socket = null;
let reconnectTimer = null;
let syncTimer = null;
let lastMessageAt = null;
let lastPublishedAt = null;
let lastPublishedRoundId = null;
let lastError = null;

const PORT = Number(process.env.PORT || 3000);
const BRIDGE_URL = `ws://127.0.0.1:${PORT}`;
const GAME_URL = `http://127.0.0.1:${PORT}/api/game`;
const RECONNECT_DELAY = 1000;
const SYNC_INTERVAL = 1000;

function numberFrom(value) {
    const number = Number(
        typeof value === "string"
            ? value.trim().replace(/x$/i, "")
            : value
    );
    return Number.isFinite(number) ? number : NaN;
}

function payloadOf(message) {
    if (!message || typeof message !== "object") return null;
    return message.data && typeof message.data === "object" ? message.data : null;
}

function oddOf(payload) {
    if (!payload) return NaN;
    return numberFrom(
        payload.crashMultiplier ??
        payload.bigOdd ??
        payload.odd ??
        payload.multiplier
    );
}

function findRound(roundId) {
    const id = Number(roundId);
    if (!Number.isFinite(id)) return null;
    return bigOddEngine
        .getHistory()
        .find(item => Number(item.roundId) === id) || null;
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
        status: payload.status || null,
        createdAt: payload.createdAt || payload.serverTime || new Date().toISOString(),
        serverTime: payload.serverTime || new Date().toISOString(),
        startedAt: payload.startedAt || null,
        crashedAt: payload.crashedAt || null
    });

    if (record) {
        lastPublishedAt = new Date().toISOString();
        lastPublishedRoundId = record.roundId;
        console.log(
            `[BIG ODD] Published live round ${payload.roundId} -> ${record.odd.toFixed(2)}x`
        );
    }

    return record;
}

function bindScheduledRound(payload) {
    if (!payload || payload.roundId === undefined) return null;

    const startedAt = payload.startedAt || payload.serverTime || new Date().toISOString();
    const record = bigOddEngine.bindScheduledToRound(
        payload.roundId,
        startedAt
    );

    if (record) {
        console.log(
            `[BIG ODD] Scheduled ${record.id} bound to round ${record.roundId} at ${startedAt}`
        );
    }

    return record;
}

function ensurePublished(payload) {
    if (!payload || payload.roundId === undefined) return null;
    return findRound(payload.roundId) || publish(payload);
}

function processMessage(message) {
    if (!message || typeof message !== "object") return;

    lastMessageAt = new Date().toISOString();
    const payload = payloadOf(message);
    if (!payload) return;

    if (message.type === "CONNECTED" && payload.game) {
        processMessage({ type: "GAME_STATE", data: payload.game });
        return;
    }

    if (message.type === "GAME_STATE") {
        const odd = oddOf(payload);

        if (payload.status === "RUNNING") {
            const scheduled = bindScheduledRound(payload);
            const record = scheduled || ensurePublished(payload);

            if (record) {
                bigOddEngine.updateRoundStatus(
                    payload.roundId,
                    "RUNNING",
                    {
                        runningAt: payload.startedAt || payload.serverTime
                    }
                );
            }
            return;
        }

        if (payload.status === "CRASHED") {
            const record = ensurePublished(payload);

            if (record) {
                bigOddEngine.updateRoundStatus(
                    payload.roundId,
                    "PLAYED",
                    {
                        playedAt: payload.crashedAt || payload.serverTime
                    }
                );
            }
            return;
        }

        // Only publish normal WebSocket rounds when they themselves
        // qualify as a Big Odd. Scheduled items are already published
        // by the daily scheduler one hour before their slot.
        if (
            Number.isFinite(odd) &&
            odd >= bigOddEngine.BIG_ODD_MINIMUM
        ) {
            publish(payload);
        }
        return;
    }

    if (message.type === "ROUND_CREATED") {
        // Do not publish here. A round is not a Big Odd merely because
        // it was created; the scheduled publisher handles announcements.
        return;
    }

    if (message.type === "ROUND_STARTED") {
        const scheduled = bindScheduledRound(payload);
        const record = scheduled || ensurePublished(payload);

        if (record) {
            bigOddEngine.updateRoundStatus(
                payload.roundId,
                "RUNNING",
                {
                    runningAt: payload.startedAt || payload.serverTime
                }
            );
        }
        return;
    }

    if (message.type === "ROUND_CRASHED") {
        const record = ensurePublished(payload);

        if (record) {
            bigOddEngine.updateRoundStatus(
                payload.roundId,
                "PLAYED",
                {
                    playedAt: payload.crashedAt || payload.serverTime
                }
            );
        }
    }
}

async function syncCurrentGame() {
    if (!installed) return;

    try {
        const response = await fetch(GAME_URL, {
            headers: { Accept: "application/json" }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = await response.json();
        if (body && body.success && body.game) {
            processMessage({ type: "GAME_STATE", data: body.game });
        }

        lastError = null;
    } catch (error) {
        lastError = error.message;
    }
}

function startSyncLoop() {
    if (syncTimer) return;
    syncCurrentGame();
    syncTimer = setInterval(syncCurrentGame, SYNC_INTERVAL);
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

    if (
        socket &&
        (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
        )
    ) return;

    console.log(`[BIG ODD] Connecting bridge to ${BRIDGE_URL}`);

    try {
        socket = new WebSocket(BRIDGE_URL);
    } catch (error) {
        lastError = error.message;
        console.error("[BIG ODD] Bridge connection failed:", error.message);
        scheduleReconnect();
        return;
    }

    socket.on("open", () => {
        lastError = null;
        console.log("[BIG ODD] Bridge connected to crash WebSocket");
        syncCurrentGame();
    });

    socket.on("message", raw => {
        try {
            processMessage(JSON.parse(raw.toString()));
        } catch (error) {
            lastError = error.message;
            console.warn("[BIG ODD] Invalid bridge message:", error.message);
        }
    });

    socket.on("error", error => {
        lastError = error.message;
        console.error("[BIG ODD] Bridge error:", error.message);
    });

    socket.on("close", () => {
        socket = null;
        scheduleReconnect();
    });
}

function getStatus() {
    return {
        installed,
        websocketConnected: !!socket && socket.readyState === WebSocket.OPEN,
        bridgeUrl: BRIDGE_URL,
        gameUrl: GAME_URL,
        minimumBigOdd: bigOddEngine.BIG_ODD_MINIMUM,
        lastMessageAt,
        lastPublishedAt,
        lastPublishedRoundId,
        lastError
    };
}

function install() {
    if (installed) return;
    installed = true;

    console.log(
        `[BIG ODD] WebSocket bridge installed. Minimum: ${bigOddEngine.BIG_ODD_MINIMUM}x`
    );

    startSyncLoop();
    setTimeout(connect, 1000);
}

module.exports = {
    install,
    processMessage,
    getStatus
};
