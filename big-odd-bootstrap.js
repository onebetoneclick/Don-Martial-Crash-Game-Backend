"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD BOOTSTRAP
=========================================================

This file connects the existing crash-game server to the
Big Odd REST API without replacing the current game server.

It does three jobs:
1. Adds /api/v1/big-odd/* routes to the existing HTTP server.
2. Adds POST /api/v1/api-key for secure API-key generation.
3. Bridges WebSocket round events into the Big Odd Engine.

BIG ODD FLOW:

WebSocket generates round + crash odd
        ↓
ROUND_CREATED
        ↓
Big Odd Engine stores it as status: null
        ↓
REST /upcoming and /today can see it
        ↓
ROUND_STARTED
        ↓
status: running
        ↓
ROUND_CRASHED
        ↓
status: played
=========================================================
*/

const http = require("http");
const WebSocket = require("ws");

const bigOddApi = require("./big-odd-api");
const bigOddEngine = require("./big-odd-engine");
const apiKeyManager = require("./api-key-manager");

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

            if (
                pathname === "/api/v1/api-key" ||
                pathname === "/api/v1/api-key/generate"
            ) {
                const handled = apiKeyManager.handleApiKeyRequest(
                    req,
                    res,
                    pathname
                );

                if (handled) return;
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

            if (payload && message.type === "ROUND_CREATED") {
                const crashMultiplier = Number(payload.crashMultiplier);

                if (
                    Number.isFinite(crashMultiplier) &&
                    crashMultiplier >= bigOddEngine.BIG_ODD_MINIMUM
                ) {
                    const record = bigOddEngine.publishFromRound({
                        roundId: payload.roundId,
                        status: payload.status || "WAITING",
                        crashMultiplier,
                        createdAt: payload.createdAt || payload.serverTime,
                        serverTime: payload.serverTime
                    });

                    if (record) {
                        console.log(
                            `[BIG ODD] Generated round ${payload.roundId} at ${crashMultiplier.toFixed(2)}x`
                        );
                    }
                }
            }

            if (payload && message.type === "ROUND_STARTED") {
                const record = bigOddEngine.updateRoundStatus(
                    payload.roundId,
                    "RUNNING",
                    {
                        runningAt:
                            payload.serverTime ||
                            new Date().toISOString()
                    }
                );

                if (record) {
                    console.log(
                        `[BIG ODD] Round ${payload.roundId} is now running`
                    );
                }
            }

            if (payload && message.type === "ROUND_CRASHED") {
                const record = bigOddEngine.updateRoundStatus(
                    payload.roundId,
                    "CRASHED",
                    {
                        playedAt:
                            payload.crashedAt ||
                            payload.serverTime ||
                            new Date().toISOString()
                    }
                );

                if (record) {
                    console.log(
                        `[BIG ODD] Round ${payload.roundId} marked played`
                    );
                }
            }
        }
    } catch {
        // Ignore non-JSON WebSocket messages and continue normally.
    }

    return originalSend.call(this, data, ...args);
};

console.log("[BIG ODD] Bootstrap loaded");
