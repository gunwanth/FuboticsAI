const crypto = require("crypto");
const db = require("../db");
const config = require("../config/database");

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

function buildExpiry() {
  const maxAgeMs = config.cookie.maxAge || 7 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + maxAgeMs);
}

const authTokenModel = {
  async create(userId, options = {}) {
    const rawToken = generateRefreshToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = buildExpiry();

    const result = await db.query(
      `INSERT INTO auth_tokens (
         user_id,
         token,
         token_type,
         session_id,
         expires_at,
         ip_address,
         user_agent,
         device_info,
         rotated_from_id
       )
       VALUES ($1, $2, 'refresh', COALESCE($3::uuid, uuid_generate_v4()), $4, $5, $6, $7, $8)
       RETURNING id, user_id, session_id, expires_at, created_at`,
      [
        userId,
        tokenHash,
        options.sessionId || null,
        expiresAt,
        options.ipAddress || null,
        options.userAgent || null,
        options.deviceInfo || null,
        options.rotatedFromId || null,
      ]
    );

    return {
      ...result.rows[0],
      token: rawToken,
      tokenHash,
    };
  },

  async verify(rawToken) {
    const tokenHash = hashToken(rawToken);
    const result = await db.query(
      `SELECT at.id, at.user_id, at.session_id, at.expires_at, at.revoked, at.created_at,
              at.last_used_at, at.ip_address, at.user_agent, at.device_info,
              u.username
       FROM auth_tokens at
       JOIN users u ON at.user_id = u.id
       WHERE at.revoked = false
         AND at.expires_at > NOW()
         AND (at.token = $1 OR at.token = $2)
       ORDER BY at.created_at DESC
       LIMIT 1`,
      [tokenHash, rawToken]
    );
    return result.rows[0] || null;
  },

  async touch(tokenId) {
    await db.query(
      "UPDATE auth_tokens SET last_used_at = NOW() WHERE id = $1",
      [tokenId]
    );
  },

  async revoke(rawToken) {
    const tokenHash = hashToken(rawToken);
    const result = await db.query(
      `UPDATE auth_tokens
       SET revoked = true, revoked_at = NOW()
       WHERE token = $1 OR token = $2
       RETURNING id`,
      [tokenHash, rawToken]
    );
    return result.rowCount > 0;
  },

  async revokeById(tokenId, replacedByTokenId = null) {
    const result = await db.query(
      `UPDATE auth_tokens
       SET revoked = true,
           revoked_at = NOW(),
           replaced_by_token_id = COALESCE($2, replaced_by_token_id)
       WHERE id = $1
       RETURNING id`,
      [tokenId, replacedByTokenId]
    );
    return result.rowCount > 0;
  },

  async rotate(rawToken, options = {}) {
    const current = await this.verify(rawToken);
    if (!current) {
      return null;
    }

    await this.touch(current.id);

    const next = await this.create(current.user_id, {
      sessionId: current.session_id,
      ipAddress: options.ipAddress || current.ip_address,
      userAgent: options.userAgent || current.user_agent,
      deviceInfo: options.deviceInfo || current.device_info,
      rotatedFromId: current.id,
    });

    await this.revokeById(current.id, next.id);

    return {
      previous: current,
      current: next,
    };
  },

  async revokeAllForUser(userId) {
    const result = await db.query(
      `UPDATE auth_tokens
       SET revoked = true, revoked_at = NOW()
       WHERE user_id = $1 AND revoked = false
       RETURNING id`,
      [userId]
    );
    return result.rowCount;
  },

  async getActiveTokens(userId) {
    const result = await db.query(
      `SELECT id, user_id, session_id, expires_at, created_at, last_used_at, ip_address, user_agent, device_info
       FROM auth_tokens
       WHERE user_id = $1 AND revoked = false AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  },

  async cleanupExpired() {
    const result = await db.query(
      "DELETE FROM auth_tokens WHERE expires_at < NOW() RETURNING id"
    );
    return result.rowCount;
  },

  async getActiveTokenCount(userId) {
    const result = await db.query(
      `SELECT COUNT(*) as count
       FROM auth_tokens
       WHERE user_id = $1 AND revoked = false AND expires_at > NOW()`,
      [userId]
    );
    return Number.parseInt(result.rows[0].count, 10);
  }
};

module.exports = authTokenModel;
