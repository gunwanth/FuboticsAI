const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const axios = require("axios");
const cheerio = require("cheerio");
const knowledgeSourceModel = require("../models/knowledgeSource");
const knowledgeChunkModel = require("../models/knowledgeChunk");
const {
  buildRagContext,
  indexWebSourcesForRag,
} = require("../services/ragService");
const {
  MODEL_ANNOTATIONS,
  AGENT_ANNOTATIONS,
  classifyTokenBudget,
} = require("../config/modelAnnotations");

const USER_AGENT =
  process.env.MCP_WEB_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const SEARCH_TIMEOUT_MS = Math.min(
  30000,
  Math.max(3000, Number.parseInt(process.env.MCP_SEARCH_TIMEOUT_MS || "9000", 10))
);
const PAGE_TIMEOUT_MS = Math.min(
  30000,
  Math.max(3000, Number.parseInt(process.env.MCP_PAGE_TIMEOUT_MS || "8000", 10))
);
const PROJECT_ROOT = path.resolve(process.env.DINO_PROJECT_ROOT || path.join(__dirname, "..", ".."));
const MAX_SCAN_FILE_BYTES = Math.max(16 * 1024, Number.parseInt(process.env.MCP_MAX_SCAN_FILE_BYTES || "524288", 10));
const MAX_READ_FILE_BYTES = Math.max(16 * 1024, Number.parseInt(process.env.MCP_MAX_READ_FILE_BYTES || "262144", 10));
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "uploads",
  "attachments",
  "generated",
  "__pycache__",
  ".venv",
  "venv",
]);
const CODE_FILE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".md",
  ".sql",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".yml",
  ".yaml",
  ".env",
  ".sh",
  ".bat",
]);

function normalizePathForDisplay(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function resolveProjectPath(inputPath) {
  const relativeInput = String(inputPath || "").trim();
  if (!relativeInput) throw new Error("path is required");
  const resolved = path.resolve(PROJECT_ROOT, relativeInput);
  const normalizedRoot = path.resolve(PROJECT_ROOT) + path.sep;
  const normalizedResolved = path.resolve(resolved);
  if (normalizedResolved !== path.resolve(PROJECT_ROOT) && !normalizedResolved.startsWith(normalizedRoot)) {
    throw new Error("path must stay within the project root");
  }
  return normalizedResolved;
}

function collectProjectFiles(rootDir, limit = 2000) {
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0 && results.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= limit) break;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(absolute);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      results.push(absolute);
    }
  }

  return results;
}

function isLikelyCodeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (CODE_FILE_EXTENSIONS.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  return base === "dockerfile" || base.endsWith(".env") || base === "makefile";
}

function readUtf8IfReasonable(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("not a file");
  if (stat.size > maxBytes) {
    throw new Error(`file too large to inspect (${stat.size} bytes)`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function scoreTextMatch(haystack, needle) {
  const h = String(haystack || "").toLowerCase();
  const n = String(needle || "").toLowerCase();
  if (!n) return 0;
  if (h === n) return 200;
  if (h.includes(n)) return 80;
  const parts = n.split(/\s+/).filter(Boolean);
  return parts.reduce((score, part) => score + (h.includes(part) ? 20 : 0), 0);
}

function createStoredChunksFromContent(content, title, tags, metadata = {}) {
  return [
    {
      chunk_index: 0,
      content,
      token_count: String(content || "").split(/\s+/).filter(Boolean).length,
      metadata: {
        title,
        tags,
        ...metadata,
      },
    },
  ];
}

function normalizeUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return value;
  }
}

async function fetchPageSnippet(url) {
  const response = await axios.get(url, {
    timeout: PAGE_TIMEOUT_MS,
    headers: { "User-Agent": USER_AGENT },
    validateStatus: () => true,
    maxRedirects: 5,
  });
  if (response.status < 200 || response.status >= 300) return "";

  const html = String(response.data || "");
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const title =
    $("title").first().text().replace(/\s+/g, " ").trim() ||
    $("meta[property='og:title']").attr("content") ||
    "";
  const description =
    $("meta[name='description']").attr("content") ||
    $("meta[property='og:description']").attr("content") ||
    "";
  const headings = $("h1, h2, h3")
    .slice(0, 10)
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean);
  const listItems = $("article li, main li, li")
    .slice(0, 18)
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter((value) => value && value.length > 18);
  const paragraphs = $("article p, main p, p")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean);
  const sameHostLinks = $("a[href]")
    .slice(0, 80)
    .map((_, el) => {
      const href = normalizeUrl($(el).attr("href"));
      const text = $(el).text().replace(/\s+/g, " ").trim();
      return { href, text };
    })
    .get()
    .filter((item) => item.href && item.text)
    .slice(0, 8);

  const joined = [
    title ? `Title: ${title}` : "",
    description ? `Description: ${String(description).replace(/\s+/g, " ").trim()}` : "",
    headings.length > 0 ? `Headings: ${headings.join(" | ")}` : "",
    listItems.length > 0 ? `Key Points: ${listItems.join(" | ")}` : "",
    paragraphs.join(" "),
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    content: joined.slice(0, 2200),
    structure: {
      title,
      description: String(description || "").trim(),
      headings: headings.slice(0, 8),
      keyPoints: listItems.slice(0, 8),
      relatedLinks: sameHostLinks,
    },
  };
}

