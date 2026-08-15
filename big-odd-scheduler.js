"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD DAILY SCHEDULER
=========================================================

Creates the day's Big Odd plan early in the day, keeps the
plan private until its publication time, then publishes each
item to the existing Big Odd engine one hour before its
scheduled time.

IMPORTANT:
This scheduler is for the DEMO/TEST crash server. It does not
change the live crash result. The crash server remains the
source of the actual round outcome.
=========================================================
*/

const crypto = require("crypto");
const engine = require("./big-odd-engine");

const ENABLED = String(process.env.BIG_ODD_SCHEDULER_ENABLED || "true").toLowerCase() !== "false";
const DAILY_COUNT = Math.max(1, Math.min(50, Number(process.env.BIG_ODD_DAILY_COUNT || 10)));
const PUBLISH_MINUTES = Math.max(1, Number(process.env.BIG_ODD_PUBLISH_MINUTES || 60));
const PLAN_HOUR = Math.max(0, Math.min(23, Number(process.env.BIG_ODD_PLAN_HOUR || 6)));
const MIN_ODD = Math.max(engine.BIG_ODD_MINIMUM, Number(process.env.BIG_ODD_MINIMUM || 10));
const MAX_ODD = Math.max(MIN_ODD, Number(process.env.BIG_ODD_MAXIMUM || 100));
const CHECK_INTERVAL = 1000;

let installed = false;
let timer = null;
let plannedDate = null;
let plan = [];
let lastPlanAt = null;
let lastPublishedAt = null;
let lastError = null;

function dateKey(date = new Date()) {
    return new Date(date).toISOString().slice(0, 10);
}

function randomOdd() {
    const range = MAX_ODD - MIN_ODD;
    const value = MIN_ODD + (Math.random() * range);
    return Number(value.toFixed(2));
}

function randomTimeForDay(dateKeyValue, index) {
    const start = new Date(`${dateKeyValue}T00:00:00.000Z`).getTime();
    const end = start + (24 * 60 * 60 * 1000) - 1;

    // Use a deterministic spread first, then add jitter so the
    // daily schedule is distributed over the full 24-hour day.
    const slot = (index + 0.5) / DAILY_COUNT;
    const jitter = (Math.random() - 0.5) * (0.70 / DAILY_COUNT);
    const ratio = Math.min(0.999, Math.max(0.001, slot + jitter));

    return new Date(start + ((end - start) * ratio));
}

function makePlanForDate(day) {
    const items = [];

    for (let i = 0; i < DAILY_COUNT; i += 1) {
        const scheduledAtDate = randomTimeForDay(day, i);
        const publishAtDate = new Date(
            scheduledAtDate.getTime() - (PUBLISH_MINUTES * 60 * 1000)
        );

        items.push({
            id: `BO-${day}-PLAN-${String(i + 1).padStart(2, "0")}-${crypto.randomBytes(3).toString("hex")}`,
            odd: randomOdd(),
            scheduledAt: scheduledAtDate.toISOString(),
            publishAt: publishAtDate.toISOString(),
            published: false,
            publishedRecordId: null
        });
    }

    return items.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}

function shouldCreatePlan(now = new Date()) {
    const today = dateKey(now);
    if (plannedDate === today && plan.length > 0) return false;

    const hour = now.getUTCHours();
    return hour >= PLAN_HOUR || plannedDate !== today;
}

function createDailyPlan(now = new Date()) {
    const today = dateKey(now);

    // Do not replace a plan that is already active for today.
    if (plannedDate === today && plan.length > 0) return plan;

    plan = makePlanForDate(today);
    plannedDate = today;
    lastPlanAt = new Date().toISOString();
    lastError = null;

    console.log(
        `[BIG ODD] Daily plan created for ${today}: ${plan.length} Big Odd slots.`
    );

    return plan;
}

function publishDueItems(now = new Date()) {
    const nowMs = now.getTime();

    for (const item of plan) {
        if (item.published) continue;

        const publishAtMs = new Date(item.publishAt).getTime();
        if (!Number.isFinite(publishAtMs) || nowMs < publishAtMs) continue;

        try {
            const record = engine.publishFromRound({
                bigOddId: item.id,
                roundId: null,
                odd: item.odd,
                status: null,
                createdAt: new Date().toISOString(),
                scheduledAt: item.scheduledAt,
                publishAt: item.publishAt,
                publishedAt: new Date().toISOString(),
                serverTime: new Date().toISOString(),
                date: plannedDate
            });

            if (record) {
                item.published = true;
                item.publishedRecordId = record.id;
                lastPublishedAt = new Date().toISOString();

                console.log(
                    `[BIG ODD] Published ${record.id}: ${record.odd.toFixed(2)}x for ${record.scheduledAt}`
                );
            }
        } catch (error) {
            lastError = error.message;
            console.error("[BIG ODD] Publish error:", error.message);
        }
    }
}

function tick() {
    if (!installed || !ENABLED) return;

    const now = new Date();

    try {
        if (shouldCreatePlan(now)) {
            createDailyPlan(now);
        }

        publishDueItems(now);

        // After midnight, the next tick creates the new day's plan.
        if (plannedDate !== dateKey(now)) {
            createDailyPlan(now);
        }
    } catch (error) {
        lastError = error.message;
        console.error("[BIG ODD] Scheduler error:", error.message);
    }
}

function install() {
    if (installed) return;

    installed = true;

    if (!ENABLED) {
        console.log("[BIG ODD] Daily scheduler disabled by BIG_ODD_SCHEDULER_ENABLED=false");
        return;
    }

    console.log(
        `[BIG ODD] Daily scheduler enabled. Count=${DAILY_COUNT}, publish=${PUBLISH_MINUTES}m before scheduled time, planHour=${PLAN_HOUR}:00 UTC.`
    );

    tick();
    timer = setInterval(tick, CHECK_INTERVAL);
}

function getStatus() {
    const now = new Date();

    return {
        enabled: ENABLED,
        installed,
        plannedDate,
        dailyCount: DAILY_COUNT,
        publishMinutes: PUBLISH_MINUTES,
        planHourUtc: PLAN_HOUR,
        now: now.toISOString(),
        lastPlanAt,
        lastPublishedAt,
        lastError,
        plan: plan.map(item => ({
            id: item.id,
            odd: item.odd,
            scheduledAt: item.scheduledAt,
            publishAt: item.publishAt,
            published: item.published,
            publishedRecordId: item.publishedRecordId
        }))
    };
}

module.exports = {
    install,
    getStatus,
    createDailyPlan,
    publishDueItems
};
