"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD BOOTSTRAP
=========================================================

Loads the Big Odd REST API, API-key manager, live WebSocket
bridge, and daily Big Odd scheduler before server.js creates
its HTTP/WebSocket server.
=========================================================
*/

const http = require("http");

const bigOddApi = require("./big-odd-api");
const apiKeyManager = require("./api-key-manager");
const bigOddWebSocketBridge = require("./big-odd-websocket-bridge");
const bigOddScheduler = require("./big-odd-scheduler");

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
                // Keep raw URL if parsing fails.
            }

            if (pathname === "/api/v1/big-odd/bridge-status") {
                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store"
                });

                res.end(JSON.stringify({
                    success: true,
                    type: "bridge-status",
                    serverTime: new Date().toISOString(),
                    bridge: bigOddWebSocketBridge.getStatus()
                }));

                return;
            }

            if (pathname === "/api/v1/big-odd/scheduler-status") {
                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store"
                });

                res.end(JSON.stringify({
                    success: true,
                    type: "scheduler-status",
                    serverTime: new Date().toISOString(),
                    scheduler: bigOddScheduler.getStatus()
                }));

                return;
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

bigOddWebSocketBridge.install();
bigOddScheduler.install();

console.log("[BIG ODD] Bootstrap loaded");
