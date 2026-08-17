"use strict";

// Authentication module placeholder.
// This file is intentionally not loaded by server.js yet.
// OTP and auth integration will be wired into server.js in a separate deployment-safe change.

module.exports = {
  handleAuthRequest() { return false; },
  currentUser() { return null; },
  publicUser(user) { return user || null; }
};
