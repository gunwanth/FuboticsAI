require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Groq = require("groq-sdk");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

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
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (allowedTypes.includes(file.mimetype) || 
        ['.csv', '.txt', '.json', '.pdf', '.png', '.jpg', '.jpeg', '.xls', '.xlsx'].includes(path.extname(file.originalname).toLowerCase())) {
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
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin || "";
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
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES users(id)`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding user_id column:', err.message);
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      session_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT,
      file_size INTEGER,
      analysis_result TEXT,
      is_generated BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`ALTER TABLE attachments ADD COLUMN is_generated BOOLEAN DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding is_generated column:', err.message);
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS message_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      attachment_id INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (attachment_id) REFERENCES attachments(id)
    )
  `);

  console.log("✅ SQLite ready (chat.db)");
});

// ---------- DB HELPERS ----------
function createSession(name = null, userId = null) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO sessions (name, user_id) VALUES (?, ?)",
      [name, userId],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, name, user_id: userId, created_at: new Date().toISOString() });
      }
    );
  });
}

function getSessions(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT id, name, created_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC",
      [userId],
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
      db.run("DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)", [sessionId]);
      db.run("DELETE FROM messages WHERE session_id = ?", [sessionId]);
      db.run("DELETE FROM attachments WHERE session_id = ?", [sessionId]);
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
      `SELECT m.id, m.role, m.content, m.created_at,
              GROUP_CONCAT(a.id) as attachment_ids,
              GROUP_CONCAT(a.original_filename) as attachment_names
       FROM messages m
       LEFT JOIN message_attachments ma ON m.id = ma.message_id
       LEFT JOIN attachments a ON ma.attachment_id = a.id
       WHERE m.session_id = ?
       GROUP BY m.id
       ORDER BY m.id ASC`,
      [sessionId],
      (err, rows) => {
        if (err) return reject(err);
        const messages = rows.map(row => ({
          id: row.id,
          role: row.role,
          content: row.content,
          created_at: row.created_at,
          attachments: row.attachment_ids ? row.attachment_ids.split(',').map((id, idx) => ({
            id: parseInt(id),
            filename: row.attachment_names.split(',')[idx]
          })) : []
        }));
        resolve(messages);
      }
    );
  });
}

function insertAttachment(sessionId, filename, originalFilename, filePath, fileType, fileSize, analysisResult = null, isGenerated = false) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO attachments (session_id, filename, original_filename, file_path, file_type, file_size, analysis_result, is_generated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [sessionId, filename, originalFilename, filePath, fileType, fileSize, analysisResult, isGenerated ? 1 : 0],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function linkMessageAttachment(messageId, attachmentId) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO message_attachments (message_id, attachment_id) VALUES (?, ?)",
      [messageId, attachmentId],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function getAttachmentsBySession(sessionId) {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at DESC",
      [sessionId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

// ---------- USERS / AUTH HELPERS ----------
const JWT_SECRET = process.env.JWT_SECRET || "please_change_this_secret";

function createUser(username, password) {
  return new Promise((resolve, reject) => {
    const pwHash = bcrypt.hashSync(password, 10);
    db.run(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)",
      [username, pwHash],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, username });
      }
    );
  });
}

function findUserByUsername(username) {
  return new Promise((resolve, reject) => {
    db.get("SELECT id, username, password_hash FROM users WHERE username = ?", [username], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Missing token" });
  const token = auth.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ---------- FILE ANALYSIS HELPERS ----------
async function analyzeFile(filePath, fileType, originalFilename) {
  try {
    let content = '';
    
    if (fileType === 'text/csv' || originalFilename.endsWith('.csv')) {
      const rows = [];
      return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => rows.push(row))
          .on('end', () => {
            const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
            const summary = {
              type: 'csv',
              rows: rows.length,
              columns: columns,
              sample: rows.slice(0, 3)
            };
            resolve(JSON.stringify(summary));
          })
          .on('error', reject);
      });
    } else if (fileType === 'text/plain' || fileType === 'application/json') {
      content = fs.readFileSync(filePath, 'utf8');
      return JSON.stringify({
        type: fileType === 'application/json' ? 'json' : 'text',
        preview: content.substring(0, 1000),
        size: content.length
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

async function getAIReply(history, sessionAttachments = []) {
  try {
    let systemContent = "You are a helpful assistant.";
    
    if (sessionAttachments.length > 0) {
      systemContent += "\n\nYou have access to the following files uploaded in this conversation:\n";
      for (const att of sessionAttachments) {
        systemContent += `\n- ${att.original_filename} (${att.file_type})`;
        if (att.analysis_result) {
          try {
            const analysis = JSON.parse(att.analysis_result);
            if (analysis.type === 'csv') {
              systemContent += `\n  CSV file with ${analysis.rows} rows and columns: ${analysis.columns.join(', ')}`;
            } else if (analysis.preview) {
              systemContent += `\n  Preview: ${analysis.preview.substring(0, 200)}...`;
            }
          } catch (e) {
            systemContent += `\n  ${att.analysis_result}`;
          }
        }
      }
      systemContent += "\n\nWhen users ask about these files, reference the information provided above.";
    }

    const messages = [
      { role: "system", content: systemContent },
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
app.get("/api/health", (req, res) => {
  res.json({ ok: true, allowed_origins: ALLOWED_ORIGINS });
});

app.get("/api/sessions", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    res.json({ sessions: await getSessions(userId) });
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
    const session = await createSession(name, userId);
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
    const session = await new Promise((resolve, reject) => {
      db.get("SELECT user_id FROM sessions WHERE id = ?", [sessionId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    if (!session || session.user_id !== userId) {
      return res.status(403).json({ error: "Unauthorized to delete this session" });
    }
    
    const attachments = await getAttachmentsBySession(sessionId);
    for (const att of attachments) {
      try {
        if (fs.existsSync(att.file_path)) {
          fs.unlinkSync(att.file_path);
        }
      } catch (err) {
        console.error('Error deleting attachment file:', err);
      }
    }
    
    await deleteSession(sessionId);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/sessions error:", err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

app.get("/api/messages", authMiddleware, async (req, res) => {
  try {
    const sessionId = parseInt(req.query.sessionId, 10);
    res.json({ messages: await getMessagesBySession(sessionId) });
  } catch (err) {
    console.error("GET /api/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.post("/api/attachments", authMiddleware, chatUpload.array('files', 10), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });

    const attachmentIds = [];
    
    for (const file of req.files) {
      const analysisResult = await analyzeFile(file.path, file.mimetype, file.originalname);
      const attachmentId = await insertAttachment(
        sessionId,
        file.filename,
        file.originalname,
        file.path,
        file.mimetype,
        file.size,
        analysisResult
      );
      attachmentIds.push(attachmentId);
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
    const attachments = await getAttachmentsBySession(sessionId);
    res.json({ attachments });
  } catch (err) {
    console.error("GET /api/attachments error:", err);
    res.status(500).json({ error: "Failed to fetch attachments" });
  }
});

app.post("/api/messages", authMiddleware, async (req, res) => {
  try {
    const { sessionId, content, attachmentIds } = req.body;
    
    const sessionAttachments = await getAttachmentsBySession(sessionId);
    
    const messageId = await insertMessage(sessionId, "user", content);
    
    if (attachmentIds && Array.isArray(attachmentIds)) {
      for (const attId of attachmentIds) {
        await linkMessageAttachment(messageId, attId);
      }
    }
    
    const history = await getMessagesBySession(sessionId);
    const aiReply = await getAIReply(history, sessionAttachments);
    await insertMessage(sessionId, "assistant", aiReply);
    
    res.json({ messages: await getMessagesBySession(sessionId) });
  } catch (err) {
    console.error("POST /api/messages error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

app.post("/api/signup", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });

    const existing = await findUserByUsername(username);
    if (existing) return res.status(409).json({ error: "username taken" });

    const user = await createUser(username, password);
    const token = signToken(user);
    res.status(201).json({ user: { id: user.id, username: user.username }, token });
  } catch (err) {
    console.error("POST /api/signup error:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });

    const user = await findUserByUsername(username);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken(user);
    res.json({ user: { id: user.id, username: user.username }, token });
  } catch (err) {
    console.error("POST /api/login error:", err);
    res.status(500).json({ error: "Failed to login" });
  }
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.post("/api/upload-data", authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

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
          const cleanedAttachmentId = await insertAttachment(
            sessionId,
            cleanedFile,
            `Cleaned_${req.file.originalname}`,
            cleanedPath,
            'text/csv',
            fs.statSync(cleanedPath).size,
            JSON.stringify({ type: 'cleaned_csv', originalFile: req.file.originalname }),
            true // is_generated
          );

          const reportAttachmentId = await insertAttachment(
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
            cleanedAttachmentId,
            reportAttachmentId,
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

// Download attachment by ID
app.get("/api/download-attachment/:id", authMiddleware, async (req, res) => {
  try {
    const attachmentId = parseInt(req.params.id, 10);
    
    const attachment = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM attachments WHERE id = ?", [attachmentId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found" });
    }

    if (!fs.existsSync(attachment.file_path)) {
      return res.status(404).json({ error: "File not found on disk" });
    }

    res.download(attachment.file_path, attachment.original_filename, (err) => {
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

app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
  console.log("Allowed origins:", ALLOWED_ORIGINS);
});