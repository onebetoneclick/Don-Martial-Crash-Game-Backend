/*
=========================================================
 DON MARTIAL CRASH GAME SERVER
=========================================================

 DEMO / TEST SERVER

 Features:
 - HTTP health endpoint
 - WebSocket game stream
 - Server-authoritative round timer
 - Betting window
 - Two independent bets per player
 - Server-side bet validation
 - Server-side cash-out validation
 - Auto cash-out
 - Persistent-in-memory round history
 - Round details and validation data
 - Stage timeout messages
 - Server timestamps
 - Smooth multiplier updates
 - Automatic crash
 - Automatic next round

 IMPORTANT:
 This version uses in-memory data.
 Restarting Render will clear the round history.

 Later we can move round history/bets to Supabase/PostgreSQL.
=========================================================
*/

"use strict";

const http = require("http");
const WebSocket = require("ws");


/* =====================================================
   CONFIGURATION
===================================================== */

const PORT = process.env.PORT || 3000;


/*
 * How long users can place bets.
 *
 * 5 seconds = 5000 milliseconds.
 */
const BETTING_TIME = 10000;


/*
 * Small delay before creating the next round
 * after a crash.
 */
const NEXT_ROUND_DELAY = 5000;


/*
 * How frequently the server sends multiplier
 * updates to connected clients.
 */
const TICK_RATE = 50;


/*
 * Maximum number of rounds kept in server memory.
 */
const MAX_ROUND_HISTORY = 500;


/*
 * Maximum amount allowed for a demo bet.
 */
const MAX_BET_AMOUNT = 100000;


/*
 * Minimum demo bet.
 */
const MIN_BET_AMOUNT = 10;


/* =====================================================
   GAME STATE
===================================================== */

let roundNumber = 0;

let currentRound = null;

let roundTimer = null;

let bettingTimer = null;

let nextRoundTimer = null;


/*
 * Completed rounds.
 *
 * IMPORTANT:
 * This is memory only.
 * Render restart clears it.
 */
const roundHistory = [];


/*
 * Connected clients.
 */
const clients = new Set();


/*
 * Simple demo player ID counter.
 */
let playerCounter = 0;


/* =====================================================
   HTTP SERVER
===================================================== */

const server = http.createServer((req, res) => {

    /*
     * CORS
     */
    res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type"
    );


    /*
     * OPTIONS
     */
    if (req.method === "OPTIONS") {

        res.writeHead(204);

        res.end();

        return;
    }


    /*
     * Health check
     */
    if (
        req.url === "/" ||
        req.url === "/health"
    ) {

        res.writeHead(
            200,
            {
                "Content-Type":
                    "application/json"
            }
        );


        res.end(
            JSON.stringify({
                success: true,

                service:
                    "Don Martial Crash Game",

                status:
                    "online",

                websocket:
                    "available",

                mode:
                    "DEMO",

                currentRound:
                    currentRound
                        ? currentRound.roundId
                        : null,

                gameStatus:
                    currentRound
                        ? currentRound.status
                        : "STARTING",

                serverTime:
                    new Date().toISOString()
            })
        );

        return;
    }


    /*
     * Current round REST endpoint.
     */
    if (
        req.url === "/api/game"
    ) {

        res.writeHead(
            200,
            {
                "Content-Type":
                    "application/json"
            }
        );


        res.end(
            JSON.stringify({
                success: true,

                game:
                    getPublicRoundState()
            })
        );

        return;
    }


    /*
     * Round history.
     */
    if (
        req.url === "/api/rounds"
    ) {

        res.writeHead(
            200,
            {
                "Content-Type":
                    "application/json"
            }
        );


        res.end(
            JSON.stringify({
                success: true,

                rounds:
                    roundHistory
            })
        );

        return;
    }


    /*
     * Unknown route.
     */
    res.writeHead(
        404,
        {
            "Content-Type":
                "application/json"
        }
    );


    res.end(
        JSON.stringify({
            success: false,

            error:
                "Route not found"
        })
    );

});


/* =====================================================
   WEBSOCKET SERVER
===================================================== */

const wss =
    new WebSocket.Server({
        server
    });


/* =====================================================
   WEBSOCKET CONNECTION
===================================================== */

