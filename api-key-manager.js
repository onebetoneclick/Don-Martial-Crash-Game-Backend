"use strict";

const crypto = require("crypto");
const planManager = require("./api-plan-manager");
const subscriptionManager = require("./subscription-manager");

/*
=========================================================
 DON MARTIAL API KEY MANAGER
=========================================================

Every generated key has an owner userId and a plan.
Plaintext keys are never stored.

The subscription is the source of truth for the user's
plan when an owner is attached to a key. This lets a future
OPay payment upgrade the user's subscription and immediately
change the permissions of the existing API key.

Current storage is in-memory. It can later be replaced by
Supabase/PostgreSQL without changing the API contract.
=========================================================
*/

const generatedKeys = new Map();

function hashKey(key) {
    return crypto.createHash("sha256").update(String(key), "utf8").digest("hex");
}

function generateApiKey(options = {}) {
    const userId = String(options.userId || "").trim() || null;
    const plan = planManager.normalizePlan(options.plan);
    const key = `mt_live_${crypto.randomBytes(24).toString("hex")}`;
    const keyHash = hashKey(key);
    const now = new Date().toISOString();

    if (userId) {
        subscriptionManager.ensureUser({
            userId,
            name: options.name,
            email: options.email
        });
        subscriptionManager.createOrUpdateSubscription(userId, {
            plan,
            status: "active"
        });
    }

    const record = {
        keyId: `key_${crypto.randomBytes(8).toString("hex")}`,
        userId,
        plan,
        status: "active",
        createdAt: now,
        lastUsedAt: null,
        requestCount: 0
    };

    generatedKeys.set(keyHash, record);
    return { key, record };
}

function syncPlanFromSubscription(record) {
    if (!record || !record.userId) return record;

    const subscription = subscriptionManager.getSubscription(record.userId);
    if (subscription && subscriptionManager.isSubscriptionActive(subscription)) {
        record.plan = planManager.normalizePlan(subscription.plan);
    }

    return record;
}

function getKeyRecord(key) {
    const supplied = String(key || "").trim();
    if (!supplied) return null;

    const record = generatedKeys.get(hashKey(supplied));
    if (!record || record.status !== "active") return null;

    syncPlanFromSubscription(record);
    record.lastUsedAt = new Date().toISOString();
    record.requestCount = Number(record.requestCount || 0) + 1;
    return record;
}

function getApiKeyInfo(key) {
    const record = getKeyRecord(key);
    if (!record) return null;

    const profile = record.userId
        ? subscriptionManager.getUserProfile(record.userId)
        : null;

    return {
        keyId: record.keyId,
        userId: record.userId,
        plan: planManager.getPlanResponse(record.plan),
        status: record.status,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        requestCount: record.requestCount,
        user: profile ? profile.user : null,
        subscription: profile ? profile.subscription : null
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
    const configuredAdminKey = String(process.env.BIG_ODD_ADMIN_KEY || "").trim();
    const suppliedAdminKey = String(req.headers["x-admin-key"] || "").trim();
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

        const info = getApiKeyInfo(getRequestKey(req));
        if (!info) {
            sendJson(res, 401, {
                success: false,
                error: "INVALID_API_KEY",
                message: "A valid API key is required."
            });
            return true;
        }

        sendJson(res, 200, { success: true, data: info });
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
        const result = generateApiKey({
            plan,
            userId: input.userId,
            name: input.name,
            email: input.email
        });

        sendJson(res, 201, {
            success: true,
            message: "API key created. Store this key securely; the plaintext key will not be returned again.",
            apiKey: result.key,
            keyId: result.record.keyId,
            userId: result.record.userId,
            plan: planManager.getPlanResponse(plan),
            endpoints: {
                current: "/api/v1/big-odd/current",
                history: "/api/v1/big-odd/history",
                today: "/api/v1/big-odd/today",
                upcoming: planManager.getPlan(plan).upcomingBigOdd
                    ? "/api/v1/big-odd/upcoming"
                    : null,
                schedulerStatus: planManager.getPlan(plan).upcomingBigOdd
                    ? "/api/v1/big-odd/scheduler-status"
                    : null
            },
            createdAt: result.record.createdAt
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
