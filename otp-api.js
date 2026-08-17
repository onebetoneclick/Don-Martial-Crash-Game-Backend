"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const DATA_DIR = path.join(__dirname, "data");
const OTP_FILE = path.join(DATA_DIR, "otps.json");
const VERIFIED_FILE = path.join(DATA_DIR, "verified-emails.json");

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

const SMTP_CONNECTION_TIMEOUT = 5000;
const SMTP_GREETING_TIMEOUT = 5000;
const SMTP_SOCKET_TIMEOUT = 7000;
const SMTP_SEND_TIMEOUT = 9000;

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(OTP_FILE)) fs.writeFileSync(OTP_FILE, "[]");
  if (!fs.existsSync(VERIFIED_FILE)) fs.writeFileSync(VERIFIED_FILE, "[]");
}

function readJson(file) {
  ensureStorage();
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeJson(file, value) {
  ensureStorage();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readOtps() { return readJson(OTP_FILE); }
function writeOtps(value) { writeJson(OTP_FILE, value); }
function readVerified() { return readJson(VERIFIED_FILE); }
function writeVerified(value) { writeJson(VERIFIED_FILE, value); }

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
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "");

  if (!user || !pass) return null;

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT,
    greetingTimeout: SMTP_GREETING_TIMEOUT,
    socketTimeout: SMTP_SOCKET_TIMEOUT,
    logger: false
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
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.setTimeout(5000, () => fail(new Error("Request body timeout")));
    req.on("data", chunk => {
      raw += chunk.toString();
      if (raw.length > 1024 * 1024) {
        fail(new Error("Request body too large"));
        try { req.destroy(); } catch {}
      }
    });
    req.on("end", () => {
      if (settled) return;
      try {
        settled = true;
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        fail(new Error("Invalid JSON body"));
      }
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("Request aborted")));
  });
}

function markEmailVerified(email, purpose) {
  const now = Date.now();
  const records = readVerified().filter(item => new Date(item.expiresAt).getTime() > now);
  records.push({
    id: "verified_" + crypto.randomBytes(10).toString("hex"),
    email,
    purpose,
    verifiedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString()
  });
  writeVerified(records.slice(-5000));
}

function consumeVerifiedEmail(email, purpose) {
  const now = Date.now();
  const records = readVerified().filter(item => new Date(item.expiresAt).getTime() > now);
  const index = records.findIndex(item => item.email === email && item.purpose === purpose);
  if (index === -1) {
    writeVerified(records);
    return false;
  }
  records.splice(index, 1);
  writeVerified(records);
  return true;
}

function isEmailVerified(email, purpose) {
  const now = Date.now();
  const records = readVerified().filter(item => new Date(item.expiresAt).getTime() > now);
  writeVerified(records);
  return records.some(item => item.email === email && item.purpose === purpose);
}

