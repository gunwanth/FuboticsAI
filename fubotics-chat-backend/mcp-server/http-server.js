require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const db = require("../db");
const { TOOL_DEFS, TOOL_HANDLERS } = require("./toolRuntime");

const PORT = Math.max(
  1,
  Number.parseInt(process.env.PORT || process.env.MCP_HTTP_PORT || "5051", 10)
);
const HOST = process.env.MCP_HTTP_HOST || "0.0.0.0";

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += Buffer.from(chunk).toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleToolCall(req, res) {
  const payload = await readJsonBody(req);
  const name = String(payload?.name || "").trim();
  const args = payload?.arguments && typeof payload.arguments === "object" ? payload.arguments : {};
  const handler = TOOL_HANDLERS[name];

  if (!handler) {
    return sendJson(res, 404, { error: `Unknown tool: ${name}` });
  }

  const data = await handler(args);
  return sendJson(res, 200, { ok: true, name, data });
}

async function main() {
  await db.initializeDatabase();

  const server = http.createServer(async (req, res) => {
    try {
      const method = String(req.method || "GET").toUpperCase();
      const url = String(req.url || "/");

      if (method === "GET" && url === "/health") {
        return sendJson(res, 200, { ok: true, service: "fubotics-dino-mcp-http" });
      }

      if (method === "GET" && url === "/tools") {
        return sendJson(res, 200, { ok: true, tools: TOOL_DEFS });
      }

      if (method === "POST" && url === "/tools/call") {
        return await handleToolCall(req, res);
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      return sendJson(res, 500, { error: err?.message || "Internal server error" });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[Dino MCP HTTP] listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[Dino MCP HTTP] failed to start:", err?.message || err);
  process.exit(1);
});
