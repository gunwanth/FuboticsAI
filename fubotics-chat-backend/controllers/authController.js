const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const config = require("../config/database");
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

const authController = {
  async signup(req, res) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }

      const existingUser = await userModel.findByUsername(username);
      if (existingUser) {
        return res.status(409).json({ error: "Username taken" });
      }

      const user = await userModel.create(username, password);
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
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }

      const user = await userModel.findByUsername(username);
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
  }
};

module.exports = authController;
