"use strict";

const engine = require("./big-odd-engine");
const apiKeys = require("./api-key-manager");
const planManager = require("./api-plan-manager");

function getApiKey(req) {
    return apiKeys.getRequestKey(req);
}

function getKeyRecord(req) {
    return apiKeys.getRequestKeyRecord(req);
}

function isAuthorized(req) {
    return Boolean(getKeyRecord(req));
}

function isAdmin(req) {
    const configured = String(process.env.BIG_ODD_ADMIN_KEY || "").trim();
    const supplied = String(req.headers["x-admin-key"] || "").trim();
    return Boolean(configured && supplied && supplied === configured);
}

function sendJson(res, statusCode, payload) {
    if (res.headersSent) return;

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
                sendJson(res, 400, { success: false, error: "INVALID_JSON" });
                return;
            }

            if (!input || typeof input !== "object" || Array.isArray(input)) {
                sendJson(res, 400, { success: false, error: "INVALID_REQUEST_BODY" });
                return;
            }

            const odd =
                input.odd ??
                input.bigOdd ??
                input.multiplier ??
                input.crashMultiplier;

            const result = engine.publishTestOdd({
                ...input,
                odd
            });

            if (result && result.error) {
                sendJson(res, 400, {
                    success: false,
                    error: result.error,
                    minimum: result.minimum,
                    received: result.received,
                    message: result.message || "Big Odd value is invalid."
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

    const keyRecord = getKeyRecord(req);

    if (!keyRecord) {
        sendJson(res, 401, {
            success: false,
            error: "INVALID_API_KEY",
            message: "A valid Big Odd API key is required."
        });
        return true;
    }

    const plan = planManager.getPlan(keyRecord.plan);

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
            if (!plan.upcomingBigOdd) {
                sendJson(res, 403, {
                    success: false,
                    error: "PLAN_UPGRADE_REQUIRED",
                    message: "Upcoming Big Odd is available from the Premium plan.",
                    plan: plan.id,
                    requiredPlan: "premium",
                    upgrade: true,
                    availableEndpoints: {
                        current: "/api/v1/big-odd/current",
                        history: "/api/v1/big-odd/history",
                        today: "/api/v1/big-odd/today"
                    }
                });
                return true;
            }

            type = "upcoming";
            data = engine.getUpcoming().slice(0, plan.upcomingLimit);
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
        plan: planManager.getPlanResponse(plan.id),
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
