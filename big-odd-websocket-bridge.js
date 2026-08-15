"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD WEBSOCKET BRIDGE
=========================================================

Consumes the crash server's outgoing WebSocket events and
publishes qualifying crash multipliers (>= BIG_ODD_MINIMUM)
to the Big Odd engine.

Important:
- This is an internal bridge; it does not create a second
  WebSocket server.
- It watches the exact messages the crash server broadcasts.
- ROUND_STARTED and ROUND_CRASHED are fallbacks when the
  earlier event does not contain the multiplier.
=========================================================
*/

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
        serverTime: payload.serverTime,
        startedAt: payload.startedAt,
        crashedAt: payload.crashedAt
    });

    if (record) {
        console.log(
            `[BIG ODD] Published round ${payload.roundId} -> ${record.odd.toFixed(2)}x`
        );
    }

    return record;
}

function ensurePublished(payload) {
    const roundId = Number(payload.roundId);

    if (Number.isFinite(roundId)) {
        const existing = bigOddEngine
            .getHistory()
            .find(item => Number(item.roundId) === roundId);

        if (existing) return existing;
    }

    return publishCreatedRound(payload);
}

function markRunning(payload) {
    const published = ensurePublished(payload);

    if (!published) {
        return;
    }

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

    if (record) {
        console.log(
            `[BIG ODD] Round ${payload.roundId} -> running`
        );
    }
}

function markPlayed(payload) {
    const published = ensurePublished(payload);

    if (!published) {
        return;
    }

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

    if (record) {
        console.log(
            `[BIG ODD] Round ${payload.roundId} -> played`
        );
    }
}

function processMessage(message) {
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

    /*
     * Keep the existing WebSocket bridge, but make the hook
     * defensive and non-blocking. ws sends strings in our
     * crash server, so only JSON strings are inspected.
     */
    let WebSocket;

    try {
        WebSocket = require("ws");
    } catch (error) {
        console.error("[BIG ODD] Could not load ws:", error.message);
        return;
    }

    const originalSend = WebSocket.prototype.send;

    if (typeof originalSend !== "function") {
        console.error("[BIG ODD] WebSocket.send was not found.");
        return;
    }

    WebSocket.prototype.send = function bigOddBridgeSend(data, ...args) {
        try {
            if (typeof data === "string") {
                processMessage(JSON.parse(data));
            }
        } catch (error) {
            console.warn(
                "[BIG ODD] Bridge ignored outgoing message:",
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
    install,
    processMessage
};