wss.on(
    "connection",
    (ws, request) => {

        /*
         * Give this connection a temporary
         * demo player ID.
         */
        playerCounter++;

        const playerId =
            `player_${playerCounter}`;


        /*
         * Each browser connection gets
         * its own two bets.
         */
        ws.playerId =
            playerId;


        ws.bets = {
            bet1: null,
            bet2: null
        };


        ws.isAlive = true;


        clients.add(ws);


        console.log(
            `[WS] Client connected: ${playerId}`
        );


        /*
         * Send connection information.
         */
        send(ws, {
            type: "CONNECTED",

            data: {
                playerId,

                serverTime:
                    new Date().toISOString(),

                game:
                    getPublicRoundState()
            }
        });


        /*
         * Immediately send current game state.
         */
        send(ws, {
            type: "GAME_STATE",

            data:
                getPublicRoundState()
        });


        /*
         * Handle messages.
         */
        ws.on(
            "message",
            message => {

                handleClientMessage(
                    ws,
                    message
                );

            }
        );


        /*
         * Ping/pong support.
         */
        ws.on(
            "pong",
            () => {

                ws.isAlive = true;

            }
        );


        /*
         * Connection closed.
         */
        ws.on(
            "close",
            () => {

                clients.delete(ws);


                console.log(
                    `[WS] Client disconnected: ${playerId}`
                );

            }
        );


        /*
         * Connection error.
         */
        ws.on(
            "error",
            error => {

                console.error(
                    `[WS] ${playerId} error:`,
                    error.message
                );

            }
        );

    }
);


/* =====================================================
   CLIENT MESSAGE HANDLER
===================================================== */

function handleClientMessage(
    ws,
    rawMessage
) {

    let message;


    try {

        message =
            JSON.parse(
                rawMessage.toString()
            );

    }

    catch {

        sendError(
            ws,
            "INVALID_MESSAGE",
            "Invalid JSON message."
        );

        return;
    }


    const type =
        message.type;


    const data =
        message.data || {};


    switch (type) {


        /* ---------------------------------------------
           PLACE BET
        --------------------------------------------- */

        case "PLACE_BET":

            placeBet(
                ws,
                data
            );

            break;


        /* ---------------------------------------------
           CASH OUT
        --------------------------------------------- */

        case "CASH_OUT":

            cashOut(
                ws,
                data
            );

            break;


        /* ---------------------------------------------
           AUTO CASH OUT
        --------------------------------------------- */

        case "SET_AUTO_CASHOUT":

            setAutoCashout(
                ws,
                data
            );

            break;


        /* ---------------------------------------------
           GET ROUND DETAILS
        --------------------------------------------- */

        case "GET_ROUND_DETAILS":

            sendRoundDetails(
                ws,
                data.roundId
            );

            break;


        /* ---------------------------------------------
           GET ROUND HISTORY
        --------------------------------------------- */

        case "GET_ROUND_HISTORY":

            send(
                ws,
                {
                    type:
                        "ROUND_HISTORY",

                    data: {
                        rounds:
                            roundHistory
                    }
                }
            );

            break;


        /* ---------------------------------------------
           PING
        --------------------------------------------- */

        case "PING":

            send(
                ws,
                {
                    type: "PONG",

                    data: {
                        serverTime:
                            new Date().toISOString()
                    }
                }
            );

            break;


        default:

            sendError(
                ws,
                "UNKNOWN_EVENT",
                `Unknown event: ${type}`
            );

    }

}


/* =====================================================
   CREATE ROUND
===================================================== */

function createRound() {

    roundNumber++;


    const now =
        new Date();


    /*
     * Generate a crash multiplier.
     *
     * This is only a demo/test generator.
     *
     * It produces values generally above 1.00x.
     */
    const crashMultiplier =
        generateCrashMultiplier();


    currentRound = {

        roundId:
            roundNumber,

        status:
            "WAITING",


        /*
         * Timestamps
         */
        createdAt:
            now.toISOString(),

        bettingOpenedAt:
            null,

        bettingClosedAt:
            null,

        startedAt:
            null,

        crashedAt:
            null,


        /*
         * Timing
         */
        bettingDuration:
            BETTING_TIME,

        runningDuration:
            null,

        totalDuration:
            null,


        /*
         * Multiplier
         */
        startingMultiplier:
            1.00,

        multiplier:
            1.00,

        crashMultiplier:
            crashMultiplier,


        /*
         * Internal timing
         */
        bettingEndsAt:
            null,

        crashAt:
            null,


        /*
         * Event timeline
         */
        events: []

    };


    addRoundEvent(
        "ROUND_CREATED"
    );


    broadcast(
        "ROUND_CREATED",
        getPublicRoundState()
    );


    /*
     * Open betting shortly after creation.
     */
    setTimeout(
        openBetting,
        100
    );

}


