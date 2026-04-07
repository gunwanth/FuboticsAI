const axios = require("axios");
const { spawn } = require("child_process");
const path = require("path");
const { listProjectFiles, searchCodebase, readProjectFile, PROJECT_ROOT } = require("./codeToolsService");

const SERENA_ENABLED = String(process.env.SERENA_ENABLED || "true").toLowerCase() !== "false";
const SERENA_MCP_URL = String(process.env.SERENA_MCP_URL || "").trim().replace(/\/+$/, "");
const SERENA_MCP_TIMEOUT_MS = Math.min(
  120000,
  Math.max(3000, Number.parseInt(process.env.SERENA_MCP_TIMEOUT_MS || "30000", 10))
);
const SERENA_MCP_COMMAND = String(process.env.SERENA_MCP_COMMAND || "uv").trim();
const SERENA_MCP_CONTEXT = String(process.env.SERENA_MCP_CONTEXT || "ide-assistant").trim() || "ide-assistant";
const SERENA_MCP_CACHE_DIR = String(
  process.env.SERENA_MCP_CACHE_DIR || process.env.UV_CACHE_DIR || path.join(PROJECT_ROOT, ".uv-cache")
).trim();
const SERENA_MCP_LINK_MODE = String(process.env.SERENA_MCP_LINK_MODE || process.env.UV_LINK_MODE || "copy").trim() || "copy";

function parseSerenaArgs() {
  const raw = String(process.env.SERENA_MCP_ARGS_JSON || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch (_) {
      // ignore and fall back
    }
  }

  return [
    "tool",
    "run",
    "--from",
    "git+https://github.com/oraios/serena",
    "serena",
    "start-mcp-server",
    "--project-from-cwd",
    "--context",
    SERENA_MCP_CONTEXT,
  ];
}

const SERENA_MCP_ARGS = parseSerenaArgs();

let serenaHttpDisabledUntil = 0;
let serenaHttpWarnedAt = 0;
let serenaClientPromise = null;
let serenaToolsPromise = null;
let lastSerenaTransportLog = "";

function noteSerenaTransport(mode, detail = "") {
  const next = `${mode}:${detail}`;
  if (next === lastSerenaTransportLog) return;
  lastSerenaTransportLog = next;
  console.info(`[Serena MCP] transport=${mode}${detail ? ` ${detail}` : ""}`);
}

function shouldTrySerenaHttp() {
  return !!SERENA_MCP_URL && Date.now() >= serenaHttpDisabledUntil;
}

function markSerenaHttpUnavailable(err) {
  serenaHttpDisabledUntil = Date.now() + 60_000;
  if (Date.now() - serenaHttpWarnedAt > 30_000) {
    serenaHttpWarnedAt = Date.now();
    console.warn("[Serena MCP] HTTP bridge unavailable, falling back to stdio/local:", err?.message || err);
  }
}

function createSerenaStdioClient() {
  const child = spawn(SERENA_MCP_COMMAND, SERENA_MCP_ARGS, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      UV_CACHE_DIR: SERENA_MCP_CACHE_DIR,
      UV_LINK_MODE: SERENA_MCP_LINK_MODE,
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  let closed = false;

  const cleanupPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  const handleMessage = (message) => {
    const id = message?.id;
    if (id == null || !pending.has(id)) return;
    const { resolve, reject, timer } = pending.get(id);
    clearTimeout(timer);
    pending.delete(id);
    if (message.error) {
      reject(new Error(message.error?.message || "Serena MCP error"));
      return;
    }
    resolve(message.result);
  };

  const processStdout = () => {
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          handleMessage(JSON.parse(line));
        } catch (err) {
          console.error("[Serena MCP] Failed to parse MCP response:", err?.message || err);
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  };

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk || "");
    processStdout();
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (text) {
      console.warn("[Serena MCP]", text);
    }
  });

  child.on("error", (err) => {
    closed = true;
    serenaClientPromise = null;
    serenaToolsPromise = null;
    cleanupPending(err);
  });

  child.on("exit", (code, signal) => {
    closed = true;
    serenaClientPromise = null;
    serenaToolsPromise = null;
    cleanupPending(new Error(`Serena MCP exited (${code ?? "null"}${signal ? `, signal ${signal}` : ""})`));
  });

  const sendRequest = (method, params) =>
    new Promise((resolve, reject) => {
      if (closed || !child.stdin.writable) {
        reject(new Error("Serena MCP server is not running."));
        return;
      }

      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Serena MCP request timed out for ${method}`));
      }, SERENA_MCP_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${payload}\n`, "utf8", (err) => {
        if (!err) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      });
    });

  return {
    async initialize() {
      await sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "fubotics-chat-backend-serena", version: "1.0.0" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`, "utf8");
      return this;
    },
    async listTools() {
      noteSerenaTransport("stdio", `command=${SERENA_MCP_COMMAND}`);
      const result = await sendRequest("tools/list", {});
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    async callTool(name, args) {
      noteSerenaTransport("stdio", `command=${SERENA_MCP_COMMAND}`);
      console.info(`[Serena MCP] stdio tool call name=${name}`);
      const result = await sendRequest("tools/call", { name, arguments: args });
      const textParts = Array.isArray(result?.content)
        ? result.content.filter((item) => item?.type === "text").map((item) => String(item.text || ""))
        : [];
      const text = textParts.join("\n").trim();
      if (!text) return result;
      try {
        return JSON.parse(text);
      } catch (_) {
        return text;
      }
    },
  };
}

async function callSerenaHttp(name, args) {
  noteSerenaTransport("http", `url=${SERENA_MCP_URL}`);
  console.info(`[Serena MCP] HTTP tool call name=${name}`);
  const response = await axios.post(
    `${SERENA_MCP_URL}/tools/call`,
    { name, arguments: args },
    {
      timeout: SERENA_MCP_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Serena MCP HTTP call failed (${response.status}): ${response.data?.error || response.statusText || "request error"}`);
  }

  serenaHttpDisabledUntil = 0;
  return response.data?.data;
}

