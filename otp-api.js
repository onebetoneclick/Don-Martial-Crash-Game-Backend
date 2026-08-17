"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const DATA_DIR = path.join(__dirname, "data");
const OTP_FILE = path.join(DATA_DIR, "otps.json");
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(OTP_FILE)) fs.writeFileSync(OTP_FILE, "[]");
}

function readOtps() {
  ensureStorage();
  try {
    const value = JSON.parse(fs.readFileSync(OTP_FILE, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeOtps(value) {
  ensureStorage();
  const tmp = OTP_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, OTP_FILE);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function hashOtp(otp, salt) {
  return crypto.createHash("sha256").update(`${salt}:${otp}`).digest("hex");
}

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk.toString();
      if (raw.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function sendOtp(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (error) {
    return sendJson(res, 400, { success: false, error: "INVALID_JSON", message: error.message });
  }

  const email = normalizeEmail(body.email);
  const purpose = String(body.purpose || "signup").trim().toLowerCase();

  if (!validEmail(email)) {
    return sendJson(res, 400, { success: false, error: "INVALID_EMAIL", message: "Enter a valid email address." });
  }

  if (!["signup", "login", "password_reset"].includes(purpose)) {
    return sendJson(res, 400, { success: false, error: "INVALID_PURPOSE", message: "Invalid OTP purpose." });
  }

  const now = Date.now();
  let records = readOtps().filter(item => new Date(item.expiresAt).getTime() > now);
  const existing = records.find(item => item.email === email && item.purpose === purpose);

  if (existing && now - new Date(existing.sentAt).getTime() < RESEND_COOLDOWN_MS) {
    const remaining = Math.ceil((RESEND_COOLDOWN_MS - (now - new Date(existing.sentAt).getTime())) / 1000);
    writeOtps(records);
    return sendJson(res, 429, {
      success: false,
      error: "OTP_COOLDOWN",
      message: `Please wait ${remaining} seconds before requesting another OTP.`,
      retryAfterSeconds: remaining
    });
  }

  const transporter = createTransporter();
  if (!transporter) {
    return sendJson(res, 503, {
      success: false,
      error: "SMTP_NOT_CONFIGURED",
      message: "OTP email service is not configured on the server yet. Add SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS to Render environment variables."
    });
  }

  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const salt = crypto.randomBytes(16).toString("hex");
  const record = {
    id: "otp_" + crypto.randomBytes(10).toString("hex"),
    email,
    purpose,
    salt,
    otpHash: hashOtp(otp, salt),
    attempts: 0,
    sentAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OTP_TTL_MS).toISOString()
  };

  records = records.filter(item => !(item.email === email && item.purpose === purpose));
  records.push(record);
  writeOtps(records.slice(-5000));

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appName = process.env.APP_NAME || "Don Martial";

  try {
    await transporter.sendMail({
      from: `${appName} <${from}>`,
      to: email,
      subject: `${appName} verification code`,
      text: `Your ${appName} verification code is ${otp}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto"><h2>${appName}</h2><p>Your verification code is:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:20px 0">${otp}</div><p>This code expires in 10 minutes.</p><p>If you did not request this code, you can ignore this email.</p></div>`
    });
  } catch (error) {
    records = readOtps().filter(item => item.id !== record.id);
    writeOtps(records);
    console.error("[OTP EMAIL]", error.message);
    return sendJson(res, 502, { success: false, error: "OTP_SEND_FAILED", message: "The verification email could not be sent." });
  }

  return sendJson(res, 200, {
    success: true,
    message: "OTP sent successfully.",
    email,
    purpose,
    expiresInSeconds: OTP_TTL_MS / 1000,
    resendAfterSeconds: RESEND_COOLDOWN_MS / 1000
  });
}

async function verifyOtp(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (error) {
    return sendJson(res, 400, { success: false, error: "INVALID_JSON", message: error.message });
  }

  const email = normalizeEmail(body.email);
  const purpose = String(body.purpose || "signup").trim().toLowerCase();
  const otp = String(body.otp || "").trim();

  if (!validEmail(email) || !/^\d{6}$/.test(otp)) {
    return sendJson(res, 400, { success: false, error: "INVALID_OTP", message: "Enter the email and the 6-digit OTP." });
  }

  const now = Date.now();
  const records = readOtps().filter(item => new Date(item.expiresAt).getTime() > now);
  const record = records.find(item => item.email === email && item.purpose === purpose);

  if (!record) {
    writeOtps(records);
    return sendJson(res, 400, { success: false, error: "OTP_NOT_FOUND", message: "OTP not found or expired. Request a new OTP." });
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    return sendJson(res, 429, { success: false, error: "OTP_ATTEMPTS_EXCEEDED", message: "Too many incorrect OTP attempts. Request a new OTP." });
  }

  const expected = hashOtp(otp, record.salt);
  if (expected !== record.otpHash) {
    record.attempts += 1;
    writeOtps(records);
    return sendJson(res, 400, {
      success: false,
      error: "OTP_INVALID",
      message: "The verification code is incorrect.",
      attemptsRemaining: Math.max(0, MAX_ATTEMPTS - record.attempts)
    });
  }

  writeOtps(records.filter(item => item.id !== record.id));
  return sendJson(res, 200, {
    success: true,
    verified: true,
    message: "OTP verified successfully.",
    email,
    purpose
  });
}

function handleOtpRequest(req, res, pathname) {
  if (!pathname.startsWith("/api/v1/auth/otp")) return false;

  if (req.method === "POST" && pathname === "/api/v1/auth/otp/send") {
    sendOtp(req, res).catch(error => sendJson(res, 500, { success: false, error: "OTP_ERROR", message: error.message }));
    return true;
  }

  if (req.method === "POST" && pathname === "/api/v1/auth/otp/verify") {
    verifyOtp(req, res).catch(error => sendJson(res, 500, { success: false, error: "OTP_ERROR", message: error.message }));
    return true;
  }

  sendJson(res, 404, { success: false, error: "OTP_ROUTE_NOT_FOUND" });
  return true;
}

ensureStorage();
module.exports = { handleOtpRequest };