/* =====================================================
   OPEN BETTING
===================================================== */

function openBetting() {

    if (
        !currentRound
    ) {
        return;
    }


    if (
        currentRound.status !==
        "WAITING"
    ) {
        return;
    }


    const now =
        new Date();


    currentRound.status =
        "BETTING";


    currentRound.bettingOpenedAt =
        now.toISOString();


    currentRound.bettingEndsAt =
        Date.now() +
        BETTING_TIME;


    addRoundEvent(
        "BETTING_OPEN"
    );


    broadcast(
        "BETTING_OPEN",
        {
            roundId:
                currentRound.roundId,

            status:
                currentRound.status,

            duration:
                BETTING_TIME,

            bettingEndsAt:
                currentRound.bettingEndsAt,

            serverTime:
                now.toISOString()
        }
    );


    /*
     * Automatically close betting.
     */
    bettingTimer =
        setTimeout(
            closeBetting,
            BETTING_TIME
        );

}


/* =====================================================
   CLOSE BETTING
===================================================== */

function closeBetting() {

    if (
        !currentRound
    ) {
        return;
    }


    if (
        currentRound.status !==
        "BETTING"
    ) {
        return;
    }


    const now =
        new Date();


    currentRound.status =
        "BETTING_CLOSED";


    currentRound.bettingClosedAt =
        now.toISOString();


    addRoundEvent(
        "BETTING_CLOSED"
    );


    broadcast(
        "BETTING_CLOSED",
        {
            roundId:
                currentRound.roundId,

            status:
                currentRound.status,

            serverTime:
                now.toISOString()
        }
    );


    /*
     * Start game shortly after betting closes.
     */
    setTimeout(
        startRound,
        100
    );

}


/* =====================================================
   START ROUND
===================================================== */

function startRound() {

    if (
        !currentRound
    ) {
        return;
    }


    if (
        currentRound.status !==
        "BETTING_CLOSED"
    ) {
        return;
    }


    const now =
        new Date();


    currentRound.status =
        "RUNNING";


    currentRound.startedAt =
        now.toISOString();


    currentRound.multiplier =
        1.00;


    /*
     * Determine when the round will crash.
     */
    const runningTime =
        calculateRunningTime(
            currentRound.crashMultiplier
        );


    currentRound.crashAt =
        Date.now() +
        runningTime;


    addRoundEvent(
        "ROUND_STARTED"
    );


    broadcast(
        "ROUND_STARTED",
        {
            roundId:
                currentRound.roundId,

            status:
                currentRound.status,

            multiplier:
                1.00,

            crashMultiplier:
                currentRound.crashMultiplier,

            serverTime:
                now.toISOString()
        }
    );


    /*
     * Start multiplier engine.
     */
    startMultiplierLoop();

}


/* =====================================================
   MULTIPLIER LOOP
===================================================== */

function startMultiplierLoop() {

    stopMultiplierLoop();


    roundTimer =
        setInterval(
            () => {

                if (
                    !currentRound
                ) {
                    return;
                }


                if (
                    currentRound.status !==
                    "RUNNING"
                ) {
                    return;
                }


                const now =
                    Date.now();


                /*
                 * If crash time has arrived,
                 * crash the round.
                 */
                if (
                    now >=
                    currentRound.crashAt
                ) {

                    currentRound.multiplier =
                        currentRound.crashMultiplier;


                    broadcast(
                        "MULTIPLIER_UPDATE",
                        {
                            roundId:
                                currentRound.roundId,

                            multiplier:
                                currentRound.multiplier,

                            serverTime:
                                new Date()
                                    .toISOString()
                        }
                    );


                    crashRound();

                    return;

                }


                /*
                 * Calculate current multiplier.
                 */
                const elapsed =
                    now -
                    new Date(
                        currentRound.startedAt
                    ).getTime();


                const total =
                    currentRound.crashAt -
                    new Date(
                        currentRound.startedAt
                    ).getTime();


                const progress =
                    Math.min(
                        elapsed / total,
                        1
                    );


                /*
                 * Smooth exponential-style
                 * multiplier progression.
                 */
                const multiplier =
                    1 +
                    (
                        currentRound.crashMultiplier -
                        1
                    ) *
                    Math.pow(
                        progress,
                        1.65
                    );


                currentRound.multiplier =
                    Math.min(
                        multiplier,
                        currentRound.crashMultiplier
                    );


                broadcast(
                    "MULTIPLIER_UPDATE",
                    {
                        roundId:
                            currentRound.roundId,

                        multiplier:
                            Number(
                                currentRound
                                    .multiplier
                                    .toFixed(4)
                            ),

                        serverTime:
                            new Date()
                                .toISOString()
                    }
                );


                /*
                 * Check auto cash-outs.
                 */
                checkAutoCashouts();

            },
            TICK_RATE
        );

}