async function deepSearchWeb(query, maxResults = 5) {
  const q = String(query || "").trim();
  if (!q) return [];
  const prefersFreshNews =
    /(^|\b)(latest|recent|today|current|news|update|updates|breaking|release|launched|announced)(\b|$)/i.test(q);
  const lowSignalHosts = new Set([
    "zhihu.com",
    "www.zhihu.com",
    "quora.com",
    "www.quora.com",
    "pinterest.com",
    "www.pinterest.com",
    "facebook.com",
    "www.facebook.com",
    "instagram.com",
    "www.instagram.com",
    "tiktok.com",
    "www.tiktok.com",
  ]);

  const fetchBingRssResults = async () => {
    const rssResponse = await axios.get("https://www.bing.com/search", {
      params: { q, format: "rss" },
      timeout: SEARCH_TIMEOUT_MS,
      headers: { "User-Agent": USER_AGENT },
      validateStatus: () => true,
    });
    if (rssResponse.status < 200 || rssResponse.status >= 300) {
      return [];
    }
    const rss$ = cheerio.load(String(rssResponse.data || ""), { xmlMode: true });
    return rss$("item")
      .slice(0, Math.max(12, Math.max(1, Math.min(12, Number(maxResults) || 5)) * 4))
      .map((_, el) => ({
        title: rss$(el).find("title").first().text().replace(/\s+/g, " ").trim(),
        url: normalizeUrl(rss$(el).find("link").first().text().trim()),
        snippet: rss$(el).find("description").first().text().replace(/\s+/g, " ").trim(),
      }))
      .get()
      .filter((item) => item.title && item.url);
  };

  const fetchGoogleNewsRssResults = async () => {
    const rssResponse = await axios.get("https://news.google.com/rss/search", {
      params: {
        q,
        hl: "en-IN",
        gl: "IN",
        ceid: "IN:en",
      },
      timeout: SEARCH_TIMEOUT_MS,
      headers: { "User-Agent": USER_AGENT },
      validateStatus: () => true,
    });
    if (rssResponse.status < 200 || rssResponse.status >= 300) {
      return [];
    }
    const rss$ = cheerio.load(String(rssResponse.data || ""), { xmlMode: true });
    return rss$("item")
      .slice(0, Math.max(12, Math.max(1, Math.min(12, Number(maxResults) || 5)) * 4))
      .map((_, el) => ({
        title: rss$(el).find("title").first().text().replace(/\s+/g, " ").trim(),
        url: normalizeUrl(rss$(el).find("link").first().text().trim()),
        snippet: rss$(el).find("description").first().text().replace(/\s+/g, " ").trim(),
      }))
      .get()
      .filter((item) => item.title && item.url);
  };

  const searchResponse = await axios.get("https://html.duckduckgo.com/html/", {
    params: { q },
    timeout: SEARCH_TIMEOUT_MS,
    headers: { "User-Agent": USER_AGENT },
    validateStatus: () => true,
  });

  if (searchResponse.status < 200 || searchResponse.status >= 300) {
    throw new Error(`Web search failed (HTTP ${searchResponse.status})`);
  }

  const $ = cheerio.load(String(searchResponse.data || ""));
  const candidates = [];
  $(".result").each((_, el) => {
    const link = $(el).find(".result__a").first();
    const title = link.text().replace(/\s+/g, " ").trim();
    const href = normalizeUrl(link.attr("href"));
    const snippet = $(el).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    if (title && href) {
      candidates.push({ title, url: href, snippet });
    }
  });

  if (candidates.length === 0 && prefersFreshNews) {
    candidates.push(...(await fetchGoogleNewsRssResults()));
  }
  if (candidates.length === 0) {
    candidates.push(...(await fetchBingRssResults()));
  }

  const unique = [];
  const seen = new Set();
  for (const item of candidates) {
    if (seen.has(item.url)) continue;
    let hostname = "";
    try {
      hostname = new URL(item.url).hostname;
    } catch (_) {
      hostname = "";
    }
    if (lowSignalHosts.has(hostname)) continue;
    seen.add(item.url);
    unique.push(item);
    if (unique.length >= Math.max(1, Math.min(12, Number(maxResults) || 5))) break;
  }

  const enriched = [];
  for (const item of unique) {
    let content = "";
    let structure = {};
    try {
      const extracted = await fetchPageSnippet(item.url);
      content = extracted?.content || "";
      structure = extracted?.structure || {};
    } catch (_) {
      // Keep search result even if page fetch fails.
    }
    enriched.push({
      ...item,
      content,
      structure,
      snippet: item.snippet || content.slice(0, 300),
    });
  }

  return enriched;
}

