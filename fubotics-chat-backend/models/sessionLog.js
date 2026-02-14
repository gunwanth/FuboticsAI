const db = require("../db");

const sessionLogModel = {
  async log(userId, sessionId, action, ipAddress = null, userAgent = null, deviceInfo = null, details = {}) {
    const result = await db.query(
      `INSERT INTO session_logs (user_id, session_id, action, ip_address, user_agent, device_info, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, session_id, action, created_at`,
      [userId, String(sessionId), action, ipAddress, userAgent, deviceInfo, details]
    );
    return result.rows[0];
  },

  async getByUserId(userId, limit = 50) {
    const result = await db.query(
      `SELECT id, user_id, session_id, action, ip_address, user_agent, device_info, created_at, details
       FROM session_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },

  async getActiveSessions(userId) {
    const result = await db.query(
      `SELECT DISTINCT ON (session_id)
         id, user_id, session_id, action, ip_address, user_agent, device_info, created_at
       FROM session_logs
       WHERE user_id = $1
       ORDER BY session_id, created_at DESC`,
      [userId]
    );
    return result.rows.filter((row) => row.action === "login" || row.action === "token_refresh");
  },

  async getSessionStats(userId) {
    const result = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE action = 'login') as total_logins,
         COUNT(*) FILTER (WHERE action = 'logout') as total_logouts,
         COUNT(*) FILTER (WHERE action = 'token_refresh') as total_refreshes,
         COUNT(*) FILTER (WHERE action = 'logout_all') as total_logout_all,
         COUNT(*) FILTER (WHERE action = 'expired') as total_expired,
         MIN(created_at) as first_session,
         MAX(created_at) as last_activity
       FROM session_logs
       WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0];
  }
};

module.exports = sessionLogModel;
