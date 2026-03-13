require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const Groq = require("groq-sdk");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const axios = require("axios");
const cheerio = require("cheerio");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
const jwt = require("jsonwebtoken");
const PDFDocument = require("pdfkit");
const PptxGenJS = require("pptxgenjs");
const { Document, Packer, Paragraph, HeadingLevel } = require("docx");
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// Import configurations and modules
const db = require("./db");
const { authMiddleware } = require("./middleware/auth");
const authController = require("./controllers/authController");
const chatSessionModel = require("./models/chatSession");
const messageModel = require("./models/message");
const attachmentModel = require("./models/attachment");
const shareChatModel = require("./models/shareChat");
const config = require("./config/database");
const { buildRagContext, indexAttachmentForRag, indexWebSourcesForRag } = require("./services/ragService");
const { createImageGenerationService } = require("./services/imageGenerationService");

const app = express();
const PORT = process.env.PORT || 5000;
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || "25mb";
const PUBLIC_IMAGE_SHARE_EXPIRY = process.env.PUBLIC_IMAGE_SHARE_EXPIRY || "30d";
app.set("trust proxy", 1);

// ---------- CORS (dynamic allowlist) ----------
const defaultOrigins = [
  "http://localhost:5173",
  "https://nexacore-ai.vercel.app",
  "https://www.nexacore-ai.vercel.app",
  "https://fuboticsai.onrender.com"
];

const envList = process.env.FRONTEND_ORIGINS
  ? process.env.FRONTEND_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

function normalizeOrigin(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

const ALLOWED_ORIGINS = Array.from(
  new Set([...envList, ...defaultOrigins].map(normalizeOrigin).filter(Boolean))
);

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

// Cookie parser for refresh tokens
app.use(cookieParser());

// ---------- MULTER SETUP ----------
const uploadDir = path.join(__dirname, 'uploads');
const generatedDir = path.join(__dirname, 'generated');
const attachmentsDir = path.join(__dirname, 'attachments');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir);
if (!fs.existsSync(attachmentsDir)) fs.mkdirSync(attachmentsDir);

// Upload for data analytics
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || path.extname(file.originalname).toLowerCase() === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Upload for chat attachments (supports multiple file types)
const chatUpload = multer({
  dest: attachmentsDir,
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'text/csv', 'text/plain', 'application/json',
      'application/pdf', 'image/png', 'image/jpeg', 
      'application/vnd.ms-excel', 
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ];
    if (allowedTypes.includes(file.mimetype) || 
        ['.csv', '.txt', '.json', '.pdf', '.png', '.jpg', '.jpeg', '.xls', '.xlsx', '.docx', '.pptx'].includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  }
});

// CORS middleware
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    const normalizedOrigin = normalizeOrigin(origin);
    if (ALLOWED_ORIGINS.includes(normalizedOrigin)) return callback(null, true);
    return callback(new Error("CORS origin denied: " + origin));
  },
  methods: ["GET", "POST", "PUT", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin || "";
    const normalizedOrigin = normalizeOrigin(origin);
    if (!origin || ALLOWED_ORIGINS.includes(normalizedOrigin)) {
      res.header("Access-Control-Allow-Origin", origin || "*");
      res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS,DELETE");
      res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
      res.header("Access-Control-Allow-Credentials", "true");
      return res.sendStatus(200);
    }
    return res.status(403).send("CORS origin denied");
  }
  next();
});

// ---------- DATABASE INITIALIZATION ----------
// Initialize PostgreSQL database
async function initializeApp() {
  try {
    // Initialize database schema
    await db.initializeDatabase();
    console.log("✅ PostgreSQL database initialized");
  } catch (err) {
    console.error("❌ Failed to initialize database:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
    });
    process.exit(1);
  }
}

// ---------- FILE ANALYSIS HELPERS ----------
async function analyzeFile(filePath, fileType, originalFilename) {
  try {
    const lowerName = (originalFilename || "").toLowerCase();
    
    if (fileType === 'text/csv' || lowerName.endsWith('.csv')) {
      const rows = [];
      return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => rows.push(row))
          .on('end', () => {
            const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
            const csvText = rows
              .slice(0, 120)
              .map((r) => columns.map((c) => `${c}: ${String(r[c] ?? "")}`).join(" | "))
              .join("\n")
              .slice(0, extractionMaxChars);
            const summary = {
              type: 'csv',
              rows: rows.length,
              columns: columns,
              sample: rows.slice(0, 10),
              extracted_text: csvText
            };
            resolve(JSON.stringify(summary));
          })
          .on('error', reject);
      });
    } else if (fileType === 'text/plain' || fileType === 'application/json' || lowerName.endsWith(".txt") || lowerName.endsWith(".json")) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.stringify({
        type: fileType === 'application/json' ? 'json' : 'text',
        preview: content.substring(0, 2000),
        extracted_text: content.substring(0, extractionMaxChars),
        size: content.length
      });
    } else if (fileType === "application/pdf" || lowerName.endsWith(".pdf")) {
      const buffer = fs.readFileSync(filePath);
      const parsed = await pdfParse(buffer);
      const text = (parsed.text || "").replace(/\s+/g, " ").trim();
      return JSON.stringify({
        type: "pdf",
        pages: parsed.numpages,
        preview: text.substring(0, 2000),
        extracted_text: text.substring(0, extractionMaxChars)
      });
    } else if (fileType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || lowerName.endsWith(".docx")) {
      const extracted = await mammoth.extractRawText({ path: filePath });
      const text = (extracted.value || "").replace(/\s+/g, " ").trim();
      return JSON.stringify({
        type: "docx",
        preview: text.substring(0, 2000),
        extracted_text: text.substring(0, extractionMaxChars),
        length: text.length
      });
    } else if (
      fileType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      fileType === "application/vnd.ms-excel" ||
      lowerName.endsWith(".xlsx") ||
      lowerName.endsWith(".xls")
    ) {
      const workbook = XLSX.readFile(filePath);
      const firstSheet = workbook.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "" });
      const columns = rows.length ? Object.keys(rows[0]) : [];
      const sheetText = rows
        .slice(0, 150)
        .map((r) => columns.map((c) => `${c}: ${String(r[c] ?? "")}`).join(" | "))
        .join("\n")
        .slice(0, extractionMaxChars);
      return JSON.stringify({
        type: "spreadsheet",
        sheet: firstSheet,
        rows: rows.length,
        columns,
        sample: rows.slice(0, 10),
        extracted_text: sheetText
      });
    } else if (
      fileType === "image/png" ||
      fileType === "image/jpeg" ||
      fileType === "image/jpg" ||
      lowerName.endsWith(".png") ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg")
    ) {
      return await analyzeImageWithVision(filePath, fileType, originalFilename);
    }
    
    return JSON.stringify({ type: 'file', filename: originalFilename });
  } catch (err) {
    console.error('File analysis error:', err);
    return JSON.stringify({ type: 'file', filename: originalFilename, error: 'Could not analyze' });
  }
}

// ---------- GROQ / AI SETUP ----------
const groqKey = process.env.GROQ_API_KEY;
if (!groqKey) {
  console.warn("⚠️ GROQ_API_KEY is NOT set in environment!");
} else {
  console.log("✅ GROQ_API_KEY loaded.");
}
const groq = new Groq({ apiKey: groqKey });
const sambaNovaApiKey = process.env.SAMBANOVA_API_KEY || null;
const sambaNovaBaseUrl = process.env.SAMBANOVA_BASE_URL || "https://api.sambanova.ai/v1";
const sambaNovaChatModel = process.env.SAMBANOVA_CHAT_MODEL || "Meta-Llama-3.3-70B-Instruct";
const sambaNovaPromptModel = process.env.SAMBANOVA_IMAGE_PROMPT_MODEL || "Meta-Llama-3.3-70B-Instruct";
const sambaNovaVisionModel = process.env.SAMBANOVA_VISION_MODEL || "Llama-4-Maverick-17B-128E-Instruct";
const freepikEnabled = String(process.env.ENABLE_FREEPIK || "false").toLowerCase() === "true";
const freepikApiKey = freepikEnabled ? process.env.FREEPIK_API_KEY || null : null;
const freepikImageModel = process.env.FREEPIK_IMAGE_MODEL || "flux-pro-v1-1";
const freepikPollAttempts = Math.min(
  30,
  Math.max(3, Number.parseInt(process.env.FREEPIK_POLL_ATTEMPTS || "15", 10))
);
const freepikPollIntervalMs = Math.min(
  5000,
  Math.max(500, Number.parseInt(process.env.FREEPIK_POLL_INTERVAL_MS || "1200", 10))
);
const huggingFaceApiKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_API_KEY || null;
const huggingFaceImageModel = process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";
const pollinationsBaseUrl = (process.env.POLLINATIONS_BASE_URL || "https://image.pollinations.ai").replace(/\/$/, "");
const pollinationsImageModel = process.env.POLLINATIONS_IMAGE_MODEL || "flux";
const localImageWorkerUrl = (process.env.LOCAL_IMAGE_WORKER_URL || "").trim();
const localImageWorkerApiKey = process.env.LOCAL_IMAGE_WORKER_API_KEY || null;
const localImageWorkerTimeoutMs = Math.min(
  300000,
  Math.max(30000, Number.parseInt(process.env.LOCAL_IMAGE_WORKER_TIMEOUT_MS || "180000", 10))
);
const allowPlaceholderFallback = String(process.env.ALLOW_IMAGE_PLACEHOLDER_FALLBACK || "false").toLowerCase() === "true";
const extractionMaxChars = Math.min(
  120000,
  Math.max(4000, Number.parseInt(process.env.EXTRACTION_MAX_CHARS || "30000", 10))
);

