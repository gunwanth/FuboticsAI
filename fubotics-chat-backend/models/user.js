const db = require("../db");
const bcrypt = require("bcryptjs");

const userModel = {
  /**
   * Create a new user
   * @param {string} username 
   * @param {string} password 
   * @returns {Promise<Object>} Created user object
   */
  async create(username, password, email = null) {
    const pwHash = bcrypt.hashSync(password, 10);
    const result = await db.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, created_at",
      [username, email, pwHash]
    );
    return result.rows[0];
  },

  /**
   * Find user by username
   * @param {string} username 
   * @returns {Promise<Object|null>} User object or null
   */
  async findByUsername(username) {
    const result = await db.query(
      "SELECT id, username, email, password_hash, created_at FROM users WHERE username = $1",
      [username]
    );
    return result.rows[0] || null;
  },

  /**
   * Find user by email
   * @param {string} email
   * @returns {Promise<Object|null>} User object or null
   */
  async findByEmail(email) {
    const result = await db.query(
      "SELECT id, username, email, password_hash, created_at FROM users WHERE lower(email) = lower($1)",
      [email]
    );
    return result.rows[0] || null;
  },

  /**
   * Find user by ID
   * @param {number} id 
   * @returns {Promise<Object|null>} User object or null
   */
  async findById(id) {
    const result = await db.query(
      "SELECT id, username, email, created_at FROM users WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  },

  /**
   * Verify password against hash
   * @param {string} password 
   * @param {string} hash 
   * @returns {boolean} True if password matches
   */
  verifyPassword(password, hash) {
    return bcrypt.compareSync(password, hash);
  },

  /**
   * Update password by username
   * @param {string} username
   * @param {string} newPassword
   * @returns {Promise<boolean>}
   */
  async updatePasswordByUsername(username, newPassword) {
    const pwHash = bcrypt.hashSync(newPassword, 10);
    const result = await db.query(
      "UPDATE users SET password_hash = $1 WHERE username = $2 RETURNING id",
      [pwHash, username]
    );
    return result.rowCount > 0;
  },

  /**
   * Update password by email
   * @param {string} email
   * @param {string} newPassword
   * @returns {Promise<boolean>}
   */
  async updatePasswordByEmail(email, newPassword) {
    const pwHash = bcrypt.hashSync(newPassword, 10);
    const result = await db.query(
      "UPDATE users SET password_hash = $1 WHERE lower(email) = lower($2) RETURNING id",
      [pwHash, email]
    );
    return result.rowCount > 0;
  },

  /**
   * Get all users (admin function)
   * @returns {Promise<Array>} Array of users
   */
  async findAll() {
    const result = await db.query(
      "SELECT id, username, created_at FROM users ORDER BY created_at DESC"
    );
    return result.rows;
  }
};

module.exports = userModel;
