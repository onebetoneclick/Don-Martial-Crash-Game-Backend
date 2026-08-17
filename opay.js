"use strict";

const crypto = require("crypto");

const OPAY_SANDBOX_URL = "https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create";
const OPAY_PRODUCTION_URL = "https://api.opaycheckout.com/api/v1/international/cashier/create";
const OPAY_STATUS_SANDBOX_URL = "https://sandboxapi.opaycheckout.com/api/v1/international/cashier/status";
const OPAY_STATUS_PRODUCTION_URL = "https://api.opaycheckout.com/api/v1/international/cashier/status";

function getConfig() {
    const merchantId = process.env.OPAY_MERCHANT_ID;
    const publicKey = process.env.OPAY_PUBLIC_KEY;
    const secretKey = process.env.OPAY_SECRET_KEY;
    const environment = String(process.env.OPAY_ENV || "sandbox").toLowerCase();

    if (!merchantId || !publicKey || !secretKey) {
        const error = new Error("OPay is not configured. Set OPAY_MERCHANT_ID, OPAY_PUBLIC_KEY and OPAY_SECRET_KEY.");
        error.code = "OPAY_NOT_CONFIGURED";
        throw error;
    }

    return {
        merchantId,
        publicKey,
        secretKey,
        environment,
        url: environment === "production" ? OPAY_PRODUCTION_URL : OPAY_SANDBOX_URL,
        statusUrl: environment === "production" ? OPAY_STATUS_PRODUCTION_URL : OPAY_STATUS_SANDBOX_URL,
        callbackUrl: process.env.OPAY_CALLBACK_URL || "https://don-martial-crash-game-backend.onrender.com/api/v1/payments/opay/webhook"
    };
}

function createReference() {
    return `DM-OPAY-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`.toUpperCase();
}

function sortObject(value) {
    if (Array.isArray(value)) return value.map(sortObject);
    if (value && typeof value === "object") {
        return Object.keys(value).sort().reduce((out, key) => {
            out[key] = sortObject(value[key]);
            return out;
        }, {});
    }
    return value;
}

function signPayload(payload, secretKey) {
    const ordered = JSON.stringify(sortObject(payload));
    return crypto.createHmac("sha512", secretKey).update(ordered).digest("hex");
}

async function opayRequest(url, body, config) {
    const signature = signPayload(body, config.secretKey);

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": `Bearer ${signature}`,
            "MerchantId": config.merchantId
        },
        body: JSON.stringify(body)
    });

    const raw = await response.text();
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        data = { raw };
    }

    if (!response.ok || (data.code && data.code !== "00000" && data.code !== "00")) {
        const error = new Error(data.message || `OPay returned HTTP ${response.status}`);
        error.code = data.code || "OPAY_REQUEST_FAILED";
        error.status = response.status;
        error.opay = data;
        throw error;
    }

    return data;
}

async function createCashierPayment({ amount, currency = "NGN", productName = "Don Martial Subscription", productDescription = "Don Martial entertainment subscription", user = {}, returnUrl, callbackUrl, cancelUrl }) {
    const config = getConfig();
    const numericAmount = Number(amount);

    if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
        const error = new Error("amount must be a positive integer in the currency's smallest unit.");
        error.code = "INVALID_AMOUNT";
        throw error;
    }

    if (!returnUrl) {
        const error = new Error("returnUrl is required.");
        error.code = "INVALID_RETURN_URL";
        throw error;
    }

    const reference = createReference();
    const finalCallbackUrl = callbackUrl || config.callbackUrl;

    const body = {
        country: "NG",
        reference,
        amount: {
            total: numericAmount,
            currency: String(currency).toUpperCase()
        },
        product: {
            name: productName,
            description: productDescription
        },
        productList: [
            {
                productId: reference,
                name: productName,
                description: productDescription,
                price: numericAmount,
                quantity: 1
            }
        ],
        userInfo: {
            userId: String(user.id || reference),
            userName: String(user.name || "Don Martial Customer"),
            userEmail: String(user.email || ""),
            userMobile: String(user.mobile || "")
        },
        returnUrl,
        callbackUrl: finalCallbackUrl,
        cancelUrl: cancelUrl || undefined,
        expireAt: 30
    };

    const response = await fetch(config.url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": `Bearer ${config.publicKey}`,
            "MerchantId": config.merchantId
        },
        body: JSON.stringify(body)
    });

    const raw = await response.text();
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        data = { raw };
    }

    if (!response.ok || (data.code && data.code !== "00000" && data.code !== "00")) {
        const error = new Error(data.message || `OPay returned HTTP ${response.status}`);
        error.code = data.code || "OPAY_REQUEST_FAILED";
        error.status = response.status;
        error.opay = data;
        throw error;
    }

    return {
        reference,
        environment: config.environment,
        callbackUrl: finalCallbackUrl,
        opay: data
    };
}

async function queryPaymentStatus({ reference, orderNo, country = "NG" }) {
    const config = getConfig();

    if (!reference && !orderNo) {
        const error = new Error("reference or orderNo is required.");
        error.code = "INVALID_REFERENCE";
        throw error;
    }

    const body = {
        country: String(country).toUpperCase()
    };

    if (reference) body.reference = String(reference);
    if (orderNo) body.orderNo = String(orderNo);

    const data = await opayRequest(config.statusUrl, body, config);

    return {
        environment: config.environment,
        opay: data
    };
}

function verifyCallbackSignature(body, signature, requestTimestamp) {
    const config = getConfig();
    if (!signature) return false;

    const bodyText = JSON.stringify(body);
    const candidates = [];

    // Current callback documentation: HMAC-SHA512 over RequestTimestamp + request body.
    if (requestTimestamp) {
        candidates.push(
            crypto.createHmac("sha512", config.secretKey)
                .update(String(requestTimestamp) + bodyText)
                .digest("hex")
        );
    }

    // Also support the callback format documented by OPay that signs the raw JSON body.
    candidates.push(
        crypto.createHmac("sha512", config.secretKey)
            .update(bodyText)
            .digest("hex")
    );

    // Some OPay callback documentation uses HMAC-SHA3-512 for the sha512 field.
    candidates.push(
        crypto.createHmac("sha3-512", config.secretKey)
            .update(bodyText)
            .digest("hex")
    );

    const supplied = String(signature).toLowerCase();
    return candidates.some(expected => {
        try {
            return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
        } catch {
            return false;
        }
    });
}

function getStatusConfig() {
    return getConfig();
}

module.exports = {
    createCashierPayment,
    queryPaymentStatus,
    verifyCallbackSignature,
    getStatusConfig
};
