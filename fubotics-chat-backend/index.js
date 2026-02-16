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

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- CORS (dynamic allowlist) ----------
const defaultOrigins = [
  "http://localhost:5173",
  "https://fubotics-ai.vercel.app",
  "https://fuboticsai.onrender.com"
];

const envList = process.env.FRONTEND_ORIGINS
  ? process.env.FRONTEND_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

const ALLOWED_ORIGINS = Array.from(new Set([...envList, ...defaultOrigins]));

app.use(express.json());

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
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("CORS origin denied: " + origin));
  },
  methods: ["GET", "POST", "PUT", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin || "";
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
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
const sambaNovaPromptModel = process.env.SAMBANOVA_IMAGE_PROMPT_MODEL || "Meta-Llama-3.3-70B-Instruct";
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
const extractionMaxChars = Math.min(
  120000,
  Math.max(4000, Number.parseInt(process.env.EXTRACTION_MAX_CHARS || "30000", 10))
);

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
  return raw.split(/\s+/).slice(0, 6).join(" ").slice(0, 60) || "New Chat";
}

function renderAttachmentInsight(analysis) {
  if (!analysis || typeof analysis !== "object") return "";
  const richText = String(analysis.extracted_text || analysis.preview || "").substring(0, 6000);
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

async function generateDocumentFile(sessionId, prompt, contextText = "") {
  const content = await generateNarrative(prompt, "word document", contextText);
  const filename = `document_${Date.now()}.docx`;
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
  const filename = `document_${Date.now()}.pdf`;
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
  const filename = `presentation_${Date.now()}.pptx`;
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
  const filename = `notes_${Date.now()}.md`;
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

async function buildImagePromptWithSamba(userPrompt) {
  if (!sambaNovaApiKey) {
    return userPrompt;
  }
  try {
    const resp = await axios.post(
      `${sambaNovaBaseUrl}/chat/completions`,
      {
        model: sambaNovaPromptModel,
        temperature: 0.4,
        max_tokens: 500,
        messages: [
          {
            role: "system",
            content:
              "You are an expert prompt engineer for text-to-image models. Return one detailed visual prompt only.",
          },
          {
            role: "user",
            content: `Create a production-grade text-to-image prompt for: ${userPrompt}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${sambaNovaApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );
    return resp.data?.choices?.[0]?.message?.content?.trim() || userPrompt;
  } catch (err) {
    console.error("SambaNova prompt generation failed, using raw prompt:", err.message);
    return userPrompt;
  }
}

async function generateImageFile(sessionId, prompt) {
  let imageBuffer = null;
  let imageMime = "image/png";
  const promptForGenerator = await buildImagePromptWithSamba(prompt);

  async function generateImageWithFreepik(textPrompt) {
    const baseUrl =
      freepikImageModel === "mystic"
        ? "https://api.freepik.com/v1/ai/mystic"
        : `https://api.freepik.com/v1/ai/text-to-image/${encodeURIComponent(freepikImageModel)}`;
    const createRes = await axios.post(
      baseUrl,
      {
        prompt: textPrompt,
        aspect_ratio: "square_1_1",
        output_format: "png",
      },
      {
        headers: {
          "x-freepik-api-key": freepikApiKey,
          "Content-Type": "application/json",
        },
        timeout: 60000,
        validateStatus: () => true,
      }
    );

    if (createRes.status >= 400) {
      throw new Error(`Freepik create task failed (${createRes.status}): ${JSON.stringify(createRes.data).slice(0, 260)}`);
    }

    const taskId = createRes.data?.data?.task_id;
    if (!taskId) {
      throw new Error("Freepik did not return task_id");
    }

    for (let i = 0; i < freepikPollAttempts; i++) {
      const pollRes = await axios.get(`${baseUrl}/${taskId}`, {
        headers: {
          "x-freepik-api-key": freepikApiKey,
        },
        timeout: 45000,
        validateStatus: () => true,
      });

      if (pollRes.status >= 400) {
        throw new Error(`Freepik poll failed (${pollRes.status}): ${JSON.stringify(pollRes.data).slice(0, 260)}`);
      }

      const payload = pollRes.data?.data || {};
      const generated = Array.isArray(payload.generated) ? payload.generated : [];
      if (generated.length > 0 && generated[0]) {
        const imageUrl = generated[0];
        const imageRes = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 60000,
          validateStatus: () => true,
        });
        if (imageRes.status >= 400) {
          throw new Error(`Freepik image download failed (${imageRes.status})`);
        }
        const contentType = imageRes.headers["content-type"] || "image/png";
        return { buffer: Buffer.from(imageRes.data), mime: contentType };
      }

      const status = String(payload.status || "").toUpperCase();
      if (status === "FAILED" || status === "REJECTED" || status === "CANCELLED") {
        throw new Error(`Freepik task ended with status ${status}`);
      }

      await new Promise((r) => setTimeout(r, freepikPollIntervalMs));
    }

    throw new Error("Freepik task timed out");
  }

  if (!imageBuffer && freepikApiKey) {
    try {
      const freepikImage = await generateImageWithFreepik(promptForGenerator);
      imageBuffer = freepikImage.buffer;
      imageMime = freepikImage.mime;
      console.warn("Image generation used Freepik provider.");
    } catch (err) {
      console.error("Freepik image generation failed:", err.message);
    }
  }

  if (!imageBuffer && huggingFaceApiKey) {
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const hfRes = await axios.post(
          `https://router.huggingface.co/hf-inference/models/${encodeURIComponent(huggingFaceImageModel)}`,
          { inputs: promptForGenerator },
          {
            headers: {
              Authorization: `Bearer ${huggingFaceApiKey}`,
              "Content-Type": "application/json",
              Accept: "image/png",
            },
            responseType: "arraybuffer",
            timeout: 90000,
            validateStatus: () => true,
          }
        );

        const contentType = hfRes.headers["content-type"] || "";
        if (contentType.startsWith("image/")) {
          imageBuffer = Buffer.from(hfRes.data);
          imageMime = contentType;
          break;
        }

        const bodyText = Buffer.from(hfRes.data).toString("utf8");
        let payload = {};
        try {
          payload = JSON.parse(bodyText);
        } catch (_) {
          payload = { error: bodyText.substring(0, 300) };
        }

        if (payload?.estimated_time) {
          await new Promise((r) => setTimeout(r, Math.ceil(payload.estimated_time * 1000)));
          continue;
        }
        throw new Error(
          payload?.error ||
            payload?.message ||
            `Hugging Face request failed with status ${hfRes.status}`
        );
      } catch (err) {
        lastError = err;
      }
    }
    if (!imageBuffer && lastError) {
      console.error("Hugging Face image generation failed:", lastError.message);
    }
  }

  if (!imageBuffer && pollinationsBaseUrl) {
    try {
      const pollinationsUrl = `${pollinationsBaseUrl}/prompt/${encodeURIComponent(promptForGenerator)}?model=${encodeURIComponent(pollinationsImageModel)}&width=1024&height=1024&nologo=true`;
      const pollinationsRes = await axios.get(pollinationsUrl, {
        responseType: "arraybuffer",
        timeout: 90000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      });
      imageBuffer = Buffer.from(pollinationsRes.data);
      imageMime = pollinationsRes.headers["content-type"] || "image/png";
      console.warn("Image generation used Pollinations fallback provider.");
    } catch (err) {
      console.error("Pollinations fallback failed:", err.message);
    }
  }

  if (!imageBuffer) {
    const query = encodeURIComponent((prompt || "art image").slice(0, 180));
    const webImageCandidates = [
      `https://source.unsplash.com/1024x1024/?${query}`,
      `https://loremflickr.com/1024/1024/${query}`,
    ];
    for (const candidate of webImageCandidates) {
      try {
        const webRes = await axios.get(candidate, {
          responseType: "arraybuffer",
          timeout: 45000,
          maxRedirects: 5,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          validateStatus: () => true,
        });
        const ct = (webRes.headers["content-type"] || "").toLowerCase();
        if (ct.startsWith("image/")) {
          imageBuffer = Buffer.from(webRes.data);
          imageMime = ct;
          console.warn(`Image generation used web-scraped fallback: ${candidate}`);
          break;
        }
      } catch (err) {
        console.error(`Web image fallback failed for ${candidate}:`, err.message);
      }
    }
  }

  if (!imageBuffer) {
    imageBuffer = createFallbackPng(prompt);
    imageMime = "image/png";
    console.warn("All remote image providers failed. Served local PNG fallback image.");
  }
  const ext = imageMime.includes("jpeg")
    ? "jpg"
    : imageMime.includes("webp")
    ? "webp"
    : "png";
  const filename = `image_${Date.now()}.${ext}`;
  const filePath = path.join(generatedDir, filename);
  fs.writeFileSync(filePath, imageBuffer);
  return attachmentModel.create(
    sessionId,
    filename,
    filename,
    filePath,
    imageMime,
    fs.statSync(filePath).size,
    JSON.stringify({ type: "generated_image", prompt }),
    true
  );
}

function detectGenerationRequest(content) {
  const text = (content || "").toLowerCase();
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

async function getAIReply(history, sessionAttachments = [], webSources = [], extraContext = "") {
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

    const messages = [
      { role: "system", content: systemContent },
      ...history.map((m) => ({ role: m.role, content: m.content }))
    ];

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: webSources.length > 0 ? aiDeepSearchMaxTokens : aiDefaultMaxTokens,
      temperature: 0.7,
    });

    return response.choices?.[0]?.message?.content || "No reply from AI";
  } catch (err) {
    console.error("❌ Groq error:", err.message || err);
    return "AI is currently unavailable, your backend and DB are working 🙂";
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

// ---------- ROUTES ----------

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, allowed_origins: ALLOWED_ORIGINS });
});