const CHAT_MODELS = {
  groq: {
    id: "groq",
    label: "Groq (Llama 3.3 70B)",
    enabled: Boolean(groqKey),
    model: "llama-3.3-70b-versatile",
  },
  sambanova: {
    id: "sambanova",
    label: "SambaNova",
    enabled: Boolean(sambaNovaApiKey),
    model: sambaNovaChatModel,
  },
};

const defaultChatModel = CHAT_MODELS.groq.enabled ? "groq" : (CHAT_MODELS.sambanova.enabled ? "sambanova" : "groq");

function createFallbackPng(prompt = "") {
  const width = 768;
  const height = 768;
  const rowSize = width * 4 + 1;
  const raw = Buffer.alloc(rowSize * height);
  const text = String(prompt || "image");
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed + text.charCodeAt(i) * (i + 1)) >>> 0;

  for (let y = 0; y < height; y++) {
    const row = y * rowSize;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const idx = row + 1 + x * 4;
      const r = Math.floor((x / width) * 160) + 30;
      const g = Math.floor((y / height) * 140) + 40;
      const b = ((seed % 150) + 80 + Math.floor((x + y) / 16)) % 256;
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = 255;
    }
  }

  const cx = width / 2;
  const cy = height / 2;
  const radius = 180;
  for (let y = Math.max(0, cy - radius); y < Math.min(height, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x < Math.min(width, cx + radius); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        const idx = y * rowSize + 1 + x * 4;
        raw[idx] = 248;
        raw[idx + 1] = 250;
        raw[idx + 2] = 252;
        raw[idx + 3] = 255;
      }
    }
  }

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const imageGenerationService = createImageGenerationService({
  axios,
  fs,
  path,
  attachmentModel,
  generatedDir,
  buildGeneratedFilename,
  createFallbackPng,
  sambaNovaApiKey,
  sambaNovaBaseUrl,
  sambaNovaPromptModel,
  freepikApiKey,
  freepikImageModel,
  freepikPollAttempts,
  freepikPollIntervalMs,
  huggingFaceApiKey,
  huggingFaceImageModel,
  pollinationsBaseUrl,
  pollinationsImageModel,
  localImageWorkerUrl,
  localImageWorkerApiKey,
  localImageWorkerTimeoutMs,
  allowPlaceholderFallback,
});
const deepSearchMaxResults = Math.min(
  12,
  Math.max(1, Number.parseInt(process.env.DEEP_SEARCH_MAX_RESULTS || "6", 10))
);
const deepSearchFetchConcurrency = Math.min(
  6,
  Math.max(1, Number.parseInt(process.env.DEEP_SEARCH_FETCH_CONCURRENCY || "3", 10))
);
const deepSearchSnippetChars = Math.min(
  1800,
  Math.max(300, Number.parseInt(process.env.DEEP_SEARCH_SNIPPET_CHARS || "900", 10))
);
const deepSearchSearchTimeoutMs = Math.min(
  20000,
  Math.max(5000, Number.parseInt(process.env.DEEP_SEARCH_SEARCH_TIMEOUT_MS || "12000", 10))
);
const deepSearchPageTimeoutMs = Math.min(
  20000,
  Math.max(5000, Number.parseInt(process.env.DEEP_SEARCH_PAGE_TIMEOUT_MS || "10000", 10))
);
const aiDefaultMaxTokens = Math.min(
  4096,
  Math.max(512, Number.parseInt(process.env.AI_MAX_TOKENS || "2048", 10))
);
const aiDeepSearchMaxTokens = Math.min(
  4096,
  Math.max(aiDefaultMaxTokens, Number.parseInt(process.env.AI_DEEP_SEARCH_MAX_TOKENS || "3072", 10))
);

function stripCodeFence(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

async function analyzeImageWithVision(filePath, fileType, originalFilename) {
  if (!sambaNovaApiKey) {
    return JSON.stringify({
      type: "image",
      filename: originalFilename,
      summary: "Image uploaded. Vision analysis unavailable because SAMBANOVA_API_KEY is not configured.",
      extracted_text: `Image file ${originalFilename}. Vision analysis unavailable.`,
    });
  }

  const mimeType = fileType || "image/png";
  const imageBase64 = fs.readFileSync(filePath).toString("base64");
  const prompt = [
    "Analyze this image and return only valid JSON.",
    "Required keys: type, subject, likely_type, dominant_colors, background, visible_text, summary, extracted_text.",
    "Use short values and keep extracted_text retrieval-friendly.",
  ].join("\n");

  const response = await axios.post(
    `${sambaNovaBaseUrl}/chat/completions`,
    {
      model: sambaNovaVisionModel,
      max_tokens: 700,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
    },
    {
      timeout: 45000,
      headers: {
        Authorization: `Bearer ${sambaNovaApiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const rawContent = response.data?.choices?.[0]?.message?.content || "";
  const cleaned = stripCodeFence(rawContent);
  try {
    const parsed = JSON.parse(cleaned);
    parsed.type = "image";
    if (!parsed.extracted_text) {
      parsed.extracted_text = [
        parsed.subject ? `Subject: ${parsed.subject}` : "",
        parsed.likely_type ? `Type: ${parsed.likely_type}` : "",
        Array.isArray(parsed.dominant_colors) && parsed.dominant_colors.length
          ? `Colors: ${parsed.dominant_colors.join(", ")}`
          : "",
        parsed.background ? `Background: ${parsed.background}` : "",
        parsed.visible_text ? `Visible text: ${parsed.visible_text}` : "",
      ].filter(Boolean).join(". ");
    }
    return JSON.stringify(parsed);
  } catch (_) {
    return JSON.stringify({
      type: "image",
      filename: originalFilename,
      summary: cleaned.slice(0, 1000),
      extracted_text: cleaned.slice(0, extractionMaxChars),
    });
  }
}

function buildHistoryContext(history = [], maxMessages = 24) {
  const recent = Array.isArray(history) ? history.slice(-maxMessages) : [];
  return recent
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
      return `[${role}] ${String(m.content || "").trim()}`;
    })
    .join("\n")
    .slice(0, 14000);
}

function shouldReviewAcrossChats(content = "") {
  const text = String(content || "").toLowerCase();
  const patterns = [
    "existing chats",
    "previous chats",
    "review chats",
    "past chats",
    "across chats",
    "all chats",
    "older chats",
  ];
  return patterns.some((p) => text.includes(p));
}

async function getCrossChatContext(userId, currentSessionId) {
  try {
    const sessions = await chatSessionModel.getByUserId(userId);
    const others = sessions.filter((s) => s.id !== currentSessionId).slice(0, 5);
    const chunks = [];
    for (const s of others) {
      const recent = await messageModel.getRecentBySessionId(s.id, 6);
      if (!recent.length) continue;
      const title = s.name || `Chat ${s.id}`;
      const block = recent
        .map((m) => `[${m.role}] ${String(m.content || "").trim()}`)
        .join("\n")
        .slice(0, 3000);
      chunks.push(`Session: ${title}\n${block}`);
    }
    return chunks.join("\n\n").slice(0, 10000);
  } catch (err) {
    console.error("Cross-chat context fetch failed:", err.message);
    return "";
  }
}

async function generateNarrative(prompt, style = "document", contextText = "") {
  const contentPrompt = `Create a high quality ${style} based on this request:\n${prompt}

Conversation context (use this as source material when relevant):
${contextText || "No additional context provided."}

Return only final content (no meta commentary).`;
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: "You are a professional content generator." },
      { role: "user", content: contentPrompt },
    ],
    max_tokens: 2500,
    temperature: 0.6,
  });
  return response.choices?.[0]?.message?.content?.trim() || prompt;
}

async function suggestSessionNameFromPrompt(prompt) {
  const raw = String(prompt || "").trim();
  if (!raw) return "New Chat";

  const fallbackName = (() => {
    const cleaned = raw
      .replace(/[`*_#>[\](){}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "New Chat";

    const topicalMatch = cleaned.match(/\b(?:about|for|on|regarding)\b\s+(.+)/i);
    if (topicalMatch?.[1]) {
      return topicalMatch[1]
        .split(/\s+/)
        .slice(0, 6)
        .join(" ")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .slice(0, 60) || "New Chat";
    }

    const stopWords = new Set([
      "the", "a", "an", "please", "can", "could", "would", "should", "help", "me", "i",
      "to", "of", "and", "or", "in", "on", "for", "with", "is", "are", "this", "that",
      "my", "your", "our", "it", "be", "as", "at", "by", "from", "do", "does", "did",
    ]);
    const tokens = cleaned
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !stopWords.has(t));

    const picked = tokens.slice(0, 6).map((t) => t.charAt(0).toUpperCase() + t.slice(1));
    if (picked.length) return picked.join(" ").slice(0, 60);
    return cleaned.split(/\s+/).slice(0, 5).join(" ").slice(0, 60) || "New Chat";
  })();

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "Generate a short, clear chat title (max 6 words). Return title only." },
        { role: "user", content: raw },
      ],
      max_tokens: 20,
      temperature: 0.2,
    });
    const title = (response.choices?.[0]?.message?.content || "")
      .replace(/["`]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    if (title) return title;
  } catch (err) {
    console.warn("Session name suggestion failed:", err.message);
  }
  return fallbackName;
}

