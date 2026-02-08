import { useEffect, useState, useRef } from "react";
import axios from "axios";
import "./App.css";

// App.jsx (top)
const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [token, setToken] = useState(localStorage.getItem("token") || null);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(window.innerWidth > 768);
  const [isTyping, setIsTyping] = useState(false);
  const chatWindowRef = useRef(null);

  // Load sessions on mount
  useEffect(() => {
    if (token) {
      axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    }
    fetchSessions();
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth <= 768 && sidebarVisible) {
        // Don't auto-close on mobile, let user control it
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [sidebarVisible]);

  // Try restore session (validate token)
  useEffect(() => {
    const t = localStorage.getItem("token");
    if (t && !token) setToken(t);
  }, []);

  // keep axios header in sync when token changes
  useEffect(() => {
    if (token) axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    else delete axios.defaults.headers.common["Authorization"];
  }, [token]);

  // Simple auth screen shown before entering the chat UI
  function AuthScreen() {
    const [localUser, setLocalUser] = useState("");
    const [localPass, setLocalPass] = useState("");
    const [localMode, setLocalMode] = useState("login");

    async function handleLocalSubmit(e) {
      e.preventDefault();
      try {
        const path = localMode === "signup" ? "/api/signup" : "/api/login";
        const res = await axios.post(`${API_BASE}${path}`, { username: localUser, password: localPass });
        const t = res.data.token;
        if (t) {
          setToken(t);
          localStorage.setItem("token", t);
          axios.defaults.headers.common["Authorization"] = `Bearer ${t}`;
          setLocalUser("");
          setLocalPass("");
          // refresh sessions/messages as authenticated user
          fetchSessions();
        }
      } catch (err) {
        console.error("Auth error", err.response?.data || err.message || err);
        alert(err.response?.data?.error || "Auth failed");
      }
    }

    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-logo">
            <div className="logo-icon">AI</div>
            <h2>Fubotics AI</h2>
          </div>
          <h3>{localMode === "login" ? "Welcome Back" : "Create Account"}</h3>
          <form onSubmit={handleLocalSubmit} className="auth-form">
            <div className="input-group">
              <input 
                placeholder="Username" 
                value={localUser} 
                onChange={(e) => setLocalUser(e.target.value)}
                required 
              />
            </div>
            <div className="input-group">
              <input 
                placeholder="Password" 
                type="password" 
                value={localPass} 
                onChange={(e) => setLocalPass(e.target.value)}
                required 
              />
            </div>
            <button type="submit" className="primary-btn">
              {localMode === "login" ? "Login" : "Create Account"}
            </button>
            <button 
              type="button" 
              className="secondary-btn"
              onClick={() => setLocalMode(localMode === "login" ? "signup" : "login")}
            >
              {localMode === "login" ? "Need an account?" : "Already have an account?"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  async function fetchSessions() {
    try {
      const res = await axios.get(`${API_BASE}/api/sessions`);
      const list = res.data.sessions || [];
      setSessions(list);

      if (list.length > 0) {
        const first = list[0].id;
        setSelectedSessionId(first);
        await fetchMessages(first);
      }
    } catch (err) {
      console.error("Error loading sessions", err);
    }
  }

  function handleLogout() {
    setToken(null);
    localStorage.removeItem("token");
    delete axios.defaults.headers.common["Authorization"];
  }

  async function fetchMessages(sessionId) {
    try {
      const res = await axios.get(`${API_BASE}/api/messages`, {
        params: { sessionId },
      });
      setMessages(res.data.messages || []);
    } catch (err) {
      console.error("Error loading messages", err);
      setMessages([]);
    }
  }

  async function handleNewChat() {
    try {
      const defaultName = `Chat ${sessions.length + 1}`;
      const userInput = window.prompt("Enter chat name (optional):", defaultName);

      if (userInput === null) return; // cancelled

      const name = userInput.trim() === "" ? defaultName : userInput.trim();

      const res = await axios.post(`${API_BASE}/api/sessions`, { name });
      const newSession = res.data.session;

      setSessions((prev) => [newSession, ...prev]);
      setSelectedSessionId(newSession.id);
      setMessages([]);
      
      // Close sidebar on mobile after creating chat
      if (window.innerWidth <= 768) {
        setSidebarVisible(false);
      }
    } catch (err) {
      console.error("Error creating session", err);
      alert("Failed to create chat");
    }
  }

  async function handleDeleteSession(sessionId, e) {
    e.stopPropagation(); // avoid selecting chat

    try {
      await axios.delete(`${API_BASE}/api/sessions/${sessionId}`);
      const remaining = sessions.filter((s) => s.id !== sessionId);

      setSessions(remaining);

      if (selectedSessionId === sessionId) {
        if (remaining.length > 0) {
          const next = remaining[0].id;
          setSelectedSessionId(next);
          await fetchMessages(next);
        } else {
          setSelectedSessionId(null);
          setMessages([]);
        }
      }
    } catch (err) {
      console.error("Error deleting session", err);
    }
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    if (!selectedSessionId) {
      alert("Please create a chat first");
      return;
    }

    const text = input.trim();
    setInput("");
    setLoading(true);

    // Optimistic UI
    setMessages((prev) => [...prev, { id: Date.now(), role: "user", content: text }]);

    setIsTyping(true);
    try {
      const res = await axios.post(`${API_BASE}/api/messages`, {
        sessionId: selectedSessionId,
        content: text,
      });
      setMessages(res.data.messages || []);
    } catch (err) {
      console.error("Send error", err);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: "assistant",
          content: "Error talking to server",
        },
      ]);
    } finally {
      setLoading(false);
      setIsTyping(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleCopy(text) {
    navigator.clipboard.writeText(text);
  }

  // Close sidebar on mobile when chat area is clicked
  function handleChatAreaClick() {
    if (window.innerWidth <= 768 && sidebarVisible) {
      setSidebarVisible(false);
    }
  }

  // Select session and close sidebar on mobile
  function handleSessionSelect(sessionId) {
    setSelectedSessionId(sessionId);
    fetchMessages(sessionId);
    
    // Close sidebar on mobile after selecting chat
    if (window.innerWidth <= 768) {
      setSidebarVisible(false);
    }
  }

  // Enhanced markdown rendering with bold, tables, and code blocks
  function renderMessageContent(content) {
    let processedContent = content;
    const elements = [];
    let currentIndex = 0;

    // First, extract and process code blocks
    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
    let match;
    const codeBlocks = [];
    
    while ((match = codeBlockRegex.exec(content)) !== null) {
      codeBlocks.push({
        index: match.index,
        length: match[0].length,
        language: match[1] || 'text',
        code: match[2].trim(),
        fullMatch: match[0]
      });
    }

    // Split content by code blocks
    let lastIndex = 0;
    codeBlocks.forEach((block, idx) => {
      // Process text before code block
      if (block.index > lastIndex) {
        const textSegment = content.substring(lastIndex, block.index);
        elements.push(
          <span key={`text-${idx}`}>
            {renderTextWithFormatting(textSegment)}
          </span>
        );
      }

      // Add code block
      elements.push(
        <div className="code-block" key={`code-${idx}`}>
          <div className="code-header">
            <span className="code-language">{block.language}</span>
            <button className="copy-btn" onClick={() => handleCopy(block.code)}>
              Copy
            </button>
          </div>
          <pre><code>{block.code}</code></pre>
        </div>
      );

      lastIndex = block.index + block.length;
    });

    // Process remaining text after last code block
    if (lastIndex < content.length) {
      const textSegment = content.substring(lastIndex);
      elements.push(
        <span key={`text-final`}>
          {renderTextWithFormatting(textSegment)}
        </span>
      );
    }

    return elements.length > 0 ? elements : renderTextWithFormatting(content);
  }

  // Render text with bold, tables, lists, and other formatting
  function renderTextWithFormatting(text) {
    // Check for table formatting (simple markdown tables)
    if (text.includes('|') && text.includes('\n')) {
      const lines = text.split('\n');
      const tableLines = [];
      const nonTableLines = [];
      let inTable = false;

      lines.forEach(line => {
        if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
          tableLines.push(line);
          inTable = true;
        } else if (inTable && line.trim() === '') {
          inTable = false;
        } else if (!inTable) {
          nonTableLines.push(line);
        }
      });

      if (tableLines.length > 0) {
        return (
          <div>
            {renderTable(tableLines)}
            {nonTableLines.length > 0 && (
              <div>{renderListsAndText(nonTableLines.join('\n'))}</div>
            )}
          </div>
        );
      }
    }

    return renderListsAndText(text);
  }

  // Render lists (bullet and numbered) and text
  function renderListsAndText(text) {
    const lines = text.split('\n');
    const elements = [];
    let currentList = null;
    let currentListType = null;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Check for bullet point (-, *, •)
      const bulletMatch = trimmedLine.match(/^[-*•]\s+(.+)$/);
      // Check for numbered list (1. 2. 3. etc)
      const numberedMatch = trimmedLine.match(/^\d+\.\s+(.+)$/);

      if (bulletMatch) {
        if (currentListType !== 'ul') {
          if (currentList) {
            elements.push(currentList);
          }
          currentList = { type: 'ul', items: [] };
          currentListType = 'ul';
        }
        currentList.items.push(bulletMatch[1]);
      } else if (numberedMatch) {
        if (currentListType !== 'ol') {
          if (currentList) {
            elements.push(currentList);
          }
          currentList = { type: 'ol', items: [] };
          currentListType = 'ol';
        }
        currentList.items.push(numberedMatch[1]);
      } else {
        // Not a list item
        if (currentList) {
          elements.push(currentList);
          currentList = null;
          currentListType = null;
        }
        if (trimmedLine) {
          elements.push({ type: 'text', content: line });
        } else {
          elements.push({ type: 'break' });
        }
      }
      i++;
    }

    // Add remaining list if any
    if (currentList) {
      elements.push(currentList);
    }

    return elements.map((element, idx) => {
      if (element.type === 'ul') {
        return (
          <ul key={idx} className="markdown-list">
            {element.items.map((item, itemIdx) => (
              <li key={itemIdx}>{renderBoldText(item)}</li>
            ))}
          </ul>
        );
      } else if (element.type === 'ol') {
        return (
          <ol key={idx} className="markdown-list">
            {element.items.map((item, itemIdx) => (
              <li key={itemIdx}>{renderBoldText(item)}</li>
            ))}
          </ol>
        );
      } else if (element.type === 'text') {
        return <div key={idx}>{renderBoldText(element.content)}</div>;
      } else if (element.type === 'break') {
        return <br key={idx} />;
      }
      return null;
    });
  }

  // Render table from markdown
  function renderTable(lines) {
    if (lines.length < 2) return renderBoldText(lines.join('\n'));

    const parseRow = (line) => {
      return line
        .split('|')
        .slice(1, -1)
        .map(cell => cell.trim());
    };

    const headers = parseRow(lines[0]);
    const rows = lines.slice(2).map(parseRow); // Skip separator line

    return (
      <div className="markdown-table-wrapper">
        <table className="markdown-table">
          <thead>
            <tr>
              {headers.map((header, idx) => (
                <th key={idx}>{renderBoldText(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx}>
                {row.map((cell, cellIdx) => (
                  <td key={cellIdx}>{renderBoldText(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Render bold text (convert **text** to <strong>text</strong>)
  function renderBoldText(text) {
    const parts = text.split(/(\*\*.*?\*\*)/g);
    
    return parts.map((part, index) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      return <span key={index}>{part}</span>;
    });
  }

  return (
    <div className="app">
      {!token ? (
        <div className="layout">
          <AuthScreen />
        </div>
      ) : (
      <div className="layout">

        {/* SIDEBAR */}
        <aside className={`sidebar ${sidebarVisible ? 'visible' : 'hidden'}`}>
          <div className="sidebar-header">
            <div className="brand">
              <div className="brand-icon">AI</div>
              <h2>Fubotics AI</h2>
            </div>
            <button className="new-chat-btn" onClick={handleNewChat}>
              <span className="btn-icon">+</span>
              <span className="btn-text">New Chat</span>
            </button>
          </div>

          <div className="session-list">
            {sessions.length === 0 && (
              <div className="empty-sessions">
                <div className="empty-icon">Chat</div>
                <p>No chats yet</p>
                <small>Create your first chat to get started</small>
              </div>
            )}

            {sessions.map((session) => (
              <div
                key={session.id}
                className={`session-item ${session.id === selectedSessionId ? 'active' : ''}`}
                onClick={() => handleSessionSelect(session.id)}
              >
                <div className="session-icon">•</div>
                <span className="session-name">
                  {session.name ? session.name : `Chat ${session.id}`}
                </span>
                <button
                  className="delete-session-btn"
                  onClick={(e) => handleDeleteSession(session.id, e)}
                  title="Delete chat"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="sidebar-footer">
            <button className="logout-btn" onClick={handleLogout}>
              <span>↪</span> Logout
            </button>
          </div>
        </aside>

        {/* Overlay for mobile */}
        {sidebarVisible && window.innerWidth <= 768 && (
          <div className="sidebar-overlay" onClick={() => setSidebarVisible(false)} />
        )}

        {/* MAIN CHAT */}
        <main className={`chat-area ${!sidebarVisible ? 'expanded' : ''}`} onClick={handleChatAreaClick}>
          {/* Toggle Button */}
          <button 
            className="toggle-sidebar-btn" 
            onClick={(e) => {
              e.stopPropagation();
              setSidebarVisible(!sidebarVisible);
            }}
            title={sidebarVisible ? "Hide chats" : "Show chats"}
          >
            <span className="toggle-icon">
              {sidebarVisible ? '◀' : '▶'}
            </span>
          </button>

          <div className="chat-column">
            <header className="chat-header">
              <div className="header-content">
                <div className="header-icon">AI</div>
                <h1>Fubotics AI</h1>
              </div>
              <div className="header-status">
                <span className="status-dot"></span>
                <span className="status-text">Online</span>
              </div>
            </header>

            <div className="chat-window" ref={chatWindowRef}>
              {!selectedSessionId && (
                <div className="empty-state">
                  <div className="empty-state-content">
                    <div className="empty-state-icon">Start</div>
                    <h2>Welcome to Fubotics AI</h2>
                    <p>Select a chat or create a new one to get started</p>
                  </div>
                </div>
              )}

              {selectedSessionId && messages.length === 0 && (
                <div className="empty-state">
                  <div className="empty-state-content">
                    <div className="empty-state-icon">Hi</div>
                    <h2>Start the conversation</h2>
                    <p>Ask me anything!</p>
                  </div>
                </div>
              )}

              {selectedSessionId &&
                messages.map((msg) => (
                  <div
                    key={msg.id + (msg.created_at || "")}
                    className={`message-row ${msg.role === "user" ? "user-row" : "ai-row"}`}
                  >
                    <div className="message-avatar">
                      {msg.role === "user" ? "U" : "AI"}
                    </div>
                    <div className="bubble">
                      <div className="sender">
                        {msg.role === "user" ? "You" : "Fubotics AI"}
                      </div>
                      <div className="content">
                        {renderMessageContent(msg.content)}
                      </div>
                    </div>
                  </div>
                ))}

              {isTyping && (
                <div className="message-row ai-row">
                  <div className="message-avatar">AI</div>
                  <div className="typing-indicator">
                    <div className="typing-dots">
                      <div className="typing-dot"></div>
                      <div className="typing-dot"></div>
                      <div className="typing-dot"></div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="input-area" onClick={(e) => e.stopPropagation()}>
              <div className="input-wrapper">
                <textarea
                  placeholder="Type your message..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                />
                <button 
                  className="send-btn" 
                  onClick={handleSend} 
                  disabled={loading || !input.trim()}
                >
                  {loading ? "..." : "Send"}
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
      )}
    </div>
  );
}