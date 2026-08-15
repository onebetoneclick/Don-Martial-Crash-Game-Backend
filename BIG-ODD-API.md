# Don Martial Big Odd API

The Big Odd system is designed as a second layer around the existing WebSocket crash-game server.

## Flow

```text
WebSocket Game Server
        |
        | generated special BIG ODD
        v
Big Odd Engine
        |
        | published records
        v
REST API
        |
        +--> /api/v1/big-odd/current
        +--> /api/v1/big-odd/next
        +--> /api/v1/big-odd/upcoming
        +--> /api/v1/big-odd/today
        +--> /api/v1/big-odd/history
```

There is intentionally **no tomorrow endpoint** in this version.

## API key

Set this environment variable on the backend:

```text
BIG_ODD_API_KEY=replace-with-a-long-random-secret
```

Clients send either:

```http
x-api-key: replace-with-a-long-random-secret
```

or:

```http
Authorization: Bearer replace-with-a-long-random-secret
```

Do not put the secret API key in a frontend application.

## BIG ODD rule

The engine currently treats a crash multiplier of `10.00x` or higher as a BIG ODD. This can be changed with:

```text
BIG_ODD_MINIMUM=10
```

The WebSocket/game server remains the authority that generates the game result. The REST API does not invent a result independently.

## Status model

A Big Odd record can expose:

- `running` — the associated game is currently running.
- `played` — the associated game has finished.
- `null` — no final status has been assigned yet.

## Important next integration step

The existing `server.js` still owns the WebSocket round lifecycle. The next backend change is to call `bigOddEngine.publishFromRound(currentRound)` when a generated round qualifies, and call `updateRoundStatus()` when that round starts/crashes. That makes the REST API a true publication layer for the WebSocket-generated Big Odds rather than a second generator.