async function ensureSequentialSessionName(userId, proposedName) {
  const baseName = String(proposedName || "").trim().slice(0, 255) || "New Chat";
  const sessions = await chatSessionModel.getByUserId(userId);
  const names = sessions
    .map((s) => String(s.name || "").trim())
    .filter(Boolean);

  const lowerBase = baseName.toLowerCase();
  let maxSuffix = 0;
  for (const name of names) {
    const lowerName = name.toLowerCase();
    if (lowerName === lowerBase) {
      maxSuffix = Math.max(maxSuffix, 1);
      continue;
    }
    const escaped = lowerBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = lowerName.match(new RegExp(`^${escaped}\\s+(\\d+)$`));
    if (match) {
      const suffix = Number.parseInt(match[1], 10);
      if (Number.isInteger(suffix)) maxSuffix = Math.max(maxSuffix, suffix);
    }
  }

  if (maxSuffix === 0) return baseName;
  return `${baseName} ${maxSuffix + 1}`.slice(0, 255);
}

function renderAttachmentInsight(analysis) {
  if (!analysis || typeof analysis !== "object") return "";
  const richText = String(analysis.extracted_text || analysis.preview || "").substring(0, 6000);
  if (analysis.type === "image") {
    const colors = Array.isArray(analysis.dominant_colors) ? analysis.dominant_colors.join(", ") : "";
    return [
      analysis.subject ? `Image subject: ${analysis.subject}.` : "",
      analysis.likely_type ? `Likely type: ${analysis.likely_type}.` : "",
      colors ? `Dominant colors: ${colors}.` : "",
      analysis.background ? `Background: ${analysis.background}.` : "",
      analysis.visible_text ? `Visible text: ${analysis.visible_text}.` : "",
      richText ? `Visual extraction: ${richText}` : "",
    ].filter(Boolean).join(" ");
  }
  if (analysis.type === "csv") {
    return `CSV with ${analysis.rows || 0} rows and columns: ${(analysis.columns || []).join(", ")}. Extracted content: ${richText}`;
  }
  if (analysis.type === "spreadsheet") {
    return `Spreadsheet (${analysis.sheet || "sheet"}) with ${analysis.rows || 0} rows and columns: ${(analysis.columns || []).join(", ")}. Extracted content: ${richText}`;
  }
  if (analysis.type === "pdf") {
    return `PDF with ${analysis.pages || "unknown"} pages. Extracted text: ${richText}`;
  }
  if (analysis.type === "docx") {
    return `DOCX extracted text: ${richText}`;
  }
  if (analysis.type === "json" || analysis.type === "text") {
    return `${analysis.type.toUpperCase()} extracted text: ${richText}`;
  }
  if (analysis.extracted_text) return String(analysis.extracted_text).substring(0, 6000);
  if (analysis.preview) return String(analysis.preview).substring(0, 2000);
  if (analysis.sample) return `Sample data: ${JSON.stringify(analysis.sample).substring(0, 700)}`;
  return "";
}

async function deepSearchWeb(query, maxResults = deepSearchMaxResults) {
  const normalizeResultUrl = (rawUrl) => {
    if (!rawUrl) return null;
    let candidate = String(rawUrl).trim();
    if (!candidate) return null;

    if (candidate.startsWith("//")) {
      candidate = `https:${candidate}`;
    } else if (candidate.startsWith("/")) {
      candidate = `https://duckduckgo.com${candidate}`;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.hostname.includes("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
        const target = parsed.searchParams.get("uddg");
        if (target) return decodeURIComponent(target);
      }
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
      return null;
    } catch (_) {
      return null;
    }
  };

  try {
    const targetResults = Math.min(12, Math.max(1, Number.parseInt(String(maxResults), 10) || deepSearchMaxResults));
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const { data } = await axios.get(searchUrl, {
      timeout: deepSearchSearchTimeoutMs,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });
    const $ = cheerio.load(data);
    const rawResults = [];
    $("a.result__a").each((_, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr("href");
      const normalized = normalizeResultUrl(href);
      if (title && normalized) rawResults.push({ title, url: normalized });
    });

    const unique = [];
    const seenDomainCount = new Map();
    const seen = new Set();
    for (const item of rawResults) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        let hostname = "";
        try {
          hostname = new URL(item.url).hostname;
        } catch (_) {
          hostname = "";
        }
        const domainHits = seenDomainCount.get(hostname) || 0;
        if (domainHits < 2) {
          unique.push(item);
          seenDomainCount.set(hostname, domainHits + 1);
        }
      }
      if (unique.length >= targetResults * 2) break;
    }

    const fetchSourceSnippet = async (item) => {
      try {
        const page = await axios.get(item.url, {
          timeout: deepSearchPageTimeoutMs,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          },
        });
        const p$ = cheerio.load(page.data);
        const content = p$("p")
          .slice(0, 20)
          .map((__, p) => p$(p).text().trim())
          .get()
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, deepSearchSnippetChars);
        return {
          title: item.title,
          url: item.url,
          snippet: content || "No extractable content.",
        };
      } catch (_) {
        return {
          title: item.title,
          url: item.url,
          snippet: "Source fetched but content extraction failed.",
        };
      }
    };

    const enriched = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(deepSearchFetchConcurrency, unique.length) },
      async () => {
        while (cursor < unique.length) {
          const current = unique[cursor++];
          const fetched = await fetchSourceSnippet(current);
          enriched.push(fetched);
        }
      }
    );
    await Promise.all(workers);
    if (enriched.length > targetResults) {
      return enriched.slice(0, targetResults);
    }
    return enriched;
  } catch (err) {
    console.error("Deep search error:", err.message);
    return [];
  }
}

function buildPromptBasedBasename(prompt, fallback) {
  const raw = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return fallback;
  const stop = new Set(["generate", "create", "make", "please", "a", "an", "the", "for", "to", "of", "with", "and"]);
  const parts = raw
    .split(" ")
    .filter((w) => w && !stop.has(w))
    .slice(0, 6);
  if (parts.length === 0) return fallback;
  return parts.join("_");
}

function buildGeneratedFilename(prompt, type, ext) {
  const fallbackByType = {
    document: "document",
    pdf: "report",
    ppt: "presentation",
    notes: "notes",
    image: "image",
  };
  const base = buildPromptBasedBasename(prompt, fallbackByType[type] || "file");
  const stamp = Date.now();
  return `${base}_${stamp}.${ext}`;
}

function getCodeExtension(language) {
  const lang = String(language || "").trim().toLowerCase();
  const map = {
    javascript: "js",
    js: "js",
    typescript: "ts",
    ts: "ts",
    jsx: "jsx",
    tsx: "tsx",
    python: "py",
    py: "py",
    java: "java",
    c: "c",
    cpp: "cpp",
    "c++": "cpp",
    csharp: "cs",
    cs: "cs",
    go: "go",
    rust: "rs",
    ruby: "rb",
    php: "php",
    swift: "swift",
    kotlin: "kt",
    sql: "sql",
    html: "html",
    css: "css",
    json: "json",
    yaml: "yml",
    yml: "yml",
    bash: "sh",
    shell: "sh",
    sh: "sh",
  };
  return map[lang] || "txt";
}

