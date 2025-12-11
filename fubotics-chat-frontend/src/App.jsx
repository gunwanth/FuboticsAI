import { useEffect, useState } from "react";
import axios from "axios";
import "./App.css";

// App.jsx (top)
const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  // Load sessions on mount
  useEffect(() => {
    fetchSessions();
  }, []);

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
          content: "Error talking to server 😢",
        },
      ]);
    } finally {
      setLoading(false);
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

  function renderMessageContent(content) {
    if (!content.includes("```")) return content;

    const parts = content.split("```");

    return parts.map((part, index) => {
      if (index % 2 === 1) {
        return (
          <div className="code-block" key={index}>
            <button className="copy-btn" onClick={() => handleCopy(part)}>
              Copy
            </button>
            <pre><code>{part}</code></pre>
          </div>
        );
      }
      return <span key={index}>{part}</span>;
    });
  }

  return (
    <div className="app">
      <div className="layout">

        {/* SIDEBAR */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>Fubotics AI</h2>
            <button className="new-chat-btn" onClick={handleNewChat}>
              + New
            </button>
          </div>

          <div className="session-list">
            {sessions.length === 0 && (
              <div className="empty-sessions">No chats yet — create one 👇</div>
            )}

            {sessions.map((session) => (
              <div
                key={session.id}
                className={
                  "session-item" +
                  (session.id === selectedSessionId ? " active" : "")
                }
                onClick={() => {
                  setSelectedSessionId(session.id);
                  fetchMessages(session.id);
                }}
              >
                <span className="session-name">
                  {session.name ? session.name : `Chat ${session.id}`}
                </span>

                <button
                  className="delete-session-btn"
                  onClick={(e) => handleDeleteSession(session.id, e)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* MAIN CHAT */}
        <main className="chat-area">
          <div className="chat-column">

            <header className="chat-header">
              <h1>Fubotics AI Chat</h1>
            </header>

            <div className="chat-window">
              {!selectedSessionId && (
                <div className="empty-state">Select a chat or create one</div>
              )}

              {selectedSessionId && messages.length === 0 && (
                <div className="empty-state">Start the conversation 👋</div>
              )}

              {selectedSessionId &&
                messages.map((msg) => (
                  <div
                    key={msg.id + (msg.created_at || "")}
                    className={
                      "message-row " +
                      (msg.role === "user" ? "user-row" : "ai-row")
                    }
                  >
                    <div className="bubble">
                      <div className="sender">
                        {msg.role === "user" ? "You" : "AI"}
                      </div>
                      <div className="content">
                        {renderMessageContent(msg.content)}
                      </div>
                    </div>
                  </div>
                ))}
            </div>

            <div className="input-area">
              <textarea
                placeholder="Type your message..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={2}
              />
              <button onClick={handleSend} disabled={loading}>
                {loading ? "Sending..." : "Send"}
              </button>
            </div>

          </div>
        </main>

      </div>
    </div>
  );
}