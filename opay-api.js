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

// Development/test payment records. These are intentionally in memory for now.
// Before production we will move these to persistent storage (Supabase/PostgreSQL).
const paymentRecords = new Map();

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
                sandbox: config.environment !== "production",
                webhookUrl: config.callbackUrl
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

            paymentRecords.set(result.reference, {
                reference: result.reference,
                provider: "opay",
                environment: result.environment,
                status: "INITIAL",
                amount: body.amount,
                currency: body.currency || "NGN",
                user: body.user || {},
                createdAt: new Date().toISOString(),
                lastUpdatedAt: new Date().toISOString()
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

    if (pathname === "/api/v1/payments/opay/status" && req.method === "POST") {
        try {
            const body = await readBody(req);
            const reference = body.reference;
            const orderNo = body.orderNo;

            if (!reference && !orderNo) {
                return json(res, 400, {
                    success: false,
                    provider: "opay",
                    error: "INVALID_REFERENCE",
                    message: "reference or orderNo is required."
                });
            }

            const result = await opay.queryPaymentStatus({
                reference,
                orderNo,
                country: body.country || "NG"
            });

            const opayData = result.opay && result.opay.data ? result.opay.data : {};
            const resolvedReference = opayData.reference || reference;
            const record = paymentRecords.get(resolvedReference);

            if (record) {
                record.status = opayData.status || record.status;
                record.orderNo = opayData.orderNo || record.orderNo;
                record.lastUpdatedAt = new Date().toISOString();
                record.opay = opayData;
            }

            return json(res, 200, {
                success: true,
                provider: "opay",
                environment: result.environment,
                reference: resolvedReference,
                payment: record || null,
                data: result.opay
            });
        } catch (error) {
            console.error("[OPAY STATUS]", error.message, error.opay || "");
            return json(res, error.status >= 400 && error.status < 600 ? error.status : 500, {
                success: false,
                provider: "opay",
                error: error.code || "OPAY_STATUS_FAILED",
                message: error.message,
                details: error.opay || undefined
            });
        }
    }

    if (pathname.startsWith("/api/v1/payments/opay/status/") && req.method === "GET") {
        const reference = decodeURIComponent(pathname.slice("/api/v1/payments/opay/status/".length));
        if (!reference) {
            return json(res, 400, {
                success: false,
                provider: "opay",
                error: "INVALID_REFERENCE"
            });
        }

        try {
            const result = await opay.queryPaymentStatus({ reference, country: "NG" });
            const opayData = result.opay && result.opay.data ? result.opay.data : {};
            const record = paymentRecords.get(reference);

            if (record) {
                record.status = opayData.status || record.status;
                record.orderNo = opayData.orderNo || record.orderNo;
                record.lastUpdatedAt = new Date().toISOString();
                record.opay = opayData;
            }

            return json(res, 200, {
                success: true,
                provider: "opay",
                environment: result.environment,
                reference,
                payment: record || null,
                data: result.opay
            });
        } catch (error) {
            console.error("[OPAY STATUS GET]", error.message, error.opay || "");
            return json(res, error.status >= 400 && error.status < 600 ? error.status : 500, {
                success: false,
                provider: "opay",
                error: error.code || "OPAY_STATUS_FAILED",
                message: error.message,
                details: error.opay || undefined
            });
        }
    }

    if (pathname === "/api/v1/payments/opay/webhook" && req.method === "POST") {
        try {
            const body = await readBody(req);
            const signature = req.headers.signature || req.headers["x-opay-signature"] || body.sha512;
            const requestTimestamp = req.headers.requesttimestamp || req.headers["x-opay-request-timestamp"];
            const signatureValid = opay.verifyCallbackSignature(body, signature, requestTimestamp);

            console.log("[OPAY WEBHOOK]", JSON.stringify({
                signatureValid,
                reference: body.reference || (body.payload && body.payload.reference) || null,
                status: body.status || (body.payload && body.payload.status) || null
            }));

            const payload = body.payload && typeof body.payload === "object" ? body.payload : body;
            const reference = payload.reference;
            const status = payload.status || "UNKNOWN";

            if (reference) {
                const record = paymentRecords.get(reference) || {
                    reference,
                    provider: "opay",
                    environment: opay.getStatusConfig().environment,
                    createdAt: new Date().toISOString()
                };
                record.callbackStatus = status;
                record.status = status;
                record.callbackReceivedAt = new Date().toISOString();
                record.signatureValid = signatureValid;
                record.callback = payload;
                paymentRecords.set(reference, record);

                // Cross-verification is deliberately attempted before any future entitlement grant.
                try {
                    const verified = await opay.queryPaymentStatus({ reference, country: payload.country || "NG" });
                    record.verification = verified.opay;
                    if (verified.opay && verified.opay.data && verified.opay.data.status) {
                        record.status = verified.opay.data.status;
                    }
                    record.lastUpdatedAt = new Date().toISOString();
                } catch (verificationError) {
                    record.verificationError = verificationError.message;
                    record.lastUpdatedAt = new Date().toISOString();
                    console.error("[OPAY WEBHOOK VERIFY]", verificationError.message);
                }
            }

            // OPay requires a 2xx acknowledgement; never grant a subscription from the callback alone.
            return json(res, 200, {
                success: true,
                received: true,
                provider: "opay",
                reference: reference || null,
                status,
                signatureValid,
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

    if (pathname === "/api/v1/payments/opay/records" && req.method === "GET") {
        return json(res, 200, {
            success: true,
            provider: "opay",
            count: paymentRecords.size,
            data: Array.from(paymentRecords.values()).map(record => ({
                ...record,
                // Don't expose sensitive configuration values.
                user: record.user ? {
                    id: record.user.id,
                    name: record.user.name,
                    email: record.user.email
                } : undefined
            }))
        });
    }

    return json(res, 404, {
        success: false,
        error: "OPAY_ROUTE_NOT_FOUND"
    });
}

module.exports = { handleOpayRequest };
