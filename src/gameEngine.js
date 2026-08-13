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
    // CREATE A RANDOM CRASH POINT
    // ----------------------------------------

    generateCrashPoint() {

        const randomBytes = crypto.randomBytes(8);

        const randomNumber =
            randomBytes.readBigUInt64BE() /
            BigInt("18446744073709551615");

        const random =
            Number(randomNumber);

        // Demo crash-point formula
        let crashPoint =
            0.99 / (1 - random);

        // Prevent extremely small values
        crashPoint =
            Math.max(1.00, crashPoint);

        // Keep demo rounds reasonable
        crashPoint =
            Math.min(crashPoint, 1000);

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
            `\nROUND ${this.roundId}`
        );

        console.log(
            `Crash point: ${this.crashPoint}x`
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

        this.roundTimer = setTimeout(() => {

            this.startRound();

        }, this.bettingTime);
    }

    // ----------------------------------------
    // START GAME
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

        const startTime = Date.now();

        this.gameTimer = setInterval(() => {

            const elapsed =
                Date.now() - startTime;

            /*
             * Exponential multiplier curve.
             *
             * This is only the demo game curve.
             * Later we can tune the speed and
             * animation independently.
             */

            this.multiplier =
                Math.exp(elapsed / 10000);

            this.multiplier =
                Number(
                    this.multiplier.toFixed(2)
                );

            // Check crash
            if (
                this.multiplier >=
                this.crashPoint
            ) {

                this.crash();

                return;
            }

            this.broadcast({
                type: "MULTIPLIER_UPDATE",

                data: {
                    roundId: this.roundId,
                    multiplier: this.multiplier
                }
            });

        }, this.tickRate);
    }

    // ----------------------------------------
    // CRASH
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
            type: "ROUND_CRASHED",

            data: {
                roundId: this.roundId,
                multiplier: this.crashPoint
            }
        });

        // Give clients time to display crash
        setTimeout(() => {

            this.startNewRound();

        }, 3000);
    }

    // ----------------------------------------
    // GET CURRENT GAME STATE
    // ----------------------------------------

    getState() {

        return {
            roundId: this.roundId,
            status: this.status,
            multiplier: this.multiplier
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
