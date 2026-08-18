"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const subscriptionManager = require("./subscription-manager");

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const BODY_TIMEOUT_MS = 8000;

function ensureStorage() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf8");
}

function readUsers() {
    ensureStorage();
    try {
        const value = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
        return Array.isArray(value) ? value : [];
    } catch (error) {
        console.error("[AUTH] users.json read error:", error.message);
        return [];
    }
}

function writeUsers(users) {
    ensureStorage();
    const tmp = USERS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2), "utf8");
    fs.renameSync(tmp, USERS_FILE);
}

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function normalizeName(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
}

function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    return {
        salt,
        hash: crypto.scryptSync(password, salt, 64).toString("hex")
    };
}

function verifyPassword(password, user) {
    try {
        if (!user || !user.passwordHash || !user.passwordSalt) return false;

        const actual = crypto.scryptSync(
            password,
            user.passwordSalt,
            64
        );

        const expected = Buffer.from(
            String(user.passwordHash),
            "hex"
        );

        if (expected.length !== actual.length) return false;

        return crypto.timingSafeEqual(actual, expected);
    } catch (error) {
        console.error("[AUTH] password verification error:", error.message);
        return false;
    }
}

function publicUser(user) {
    if (!user) return null;

    return {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan || "starter",
        authProvider: user.authProvider || "password",
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt || null
    };
}

function sendJson(res, status, payload) {
    if (res.headersSent || res.destroyed) return;

    try {
        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token"
        });
        res.end(JSON.stringify(payload));
    } catch (error) {
        console.error("[AUTH] response error:", error.message);
    }
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        let settled = false;

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(value);
        };

        const timeout = setTimeout(() => {
            finish(new Error("Request body timeout."));
        }, BODY_TIMEOUT_MS);

        const cleanup = () => clearTimeout(timeout);

        req.on("data", chunk => {
            if (settled) return;

            raw += chunk.toString("utf8");

            if (Buffer.byteLength(raw, "utf8") > MAX_BODY) {
                cleanup();
                finish(new Error("Request body too large."));
                try { req.destroy(); } catch {}
            }
        });

        req.on("end", () => {
            cleanup();

            if (settled) return;

            if (!raw.trim()) {
                finish(null, {});
                return;
            }

            try {
                finish(null, JSON.parse(raw));
            } catch {
                finish(new Error("Invalid JSON body."));
            }
        });

        req.on("error", error => {
            cleanup();
            finish(error);
        });

        req.on("aborted", () => {
            cleanup();
            finish(new Error("Request aborted."));
        });
    });
}

function createSession(userId) {
    const token = "dm_session_" + crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL_MS;

    sessions.set(token, {
        userId,
        expiresAt
    });

    return {
        token,
        expiresAt: new Date(expiresAt).toISOString()
    };
}

function getSessionToken(req) {
    const direct = String(
        req.headers["x-session-token"] || ""
    ).trim();

    if (direct) return direct;

    const auth = String(
        req.headers.authorization || ""
    ).trim();

    if (/^Bearer\s+/i.test(auth)) {
        return auth.replace(/^Bearer\s+/i, "").trim();
    }

    return "";
}

function currentUser(req) {
    const token = getSessionToken(req);
    if (!token) return null;

    const session = sessions.get(token);
    if (!session) return null;

    if (session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
    }

    return readUsers().find(
        user => user.id === session.userId
    ) || null;
}

function signup(req, res) {
    parseBody(req)
        .then(body => {
            const name = normalizeName(body.name);
            const email = normalizeEmail(body.email);
            const password = String(body.password || "");

            if (name.length < 2 || name.length > 80) {
                return sendJson(res, 400, {
                    success: false,
                    error: "INVALID_NAME",
                    message: "Name must contain 2-80 characters."
                });
            }

            if (!validEmail(email)) {
                return sendJson(res, 400, {
                    success: false,
                    error: "INVALID_EMAIL",
                    message: "Enter a valid email address."
                });
            }

            if (password.length < 6 || password.length > 200) {
                return sendJson(res, 400, {
                    success: false,
                    error: "INVALID_PASSWORD",
                    message: "Password must contain 6-200 characters."
                });
            }

            const users = readUsers();

            if (users.some(user => user.email === email)) {
                return sendJson(res, 409, {
                    success: false,
                    error: "EMAIL_ALREADY_EXISTS",
                    message: "An account with this email already exists. Please log in."
                });
            }

            if (users.some(
                user => String(user.name || "").toLowerCase() === name.toLowerCase()
            )) {
                return sendJson(res, 409, {
                    success: false,
                    error: "NAME_ALREADY_EXISTS",
                    message: "That name is already registered."
                });
            }

            const now = new Date().toISOString();
            const passwordData = hashPassword(password);

            const user = {
                id: "dm_user_" + crypto.randomBytes(10).toString("hex"),
                name,
                email,
                passwordHash: passwordData.hash,
                passwordSalt: passwordData.salt,
                plan: "starter",
                authProvider: "password",
                createdAt: now,
                lastLoginAt: now
            };

            users.push(user);
            writeUsers(users);

            subscriptionManager.ensureUser({
                userId: user.id,
                name,
                email
            });

            subscriptionManager.ensureStarterSubscription(
                user.id,
                { name, email }
            );

            const session = createSession(user.id);

            return sendJson(res, 201, {
                success: true,
                message: "Account created successfully.",
                user: publicUser(user),
                session
            });
        })
        .catch(error => {
            console.error("[AUTH SIGNUP]", error);
            sendJson(res, 400, {
                success: false,
                error: "SIGNUP_FAILED",
                message: error.message || "Signup failed."
            });
        });
}

