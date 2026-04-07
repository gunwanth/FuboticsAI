require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const db = require("../db");
const { TOOL_DEFS, TOOL_HANDLERS } = require("./toolRuntime");

const SERVER_INFO = {
  name: "fubotics-dino-mcp",
  version: "1.0.0",
};

let inputBuffer = Buffer.alloc(0);

function writeMessage(message) {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  process.stdout.write(Buffer.concat([header, payload]));
}

function writeResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id, code, message, data = null) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  });
}

async function handleRequest(request) {
  const { id, method, params } = request || {};

  try {
    if (method === "initialize") {
      return writeResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      });
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "ping") {
      return writeResult(id, {});
    }

    if (method === "tools/list") {
      return writeResult(id, { tools: TOOL_DEFS });
    }

    if (method === "tools/call") {
      const name = String(params?.name || "").trim();
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        return writeError(id, -32601, `Unknown tool: ${name}`);
      }

      const data = await handler(args);
      return writeResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      });
    }

    return writeError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    return writeError(id, -32000, err?.message || "Unhandled MCP server error");
  }
}

function processInputBuffer() {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const headerText = inputBuffer.slice(0, headerEnd).toString("utf8");
    const headers = headerText.split("\r\n");
    let contentLength = 0;
    for (const line of headers) {
      const match = /^Content-Length:\s*(\d+)$/i.exec(line.trim());
      if (match) {
        contentLength = Number.parseInt(match[1], 10);
        break;
      }
    }

    const totalLength = headerEnd + 4 + contentLength;
    if (!contentLength || inputBuffer.length < totalLength) return;

    const body = inputBuffer.slice(headerEnd + 4, totalLength).toString("utf8");
    inputBuffer = inputBuffer.slice(totalLength);

    let message;
    try {
      message = JSON.parse(body);
    } catch (err) {
      writeError(null, -32700, "Parse error");
      continue;
    }

    void handleRequest(message);
  }
}

async function main() {
  await db.initializeDatabase();
  process.stdin.on("data", (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
    processInputBuffer();
  });
  process.stdin.on("error", (err) => {
    console.error("[MCP] stdin error:", err?.message || err);
  });
}

main().catch((err) => {
  console.error("[MCP] failed to start:", err?.message || err);
  process.exit(1);
});
