"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD BOOTSTRAP
=========================================================

This file connects the existing crash-game server to the
Big Odd REST API without replacing the current game server.

It does two jobs:
1. Adds /api/v1/big-odd/* routes to the existing HTTP server.
2. Watches server WebSocket messages so BIG ODD records are
   automatically published/updated in the Big Odd Engine.

Start with:
  node -r ./big-odd-bootstrap.js server.js
=========================================================
*/

const http = require("http");
const WebSocket = require("ws");

const bigOddApi = require("./big-odd-api");
const bigOddEngine = require("./big-odd-engine");

/* =====================================================
   HTTP ROUTE INTEGRATION
===================================================== */

const originalCreateServer = http.createServer;

http.createServer = function patchedCreateServer(...args) {
    const listenerIndex = typeof args[0] === "function" ? 0 : 1;
    const originalListener = args[listenerIndex];

    if (typeof originalListener === "function") {
        args[listenerIndex] = function patchedRequestHandler(req, res) {
            let pathname = req.url || "/";

            try {
                pathname = new URL(
                    req.url || "/",
                    `http://${req.headers.host || "localhost"}`
                ).pathname;
            } catch {
                // Keep the raw URL if parsing fails.
            }

            if (pathname.startsWith("/api/v1/big-odd/")) {
                const handled = bigOddApi.handleBigOddRequest(
                    req,
                    res,
                    pathname
                );

                if (handled) return;
            }

            return originalListener(req, res);
        };
    }

    return originalCreateServer.apply(http, args);
};

/* =====================================================
   WEBSOCKET BIG ODD BRIDGE
===================================================== */

const originalSend = WebSocket.prototype.send;

WebSocket.prototype.send = function patchedSend(data, ...args) {
    try {
        if (typeof data === "string") {
            const message = JSON.parse(data);
            const payload = message && message.data;

            if (payload && message.type === "ROUND_STARTED") {
                const crashMultiplier = Number(payload.crashMultiplier);

                if (
                    Number.isFinite(crashMultiplier) &&
                    crashMultiplier >= bigOddEngine.BIG_ODD_MINIMUM
                ) {
                    bigOddEngine.publishFromRound({
                        roundId: payload.roundId,
                        status: "RUNNING",
                        crashMultiplier,
                        startedAt: payload.serverTime || new Date().toISOString(),
                        createdAt: payload.serverTime || new Date().toISOString()
                    });

                    console.log(
                        `[BIG ODD] Published round ${payload.roundId} at ${crashMultiplier.toFixed(2)}x`
                    );
                }
            }

            if (payload && message.type === "ROUND_CRASHED") {
                bigOddEngine.updateRoundStatus(
                    payload.roundId,
                    "CRASHED",
                    {
                        playedAt:
                            payload.serverTime ||
                            new Date().toISOString()
                    }
                );

                console.log(
                    `[BIG ODD] Round ${payload.roundId} marked played`
                );
            }
        }
    } catch {
        // Ignore non-JSON WebSocket messages and continue normally.
    }

    return originalSend.call(this, data, ...args);
};

console.log("[BIG ODD] Bootstrap loaded");
