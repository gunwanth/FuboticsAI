const express = require("express");
process.env.SERENA_HTTP_BRIDGE_INTERNAL = process.env.SERENA_HTTP_BRIDGE_INTERNAL || "1";
process.env.SERENA_MCP_URL = "";
const {
  SERENA_ENABLED,
  getSerenaClient,
  getSerenaTools,
} = require("./services/serenaConnector");

const app = express();
const HOST = process.env.SERENA_HTTP_BRIDGE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.SERENA_HTTP_BRIDGE_PORT || "9121", 10);

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  console.log("[Serena HTTP Bridge] Incoming " + req.method + " " + req.path);
  next();
});

app.get("/health", async (req, res) => {
  try {
    const tools = SERENA_ENABLED ? await getSerenaTools() : [];
    console.log("[Serena HTTP Bridge] Health check ok. tools=" + (Array.isArray(tools) ? tools.length : 0));
    res.json({
      ok: true,
      service: "serena-http-bridge",
      serenaEnabled: SERENA_ENABLED,
      toolCount: Array.isArray(tools) ? tools.length : 0,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      service: "serena-http-bridge",
      error: err?.message || String(err),
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/tools", async (req, res) => {
  try {
    const tools = await getSerenaTools();
    console.log("[Serena HTTP Bridge] Listed tools. count=" + (Array.isArray(tools) ? tools.length : 0));
    res.json({ tools: Array.isArray(tools) ? tools : [] });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to list Serena tools" });
  }
});

app.post("/tools/call", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const args = req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {};
    if (!name) {
      return res.status(400).json({ error: "Tool name is required" });
    }

    console.log("[Serena HTTP Bridge] Tool request name=" + name);
    const client = await getSerenaClient();
    const data = await client.callTool(name, args);
    console.log("[Serena HTTP Bridge] Tool request completed name=" + name);
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to call Serena tool" });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[Serena HTTP Bridge] listening at http://${HOST}:${PORT}`);
});