async function offloadLargeCodeBlocksToFiles(sessionId, prompt, replyText, minLines = 100) {
  const text = String(replyText || "");
  const regex = /(```|~~~)\s*([^\n`]*)\r?\n([\s\S]*?)\r?\n?\1[ \t]*/g;
  const matches = Array.from(text.matchAll(regex));
  if (matches.length === 0) {
    return { content: text, attachments: [] };
  }
  const totalCodeLines = matches.reduce((sum, match) => {
    const code = String(match[3] || "");
    return sum + code.split(/\r?\n/).length;
  }, 0);
  const exportAllCodeBlocks = totalCodeLines > minLines;

  const attachments = [];
  const segments = [];
  let cursor = 0;
  let exportedCount = 0;

  for (const match of matches) {
    const start = match.index || 0;
    const end = start + match[0].length;
    const language = String(match[2] || "").trim();
    const code = String(match[3] || "");
    const lines = code.split(/\r?\n/).length;

    segments.push(text.slice(cursor, start));

    if (exportAllCodeBlocks || lines > minLines) {
      exportedCount += 1;
      const ext = getCodeExtension(language);
      const filename = buildGeneratedFilename(`${prompt} code ${exportedCount}`, "document", ext);
      const filePath = path.join(generatedDir, filename);
      fs.writeFileSync(filePath, code, "utf8");

      const attachment = await attachmentModel.create(
        sessionId,
        filename,
        filename,
        filePath,
        "text/plain",
        fs.statSync(filePath).size,
        JSON.stringify({ type: "generated_code", prompt, language, lines }),
        true
      );
      attachments.push(attachment);
      segments.push(
        `\n[PASTED CODE FILE] ${filename} (${lines} lines)\n` +
        `This code was sent as a file because it is longer than ${minLines} lines.\n` +
        `Reply with what you want me to do next: explain, debug, refactor, optimize, test, or convert it.\n`
      );
    } else {
      segments.push(match[0]);
    }

    cursor = end;
  }

  segments.push(text.slice(cursor));
  const merged = segments.join("").trim();
  return {
    content: merged || "Code generated and exported to files.",
    attachments,
  };
}

async function generateDocumentFile(sessionId, prompt, contextText = "") {
  const content = await generateNarrative(prompt, "word document", contextText);
  const filename = buildGeneratedFilename(prompt, "document", "docx");
  const filePath = path.join(generatedDir, filename);
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "Generated Document", heading: HeadingLevel.HEADING_1 }),
          ...content.split("\n").map((line) => new Paragraph(line || " ")),
        ],
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  return attachmentModel.create(
    sessionId,
    filename,
    filename,
    filePath,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fs.statSync(filePath).size,
    JSON.stringify({ type: "generated_document", prompt }),
    true
  );
}

async function generatePdfFile(sessionId, prompt, contextText = "") {
  const content = await generateNarrative(prompt, "pdf report", contextText);
  const filename = buildGeneratedFilename(prompt, "pdf", "pdf");
  const filePath = path.join(generatedDir, filename);
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.fontSize(18).text("Generated PDF", { underline: true });
    doc.moveDown();
    doc.fontSize(12).text(content);
    doc.moveDown();
    doc.text(`Generated at: ${new Date().toISOString()}`);
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return attachmentModel.create(
    sessionId,
    filename,
    filename,
    filePath,
    "application/pdf",
    fs.statSync(filePath).size,
    JSON.stringify({ type: "generated_pdf", prompt }),
    true
  );
}

async function generatePptFile(sessionId, prompt, contextText = "") {
  const content = await generateNarrative(prompt, "presentation with key points", contextText);
  const bullets = content
    .split("\n")
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  const filename = buildGeneratedFilename(prompt, "ppt", "pptx");
  const filePath = path.join(generatedDir, filename);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  const slide1 = pptx.addSlide();
  slide1.addText("Generated Presentation", { x: 0.5, y: 0.5, w: 12, h: 0.8, fontSize: 28, bold: true });
  slide1.addText(prompt, { x: 0.8, y: 1.6, w: 11.5, h: 1.2, fontSize: 16 });
  const slide2 = pptx.addSlide();
  slide2.addText("Summary", { x: 0.5, y: 0.5, w: 12, h: 0.7, fontSize: 24, bold: true });
  slide2.addText(
    bullets.map((b) => ({ text: b, options: { bullet: { indent: 16 } } })),
    { x: 0.8, y: 1.5, w: 11, h: 4.5, fontSize: 16 }
  );
  await pptx.writeFile({ fileName: filePath });
  return attachmentModel.create(
    sessionId,
    filename,
    filename,
    filePath,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    fs.statSync(filePath).size,
    JSON.stringify({ type: "generated_ppt", prompt }),
    true
  );
}

async function generateNotesFile(sessionId, prompt, contextText = "") {
  const content = await generateNarrative(prompt, "structured study notes in markdown", contextText);
  const filename = buildGeneratedFilename(prompt, "notes", "md");
  const filePath = path.join(generatedDir, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return attachmentModel.create(
    sessionId,
    filename,
    filename,
    filePath,
    "text/markdown",
    fs.statSync(filePath).size,
    JSON.stringify({ type: "generated_notes", prompt }),
    true
  );
}

async function generateImageFile(sessionId, prompt) {
  return imageGenerationService.generateImageFile(sessionId, prompt);
}

function detectGenerationRequest(content) {
  const raw = String(content || "");
  const text = raw.toLowerCase();
  const fencedRegex = /(```|~~~)\s*([^\n`]*)\r?\n([\s\S]*?)\r?\n?\1[ \t]*/g;
  const fencedBlocks = Array.from(raw.matchAll(fencedRegex));
  const fencedLines = fencedBlocks.reduce((sum, m) => sum + String(m[3] || "").split(/\r?\n/).length, 0);
  const plainLines = raw.split(/\r?\n/);
  const nonEmpty = plainLines.filter((l) => l.trim().length > 0);
  const codeLikeCount = nonEmpty.filter((l) =>
    /[{}();=<>]|^\s*(const|let|var|function|class|if|for|while|import|export|def|return|public|private|static|async|await)\b/i.test(l)
  ).length;
  const isLikelyCodePayload =
    fencedLines > 40 ||
    (nonEmpty.length > 80 && codeLikeCount >= Math.max(20, Math.ceil(nonEmpty.length * 0.2)));
  if (isLikelyCodePayload) return null;

  const asksForCreation =
    text.includes("generate") ||
    text.includes("create") ||
    text.includes("make") ||
    text.includes("export") ||
    text.includes("convert") ||
    text.includes("prepare");
  if (!asksForCreation) return null;
  if (text.includes("image")) return "image";
  if (text.includes("ppt") || text.includes("powerpoint") || text.includes("presentation")) return "ppt";
  if (text.includes("pdf")) return "pdf";
  if (text.includes("notes") || text.includes("note")) return "notes";
  if (text.includes("docx") || text.includes("word") || text.includes("doc") || text.includes("document")) return "document";
  return null;
}

function resolvePreferredChatModel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized && CHAT_MODELS[normalized]) return normalized;
  return defaultChatModel;
}

async function sendGroqCompletion(messages, maxTokens, temperature) {
  const response = await groq.chat.completions.create({
    model: CHAT_MODELS.groq.model,
    messages,
    max_tokens: maxTokens,
    temperature,
  });
  return response.choices?.[0]?.message?.content || "";
}