async function sendMailWithTimeout(transporter, mail) {
  let timer;
  try {
    return await Promise.race([
      transporter.sendMail(mail),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Gmail SMTP operation timed out")), SMTP_SEND_TIMEOUT);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function testGmailSmtp(req, res) {
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "");

  if (!user || !pass) {
    return sendJson(res, 503, {
      success: false,
      smtp: "gmail",
      connection: false,
      authenticated: false,
      error: "GMAIL_NOT_CONFIGURED",
      message: "SMTP_USER or SMTP_PASS is missing on the server.",
      requiredEnvironment: ["SMTP_USER", "SMTP_PASS"]
    });
  }

  const transporter = createTransporter();
  const startedAt = Date.now();

  try {
    await transporter.verify();
    const elapsedMs = Date.now() - startedAt;
    console.log(`[GMAIL TEST] SMTP verified successfully in ${elapsedMs}ms`);

    return sendJson(res, 200, {
      success: true,
      smtp: "gmail",
      connection: true,
      authenticated: true,
      message: "Gmail SMTP connection and authentication are working.",
      elapsedMs,
      account: user,
      server: "smtp.gmail.com"
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    console.error("[GMAIL TEST]", error.code || "ERROR", error.message);

    let errorType = "GMAIL_SMTP_TEST_FAILED";
    let message = "Gmail SMTP connection or authentication failed.";

    if (error.code === "EAUTH") {
      errorType = "GMAIL_AUTH_FAILED";
      message = "Gmail SMTP was reached, but authentication failed. Check the Gmail address and App Password.";
    } else if (
      error.code === "ETIMEDOUT" ||
      String(error.message || "").toLowerCase().includes("timed out")
    ) {
      errorType = "GMAIL_CONNECTION_TIMEOUT";
      message = "The server could not reach Gmail SMTP before the timeout.";
    } else if (error.code === "ECONNECTION" || error.code === "ECONNREFUSED") {
      errorType = "GMAIL_CONNECTION_FAILED";
      message = "The server could not establish a connection to Gmail SMTP.";
    }

    return sendJson(res, 502, {
      success: false,
      smtp: "gmail",
      connection: false,
      authenticated: error.code === "EAUTH" ? false : null,
      error: errorType,
      message,
      elapsedMs,
      account: user,
      server: "smtp.gmail.com",
      details: process.env.NODE_ENV === "production" ? undefined : (error.code || error.message),
      retryable: error.code !== "EAUTH"
    });
  } finally {
    try { transporter.close(); } catch {}
  }
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
      error: "GMAIL_NOT_CONFIGURED",
      message: "Gmail OTP service is not configured on the server.",
      requiredEnvironment: ["SMTP_USER", "SMTP_PASS"]
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
    await sendMailWithTimeout(transporter, {
      from: `${appName} <${from}>`,
      to: email,
      subject: `${appName} verification code`,
      text: `Your ${appName} verification code is ${otp}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto"><h2>${appName}</h2><p>Your verification code is:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:20px 0">${otp}</div><p>This code expires in 10 minutes.</p><p>If you did not request this code, you can ignore this email.</p></div>`
    });
  } catch (error) {
    records = readOtps().filter(item => item.id !== record.id);
    writeOtps(records);
    console.error("[OTP EMAIL]", error.code || "ERROR", error.message);

    let errorType = "GMAIL_SEND_FAILED";
    if (error.message.includes("timed out") || error.code === "ETIMEDOUT") {
      errorType = "GMAIL_CONNECTION_TIMEOUT";
    } else if (error.code === "EAUTH") {
      errorType = "GMAIL_AUTH_FAILED";
    } else if (error.code === "ECONNECTION" || error.code === "ECONNREFUSED") {
      errorType = "GMAIL_CONNECTION_FAILED";
    }

    return sendJson(res, 502, {
      success: false,
      error: errorType,
      message: "Gmail could not be reached to send the verification email.",
      retryable: true,
      details: process.env.NODE_ENV === "production" ? undefined : (error.code || error.message)
    });
  } finally {
    try { transporter.close(); } catch {}
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

  if (!["signup", "login", "password_reset"].includes(purpose)) {
    return sendJson(res, 400, { success: false, error: "INVALID_PURPOSE", message: "Invalid OTP purpose." });
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
  markEmailVerified(email, purpose);

  return sendJson(res, 200, {
    success: true,
    verified: true,
    message: "OTP verified successfully.",
    email,
    purpose,
    verificationExpiresInSeconds: 15 * 60
  });
}

function handleOtpRequest(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/v1/system/gmail-smtp-test") {
    testGmailSmtp(req, res).catch(error => sendJson(res, 500, {
      success: false,
      smtp: "gmail",
      connection: false,
      error: "GMAIL_TEST_ERROR",
      message: error.message
    }));
    return true;
  }

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
module.exports = {
  handleOtpRequest,
  isEmailVerified,
  consumeVerifiedEmail
};
