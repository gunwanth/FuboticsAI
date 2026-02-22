import { useEffect, useState, useRef } from "react";
import axios from "axios";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";
const ANONYMOUS_DEFAULT_MODEL = "sambanova";
const LANDING_TITLES = [
  "What can I help with?",
  "How can I support you today?",
  "What would you like to explore?",
  "What are we building today?",
  "What do you want to solve next?",
  "How can I assist right now?",
  "What should we work on first?",
  "What can I help you figure out?",
];
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
  const initialShareToken = new URLSearchParams(window.location.search).get("share");
  const [sessions, setSessions] = useState([]);
  const [showSessionSearch, setShowSessionSearch] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
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
  const [availableModels, setAvailableModels] = useState([
    { id: "groq", label: "Groq (Llama 3.3 70B)", enabled: true },
  ]);
  const [selectedModel, setSelectedModel] = useState(localStorage.getItem("chatModel") || "groq");
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState([]);
  const [sessionAttachments, setSessionAttachments] = useState([]);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [openSessionMenuId, setOpenSessionMenuId] = useState(null);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState(null);
  const [pendingDeleteAccount, setPendingDeleteAccount] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [recentActivity, setRecentActivity] = useState([]);
  const [shareToken, setShareToken] = useState(initialShareToken);
  const [sharedView, setSharedView] = useState({ loading: false, error: "", session: null, messages: [] });
  const [showAuthScreen, setShowAuthScreen] = useState(false);
  const [pendingContinueShared, setPendingContinueShared] = useState(false);
  const [authIntentMode, setAuthIntentMode] = useState("login");
  const [sharedMessages, setSharedMessages] = useState([]);
  const [anonymousMessages, setAnonymousMessages] = useState([]);
  const [anonymousQuestionCount, setAnonymousQuestionCount] = useState(0);
  const [anonymousSharedQuestionCount, setAnonymousSharedQuestionCount] = useState(0);
  const [sharedLimitModal, setSharedLimitModal] = useState(null); // "soft" | "hard" | null
  const [copiedCodeKey, setCopiedCodeKey] = useState(null);
  const copyResetTimerRef = useRef(null);
  const fileInputRef = useRef(null);
  const [landingTitle, setLandingTitle] = useState(LANDING_TITLES[0]);
  const getSessionLabel = (session) => {
    if (session?.name) return session.name;
    if (Number.isInteger(session?.session_number)) return `Session ${session.session_number}`;
    return `Chat ${session?.id}`;
  };
  const filteredSessions = sessions.filter((session) =>
    getSessionLabel(session).toLowerCase().includes(sessionSearchQuery.trim().toLowerCase())
  );
  const rotateLandingTitle = () => {
    setLandingTitle((prev) => {
      if (LANDING_TITLES.length <= 1) return prev;
      const currentIndex = LANDING_TITLES.indexOf(prev);
      let nextIndex = currentIndex;
      while (nextIndex === currentIndex) {
        nextIndex = Math.floor(Math.random() * LANDING_TITLES.length);
      }
      return LANDING_TITLES[nextIndex];
    });
  };

  useEffect(() => {
    const syncShareToken = () => {
      const p = new URLSearchParams(window.location.search).get("share");
      setShareToken(p);
    };
    window.addEventListener("popstate", syncShareToken);
    return () => window.removeEventListener("popstate", syncShareToken);
  }, []);

  useEffect(() => {
    if (!shareToken) return;
    const loadShared = async () => {
      setSharedView({ loading: true, error: "", session: null, messages: [] });
      try {
        const res = await axios.get(`${API_BASE}/api/public/share/${shareToken}`);
        setSharedView({
          loading: false,
          error: "",
          session: res.data?.session || null,
          messages: res.data?.messages || [],
        });
        setSharedMessages(res.data?.messages || []);
      } catch (err) {
        setSharedView({
          loading: false,
          error: err.response?.data?.error || "Failed to load shared chat",
          session: null,
          messages: [],
        });
        setSharedMessages([]);
      }
    };
    loadShared();
    setShowAuthScreen(false);
  }, [shareToken]);

  useEffect(() => {
    setAnonymousSharedQuestionCount(0);
    setAnonymousQuestionCount(0);
    setSharedLimitModal(null);
  }, [shareToken]);

  useEffect(() => {
    if (!token || !pendingContinueShared || !shareToken) return;
    const run = async () => {
      await continueSharedChatWithCurrentAuth();
      setPendingContinueShared(false);
      setShowAuthScreen(false);
    };
    run();
  }, [token, pendingContinueShared, shareToken]);

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
    const loadModels = async () => {
      try {
        const res = await axios.get(`${API_BASE}/api/models`);
        const models = Array.isArray(res.data?.models) ? res.data.models : [];
        const enabledModels = models.filter((m) => m?.enabled);
        if (enabledModels.length > 0) {
          setAvailableModels(enabledModels);
          const currentStillValid = enabledModels.some((m) => m.id === selectedModel);
          if (!currentStillValid) {
            const fallback = res.data?.defaultModel || enabledModels[0].id;
            setSelectedModel(fallback);
            localStorage.setItem("chatModel", fallback);
          }
        }
      } catch (err) {
        console.warn("Failed to load model list, using default:", err?.message || err);
      }
    };
    loadModels();
  }, []);

  useEffect(() => {
    localStorage.setItem("chatModel", selectedModel);
  }, [selectedModel]);

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
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (token) {
      localStorage.setItem("accessToken", token);
      axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      fetchSessions();
      fetchCurrentUser();
    } else {
      localStorage.removeItem("accessToken");
      delete axios.defaults.headers.common["Authorization"];
      setProfileOpen(false);
      setRecentActivity([]);
      setCurrentUser(null);
      setSessions([]);
      setSelectedSessionId(null);
      setMessages([]);
      setSessionAttachments([]);
    }
    rotateLandingTitle();
  }, [token]);

  function AuthScreen() {
    const [localUser, setLocalUser] = useState("");
    const [localEmail, setLocalEmail] = useState("");
    const [localPass, setLocalPass] = useState("");
    const [localMode, setLocalMode] = useState(authIntentMode || "login");
    const [loginFailureMap, setLoginFailureMap] = useState({});

    const loginIdentifierKey = String(localUser || "").trim().toLowerCase();
    const loginFailCount = loginFailureMap[loginIdentifierKey] || 0;
    const showForgotPasswordButton =
      localMode === "login" && Boolean(loginIdentifierKey) && loginFailCount >= 3;

    useEffect(() => {
      setLocalMode(authIntentMode || "login");
    }, [authIntentMode]);

    async function handleLocalSubmit(e) {
      e.preventDefault();
      try {
        if (localMode === "signup") {
          const res = await axios.post(
            `${API_BASE}/api/signup`,
            { username: localUser, email: localEmail || undefined, password: localPass },
            { withCredentials: true }
          );
          const t = res.data.accessToken;
          if (t) {
            setToken(t);
            setShowAuthScreen(false);
            setSharedLimitModal(null);
            setLocalUser("");
            setLocalEmail("");
            setLocalPass("");
          }
          return;
        }

        if (localMode === "login") {
          const res = await axios.post(
            `${API_BASE}/api/login`,
            { username: localUser, password: localPass },
            { withCredentials: true }
          );
          const t = res.data.accessToken;
          if (t) {
            if (loginIdentifierKey) {
              setLoginFailureMap((prev) => ({ ...prev, [loginIdentifierKey]: 0 }));
            }
            setToken(t);
            setShowAuthScreen(false);
            setSharedLimitModal(null);
            setLocalUser("");
            setLocalPass("");
          }
          return;
        }

        if (localMode === "forgot_username") {
          await axios.post(`${API_BASE}/api/forgot-password/username`, {
            username: localUser,
            newPassword: localPass,
          });
          alert("Password updated. Please login with your new password.");
          setLocalMode("login");
          setLocalPass("");
          return;
        }

        if (localMode === "forgot_email") {
          await axios.post(`${API_BASE}/api/forgot-password/email`, {
            email: localEmail,
            newPassword: localPass,
          });
          alert("Password updated. Please login with your new password.");
          setLocalMode("login");
          setLocalPass("");
          return;
        }
      } catch (err) {
        if (localMode === "login" && loginIdentifierKey) {
          const isInvalidCredentials =
            err?.response?.status === 401 ||
            String(err?.response?.data?.error || "").toLowerCase().includes("invalid credentials");
          if (isInvalidCredentials) {
            setLoginFailureMap((prev) => ({
              ...prev,
              [loginIdentifierKey]: (prev[loginIdentifierKey] || 0) + 1,
            }));
          }
        }
        console.error("Auth error", err.response?.data || err.message || err);
        alert(err.response?.data?.error || "Auth failed");
      }
    }

    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-logo">
            <div className="logo-icon" aria-hidden="true"></div>
            <h2>NexaCore AI</h2>
          </div>
          <h3>
            {localMode === "login" && "Welcome Back"}
            {localMode === "signup" && "Create Account"}
            {localMode === "forgot_username" && "Reset Password"}
            {localMode === "forgot_email" && "Reset Password With Email"}
          </h3>
          <form onSubmit={handleLocalSubmit} className="auth-form">
            <div className="input-group">
              <input 
                placeholder={localMode === "login" ? "Username or Email" : "Username"} 
                value={localUser} 
                onChange={(e) => setLocalUser(e.target.value)}
                required={localMode !== "forgot_email"}
              />
            </div>
            {(localMode === "signup" || localMode === "forgot_email") && (
              <div className="input-group">
                <input
                  placeholder="Email"
                  type="email"
                  value={localEmail}
                  onChange={(e) => setLocalEmail(e.target.value)}
                  required={localMode === "forgot_email"}
                />
              </div>
            )}
            <div className="input-group">
              <input 
                placeholder={localMode.startsWith("forgot") ? "New Password" : "Password"} 
                type="password" 
                value={localPass} 
                onChange={(e) => setLocalPass(e.target.value)}
                required 
              />
            </div>
            {localMode === "login" && showForgotPasswordButton && (
              <div className="forgot-inline-wrap">
                <button
                  type="button"
                  className="forgot-inline-btn"
                  onClick={() => setLocalMode("forgot_username")}
                >
                  Forgot password?
                </button>
              </div>
            )}
            <button type="submit" className="primary-btn">
              {localMode === "login" && "Login"}
              {localMode === "signup" && "Create Account"}
              {localMode.startsWith("forgot") && "Update Password"}
            </button>
            {localMode === "login" && (
              <>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setLocalMode("signup")}
                >
                  Need an account?
                </button>
              </>
            )}
            {localMode === "signup" && (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setLocalMode("login")}
              >
                Already have an account?
              </button>
            )}
            {localMode === "forgot_username" && (
              <>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setLocalMode("forgot_email")}
                >
                  Forgot username? Use email
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setLocalMode("login")}
                >
                  Back to login
                </button>
              </>
            )}
            {localMode === "forgot_email" && (
              <>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setLocalMode("forgot_username")}
                >
                  Use username instead
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setLocalMode("login")}
                >
                  Back to login
                </button>
              </>
            )}
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
        const searchParams = new URLSearchParams(window.location.search);
        const requested = Number.parseInt(searchParams.get("session") || "", 10);
        const hasRequested = Number.isInteger(requested) && list.some((s) => s.id === requested);
        const target = hasRequested ? requested : list[0].id;
        setSelectedSessionId(target);
        await fetchMessages(target);
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
    setProfileOpen(false);
    setToken(null);
  }

  async function fetchCurrentUser() {
    try {
      const res = await axios.get(`${API_BASE}/api/me`);
      setCurrentUser(res.data?.user || null);
    } catch (err) {
      console.error("Error loading user profile", err);
      setCurrentUser(null);
    }
  }

  async function handleDeleteAccount() {
    try {
      await axios.delete(`${API_BASE}/api/account`, { withCredentials: true });
      setProfileOpen(false);
      setPendingDeleteAccount(false);
      setToken(null);
      localStorage.removeItem("accessToken");
      delete axios.defaults.headers.common["Authorization"];
      setCurrentUser(null);
      setSessions([]);
      setMessages([]);
      setSelectedSessionId(null);
      setSessionAttachments([]);
      setAttachedFiles([]);
      setPendingAttachmentIds([]);
    } catch (err) {
      console.error("Delete account error", err);
      alert(err.response?.data?.error || "Failed to delete account");
    }
  }

  async function fetchRecentActivity() {
    if (!token) return;
    setActivityLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/api/session-logs`);
      const logs = Array.isArray(res.data?.logs) ? res.data.logs : [];
      const cutoff = Date.now() - (3 * 24 * 60 * 60 * 1000);
      const filtered = logs
        .filter((l) => {
          const ts = new Date(l.created_at).getTime();
          return Number.isFinite(ts) && ts >= cutoff;
        })
        .slice(0, 25);
      setRecentActivity(filtered);
    } catch (err) {
      console.error("Failed to fetch recent activity", err);
      setRecentActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }

  async function toggleProfilePanel() {
    const next = !profileOpen;
    setProfileOpen(next);
    if (next) {
      await fetchRecentActivity();
    }
  }

  function formatActivityRow(row) {
    const action = String(row?.action || "").toLowerCase();
    if (action === "login") return "Logged in";
    if (action === "logout") return "Logged out";
    if (action === "token_refresh") return "Session refreshed";
    if (action === "logout_all") return "Logged out from all devices";
    return row?.action || "Activity";
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
    rotateLandingTitle();
    setSelectedSessionId(null);
    setMessages([]);
    setAttachedFiles([]);
    setPendingAttachmentIds([]);
    setInput("");
    setEditingMessageId(null);
    setOpenSessionMenuId(null);
    setPendingDeleteSessionId(null);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("session");
    window.history.replaceState({}, "", nextUrl.toString());

    if (window.innerWidth <= 768) {
      setSidebarVisible(false);
    }
  }

  async function ensureSessionForMessage(firstPrompt) {
    if (selectedSessionId) return selectedSessionId;
    const res = await axios.post(`${API_BASE}/api/sessions/auto`, {
      firstPrompt: String(firstPrompt || "").trim(),
    });
    const newSession = res.data?.session;
    if (!newSession?.id) throw new Error("Could not create session");
    setSessions((prev) => [newSession, ...prev]);
    setSelectedSessionId(newSession.id);
    setMessages([]);
    setAttachedFiles([]);
    setPendingAttachmentIds([]);
    if (window.innerWidth <= 768) {
      setSidebarVisible(false);
    }
    return newSession.id;
  }

  async function handleDeleteSession(sessionId) {
    try {
      await axios.delete(`${API_BASE}/api/sessions/${sessionId}`);
      const remaining = sessions.filter((s) => s.id !== sessionId);

      setSessions(remaining);
      setPendingDeleteSessionId(null);
      setOpenSessionMenuId(null);

      if (selectedSessionId === sessionId) {
        if (remaining.length > 0) {
          const next = remaining[0].id;
          setSelectedSessionId(next);
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set("session", String(next));
          window.history.replaceState({}, "", nextUrl.toString());
          await fetchMessages(next);
        } else {
          setSelectedSessionId(null);
          setMessages([]);
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.delete("session");
          window.history.replaceState({}, "", nextUrl.toString());
        }
        setAttachedFiles([]);
        setPendingAttachmentIds([]);
      }
    } catch (err) {
      console.error("Error deleting session", err);
    }
  }

  async function handleShareSession(session, e) {
    e.stopPropagation();
    setOpenSessionMenuId(null);
    let shareUrl = "";
    try {
      const res = await axios.post(`${API_BASE}/api/sessions/${session.id}/share`);
      shareUrl = res.data?.shareUrl || "";
    } catch (err) {
      console.error("Share token creation failed", err);
    }
    if (!shareUrl) {
      const url = new URL(window.location.href);
      url.searchParams.delete("session");
      url.searchParams.set("share", String(session.id));
      shareUrl = url.toString();
    }
    const nativeShareSupported = typeof navigator !== "undefined" && typeof navigator.share === "function";
    const clipboardSupported = typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function";

    if (nativeShareSupported) {
      try {
        await navigator.share({
          title: getSessionLabel(session),
          text: "Shared Fubotics chat link",
          url: shareUrl,
        });
        return;
      } catch (err) {
        // Continue to clipboard/prompt fallback if user cancels or share is unavailable.
        console.warn("Native share failed, trying fallback:", err?.message || err);
      }
    }

    if (clipboardSupported) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        alert("Chat link copied to clipboard");
        return;
      } catch (err) {
        console.warn("Clipboard API failed, trying legacy copy:", err?.message || err);
      }
    }

    try {
      const input = document.createElement("textarea");
      input.value = shareUrl;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.focus();
      input.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(input);
      if (ok) {
        alert("Chat link copied to clipboard");
        return;
      }
    } catch (err) {
      console.warn("Legacy copy failed:", err?.message || err);
    }

    window.prompt("Copy this chat link:", shareUrl);
  }

  async function handleRenameSession(session, e) {
    e.stopPropagation();
    setOpenSessionMenuId(null);
    const nextName = window.prompt("Rename chat:", getSessionLabel(session));
    if (nextName === null) return;
    const clean = nextName.trim();
    if (!clean) return;
    try {
      const res = await axios.put(`${API_BASE}/api/sessions/${session.id}`, { name: clean });
      const updated = res.data?.session;
      if (!updated) return;
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? { ...s, name: updated.name } : s)));
    } catch (err) {
      alert(err.response?.data?.error || "Failed to rename chat");
    }
  }

  async function handleContinueSharedChat() {
    if (!shareToken) return;
    if (!token) {
      setPendingContinueShared(true);
      setAuthIntentMode("login");
      setShowAuthScreen(true);
      return;
    }
    await continueSharedChatWithCurrentAuth();
  }

  async function continueSharedChatWithCurrentAuth() {
    if (!shareToken) return;
    try {
      const historyPayload = (sharedMessages || []).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const res = await axios.post(`${API_BASE}/api/public/share/${shareToken}/continue`, {
        history: historyPayload,
      });
      const newSessionId = res.data?.session?.id;
      if (!newSessionId) return;
      const url = new URL(window.location.href);
      url.searchParams.delete("share");
      url.searchParams.set("session", String(newSessionId));
      window.history.replaceState({}, "", url.toString());
      setShareToken(null);
      await fetchSessions();
      setSelectedSessionId(newSessionId);
      setMessages(res.data?.messages || []);
    } catch (err) {
      alert(err.response?.data?.error || "Failed to continue shared chat");
    }
  }

  function openAuthFor(mode) {
    setAuthIntentMode(mode);
    setSharedLimitModal(null);
    if (shareToken && !token) {
      setPendingContinueShared(true);
    }
    setShowAuthScreen(true);
  }

  // Handle file attachment selection
  async function handleFileAttachment(event) {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    let targetSessionId = selectedSessionId;
    if (!targetSessionId) {
      try {
        targetSessionId = await ensureSessionForMessage("File upload");
      } catch (err) {
        console.error("Session auto-create for file upload failed:", err);
        alert("Failed to create chat for file upload");
        return;
      }
    }

    setUploading(true);
    const formData = new FormData();
    formData.append('sessionId', targetSessionId);
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

      const csvFiles = files.filter((f) =>
        f.type === "text/csv" || String(f.name || "").toLowerCase().endsWith(".csv")
      );

      if (csvFiles.length > 0) {
        for (const csvFile of csvFiles) {
          const csvFormData = new FormData();
          csvFormData.append('file', csvFile);
          csvFormData.append('sessionId', targetSessionId);
          await axios.post(`${API_BASE}/api/upload-data`, csvFormData);
        }
        const attRes = await axios.get(`${API_BASE}/api/attachments`, {
          params: { sessionId: targetSessionId },
        });
        setSessionAttachments(attRes.data.attachments || []);
      }
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

    const text = input.trim() || "(Sent files)";
    const isAnonymousSharedMode = !!shareToken && !token;
    const isAnonymousPublicMode = !token && !shareToken;
    const activeModel = token ? selectedModel : ANONYMOUS_DEFAULT_MODEL;
    if (
      (isAnonymousSharedMode && anonymousSharedQuestionCount >= 15) ||
      (isAnonymousPublicMode && anonymousQuestionCount >= 15)
    ) {
      setSharedLimitModal("hard");
      return;
    }
    setLoading(true);

    if (editingMessageId) {
      try {
        const res = await axios.put(`${API_BASE}/api/messages/${editingMessageId}`, {
          content: text,
          deepSearch: deepSearchEnabled,
          model: activeModel,
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
    if (!isAnonymousSharedMode && !isAnonymousPublicMode) {
      setMessages((prev) => [...prev, tempMsg]);
    }

    // Clear attached files from UI
    const attachmentIdsToSend = [...pendingAttachmentIds];
    setAttachedFiles([]);
    setPendingAttachmentIds([]);

    setIsTyping(true);
    try {
      if (isAnonymousSharedMode) {
        const tempUser = { id: Date.now(), role: "user", content: text };
        setSharedMessages((prev) => [...prev, tempUser]);
        const historyForApi = [...sharedMessages, tempUser].map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const res = await axios.post(`${API_BASE}/api/public/share/${shareToken}/chat`, {
          content: text,
          history: historyForApi,
          model: ANONYMOUS_DEFAULT_MODEL,
        });
        const assistant = String(res.data?.assistant || "").trim() || "No reply";
        setSharedMessages((prev) => [...prev, { id: Date.now() + 1, role: "assistant", content: assistant }]);

        const nextCount = anonymousSharedQuestionCount + 1;
        setAnonymousSharedQuestionCount(nextCount);
        if (nextCount === 10) setSharedLimitModal("soft");
        if (nextCount >= 15) setSharedLimitModal("hard");
        setInput("");
        return;
      }

      if (isAnonymousPublicMode) {
        const tempUser = { id: Date.now(), role: "user", content: text };
        setAnonymousMessages((prev) => [...prev, tempUser]);
        const historyForApi = [...anonymousMessages, tempUser].map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const res = await axios.post(`${API_BASE}/api/public/chat`, {
          content: text,
          history: historyForApi,
          model: ANONYMOUS_DEFAULT_MODEL,
        });
        const assistant = String(res.data?.assistant || "").trim() || "No reply";
        setAnonymousMessages((prev) => [...prev, { id: Date.now() + 1, role: "assistant", content: assistant }]);

        const nextCount = anonymousQuestionCount + 1;
        setAnonymousQuestionCount(nextCount);
        if (nextCount === 10) setSharedLimitModal("soft");
        if (nextCount >= 15) setSharedLimitModal("hard");
        setInput("");
        return;
      }

      const targetSessionId = await ensureSessionForMessage(text);
      const res = await axios.post(`${API_BASE}/api/messages`, {
        sessionId: targetSessionId,
        content: text,
        deepSearch: deepSearchEnabled,
        model: activeModel,
        attachmentIds: attachmentIdsToSend.length > 0 ? attachmentIdsToSend : undefined
      });
      setMessages(res.data.messages || []);
    } catch (err) {
      console.error("Send error", err);
      if (isAnonymousSharedMode) {
        setSharedMessages((prev) => [
          ...prev,
          { id: Date.now() + 1, role: "assistant", content: "Error talking to server" },
        ]);
      } else if (isAnonymousPublicMode) {
        setAnonymousMessages((prev) => [
          ...prev,
          { id: Date.now() + 1, role: "assistant", content: "Error talking to server" },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: "assistant",
            content: "Error talking to server",
          },
        ]);
      }
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

  async function handleCopy(text, key = null) {
    try {
      await navigator.clipboard.writeText(text);
      if (key) {
        setCopiedCodeKey(key);
        if (copyResetTimerRef.current) {
          clearTimeout(copyResetTimerRef.current);
        }
        copyResetTimerRef.current = setTimeout(() => {
          setCopiedCodeKey(null);
        }, 5000);
      }
    } catch (err) {
      console.error("Copy failed:", err);
    }
  }

  function handleChatAreaClick() {
    setOpenSessionMenuId(null);
    if (window.innerWidth <= 768 && sidebarVisible) {
      setSidebarVisible(false);
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
    setOpenSessionMenuId(null);
    setPendingDeleteSessionId(null);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("session", String(sessionId));
    window.history.replaceState({}, "", nextUrl.toString());
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

      const copyKey = `code-${idx}-${block.index}`;
      elements.push(
        <div className="code-block" key={`code-${idx}`}>
          <div className="code-header">
            <span className="code-language">{block.language}</span>
            <button className="copy-btn" onClick={() => handleCopy(block.code, copyKey)}>
              {copiedCodeKey === copyKey ? "Copied" : "Copy"}
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

  const isLandingMode =
    !shareToken &&
    !loading &&
    !isTyping &&
    (
      (!token && anonymousMessages.length === 0) ||
      (token && (!selectedSessionId || (selectedSessionId && messages.length === 0)))
    );

  return (
    <div className="app">
      <div className="layout">

        <aside className={`sidebar ${sidebarVisible ? 'visible' : 'hidden'}`}>
          <div className="sidebar-header">
            <div className="brand">
              <div className="brand-icon" aria-hidden="true"></div>
              <h2>NexaCore AI</h2>
            </div>
            <button className="new-chat-btn" onClick={handleNewChat}>
              <span className="btn-icon">+</span>
              <span className="btn-text">New Chat</span>
            </button>
            {token && (
              <>
                <button
                  className="search-chats-btn"
                  onClick={() => {
                    const next = !showSessionSearch;
                    setShowSessionSearch(next);
                    if (!next) setSessionSearchQuery("");
                  }}
                >
                  <span className="btn-text">Search chats</span>
                </button>
                {showSessionSearch && (
                  <input
                    className="search-chats-input"
                    type="text"
                    placeholder="Search chats..."
                    value={sessionSearchQuery}
                    onChange={(e) => setSessionSearchQuery(e.target.value)}
                  />
                )}
              </>
            )}
          </div>

          <div className="session-list">
            {!token && !shareToken && (
              <div className="empty-sessions">
                <div className="empty-icon">Guest</div>
                <p>Anonymous chat mode</p>
                <small>Login for deep search, files, and saved chats</small>
              </div>
            )}

            {token && sessions.length === 0 && (
              <div className="empty-sessions">
                <div className="empty-icon">Chat</div>
                <p>No chats yet</p>
                <small>Create your first chat to get started</small>
              </div>
            )}

            {token && filteredSessions.map((session) => (
              <div
                key={session.id}
                className={`session-item ${session.id === selectedSessionId ? 'active' : ''}`}
                onClick={() => handleSessionSelect(session.id)}
              >
                <div className="session-icon">•</div>
                <span className="session-name">
                  {getSessionLabel(session)}
                </span>
                <div
                  className="session-actions"
                  onMouseEnter={() => {
                    setPendingDeleteSessionId(null);
                    setOpenSessionMenuId(session.id);
                  }}
                  onMouseLeave={() => setOpenSessionMenuId((prev) => (prev === session.id ? null : prev))}
                >
                  <button
                    className="session-menu-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteSessionId(null);
                      setOpenSessionMenuId((prev) => (prev === session.id ? null : session.id));
                    }}
                    title="Chat actions"
                  >
                    ...
                  </button>
                  {openSessionMenuId === session.id && (
                    <div className="session-menu" onClick={(e) => e.stopPropagation()}>
                      <>
                          <button onClick={(e) => handleShareSession(session, e)}>Share Chat</button>
                          <button onClick={(e) => handleRenameSession(session, e)}>Rename Chat</button>
                          <button
                            className="danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenSessionMenuId(null);
                            setPendingDeleteSessionId(session.id);
                          }}
                        >
                          Delete Chat
                        </button>
                      </>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {token && sessions.length > 0 && filteredSessions.length === 0 && (
              <div className="empty-sessions">
                <div className="empty-icon">Search</div>
                <p>No chats found</p>
                <small>Try a different keyword</small>
              </div>
            )}
          </div>

          <div className="sidebar-footer">
            {token ? (
              <>
                <button className="profile-entry-btn" onClick={toggleProfilePanel}>
                  <div className="profile-avatar">
                    {(currentUser?.username || "U").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="profile-entry-text">
                    <div className="profile-name">{currentUser?.username || "User"}</div>
                    <div className="profile-status">Active now</div>
                  </div>
                </button>
                {profileOpen && (
                  <div className="profile-panel">
                    <div className="profile-panel-title">Activity (last 3 days)</div>
                    <div className="profile-activity-list">
                      {activityLoading ? (
                        <div className="profile-empty">Loading activity...</div>
                      ) : recentActivity.length === 0 ? (
                        <div className="profile-empty">No recent activity</div>
                      ) : (
                        recentActivity.map((item) => (
                          <div key={item.id} className="profile-activity-row">
                            <div className="profile-activity-action">{formatActivityRow(item)}</div>
                            <div className="profile-activity-time">
                              {item.created_at ? new Date(item.created_at).toLocaleString() : ""}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="profile-panel-actions">
                      <button className="logout-btn" onClick={handleLogout}>
                        <span>&#8634;</span> Logout
                      </button>
                      <button
                        className="delete-account-btn"
                        onClick={() => {
                          setProfileOpen(false);
                          setPendingDeleteAccount(true);
                        }}
                      >
                        Delete Account
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <button className="logout-btn" onClick={() => openAuthFor("login")}>
                <span>&#8634;</span> Login
              </button>
            )}
          </div>
        </aside>

        {sidebarVisible && window.innerWidth <= 768 && (
          <div className="sidebar-overlay" onClick={() => setSidebarVisible(false)} />
        )}

        {pendingDeleteSessionId && (
          <div
            className="delete-chat-modal-overlay"
            onClick={() => setPendingDeleteSessionId(null)}
          >
            <div
              className="delete-chat-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <h3>Delete Chat</h3>
              <p>Are you sure to delete this chat</p>
              <div className="delete-chat-modal-actions">
                <button
                  className="confirm-btn"
                  onClick={() => handleDeleteSession(pendingDeleteSessionId)}
                >
                  Yes
                </button>
                <button
                  className="cancel-btn"
                  onClick={() => setPendingDeleteSessionId(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingDeleteAccount && (
          <div
            className="delete-chat-modal-overlay"
            onClick={() => setPendingDeleteAccount(false)}
          >
            <div
              className="delete-chat-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <h3>Delete Account</h3>
              <p>Deleting your account will result in premanent deletion of yout details from the database. Are you sure you want to deleted your account</p>
              <div className="delete-chat-modal-actions">
                <button className="confirm-btn" onClick={handleDeleteAccount}>Yes</button>
                <button className="cancel-btn" onClick={() => setPendingDeleteAccount(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {sharedLimitModal && (
          <div
            className="delete-chat-modal-overlay"
            onClick={() => sharedLimitModal === "soft" && setSharedLimitModal(null)}
          >
            <div className="delete-chat-modal" onClick={(e) => e.stopPropagation()}>
              {sharedLimitModal === "soft" ? (
                <>
                  <h3>Unlock Full Potential</h3>
                  <p>To use the complete potential please login</p>
                  <div className="delete-chat-modal-actions">
                    <button className="confirm-btn" onClick={() => openAuthFor("login")}>Login</button>
                    <button className="cancel-btn" onClick={() => setSharedLimitModal(null)}>Close</button>
                  </div>
                </>
              ) : (
                <>
                  <h3>Please Login To Continue</h3>
                  <p>You have reached the shared chat limit.</p>
                  <div className="delete-chat-modal-actions">
                    <button className="confirm-btn" onClick={() => openAuthFor("login")}>Login</button>
                    <button className="cancel-btn" onClick={() => openAuthFor("signup")}>Signup</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {!token && showAuthScreen && (
          <div className="auth-modal-overlay" onClick={() => { setShowAuthScreen(false); setPendingContinueShared(false); }}>
            <div className="auth-modal-content" onClick={(e) => e.stopPropagation()}>
              <AuthScreen />
            </div>
          </div>
        )}

        <main className={`chat-area ${isLandingMode ? 'landing-mode' : ''} ${!sidebarVisible ? 'expanded' : ''} ${filesSidebarVisible ? 'files-open' : ''}`} onClick={handleChatAreaClick}>
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
                <div className="header-icon" aria-hidden="true"></div>
                <h1>NexaCore AI</h1>
              </div>
              <div className="header-actions">
                {token && (
                  <div className="model-select-wrap">
                    <select
                      className="model-select"
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      title="Select chat model"
                    >
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <button
                  className={`deep-search-btn ${deepSearchEnabled ? "active" : ""}`}
                  onClick={() => setDeepSearchEnabled((prev) => !prev)}
                  disabled={!token}
                  title="Use deep web research for next message"
                >
                  {deepSearchEnabled ? "Deep Search On" : "Deep Search"}
                </button>
                <button 
                  className="files-toggle-btn"
                  onClick={() => setFilesSidebarVisible(!filesSidebarVisible)}
                  disabled={!token}
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
              {isLandingMode && (
                <div className="hero-title">{landingTitle}</div>
              )}
              {shareToken && sharedView.loading && (
                <div className="empty-state"><div className="empty-state-content"><p>Loading shared chat...</p></div></div>
              )}
              {shareToken && sharedView.error && (
                <div className="empty-state"><div className="empty-state-content"><p>{sharedView.error}</p></div></div>
              )}
              {shareToken && !sharedView.loading && !sharedView.error &&
                sharedMessages.map((msg) => (
                  <div
                    key={msg.id + (msg.created_at || "")}
                    className={`message-row ${msg.role === "user" ? "user-row" : "ai-row"}`}
                  >
                    <div className="message-avatar">{msg.role === "user" ? "U" : "AI"}</div>
                    <div className="bubble">
                      <div className="sender">{msg.role === "user" ? "You" : "NexaCore AI"}</div>
                      <div className="content">{renderMessageContent(msg.content)}</div>
                    </div>
                  </div>
                ))
              }
              {!isLandingMode && !token && !shareToken && anonymousMessages.length === 0 && (
                <div className="empty-state">
                  <div className="empty-state-content">
                    <div className="empty-state-icon">Start</div>
                    <h2>Welcome to NexaCore AI</h2>
                    <p>Anonymous chat mode active. Login to unlock full features.</p>
                  </div>
                </div>
              )}
              {!token && !shareToken &&
                anonymousMessages.map((msg) => (
                  <div
                    key={msg.id + (msg.created_at || "")}
                    className={`message-row ${msg.role === "user" ? "user-row" : "ai-row"}`}
                  >
                    <div className="message-avatar">{msg.role === "user" ? "U" : "AI"}</div>
                    <div className="bubble">
                      <div className="sender">{msg.role === "user" ? "You" : "NexaCore AI"}</div>
                      <div className="content">{renderMessageContent(msg.content)}</div>
                    </div>
                  </div>
                ))
              }
              {!isLandingMode && token && !shareToken && !selectedSessionId && (
                <div className="empty-state">
                  <div className="empty-state-content">
                    <div className="empty-state-icon">Start</div>
                    <h2>Welcome to NexaCore AI</h2>
                    <p>Select a chat or create a new one to get started</p>
                  </div>
                </div>
              )}

              {!isLandingMode && token && !shareToken && selectedSessionId && messages.length === 0 && (
                <div className="empty-state">
                  <div className="empty-state-content">
                    <div className="empty-state-icon">Hi</div>
                    <h2>Start the conversation</h2>
                    <p>Ask me anything!</p>
                  </div>
                </div>
              )}

              {token && !shareToken && selectedSessionId &&
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
                        {msg.role === "user" ? "You" : "NexaCore AI"}
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

              {!shareToken && isTyping && (
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
              {shareToken && (
                <div className="share-continue-row">
                  <button type="button" className="share-continue-btn" onClick={handleContinueSharedChat}>
                    Continue this chat
                  </button>
                </div>
              )}
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
                  disabled={uploading || !!editingMessageId || !!shareToken || !token}
                  title="Upload files and CSV analytics"
                >
                  +
                </button>
                <textarea
                  placeholder="Ask anything"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                />
                <button
                  className="send-btn"
                  onClick={handleSend}
                  disabled={loading || (!input.trim() && attachedFiles.length === 0)}
                >
                  {loading ? "..." : editingMessageId ? "Resend" : "↗"}
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
    </div>
  );
}





