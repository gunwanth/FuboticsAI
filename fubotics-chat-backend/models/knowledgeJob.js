const db = require("../db");

const knowledgeJobModel = {
  async create(sourceId, jobType, status = "queued", errorMessage = null) {
    const result = await db.query(
      `INSERT INTO knowledge_jobs (source_id, job_type, status, error_message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, source_id, job_type, status, error_message, created_at, updated_at`,
      [sourceId, jobType, status, errorMessage]
    );
    return result.rows[0];
  },

  async updateStatus(jobId, status, errorMessage = null) {
    const result = await db.query(
      `UPDATE knowledge_jobs
       SET status = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, source_id, job_type, status, error_message, created_at, updated_at`,
      [jobId, status, errorMessage]
    );
    return result.rows[0] || null;
  },
};

module.exports = knowledgeJobModel;