function login(req, res) {
    parseBody(req)
        .then(body => {
            const identifier = String(
                body.identifier || body.email || body.name || ""
            ).trim();

            const password = String(body.password || "");

            if (!identifier || !password) {
                return sendJson(res, 400, {
                    success: false,
                    error: "MISSING_CREDENTIALS",
                    message: "Email/name and password are required."
                });
            }

            const normalizedEmail = normalizeEmail(identifier);
            const normalizedName = normalizeName(identifier).toLowerCase();

            const users = readUsers();

            const user = users.find(item =>
                normalizeEmail(item.email) === normalizedEmail ||
                normalizeName(item.name).toLowerCase() === normalizedName
            );

            if (!user) {
                return sendJson(res, 401, {
                    success: false,
                    error: "INVALID_CREDENTIALS",
                    message: "Incorrect email/name or password."
                });
            }

            if (!verifyPassword(password, user)) {
                return sendJson(res, 401, {
                    success: false,
                    error: "INVALID_CREDENTIALS",
                    message: "Incorrect email/name or password."
                });
            }

            user.lastLoginAt = new Date().toISOString();

            const index = users.findIndex(
                item => item.id === user.id
            );

            if (index >= 0) {
                users[index] = user;
                writeUsers(users);
            }

            // Re-create the in-memory subscription record after a Render restart.
            subscriptionManager.ensureUser({
                userId: user.id,
                name: user.name,
                email: user.email
            });

            subscriptionManager.ensureStarterSubscription(
                user.id,
                {
                    name: user.name,
                    email: user.email
                }
            );

            const session = createSession(user.id);

            return sendJson(res, 200, {
                success: true,
                message: "Login successful.",
                user: publicUser(user),
                session
            });
        })
        .catch(error => {
            console.error("[AUTH LOGIN]", error);
            sendJson(res, 500, {
                success: false,
                error: "LOGIN_SERVER_ERROR",
                message: "The login request failed on the server.",
                details: process.env.NODE_ENV === "production" ? undefined : error.message
            });
        });
}

function me(req, res) {
    try {
        const user = currentUser(req);

        if (!user) {
            return sendJson(res, 401, {
                success: false,
                error: "UNAUTHORIZED",
                message: "A valid session is required. Send Authorization: Bearer <token>."
            });
        }

        // Restore the in-memory subscription record if the process restarted.
        subscriptionManager.ensureUser({
            userId: user.id,
            name: user.name,
            email: user.email
        });

        subscriptionManager.ensureStarterSubscription(
            user.id,
            {
                name: user.name,
                email: user.email
            }
        );

        const profile = subscriptionManager.getUserProfile(user.id);

        return sendJson(res, 200, {
            success: true,
            user: publicUser(user),
            subscription: profile ? profile.subscription : null,
            serverTime: new Date().toISOString()
        });
    } catch (error) {
        console.error("[AUTH ME]", error);
        return sendJson(res, 500, {
            success: false,
            error: "ME_SERVER_ERROR",
            message: "Could not load the current user."
        });
    }
}

function logout(req, res) {
    try {
        const token = getSessionToken(req);
        if (token) sessions.delete(token);

        return sendJson(res, 200, {
            success: true,
            message: "Logged out successfully."
        });
    } catch (error) {
        return sendJson(res, 500, {
            success: false,
            error: "LOGOUT_SERVER_ERROR",
            message: "Could not complete logout."
        });
    }
}

function authHealth(req, res) {
    return sendJson(res, 200, {
        success: true,
        type: "auth-health",
        status: "online",
        storage: "local-json",
        userCount: readUsers().length,
        otpRequired: false,
        routes: {
            signup: "POST /api/v1/auth/signup",
            login: "POST /api/v1/auth/login",
            me: "GET /api/v1/auth/me",
            logout: "POST /api/v1/auth/logout"
        },
        serverTime: new Date().toISOString()
    });
}

function handleAuthRequest(req, res, pathname) {
    if (!pathname.startsWith("/api/v1/auth")) return false;

    // Accept both /route and /route/.
    const cleanPath = pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return true;
    }

    if (req.method === "GET" && cleanPath === "/api/v1/auth/health") {
        authHealth(req, res);
        return true;
    }

    if (req.method === "POST" && cleanPath === "/api/v1/auth/signup") {
        signup(req, res);
        return true;
    }

    if (req.method === "POST" && cleanPath === "/api/v1/auth/login") {
        login(req, res);
        return true;
    }

    if (req.method === "GET" && cleanPath === "/api/v1/auth/me") {
        me(req, res);
        return true;
    }

    if (req.method === "POST" && cleanPath === "/api/v1/auth/logout") {
        logout(req, res);
        return true;
    }

    sendJson(res, 404, {
        success: false,
        error: "AUTH_ROUTE_NOT_FOUND",
        message: "Authentication route not found.",
        availableRoutes: {
            signup: "POST /api/v1/auth/signup",
            login: "POST /api/v1/auth/login",
            me: "GET /api/v1/auth/me",
            logout: "POST /api/v1/auth/logout",
            health: "GET /api/v1/auth/health"
        }
    });

    return true;
}

module.exports = {
    handleAuthRequest,
    currentUser,
    publicUser
};
