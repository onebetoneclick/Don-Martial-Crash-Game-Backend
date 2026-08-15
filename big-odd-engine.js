"use strict";

/*
=========================================================
 DON MARTIAL BIG ODD ENGINE
=========================================================

The WebSocket/game server generates the crash multiplier.
Qualifying rounds are published here immediately.

Lifecycle:
  WAITING / BETTING -> status: null (upcoming)
  RUNNING           -> status: running
  CRASHED           -> status: played

The test publisher is intentionally separate from the real
WebSocket bridge and is only for backend verification.
=========================================================
*/

const MAX_HISTORY = 1000;
const BIG_ODD_MINIMUM = Number(process.env.BIG_ODD_MINIMUM || 10);

const records = [];
let sequence = 0;

function todayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function makeId() {
    sequence += 1;
    return `BO-${todayKey()}-${String(sequence).padStart(4, "0")}`;
}

function normalizeStatus(status) {
    if (status === "played" || status === "CRASHED") return "played";
    if (status === "running" || status === "RUNNING") return "running";
    return null;
}

function publishFromRound(round) {
    if (!round) return null;

    const multiplier = Number(round.crashMultiplier ?? round.odd);
    if (!Number.isFinite(multiplier) || multiplier < BIG_ODD_MINIMUM) return null;

    const roundId = Number(round.roundId);
    const duplicate = records.find(item =>
        (Number.isFinite(roundId) && Number(item.roundId) === roundId) ||
        (round.bigOddId && item.id === round.bigOddId)
    );
    if (duplicate) return duplicate;

    const createdAt = round.createdAt || round.serverTime || new Date().toISOString();
    const status = normalizeStatus(round.status);

    const record = {
        id: round.bigOddId || makeId(),
        roundId: Number.isFinite(roundId) ? roundId : null,
        odd: Number(multiplier.toFixed(2)),
        status,
        date: todayKey(new Date(createdAt)),
        createdAt,
        runningAt: status === "running" ? (round.startedAt || round.serverTime || null) : null,
        playedAt: status === "played" ? (round.crashedAt || round.serverTime || null) : null,
        serverTime: new Date().toISOString()
    };

    records.unshift(record);
    if (records.length > MAX_HISTORY) records.length = MAX_HISTORY;
    return record;
}

function publishTestOdd({ odd, roundId, status = null } = {}) {
    const multiplier = Number(odd);
    if (!Number.isFinite(multiplier) || multiplier < BIG_ODD_MINIMUM) {
        return { error: "INVALID_BIG_ODD", minimum: BIG_ODD_MINIMUM };
    }

    const id = Number.isFinite(Number(roundId)) ? Number(roundId) : `TEST-${Date.now()}`;
    const now = new Date().toISOString();

    return publishFromRound({
        roundId: id,
        crashMultiplier: multiplier,
        status,
        createdAt: now,
        serverTime: now,
        startedAt: status === "running" ? now : null,
        crashedAt: status === "played" ? now : null
    });
}

function updateRoundStatus(roundId, status, extra = {}) {
    const id = Number(roundId);
    const record = records.find(item => Number(item.roundId) === id);
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

function getCurrent() { return records.find(item => item.status === "running") || null; }
function getNext() { return getUpcoming()[0] || null; }
function getUpcoming() {
    return records.filter(item => item.status === null)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}
function getToday() {
    const key = todayKey();
    return records.filter(item => item.date === key);
}
function getHistory() { return [...records]; }
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
    updateRoundStatus,
    getCurrent,
    getNext,
    getUpcoming,
    getToday,
    getHistory,
    getStats
};