async function searchRag(args) {
  const userId = Number.parseInt(args.userId, 10);
  const sessionId = Number.parseInt(args.sessionId, 10);
  const query = String(args.query || "").trim();
  const limit = Math.max(1, Math.min(12, Number.parseInt(args.limit, 10) || 6));

  if (!Number.isInteger(userId)) throw new Error("userId is required");
  if (!query) throw new Error("query is required");

  return await buildRagContext(userId, Number.isInteger(sessionId) ? sessionId : null, query, limit);
}

async function searchWeb(args) {
  const userId = Number.parseInt(args.userId, 10);
  const sessionId = Number.parseInt(args.sessionId, 10);
  const query = String(args.query || "").trim();
  const maxResults = Math.max(1, Math.min(12, Number.parseInt(args.maxResults, 10) || 5));
  const autoIndex = args.autoIndex !== false;

  if (!query) throw new Error("query is required");
  const sources = await deepSearchWeb(query, maxResults);

  if (autoIndex && Number.isInteger(userId)) {
    await indexWebSourcesForRag(userId, Number.isInteger(sessionId) ? sessionId : null, sources);
  }

  return { sources };
}

async function storeKnowledge(args) {
  const userId = Number.parseInt(args.userId, 10);
  const sessionId = Number.parseInt(args.sessionId, 10);
  const title = String(args.title || "").trim().slice(0, 200);
  const content = String(args.content || "").trim().slice(0, 20000);
  const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t)).slice(0, 20) : [];

  if (!Number.isInteger(userId)) throw new Error("userId is required");
  if (!title) throw new Error("title is required");
  if (!content) throw new Error("content is required");

  const knowledgeKind = String(args.knowledgeKind || "general").trim().slice(0, 80) || "general";
  const source = await knowledgeSourceModel.createInsight(
    userId,
    Number.isInteger(sessionId) ? sessionId : null,
    title,
    content,
    {
      tags,
      knowledge_kind: knowledgeKind,
      learned_from_interaction: true,
      agent: "Dino MCP Agent",
      source: "mcp_server",
    }
  );

  const chunks = createStoredChunksFromContent(content, title, tags, { knowledge_kind: knowledgeKind });

  await knowledgeChunkModel.replaceChunksForSource(
    source.id,
    userId,
    Number.isInteger(sessionId) ? sessionId : null,
    chunks
  );

  return {
    stored: true,
    sourceId: source.id,
    title,
    tags,
    knowledgeKind,
  };
}

