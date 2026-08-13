const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({
    server
});

// Store connected players
const players = new Set();

// Current game state
let gameState = {
    roundId: 0,
    status: "WAITING",
    multiplier: 1.00,
    crashPoint: null
};

// -------------------------------------
// BASIC API
// -------------------------------------

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Don Martial Crash Backend is running",
        version: "1.0.0"
    });
});

app.get("/api/game/status", (req, res) => {
    res.json({
        success: true,
        game: gameState
    });
});

// -------------------------------------
// WEBSOCKET CONNECTION
// -------------------------------------

wss.on("connection", (socket) => {

    console.log("New WebSocket connection");

    players.add(socket);

    // Send current game state immediately
    socket.send(JSON.stringify({
        type: "GAME_STATE",
        data: gameState
    }));

    socket.on("message", (message) => {

        try {

            const data = JSON.parse(message);

            console.log("Client message:", data);

            if (data.type === "PING") {

                socket.send(JSON.stringify({
                    type: "PONG",
                    timestamp: Date.now()
                }));

            }

        } catch (error) {

            socket.send(JSON.stringify({
                type: "ERROR",
                message: "Invalid message format"
            }));

        }

    });

    socket.on("close", () => {

        console.log("WebSocket connection closed");

        players.delete(socket);

    });

    socket.on("error", (error) => {

        console.error("WebSocket error:", error);

        players.delete(socket);

    });

});

// -------------------------------------
// BROADCAST FUNCTION
// -------------------------------------

function broadcast(data) {

    const message = JSON.stringify(data);

    players.forEach((socket) => {

        if (socket.readyState === WebSocket.OPEN) {

            socket.send(message);

        }

    });

}

// -------------------------------------
// TEST GAME LOOP
// -------------------------------------

let testMultiplier = 1.00;

setInterval(() => {

    testMultiplier += 0.01;

    gameState = {
        roundId: 1,
        status: "RUNNING",
        multiplier: Number(testMultiplier.toFixed(2)),
        crashPoint: null
    };

    broadcast({
        type: "MULTIPLIER_UPDATE",
        data: {
            multiplier: gameState.multiplier
        }
    });

}, 1000);

// -------------------------------------
// START SERVER
// -------------------------------------

server.listen(PORT, () => {

    console.log("-----------------------------------");
    console.log("DON MARTIAL CRASH BACKEND");
    console.log("-----------------------------------");
    console.log(`HTTP Server: http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log("-----------------------------------");

});