/* =====================================================
   STOP MULTIPLIER LOOP
===================================================== */

function stopMultiplierLoop() {

    if (
        roundTimer
    ) {

        clearInterval(
            roundTimer
        );

        roundTimer =
            null;

    }

}


/* =====================================================
   CRASH ROUND
===================================================== */

function crashRound() {

    if (
        !currentRound
    ) {
        return;
    }


    if (
        currentRound.status !==
        "RUNNING"
    ) {
        return;
    }


    stopMultiplierLoop();


    const now =
        new Date();


    currentRound.status =
        "CRASHED";


    currentRound.crashedAt =
        now.toISOString();


    currentRound.multiplier =
        currentRound.crashMultiplier;


    /*
     * Calculate durations.
     */
    currentRound.runningDuration =
        differenceMs(
            currentRound.startedAt,
            currentRound.crashedAt
        );


    currentRound.totalDuration =
        differenceMs(
            currentRound.createdAt,
            currentRound.crashedAt
        );


    addRoundEvent(
        "ROUND_CRASHED"
    );


    /*
     * Save official round.
     */
    saveRoundToHistory();


    /*
     * Notify clients.
     */
    broadcast(
        "ROUND_CRASHED",
        {
            roundId:
                currentRound.roundId,

            status:
                "CRASHED",

            multiplier:
                currentRound.crashMultiplier,

            crashMultiplier:
                currentRound.crashMultiplier,

            crashedAt:
                currentRound.crashedAt,

            runningDuration:
                currentRound.runningDuration,

            totalDuration:
                currentRound.totalDuration,

            validation:
                buildRoundValidation(
                    currentRound
                )
        }
    );


    /*
     * Tell players who failed to cash out.
     */
    broadcastPlayerTimeouts();


    /*
     * Create next round.
     */
    nextRoundTimer =
        setTimeout(
            createRound,
            NEXT_ROUND_DELAY
        );

}


/* =====================================================
   PLACE BET
===================================================== */

