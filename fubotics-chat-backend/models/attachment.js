const db = require("../db");

const attachmentModel = {
  /**
   * Create a new attachment
   * @param {number} sessionId 
   * @param {string} filename 
   * @param {string} originalFilename 
   * @param {string} filePath 
   * @param {string} fileType 
   * @param {number} fileSize 
   * @param {string} analysisResult 
   * @param {boolean} isGenerated 
   * @returns {Promise<Object>} Created attachment
   */
  async create(sessionId, filename, originalFilename, filePath, fileType, fileSize, analysisResult = null, isGenerated = false) {
    const result = await db.query(
      `INSERT INTO attachments (session_id, filename, original_filename, file_path, file_type, file_size, analysis_result, is_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING id, session_id, filename, original_filename, file_path, file_type, file_size, analysis_result, is_generated, created_at`,
      [sessionId, filename, originalFilename, filePath, fileType, fileSize, analysisResult, isGenerated]
    );
    return result.rows[0];
  },

  /**
   * Get attachments by session ID
   * @param {number} sessionId 
   * @returns {Promise<Array>} Array of attachments
   */
  async getBySessionId(sessionId) {
    const result = await db.query(
      `SELECT id, session_id, filename, original_filename, file_type, file_size, analysis_result, is_generated, created_at
       FROM attachments 
       WHERE session_id = $1 
       ORDER BY created_at DESC`,
      [sessionId]
    );
    return result.rows;
  },

  /**
   * Get all attachments belonging to a user across all sessions
   * @param {number} userId
   * @returns {Promise<Array>} Array of attachments
   */
  async getByUserId(userId) {
    const result = await db.query(
      `SELECT a.id, a.session_id, a.filename, a.original_filename, a.file_type, a.file_size, a.analysis_result, a.is_generated, a.created_at
       FROM attachments a
       JOIN chat_sessions cs ON cs.id = a.session_id
       WHERE cs.user_id = $1
       ORDER BY a.created_at DESC`,
      [userId]
    );
    return result.rows;
  },

  /**
   * Get attachment file paths for cleanup operations.
   * @param {number} sessionId
   * @returns {Promise<Array>} Array with id and file_path
   */
  async getFilePathsBySessionId(sessionId) {
    const result = await db.query(
      `SELECT id, file_path
       FROM attachments
       WHERE session_id = $1`,
      [sessionId]
    );
    return result.rows;
  },

  /**
   * Get attachment by ID
   * @param {number} attachmentId 
   * @returns {Promise<Object|null>} Attachment or null
   */
  async getById(attachmentId) {
    const result = await db.query(
      `SELECT id, session_id, filename, original_filename, file_path, file_type, file_size, analysis_result, is_generated, created_at
       FROM attachments WHERE id = $1`,
      [attachmentId]
    );
    return result.rows[0] || null;
  },

  /**
   * Update attachment analysis result.
   * @param {number} attachmentId
   * @param {string} analysisResult
   * @returns {Promise<Object|null>} Updated attachment or null
   */
  async updateAnalysisResult(attachmentId, analysisResult) {
    const result = await db.query(
      `UPDATE attachments
       SET analysis_result = $2
       WHERE id = $1
       RETURNING id, session_id, filename, original_filename, file_path, file_type, file_size, analysis_result, is_generated, created_at`,
      [attachmentId, analysisResult]
    );
    return result.rows[0] || null;
  },

  /**
   * Delete attachment by ID
   * @param {number} attachmentId 
   * @returns {Promise<boolean>} True if deleted
   */
  async delete(attachmentId) {
    const result = await db.query(
      "DELETE FROM attachments WHERE id = $1 RETURNING id",
      [attachmentId]
    );
    return result.rowCount > 0;
  },

  /**
   * Delete all attachments in a session
   * @param {number} sessionId 
   * @returns {Promise<number>} Number of deleted attachments
   */
  async deleteBySessionId(sessionId) {
    const result = await db.query(
      "DELETE FROM attachments WHERE session_id = $1 RETURNING id",
      [sessionId]
    );
    return result.rowCount;
  },

  /**
   * Link a message to an attachment
   * @param {number} messageId 
   * @param {number} attachmentId 
   * @returns {Promise<Object>} Created link
   */
  async linkToMessage(messageId, attachmentId) {
    const result = await db.query(
      "INSERT INTO message_attachments (message_id, attachment_id) VALUES ($1, $2) RETURNING id, message_id, attachment_id",
      [messageId, attachmentId]
    );
    return result.rows[0];
  },

  /**
   * Get attachments by message ID
   * @param {number} messageId 
   * @returns {Promise<Array>} Array of attachments
   */
  async getByMessageId(messageId) {
    const result = await db.query(
      `SELECT a.id, a.session_id, a.filename, a.original_filename, a.file_type, a.file_size, a.is_generated, a.created_at
       FROM attachments a
       JOIN message_attachments ma ON a.id = ma.attachment_id
       WHERE ma.message_id = $1`,
      [messageId]
    );
    return result.rows;
  },

  /**
   * Get generated files for a session
   * @param {number} sessionId 
   * @returns {Promise<Array>} Array of generated attachments
   */
  async getGeneratedBySessionId(sessionId) {
    const result = await db.query(
      `SELECT id, session_id, filename, original_filename, file_type, file_size, is_generated, created_at
       FROM attachments 
       WHERE session_id = $1 AND is_generated = true
       ORDER BY created_at DESC`,
      [sessionId]
    );
    return result.rows;
  },

  /**
   * Get uploaded files for a session
   * @param {number} sessionId 
   * @returns {Promise<Array>} Array of uploaded attachments
   */
  async getUploadedBySessionId(sessionId) {
    const result = await db.query(
      `SELECT id, session_id, filename, original_filename, file_type, file_size, is_generated, created_at
       FROM attachments 
       WHERE session_id = $1 AND is_generated = false
       ORDER BY created_at DESC`,
      [sessionId]
    );
    return result.rows;
  }
};

module.exports = attachmentModel;
