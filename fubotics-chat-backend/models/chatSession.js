const db = require("../db");

const chatSessionModel = {
  /**
   * Create a new chat session
   * @param {number} userId 
   * @param {string} name 
   * @returns {Promise<Object>} Created session
   */
  async create(userId, name = null) {
    const result = await db.query(
      "INSERT INTO chat_sessions (user_id, name) VALUES ($1, $2) RETURNING id, user_id, name, created_at, updated_at",
      [userId, name]
    );
    return result.rows[0];
  },

  /**
   * Get all sessions for a user
   * @param {number} userId 
   * @returns {Promise<Array>} Array of sessions
   */
  async getByUserId(userId) {
    const result = await db.query(
      "SELECT id, user_id, name, created_at, updated_at FROM chat_sessions WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    return result.rows;
  },

  /**
   * Get a session by ID (with user verification)
   * @param {number} sessionId 
   * @param {number} userId 
   * @returns {Promise<Object|null>} Session or null
   */
  async getById(sessionId, userId) {
    const result = await db.query(
      "SELECT id, user_id, name, created_at, updated_at FROM chat_sessions WHERE id = $1 AND user_id = $2",
      [sessionId, userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Delete a session
   * @param {number} sessionId 
   * @param {number} userId 
   * @returns {Promise<boolean>} True if deleted
   */
  async delete(sessionId, userId) {
    const result = await db.query(
      "DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2 RETURNING id",
      [sessionId, userId]
    );
    return result.rowCount > 0;
  },

  /**
   * Update session name
   * @param {number} sessionId 
   * @param {number} userId 
   * @param {string} name 
   * @returns {Promise<Object|null>} Updated session or null
   */
  async updateName(sessionId, userId, name) {
    const result = await db.query(
      "UPDATE chat_sessions SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, user_id, name, created_at, updated_at",
      [name, sessionId, userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Get session count for a user
   * @param {number} userId 
   * @returns {Promise<number>} Session count
   */
  async getCountByUserId(userId) {
    const result = await db.query(
      "SELECT COUNT(*) as count FROM chat_sessions WHERE user_id = $1",
      [userId]
    );
    return parseInt(result.rows[0].count);
  }
};

module.exports = chatSessionModel;