function placeBet(
    ws,
    data
) {

    /*
     * Make sure there is a round.
     */
    if (
        !currentRound
    ) {

        sendStageTimeout(
            ws,
            "There is no active round."
        );

        return;
    }


    /*
     * IMPORTANT:
     * Server decides whether betting
     * is actually open.
     */
    if (
        currentRound.status !==
        "BETTING"
    ) {

        sendStageTimeout(
            ws,
            "Betting time has ended."
        );

        return;
    }


    /*
     * Check actual server time.
     */
    if (
        Date.now() >=
        currentRound.bettingEndsAt
    ) {

        sendStageTimeout(
            ws,
            "Betting time has expired."
        );

        return;
    }


    /*
     * Bet slot.
     */
    const slot =
        data.slot === "bet2"
            ? "bet2"
            : "bet1";


    /*
     * Don't allow another bet in
     * the same slot for this round.
     */
    if (
        ws.bets[slot] &&
        ws.bets[slot].roundId ===
            currentRound.roundId
    ) {

        sendError(
            ws,
            "BET_ALREADY_PLACED",
            `${slot} already has a bet in this round.`
        );

        return;
    }


    const amount =
        Number(
            data.amount
        );


    /*
     * Validate amount.
     */
    if (
        !Number.isFinite(amount)
    ) {

        sendError(
            ws,
            "INVALID_AMOUNT",
            "Invalid bet amount."
        );

        return;
    }


    if (
        amount <
        MIN_BET_AMOUNT
    ) {

        sendError(
            ws,
            "INVALID_AMOUNT",
            `Minimum demo bet is ${MIN_BET_AMOUNT}.`
        );

        return;
    }


    if (
        amount >
        MAX_BET_AMOUNT
    ) {

        sendError(
            ws,
            "INVALID_AMOUNT",
            `Maximum demo bet is ${MAX_BET_AMOUNT}.`
        );

        return;
    }


    /*
     * Auto cash-out value.
     */
    let autoCashout =
        Number(
            data.autoCashout
        );


    if (
        !Number.isFinite(autoCashout) ||
        autoCashout < 1.01
    ) {

        autoCashout =
            null;

    }


    /*
     * Create server-side bet.
     */
    const bet = {

        betId:
            `${currentRound.roundId}-${ws.playerId}-${slot}`,

        playerId:
            ws.playerId,

        slot:
            slot,

        roundId:
            currentRound.roundId,

        amount:
            Number(
                amount.toFixed(2)
            ),

        status:
            "ACTIVE",

        placedAt:
            new Date().toISOString(),

        cashedOutAt:
            null,

        cashoutMultiplier:
            null,

        payout:
            null,

        autoCashout:
            autoCashout

    };


    ws.bets[slot] =
        bet;


    /*
     * Add event.
     */
    addRoundEvent(
        "BET_PLACED",
        {
            playerId:
                ws.playerId,

            slot:
                slot,

            amount:
                bet.amount
        }
    );


    /*
     * Tell the client.
     */
    send(
        ws,
        {
            type:
                "BET_ACCEPTED",

            data: {

                betId:
                    bet.betId,

                slot:
                    bet.slot,

                roundId:
                    bet.roundId,

                amount:
                    bet.amount,

                status:
                    bet.status,

                autoCashout:
                    bet.autoCashout,

                serverTime:
                    new Date()
                        .toISOString()

            }
        }
    );


    /*
     * Broadcast anonymous bet event.
     */
    broadcast(
        "BET_PLACED",
        {
            roundId:
                currentRound.roundId,

            slot:
                slot
        }
    );

}


/* =====================================================
   SET AUTO CASHOUT
===================================================== */

function setAutoCashout(
    ws,
    data
) {

    const slot =
        data.slot === "bet2"
            ? "bet2"
            : "bet1";


    const bet =
        ws.bets[slot];


    if (
        !bet
    ) {

        sendError(
            ws,
            "NO_BET",
            `No active ${slot} exists.`
        );

        return;
    }


    if (
        bet.roundId !==
        currentRound?.roundId
    ) {

        sendError(
            ws,
            "ROUND_MISMATCH",
            "This bet belongs to another round."
        );

        return;
    }


    if (
        bet.status !==
        "ACTIVE"
    ) {

        sendError(
            ws,
            "BET_NOT_ACTIVE",
            "This bet is no longer active."
        );

        return;
    }


    const value =
        Number(
            data.multiplier
        );


    if (
        !Number.isFinite(value) ||
        value < 1.01
    ) {

        sendError(
            ws,
            "INVALID_AUTO_CASHOUT",
            "Auto cash-out must be at least 1.01x."
        );

        return;
    }


    bet.autoCashout =
        Number(
            value.toFixed(2)
        );


    send(
        ws,
        {
            type:
                "AUTO_CASHOUT_SET",

            data: {

                slot:
                    slot,

                multiplier:
                    bet.autoCashout

            }
        }
    );

}


/* =====================================================
   AUTO CASHOUT CHECK
===================================================== */

function checkAutoCashouts() {

    if (
        !currentRound
    ) {
        return;
    }


    for (
        const ws of clients
    ) {

        for (
            const slot of [
                "bet1",
                "bet2"
            ]
        ) {

            const bet =
                ws.bets[slot];


            if (
                !bet
            ) {
                continue;
            }


            if (
                bet.roundId !==
                currentRound.roundId
            ) {
                continue;
            }


            if (
                bet.status !==
                "ACTIVE"
            ) {
                continue;
            }


            if (
                bet.autoCashout ===
                null
            ) {
                continue;
            }


            if (
                currentRound.multiplier >=
                bet.autoCashout
            ) {

                cashOut(
                    ws,
                    {
                        slot:
                            slot,

                        automatic:
                            true
                    }
                );

            }

        }

    }

}


/* =====================================================
   CASH OUT
===================================================== */

