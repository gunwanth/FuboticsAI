const db = require("../db");

const chatSessionModel = {
  /**
   * Create a new chat session
   * @param {number} userId 
   * @param {string} name 
   * @returns {Promise<Object>} Created session
   */
  async create(userId, name = null) {
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const result = await client.query(
        `INSERT INTO chat_sessions (user_id, session_number, name)
         VALUES (
           $1,
           (SELECT COALESCE(MAX(session_number), 0) + 1 FROM chat_sessions WHERE user_id = $1),
           $2
         )
         RETURNING id, user_id, session_number, name, created_at, updated_at`,
        [userId, name]
      );
      await client.query("COMMIT");
      return result.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Get all sessions for a user
   * @param {number} userId 
   * @returns {Promise<Array>} Array of sessions
   */
  async getByUserId(userId) {
    const result = await db.query(
      "SELECT id, user_id, session_number, name, created_at, updated_at FROM chat_sessions WHERE user_id = $1 ORDER BY session_number ASC",
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
      "SELECT id, user_id, session_number, name, created_at, updated_at FROM chat_sessions WHERE id = $1 AND user_id = $2",
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
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);

      const target = await client.query(
        "SELECT session_number FROM chat_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [sessionId, userId]
      );

      if (target.rowCount === 0) {
        await client.query("ROLLBACK");
        return false;
      }

      const deletedSessionNumber = target.rows[0].session_number;

      await client.query("DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
      await client.query(
        `UPDATE chat_sessions
         SET session_number = session_number - 1
         WHERE user_id = $1 AND session_number > $2`,
        [userId, deletedSessionNumber]
      );

      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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
      "UPDATE chat_sessions SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, user_id, session_number, name, created_at, updated_at",
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
    return parseInt(result.rows[0].count, 10);
  }
};

module.exports = chatSessionModel;
