const fs = require("fs");
const path = require("path");

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

async function listProjectFiles(args = {}) {
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

async function searchCodebase(args = {}) {
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

async function readProjectFile(args = {}) {
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

module.exports = {
  PROJECT_ROOT,
  normalizePathForDisplay,
  listProjectFiles,
  searchCodebase,
  readProjectFile,
};
