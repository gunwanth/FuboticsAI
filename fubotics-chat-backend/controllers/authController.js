const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const config = require("../config/database");
const db = require("../db");
const userModel = require("../models/user");
const authTokenModel = require("../models/authToken");
const sessionLogModel = require("../models/sessionLog");

function getClientMetadata(req) {
  const userAgent = req.get("user-agent") || null;
  return {
    ipAddress: req.ip || null,
    userAgent,
    deviceInfo: userAgent,
  };
}

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: config.cookie.maxAge,
    path: "/",
  };
}

function generateAccessToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    config.jwt.secret,
    { expiresIn: config.jwt.accessTokenExpiry }
  );
}

function validatePasswordConstraints(password) {
  const value = String(password || "");
  if (value.length < 8) {
    return "Password must be at least 8 characters long";
  }
  if (!/[A-Z]/.test(value)) {
    return "Password must include at least 1 capital letter";
  }
  return null;
}

function safeDeleteFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn("Failed deleting file during account cleanup:", err?.message || err);
  }
}

async function cleanupUserFiles(userId) {
  const result = await db.query(
    `SELECT DISTINCT a.file_path, a.filename, a.original_filename
     FROM attachments a
     JOIN chat_sessions cs ON cs.id = a.session_id
     WHERE cs.user_id = $1`,
    [userId]
  );

  const baseDir = path.join(__dirname, "..");
  for (const row of result.rows) {
    const candidates = [];
    if (row.file_path) candidates.push(String(row.file_path));
    if (row.filename) {
      candidates.push(path.join(baseDir, "attachments", row.filename));
      candidates.push(path.join(baseDir, "uploads", row.filename));
      candidates.push(path.join(baseDir, "generated", row.filename));
    }
    if (row.original_filename) {
      candidates.push(path.join(baseDir, "attachments", row.original_filename));
      candidates.push(path.join(baseDir, "uploads", row.original_filename));
      candidates.push(path.join(baseDir, "generated", row.original_filename));
    }

    const uniquePaths = Array.from(new Set(candidates.filter(Boolean)));
    uniquePaths.forEach((p) => safeDeleteFile(p));
  }
}

