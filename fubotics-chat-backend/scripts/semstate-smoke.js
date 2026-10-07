const db = require("../db");
const g = require("../services/semanticStateGraphService");

(async () => {
  const log = (...a) => console.log("[SMOKE]", ...a);
  const u = await db.query("INSERT INTO users (username, password_hash) VALUES ('__semstate_smoke_' || floor(random()*100000)::int, 'x') RETURNING id");
  const userId = u.rows[0].id;
  log("user", userId);
  const s = await db.query("INSERT INTO chat_sessions (user_id, session_number) VALUES ($1, 1) RETURNING id", [userId]);
  const sessionId = s.rows[0].id;
  log("session", sessionId);

  try {
    const mb = await g.buildMetaBridge(userId, sessionId, "dino_agent", {
      task: "semantic state network architecture review",
      sessionHistory: [{ role: "user", content: "review the architecture" }],
    });
    log("meta-bridge chars:", mb.metaBridge ? mb.metaBridge.length : 0, "links:", mb.refreshedLinks, "agentNode:", mb.agentNodeId);

    const insight = await g.recordInsight(userId, sessionId, {
      sourceId: 999999,
      agentId: "dino_agent",
      tags: ["rag", "semantic"],
      content: "The semantic state network uses bounded neighborhood traversal with cosine similarity and quality feedback.",
      title: "Bounded traversal insight",
    });
    log("insight:", JSON.stringify(insight));

    const nb = await g.findSemanticNeighborhood(userId, sessionId, { query: "semantic state network", agentId: "dino_agent" });
    log("neighborhood nodes:", nb.nodes.length, "edges:", nb.edges.length, "ctxChars:", nb.context.length);
    log("node kinds:", nb.nodes.map((n) => n.kind).join(","));

    const fb = await g.runCognitiveFeedbackLoop(userId, sessionId, {
      agentId: "dino_agent",
      query: "semantic state network",
      neighborhood: nb,
      replyText: "Here is a substantive answer citing sources at https://example.com and RAG [1].",
      citationCount: 2,
    });
    log("feedback:", JSON.stringify(fb));

    const counts = await db.query("SELECT kind, count(*) FROM state_nodes WHERE user_id = $1 GROUP BY kind", [userId]);
    log("node counts:", JSON.stringify(counts.rows));
    const edges = await db.query("SELECT relation, count(*) FROM state_edges WHERE user_id = $1 GROUP BY relation", [userId]);
    log("edge counts:", JSON.stringify(edges.rows));
    const trav = await db.query("SELECT outcome, evidence_used FROM state_traversals WHERE user_id = $1", [userId]);
    log("traversals:", JSON.stringify(trav.rows));

    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    log("COMPLETE");
  } catch (e) {
    log("FAIL:", e.message);
    await db.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
