"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD BOOTSTRAP
=========================================================
*/

const http = require("http");

const bigOddApi = require("./big-odd-api");
const apiKeyManager = require("./api-key-manager");
const planManager = require("./api-plan-manager");
const bigOddWebSocketBridge = require("./big-odd-websocket-bridge");
const bigOddScheduler = require("./big-odd-scheduler");
const opayApi = require("./opay-api");

const originalCreateServer = http.createServer;

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-API-Key, X-Admin-Key"
    );
    res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, statusCode, payload) {
    if (res.headersSent) return;
    setCorsHeaders(res);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(payload));
}

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
            } catch {}

            if (
                req.method === "OPTIONS" &&
                pathname.startsWith("/api/v1/")
            ) {
                setCorsHeaders(res);
                res.writeHead(204);
                res.end();
                return;
            }

            /* Public API plan catalog */
            if (pathname === "/api/v1/api-key/plans") {
                if (req.method !== "GET") {
                    sendJson(res, 405, {
                        success: false,
                        error: "METHOD_NOT_ALLOWED"
                    });
                    return;
                }

                sendJson(res, 200, {
                    success: true,
                    type: "api-plans",
                    serverTime: new Date().toISOString(),
                    data: planManager.listPlans().map(plan =>
                        planManager.getPlanResponse(plan.id)
                    )
                });
                return;
            }

            if (pathname === "/api/v1/big-odd/bridge-status") {
                sendJson(res, 200, {
                    success: true,
                    type: "bridge-status",
                    serverTime: new Date().toISOString(),
                    bridge: bigOddWebSocketBridge.getStatus()
                });
                return;
            }

            if (pathname === "/api/v1/big-odd/scheduler-status") {
                sendJson(res, 200, {
                    success: true,
                    type: "scheduler-status",
                    serverTime: new Date().toISOString(),
                    scheduler: bigOddScheduler.getStatus()
                });
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

            if (pathname.startsWith("/api/v1/payments/opay")) {
                opayApi.handleOpayRequest(req, res, pathname)
                    .catch(error => {
                        console.error("[OPAY ROUTE]", error);
                        if (!res.headersSent) {
                            sendJson(res, 500, {
                                success: false,
                                error: "OPAY_ROUTE_ERROR",
                                message: error.message
                            });
                        }
                    });
                return;
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
console.log("[OPAY] Payment API routes loaded");
