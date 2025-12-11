require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const Groq = require("groq-sdk");

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- CORS (dynamic allowlist) ----------
// Provide allowed frontend origins via env var FRONTEND_ORIGINS (comma separated)
// Example: FRONTEND_ORIGINS="http://localhost:5173,https://fubotics-ai.vercel.app"
const defaultOrigins = [
  "http://localhost:5173",
  "https://fubotics-ai.vercel.app",     // <- replace with your Vercel domain
  "https://fuboticsai.onrender.com"    // backend origin (optional)
];

const envList = process.env.FRONTEND_ORIGINS
  ? process.env.FRONTEND_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

const ALLOWED_ORIGINS = Array.from(new Set([...envList, ...defaultOrigins]));

app.use(express.json());

// CORS middleware with dynamic origin verification
app.use(cors({
  origin: function(origin, callback) {
    // allow non-browser requests (curl, server-to-server) where origin is undefined
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // otherwise reject
    return callback(new Error("CORS origin denied: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Ensure Express responds to preflight OPTIONS for all routes
// Ensure Express handles OPTIONS preflight for all routes (safe — avoids path-to-regexp)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin || "";
    // allow non-browser requests like curl (origin undefined)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin || "*");
      res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS,DELETE");
      res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
      return res.sendStatus(200);
    }
    return res.status(403).send("CORS origin denied");
  }
  next();
});


// ---------- DB SETUP ----------
const db = new sqlite3.Database("./chat.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      session_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("✅ SQLite ready (chat.db)");
});

// ---------- DB HELPERS ----------
function createSession(name = null) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO sessions (name) VALUES (?)",
      [name],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, name, created_at: new Date().toISOString() });
      }
    );
  });
}

function getSessions() {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT id, name, created_at FROM sessions ORDER BY created_at DESC",
      [],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

function deleteSession(sessionId) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("DELETE FROM messages WHERE session_id = ?", [sessionId]);
      db.run("DELETE FROM sessions WHERE id = ?", [sessionId], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

function insertMessage(sessionId, role, content) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
      [sessionId, role, content],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function getMessagesBySession(sessionId) {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
      [sessionId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

// ---------- GROQ / AI SETUP ----------
const groqKey = process.env.GROQ_API_KEY;
if (!groqKey) {
  console.warn("⚠️ GROQ_API_KEY is NOT set in environment!");
} else {
  console.log("✅ GROQ_API_KEY loaded.");
}
const groq = new Groq({ apiKey: groqKey });

async function getAIReply(history) {
  try {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      ...history.map((m) => ({ role: m.role, content: m.content }))
    ];

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 2048,
      temperature: 0.7,
    });

    return response.choices?.[0]?.message?.content || "No reply from AI";
  } catch (err) {
    console.error("❌ Groq error:", err.message || err);
    return "AI is currently unavailable, your backend and DB are working 🙂";
  }
}

// ---------- ROUTES ----------
// Health
app.get("/api/health", (req, res) => {
  res.json({ ok: true, allowed_origins: ALLOWED_ORIGINS });
});

// List sessions
app.get("/api/sessions", async (req, res) => {
  try {
    res.json({ sessions: await getSessions() });
  } catch (err) {
    console.error("GET /api/sessions error:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// Create session
app.post("/api/sessions", async (req, res) => {
  try {
    console.log("📥 POST /api/sessions body:", req.body, "origin:", req.headers.origin);
    let name = null;
    if (req.body && typeof req.body.name === "string") {
      name = req.body.name.trim();
      if (name === "") name = null;
    }
    const session = await createSession(name);
    console.log("💾 Created session:", session);
    res.status(201).json({ session });
  } catch (err) {
    console.error("❌ Failed to create session:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// Delete session
app.delete("/api/sessions/:id", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    await deleteSession(sessionId);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/sessions error:", err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// Get messages by session
app.get("/api/messages", async (req, res) => {
  try {
    const sessionId = parseInt(req.query.sessionId, 10);
    res.json({ messages: await getMessagesBySession(sessionId) });
  } catch (err) {
    console.error("GET /api/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Send message
app.post("/api/messages", async (req, res) => {
  try {
    const { sessionId, content } = req.body;
    await insertMessage(sessionId, "user", content);
    const history = await getMessagesBySession(sessionId);
    const aiReply = await getAIReply(history);
    await insertMessage(sessionId, "assistant", aiReply);
    res.json({ messages: await getMessagesBySession(sessionId) });
  } catch (err) {
    console.error("POST /api/messages error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
  console.log("Allowed origins:", ALLOWED_ORIGINS);
});