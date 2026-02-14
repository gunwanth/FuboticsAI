import { useEffect, useState, useRef } from "react";
import axios from "axios";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";
axios.defaults.withCredentials = true;

// Axios interceptor setup for token refresh
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// Setup axios interceptors
axios.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("accessToken");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    
    if (error.response?.status === 401 && error.response?.data?.code === "TOKEN_EXPIRED" && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then(token => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return axios(originalRequest);
          })
          .catch(err => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const response = await axios.post(`${API_BASE}/api/refresh`, {}, { withCredentials: true });
        const { accessToken } = response.data;
        
        localStorage.setItem("accessToken", accessToken);
        axios.defaults.headers.common["Authorization"] = `Bearer ${accessToken}`;
        
        processQueue(null, accessToken);
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        
        return axios(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        // If refresh fails, logout user
        localStorage.removeItem("accessToken");
        window.location.reload();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }
    
    return Promise.reject(error);
  }
);

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [token, setToken] = useState(localStorage.getItem("accessToken") || null);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(window.innerWidth > 768);
  const [filesSidebarVisible, setFilesSidebarVisible] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const chatWindowRef = useRef(null);
  const [dataAnalytics, setDataAnalytics] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [deepSearchEnabled, setDeepSearchEnabled] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState([]);
  const [sessionAttachments, setSessionAttachments] = useState([]);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const bootstrapAuth = async () => {
      const savedToken = localStorage.getItem("accessToken");
      if (savedToken) {
        setToken(savedToken);
        axios.defaults.headers.common["Authorization"] = `Bearer ${savedToken}`;
        return;
      }

      try {
        const response = await axios.post(`${API_BASE}/api/refresh`, {}, { withCredentials: true });
        const refreshedToken = response.data?.accessToken;
        if (refreshedToken) {
          localStorage.setItem("accessToken", refreshedToken);
          setToken(refreshedToken);
          axios.defaults.headers.common["Authorization"] = `Bearer ${refreshedToken}`;
        }
      } catch (_) {
        localStorage.removeItem("accessToken");
      }
    };

    bootstrapAuth();
  }, []);

  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth <= 768 && sidebarVisible) {
        // Don't auto-close on mobile, let user control it
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [sidebarVisible]);

  useEffect(() => {
    if (token) {
      localStorage.setItem("accessToken", token);
      axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      fetchSessions();
    } else {
      localStorage.removeItem("accessToken");
      delete axios.defaults.headers.common["Authorization"];
      setSessions([]);
      setSelectedSessionId(null);
      setMessages([]);
      setSessionAttachments([]);
    }
  }, [token]);

  function AuthScreen() {
    const [localUser, setLocalUser] = useState("");
    const [localPass, setLocalPass] = useState("");
    const [localMode, setLocalMode] = useState("login");

    async function handleLocalSubmit(e) {
      e.preventDefault();
      try {
        const path = localMode === "signup" ? "/api/signup" : "/api/login";
        const res = await axios.post(
          `${API_BASE}${path}`,
          { username: localUser, password: localPass },
          { withCredentials: true }
        );
        const t = res.data.accessToken;
        if (t) {
          setToken(t);
          setLocalUser("");
          setLocalPass("");
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
    if (!token) return;
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

  async function handleLogout() {
    try {
      await axios.post(`${API_BASE}/api/logout`, {}, { withCredentials: true });
    } catch (err) {
      console.error("Logout request failed", err);
    }
    setToken(null);
  }

  async function fetchMessages(sessionId) {
    try {
      const res = await axios.get(`${API_BASE}/api/messages`, {
        params: { sessionId },
      });
      setMessages(res.data.messages || []);
      
      // Fetch session attachments
      const attRes = await axios.get(`${API_BASE}/api/attachments`, {
        params: { sessionId },
      });
      setSessionAttachments(attRes.data.attachments || []);
    } catch (err) {
      console.error("Error loading messages", err);
      setMessages([]);
      setSessionAttachments([]);
    }
  }

  async function handleNewChat() {
    try {
      const defaultName = `Chat ${sessions.length + 1}`;
      const userInput = window.prompt("Enter chat name (optional):", defaultName);

      if (userInput === null) return;

      const name = userInput.trim() === "" ? defaultName : userInput.trim();

      const res = await axios.post(`${API_BASE}/api/sessions`, { name });
      const newSession = res.data.session;

      setSessions((prev) => [newSession, ...prev]);
      setSelectedSessionId(newSession.id);
      setMessages([]);
      setAttachedFiles([]);
      setPendingAttachmentIds([]);
      
      if (window.innerWidth <= 768) {
        setSidebarVisible(false);
      }
    } catch (err) {
      console.error("Error creating session", err);
      alert("Failed to create chat");
    }
  }

  async function handleDeleteSession(sessionId, e) {
    e.stopPropagation();

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
        setAttachedFiles([]);
        setPendingAttachmentIds([]);
      }
    } catch (err) {
      console.error("Error deleting session", err);
    }
  }

  // Handle file attachment selection
  async function handleFileAttachment(event) {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    if (!selectedSessionId) {
      alert("Please create a chat first");
      return;
    }

    setUploading(true);
    const formData = new FormData();
    formData.append('sessionId', selectedSessionId);
    files.forEach(file => {
      formData.append('files', file);
    });

    try {
      const response = await axios.post(`${API_BASE}/api/attachments`, formData);
      
      setAttachedFiles(prev => [...prev, ...files.map((f, idx) => ({
        name: f.name,
        id: response.data.attachmentIds[idx]
      }))]);
      
      setPendingAttachmentIds(prev => [...prev, ...response.data.attachmentIds]);
      
    } catch (error) {
      console.error('Upload error:', error);
      alert('Failed to upload files: ' + (error.response?.data?.error || error.message));
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  // Remove attached file
  function removeAttachedFile(index) {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
    setPendingAttachmentIds(prev => prev.filter((_, i) => i !== index));
  }

  async function handleSend() {
    if ((!input.trim() && attachedFiles.length === 0) || loading) return;
    if (!selectedSessionId) {
      alert("Please create a chat first");
      return;
    }

    const text = input.trim() || "(Sent files)";
    setLoading(true);

    if (editingMessageId) {
      try {
        const res = await axios.put(`${API_BASE}/api/messages/${editingMessageId}`, {
          content: text,
          deepSearch: deepSearchEnabled,
        });
        setMessages(res.data.messages || []);
        setInput("");
        setEditingMessageId(null);
      } catch (err) {
        console.error("Edit resend error", err);
        alert(err.response?.data?.error || "Failed to edit message");
      } finally {
        setLoading(false);
        setIsTyping(false);
        setDeepSearchEnabled(false);
      }
      return;
    }

    setInput("");

    // Optimistic UI
    const tempMsg = { 
      id: Date.now(), 
      role: "user", 
      content: text,
      attachments: attachedFiles.map(f => ({ filename: f.name }))
    };
    setMessages((prev) => [...prev, tempMsg]);

    // Clear attached files from UI
    const attachmentIdsToSend = [...pendingAttachmentIds];
    setAttachedFiles([]);
    setPendingAttachmentIds([]);

    setIsTyping(true);
    try {
      const res = await axios.post(`${API_BASE}/api/messages`, {
        sessionId: selectedSessionId,
        content: text,
        deepSearch: deepSearchEnabled,
        attachmentIds: attachmentIdsToSend.length > 0 ? attachmentIdsToSend : undefined
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
      setDeepSearchEnabled(false);
    }
  }

  function startEditingMessage(msg) {
    if (!msg || msg.role !== "user") return;
    setEditingMessageId(msg.id);
    setInput(msg.content || "");
    setAttachedFiles([]);
    setPendingAttachmentIds([]);
  }

  function cancelEditingMessage() {
    setEditingMessageId(null);
    setInput("");
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

  function handleChatAreaClick() {
    if (window.innerWidth <= 768 && sidebarVisible) {
      setSidebarVisible(false);
    }
  }

  async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!selectedSessionId) {
      alert("Please create a chat first");
      return;
    }

    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('sessionId', selectedSessionId);

    try {
      const response = await axios.post(`${API_BASE}/api/upload-data`, formData);
      
      // Refresh session attachments to show new generated files
      const attRes = await axios.get(`${API_BASE}/api/attachments`, {
        params: { sessionId: selectedSessionId },
      });
      setSessionAttachments(attRes.data.attachments || []);
      
      alert('File processed successfully! Check the Generated Files section below.');
    } catch (error) {
      console.error('Upload error:', error);
      alert('Failed to upload and process file: ' + (error.response?.data?.error || error.message));
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  async function handleDownload(filename) {
    try {
      const response = await axios.get(`${API_BASE}/api/download/${filename}`, {
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download error:', error);
      alert('Failed to download file');
    }
  }

  async function handleDownloadAttachment(attachmentId, filename) {
    try {
      const response = await axios.get(`${API_BASE}/api/download-attachment/${attachmentId}`, {
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download error:', error);
      alert('Failed to download file');
    }
  }

  function handleSessionSelect(sessionId) {
    setSelectedSessionId(sessionId);
    fetchMessages(sessionId);
    setAttachedFiles([]);
    setPendingAttachmentIds([]);
    setDataAnalytics(null);
    
    if (window.innerWidth <= 768) {
      setSidebarVisible(false);
    }
  }

  function renderMessageContent(content) {
    let processedContent = content;
    const elements = [];
    let currentIndex = 0;

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

    let lastIndex = 0;
    codeBlocks.forEach((block, idx) => {
      if (block.index > lastIndex) {
        const textSegment = content.substring(lastIndex, block.index);
        elements.push(
          <span key={`text-${idx}`}>
            {renderTextWithFormatting(textSegment)}
          </span>
        );
      }

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

  function renderTextWithFormatting(text) {
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

  function renderListsAndText(text) {
    const lines = text.split('\n');
    const elements = [];
    let currentList = null;
    let currentListType = null;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmedLine = line.trim();

      const bulletMatch = trimmedLine.match(/^[-*•]\s+(.+)$/);
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

  function renderTable(lines) {
    if (lines.length < 2) return renderBoldText(lines.join('\n'));

    const parseRow = (line) => {
      return line
        .split('|')
        .slice(1, -1)
        .map(cell => cell.trim());
    };

    const headers = parseRow(lines[0]);
    const rows = lines.slice(2).map(parseRow);

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

  function renderBoldText(text) {
    const elements = [];
    const regex = /(\*\*.*?\*\*|\[[^\]]+\]\(([^)\s]+)\)|((?:https?:\/\/|www\.)[^\s]+))/g;
    let lastIndex = 0;
    let match;
    let key = 0;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        elements.push(<span key={key++}>{text.substring(lastIndex, match.index)}</span>);
      }

      const token = match[0];
      if (token.startsWith("**") && token.endsWith("**")) {
        elements.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
      } else if (token.startsWith("[") && token.includes("](")) {
        const parts = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        if (parts) {
          const href = parts[2].startsWith("www.") ? `https://${parts[2]}` : parts[2];
          elements.push(
            <a key={key++} href={href} target="_blank" rel="noreferrer">
              {parts[1]}
            </a>
          );
        } else {
          elements.push(<span key={key++}>{token}</span>);
        }
      } else {
        const cleanToken = token.replace(/[),.;]+$/, "");
        const href = cleanToken.startsWith("www.") ? `https://${cleanToken}` : cleanToken;
        elements.push(
          <a key={key++} href={href} target="_blank" rel="noreferrer">
            {cleanToken}
          </a>
        );
      }

      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      elements.push(<span key={key++}>{text.substring(lastIndex)}</span>);
    }

    return elements.length > 0 ? elements : <span>{text}</span>;
  }

  return (
    <div className="app">
      {!token ? (
        <div className="layout">
          <AuthScreen />
        </div>
      ) : (
      <div className="layout">

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

        {sidebarVisible && window.innerWidth <= 768 && (
          <div className="sidebar-overlay" onClick={() => setSidebarVisible(false)} />
        )}

        <main className={`chat-area ${!sidebarVisible ? 'expanded' : ''} ${filesSidebarVisible ? 'files-open' : ''}`} onClick={handleChatAreaClick}>
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
              <div className="header-actions">
                <button
                  className={`deep-search-btn ${deepSearchEnabled ? "active" : ""}`}
                  onClick={() => setDeepSearchEnabled((prev) => !prev)}
                  title="Use deep web research for next message"
                >
                  {deepSearchEnabled ? "Deep Search On" : "Deep Search"}
                </button>
                <button 
                  className="files-toggle-btn"
                  onClick={() => setFilesSidebarVisible(!filesSidebarVisible)}
                  title="Toggle Files"
                >
                  📁 Files
                </button>
                <div className="header-status">
                  <span className="status-dot"></span>
                  <span className="status-text">Online</span>
                </div>
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
                        {msg.role === "user" && (
                          <button
                            className="message-edit-btn"
                            onClick={() => startEditingMessage(msg)}
                            type="button"
                            title="Edit and resend this message"
                          >
                            Edit
                          </button>
                        )}
                      </div>
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="message-attachments">
                          {msg.attachments.map((att, idx) => (
                            <div key={idx} className="attachment-badge">
                              📎 {att.filename}
                            </div>
                          ))}
                        </div>
                      )}
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
              {editingMessageId && (
                <div className="edit-banner">
                  Editing previous message
                  <button type="button" onClick={cancelEditingMessage}>Cancel</button>
                </div>
              )}
              {attachedFiles.length > 0 && (
                <div className="attached-files-preview">
                  {attachedFiles.map((file, idx) => (
                    <div key={idx} className="attached-file-item">
                      <span>📎 {file.name}</span>
                      <button onClick={() => removeAttachedFile(idx)}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="input-wrapper">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileAttachment}
                  style={{ display: 'none' }}
                  multiple
                  accept=".csv,.txt,.json,.pdf,.png,.jpg,.jpeg,.xls,.xlsx,.docx,.pptx"
                  disabled={uploading}
                />
                <button
                  className="attach-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || !selectedSessionId || !!editingMessageId}
                  title="Attach files"
                >
                  📎
                </button>
                <textarea
                  placeholder="Type your message..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                />
                <input
                  type="file"
                  accept=".csv"
                  onChange={handleFileUpload}
                  style={{ display: 'none' }}
                  id="csv-upload-input"
                  disabled={uploading}
                />
                <button
                  className="csv-upload-btn"
                  onClick={() => document.getElementById('csv-upload-input').click()}
                  disabled={uploading || !selectedSessionId || !!editingMessageId}
                  title="Upload CSV for Analytics"
                >
                  📊
                </button>
                <button
                  className="send-btn"
                  onClick={handleSend}
                  disabled={loading || (!input.trim() && attachedFiles.length === 0)}
                >
                  {loading ? "..." : editingMessageId ? "Resend" : "Send"}
                </button>
              </div>
            </div>
          </div>

          {/* FILES SIDEBAR */}
          <aside className={`files-sidebar ${filesSidebarVisible ? 'visible' : 'hidden'}`}>
            <div className="files-sidebar-header">
              <h2>📁 Files</h2>
              <button 
                className="close-files-btn"
                onClick={() => setFilesSidebarVisible(false)}
                title="Close"
              >
                ×
              </button>
            </div>

            <div className="files-content">
              {!selectedSessionId ? (
                <div className="no-session-message">
                  <p>Select a chat to view files</p>
                </div>
              ) : (
                <>
                  {/* Generated Files Section */}
                  <div className="file-category">
                    <h3 className="category-title">📊 Generated Files</h3>
                    <div className="files-list">
                      {sessionAttachments.filter(att => att.is_generated).length === 0 ? (
                        <div className="empty-files">
                          <p>No generated files yet</p>
                          <small>Upload a CSV to generate analytics</small>
                        </div>
                      ) : (
                        sessionAttachments
                          .filter(att => att.is_generated)
                          .map((attachment) => (
                            <div key={attachment.id} className="file-item">
                              <div className="file-icon-wrapper">
                                {attachment.file_type === 'text/csv' ? '📊' : '📄'}
                              </div>
                              <div className="file-info-wrapper">
                                <div className="file-name-text">{attachment.original_filename}</div>
                                <div className="file-size-text">
                                  {(attachment.file_size / 1024).toFixed(1)} KB
                                </div>
                              </div>
                              <button
                                onClick={() => handleDownloadAttachment(attachment.id, attachment.original_filename)}
                                className="file-download-btn"
                                title="Download"
                              >
                                ⬇️
                              </button>
                            </div>
                          ))
                      )}
                    </div>
                  </div>

                  {/* Uploaded Files Section */}
                  <div className="file-category">
                    <h3 className="category-title">📎 Uploaded Files</h3>
                    <div className="files-list">
                      {sessionAttachments.filter(att => !att.is_generated).length === 0 ? (
                        <div className="empty-files">
                          <p>No uploaded files</p>
                          <small>Use the 📎 button to attach files</small>
                        </div>
                      ) : (
                        sessionAttachments
                          .filter(att => !att.is_generated)
                          .map((attachment) => (
                            <div key={attachment.id} className="file-item">
                              <div className="file-icon-wrapper">📎</div>
                              <div className="file-info-wrapper">
                                <div className="file-name-text">{attachment.original_filename}</div>
                                <div className="file-size-text">
                                  {(attachment.file_size / 1024).toFixed(1)} KB
                                </div>
                              </div>
                              <button
                                onClick={() => handleDownloadAttachment(attachment.id, attachment.original_filename)}
                                className="file-download-btn"
                                title="Download"
                              >
                                ⬇️
                              </button>
                            </div>
                          ))
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </aside>

          {/* Overlay for files sidebar on mobile */}
          {filesSidebarVisible && window.innerWidth <= 768 && (
            <div className="files-sidebar-overlay" onClick={() => setFilesSidebarVisible(false)} />
          )}
        </main>
      </div>
      )}
    </div>
  );
}