async function runProjectChecks(args) {
  const scope = String(args.scope || "quick").trim().toLowerCase();
  const includeBuild = args.includeBuild === true;
  const checks = [];

  const runCheck = (label, command, commandArgs, cwd) => {
    const result = spawnSync(command, commandArgs, {
      cwd,
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true,
    });
    checks.push({
      label,
      command: [command, ...commandArgs].join(" "),
      cwd: normalizePathForDisplay(cwd),
      ok: result.status === 0,
      exitCode: result.status,
      stdout: String(result.stdout || "").trim().slice(0, 6000),
      stderr: String(result.stderr || "").trim().slice(0, 6000),
      error: result.error ? String(result.error.message || result.error) : "",
    });
  };

  const backendRoot = path.join(PROJECT_ROOT, "fubotics-chat-backend");
  const frontendRoot = path.join(PROJECT_ROOT, "fubotics-chat-frontend");

  runCheck("backend:index syntax", process.execPath, ["--check", "index.js"], backendRoot);
  runCheck("backend:mcp syntax", process.execPath, ["--check", "mcp-server/toolRuntime.js"], backendRoot);

  if (scope === "full" || scope === "frontend" || scope === "quick") {
    runCheck("frontend:lint", "npm", ["run", "lint"], frontendRoot);
    if (includeBuild || scope === "full") {
      runCheck("frontend:build", "npm", ["run", "build"], frontendRoot);
    }
  }

  return {
    scope,
    includeBuild,
    ok: checks.every((item) => item.ok),
    checks,
  };
}

async function listProjectFiles(args) {
  const limit = Math.max(1, Math.min(400, Number.parseInt(args.limit, 10) || 120));
  const query = String(args.query || "").trim().toLowerCase();
  const onlyCode = args.onlyCode !== false;
  const files = collectProjectFiles(PROJECT_ROOT, Math.max(limit * 8, 600))
    .filter((filePath) => !onlyCode || isLikelyCodeFile(filePath))
    .map((filePath) => {
      const relativePath = normalizePathForDisplay(path.relative(PROJECT_ROOT, filePath));
      const score = query ? scoreTextMatch(relativePath, query) : 1;
      return { path: relativePath, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);

  return {
    root: normalizePathForDisplay(PROJECT_ROOT),
    files,
  };
}

async function searchCodebase(args) {
  const query = String(args.query || "").trim();
  const limit = Math.max(1, Math.min(80, Number.parseInt(args.limit, 10) || 20));
  const fileHint = String(args.fileHint || "").trim().toLowerCase();
  if (!query) throw new Error("query is required");

  const files = collectProjectFiles(PROJECT_ROOT, 2400).filter((filePath) => {
    if (!isLikelyCodeFile(filePath)) return false;
    const relativePath = normalizePathForDisplay(path.relative(PROJECT_ROOT, filePath)).toLowerCase();
    return !fileHint || relativePath.includes(fileHint);
  });

  const matches = [];
  for (const filePath of files) {
    let content = "";
    try {
      content = readUtf8IfReasonable(filePath, MAX_SCAN_FILE_BYTES);
    } catch (_) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const relativePath = normalizePathForDisplay(path.relative(PROJECT_ROOT, filePath));
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const score = scoreTextMatch(line, query) + scoreTextMatch(relativePath, query);
      if (score <= 0) continue;
      matches.push({
        path: relativePath,
        line: index + 1,
        snippet: line.trim().slice(0, 240),
        score,
      });
      if (matches.length >= limit * 6) break;
    }
    if (matches.length >= limit * 6) break;
  }

  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);

  return {
    query,
    matches: matches.slice(0, limit),
  };
}

async function readProjectFile(args) {
  const filePath = resolveProjectPath(args.path);
  const startLine = Math.max(1, Number.parseInt(args.startLine, 10) || 1);
  const endLine = Math.max(startLine, Math.min(2000, Number.parseInt(args.endLine, 10) || startLine + 119));
  const content = readUtf8IfReasonable(filePath, MAX_READ_FILE_BYTES);
  const lines = content.split(/\r?\n/);
  const sliced = lines.slice(startLine - 1, endLine);
  const text = sliced.map((line, idx) => `${startLine + idx}: ${line}`).join("\n");

  return {
    path: normalizePathForDisplay(path.relative(PROJECT_ROOT, filePath)),
    startLine,
    endLine: Math.min(endLine, lines.length),
    content: text,
  };
}

