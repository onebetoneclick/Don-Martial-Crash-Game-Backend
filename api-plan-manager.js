"use strict";

/*
=========================================================
 DON MARTIAL API PLAN MANAGER
=========================================================

Starter   -> no upcoming Big Odd
Premium   -> 3 upcoming
Enterprise-> 5 upcoming
Ultimate  -> 10 upcoming

The plan is attached to each generated API key.
=========================================================
*/

const PLANS = Object.freeze({
    starter: Object.freeze({
        id: "starter",
        name: "Starter",
        upcomingBigOdd: false,
        upcomingLimit: 0,
        rateLimitPerMinute: 60
    }),
    premium: Object.freeze({
        id: "premium",
        name: "Premium",
        upcomingBigOdd: true,
        upcomingLimit: 3,
        rateLimitPerMinute: 300
    }),
    enterprise: Object.freeze({
        id: "enterprise",
        name: "Enterprise",
        upcomingBigOdd: true,
        upcomingLimit: 5,
        rateLimitPerMinute: 1000
    }),
    ultimate: Object.freeze({
        id: "ultimate",
        name: "Ultimate",
        upcomingBigOdd: true,
        upcomingLimit: 10,
        rateLimitPerMinute: 3000
    })
});

function normalizePlan(value) {
    const plan = String(value || "starter").trim().toLowerCase();
    return PLANS[plan] ? plan : "starter";
}

function getPlan(plan) {
    return PLANS[normalizePlan(plan)];
}

function listPlans() {
    return Object.values(PLANS);
}

function getPlanResponse(plan) {
    const p = getPlan(plan);
    return {
        id: p.id,
        name: p.name,
        features: {
            currentBigOdd: true,
            history: true,
            upcomingBigOdd: p.upcomingBigOdd,
            upcomingLimit: p.upcomingLimit
        },
        rateLimitPerMinute: p.rateLimitPerMinute
    };
}

module.exports = {
    PLANS,
    normalizePlan,
    getPlan,
    listPlans,
    getPlanResponse
};