function cashOut(
    ws,
    data
) {

    /*
     * Identify bet.
     */
    const slot =
        data.slot === "bet2"
            ? "bet2"
            : "bet1";


    const bet =
        ws.bets[slot];


    /*
     * No bet.
     */
    if (
        !bet
    ) {

        sendError(
            ws,
            "NO_BET",
            `No ${slot} was placed.`
        );

        return;
    }


    /*
     * Wrong round.
     */
    if (
        !currentRound ||
        bet.roundId !==
        currentRound.roundId
    ) {

        sendStageTimeout(
            ws,
            "This bet belongs to a previous round."
        );

        return;
    }


    /*
     * Already cashed out.
     */
    if (
        bet.status ===
        "CASHED_OUT"
    ) {

        sendError(
            ws,
            "ALREADY_CASHED_OUT",
            "This bet has already been cashed out."
        );

        return;
    }


    /*
     * If round is no longer running,
     * cash-out is too late.
     */
    if (
        currentRound.status !==
        "RUNNING"
    ) {

        bet.status =
            "LOST";


        sendStageTimeout(
            ws,
            "Cash out was too late. The round has ended."
        );

        return;
    }


    /*
     * Server's current multiplier.
     */
    const multiplier =
        Number(
            currentRound.multiplier
        );


    /*
     * Verify crash hasn't already
     * occurred.
     */
    if (
        Date.now() >=
        currentRound.crashAt
    ) {

        /*
         * Crash immediately if necessary.
         */
        crashRound();


        bet.status =
            "LOST";


        sendStageTimeout(
            ws,
            "Cash out was too late. The round had already crashed."
        );

        return;
    }


    /*
     * Calculate payout on server.
     */
    const payout =
        bet.amount *
        multiplier;


    bet.status =
        "CASHED_OUT";


    bet.cashedOutAt =
        new Date().toISOString();


    bet.cashoutMultiplier =
        Number(
            multiplier.toFixed(4)
        );


    bet.payout =
        Number(
            payout.toFixed(2)
        );


    /*
     * Add event.
     */
    addRoundEvent(
        "BET_CASHED_OUT",
        {
            playerId:
                ws.playerId,

            slot:
                slot,

            amount:
                bet.amount,

            multiplier:
                bet.cashoutMultiplier,

            payout:
                bet.payout,

            automatic:
                data.automatic === true
        }
    );


    /*
     * Tell client.
     */
    send(
        ws,
        {
            type:
                "CASHOUT_SUCCESS",

            data: {

                betId:
                    bet.betId,

                slot:
                    slot,

                roundId:
                    bet.roundId,

                amount:
                    bet.amount,

                multiplier:
                    bet.cashoutMultiplier,

                payout:
                    bet.payout,

                automatic:
                    data.automatic === true,

                cashedOutAt:
                    bet.cashedOutAt,

                serverTime:
                    new Date()
                        .toISOString()

            }
        }
    );

}


/* =====================================================
   PLAYER TIMEOUTS
===================================================== */

function broadcastPlayerTimeouts() {

    for (
        const ws of clients
    ) {

        for (
            const slot of [
                "bet1",
                "bet2"
            ]
        ) {

            const bet =
                ws.bets[slot];


            if (
                !bet
            ) {
                continue;
            }


            if (
                bet.roundId !==
                currentRound.roundId
            ) {
                continue;
            }


            if (
                bet.status ===
                "ACTIVE"
            ) {

                bet.status =
                    "LOST";


                send(
                    ws,
                    {
                        type:
                            "BET_LOST",

                        data: {

                            slot:
                                slot,

                            roundId:
                                bet.roundId,

                            amount:
                                bet.amount,

                            crashMultiplier:
                                currentRound
                                    .crashMultiplier,

                            reason:
                                "ROUND_CRASHED",

                            message:
                                "The round crashed before cash-out."

                        }
                    }
                );

            }

        }

    }

}


/* =====================================================
   ROUND HISTORY
===================================================== */

