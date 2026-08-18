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

function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function normalizeName(value) { return String(value || "").trim().replace(/\s+/g, " "); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function verifyPassword(password, user) {
    if (!user || !user.passwordHash || !user.passwordSalt) return false;
    const actual = Buffer.from(crypto.scryptSync(password, user.passwordSalt, 64).toString("hex"), "hex");
    const expected = Buffer.from(user.passwordHash, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
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
    if (res.headersSent) return;
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(payload));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        let done = false;
        const fail = error => { if (!done) { done = true; reject(error); } };
        req.setTimeout(8000, () => fail(new Error("Request body timeout.")));
        req.on("data", chunk => {
            raw += chunk.toString();
            if (raw.length > MAX_BODY) {
                fail(new Error("Request body too large."));
                try { req.destroy(); } catch {}
            }
        });
        req.on("end", () => {
            if (done) return;
            try { done = true; resolve(raw ? JSON.parse(raw) : {}); }
            catch { fail(new Error("Invalid JSON body.")); }
        });
        req.on("error", fail);
        req.on("aborted", () => fail(new Error("Request aborted.")));
    });
}

function createSession(userId) {
    const token = "dm_session_" + crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
}

function getSessionToken(req) {
    const direct = String(req.headers["x-session-token"] || "").trim();
    if (direct) return direct;
    const auth = String(req.headers.authorization || "");
    return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
}

function currentUser(req) {
    const token = getSessionToken(req);
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; }
    return readUsers().find(user => user.id === session.userId) || null;
}

function signup(req, res) {
    return parseBody(req).then(body => {
        const name = normalizeName(body.name);
        const email = normalizeEmail(body.email);
        const password = String(body.password || "");

        if (name.length < 2 || name.length > 80) return sendJson(res, 400, { success:false, error:"INVALID_NAME", message:"Name must contain 2-80 characters." });
        if (!validEmail(email)) return sendJson(res, 400, { success:false, error:"INVALID_EMAIL", message:"Enter a valid email address." });
        if (password.length < 6 || password.length > 200) return sendJson(res, 400, { success:false, error:"INVALID_PASSWORD", message:"Password must contain 6-200 characters." });

        const users = readUsers();
        if (users.some(user => user.email === email)) return sendJson(res, 409, { success:false, error:"EMAIL_ALREADY_EXISTS", message:"An account with this email already exists. Please log in." });
        if (users.some(user => String(user.name).toLowerCase() === name.toLowerCase())) return sendJson(res, 409, { success:false, error:"NAME_ALREADY_EXISTS", message:"That name is already registered." });

        const now = new Date().toISOString();
        const passwordData = hashPassword(password);
        const user = {
            id: "dm_user_" + crypto.randomBytes(10).toString("hex"),
            name, email,
            passwordHash: passwordData.hash,
            passwordSalt: passwordData.salt,
            plan: "starter",
            authProvider: "password",
            createdAt: now,
            lastLoginAt: now
        };
        users.push(user);
        writeUsers(users);
        subscriptionManager.ensureUser({ userId:user.id, name, email });
        subscriptionManager.ensureStarterSubscription(user.id, { name, email });

        const token = createSession(user.id);
        return sendJson(res, 201, {
            success:true,
            message:"Account created successfully.",
            user:publicUser(user),
            session:{ token, expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString() }
        });
    }).catch(error => {
        console.error("[AUTH SIGNUP]", error);
        sendJson(res, 400, { success:false, error:"SIGNUP_FAILED", message:error.message });
    });
}

function login(req, res) {
    return parseBody(req).then(body => {
        const identifier = String(body.email || body.name || body.identifier || "").trim();
        const password = String(body.password || "");
        if (!identifier || !password) return sendJson(res, 400, { success:false, error:"MISSING_CREDENTIALS", message:"Email/name and password are required." });

        const id = identifier.toLowerCase();
        const user = readUsers().find(item => item.email === normalizeEmail(identifier) || String(item.name || "").toLowerCase() === id);
        if (!user || !verifyPassword(password, user)) return sendJson(res, 401, { success:false, error:"INVALID_CREDENTIALS", message:"Incorrect email/name or password." });

        user.lastLoginAt = new Date().toISOString();
        const users = readUsers();
        const index = users.findIndex(item => item.id === user.id);
        if (index >= 0) { users[index] = user; writeUsers(users); }

        const token = createSession(user.id);
        return sendJson(res, 200, {
            success:true,
            message:"Login successful.",
            user:publicUser(user),
            session:{ token, expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString() }
        });
    }).catch(error => {
        console.error("[AUTH LOGIN]", error);
        sendJson(res, 400, { success:false, error:"LOGIN_FAILED", message:error.message });
    });
}

function me(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { success:false, error:"UNAUTHORIZED", message:"A valid session is required." });
    const profile = subscriptionManager.getUserProfile(user.id);
    return sendJson(res, 200, { success:true, user:publicUser(user), subscription:profile ? profile.subscription : null });
}

function logout(req, res) {
    const token = getSessionToken(req);
    if (token) sessions.delete(token);
    return sendJson(res, 200, { success:true, message:"Logged out successfully." });
}

function authHealth(req, res) {
    return sendJson(res, 200, {
        success:true,
        type:"auth-health",
        status:"online",
        storage:"local-json",
        userCount:readUsers().length,
        otpRequired:false,
        routes:{ signup:"POST /api/v1/auth/signup", login:"POST /api/v1/auth/login", me:"GET /api/v1/auth/me", logout:"POST /api/v1/auth/logout" },
        serverTime:new Date().toISOString()
    });
}

function handleAuthRequest(req, res, pathname) {
    if (!pathname.startsWith("/api/v1/auth")) return false;
    if (req.method === "OPTIONS") { sendJson(res, 204, {}); return true; }
    if (req.method === "GET" && pathname === "/api/v1/auth/health") { authHealth(req,res); return true; }
    if (req.method === "POST" && pathname === "/api/v1/auth/signup") { signup(req,res); return true; }
    if (req.method === "POST" && pathname === "/api/v1/auth/login") { login(req,res); return true; }
    if (req.method === "GET" && pathname === "/api/v1/auth/me") { me(req,res); return true; }
    if (req.method === "POST" && pathname === "/api/v1/auth/logout") { logout(req,res); return true; }
    sendJson(res, 404, { success:false, error:"AUTH_ROUTE_NOT_FOUND", message:"Authentication route not found.", availableRoutes:{ signup:"POST /api/v1/auth/signup", login:"POST /api/v1/auth/login", me:"GET /api/v1/auth/me", logout:"POST /api/v1/auth/logout", health:"GET /api/v1/auth/health" } });
    return true;
}

module.exports = { handleAuthRequest, currentUser, publicUser };