async function sendSambaNovaCompletion(messages, maxTokens, temperature) {
  const response = await axios.post(
    `${sambaNovaBaseUrl}/chat/completions`,
    {
      model: CHAT_MODELS.sambanova.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    },
    {
      timeout: 45000,
      headers: {
        Authorization: `Bearer ${sambaNovaApiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data?.choices?.[0]?.message?.content || "";
}

async function getAIReply(
  history,
  sessionAttachments = [],
  webSources = [],
  extraContext = "",
  preferredModel = null,
  thinking = false
) {
  try {
    let systemContent = "You are a helpful assistant.";

    if (sessionAttachments.length > 0) {
      systemContent += "\n\nYou have access to the following files uploaded in this conversation:\n";
      for (const att of sessionAttachments) {
        systemContent += `\n- ${att.original_filename} (${att.file_type})`;
        if (att.analysis_result) {
          try {
            const analysis = JSON.parse(att.analysis_result);
            const insight = renderAttachmentInsight(analysis);
            if (insight) systemContent += `\n  ${insight}`;
          } catch (e) {
            systemContent += `\n  ${att.analysis_result}`;
          }
        }
      }
      systemContent += "\n\nWhen users ask about these files, reference the information provided above.";
      systemContent += "\nIf an uploaded file is an image, its visual analysis has already been performed by the system.";
      systemContent += "\nDo not say you cannot view, inspect, or analyze the image.";
      systemContent += "\nUse the provided image subject, likely type, colors, background, visible text, and extracted visual summary as the authoritative visual evidence.";
    }

    if (webSources.length > 0) {
      systemContent += "\n\nDeep web research sources were collected for this answer. Cite them when useful:\n";
      for (const source of webSources.slice(0, deepSearchMaxResults)) {
        const safeSnippet = String(source.snippet || "").replace(/\s+/g, " ").trim().slice(0, deepSearchSnippetChars);
        systemContent += `\n- ${source.title} (${source.url})\n  Snippet: ${safeSnippet}`;
      }
      systemContent += "\n\nUse these sources to provide a research-focused response with factual caution.";
    }
    if (extraContext && extraContext.trim()) {
      systemContent += `\n\nAdditional context from other chats:\n${extraContext.trim()}`;
      systemContent += "\n\nUse it only if relevant to the current user request.";
    }
    if (thinking) {
      systemContent +=
        "\n\nThinking mode is ON. Think deeply, reason step-by-step internally, and provide a clear, well-structured answer.";
    }

    const messages = [
      { role: "system", content: systemContent },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    const maxTokens = webSources.length > 0 ? aiDeepSearchMaxTokens : aiDefaultMaxTokens;
    const selectedModel = resolvePreferredChatModel(preferredModel);
    const selectedConfig = CHAT_MODELS[selectedModel];

    if (!selectedConfig?.enabled) {
      return `Selected model "${selectedModel}" is not configured or unavailable. Please select another model and retry.`;
    }

    if (selectedModel === "sambanova") {
      try {
        const sambaReply = await sendSambaNovaCompletion(messages, maxTokens, 0.7);
        return sambaReply || "No reply from AI";
      } catch (err) {
        console.warn("SambaNova chat failed:", err?.message || err);
        return `Selected model "${selectedConfig.label}" failed: ${err?.message || "request error"}. Please retry or switch model manually.`;
      }
    }

    if (selectedModel === "groq") {
      try {
        const groqReply = await sendGroqCompletion(messages, maxTokens, 0.7);
        return groqReply || "No reply from AI";
      } catch (err) {
        console.warn("Groq chat failed:", err?.message || err);
        return `Selected model "${selectedConfig.label}" failed: ${err?.message || "request error"}. Please retry or switch model manually.`;
      }
    }

    return `Selected model "${selectedModel}" is unsupported. Please choose a valid model.`;
  } catch (err) {
    console.error("Chat completion error:", err.message || err);
    return "AI is currently unavailable, your backend and DB are working :)";
  }
}
function resolveAttachmentDiskPath(attachment) {
  if (!attachment) return null;
  const candidates = [];
  if (attachment.file_path) candidates.push(String(attachment.file_path));
  if (attachment.filename) {
    candidates.push(path.join(attachmentsDir, attachment.filename));
    candidates.push(path.join(uploadDir, attachment.filename));
    candidates.push(path.join(generatedDir, attachment.filename));
  }
  if (attachment.original_filename) {
    candidates.push(path.join(attachmentsDir, attachment.original_filename));
    candidates.push(path.join(uploadDir, attachment.original_filename));
    candidates.push(path.join(generatedDir, attachment.original_filename));
  }
  if (attachment.file_path) {
    const base = path.basename(String(attachment.file_path).replace(/\\/g, "/"));
    candidates.push(path.join(attachmentsDir, base));
    candidates.push(path.join(uploadDir, base));
    candidates.push(path.join(generatedDir, base));
  }

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function isImageAttachment(attachment) {
  if (!attachment) return false;
  const fileType = String(attachment.file_type || "").toLowerCase();
  const lowerName = String(attachment.original_filename || attachment.filename || "").toLowerCase();
  return (
    fileType.startsWith("image/") ||
    lowerName.endsWith(".png") ||
    lowerName.endsWith(".jpg") ||
    lowerName.endsWith(".jpeg") ||
    lowerName.endsWith(".webp") ||
    lowerName.endsWith(".gif")
  );
}

function createPublicImageShareToken(attachmentId) {
  return jwt.sign(
    { type: "public_image_share", attachmentId: Number(attachmentId) },
    config.jwt.secret,
    { expiresIn: PUBLIC_IMAGE_SHARE_EXPIRY }
  );
}

function verifyPublicImageShareToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

function getBackendPublicBaseUrl(req) {
  if (process.env.BACKEND_PUBLIC_URL) {
    return String(process.env.BACKEND_PUBLIC_URL).replace(/\/+$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

// ---------- ROUTES ----------

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, allowed_origins: ALLOWED_ORIGINS });
});

app.get("/api/models", (req, res) => {
  const models = Object.values(CHAT_MODELS).map((item) => ({
    id: item.id,
    label: item.label,
    enabled: item.enabled,
  }));
  res.json({ models, defaultModel: defaultChatModel });
});

// Auth routes
app.post("/api/signup", authController.signup);
app.post("/api/login", authController.login);
app.post("/api/forgot-password/username", authController.forgotPasswordByUsername);
app.post("/api/forgot-password/email", authController.forgotPasswordByEmail);
app.post("/api/refresh", authController.refresh);
app.post("/api/logout", authController.logout);
app.get("/api/me", authMiddleware, authController.me);
app.get("/api/session-logs", authMiddleware, authController.getSessionLogs);
app.post("/api/logout-all", authMiddleware, authController.logoutAll);
app.delete("/api/account", authMiddleware, authController.deleteAccount);

// Sessions routes
app.get("/api/sessions", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const sessions = await chatSessionModel.getByUserId(userId);
    res.json({ sessions });
  } catch (err) {
    console.error("GET /api/sessions error:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

app.post("/api/sessions", authMiddleware, async (req, res) => {
  try {
    let name = null;
    if (req.body && typeof req.body.name === "string") {
      name = req.body.name.trim();
      if (name === "") name = null;
    }
    const userId = req.user.id;
    const session = await chatSessionModel.create(userId, name);
    res.status(201).json({ session });
  } catch (err) {
    console.error("❌ Failed to create session:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

app.delete("/api/sessions/:id", authMiddleware, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const userId = req.user.id;
    
    // Verify session belongs to user
    const session = await chatSessionModel.getById(sessionId, userId);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to delete this session" });
    }
    
    // Get attachments to delete files
    const attachments = await attachmentModel.getFilePathsBySessionId(sessionId);
    for (const att of attachments) {
      try {
        if (att.file_path && fs.existsSync(att.file_path)) {
          fs.unlinkSync(att.file_path);
        }
      } catch (err) {
        console.error('Error deleting attachment file:', err);
      }
    }
    
    // Delete from database (cascades to messages and attachments)
    await chatSessionModel.delete(sessionId, userId);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/sessions error:", err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// Messages routes
app.get("/api/messages", authMiddleware, async (req, res) => {
  try {
    const sessionId = parseInt(req.query.sessionId, 10);
    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({ error: "Valid sessionId required" });
    }
    const session = await chatSessionModel.getById(sessionId, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to access this session" });
    }
    const messages = await messageModel.getBySessionId(sessionId);
    res.json({ messages });
  } catch (err) {
    console.error("GET /api/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.post("/api/messages", authMiddleware, async (req, res) => {
  try {
    const { sessionId, content, attachmentIds, deepSearch, thinking, model } = req.body;
    const parsedSessionId = Number.parseInt(sessionId, 10);
    if (!Number.isInteger(parsedSessionId)) {
      return res.status(400).json({ error: "Valid sessionId required" });
    }
    
    // Verify session belongs to user
    const session = await chatSessionModel.getById(parsedSessionId, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to access this session" });
    }
    
    const sessionAttachments = await attachmentModel.getBySessionId(parsedSessionId);
    
    const messageId = await messageModel.create(parsedSessionId, "user", content);
    
    if (attachmentIds && Array.isArray(attachmentIds)) {
      for (const attId of attachmentIds) {
        await attachmentModel.linkToMessage(messageId.id, attId);
      }
    }
    
    const generationType = detectGenerationRequest(content);
    if (generationType) {
      let generatedAttachment = null;
      let generationError = null;
      try {
        const historyForGeneration = await messageModel.getBySessionId(parsedSessionId);
        const conversationContext = buildHistoryContext(historyForGeneration);
        if (generationType === "image") {
          generatedAttachment = await generateImageFile(parsedSessionId, content);
        } else if (generationType === "ppt") {
          generatedAttachment = await generatePptFile(parsedSessionId, content, conversationContext);
        } else if (generationType === "pdf") {
          generatedAttachment = await generatePdfFile(parsedSessionId, content, conversationContext);
        } else if (generationType === "notes") {
          generatedAttachment = await generateNotesFile(parsedSessionId, content, conversationContext);
        } else if (generationType === "document") {
          generatedAttachment = await generateDocumentFile(parsedSessionId, content, conversationContext);
        }
      } catch (err) {
        generationError = err;
        console.error(`Generation failed for type ${generationType}:`, err.message);
      }

      const assistantMsg = generatedAttachment
        ? `Generated ${generationType.toUpperCase()} successfully: ${generatedAttachment.original_filename}`
        : `Could not generate ${generationType} for this request.${generationError ? ` Reason: ${generationError.message}` : ""}`;
      const assistantId = await messageModel.create(parsedSessionId, "assistant", assistantMsg);
      if (generatedAttachment) {
        await attachmentModel.linkToMessage(assistantId.id, generatedAttachment.id);
      }
    } else {
      const history = await messageModel.getBySessionId(parsedSessionId);
      const sources = deepSearch ? await deepSearchWeb(content) : [];
      if (sources.length > 0) {
        try {
          await indexWebSourcesForRag(req.user.id, parsedSessionId, sources);
        } catch (err) {
          console.error("Web RAG indexing failed:", err?.message || err);
        }
      }
      const crossChatContext = shouldReviewAcrossChats(content)
        ? await getCrossChatContext(req.user.id, parsedSessionId)
        : "";
      const ragContextResult = await buildRagContext(req.user.id, parsedSessionId, content, deepSearch || thinking ? 8 : 6);
      const combinedContext = [crossChatContext, ragContextResult.context].filter(Boolean).join("\n\n");
      let aiReply = await getAIReply(history, sessionAttachments, sources, combinedContext, model, !!thinking);
      if (sources.length > 0) {
        const links = sources
          .map((s) => `- [${s.title}](${s.url})`)
          .join("\n");
        aiReply += `\n\nSources:\n${links}`;
      }
      if (ragContextResult.citations.length > 0) {
        const ragLinks = ragContextResult.citations
          .map((item) => {
            const title = item.sourceUrl ? `[${item.title}](${item.sourceUrl})` : item.title;
            return `- [RAG ${item.ref}] ${title} (${item.sourceType}, chunk ${item.chunkIndex + 1})`;
          })
          .join("\n");
        aiReply += `\n\nKnowledge Base References:\n${ragLinks}`;
      }
      const codeExport = await offloadLargeCodeBlocksToFiles(parsedSessionId, content, aiReply, 100);
      const assistantRecord = await messageModel.create(parsedSessionId, "assistant", codeExport.content);
      for (const attachment of codeExport.attachments) {
        await attachmentModel.linkToMessage(assistantRecord.id, attachment.id);
      }
    }
    
    const messages = await messageModel.getBySessionId(parsedSessionId);
    res.json({ messages });
  } catch (err) {
    console.error("POST /api/messages error:", err);
    res.status(500).json({
      error: "Failed to send message",
      detail: process.env.NODE_ENV === "production" ? undefined : err.message,
    });
  }
});

app.post("/api/sessions/auto", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const firstPrompt = String(req.body?.firstPrompt || "").trim();
    const suggestedName = await suggestSessionNameFromPrompt(firstPrompt);
    const sequencedName = await ensureSequentialSessionName(userId, suggestedName || "New Chat");
    const session = await chatSessionModel.create(userId, sequencedName || null);
    res.status(201).json({ session });
  } catch (err) {
    console.error("POST /api/sessions/auto error:", err);
    res.status(500).json({ error: "Failed to auto-create session" });
  }
});

app.put("/api/sessions/:id", authMiddleware, async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    const name = String(req.body?.name || "").trim();
    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({ error: "Valid session id required" });
    }
    if (!name) {
      return res.status(400).json({ error: "Session name is required" });
    }
    const updated = await chatSessionModel.updateName(sessionId, req.user.id, name.slice(0, 255));
    if (!updated) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ session: updated });
  } catch (err) {
    console.error("PUT /api/sessions/:id error:", err);
    res.status(500).json({ error: "Failed to rename session" });
  }
});

app.post("/api/sessions/:id/share", authMiddleware, async (req, res) => {
  try {
    const sessionId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({ error: "Valid session id required" });
    }
    const session = await chatSessionModel.getById(sessionId, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to share this chat" });
    }

    let share = await shareChatModel.getBySessionId(sessionId);
    if (!share) {
      share = await shareChatModel.create(sessionId, req.user.id);
    }

    const base = process.env.FRONTEND_PUBLIC_URL || req.headers.origin || "http://localhost:5173";
    const shareUrl = `${base.replace(/\/$/, "")}/?share=${share.token}`;
    res.json({ token: share.token, shareUrl });
  } catch (err) {
    console.error("POST /api/sessions/:id/share error:", err);
    res.status(500).json({ error: "Failed to create share link" });
  }
});

app.get("/api/public/share/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Share token required" });
    }
    const share = await shareChatModel.getByToken(token);
    if (!share) {
      return res.status(404).json({ error: "Shared chat not found" });
    }

    const ownerSession = await db.query(
      "SELECT id, name, created_at FROM chat_sessions WHERE id = $1",
      [share.session_id]
    );
    if (!ownerSession.rows[0]) {
      return res.status(404).json({ error: "Shared chat not found" });
    }
    const messages = await messageModel.getBySessionId(share.session_id);
    const sanitized = messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
      attachments: Array.isArray(m.attachments)
        ? m.attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            file_type: a.file_type,
          }))
        : [],
    }));
    res.json({
      session: ownerSession.rows[0],
      token: share.token,
      messages: sanitized,
    });
  } catch (err) {
    console.error("GET /api/public/share/:token error:", err);
    res.status(500).json({ error: "Failed to load shared chat" });
  }
});

app.post("/api/public/share/:token/continue", authMiddleware, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Share token required" });
    }
    const share = await shareChatModel.getByToken(token);
    if (!share) {
      return res.status(404).json({ error: "Shared chat not found" });
    }

    const incomingHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const hasIncomingHistory = incomingHistory.length > 0;

    if (hasIncomingHistory) {
      const normalizedHistory = incomingHistory
        .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"))
        .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 12000) }))
        .slice(-120);

      const firstUser = normalizedHistory.find((m) => m.role === "user");
      const suggested = await suggestSessionNameFromPrompt(firstUser?.content || "Shared Chat");
      const sequencedName = await ensureSequentialSessionName(req.user.id, suggested || "Shared Chat");
      const newSession = await chatSessionModel.create(req.user.id, sequencedName || "Shared Chat");
      for (const m of normalizedHistory) {
        await messageModel.create(newSession.id, m.role, m.content);
      }
      const messages = await messageModel.getBySessionId(newSession.id);
      return res.json({ session: newSession, messages });
    }

    const sourceSessionRes = await db.query("SELECT id, name FROM chat_sessions WHERE id = $1", [share.session_id]);
    const sourceSession = sourceSessionRes.rows[0];
    if (!sourceSession) return res.status(404).json({ error: "Source chat not found" });

    const newSession = await chatSessionModel.create(
      req.user.id,
      sourceSession.name ? `${sourceSession.name} (shared copy)` : "Shared Chat Copy"
    );
    const sourceMessages = await messageModel.getBySessionId(sourceSession.id);
    for (const m of sourceMessages) await messageModel.create(newSession.id, m.role, m.content);
    const messages = await messageModel.getBySessionId(newSession.id);
    return res.json({ session: newSession, messages });
  } catch (err) {
    console.error("POST /api/public/share/:token/continue error:", err);
    res.status(500).json({ error: "Failed to continue shared chat" });
  }
});

app.post("/api/public/share/:token/chat", async (req, res) => {
  try {
    if (req.headers.authorization) {
      return res.status(403).json({ error: "Public share chat is disabled for logged-in sessions" });
    }
    const token = String(req.params.token || "").trim();
    const content = String(req.body?.content || "").trim();
    const model = String(req.body?.model || "sambanova").trim().toLowerCase();
    const thinking = !!req.body?.thinking;
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!token) return res.status(400).json({ error: "Share token required" });
    if (!content) return res.status(400).json({ error: "Message content is required" });

    const share = await shareChatModel.getByToken(token);
    if (!share) return res.status(404).json({ error: "Shared chat not found" });

    const sanitizedHistory = history
      .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"))
      .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 12000) }))
      .slice(-30);
    sanitizedHistory.push({ role: "user", content: content.slice(0, 12000) });

    const assistant = await getAIReply(sanitizedHistory, [], [], "", model, thinking);
    res.json({ assistant });
  } catch (err) {
    console.error("POST /api/public/share/:token/chat error:", err);
    res.status(500).json({ error: "Failed to process shared chat message" });
  }
});

app.post("/api/public/chat", async (req, res) => {
  try {
    if (req.headers.authorization) {
      return res.status(403).json({ error: "Public chat is disabled for logged-in sessions" });
    }
    const content = String(req.body?.content || "").trim();
    const model = String(req.body?.model || "sambanova").trim().toLowerCase();
    const thinking = !!req.body?.thinking;
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!content) return res.status(400).json({ error: "Message content is required" });

    const sanitizedHistory = history
      .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"))
      .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 12000) }))
      .slice(-30);
    sanitizedHistory.push({ role: "user", content: content.slice(0, 12000) });

    const assistant = await getAIReply(sanitizedHistory, [], [], "", model, thinking);
    res.json({ assistant });
  } catch (err) {
    console.error("POST /api/public/chat error:", err);
    res.status(500).json({ error: "Failed to process anonymous chat message" });
  }
});

app.put("/api/messages/:id", authMiddleware, async (req, res) => {
  try {
    const messageId = Number.parseInt(req.params.id, 10);
    const { content, deepSearch, rewriteThread, thinking, model } = req.body || {};
    if (!Number.isInteger(messageId) || !content || !String(content).trim()) {
      return res.status(400).json({ error: "Valid message id and content are required" });
    }
    if (messageId <= 0) {
      return res.status(400).json({ error: "Message id is out of valid range" });
    }

    const targetMessage = await messageModel.getById(messageId);
    if (!targetMessage) {
      return res.status(404).json({ error: "Message not found" });
    }
    if (targetMessage.role !== "user") {
      return res.status(400).json({ error: "Only user messages can be edited" });
    }

    const session = await chatSessionModel.getById(targetMessage.session_id, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to edit this message" });
    }

    const normalizedContent = String(content).trim();
    await messageModel.updateContent(messageId, normalizedContent);
    if (rewriteThread === true) {
      await messageModel.deleteAfterMessageInSession(targetMessage.session_id, messageId);
    }

    const sessionAttachments = await attachmentModel.getBySessionId(targetMessage.session_id);
    const generationType = detectGenerationRequest(normalizedContent);
    if (generationType) {
      let generatedAttachment = null;
      let generationError = null;
      try {
        const historyForGeneration = await messageModel.getBySessionId(targetMessage.session_id);
        const conversationContext = buildHistoryContext(historyForGeneration);
        if (generationType === "image") {
          generatedAttachment = await generateImageFile(targetMessage.session_id, normalizedContent);
        } else if (generationType === "ppt") {
          generatedAttachment = await generatePptFile(targetMessage.session_id, normalizedContent, conversationContext);
        } else if (generationType === "pdf") {
          generatedAttachment = await generatePdfFile(targetMessage.session_id, normalizedContent, conversationContext);
        } else if (generationType === "notes") {
          generatedAttachment = await generateNotesFile(targetMessage.session_id, normalizedContent, conversationContext);
        } else if (generationType === "document") {
          generatedAttachment = await generateDocumentFile(targetMessage.session_id, normalizedContent, conversationContext);
        }
      } catch (err) {
        generationError = err;
        console.error(`Generation failed after edit for type ${generationType}:`, err.message);
      }

      const assistantMsg = generatedAttachment
        ? `Edited request processed. Generated ${generationType.toUpperCase()}: ${generatedAttachment.original_filename}`
        : `Could not generate ${generationType} for this request.${generationError ? ` Reason: ${generationError.message}` : ""}`;
      const assistantId = await messageModel.create(targetMessage.session_id, "assistant", assistantMsg);
      if (generatedAttachment) {
        await attachmentModel.linkToMessage(assistantId.id, generatedAttachment.id);
      }
    } else {
      const history = await messageModel.getBySessionId(targetMessage.session_id);
      const sources = deepSearch ? await deepSearchWeb(normalizedContent) : [];
      if (sources.length > 0) {
        try {
          await indexWebSourcesForRag(req.user.id, targetMessage.session_id, sources);
        } catch (err) {
          console.error("Web RAG indexing failed during edit:", err?.message || err);
        }
      }
      const crossChatContext = shouldReviewAcrossChats(normalizedContent)
        ? await getCrossChatContext(req.user.id, targetMessage.session_id)
        : "";
      const ragContextResult = await buildRagContext(
        req.user.id,
        targetMessage.session_id,
        normalizedContent,
        deepSearch || thinking ? 8 : 6
      );
      const combinedContext = [crossChatContext, ragContextResult.context].filter(Boolean).join("\n\n");
      let aiReply = await getAIReply(history, sessionAttachments, sources, combinedContext, model, !!thinking);
      if (sources.length > 0) {
        const links = sources.map((s) => `- [${s.title}](${s.url})`).join("\n");
        aiReply += `\n\nSources:\n${links}`;
      }
      if (ragContextResult.citations.length > 0) {
        const ragLinks = ragContextResult.citations
          .map((item) => {
            const title = item.sourceUrl ? `[${item.title}](${item.sourceUrl})` : item.title;
            return `- [RAG ${item.ref}] ${title} (${item.sourceType}, chunk ${item.chunkIndex + 1})`;
          })
          .join("\n");
        aiReply += `\n\nKnowledge Base References:\n${ragLinks}`;
      }
      const codeExport = await offloadLargeCodeBlocksToFiles(targetMessage.session_id, normalizedContent, aiReply, 100);
      const assistantRecord = await messageModel.create(targetMessage.session_id, "assistant", codeExport.content);
      for (const attachment of codeExport.attachments) {
        await attachmentModel.linkToMessage(assistantRecord.id, attachment.id);
      }
    }

    const messages = await messageModel.getBySessionId(targetMessage.session_id);
    res.json({ messages });
  } catch (err) {
    console.error("PUT /api/messages/:id error:", err);
    res.status(500).json({
      error: "Failed to edit message",
      detail: process.env.NODE_ENV === "production" ? undefined : err.message,
    });
  }
});

app.post("/api/deep-search", authMiddleware, async (req, res) => {
  try {
    const { sessionId, query } = req.body;
    const parsedSessionId = Number.parseInt(sessionId, 10);
    if (!Number.isInteger(parsedSessionId) || !query || !query.trim()) {
      return res.status(400).json({ error: "Valid sessionId and query required" });
    }

    const session = await chatSessionModel.getById(parsedSessionId, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to access this session" });
    }

    const sources = await deepSearchWeb(query.trim());
    res.json({ sources });
  } catch (err) {
    console.error("POST /api/deep-search error:", err);
    res.status(500).json({ error: "Failed to run deep search" });
  }
});

app.post("/api/generate", authMiddleware, async (req, res) => {
  try {
    const { sessionId, type, prompt } = req.body;
    const parsedSessionId = Number.parseInt(sessionId, 10);
    if (!Number.isInteger(parsedSessionId) || !type || !prompt) {
      return res.status(400).json({ error: "sessionId, type and prompt are required" });
    }

    const session = await chatSessionModel.getById(parsedSessionId, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to access this session" });
    }

    let generatedAttachment = null;
    const normalized = String(type).toLowerCase();
    const historyForGeneration = await messageModel.getBySessionId(parsedSessionId);
    const conversationContext = buildHistoryContext(historyForGeneration);
    if (normalized === "image") {
      generatedAttachment = await generateImageFile(parsedSessionId, prompt);
    } else if (normalized === "ppt") {
      generatedAttachment = await generatePptFile(parsedSessionId, prompt, conversationContext);
    } else if (normalized === "pdf") {
      generatedAttachment = await generatePdfFile(parsedSessionId, prompt, conversationContext);
    } else if (normalized === "notes") {
      generatedAttachment = await generateNotesFile(parsedSessionId, prompt, conversationContext);
    } else if (normalized === "document") {
      generatedAttachment = await generateDocumentFile(parsedSessionId, prompt, conversationContext);
    } else {
      return res.status(400).json({ error: "Unsupported type. Use image|ppt|pdf|notes|document" });
    }

    const assistantMessage = await messageModel.create(
      parsedSessionId,
      "assistant",
      `Generated ${normalized.toUpperCase()}: ${generatedAttachment.original_filename}`
    );
    await attachmentModel.linkToMessage(assistantMessage.id, generatedAttachment.id);
    const messages = await messageModel.getBySessionId(parsedSessionId);
    res.json({ attachment: generatedAttachment, messages });
  } catch (err) {
    console.error("POST /api/generate error:", err);
    res.status(500).json({ error: err.message || "Failed to generate file" });
  }
});

// Attachments routes
app.post("/api/attachments", authMiddleware, chatUpload.array('files', 10), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });

    // Verify session belongs to user
    const session = await chatSessionModel.getById(parseInt(sessionId), req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to access this session" });
    }

    const attachmentIds = [];
    const attachments = [];
    
    for (const file of req.files) {
      const analysisResult = await analyzeFile(file.path, file.mimetype, file.originalname);
      const attachment = await attachmentModel.create(
        sessionId,
        file.filename,
        file.originalname,
        file.path,
        file.mimetype,
        file.size,
        analysisResult
      );
      await indexAttachmentForRag(req.user.id, parseInt(sessionId, 10), attachment);
      attachmentIds.push(attachment.id);
      attachments.push(attachment);
    }

    res.json({ 
      success: true, 
      attachmentIds,
      attachments,
      message: `${req.files.length} file(s) uploaded successfully`
    });
  } catch (err) {
    console.error("POST /api/attachments error:", err);
    res.status(500).json({ error: "Failed to upload attachments" });
  }
});

app.get("/api/attachments", authMiddleware, async (req, res) => {
  try {
    const sessionId = parseInt(req.query.sessionId, 10);
    
    // Verify session belongs to user
    const session = await chatSessionModel.getById(sessionId, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to access this session" });
    }
    
    const attachments = await attachmentModel.getBySessionId(sessionId);
    res.json({ attachments });
  } catch (err) {
    console.error("GET /api/attachments error:", err);
    res.status(500).json({ error: "Failed to fetch attachments" });
  }
});

app.get("/api/attachments/all", authMiddleware, async (req, res) => {
  try {
    const attachments = await attachmentModel.getByUserId(req.user.id);
    res.json({ attachments });
  } catch (err) {
    console.error("GET /api/attachments/all error:", err);
    res.status(500).json({ error: "Failed to fetch user attachments" });
  }
});

app.post("/api/attachments/:id/vision-analyze", authMiddleware, async (req, res) => {
  try {
    const attachmentId = parseInt(req.params.id, 10);
    if (!Number.isInteger(attachmentId)) {
      return res.status(400).json({ error: "Invalid attachment id" });
    }

    const attachment = await attachmentModel.getById(attachmentId);
    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found" });
    }

    const session = await chatSessionModel.getById(attachment.session_id, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to access this attachment" });
    }

    const lowerName = String(attachment.original_filename || attachment.filename || "").toLowerCase();
    const isImage =
      String(attachment.file_type || "").startsWith("image/") ||
      lowerName.endsWith(".png") ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg");

    if (!isImage) {
      return res.status(400).json({ error: "Vision analysis is supported only for image attachments" });
    }

    const filePath = resolveAttachmentDiskPath(attachment);
    if (!filePath) {
      return res.status(404).json({ error: "Stored attachment file is not available in this runtime" });
    }

    const analysisResult = await analyzeImageWithVision(filePath, attachment.file_type, attachment.original_filename);
    const updatedAttachment = await attachmentModel.updateAnalysisResult(attachmentId, analysisResult);
    if (!updatedAttachment) {
      return res.status(500).json({ error: "Failed to update attachment analysis" });
    }

    await indexAttachmentForRag(req.user.id, updatedAttachment.session_id, updatedAttachment);
    res.json({
      success: true,
      attachment: updatedAttachment,
    });
  } catch (err) {
    console.error("POST /api/attachments/:id/vision-analyze error:", err);
    res.status(500).json({ error: "Failed to analyze image attachment" });
  }
});

app.post("/api/attachments/:id/share-image", authMiddleware, async (req, res) => {
  try {
    const attachmentId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(attachmentId)) {
      return res.status(400).json({ error: "Invalid attachment id" });
    }

    const attachment = await attachmentModel.getById(attachmentId);
    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found" });
    }

    const session = await chatSessionModel.getById(attachment.session_id, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to share this attachment" });
    }

    if (!isImageAttachment(attachment)) {
      return res.status(400).json({ error: "Only image attachments can be shared as public image links" });
    }

    const token = createPublicImageShareToken(attachment.id);
    const shareUrl = `${getBackendPublicBaseUrl(req)}/api/public/images/${token}`;
    res.json({
      token,
      shareUrl,
      expiresIn: PUBLIC_IMAGE_SHARE_EXPIRY,
      attachment: {
        id: attachment.id,
        filename: attachment.original_filename || attachment.filename,
        file_type: attachment.file_type,
      },
    });
  } catch (err) {
    console.error("POST /api/attachments/:id/share-image error:", err);
    res.status(500).json({ error: "Failed to create public image link" });
  }
});

// Data upload and analytics
app.post("/api/upload-data", authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    // Verify session belongs to user
    const session = await chatSessionModel.getById(parseInt(sessionId), req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to access this session" });
    }

    const filePath = req.file.path;
    const data = [];
    const columns = new Set();

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        data.push(row);
        Object.keys(row).forEach(col => columns.add(col));
      })
      .on('end', async () => {
        try {
          const colArray = Array.from(columns);
          const cleanedData = cleanData(data, colArray);
          const stats = computeStats(cleanedData, colArray);

          const timestamp = Date.now();
          const cleanedFile = `cleaned_${timestamp}.csv`;
          const cleanedPath = path.join(generatedDir, cleanedFile);

          const csvWriter = createCsvWriter({
            path: cleanedPath,
            header: colArray.map(col => ({ id: col, title: col }))
          });

          await csvWriter.writeRecords(cleanedData);

          const reportFile = `report_${timestamp}.json`;
          const reportPath = path.join(generatedDir, reportFile);
          const reportContent = { columns: colArray, stats, rowCount: cleanedData.length };
          fs.writeFileSync(reportPath, JSON.stringify(reportContent, null, 2));

          // Save generated files as attachments linked to this session
          const cleanedAttachment = await attachmentModel.create(
            sessionId,
            cleanedFile,
            `Cleaned_${req.file.originalname}`,
            cleanedPath,
            'text/csv',
            fs.statSync(cleanedPath).size,
            JSON.stringify({ type: 'cleaned_csv', originalFile: req.file.originalname }),
            true // is_generated
          );

          const reportAttachment = await attachmentModel.create(
            sessionId,
            reportFile,
            `Report_${req.file.originalname.replace('.csv', '.json')}`,
            reportPath,
            'application/json',
            fs.statSync(reportPath).size,
            JSON.stringify({ type: 'analysis_report', stats, rowCount: cleanedData.length }),
            true // is_generated
          );

          fs.unlinkSync(filePath);

          res.json({
            message: "Data processed successfully",
            cleanedFile,
            reportFile,
            cleanedAttachmentId: cleanedAttachment.id,
            reportAttachmentId: reportAttachment.id,
            structure: { columns: colArray, rowCount: cleanedData.length }
          });
        } catch (err) {
          console.error("Error processing CSV data:", err);
          res.status(500).json({ error: "Failed to process CSV data" });
        }
      })
      .on('error', (err) => {
        console.error("CSV parsing error:", err);
        res.status(500).json({ error: "Failed to process CSV" });
      });
  } catch (err) {
    console.error("POST /api/upload-data error:", err);
    res.status(500).json({ error: "Failed to upload and process data" });
  }
});

// Download routes
app.get("/api/download/:filename", authMiddleware, (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(generatedDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.download(filePath, filename, (err) => {
    if (err) {
      console.error("Download error:", err);
      res.status(500).json({ error: "Failed to download file" });
    }
  });
});

app.get("/api/download-attachment/:id", authMiddleware, async (req, res) => {
  try {
    const attachmentId = parseInt(req.params.id, 10);
    
    const attachment = await attachmentModel.getById(attachmentId);

    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found" });
    }

    // Verify session belongs to user
    const session = await chatSessionModel.getById(attachment.session_id, req.user.id);
    if (!session) {
      return res.status(403).json({ error: "Unauthorized to download this attachment" });
    }

    const resolvedPath = resolveAttachmentDiskPath(attachment);
    if (!resolvedPath) {
      return res.status(404).json({
        error: "File not found on disk",
        detail:
          process.env.NODE_ENV === "production"
            ? undefined
            : "Stored attachment path is missing in this runtime. Re-upload file or move it to uploads/attachments/generated.",
      });
    }

    res.download(resolvedPath, attachment.original_filename, (err) => {
      if (err) {
        console.error("Download error:", err);
        res.status(500).json({ error: "Failed to download file" });
      }
    });
  } catch (err) {
    console.error("GET /api/download-attachment error:", err);
    res.status(500).json({ error: "Failed to download attachment" });
  }
});

app.get("/api/public/images/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Image token required" });
    }

    let payload;
    try {
      payload = verifyPublicImageShareToken(token);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired image link" });
    }

    if (payload?.type !== "public_image_share" || !Number.isInteger(payload?.attachmentId)) {
      return res.status(401).json({ error: "Invalid image link" });
    }

    const attachment = await attachmentModel.getById(payload.attachmentId);
    if (!attachment || !isImageAttachment(attachment)) {
      return res.status(404).json({ error: "Image not found" });
    }

    const resolvedPath = resolveAttachmentDiskPath(attachment);
    if (!resolvedPath) {
      return res.status(404).json({ error: "Image file not found on disk" });
    }

    res.setHeader("Content-Type", attachment.file_type || "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(attachment.original_filename || attachment.filename || "image")}"`);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(resolvedPath);
  } catch (err) {
    console.error("GET /api/public/images/:token error:", err);
    res.status(500).json({ error: "Failed to load public image" });
  }
});

