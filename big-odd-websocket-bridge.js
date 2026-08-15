"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD WEBSOCKET BRIDGE
=========================================================

Connects the crash-game WebSocket events to the Big Odd
Engine.

The bridge is deliberately tolerant of the public payload:
if ROUND_CREATED does not expose crashMultiplier, the bridge
will also try ROUND_STARTED and ROUND_CRASHED.
=========================================================
*/

const WebSocket = require("ws");
const bigOddEngine = require("./big-odd-engine");

let installed = false;

function numberFrom(value) {
    const number = Number(
        typeof value === "string"
            ? value.trim().replace(/x$/i, "")
            : value
    );

    return Number.isFinite(number) ? number : NaN;
}

function getPayload(message) {
    if (!message || typeof message !== "object") return null;

    return message.data && typeof message.data === "object"
        ? message.data
        : null;
}

function getOdd(payload) {
    return numberFrom(
        payload.crashMultiplier ??
        payload.bigOdd ??
        payload.odd ??
        payload.multiplier
    );
}

function publishCreatedRound(payload) {
    const odd = getOdd(payload);

    if (
        !Number.isFinite(odd) ||
        odd < bigOddEngine.BIG_ODD_MINIMUM
    ) {
        return null;
    }

    const record = bigOddEngine.publishFromRound({
        roundId: payload.roundId,
        odd,
        crashMultiplier: odd,
        status: payload.status || "WAITING",
        createdAt: payload.createdAt || payload.serverTime,
        serverTime: payload.serverTime
    });

    if (record) {
        console.log(
            `[BIG ODD] Published round ${payload.roundId} -> ${record.odd.toFixed(2)}x`
        );
    }

    return record;
}

function ensurePublished(payload) {
    const existing = bigOddEngine
        .getHistory()
        .find(item => Number(item.roundId) === Number(payload.roundId));

    if (existing) return existing;

    return publishCreatedRound(payload);
}

function markRunning(payload) {
    /*
     * ROUND_STARTED is a fallback source because the crash
     * multiplier is exposed by the game server here.
     */
    const published = ensurePublished(payload);

    const record = bigOddEngine.updateRoundStatus(
        payload.roundId,
        "RUNNING",
        {
            runningAt:
                payload.startedAt ||
                payload.serverTime ||
                new Date().toISOString()
        }
    );

    if (record || published) {
        console.log(
            `[BIG ODD] Round ${payload.roundId} -> running`
        );
    }
}

function markPlayed(payload) {
    /*
     * Final fallback: if the earlier WebSocket event did not
     * contain the odd, try the crash event before marking it.
     */
    const published = ensurePublished(payload);

    const record = bigOddEngine.updateRoundStatus(
        payload.roundId,
        "PLAYED",
        {
            playedAt:
                payload.crashedAt ||
                payload.serverTime ||
                new Date().toISOString()
        }
    );

    if (record || published) {
        console.log(
            `[BIG ODD] Round ${payload.roundId} -> played`
        );
    }
}

function handleWebSocketMessage(message) {
    if (!message || typeof message !== "object") return;

    const payload = getPayload(message);
    if (!payload) return;

    switch (message.type) {
        case "ROUND_CREATED":
            publishCreatedRound(payload);
            break;

        case "ROUND_STARTED":
            markRunning(payload);
            break;

        case "ROUND_CRASHED":
            markPlayed(payload);
            break;

        default:
            break;
    }
}

function install() {
    if (installed) return;
    installed = true;

    const originalSend = WebSocket.prototype.send;

    WebSocket.prototype.send = function bigOddBridgeSend(data, ...args) {
        try {
            if (typeof data === "string") {
                handleWebSocketMessage(JSON.parse(data));
            }
        } catch (error) {
            console.warn(
                "[BIG ODD] Bridge ignored invalid WebSocket message:",
                error.message
            );
        }

        return originalSend.call(this, data, ...args);
    };

    console.log(
        `[BIG ODD] WebSocket bridge installed. Minimum: ${bigOddEngine.BIG_ODD_MINIMUM}x`
    );
}

module.exports = {
    install
};
