const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
require("dotenv").config();

const CrashGame = require("./src/gameEngine");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ----------------------------------------
// HTTP SERVER
// ----------------------------------------

const server = http.createServer(app);

// ----------------------------------------
// WEBSOCKET SERVER
// ----------------------------------------

const wss = new WebSocket.Server({
    server
});

// Connected players
const players = new Set();

// ----------------------------------------
// BROADCAST FUNCTION
// ----------------------------------------

function broadcast(data) {

    const message =
        JSON.stringify(data);

    players.forEach((socket) => {

        if (
            socket.readyState ===
            WebSocket.OPEN
        ) {

            socket.send(message);

        }

    });
}

// ----------------------------------------
// GAME ENGINE
// ----------------------------------------

const game = new CrashGame(
    broadcast
);

// ----------------------------------------
// BASIC API
// ----------------------------------------

app.get("/", (req, res) => {

    res.json({

        success: true,

        message:
            "Don Martial Crash Backend is running",

        version: "1.0.0",

        websocket:
            "wss://don-martial-crash-game-backend.onrender.com"
    });
});

// ----------------------------------------
// GAME STATUS API
// ----------------------------------------

app.get(
    "/api/game/status",
    (req, res) => {

        res.json({

            success: true,

            game: game.getState()

        });

    }
);

// ----------------------------------------
// WEBSOCKET CONNECTION
// ----------------------------------------

wss.on("connection", (socket) => {

    console.log(
        "New WebSocket player connected"
    );

    players.add(socket);

    // Send current state
    socket.send(
        JSON.stringify({

            type: "GAME_STATE",

            data: game.getState()

        })
    );

    // ------------------------------------
    // CLIENT MESSAGE
    // ------------------------------------

    socket.on(
        "message",
        (message) => {

            try {

                const data =
                    JSON.parse(message);

                console.log(
                    "Client message:",
                    data
                );

                // Test connection
                if (
                    data.type === "PING"
                ) {

                    socket.send(
                        JSON.stringify({

                            type: "PONG",

                            timestamp:
                                Date.now()

                        })
                    );

                }

            } catch (error) {

                console.error(
                    "Invalid WebSocket message:",
                    error.message
                );

                socket.send(
                    JSON.stringify({

                        type: "ERROR",

                        message:
                            "Invalid message format"

                    })
                );

            }

        }
    );

    // ------------------------------------
    // CONNECTION CLOSED
    // ------------------------------------

    socket.on("close", () => {

        console.log(
            "Player disconnected"
        );

        players.delete(socket);

    });

    // ------------------------------------
    // CONNECTION ERROR
    // ------------------------------------

    socket.on(
        "error",
        (error) => {

            console.error(
                "WebSocket error:",
                error.message
            );

            players.delete(socket);

        }
    );

});

// ----------------------------------------
// START SERVER
// ----------------------------------------

server.listen(
    PORT,
    () => {

        console.log(
            "-----------------------------------"
        );

        console.log(
            "DON MARTIAL CRASH BACKEND"
        );

        console.log(
            "-----------------------------------"
        );

        console.log(
            `HTTP Server running on port ${PORT}`
        );

        console.log(
            "WebSocket server is ready"
        );

        console.log(
            "-----------------------------------"
        );

    }
);
