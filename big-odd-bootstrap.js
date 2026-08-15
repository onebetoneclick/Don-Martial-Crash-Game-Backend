"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD BOOTSTRAP
=========================================================

Loads the Big Odd REST API, API-key manager, and the live
WebSocket -> Big Odd bridge before server.js creates its
HTTP/WebSocket server.

FLOW:

Crash WebSocket
      ↓
Big Odd WebSocket Bridge
      ↓
Big Odd Engine
      ↓
Big Odd REST API
      ↓
mt_live_ API key
=========================================================
*/

const http = require("http");

const bigOddApi = require("./big-odd-api");
const apiKeyManager = require("./api-key-manager");
const bigOddWebSocketBridge = require("./big-odd-websocket-bridge");

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
   INSTALL LIVE WEBSOCKET BRIDGE
===================================================== */

bigOddWebSocketBridge.install();

console.log("[BIG ODD] Bootstrap loaded");
