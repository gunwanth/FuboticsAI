const db = require("../db");
const bcrypt = require("bcryptjs");

const userModel = {
  /**
   * Create a new user
   * @param {string} username 
   * @param {string} password 
   * @returns {Promise<Object>} Created user object
   */
  async create(username, password) {
    const pwHash = bcrypt.hashSync(password, 10);
    const result = await db.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at",
      [username, pwHash]
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
      "SELECT id, username, password_hash, created_at FROM users WHERE username = $1",
      [username]
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
      "SELECT id, username, created_at FROM users WHERE id = $1",
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
