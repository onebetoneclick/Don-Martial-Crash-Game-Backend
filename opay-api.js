"use strict";

const opay = require("./opay");

function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, status, payload) {
    cors(res);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(payload));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk.toString();
            if (body.length > 1024 * 1024) {
                reject(new Error("Request body too large."));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Invalid JSON body."));
            }
        });
        req.on("error", reject);
    });
}

async function handleOpayRequest(req, res, pathname) {
    if (!pathname.startsWith("/api/v1/payments/opay")) return false;

    if (req.method === "OPTIONS") {
        cors(res);
        res.writeHead(204);
        res.end();
        return true;
    }

    if (pathname === "/api/v1/payments/opay/config" && req.method === "GET") {
        try {
            const config = opay.getStatusConfig();
            return json(res, 200, {
                success: true,
                provider: "opay",
                environment: config.environment,
                configured: true,
                sandbox: config.environment !== "production"
            });
        } catch (error) {
            return json(res, 503, {
                success: false,
                provider: "opay",
                configured: false,
                error: error.code || "OPAY_NOT_CONFIGURED",
                message: error.message
            });
        }
    }

    if (pathname === "/api/v1/payments/opay/create" && req.method === "POST") {
        try {
            const body = await readBody(req);
            const result = await opay.createCashierPayment({
                amount: body.amount,
                currency: body.currency || "NGN",
                productName: body.productName || "Don Martial Entertainment",
                productDescription: body.productDescription || "Don Martial entertainment subscription",
                user: body.user || {},
                returnUrl: body.returnUrl,
                callbackUrl: body.callbackUrl,
                cancelUrl: body.cancelUrl
            });

            return json(res, 200, {
                success: true,
                provider: "opay",
                reference: result.reference,
                environment: result.environment,
                data: result.opay
            });
        } catch (error) {
            console.error("[OPAY CREATE]", error.message, error.opay || "");
            return json(res, error.status >= 400 && error.status < 600 ? error.status : 500, {
                success: false,
                provider: "opay",
                error: error.code || "OPAY_CREATE_FAILED",
                message: error.message,
                details: error.opay || undefined
            });
        }
    }

    if (pathname === "/api/v1/payments/opay/webhook" && req.method === "POST") {
        try {
            const body = await readBody(req);
            console.log("[OPAY WEBHOOK]", JSON.stringify(body));
            return json(res, 200, {
                success: true,
                received: true,
                provider: "opay",
                serverTime: new Date().toISOString()
            });
        } catch (error) {
            return json(res, 400, {
                success: false,
                error: "INVALID_WEBHOOK",
                message: error.message
            });
        }
    }

    return json(res, 404, {
        success: false,
        error: "OPAY_ROUTE_NOT_FOUND"
    });
}

module.exports = { handleOpayRequest };