// Auth routes
app.post("/api/signup", authController.signup);
app.post("/api/login", authController.login);
app.post("/api/refresh", authController.refresh);
app.post("/api/logout", authController.logout);
app.get("/api/me", authMiddleware, authController.me);
app.get("/api/session-logs", authMiddleware, authController.getSessionLogs);
app.post("/api/logout-all", authMiddleware, authController.logoutAll);

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
    const { sessionId, content, attachmentIds, deepSearch } = req.body;
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
      const crossChatContext = shouldReviewAcrossChats(content)
        ? await getCrossChatContext(req.user.id, parsedSessionId)
        : "";
      let aiReply = await getAIReply(history, sessionAttachments, sources, crossChatContext);
      if (sources.length > 0) {
        const links = sources
          .map((s) => `- [${s.title}](${s.url})`)
          .join("\n");
        aiReply += `\n\nSources:\n${links}`;
      }
      await messageModel.create(parsedSessionId, "assistant", aiReply);
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
    const session = await chatSessionModel.create(userId, suggestedName || null);
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
      const newSession = await chatSessionModel.create(req.user.id, suggested || "Shared Chat");
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
    const token = String(req.params.token || "").trim();
    const content = String(req.body?.content || "").trim();
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

    const assistant = await getAIReply(sanitizedHistory, [], [], "");
    res.json({ assistant });
  } catch (err) {
    console.error("POST /api/public/share/:token/chat error:", err);
    res.status(500).json({ error: "Failed to process shared chat message" });
  }
});