const authController = {
  async signup(req, res) {
    try {
      const { username, password, email } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }

      const passwordIssue = validatePasswordConstraints(password);
      if (passwordIssue) {
        return res.status(400).json({ error: passwordIssue });
      }

      const existingUser = await userModel.findByUsername(username);
      if (existingUser) {
        return res.status(409).json({ error: "Username taken" });
      }

      const normalizedEmail = String(email || "").trim().toLowerCase() || null;
      if (normalizedEmail) {
        const existingEmail = await userModel.findByEmail(normalizedEmail);
        if (existingEmail) {
          return res.status(409).json({ error: "Email already in use" });
        }
      }

      const user = await userModel.create(username, password, normalizedEmail);
      const accessToken = generateAccessToken(user);
      const meta = getClientMetadata(req);
      const refreshToken = await authTokenModel.create(user.id, meta);

      await sessionLogModel.log(
        user.id,
        refreshToken.session_id,
        "login",
        meta.ipAddress,
        meta.userAgent,
        meta.deviceInfo,
        { method: "signup", token_id: refreshToken.id }
      );

      res.cookie(config.cookie.refreshToken, refreshToken.token, refreshCookieOptions());

      res.status(201).json({
        user: { id: user.id, username: user.username },
        accessToken,
        sessionId: refreshToken.session_id,
      });
    } catch (err) {
      console.error("Signup error:", err);
      res.status(500).json({ error: "Failed to create user" });
    }
  },

  async login(req, res) {
    try {
      const identifier = String(req.body?.username || req.body?.email || "").trim();
      const { password } = req.body;

      if (!identifier || !password) {
        return res.status(400).json({ error: "Username or email and password required" });
      }

      const user = identifier.includes("@")
        ? await userModel.findByEmail(identifier.toLowerCase())
        : await userModel.findByUsername(identifier);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const ok = userModel.verifyPassword(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const accessToken = generateAccessToken(user);
      const meta = getClientMetadata(req);
      const refreshToken = await authTokenModel.create(user.id, meta);

      await sessionLogModel.log(
        user.id,
        refreshToken.session_id,
        "login",
        meta.ipAddress,
        meta.userAgent,
        meta.deviceInfo,
        { method: "password", token_id: refreshToken.id }
      );

      res.cookie(config.cookie.refreshToken, refreshToken.token, refreshCookieOptions());

      res.json({
        user: { id: user.id, username: user.username },
        accessToken,
        sessionId: refreshToken.session_id,
      });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ error: "Failed to login" });
    }
  },

  async refresh(req, res) {
    try {
      const refreshToken = req.cookies[config.cookie.refreshToken];
      if (!refreshToken) {
        return res.status(401).json({ error: "No refresh token" });
      }

      const meta = getClientMetadata(req);
      const rotated = await authTokenModel.rotate(refreshToken, meta);
      if (!rotated) {
        return res.status(401).json({ error: "Invalid or expired refresh token" });
      }

      const user = await userModel.findById(rotated.current.user_id);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      const accessToken = generateAccessToken(user);

      await sessionLogModel.log(
        user.id,
        rotated.current.session_id,
        "token_refresh",
        meta.ipAddress,
        meta.userAgent,
        meta.deviceInfo,
        {
          previous_token_id: rotated.previous.id,
          token_id: rotated.current.id,
        }
      );

      res.cookie(config.cookie.refreshToken, rotated.current.token, refreshCookieOptions());

      res.json({
        user: { id: user.id, username: user.username },
        accessToken,
        sessionId: rotated.current.session_id,
      });
    } catch (err) {
      console.error("Refresh error:", err);
      res.status(500).json({ error: "Failed to refresh token" });
    }
  },

  async logout(req, res) {
    try {
      const refreshToken = req.cookies[config.cookie.refreshToken];
      const meta = getClientMetadata(req);
      let logoutUserId = null;
      let logoutSessionId = uuidv4();

      if (refreshToken) {
        const tokenData = await authTokenModel.verify(refreshToken);
        if (tokenData) {
          logoutUserId = tokenData.user_id;
          logoutSessionId = tokenData.session_id;
          await authTokenModel.revokeById(tokenData.id);
        } else {
          await authTokenModel.revoke(refreshToken);
        }
      }

      if (!logoutUserId) {
        const auth = req.headers.authorization;
        if (auth && auth.startsWith("Bearer ")) {
          try {
            const payload = jwt.verify(auth.split(" ")[1], config.jwt.secret);
            logoutUserId = payload.id;
          } catch (_) {
            // Ignore invalid access token during logout.
          }
        }
      }

      if (logoutUserId) {
        await sessionLogModel.log(
          logoutUserId,
          logoutSessionId,
          "logout",
          meta.ipAddress,
          meta.userAgent,
          meta.deviceInfo,
          { method: "manual" }
        );
      }

      res.clearCookie(config.cookie.refreshToken, {
        path: "/",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        secure: process.env.NODE_ENV === "production",
      });

      res.json({ success: true });
    } catch (err) {
      console.error("Logout error:", err);
      res.status(500).json({ error: "Failed to logout" });
    }
  },

  async me(req, res) {
    try {
      const user = await userModel.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ user: { id: user.id, username: user.username } });
    } catch (err) {
      console.error("Me error:", err);
      res.status(500).json({ error: "Failed to get user" });
    }
  },

  async getSessionLogs(req, res) {
    try {
      const logs = await sessionLogModel.getByUserId(req.user.id, 50);
      const stats = await sessionLogModel.getSessionStats(req.user.id);
      const activeTokens = await authTokenModel.getActiveTokens(req.user.id);
      res.json({ logs, stats, activeSessions: activeTokens });
    } catch (err) {
      console.error("Session logs error:", err);
      res.status(500).json({ error: "Failed to get session logs" });
    }
  },

  async logoutAll(req, res) {
    try {
      const revokedCount = await authTokenModel.revokeAllForUser(req.user.id);
      const meta = getClientMetadata(req);

      await sessionLogModel.log(
        req.user.id,
        uuidv4(),
        "logout_all",
        meta.ipAddress,
        meta.userAgent,
        meta.deviceInfo,
        { method: "all_devices", revoked_tokens: revokedCount }
      );

      res.clearCookie(config.cookie.refreshToken, {
        path: "/",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        secure: process.env.NODE_ENV === "production",
      });

      res.json({ success: true, revokedCount });
    } catch (err) {
      console.error("Logout all error:", err);
      res.status(500).json({ error: "Failed to logout from all devices" });
    }
  },

  async forgotPasswordByUsername(req, res) {
    try {
      const username = String(req.body?.username || "").trim();
      const newPassword = String(req.body?.newPassword || "");
      if (!username || !newPassword) {
        return res.status(400).json({ error: "Username and new password are required" });
      }
      const passwordIssue = validatePasswordConstraints(newPassword);
      if (passwordIssue) {
        return res.status(400).json({ error: passwordIssue });
      }
      const updated = await userModel.updatePasswordByUsername(username, newPassword);
      if (!updated) {
        return res.status(404).json({ error: "Username not found" });
      }
      return res.json({ success: true });
    } catch (err) {
      console.error("Forgot password (username) error:", err);
      return res.status(500).json({ error: "Failed to reset password" });
    }
  },

  async forgotPasswordByEmail(req, res) {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const newPassword = String(req.body?.newPassword || "");
      if (!email || !newPassword) {
        return res.status(400).json({ error: "Email and new password are required" });
      }
      const passwordIssue = validatePasswordConstraints(newPassword);
      if (passwordIssue) {
        return res.status(400).json({ error: passwordIssue });
      }
      const updated = await userModel.updatePasswordByEmail(email, newPassword);
      if (!updated) {
        return res.status(404).json({ error: "Email not found" });
      }
      return res.json({ success: true });
    } catch (err) {
      console.error("Forgot password (email) error:", err);
      return res.status(500).json({ error: "Failed to reset password" });
    }
  },

  async deleteAccount(req, res) {
    try {
      const userId = req.user.id;
      await cleanupUserFiles(userId);

      const deleted = await db.query("DELETE FROM users WHERE id = $1 RETURNING id", [userId]);
      if (deleted.rowCount === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      res.clearCookie(config.cookie.refreshToken, {
        path: "/",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        secure: process.env.NODE_ENV === "production",
      });

      res.json({ success: true });
    } catch (err) {
      console.error("Delete account error:", err);
      res.status(500).json({ error: "Failed to delete account" });
    }
  }
};

module.exports = authController;
