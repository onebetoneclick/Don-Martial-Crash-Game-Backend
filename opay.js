"use strict";

const crypto = require("crypto");

const OPAY_SANDBOX_URL = "https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create";
const OPAY_PRODUCTION_URL = "https://api.opaycheckout.com/api/v1/international/cashier/create";

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
        url: environment === "production" ? OPAY_PRODUCTION_URL : OPAY_SANDBOX_URL
    };
}

function createReference() {
    return `DM-OPAY-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`.toUpperCase();
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
        userInfo: {
            userId: String(user.id || reference),
            userName: String(user.name || "Don Martial Customer"),
            userEmail: String(user.email || ""),
            userMobile: String(user.mobile || "")
        },
        returnUrl,
        callbackUrl: callbackUrl || undefined,
        cancelUrl: cancelUrl || undefined
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
        opay: data
    };
}

function getStatusConfig() {
    return getConfig();
}

module.exports = {
    createCashierPayment,
    getStatusConfig
};
