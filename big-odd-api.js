"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD REST API
=========================================================

Endpoints:
 GET /api/v1/big-odd/current
 GET /api/v1/big-odd/next
 GET /api/v1/big-odd/upcoming
 GET /api/v1/big-odd/today
 GET /api/v1/big-odd/history

All endpoints require an API key.
The API key is supplied with:
  x-api-key: YOUR_KEY
or:
  Authorization: Bearer YOUR_KEY

The engine itself does not invent API results. The game
server publishes generated BIG ODD records into it.
=========================================================
*/

const engine = require("./big-odd-engine");

function getApiKey(req) {
    const header = req.headers["x-api-key"];
    if (header) return String(header).trim();

    const authorization = req.headers.authorization || "";
    if (/^Bearer\s+/i.test(authorization)) {
        return authorization.replace(/^Bearer\s+/i, "").trim();
    }

    return "";
}

function isAuthorized(req) {
    const expected = String(process.env.BIG_ODD_API_KEY || "").trim();
    if (!expected) return false;
    return getApiKey(req) === expected;
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
    if (!pathname.startsWith("/api/v1/big-odd/")) {
        return false;
    }

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key"
        });
        res.end();
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
