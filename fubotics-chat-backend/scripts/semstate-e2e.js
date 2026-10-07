const axios = require("axios");
const db = require("../db");

const BASE = "http://127.0.0.1:5001";
const username = "__semstate_e2e2_" + Math.floor(Math.random() * 100000);

(async () => {
  const log = (...a) => console.log("[E2E2]", ...a);
  try {
    const signup = await axios.post(`${BASE}/api/signup`, {
      username,
      password: "TestPassword1!",
      email: `${username}@test.dev`,
    });
    const token = signup.data.accessToken;
    const headers = { Authorization: `Bearer ${token}` };
    const userId = signup.data.user.id;
    const sess = await axios.post(`${BASE}/api/sessions`, {}, { headers });
    const sessionId = sess.data.session?.id || sess.data.id;
    log("user:", userId, "session:", sessionId);

    const msg = await axios.post(
      `${BASE}/api/messages`,
      {
        sessionId,
        content: "latest developments in AI agents 2026",
        deepSearch: true,
        model: "dino",
        agentMode: false,
        thinking: false,
      },
      { headers, timeout: 300000 }
    );
    const messages = msg.data.messages || [];
    const assistant = messages.find((m) => m.role === "assistant");
    log("assistant reply preview:", (assistant?.content || "").slice(0, 120).replace(/\s+/g, " "));

    // Check knowledge_sources — did indexWebSourcesForRag write anything?
    const ks = await db.query(
      `SELECT source_type, title, source_url FROM knowledge_sources WHERE user_id = $1 LIMIT 5`,
      [userId]
    );
    log("knowledge_sources:", JSON.stringify(ks.rows));

    const nodes = await db.query(`SELECT kind, count(*) FROM state_nodes WHERE user_id = $1 GROUP BY kind`, [userId]);
    log("state_nodes:", JSON.stringify(nodes.rows));

    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    log("COMPLETE");
  } catch (e) {
    log("FAIL:", e.response?.status, e.response?.data?.error || e.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