async function listSerenaHttpTools() {
  noteSerenaTransport("http", `url=${SERENA_MCP_URL}`);
  const response = await axios.get(`${SERENA_MCP_URL}/tools`, {
    timeout: SERENA_MCP_TIMEOUT_MS,
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Serena MCP HTTP tools list failed (${response.status}): ${response.data?.error || response.statusText || "request error"}`);
  }

  return Array.isArray(response.data?.tools) ? response.data.tools : Array.isArray(response.data?.data?.tools) ? response.data.data.tools : [];
}

async function getSerenaClient() {
  if (!SERENA_ENABLED) {
    throw new Error("Serena is disabled.");
  }

  if (shouldTrySerenaHttp()) {
    return {
      async listTools() {
        try {
          return await listSerenaHttpTools();
        } catch (err) {
          markSerenaHttpUnavailable(err);
          const stdioClient = await getSerenaStdioClient();
          return await stdioClient.listTools();
        }
      },
      async callTool(name, args) {
        try {
          return await callSerenaHttp(name, args);
        } catch (err) {
          markSerenaHttpUnavailable(err);
          const stdioClient = await getSerenaStdioClient();
          return await stdioClient.callTool(name, args);
        }
      },
    };
  }

  return await getSerenaStdioClient();
}

async function getSerenaStdioClient() {
  if (!serenaClientPromise) {
    serenaClientPromise = createSerenaStdioClient()
      .initialize()
      .catch((err) => {
        serenaClientPromise = null;
        serenaToolsPromise = null;
        throw err;
      });
  }
  return serenaClientPromise;
}

async function getSerenaTools() {
  if (!SERENA_ENABLED) return [];
  if (!serenaToolsPromise) {
    serenaToolsPromise = (async () => {
      const client = await getSerenaClient();
      return await client.listTools();
    })().catch((err) => {
      serenaToolsPromise = null;
      throw err;
    });
  }
  return await serenaToolsPromise;
}

function isSerenaCodeTool(name) {
  return name === "search_codebase" || name === "read_project_file" || name === "list_project_files";
}

function pickTool(tools, candidates) {
  const lowerMap = new Map(tools.map((tool) => [String(tool?.name || "").toLowerCase(), tool]));
  for (const candidate of candidates) {
    const found = lowerMap.get(candidate.toLowerCase());
    if (found) return found;
  }
  return null;
}

function getSchemaProperties(tool) {
  const properties = tool?.inputSchema?.properties;
  return properties && typeof properties === "object" ? properties : {};
}

function setIfPresent(target, properties, names, value) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(properties, name)) {
      target[name] = value;
      return true;
    }
  }
  return false;
}

function buildListArgs(tool, args) {
  const properties = getSchemaProperties(tool);
  const payload = {};
  const query = String(args.query || "").trim();

  if (String(tool?.name || "") === "find_file") {
    setIfPresent(payload, properties, ["file_mask", "pattern", "query", "name"], query || "*");
    if (query && /[\\/]/.test(query)) {
      setIfPresent(payload, properties, ["relative_path", "path", "directory", "dir_path"], path.dirname(query).replace(/\\/g, "/"));
      setIfPresent(payload, properties, ["file_mask", "pattern", "query", "name"], path.basename(query));
    }
  } else {
    if (!setIfPresent(payload, properties, ["relative_path", "path", "directory", "dir_path"], ".")) {
      setIfPresent(payload, properties, ["root", "base_path"], ".");
    }
    if (query) {
      setIfPresent(payload, properties, ["pattern", "query", "file_mask", "glob", "name"], query);
    }
  }

  setIfPresent(payload, properties, ["recursive", "recurse"], true);
  setIfPresent(payload, properties, ["max_results", "limit"], Math.max(1, Math.min(200, Number.parseInt(args.limit, 10) || 120)));
  setIfPresent(payload, properties, ["max_answer_chars"], 6000);
  return payload;
}

function buildSearchArgs(tool, args) {
  const properties = getSchemaProperties(tool);
  const payload = {};
  const query = String(args.query || "").trim();
  const fileHint = String(args.fileHint || "").trim();
  if (!setIfPresent(payload, properties, ["substring_pattern", "pattern", "query", "symbol_name", "name", "search_term"], query)) {
    payload.query = query;
  }
  if (fileHint) {
    if (Object.prototype.hasOwnProperty.call(properties, "paths_include_glob")) {
      payload.paths_include_glob = fileHint.includes("*") ? fileHint : `*${fileHint}*`;
    } else {
      setIfPresent(payload, properties, ["relative_path", "path", "file_path", "glob", "file_mask"], fileHint);
    }
  }
  setIfPresent(payload, properties, ["context_lines_before"], 1);
  setIfPresent(payload, properties, ["context_lines_after"], 1);
  setIfPresent(payload, properties, ["restrict_search_to_code_files"], true);
  setIfPresent(payload, properties, ["substring_matching", "partial_match"], true);
  setIfPresent(payload, properties, ["max_answer_chars"], 6000);
  setIfPresent(payload, properties, ["max_results", "limit"], Math.max(1, Math.min(20, Number.parseInt(args.limit, 10) || 20)));
  return payload;
}

function buildReadArgs(tool, args) {
  const properties = getSchemaProperties(tool);
  const payload = {};
  const pathValue = String(args.path || "").trim();
  setIfPresent(payload, properties, ["relative_path", "path", "file_path", "file", "filename"], pathValue);
  setIfPresent(payload, properties, ["start_line", "startLine", "from_line"], Math.max(1, Number.parseInt(args.startLine, 10) || 1));
  setIfPresent(payload, properties, ["end_line", "endLine", "to_line"], Math.max(1, Number.parseInt(args.endLine, 10) || ((Number.parseInt(args.startLine, 10) || 1) + 119)));
  return payload;
}

function ensureSerenaToolSucceeded(raw, toolName) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.startsWith("Error executing tool:")) {
    throw new Error(`${toolName} failed: ${text}`);
  }
  if (raw && typeof raw === "object" && raw.error) {
    throw new Error(`${toolName} failed: ${raw.error}`);
  }
  return raw;
}

function normalizeListResult(raw) {
  if (Array.isArray(raw?.files)) return raw;
  if (typeof raw === "string") {
    const files = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[-*]\s*/, ""))
      .slice(0, 120)
      .map((line) => ({ path: line }));
    return { files };
  }
  if (Array.isArray(raw)) {
    return { files: raw.map((item) => (typeof item === "string" ? { path: item } : item)).slice(0, 120) };
  }
  return { files: [] };
}

function normalizeSearchResult(raw) {
  if (Array.isArray(raw?.matches)) return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const matches = [];
    for (const [filePath, snippets] of Object.entries(raw)) {
      if (!Array.isArray(snippets)) continue;
      for (const snippet of snippets) {
        const text = String(snippet || "").trim();
        const lineMatch = />(\d+):/.exec(text);
        matches.push({
          path: String(filePath || "serena").replace(/\\/g, "/"),
          line: lineMatch ? Number.parseInt(lineMatch[1], 10) || 1 : 1,
          snippet: text.slice(0, 500),
        });
      }
    }
    return { matches: matches.slice(0, 20) };
  }
  if (typeof raw === "string") {
    const matches = raw
      .split(/\r?\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((block) => {
        const [firstLine, ...rest] = block.split(/\r?\n/);
        const pathLineMatch = /^(.+?):(\d+)\s*(.*)$/.exec(firstLine || "");
        if (pathLineMatch) {
          return {
            path: pathLineMatch[1],
            line: Number.parseInt(pathLineMatch[2], 10) || 1,
            snippet: [pathLineMatch[3], ...rest].join(" ").trim(),
          };
        }
        return { path: "serena", line: 1, snippet: block };
      });
    return { matches };
  }
  return { matches: [] };
}

function normalizeReadResult(raw, args) {
  if (typeof raw === "string") {
    return {
      path: String(args.path || ""),
      startLine: Math.max(1, Number.parseInt(args.startLine, 10) || 1),
      endLine: Math.max(1, Number.parseInt(args.endLine, 10) || ((Number.parseInt(args.startLine, 10) || 1) + 119)),
      content: raw,
    };
  }
  if (raw && typeof raw === "object" && typeof raw.content === "string") {
    return raw;
  }
  return {
    path: String(args.path || ""),
    content: JSON.stringify(raw || {}, null, 2),
  };
}

function formatGenericDisplay(name, raw) {
  if (name === "list_project_files") {
    const files = Array.isArray(raw?.files) ? raw.files : [];
    return files.length > 0 ? files.map((item) => item.path || JSON.stringify(item)).join("\n") : "No matching project files found.";
  }
  if (name === "search_codebase") {
    const matches = Array.isArray(raw?.matches) ? raw.matches : [];
    return matches.length > 0
      ? matches.map((item) => `${item.path}:${item.line}\n${item.snippet || ""}`.trim()).join("\n\n")
      : "No matching code results found.";
  }
  if (name === "read_project_file") {
    return raw?.content || "No file content returned.";
  }
  return typeof raw === "string" ? raw : JSON.stringify(raw || {});
}

async function executeSerenaCodeTool(name, args = {}) {
  if (!SERENA_ENABLED || !isSerenaCodeTool(name)) return null;

  let tools;
  try {
    tools = await getSerenaTools();
  } catch (err) {
    throw new Error(`Serena MCP unavailable: ${err?.message || err}`);
  }

  if (!Array.isArray(tools) || tools.length === 0) {
    console.warn("[Serena MCP] No tools reported by Serena for current project/context.");
    return null;
  }
  const client = await getSerenaClient();

  if (name === "list_project_files") {
    const tool = pickTool(tools, ["find_file", "list_dir", "list_files"]);
    if (!tool) return null;
    const raw = ensureSerenaToolSucceeded(await client.callTool(tool.name, buildListArgs(tool, args)), tool.name);
    console.info(`[Serena MCP] ${name} mapped to Serena tool ${tool.name} .`.replace(' .', '.'));
    const normalized = normalizeListResult(raw);
    return { raw: normalized, display: formatGenericDisplay(name, normalized), toolName: tool.name };
  }

  if (name === "search_codebase") {
    const tool = pickTool(tools, ["search_for_pattern", "find_symbol", "get_symbols_overview", "find_referencing_symbols"]);
    if (!tool) return null;
    const raw = ensureSerenaToolSucceeded(await client.callTool(tool.name, buildSearchArgs(tool, args)), tool.name);
    console.info(`[Serena MCP] ${name} mapped to Serena tool ${tool.name} .`.replace(' .', '.'));
    const normalized = normalizeSearchResult(raw);
    return { raw: normalized, display: formatGenericDisplay(name, normalized), toolName: tool.name };
  }

  if (name === "read_project_file") {
    const tool = pickTool(tools, ["read_file", "get_file_contents"]);
    if (!tool) return null;
    const raw = ensureSerenaToolSucceeded(await client.callTool(tool.name, buildReadArgs(tool, args)), tool.name);
    console.info(`[Serena MCP] ${name} mapped to Serena tool ${tool.name} .`.replace(' .', '.'));
    const normalized = normalizeReadResult(raw, args);
    return { raw: normalized, display: formatGenericDisplay(name, normalized), toolName: tool.name };
  }

  return null;
}

async function executeCodeToolWithFallback(name, args = {}, options = {}) {
  if (!isSerenaCodeTool(name)) {
    throw new Error(`Unsupported code tool: ${name}`);
  }

  try {
    const serenaResult = await executeSerenaCodeTool(name, args);
    if (serenaResult) {
      console.info(`[Serena MCP] ${name} executed via Serena (${serenaResult.toolName || "mapped-tool"}).`);
      return { ...serenaResult, via: "serena" };
    }
  } catch (err) {
    console.warn(`[Serena MCP] Falling back to local ${name}:`, err?.message || err);
  }

  if (name === "list_project_files") {
    const raw = await listProjectFiles(args);
    console.info(`[Serena MCP] ${name} executed via local fallback${requestedByAgent ? ` requestedBy=${requestedByAgent}` : ""}.`);
    return { raw, display: formatGenericDisplay(name, raw), via: "local" };
  }
  if (name === "search_codebase") {
    const raw = await searchCodebase(args);
    console.info(`[Serena MCP] ${name} executed via local fallback.`);
    return { raw, display: formatGenericDisplay(name, raw), via: "local" };
  }
  if (name === "read_project_file") {
    const raw = await readProjectFile(args);
    console.info(`[Serena MCP] ${name} executed via local fallback.`);
    return { raw, display: formatGenericDisplay(name, raw), via: "local" };
  }

  throw new Error(`Unsupported code tool: ${name}`);
}

module.exports = {
  SERENA_ENABLED,
  isSerenaCodeTool,
  getSerenaClient,
  getSerenaTools,
  executeSerenaCodeTool,
  executeCodeToolWithFallback,
};