function saveRoundToHistory() {

    if (
        !currentRound
    ) {
        return;
    }


    /*
     * Make a clean public copy.
     */
    const record = {

        roundId:
            currentRound.roundId,

        status:
            currentRound.status,

        createdAt:
            currentRound.createdAt,

        bettingOpenedAt:
            currentRound.bettingOpenedAt,

        bettingClosedAt:
            currentRound.bettingClosedAt,

        startedAt:
            currentRound.startedAt,

        crashedAt:
            currentRound.crashedAt,

        bettingDuration:
            currentRound.bettingDuration,

        runningDuration:
            currentRound.runningDuration,

        totalDuration:
            currentRound.totalDuration,

        startingMultiplier:
            currentRound.startingMultiplier,

        crashMultiplier:
            currentRound.crashMultiplier,

        validation:
            buildRoundValidation(
                currentRound
            ),

        events:
            currentRound.events

    };


    roundHistory.unshift(
        record
    );


    if (
        roundHistory.length >
        MAX_ROUND_HISTORY
    ) {

        roundHistory.pop();

    }

}


/* =====================================================
   ROUND DETAILS
===================================================== */

function sendRoundDetails(
    ws,
    roundId
) {

    const id =
        Number(
            roundId
        );


    const round =
        roundHistory.find(
            item =>
                item.roundId === id
        );


    if (
        !round
    ) {

        sendError(
            ws,
            "ROUND_NOT_FOUND",
            `Round ${roundId} was not found.`
        );

        return;
    }


    send(
        ws,
        {
            type:
                "ROUND_DETAILS",

            data:
                round
        }
    );

}


/* =====================================================
   VALIDATION
===================================================== */

function buildRoundValidation(
    round
) {

    const checks = {


        roundCreated:
            Boolean(
                round.createdAt
            ),


        bettingOpened:
            Boolean(
                round.bettingOpenedAt
            ),


        bettingClosed:
            Boolean(
                round.bettingClosedAt
            ),


        roundStarted:
            Boolean(
                round.startedAt
            ),


        roundCrashed:
            Boolean(
                round.crashedAt
            ),


        validMultiplier:
            Number.isFinite(
                Number(
                    round.crashMultiplier
                )
            ) &&
            Number(
                round.crashMultiplier
            ) >= 1,


        validTiming:
            round.startedAt &&
            round.crashedAt &&
            new Date(
                round.crashedAt
            ).getTime() >=
            new Date(
                round.startedAt
            ).getTime(),


        bettingTimingValid:
            round.bettingOpenedAt &&
            round.bettingClosedAt &&
            new Date(
                round.bettingClosedAt
            ).getTime() >=
            new Date(
                round.bettingOpenedAt
            ).getTime()

    };


    const valid =
        Object.values(
            checks
        ).every(
            Boolean
        );


    return {

        valid:
            valid,

        status:
            valid
                ? "VALIDATED"
                : "INVALID",

        checks:

            checks

    };

}


/* =====================================================
   EVENT TIMELINE
===================================================== */

function addRoundEvent(
    type,
    details = {}
) {

    if (
        !currentRound
    ) {
        return;
    }


    currentRound.events.push({

        type:
            type,

        timestamp:
            new Date().toISOString(),

        details:
            details

    });

}


/* =====================================================
   PUBLIC ROUND STATE
===================================================== */

function getPublicRoundState() {

    if (
        !currentRound
    ) {

        return {

            roundId:
                null,

            status:
                "STARTING",

            multiplier:
                1,

            serverTime:
                new Date().toISOString()

        };

    }


    return {

        roundId:
            currentRound.roundId,

        status:
            currentRound.status,

        multiplier:
            Number(
                currentRound
                    .multiplier
                    .toFixed(4)
            ),

        crashMultiplier:
            currentRound.crashMultiplier,

        bettingDuration:
            currentRound.bettingDuration,

        bettingOpenedAt:
            currentRound.bettingOpenedAt,

        bettingClosedAt:
            currentRound.bettingClosedAt,

        startedAt:
            currentRound.startedAt,

        crashedAt:
            currentRound.crashedAt,

        bettingEndsAt:
            currentRound.bettingEndsAt,

        serverTime:
            new Date().toISOString()

    };

}


/* =====================================================
   CRASH MULTIPLIER GENERATOR
===================================================== */

function generateCrashMultiplier() {

    /*
     * DEMO ONLY.
     *
     * We intentionally keep the minimum
     * at 1.01x so a round can crash
     * immediately without becoming 1.00x
     * every time.
     */


    const random =
        Math.random();


    /*
     * Some low crashes.
     */
    if (
        random < 0.20
    ) {

        return Number(
            (
                1.01 +
                Math.random() * 0.99
            ).toFixed(2)
        );

    }


    /*
     * Normal range.
     */
    if (
        random < 0.85
    ) {

        return Number(
            (
                2 +
                Math.random() * 6
            ).toFixed(2)
        );

    }


    /*
     * Higher demo crash.
     */
    return Number(
        (
            8 +
            Math.random() * 17
        ).toFixed(2)
    );

}


