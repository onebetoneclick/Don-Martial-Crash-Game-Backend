"use strict";

const MAX_HISTORY = 1000;
const BIG_ODD_MINIMUM = Number(process.env.BIG_ODD_MINIMUM || 10);
const records = [];
let sequence = 0;

function todayKey(date = new Date()) {
    return new Date(date).toISOString().slice(0, 10);
}

function makeId() {
    sequence += 1;
    return `BO-${todayKey()}-${String(sequence).padStart(4, "0")}`;
}

function normalizeStatus(status) {
    const value = String(status ?? "").trim().toUpperCase();
    if (value === "RUNNING") return "running";
    if (value === "PLAYED" || value === "CRASHED") return "played";
    return null;
}

function readOdd(input) {
    if (!input || typeof input !== "object") return NaN;
    const candidates = [input.odd, input.bigOdd, input.multiplier, input.crashMultiplier];
    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined || String(candidate).trim() === "") continue;
        const value = Number(String(candidate).trim().replace(/x$/i, ""));
        if (Number.isFinite(value)) return value;
    }
    return NaN;
}

function getNumericRoundId(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function publishFromRound(round) {
    if (!round || typeof round !== "object") return null;

    const multiplier = readOdd(round);
    if (!Number.isFinite(multiplier) || multiplier < BIG_ODD_MINIMUM) return null;

    // IMPORTANT: Number(null) is 0 in JavaScript. Never treat a missing
    // roundId as round 0, otherwise every scheduled Big Odd collides with
    // the first scheduled record.
    const numericRoundId = getNumericRoundId(round.roundId);
    const hasRoundId = numericRoundId !== null;
    const suppliedId = String(round.bigOddId || "").trim();

    const duplicate = records.find(item => {
        const itemRoundId = getNumericRoundId(item.roundId);
        const sameRound = hasRoundId && itemRoundId !== null && itemRoundId === numericRoundId;
        const sameBigOdd = suppliedId && item.id === suppliedId;
        return sameRound || sameBigOdd;
    });

    if (duplicate) {
        if (hasRoundId && duplicate.roundId === null) duplicate.roundId = numericRoundId;

        const status = normalizeStatus(round.status);
        if (status === "running") {
            duplicate.status = "running";
            duplicate.runningAt = round.startedAt || round.serverTime || duplicate.runningAt;
        } else if (status === "played") {
            duplicate.status = "played";
            duplicate.playedAt = round.crashedAt || round.serverTime || duplicate.playedAt;
        }

        duplicate.serverTime = new Date().toISOString();
        return duplicate;
    }

    const createdAt = round.createdAt || round.serverTime || new Date().toISOString();
    const status = normalizeStatus(round.status);

    const record = {
        id: suppliedId || makeId(),
        roundId: hasRoundId ? numericRoundId : null,
        odd: Number(multiplier.toFixed(2)),
        status,
        date: todayKey(round.date || round.scheduledAt || createdAt),
        createdAt,
        scheduledAt: round.scheduledAt || null,
        publishAt: round.publishAt || null,
        publishedAt: round.publishedAt || new Date().toISOString(),
        runningAt: status === "running" ? (round.startedAt || round.serverTime || null) : null,
        playedAt: status === "played" ? (round.crashedAt || round.serverTime || null) : null,
        serverTime: new Date().toISOString()
    };

    records.unshift(record);
    if (records.length > MAX_HISTORY) records.length = MAX_HISTORY;
    return record;
}

function publishTestOdd(input = {}) {
    const multiplier = readOdd(input);
    if (!Number.isFinite(multiplier) || multiplier < BIG_ODD_MINIMUM) {
        return {
            error: "INVALID_BIG_ODD",
            minimum: BIG_ODD_MINIMUM,
            received: input.odd ?? input.bigOdd ?? input.multiplier ?? input.crashMultiplier ?? null,
            message: `Big Odd must be a number greater than or equal to ${BIG_ODD_MINIMUM}.`
        };
    }

    const numericRoundId = getNumericRoundId(input.roundId);
    const roundId = numericRoundId !== null ? numericRoundId : `TEST-${Date.now()}`;
    const now = new Date().toISOString();
    const status = normalizeStatus(input.status);

    return publishFromRound({
        roundId,
        odd: multiplier,
        status,
        createdAt: input.createdAt || now,
        serverTime: now,
        startedAt: status === "running" ? now : null,
        crashedAt: status === "played" ? now : null
    });
}

function updateRoundStatus(roundId, status, extra = {}) {
    const id = getNumericRoundId(roundId);
    if (id === null) return null;

    const record = records.find(item => {
        const itemId = getNumericRoundId(item.roundId);
        return itemId !== null && itemId === id;
    });
    if (!record) return null;

    const normalized = normalizeStatus(status);
    if (normalized === "running") {
        record.status = "running";
        record.runningAt = extra.runningAt || record.runningAt || new Date().toISOString();
    } else if (normalized === "played") {
        record.status = "played";
        record.playedAt = extra.playedAt || record.playedAt || new Date().toISOString();
    }

    record.serverTime = new Date().toISOString();
    return record;
}

function bindScheduledToRound(roundId, scheduledAt = new Date()) {
    const id = getNumericRoundId(roundId);
    if (id === null) return null;

    const target = new Date(scheduledAt).getTime();
    if (!Number.isFinite(target)) return null;

    const windowMs = Number(process.env.BIG_ODD_BIND_WINDOW_MINUTES || 5) * 60 * 1000;

    const candidates = records
        .filter(item =>
            item.status === null &&
            item.roundId === null &&
            item.scheduledAt &&
            Math.abs(new Date(item.scheduledAt).getTime() - target) <= windowMs
        )
        .sort((a, b) =>
            Math.abs(new Date(a.scheduledAt).getTime() - target) -
            Math.abs(new Date(b.scheduledAt).getTime() - target)
        );

    const record = candidates[0];
    if (!record) return null;

    record.roundId = id;
    record.serverTime = new Date().toISOString();
    return record;
}

function getCurrent() {
    return records.find(item => item.status === "running") || null;
}

function getNext() {
    return getUpcoming()[0] || null;
}

function getUpcoming() {
    return records
        .filter(item => item.status === null)
        .sort((a, b) => {
            const at = new Date(a.scheduledAt || a.createdAt).getTime();
            const bt = new Date(b.scheduledAt || b.createdAt).getTime();
            return (Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER) -
                (Number.isFinite(bt) ? bt : Number.MAX_SAFE_INTEGER);
        });
}

function getToday() {
    const key = todayKey();
    return records.filter(item => item.date === key);
}

function getHistory() {
    return [...records];
}

function getStats() {
    const today = getToday();
    return {
        total: records.length,
        today: today.length,
        running: records.filter(item => item.status === "running").length,
        played: records.filter(item => item.status === "played").length,
        upcoming: records.filter(item => item.status === null).length
    };
}

module.exports = {
    BIG_ODD_MINIMUM,
    publishFromRound,
    publishTestOdd,
    bindScheduledToRound,
    updateRoundStatus,
    getCurrent,
    getNext,
    getUpcoming,
    getToday,
    getHistory,
    getStats
};