app.post("/api/public/chat", async (req, res) => {
  try {
    const content = String(req.body?.content || "").trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!content) return res.status(400).json({ error: "Message content is required" });

    const sanitizedHistory = history
      .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"))
      .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 12000) }))
      .slice(-30);
    sanitizedHistory.push({ role: "user", content: content.slice(0, 12000) });

    const assistant = await getAIReply(sanitizedHistory, [], [], "");
    res.json({ assistant });
  } catch (err) {
    console.error("POST /api/public/chat error:", err);
    res.status(500).json({ error: "Failed to process anonymous chat message" });
  }
});

app.put("/api/messages/:id", authMiddleware, async (req, res) => {
  try {
    const messageId = Number.parseInt(req.params.id, 10);
    const { content, deepSearch, rewriteThread } = req.body || {};
    if (!Number.isInteger(messageId) || !content || !String(content).trim()) {
      return res.status(400).json({ error: "Valid message id and content are required" });
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
      const crossChatContext = shouldReviewAcrossChats(normalizedContent)
        ? await getCrossChatContext(req.user.id, targetMessage.session_id)
        : "";
      let aiReply = await getAIReply(history, sessionAttachments, sources, crossChatContext);
      if (sources.length > 0) {
        const links = sources.map((s) => `- [${s.title}](${s.url})`).join("\n");
        aiReply += `\n\nSources:\n${links}`;
      }
      await messageModel.create(targetMessage.session_id, "assistant", aiReply);
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
      attachmentIds.push(attachment.id);
    }

    res.json({ 
      success: true, 
      attachmentIds,
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
