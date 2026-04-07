const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const ENGINEERING_DIR = path.join(REPO_ROOT, ".ai", "engineering");
const MARKETPLACE_PATH = path.join(REPO_ROOT, ".agents", "plugins", "marketplace.json");

const BUILTIN_AGENTS = [
  {
    id: "dino_agent",
    label: "Dino Agent",
    shortLabel: "Dino",
    description: "Web-aware autonomous agent for research, synthesis, and task execution.",
    kind: "builtin",
    executionMode: "dino",
    marketplaceAvailable: true,
    enabled: true,
    instruction: "Use Dino Agent mode. Prefer web grounding for current-info and research tasks, then synthesize clearly.",
  },
  {
    id: "coding_agent",
    label: "Coding Agent",
    shortLabel: "Coding",
    description: "Code-focused agent for implementation, debugging, architecture, and repo analysis.",
    kind: "builtin",
    executionMode: "coding_agent",
    marketplaceAvailable: true,
    enabled: true,
    instruction: "Use Coding Agent mode. Search the codebase first, then propose or produce precise implementation-oriented answers.",
  },
];

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function titleCase(value) {
  return String(value || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseFrontmatter(markdown) {
  const text = String(markdown || "");
  if (!text.startsWith("---\n")) {
    return { meta: {}, body: text.trim() };
  }

  const endIndex = text.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { meta: {}, body: text.trim() };
  }

  const rawMeta = text.slice(4, endIndex).split(/\r?\n/);
  const meta = {};
  for (const line of rawMeta) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    meta[match[1]] = match[2].trim();
  }

  return {
    meta,
    body: text.slice(endIndex + 4).trim(),
  };
}

function loadMarketplaceAvailability() {
  const marketplace = safeReadJson(MARKETPLACE_PATH, { plugins: [] });
  return Array.isArray(marketplace?.plugins)
    ? marketplace.plugins.some((plugin) => plugin?.name === "agentkit-engineering")
    : false;
}

function loadEngineeringAgents() {
  if (!fs.existsSync(ENGINEERING_DIR)) return [];

  const marketplaceAvailable = loadMarketplaceAvailability();

  return fs
    .readdirSync(ENGINEERING_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const filePath = path.join(ENGINEERING_DIR, entry.name);
      const markdown = fs.readFileSync(filePath, "utf8");
      const { meta, body } = parseFrontmatter(markdown);
      const baseName = entry.name.replace(/\.md$/i, "");
      const label = titleCase(meta.name || baseName);
      const shortLabel = label.length > 18 ? label.slice(0, 18).trim() : label;
      const description = meta.description || `${label} AgentKit role.`;
      return {
        id: baseName,
        label,
        shortLabel,
        description,
        kind: "agentkit_engineering",
        executionMode: "coding_agent",
        marketplaceAvailable,
        enabled: true,
        sourcePath: filePath,
        instruction: body,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function listAvailableAgents() {
  return [...BUILTIN_AGENTS, ...loadEngineeringAgents()];
}

function getAgentById(agentId) {
  const target = String(agentId || "").trim();
  if (!target) return null;
  return listAvailableAgents().find((agent) => agent.id === target) || null;
}

function buildAgentInstruction(agent) {
  if (!agent?.instruction) return "";
  if (agent.kind === "agentkit_engineering") {
    return [
      `Selected engineering agent profile: ${agent.label}.`,
      "Apply this role guidance to the current request while staying grounded in the actual repository state:",
      agent.instruction,
    ].join("\n\n");
  }
  return String(agent.instruction || "").trim();
}

module.exports = {
  listAvailableAgents,
  getAgentById,
  buildAgentInstruction,
};
