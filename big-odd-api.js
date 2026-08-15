"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD REST API
=========================================================

Public subscriber endpoints:
 GET /api/v1/big-odd/current
 GET /api/v1/big-odd/next
 GET /api/v1/big-odd/upcoming
 GET /api/v1/big-odd/today
 GET /api/v1/big-odd/history

All public endpoints require an API key.

Temporary backend verification endpoint:
 POST /api/v1/big-odd/test-publish

It requires X-Admin-Key and is intended only to verify the
WebSocket -> Big Odd Engine -> REST API pipeline.
=========================================================
*/

const engine = require("./big-odd-engine");
const apiKeys = require("./api-key-manager");

function getApiKey(req) {
    return apiKeys.getRequestKey(req);
}

function isAuthorized(req) {
    return apiKeys.isValidApiKey(getApiKey(req));
}

function isAdmin(req) {
    const configured = String(process.env.BIG_ODD_ADMIN_KEY || "").trim();
    const supplied = String(req.headers["x-admin-key"] || "").trim();
    return Boolean(configured && supplied && supplied === configured);
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(payload));
}

function handleBigOddRequest(req, res, pathname) {
    if (!pathname.startsWith("/api/v1/big-odd/")) return false;

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Admin-Key"
        });
        res.end();
        return true;
    }

    if (pathname === "/api/v1/big-odd/test-publish") {
        if (req.method !== "POST") {
            sendJson(res, 405, { success: false, error: "METHOD_NOT_ALLOWED" });
            return true;
        }

        if (!isAdmin(req)) {
            sendJson(res, 401, {
                success: false,
                error: "INVALID_ADMIN_KEY",
                message: "A valid admin key is required for the test publisher."
            });
            return true;
        }

        let body = "";
        req.on("data", chunk => {
            body += chunk.toString();
            if (body.length > 10000) req.destroy();
        });

        req.on("end", () => {
            let input = {};
            try {
                input = body ? JSON.parse(body) : {};
            } catch {
                sendJson(res, 400, {
                    success: false,
                    error: "INVALID_JSON"
                });
                return;
            }

            const result = engine.publishTestOdd({
                odd: input.odd,
                roundId: input.roundId,
                status: input.status || null
            });

            if (result && result.error) {
                sendJson(res, 400, {
                    success: false,
                    error: result.error,
                    minimum: result.minimum
                });
                return;
            }

            sendJson(res, 201, {
                success: true,
                type: "test-publish",
                message: "Test Big Odd published to the engine.",
                serverTime: new Date().toISOString(),
                data: result,
                stats: engine.getStats()
            });
        });

        return true;
    }

    if (req.method !== "GET") {
        sendJson(res, 405, {
            success: false,
            error: "METHOD_NOT_ALLOWED"
        });
        return true;
    }

    if (!isAuthorized(req)) {
        sendJson(res, 401, {
            success: false,
            error: "INVALID_API_KEY",
            message: "A valid Big Odd API key is required."
        });
        return true;
    }

    let data;
    let type;

    switch (pathname) {
        case "/api/v1/big-odd/current":
            type = "current";
            data = engine.getCurrent();
            break;
        case "/api/v1/big-odd/next":
            type = "next";
            data = engine.getNext();
            break;
        case "/api/v1/big-odd/upcoming":
            type = "upcoming";
            data = engine.getUpcoming();
            break;
        case "/api/v1/big-odd/today":
            type = "today";
            data = engine.getToday();
            break;
        case "/api/v1/big-odd/history":
            type = "history";
            data = engine.getHistory();
            break;
        default:
            sendJson(res, 404, {
                success: false,
                error: "BIG_ODD_ROUTE_NOT_FOUND"
            });
            return true;
    }

    sendJson(res, 200, {
        success: true,
        type,
        serverTime: new Date().toISOString(),
        data,
        stats: engine.getStats()
    });

    return true;
}

module.exports = {
    handleBigOddRequest,
    isAuthorized
};