/* =====================================================
   RUNNING TIME
===================================================== */

function calculateRunningTime(
    crashMultiplier
) {

    /*
     * This determines how long the
     * multiplier takes to reach its
     * crash point.
     *
     * Demo values only.
     */

    const base =
        3000;


    const extra =
        Math.min(
            crashMultiplier * 850,
            12000
        );


    return (
        base +
        extra
    );

}


/* =====================================================
   DIFFERENCE BETWEEN TIMESTAMPS
===================================================== */

function differenceMs(
    start,
    end
) {

    if (
        !start ||
        !end
    ) {

        return null;

    }


    return (
        new Date(end).getTime() -
        new Date(start).getTime()
    );

}


/* =====================================================
   SEND
===================================================== */

function send(
    ws,
    message
) {

    if (
        !ws ||
        ws.readyState !==
        WebSocket.OPEN
    ) {
        return;
    }


    try {

        ws.send(
            JSON.stringify(
                message
            )
        );

    }

    catch(error) {

        console.error(
            "WebSocket send error:",
            error.message
        );

    }

}


/* =====================================================
   BROADCAST
===================================================== */

function broadcast(
    type,
    data
) {

    const message = {

        type:
            type,

        data:
            data

    };


    for (
        const ws of clients
    ) {

        send(
            ws,
            message
        );

    }

}


/* =====================================================
   ERROR MESSAGE
===================================================== */

function sendError(
    ws,
    code,
    message
) {

    send(
        ws,
        {
            type:
                "ERROR",

            data: {

                code:
                    code,

                message:
                    message,

                serverTime:
                    new Date()
                        .toISOString()

            }
        }
    );

}


/* =====================================================
   STAGE TIMEOUT
===================================================== */

function sendStageTimeout(
    ws,
    message
) {

    send(
        ws,
        {
            type:
                "STAGE_TIMEOUT",

            data: {

                message:
                    message,

                roundId:
                    currentRound
                        ? currentRound.roundId
                        : null,

                status:
                    currentRound
                        ? currentRound.status
                        : "UNKNOWN",

                serverTime:
                    new Date()
                        .toISOString()

            }
        }
    );

}


/* =====================================================
   WEBSOCKET HEARTBEAT
===================================================== */

const heartbeat =
    setInterval(
        () => {

            for (
                const ws of clients
            ) {

                if (
                    ws.isAlive === false
                ) {

                    try {

                        ws.terminate();

                    }

                    catch {}

                    continue;

                }


                ws.isAlive =
                    false;


                try {

                    ws.ping();

                }

                catch {}

            }

        },
        15000
    );


/* =====================================================
   SERVER START
===================================================== */

server.listen(
    PORT,
    () => {

        console.log(
            "=========================================="
        );

        console.log(
            " DON MARTIAL CRASH GAME SERVER"
        );

        console.log(
            "=========================================="
        );

        console.log(
            `HTTP server: PORT ${PORT}`
        );

        console.log(
            "WebSocket: READY"
        );

        console.log(
            "Mode: DEMO"
        );

        console.log(
            `Betting time: ${BETTING_TIME}ms`
        );

        console.log(
            "Two bet slots: ENABLED"
        );

        console.log(
            "Auto cash-out: ENABLED"
        );

        console.log(
            "Round validation: ENABLED"
        );

        console.log(
            "=========================================="
        );


        /*
         * Start first round.
         */
        createRound();

    }
);


/* =====================================================
   PROCESS CLEANUP
===================================================== */

process.on(
    "SIGTERM",
    () => {

        console.log(
            "SIGTERM received. Shutting down..."
        );


        clearInterval(
            heartbeat
        );


        stopMultiplierLoop();


        if (
            bettingTimer
        ) {

            clearTimeout(
                bettingTimer
            );

        }


        if (
            nextRoundTimer
        ) {

            clearTimeout(
                nextRoundTimer
            );

        }


        for (
            const ws of clients
        ) {

            try {

                ws.close();

            }

            catch {}

        }


        server.close(
            () => {

                process.exit(0);

            }
        );

    }
);
