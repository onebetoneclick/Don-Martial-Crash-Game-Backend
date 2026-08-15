"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD API KEY MANAGER
=========================================================

API keys use this format:
  mt_live_<32 hex characters>

Generated keys are stored as SHA-256 hashes in memory.
The plaintext key is returned only when it is created.

For production, set:
  BIG_ODD_ADMIN_KEY

The admin key is required to create new subscriber keys.
=========================================================
*/

const crypto = require("crypto");

const generatedKeyHashes = new Set();

function hashKey(key) {
    return crypto
        .createHash("sha256")
        .update(String(key), "utf8")
        .digest("hex");
}

function generateApiKey() {
    const key = `mt_live_${crypto.randomBytes(16).toString("hex")}`;
    generatedKeyHashes.add(hashKey(key));
    return key;
}

function isValidApiKey(key) {
    const supplied = String(key || "").trim();

    if (!supplied) return false;

    const configured = String(process.env.BIG_ODD_API_KEY || "").trim();

    if (configured && supplied === configured) {
        return true;
    }

    return generatedKeyHashes.has(hashKey(supplied));
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

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
    });

    res.end(JSON.stringify(payload));
}

function handleApiKeyRequest(req, res, pathname) {
    if (
        pathname !== "/api/v1/api-key" &&
        pathname !== "/api/v1/api-key/generate"
    ) {
        return false;
    }

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Admin-Key"
        });
        res.end();
        return true;
    }

    if (req.method !== "POST") {
        sendJson(res, 405, {
            success: false,
            error: "METHOD_NOT_ALLOWED"
        });
        return true;
    }

    const configuredAdminKey = String(
        process.env.BIG_ODD_ADMIN_KEY || ""
    ).trim();

    if (!configuredAdminKey) {
        sendJson(res, 503, {
            success: false,
            error: "API_KEY_PROVISIONING_NOT_CONFIGURED",
            message: "Set BIG_ODD_ADMIN_KEY in Render environment variables before creating API keys."
        });
        return true;
    }

    const suppliedAdminKey = String(
        req.headers["x-admin-key"] || ""
    ).trim();

    if (!suppliedAdminKey || suppliedAdminKey !== configuredAdminKey) {
        sendJson(res, 401, {
            success: false,
            error: "INVALID_ADMIN_KEY",
            message: "A valid admin key is required to create a Big Odd API key."
        });
        return true;
    }

    const apiKey = generateApiKey();

    sendJson(res, 201, {
        success: true,
        message: "Big Odd API key created. Store this key securely; it will not be returned again.",
        apiKey,
        prefix: "mt_live_",
        createdAt: new Date().toISOString()
    });

    return true;
}

module.exports = {
    generateApiKey,
    isValidApiKey,
    getRequestKey,
    handleApiKeyRequest
};
