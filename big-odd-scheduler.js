"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD DAILY SCHEDULER
=========================================================

Creates one complete Big Odd schedule for the current UTC day.
Each Big Odd has its own odd, scheduled time and publication time.
A Big Odd is published to the engine PUBLISH_MINUTES before it is
scheduled to run.

The scheduled time may be ANY time during the 24-hour day.
The scheduler never targets a fixed hour for the actual Big Odd.

IMPORTANT:
This scheduler prepares/announces DEMO/TEST Big Odds. The WebSocket
server remains the source of the actual crash-round lifecycle.
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

function randomTimeForDay(day, index) {
    const start = new Date(`${day}T00:00:00.000Z`).getTime();
    const end = start + (24 * 60 * 60 * 1000) - 1;

    // Spread the daily Big Odds across the entire 24-hour period,
    // then add jitter so the times are not fixed.
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

        const id = `BO-${day}-PLAN-${String(i + 1).padStart(2, "0")}-${crypto.randomBytes(3).toString("hex")}`;

        items.push({
            id,
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

    // PLAN_HOUR controls when the daily plan is first created after
    // startup/midnight. It does NOT control the actual Big Odd times.
    return now.getUTCHours() >= PLAN_HOUR || plannedDate !== today;
}

function createDailyPlan(now = new Date()) {
    const today = dateKey(now);

    if (plannedDate === today && plan.length > 0) return plan;

    plan = makePlanForDate(today);
    plannedDate = today;
    lastPlanAt = new Date().toISOString();
    lastError = null;

    console.log(`[BIG ODD] Daily plan created for ${today}: ${plan.length} Big Odds.`);

    for (const item of plan) {
        console.log(
            `[BIG ODD] ${item.id} | ${item.odd.toFixed(2)}x | scheduled ${item.scheduledAt} | publish ${item.publishAt}`
        );
    }

    return plan;
}

function publishDueItems(now = new Date()) {
    const nowMs = now.getTime();

    for (const item of plan) {
        if (item.published) continue;

        const publishAtMs = new Date(item.publishAt).getTime();
        if (!Number.isFinite(publishAtMs) || nowMs < publishAtMs) continue;

        try {
            const publishedAt = new Date().toISOString();

            const record = engine.publishFromRound({
                // IMPORTANT: this plan ID is the immutable identity of this
                // particular Big Odd. Never reuse another plan's ID.
                bigOddId: item.id,
                roundId: null,
                odd: item.odd,
                status: null,
                createdAt: publishedAt,
                scheduledAt: item.scheduledAt,
                publishAt: item.publishAt,
                publishedAt,
                serverTime: publishedAt,
                date: plannedDate
            });

            if (!record) {
                throw new Error(`Engine rejected scheduled Big Odd ${item.id}`);
            }

            if (record.id !== item.id) {
                throw new Error(
                    `Big Odd identity mismatch: expected ${item.id}, received ${record.id}`
                );
            }

            item.published = true;
            item.publishedRecordId = record.id;
            lastPublishedAt = publishedAt;

            console.log(
                `[BIG ODD] Published ${record.id}: ${record.odd.toFixed(2)}x | scheduled ${record.scheduledAt}`
            );
        } catch (error) {
            lastError = error.message;
            console.error(`[BIG ODD] Publish error for ${item.id}:`, error.message);
        }
    }
}

/* =====================================================
   SERVER-SIDE COUNTDOWN
=====================================================

The countdown is calculated from the scheduled timestamp and the
server clock. The frontend does not need to calculate the target time.
The API can therefore expose an authoritative remaining duration.
*/
function getCountdown(targetAt, now = new Date()) {
    const targetMs = new Date(targetAt).getTime();
    const nowMs = now.getTime();

    if (!Number.isFinite(targetMs)) {
        return {
            available: false,
            status: "INVALID_TIME",
            milliseconds: null,
            seconds: null,
            formatted: null
        };
    }

    const remainingMs = Math.max(0, targetMs - nowMs);
    const totalSeconds = Math.floor(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return {
        available: remainingMs > 0,
        status: remainingMs > 0 ? "UPCOMING" : "AVAILABLE",
        milliseconds: remainingMs,
        seconds: totalSeconds,
        formatted:
            `${String(hours).padStart(2, "0")}:` +
            `${String(minutes).padStart(2, "0")}:` +
            `${String(seconds).padStart(2, "0")}`
    };
}

function getPublishCountdown(item, now) {
    const publish = getCountdown(item.publishAt, now);

    if (item.published) {
        return {
            ...publish,
            status: "PUBLISHED",
            available: false,
            milliseconds: 0,
            seconds: 0,
            formatted: "00:00:00"
        };
    }

    return publish;
}

function getScheduleItem(item, now = new Date()) {
    const scheduledCountdown = getCountdown(item.scheduledAt, now);
    const publishCountdown = getPublishCountdown(item, now);

    let status = "UPCOMING";

    if (scheduledCountdown.status === "AVAILABLE") {
        status = "AVAILABLE";
    }

    if (item.published && scheduledCountdown.status === "AVAILABLE") {
        status = "READY";
    }

    return {
        id: item.id,
        odd: item.odd,
        scheduledAt: item.scheduledAt,
        publishAt: item.publishAt,
        published: item.published,
        publishedRecordId: item.publishedRecordId,
        status,
        countdown: scheduledCountdown,
        publishCountdown
    };
}

function tick() {
    if (!installed || !ENABLED) return;

    const now = new Date();

    try {
        if (plannedDate !== dateKey(now)) {
            createDailyPlan(now);
        } else if (shouldCreatePlan(now)) {
            createDailyPlan(now);
        }

        publishDueItems(now);
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
        `[BIG ODD] Scheduler enabled. Count=${DAILY_COUNT}, publish=${PUBLISH_MINUTES}m before scheduled time, planHour=${PLAN_HOUR}:00 UTC.`
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
        plan: plan.map(item => getScheduleItem(item, now))
    };
}

module.exports = {
    install,
    getStatus,
    createDailyPlan,
    publishDueItems,
    getCountdown
};
