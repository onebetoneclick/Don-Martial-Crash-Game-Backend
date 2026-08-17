"use strict";

const crypto = require("crypto");
const planManager = require("./api-plan-manager");

/*
=========================================================
 DON MARTIAL API KEY MANAGER
=========================================================

Every generated key has a plan and its permissions are
checked on the backend. Plaintext keys are never stored.

Plans:
  starter    -> no upcoming Big Odd
  premium    -> 3 upcoming Big Odds
  enterprise -> 5 upcoming Big Odds
  ultimate   -> 10 upcoming Big Odds

IMPORTANT:
This in-memory registry is the first API-key layer. The
subscription/database layer can later persist these records
without changing the API contract.
=========================================================
*/

const generatedKeys = new Map();

function hashKey(key) {
    return crypto
        .createHash("sha256")
        .update(String(key), "utf8")
        .digest("hex");
}

function generateApiKey(options = {}) {
    const plan = planManager.normalizePlan(options.plan);
    const key = `mt_live_${crypto.randomBytes(24).toString("hex")}`;
    const keyHash = hashKey(key);
    const now = new Date().toISOString();

    generatedKeys.set(keyHash, {
        keyId: `key_${crypto.randomBytes(8).toString("hex")}`,
        plan,
        status: "active",
        createdAt: now,
        lastUsedAt: null
    });

    return key;
}

function getKeyRecord(key) {
    const supplied = String(key || "").trim();
    if (!supplied) return null;

    const record = generatedKeys.get(hashKey(supplied));
    if (!record || record.status !== "active") return null;

    record.lastUsedAt = new Date().toISOString();
    return record;
}

function getApiKeyInfo(key) {
    const record = getKeyRecord(key);
    if (!record) return null;

    return {
        keyId: record.keyId,
        plan: planManager.getPlanResponse(record.plan),
        status: record.status,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt
    };
}

function isValidApiKey(key) {
    return Boolean(getKeyRecord(key));
}

function getRequestKey(req) {
    const header = req.headers["x-api-key"];
    if (header) return String(header).trim();

    const authorization = req.headers.authorization || "";
    if (/^Bearer\s+/i.test(authorization)) {
        return authorization.replace(/^Bearer\s+/i, "").trim();
    }

    return "";
}

function getRequestKeyRecord(req) {
    return getKeyRecord(getRequestKey(req));
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
    });

    res.end(JSON.stringify(payload));
}

function isAdmin(req) {
    const configuredAdminKey = String(
        process.env.BIG_ODD_ADMIN_KEY || ""
    ).trim();

    const suppliedAdminKey = String(
        req.headers["x-admin-key"] || ""
    ).trim();

    return Boolean(configuredAdminKey && suppliedAdminKey && suppliedAdminKey === configuredAdminKey);
}

function handleApiKeyRequest(req, res, pathname) {
    const isKeyRoute =
        pathname === "/api/v1/api-key" ||
        pathname === "/api/v1/api-key/generate" ||
        pathname === "/api/v1/api-key/plans" ||
        pathname === "/api/v1/api-key/me";

    if (!isKeyRoute) return false;

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Admin-Key"
        });
        res.end();
        return true;
    }

    if (pathname === "/api/v1/api-key/plans") {
        if (req.method !== "GET") {
            sendJson(res, 405, { success: false, error: "METHOD_NOT_ALLOWED" });
            return true;
        }

        sendJson(res, 200, {
            success: true,
            plans: planManager.listPlans().map(plan => planManager.getPlanResponse(plan.id))
        });
        return true;
    }

    if (pathname === "/api/v1/api-key/me") {
        if (req.method !== "GET") {
            sendJson(res, 405, { success: false, error: "METHOD_NOT_ALLOWED" });
            return true;
        }

        const key = getRequestKey(req);
        const info = getApiKeyInfo(key);

        if (!info) {
            sendJson(res, 401, {
                success: false,
                error: "INVALID_API_KEY",
                message: "A valid API key is required."
            });
            return true;
        }

        sendJson(res, 200, {
            success: true,
            data: info
        });
        return true;
    }

    if (req.method !== "POST") {
        sendJson(res, 405, { success: false, error: "METHOD_NOT_ALLOWED" });
        return true;
    }

    if (!isAdmin(req)) {
        sendJson(res, 401, {
            success: false,
            error: "INVALID_ADMIN_KEY",
            message: "A valid admin key is required to create a Big Odd API key."
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

        const plan = planManager.normalizePlan(input.plan);
        const apiKey = generateApiKey({ plan });

        sendJson(res, 201, {
            success: true,
            message: "API key created. Store this key securely; the plaintext key will not be returned again.",
            apiKey,
            plan: planManager.getPlanResponse(plan),
            endpoints: {
                current: "/api/v1/big-odd/current",
                history: "/api/v1/big-odd/history",
                today: "/api/v1/big-odd/today",
                upcoming: planManager.getPlan(plan).upcomingBigOdd
                    ? "/api/v1/big-odd/upcoming"
                    : null
            },
            createdAt: new Date().toISOString()
        });
    });

    return true;
}

module.exports = {
    generateApiKey,
    isValidApiKey,
    getRequestKey,
    getRequestKeyRecord,
    getApiKeyInfo,
    handleApiKeyRequest
};
