const axios = require("axios");
const db = require("../db");

const BASE = "http://127.0.0.1:5001";
const username = "__semstate_mb_" + Math.floor(Math.random() * 100000);

(async () => {
  const log = (...a) => console.log("[MB]", ...a);
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

    // Dino agent-mode WITHOUT deepSearch: exercises runDinoAgentLoop meta-bridge injection + feedback loop
    const msg = await axios.post(
      `${BASE}/api/messages`,
      {
        sessionId,
        content: "Explain what a knowledge graph is in one paragraph.",
        deepSearch: false,
        model: "dino",
        agentMode: true,
        thinking: false,
      },
      { headers, timeout: 240000 }
    );
    const messages = msg.data.messages || [];
    const assistant = messages.filter((m) => m.role === "assistant").pop();
    log("assistant reply chars:", (assistant?.content || "").length);

    const nodes = await db.query(`SELECT kind, count(*) FROM state_nodes WHERE user_id = $1 GROUP BY kind`, [userId]);
    log("state_nodes:", JSON.stringify(nodes.rows));
    const agentState = await db.query(
      `SELECT agent_id, turn_count, meta_bridge IS NOT NULL AS has_bridge FROM agent_state WHERE user_id = $1`,
      [userId]
    );
    log("agent_state:", JSON.stringify(agentState.rows));
    const trav = await db.query(`SELECT outcome FROM state_traversals WHERE user_id = $1`, [userId]);
    log("state_traversals:", JSON.stringify(trav.rows));

    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    log("COMPLETE");
  } catch (e) {
    log("FAIL:", e.response?.status, e.response?.data?.error || e.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
