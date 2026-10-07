const db = require("../db");

(async () => {
  // kinds + session combination (autoLinkConcepts / meta-bridge refresh)
  const userId = 1;
  const sessionId = 144;
  const kinds = ["concept", "entity"];
  const limit = 12;
  const candidateCap = Math.max(40, limit * 5);

  const params = [userId, kinds, sessionId, candidateCap];
  const sql = `
    SELECT id FROM state_nodes
    WHERE user_id = $1
      AND kind = ANY($2::text[])
      AND (session_id = $3 OR session_id IS NULL)
    ORDER BY last_seen_at DESC
    LIMIT $4`;
  console.log("SQL:", sql);
  try {
    const r = await db.query(sql, params);
    console.log("OK rows:", r.rows.length);
  } catch (e) {
    console.log("ERR:", e.message);
  }
  await db.pool.end();
})();
