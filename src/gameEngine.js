const crypto = require("crypto");

class CrashGame {

    constructor(broadcast) {

        this.broadcast = broadcast;

        this.roundId = 0;
        this.status = "WAITING";

        this.multiplier = 1.00;
        this.crashPoint = null;

        this.bettingTime = 5000;
        this.tickRate = 50;

        this.roundTimer = null;
        this.gameTimer = null;

        this.startNewRound();
    }

    // ----------------------------------------
    // GENERATE RANDOM CRASH POINT
    // ----------------------------------------

    generateCrashPoint() {

        /*
         * Generate a random 32-bit unsigned integer.
         *
         * We convert it to a normal JavaScript number
         * between 0 and 1.
         */

        const randomBuffer =
            crypto.randomBytes(4);

        const randomInteger =
            randomBuffer.readUInt32BE(0);

        const random =
            randomInteger / 0xFFFFFFFF;

        /*
         * Demo crash-point formula.
         *
         * This is NOT the final provably-fair
         * implementation.
         *
         * We will build the proper fairness system
         * later in fairness.js.
         */

        let crashPoint =
            0.99 / (1 - random);

        // Minimum crash point
        crashPoint =
            Math.max(1.01, crashPoint);

        // Maximum demo crash point
        crashPoint =
            Math.min(1000, crashPoint);

        return Number(
            crashPoint.toFixed(2)
        );
    }

    // ----------------------------------------
    // START NEW ROUND
    // ----------------------------------------

    startNewRound() {

        this.clearTimers();

        this.roundId++;

        this.status = "WAITING";

        this.multiplier = 1.00;

        this.crashPoint =
            this.generateCrashPoint();

        console.log(
            "-----------------------------------"
        );

        console.log(
            `ROUND ${this.roundId}`
        );

        console.log(
            `Crash point: ${this.crashPoint}x`
        );

        console.log(
            "-----------------------------------"
        );

        this.broadcast({

            type: "ROUND_CREATED",

            data: {
                roundId: this.roundId,
                status: this.status,
                multiplier: this.multiplier,
                bettingTime: this.bettingTime
            }

        });

        this.startBettingCountdown();
    }

    // ----------------------------------------
    // BETTING COUNTDOWN
    // ----------------------------------------

    startBettingCountdown() {

        console.log(
            `Betting open for ${this.bettingTime / 1000}s`
        );

        this.broadcast({

            type: "BETTING_OPEN",

            data: {
                roundId: this.roundId,
                duration: this.bettingTime
            }

        });

        this.roundTimer =
            setTimeout(() => {

                this.startRound();

            }, this.bettingTime);
    }

    // ----------------------------------------
    // START ROUND
    // ----------------------------------------

    startRound() {

        this.status = "RUNNING";

        this.multiplier = 1.00;

        console.log(
            `ROUND ${this.roundId} STARTED`
        );

        this.broadcast({

            type: "ROUND_STARTED",

            data: {
                roundId: this.roundId,
                multiplier: this.multiplier
            }

        });

        const startTime =
            Date.now();

        this.gameTimer =
            setInterval(() => {

                const elapsed =
                    Date.now() - startTime;

                /*
                 * Multiplier growth.
                 *
                 * This controls the visual/game speed.
                 */

                this.multiplier =
                    Math.exp(
                        elapsed / 10000
                    );

                this.multiplier =
                    Number(
                        this.multiplier.toFixed(2)
                    );

                // --------------------------------
                // CHECK CRASH
                // --------------------------------

                if (
                    this.multiplier >=
                    this.crashPoint
                ) {

                    this.crash();

                    return;
                }

                // --------------------------------
                // SEND MULTIPLIER
                // --------------------------------

                this.broadcast({

                    type:
                        "MULTIPLIER_UPDATE",

                    data: {

                        roundId:
                            this.roundId,

                        multiplier:
                            this.multiplier

                    }

                });

            }, this.tickRate);
    }

    // ----------------------------------------
    // CRASH ROUND
    // ----------------------------------------

    crash() {

        this.clearTimers();

        this.status = "CRASHED";

        this.multiplier =
            this.crashPoint;

        console.log(
            `ROUND ${this.roundId} CRASHED AT ${this.crashPoint}x`
        );

        this.broadcast({

            type:
                "ROUND_CRASHED",

            data: {

                roundId:
                    this.roundId,

                multiplier:
                    this.crashPoint

            }

        });

        /*
         * Wait three seconds before
         * creating the next round.
         */

        setTimeout(() => {

            this.startNewRound();

        }, 3000);
    }

    // ----------------------------------------
    // GET GAME STATE
    // ----------------------------------------

    getState() {

        return {

            roundId:
                this.roundId,

            status:
                this.status,

            multiplier:
                this.multiplier

        };

    }

    // ----------------------------------------
    // CLEAR TIMERS
    // ----------------------------------------

    clearTimers() {

        if (this.roundTimer) {

            clearTimeout(
                this.roundTimer
            );

            this.roundTimer = null;
        }

        if (this.gameTimer) {

            clearInterval(
                this.gameTimer
            );

            this.gameTimer = null;
        }

    }

}

module.exports = CrashGame;