async function storeCodeKnowledge(args) {
  return await storeKnowledge({
    ...args,
    knowledgeKind: String(args.knowledgeKind || "code_analysis").trim() || "code_analysis",
    tags: Array.isArray(args.tags)
      ? Array.from(new Set([...args.tags.map((tag) => String(tag)), "codebase"]))
      : ["codebase"],
  });
}

async function inspectTokenPolicy(args) {
  const model = String(args.model || "groq").trim().toLowerCase();
  const prompt = String(args.prompt || "");
  const hasAttachments = !!args.hasAttachments;
  const usesWeb = !!args.usesWeb;
  const usesAgentLoop = !!args.usesAgentLoop;
  const lightningMode = !!args.lightningMode;
  const requestedMaxTokens = Number.parseInt(args.requestedMaxTokens, 10) || 0;

  return {
    model,
    modelAnnotation: MODEL_ANNOTATIONS[model] || null,
    agentAnnotation: model === "dino" ? AGENT_ANNOTATIONS.dino_agent : null,
    policy: classifyTokenBudget({
      promptText: prompt,
      hasAttachments,
      usesWeb,
      usesAgentLoop,
      requestedMaxTokens,
      lightningMode,
    }),
  };
}

const TOOL_DEFS = [
  {
    name: "search_rag",
    description: "Search the existing knowledge base and return compact RAG context plus citations.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "integer" },
        sessionId: { type: "integer" },
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["userId", "query"],
    },
  },
  {
    name: "deep_search_web",
    description: "Run live web retrieval, optionally index the results into the knowledge base, and return sources.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "integer" },
        sessionId: { type: "integer" },
        query: { type: "string" },
        maxResults: { type: "integer" },
        autoIndex: { type: "boolean" },
      },
      required: ["query"],
    },
  },
  {
    name: "store_knowledge",
    description: "Persist reusable knowledge into the knowledge base so the agent can learn over time.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "integer" },
        sessionId: { type: "integer" },
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["userId", "title", "content"],
    },
  },
  {
    name: "list_project_files",
    description: "List project files so the agent can navigate the codebase.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        onlyCode: { type: "boolean" },
      },
    },
  },
  {
    name: "search_codebase",
    description: "Search source files for code, strings, routes, functions, errors, or implementation details.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        fileHint: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_project_file",
    description: "Read a project file with line numbers for code analysis.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer" },
        endLine: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "store_code_knowledge",
    description: "Persist reusable code analysis, bug notes, architecture notes, or implementation ideas into the knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "integer" },
        sessionId: { type: "integer" },
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        knowledgeKind: { type: "string" },
      },
      required: ["userId", "title", "content"],
    },
  },
  {
    name: "run_project_checks",
    description: "Run safe project validation checks such as syntax, lint, and optional build to catch code errors and regressions.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        includeBuild: { type: "boolean" },
      },
    },
  },
  {
    name: "token_policy_inspect",
    description: "Inspect current token budget and sparsity policy for a prompt/model combination.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        prompt: { type: "string" },
        hasAttachments: { type: "boolean" },
        usesWeb: { type: "boolean" },
        usesAgentLoop: { type: "boolean" },
        lightningMode: { type: "boolean" },
        requestedMaxTokens: { type: "integer" },
      },
      required: ["prompt"],
    },
  },
];

const TOOL_HANDLERS = {
  search_rag: searchRag,
  deep_search_web: searchWeb,
  store_knowledge: storeKnowledge,
  list_project_files: listProjectFiles,
  search_codebase: searchCodebase,
  read_project_file: readProjectFile,
  store_code_knowledge: storeCodeKnowledge,
  run_project_checks: runProjectChecks,
  token_policy_inspect: inspectTokenPolicy,
};

module.exports = {
  TOOL_DEFS,
  TOOL_HANDLERS,
};