// Helper functions
function cleanData(data, columns) {
  const seen = new Set();
  const cleaned = data.filter(row => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  columns.forEach(col => {
    const values = cleaned.map(row => parseFloat(row[col])).filter(v => !isNaN(v));
    if (values.length > 0) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      cleaned.forEach(row => {
        if (row[col] === '' || row[col] == null || isNaN(parseFloat(row[col]))) {
          row[col] = mean.toString();
        }
      });
    }
  });

  return cleaned;
}

function computeStats(data, columns) {
  const stats = {};
  columns.forEach(col => {
    const values = data.map(row => parseFloat(row[col])).filter(v => !isNaN(v));
    if (values.length > 0) {
      const sorted = values.sort((a, b) => a - b);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
      stats[col] = {
        count: values.length,
        mean: mean.toFixed(2),
        median: median.toFixed(2)
      };
    } else {
      stats[col] = { count: 0, mean: 'N/A', median: 'N/A' };
    }
  });
  return stats;
}

// Global error handler (including request body size violations)
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({
      error: "Request payload too large",
      detail: `Reduce message size or increase REQUEST_BODY_LIMIT (current: ${REQUEST_BODY_LIMIT})`,
    });
  }
  if (err) {
    console.error("Unhandled server error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
  next();
});

// Start server
initializeApp().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Backend running at http://localhost:${PORT}`);
    console.log("Allowed origins:", ALLOWED_ORIGINS);
  });
}).catch(err => {
  console.error("❌ Failed to start server:", err);
  process.exit(1);
});
