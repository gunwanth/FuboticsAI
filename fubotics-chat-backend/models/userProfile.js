const db = require("../db");

const userProfileModel = {
  /**
   * Get a user's persistent profile and preferences
   * @param {number} userId 
   * @returns {Promise<Object|null>}
   */
  async getByUserId(userId) {
    const result = await db.query(
      `SELECT user_id, display_name, about_user, global_instructions, preferences, created_at, updated_at
       FROM user_profiles
       WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Upsert a user's persistent profile and preferences
   * @param {number} userId 
   * @param {Object} data 
   * @returns {Promise<Object>}
   */
  async upsert(userId, { displayName = null, aboutUser = null, globalInstructions = null, preferences = {} } = {}) {
    const result = await db.query(
      `INSERT INTO user_profiles (user_id, display_name, about_user, global_instructions, preferences, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name),
           about_user = COALESCE(EXCLUDED.about_user, user_profiles.about_user),
           global_instructions = COALESCE(EXCLUDED.global_instructions, user_profiles.global_instructions),
           preferences = user_profiles.preferences || EXCLUDED.preferences,
           updated_at = CURRENT_TIMESTAMP
       RETURNING user_id, display_name, about_user, global_instructions, preferences, created_at, updated_at`,
      [userId, displayName, aboutUser, globalInstructions, JSON.stringify(preferences || {})]
    );
    return result.rows[0];
  },

  /**
   * Update full profile fields directly
   * @param {number} userId 
   * @param {Object} fields 
   * @returns {Promise<Object>}
   */
  async update(userId, { displayName, aboutUser, globalInstructions, preferences }) {
    const existing = (await this.getByUserId(userId)) || {};
    const finalDisplayName = displayName !== undefined ? displayName : (existing.display_name || null);
    const finalAboutUser = aboutUser !== undefined ? aboutUser : (existing.about_user || null);
    const finalGlobalInstructions = globalInstructions !== undefined ? globalInstructions : (existing.global_instructions || null);
    const finalPreferences = preferences !== undefined ? preferences : (existing.preferences || {});

    const result = await db.query(
      `INSERT INTO user_profiles (user_id, display_name, about_user, global_instructions, preferences, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           about_user = EXCLUDED.about_user,
           global_instructions = EXCLUDED.global_instructions,
           preferences = EXCLUDED.preferences,
           updated_at = CURRENT_TIMESTAMP
       RETURNING user_id, display_name, about_user, global_instructions, preferences, created_at, updated_at`,
      [userId, finalDisplayName, finalAboutUser, finalGlobalInstructions, JSON.stringify(finalPreferences)]
    );
    return result.rows[0];
  }
};

module.exports = userProfileModel;
