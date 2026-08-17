"use strict";

/*
=========================================================
 DON MARTIAL USER / SUBSCRIPTION MANAGER
=========================================================

First-stage ownership layer for API keys.

User
  -> Subscription
  -> API keys

This version intentionally uses in-memory storage so it can
be introduced without requiring a database migration. The
API contract is designed so persistent storage can replace
these Maps later.
=========================================================
*/

const users = new Map();
const subscriptions = new Map();

const VALID_PLANS = new Set([
    "starter",
    "premium",
    "enterprise",
    "ultimate"
]);

function normalizePlan(plan) {
    const value = String(plan || "starter").trim().toLowerCase();
    return VALID_PLANS.has(value) ? value : "starter";
}

function normalizeUserId(userId) {
    const value = String(userId || "").trim();
    return value || null;
}

function ensureUser(options = {}) {
    const userId = normalizeUserId(options.userId);
    if (!userId) return null;

    const now = new Date().toISOString();
    let user = users.get(userId);

    if (!user) {
        user = {
            id: userId,
            name: options.name ? String(options.name).trim() : null,
            email: options.email ? String(options.email).trim().toLowerCase() : null,
            createdAt: now,
            updatedAt: now
        };
        users.set(userId, user);
    } else {
        if (options.name) user.name = String(options.name).trim();
        if (options.email) user.email = String(options.email).trim().toLowerCase();
        user.updatedAt = now;
    }

    return user;
}

function getUser(userId) {
    return users.get(normalizeUserId(userId)) || null;
}

function getSubscription(userId) {
    const id = normalizeUserId(userId);
    if (!id) return null;

    return subscriptions.get(id) || null;
}

function createOrUpdateSubscription(userId, options = {}) {
    const id = normalizeUserId(userId);
    if (!id) return null;

    ensureUser({
        userId: id,
        name: options.name,
        email: options.email
    });

    const now = new Date().toISOString();
    const plan = normalizePlan(options.plan);
    const existing = subscriptions.get(id);

    const subscription = existing || {
        userId: id,
        createdAt: now
    };

    subscription.plan = plan;
    subscription.status = options.status || "active";
    subscription.startedAt = options.startedAt || subscription.startedAt || now;
    subscription.expiresAt = options.expiresAt || subscription.expiresAt || null;
    subscription.paymentReference = options.paymentReference || subscription.paymentReference || null;
    subscription.updatedAt = now;

    subscriptions.set(id, subscription);
    return subscription;
}

function ensureStarterSubscription(userId, options = {}) {
    const existing = getSubscription(userId);
    if (existing) return existing;

    return createOrUpdateSubscription(userId, {
        ...options,
        plan: "starter",
        status: "active"
    });
}

function setPlan(userId, plan, options = {}) {
    return createOrUpdateSubscription(userId, {
        ...options,
        plan: normalizePlan(plan)
    });
}

function isSubscriptionActive(subscription) {
    if (!subscription || subscription.status !== "active") return false;

    if (subscription.expiresAt) {
        const expiry = new Date(subscription.expiresAt).getTime();
        if (Number.isFinite(expiry) && expiry <= Date.now()) return false;
    }

    return true;
}

function getUserProfile(userId) {
    const user = getUser(userId);
    if (!user) return null;

    const subscription = getSubscription(user.id);

    return {
        user,
        subscription: subscription
            ? { ...subscription, active: isSubscriptionActive(subscription) }
            : null
    };
}

function listUsers() {
    return Array.from(users.values());
}

module.exports = {
    ensureUser,
    getUser,
    getSubscription,
    createOrUpdateSubscription,
    ensureStarterSubscription,
    setPlan,
    isSubscriptionActive,
    getUserProfile,
    listUsers,
    normalizePlan
};
