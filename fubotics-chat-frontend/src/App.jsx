import { useEffect, useState, useRef } from "react";
import axios from "axios";
import html2canvas from "html2canvas";
import nexacoreLogo from "./assets/nexacore-logo.svg";
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
const INTRO_TYPING_TEXT = "NexaCore";
const INTRO_NOTE = "Starting secure chat, saved sessions, files, and research tools.";
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
  const [composerCodeDraft, setComposerCodeDraft] = useState(null);
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
  const [allUserAttachments, setAllUserAttachments] = useState([]);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [openSessionMenuId, setOpenSessionMenuId] = useState(null);
  const [openFloatingChatMenu, setOpenFloatingChatMenu] = useState(false);
  const [openFloatingModelMenu, setOpenFloatingModelMenu] = useState(false);
  const [incognitoDraftSelected, setIncognitoDraftSelected] = useState(false);
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
  const [incognitoMessages, setIncognitoMessages] = useState([]);
  const [anonymousQuestionCount, setAnonymousQuestionCount] = useState(0);
  const [anonymousSharedQuestionCount, setAnonymousSharedQuestionCount] = useState(0);
  const [sharedLimitModal, setSharedLimitModal] = useState(null); // "soft" | "hard" | null
  const [copiedCodeKey, setCopiedCodeKey] = useState(null);
  const copyResetTimerRef = useRef(null);
  const activeRequestControllerRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerToolsRef = useRef(null);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [processSteps, setProcessSteps] = useState([]);
  const [processStepIndex, setProcessStepIndex] = useState(0);
  const [pinnedSessionIds, setPinnedSessionIds] = useState(() => {
    try {
      const raw = localStorage.getItem("pinnedSessionIds");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((v) => Number.isInteger(v)) : [];
    } catch {
      return [];
    }
  });
  const [landingTitle, setLandingTitle] = useState(LANDING_TITLES[0]);
  const [showStartupIntro, setShowStartupIntro] = useState(true);
  const [typedIntroText, setTypedIntroText] = useState("");
  const getSessionLabel = (session) => {
    if (session?.name) return session.name;
    if (Number.isInteger(session?.session_number)) return `Session ${session.session_number}`;
    return `Chat ${session?.id}`;
  };
  const filteredSessions = sessions.filter((session) =>
    getSessionLabel(session).toLowerCase().includes(sessionSearchQuery.trim().toLowerCase())
  );
  const pinnedSet = new Set(pinnedSessionIds);
  const orderedSessions = [...filteredSessions].sort((a, b) => {
    const aPinned = pinnedSet.has(a.id) ? 1 : 0;
    const bPinned = pinnedSet.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return 0;
  });
  const selectedSession = sessions.find((s) => s.id === selectedSessionId) || null;
  const showIncognitoDraftHint = token && !shareToken && !selectedSessionId && incognitoDraftSelected;
  const showFloatingSessionMenu = token && !shareToken && !showIncognitoDraftHint;
  const activeModelLabel = token
    ? (availableModels.find((m) => m.id === selectedModel)?.label || selectedModel)
    : "SambaNova (Anonymous)";
  const activeProcessStatus = processSteps[processStepIndex] || "Generating response...";
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
    localStorage.setItem("pinnedSessionIds", JSON.stringify(pinnedSessionIds));
  }, [pinnedSessionIds]);

  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [messages, incognitoMessages, anonymousMessages, sharedMessages, isTyping]);

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
    if (!isTyping || processSteps.length <= 1) return;
    const timer = setInterval(() => {
      setProcessStepIndex((prev) => (prev + 1) % processSteps.length);
    }, 1600);
    return () => clearInterval(timer);
  }, [isTyping, processSteps]);

  useEffect(() => {
    if (!showStartupIntro) return;
    let charIndex = 0;
    const typeTimer = window.setInterval(() => {
      charIndex += 1;
      setTypedIntroText(INTRO_TYPING_TEXT.slice(0, charIndex));
      if (charIndex >= INTRO_TYPING_TEXT.length) {
        window.clearInterval(typeTimer);
      }
    }, 150);

    const dismissTimer = window.setTimeout(() => {
      setShowStartupIntro(false);
    }, 3600);

    return () => {
      window.clearInterval(typeTimer);
      window.clearTimeout(dismissTimer);
    };
  }, [showStartupIntro]);

  function inferProcessSteps(text, options = {}) {
    const prompt = String(text || "").toLowerCase();
    if (options.editing) {
      return ["Updating message...", "Rebuilding answer...", "Finalizing edit..."];
    }
    if (options.deepSearch) {
      return ["Searching sources...", "Reading pages...", "Building cited answer..."];
    }
    if (options.thinking) {
      return ["Thinking deeply...", "Evaluating options...", "Composing response..."];
    }
    if (options.hasFiles) {
      return ["Processing files...", "Extracting context...", "Generating answer..."];
    }
    if (/generate|create|make|export|convert|prepare/.test(prompt) && /image|pdf|ppt|doc|docx|notes|document/.test(prompt)) {
      return ["Preparing content...", "Generating file...", "Attaching downloadable output..."];
    }
    if (/code|function|class|api|bug|debug|fix|refactor/.test(prompt)) {
      return ["Analyzing code request...", "Generating solution...", "Formatting output..."];
    }
    return ["Understanding prompt...", "Generating response...", "Finalizing output..."];
  }

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!composerToolsRef.current) return;
      if (!composerToolsRef.current.contains(event.target)) {
        setComposerMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
      if (activeRequestControllerRef.current) {
        activeRequestControllerRef.current.abort();
        activeRequestControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (token) {
      localStorage.setItem("accessToken", token);
      axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      setComposerCodeDraft(null);
      setIncognitoDraftSelected(false);
      setIncognitoMessages([]);
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
      setIncognitoMessages([]);
      setIncognitoDraftSelected(false);
      setComposerCodeDraft(null);
      setSessionAttachments([]);
      setAllUserAttachments([]);
    }
    rotateLandingTitle();
  }, [token]);

  useEffect(() => {
    if (!token || !filesSidebarVisible) return;
    fetchAllUserAttachments();
    if (selectedSessionId) {
      axios
        .get(`${API_BASE}/api/attachments`, { params: { sessionId: selectedSessionId } })
        .then((res) => setSessionAttachments(res.data.attachments || []))
        .catch(() => setSessionAttachments([]));
    }
  }, [token, filesSidebarVisible, selectedSessionId]);

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
            <div className="logo-icon" aria-hidden="true">
              <img src={nexacoreLogo} alt="NexaCore AI logo" className="logo-image" />
            </div>
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
      await fetchAllUserAttachments();

      const searchParams = new URLSearchParams(window.location.search);
      const requested = Number.parseInt(searchParams.get("session") || "", 10);
      const hasRequested = Number.isInteger(requested) && list.some((s) => s.id === requested);
      if (hasRequested) {
        setSelectedSessionId(requested);
        await fetchMessages(requested);
      } else {
        setSelectedSessionId(null);
        setMessages([]);
        setSessionAttachments([]);
        searchParams.delete("session");
        const next = new URL(window.location.href);
        next.search = searchParams.toString();
        window.history.replaceState({}, "", next.toString());
      }
    } catch (err) {
      console.error("Error loading sessions", err);
    }
  }

  async function fetchAllUserAttachments() {
    if (!token) return;
    try {
      const res = await axios.get(`${API_BASE}/api/attachments/all`);
      setAllUserAttachments(res.data.attachments || []);
    } catch (err) {
      console.error("Error loading user attachments", err);
      setAllUserAttachments([]);
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
    setComposerCodeDraft(null);
    setInput("");
    setEditingMessageId(null);
    setOpenSessionMenuId(null);
    setOpenFloatingChatMenu(false);
    setOpenFloatingModelMenu(false);
    setComposerMenuOpen(false);
    setIncognitoDraftSelected(false);
    setIncognitoMessages([]);
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
    setIncognitoDraftSelected(false);
    setIncognitoMessages([]);
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
      setPinnedSessionIds((prev) => prev.filter((id) => id !== sessionId));
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
      await fetchAllUserAttachments();
    } catch (err) {
      console.error("Error deleting session", err);
    }
  }

  async function handleShareSession(session, e) {
    e?.stopPropagation?.();
    setOpenSessionMenuId(null);
    setOpenFloatingChatMenu(false);
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
    e?.stopPropagation?.();
    setOpenSessionMenuId(null);
    setOpenFloatingChatMenu(false);
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

  function safeParseAnalysis(value) {
    if (!value) return null;
    if (typeof value === "object") return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function summarizeAttachmentAnalysis(analysis) {
    const parsed = safeParseAnalysis(analysis);
    if (!parsed) return "";
    const parts = [];
    if (parsed.subject) parts.push(parsed.subject);
    if (parsed.likely_type && parsed.likely_type !== parsed.subject) parts.push(parsed.likely_type);
    if (parsed.background) parts.push(`Background: ${parsed.background}`);
    if (Array.isArray(parsed.dominant_colors) && parsed.dominant_colors.length > 0) {
      parts.push(`Colors: ${parsed.dominant_colors.slice(0, 3).join(", ")}`);
    }
    if (parsed.visible_text) parts.push(`Text: ${parsed.visible_text}`);
    if (parsed.summary) parts.push(parsed.summary);
    return parts.join(" | ");
  }

  function isImageAttachmentLike(fileType, filename) {
    const lowerName = String(filename || "").toLowerCase();
    return (
      String(fileType || "").startsWith("image/") ||
      lowerName.endsWith(".png") ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg")
    );
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

      const returnedAttachments = Array.isArray(response.data?.attachments) ? response.data.attachments : [];
      const nextAttachedFiles = files.map((f, idx) => {
        const attachment = returnedAttachments[idx] || {};
        return {
          name: f.name,
          id: response.data.attachmentIds[idx],
          fileType: attachment.file_type || f.type,
          analysisResult: attachment.analysis_result || null,
        };
      });
      setAttachedFiles(prev => [
        ...prev,
        ...nextAttachedFiles,
      ]);

      setPendingAttachmentIds(prev => [...prev, ...response.data.attachmentIds]);

      const needsVisionRefresh = nextAttachedFiles.filter(
        (file) => file.id && isImageAttachmentLike(file.fileType, file.name) && !file.analysisResult
      );
      if (needsVisionRefresh.length > 0) {
        Promise.allSettled(
          needsVisionRefresh.map((file) =>
            axios.post(`${API_BASE}/api/attachments/${file.id}/vision-analyze`)
          )
        ).then(async (results) => {
          const refreshedById = new Map();
          results.forEach((result) => {
            const attachment = result.status === "fulfilled" ? result.value?.data?.attachment : null;
            if (attachment?.id) refreshedById.set(attachment.id, attachment);
          });
          if (refreshedById.size > 0) {
            setAttachedFiles((prev) =>
              prev.map((file) => {
                const refreshed = refreshedById.get(file.id);
                return refreshed
                  ? {
                      ...file,
                      fileType: refreshed.file_type || file.fileType,
                      analysisResult: refreshed.analysis_result || file.analysisResult,
                    }
                  : file;
              })
            );
            if (targetSessionId) {
              try {
                const attRes = await axios.get(`${API_BASE}/api/attachments`, {
                  params: { sessionId: targetSessionId },
                });
                setSessionAttachments(attRes.data.attachments || []);
              } catch (_) {
                // Ignore background refresh failure.
              }
            }
            fetchAllUserAttachments();
          }
        });
      }

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
      await fetchAllUserAttachments();
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

  async function handleCaptureScreenshot() {
    if (!chatWindowRef.current) {
      alert("Chat area not available for screenshot.");
      return;
    }
    try {
      const canvas = await html2canvas(chatWindowRef.current, {
        backgroundColor: null,
        useCORS: true,
        scale: window.devicePixelRatio > 1 ? 2 : 1,
      });
      const dataUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `chat_screenshot_${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setComposerMenuOpen(false);
    } catch (err) {
      console.error("Screenshot capture failed:", err);
      alert("Failed to capture screenshot");
    }
  }

  async function handleSend(options = null) {
    if (loading) {
      if (activeRequestControllerRef.current) {
        activeRequestControllerRef.current.abort();
        activeRequestControllerRef.current = null;
      }
      setLoading(false);
      setIsTyping(false);
      setProcessSteps([]);
      setProcessStepIndex(0);
      if (editingMessageId) {
        setEditingMessageId(null);
        if (selectedSessionId && token) {
          fetchMessages(selectedSessionId);
        }
      }
      return;
    }
    const resolvedOptions = options && typeof options === "object" ? options : {};
    const codeDraftToSend = resolvedOptions.codeDraft || composerCodeDraft;
    const typedInput = input.trim();
    if (!codeDraftToSend && !typedInput && attachedFiles.length === 0) return;

    const followupForCode = String(resolvedOptions.replyText ?? typedInput).trim();
    const text = codeDraftToSend
      ? `[PASTED CODE FILE] ${codeDraftToSend.filename} (${codeDraftToSend.lines} lines)\n\n\`\`\`${codeDraftToSend.language || "txt"}\n${codeDraftToSend.content}\n\`\`\`\n\n${followupForCode || "Please analyze this code and tell me what to improve."}`
      : (typedInput || "(Sent files)");
    const displayText = codeDraftToSend
      ? `[PASTED CODE FILE] ${codeDraftToSend.filename} (${codeDraftToSend.lines} lines)\n${followupForCode || "Please analyze this code."}`
      : text;
    const isAnonymousSharedMode = !!shareToken && !token;
    const isAnonymousPublicMode = !token && !shareToken;
    const isLoggedInIncognitoMode = false;
    const activeModel = token ? selectedModel : ANONYMOUS_DEFAULT_MODEL;
    if (
      (isAnonymousSharedMode && anonymousSharedQuestionCount >= 15) ||
      (isAnonymousPublicMode && anonymousQuestionCount >= 15)
    ) {
      setSharedLimitModal("hard");
      return;
    }
    setLoading(true);
    setComposerMenuOpen(false);
    setProcessSteps(inferProcessSteps(text, {
      editing: !!editingMessageId,
      deepSearch: deepSearchEnabled,
      thinking: thinkingEnabled,
      hasFiles: attachedFiles.length > 0,
    }));
    setProcessStepIndex(0);
    const requestController = new AbortController();
    activeRequestControllerRef.current = requestController;

    if (editingMessageId) {
      const editIdRaw = String(editingMessageId || "");
      if (!editIdRaw || editIdRaw.startsWith("temp-")) {
        setEditingMessageId(null);
        setLoading(false);
        setIsTyping(false);
        setProcessSteps([]);
        setProcessStepIndex(0);
        return;
      }
      try {
        const res = await axios.put(`${API_BASE}/api/messages/${editIdRaw}`, {
          content: text,
          deepSearch: deepSearchEnabled,
          thinking: thinkingEnabled,
          rewriteThread: true,
          model: activeModel,
        }, { signal: requestController.signal });
        setMessages(res.data.messages || []);
        setInput("");
        setEditingMessageId(null);
      } catch (err) {
        if (err?.code === "ERR_CANCELED" || err?.name === "CanceledError" || err?.name === "AbortError") {
          setEditingMessageId(null);
          if (selectedSessionId && token) {
            await fetchMessages(selectedSessionId);
          }
          return;
        }
        console.error("Edit resend error", err);
        alert(err.response?.data?.error || "Failed to edit message");
      } finally {
        setLoading(false);
        setIsTyping(false);
        setDeepSearchEnabled(false);
        setProcessSteps([]);
        setProcessStepIndex(0);
      }
      return;
    }

    setInput("");
    if (codeDraftToSend) {
      setComposerCodeDraft(null);
    }
    let optimisticTempId = null;

    // Optimistic UI
    const tempMsg = {
      id: `temp-${Date.now()}`,
      isTemporary: true,
      role: "user",
      content: displayText,
      attachments: attachedFiles.map(f => ({ filename: f.name }))
    };
    optimisticTempId = tempMsg.id;
    if (!isAnonymousSharedMode && !isAnonymousPublicMode && !isLoggedInIncognitoMode) {
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
          thinking: thinkingEnabled,
          model: ANONYMOUS_DEFAULT_MODEL,
        }, { signal: requestController.signal });
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
          thinking: thinkingEnabled,
          model: ANONYMOUS_DEFAULT_MODEL,
        }, { signal: requestController.signal });
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
        thinking: thinkingEnabled,
        model: activeModel,
        attachmentIds: attachmentIdsToSend.length > 0 ? attachmentIdsToSend : undefined
      }, { signal: requestController.signal });
      setMessages(res.data.messages || []);
    } catch (err) {
      if (err?.code === "ERR_CANCELED" || err?.name === "CanceledError" || err?.name === "AbortError") {
        if (optimisticTempId) {
          setMessages((prev) => prev.filter((m) => String(m.id) !== String(optimisticTempId)));
        }
        if (codeDraftToSend) {
          setComposerCodeDraft(codeDraftToSend);
          setInput(followupForCode);
        } else {
          setInput(text);
        }
        return;
      }
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
      if (activeRequestControllerRef.current === requestController) {
        activeRequestControllerRef.current = null;
      }
      setLoading(false);
      setIsTyping(false);
      setDeepSearchEnabled(false);
      setProcessSteps([]);
      setProcessStepIndex(0);
    }
  }

  function startEditingMessage(msg) {
    if (!msg || msg.role !== "user") return;
    if (msg.isTemporary || String(msg.id || "").startsWith("temp-")) {
      setInput(msg.content || "");
      setMessages((prev) => prev.filter((m) => String(m.id) !== String(msg.id)));
      setEditingMessageId(null);
      return;
    }
    setEditingMessageId(msg.id);
    setInput(msg.content || "");
    setAttachedFiles([]);
    setPendingAttachmentIds([]);
  }

  function cancelEditingMessage() {
    setEditingMessageId(null);
    setInput("");
    setComposerCodeDraft(null);
  }

  function detectComposerCodeDraft(text) {
    const value = String(text || "");
    if (!value.trim()) return null;

    const fencedRegex = /(```|~~~)\s*([^\n`]*)\r?\n([\s\S]*?)\r?\n?\1[ \t]*/g;
    const blocks = Array.from(value.matchAll(fencedRegex));
    if (blocks.length > 0) {
      const totalLines = blocks.reduce((sum, m) => sum + String(m[3] || "").split(/\r?\n/).length, 0);
      if (totalLines > 100) {
        const rawLang = String(blocks[0]?.[2] || "").trim();
        const primaryLang = rawLang || inferCodeLanguageFromContent(value);
        const filename = buildInlineCodeFilename(primaryLang, value, 0);
        return { filename, content: value, lines: totalLines, language: primaryLang };
      }
      return null;
    }

    const lines = value.split(/\r?\n/);
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (nonEmpty.length <= 100) return null;
    const codeLikeCount = nonEmpty.filter((l) =>
      /[{}();=<>]|^\s*(const|let|var|function|class|if|for|while|import|export|def|return|public|private|static|async|await)\b/.test(l)
    ).length;
    if (codeLikeCount >= Math.max(20, Math.ceil(nonEmpty.length * 0.2))) {
      const guessedLang = inferCodeLanguageFromContent(value);
      const filename = buildInlineCodeFilename(guessedLang, value, 0);
      return { filename, content: value, lines: nonEmpty.length, language: guessedLang };
    }
    return null;
  }

  function handleComposerInputChange(e) {
    const nextValue = String(e.target.value || "");
    const draft = detectComposerCodeDraft(nextValue);
    if (draft) {
      setComposerCodeDraft(draft);
      setInput("");
      return;
    }
    setInput(nextValue);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(composerCodeDraft ? { codeDraft: composerCodeDraft } : undefined);
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
    setOpenFloatingChatMenu(false);
    setOpenFloatingModelMenu(false);
    setComposerMenuOpen(false);
    if (window.innerWidth <= 768 && sidebarVisible) {
      setSidebarVisible(false);
    }
  }

  function togglePinSession(sessionId) {
    setPinnedSessionIds((prev) => {
      if (prev.includes(sessionId)) return prev.filter((id) => id !== sessionId);
      return [sessionId, ...prev];
    });
    setOpenFloatingChatMenu(false);
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

  function buildInlineCodeFilename(language, code, index) {
    const lang = String(language || "txt").toLowerCase();
    const extMap = {
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
      text: "txt",
      txt: "txt",
    };
    const ext = extMap[lang] || "txt";
    const firstLine = String(code || "").split("\n").find((l) => l.trim()) || "code";
    const safeBase = firstLine
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join("_") || "code_block";
    return `${safeBase}_${Date.now()}_${index}.${ext}`;
  }

  function inferCodeLanguageFromContent(code) {
    const text = String(code || "");
    const lower = text.toLowerCase();
    if (/^\s*<(!doctype html|html|head|body|div|script|style)\b/m.test(lower)) return "html";
    if (/\bimport\s+react\b|\buseeffect\b|\busestate\b|\bjsx\b/.test(lower)) return "jsx";
    if (/\binterface\s+\w+|\btype\s+\w+\s*=|\bas\s+\w+/.test(lower)) return "ts";
    if (/\bdef\s+\w+\(|\bfrom\s+\w+\s+import\b|\bimport\s+\w+/.test(lower)) return "py";
    if (/\bpublic\s+class\b|\bsystem\.out\.println\b/.test(lower)) return "java";
    if (/\bconsole\.log\b|\bfunction\s+\w+\(|\bconst\s+\w+\s*=/.test(lower)) return "js";
    if (/\bselect\b[\s\S]*\bfrom\b/.test(lower)) return "sql";
    if (/^\s*\{[\s\S]*\}\s*$/m && /"\w+"\s*:/.test(text)) return "json";
    if (/^\s*[-\w]+\s*:\s*.+$/m && !/[{};]/.test(text)) return "yml";
    if (/#include\s*<|int\s+main\s*\(/.test(text)) return "cpp";
    if (/\bpackage\s+main\b|\bfunc\s+\w+\(/.test(lower)) return "go";
    if (/\bfn\s+\w+\(|\blet\s+mut\b/.test(lower)) return "rs";
    if (/\bbody\s*\{[\s\S]*\}/.test(lower) && /[.#][\w-]+\s*\{/.test(lower)) return "css";
    return "txt";
  }

  function downloadInlineCodeFile(filename, code) {
    const blob = new Blob([String(code || "")], { type: "text/plain;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  }

  function handleSessionSelect(sessionId) {
    setSelectedSessionId(sessionId);
    setIncognitoDraftSelected(false);
    setIncognitoMessages([]);
    setOpenSessionMenuId(null);
    setOpenFloatingChatMenu(false);
    setOpenFloatingModelMenu(false);
    setComposerMenuOpen(false);
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
    const safeContent = String(content || "");
    const elements = [];
    const codeBlockRegex = /(```|~~~)\s*([^\n`]*)\r?\n([\s\S]*?)\r?\n?\1[ \t]*/g;
    let match;
    const codeBlocks = [];
    
    while ((match = codeBlockRegex.exec(safeContent)) !== null) {
      codeBlocks.push({
        index: match.index,
        length: match[0].length,
        language: match[2] || 'text',
        code: match[3].trim(),
        fullMatch: match[0]
      });
    }

    let lastIndex = 0;
    const totalCodeLines = codeBlocks.reduce((sum, block) => {
      const blockLines = block.code ? block.code.split(/\r?\n/).length : 0;
      return sum + blockLines;
    }, 0);
    const collapseAllCodeBlocks = totalCodeLines > 100;
    if (codeBlocks.length === 0) {
      const plainLines = safeContent.split(/\r?\n/);
      const nonEmpty = plainLines.filter((l) => l.trim().length > 0);
      const codeLikeCount = nonEmpty.filter((l) => /[{}();=<>]|^\s*(const|let|var|function|class|if|for|while|import|export|def|return|public|private|static|async|await)\b/.test(l)).length;
      if (nonEmpty.length > 100 && codeLikeCount >= Math.max(20, Math.ceil(nonEmpty.length * 0.2))) {
        const suggestedFile = buildInlineCodeFilename("txt", safeContent, 0);
        return (
          <div className="pasted-code-inline-card">
            <div className="pasted-code-inline-preview">{suggestedFile}</div>
            <span className="pasted-code-tag">PASTED</span>
            <button
              type="button"
              className="pasted-code-inline-download"
              onClick={() => downloadInlineCodeFile(suggestedFile, safeContent)}
            >
              Download code file
            </button>
            <div className="pasted-code-inline-hint">
              Code is over 100 lines. Reply with what to do next: explain, debug, refactor, optimize, test, or convert.
            </div>
          </div>
        );
      }
    }

    codeBlocks.forEach((block, idx) => {
      if (block.index > lastIndex) {
        const textSegment = safeContent.substring(lastIndex, block.index);
        elements.push(
          <span key={`text-${idx}`}>
            {renderTextWithFormatting(textSegment)}
          </span>
        );
      }

      const copyKey = `code-${idx}-${block.index}`;
      const blockLineCount = block.code ? block.code.split(/\r?\n/).length : 0;
      if (collapseAllCodeBlocks || blockLineCount > 100) {
        const suggestedFile = buildInlineCodeFilename(block.language, block.code, idx);
        elements.push(
          <div className="pasted-code-inline-card" key={`code-file-${idx}`}>
            <div className="pasted-code-inline-preview">{suggestedFile}</div>
            <span className="pasted-code-tag">PASTED</span>
            <button
              type="button"
              className="pasted-code-inline-download"
              onClick={() => downloadInlineCodeFile(suggestedFile, block.code)}
            >
              Download code file
            </button>
            <div className="pasted-code-inline-hint">
              Code is over 100 lines. Reply with what to do next: explain, debug, refactor, optimize, test, or convert.
            </div>
          </div>
        );
      } else {
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
      }

      lastIndex = block.index + block.length;
    });

    if (lastIndex < safeContent.length) {
      const textSegment = safeContent.substring(lastIndex);
      elements.push(
        <span key={`text-final`}>
          {renderTextWithFormatting(textSegment)}
        </span>
      );
    }

    return elements.length > 0 ? elements : renderTextWithFormatting(safeContent);
  }

  function isLikelyCodeFilename(filename) {
    const name = String(filename || "").toLowerCase();
    return /\.(js|jsx|ts|tsx|py|java|c|cpp|cs|go|rs|rb|php|swift|kt|sql|html|css|json|ya?ml|sh|txt)$/.test(name);
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

      const bulletMatch = trimmedLine.match(/^[-*]\s+(.+)$/);
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
      (
        token &&
        (
          (incognitoDraftSelected && !selectedSessionId && incognitoMessages.length === 0) ||
          (!incognitoDraftSelected && (!selectedSessionId || (selectedSessionId && messages.length === 0)))
        )
      )
    );

  if (showStartupIntro) {
    return (
      <div className="startup-splash">
        <div className="startup-intro" aria-hidden={!showStartupIntro}>
          <div className="startup-intro-chip">
            <span className="startup-intro-dot" />
            Initializing
          </div>
          <div className="startup-intro-title">
            {typedIntroText}
            <span className="startup-intro-caret" />
          </div>
          <div className="startup-intro-note">{INTRO_NOTE}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="layout">

        <aside className={`sidebar ${sidebarVisible ? 'visible' : 'hidden'}`}>
          <div className="sidebar-header">
            <div className="brand">
              <div className="brand-icon" aria-hidden="true">
                <img src={nexacoreLogo} alt="NexaCore AI logo" className="brand-logo-image" />
              </div>
              <h2>NexaCore AI</h2>
            </div>
            <button className="new-chat-btn" onClick={handleNewChat} title="New chat" aria-label="New chat">
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

            {token && orderedSessions.map((session) => (
              <div
                key={session.id}
                className={`session-item ${session.id === selectedSessionId ? 'active' : ''}`}
                onClick={() => handleSessionSelect(session.id)}
              >
                <div className="session-icon" />
                <span className="session-name">
                  {getSessionLabel(session)}
                  {pinnedSet.has(session.id) ? " (Pinned)" : ""}
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
                          <button onClick={(e) => { e.stopPropagation(); togglePinSession(session.id); }}>
                            {pinnedSet.has(session.id) ? "Unpin Chat" : "Pin Chat"}
                          </button>
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
              setOpenFloatingModelMenu(false);
              setOpenFloatingChatMenu(false);
              setSidebarVisible(!sidebarVisible);
            }}
            title={sidebarVisible ? "Hide chats" : "Show chats"}
          >
            <span className="toggle-icon">
              <span className="toggle-line" />
              <span className="toggle-line" />
              <span className="toggle-line" />
            </span>
          </button>

          <div className="floating-chat-controls" onClick={(e) => e.stopPropagation()}>
            <div className="floating-controls-left">
              <button
                className="floating-pill"
                onClick={() => {
                  setOpenFloatingChatMenu(false);
                  setSidebarVisible((prev) => !prev);
                }}
                title={sidebarVisible ? "Hide chats" : "Show chats"}
              >
                <span className="toggle-icon floating-toggle-icon">
                  <span className="toggle-line" />
                  <span className="toggle-line" />
                  <span className="toggle-line" />
                </span>
              </button>
              <div className="floating-model-wrap">
                <button
                  className="floating-pill floating-model-btn"
                  onClick={() => {
                    if (!token) return;
                    setOpenFloatingChatMenu(false);
                    setOpenFloatingModelMenu((prev) => !prev);
                  }}
                  title={token ? "Choose model" : "Login to switch models"}
                >
                  NexaCore
                </button>
                {token && openFloatingModelMenu && (
                  <div className="floating-menu floating-model-menu">
                    {availableModels.map((model) => (
                      <button
                        key={model.id}
                        className={model.id === selectedModel ? "active" : ""}
                        onClick={() => {
                          setSelectedModel(model.id);
                          setOpenFloatingModelMenu(false);
                        }}
                        title={model.label}
                      >
                        {model.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="floating-controls-right">
              <button className="floating-pill floating-new-chat-btn" onClick={handleNewChat} title="New chat" aria-label="New chat">
                +
              </button>
              {showFloatingSessionMenu && (
                <div className="floating-chat-menu-wrap">
                  <button
                    className="floating-pill floating-dots-btn"
                    onClick={() => {
                      setOpenFloatingModelMenu(false);
                      setOpenFloatingChatMenu((prev) => !prev);
                    }}
                    title="Chat actions"
                  >
                    ...
                  </button>
                  {openFloatingChatMenu && (
                    <div className="floating-menu">
                      {selectedSession ? (
                        <>
                          <button onClick={() => togglePinSession(selectedSession.id)}>
                            {pinnedSet.has(selectedSession.id) ? "Unpin Chat" : "Pin Chat"}
                          </button>
                          <button onClick={() => handleShareSession(selectedSession)}>Share Chat</button>
                          <button onClick={() => handleRenameSession(selectedSession)}>Rename Chat</button>
                          <button
                            className="danger"
                            onClick={() => {
                              setOpenFloatingChatMenu(false);
                              setPendingDeleteSessionId(selectedSession.id);
                            }}
                          >
                            Delete Chat
                          </button>
                        </>
                      ) : !token ? (
                        <button
                          onClick={() => {
                            setIncognitoDraftSelected(true);
                            setIncognitoMessages([]);
                            setOpenFloatingChatMenu(false);
                          }}
                        >
                          Use Incognito Draft
                        </button>
                      ) : null}
                      
                    </div>
                  )}
                </div>
              )}
              {showIncognitoDraftHint && (
                <button
                  className="floating-pill floating-incognito-draft"
                  title="Incognito draft mode is active"
                  onClick={() => {
                    setIncognitoDraftSelected(false);
                    setIncognitoMessages([]);
                    setInput("");
                    setOpenFloatingChatMenu(false);
                    setOpenFloatingModelMenu(false);
                  }}
                >
                  . . Incognito Draft (On)
                </button>
              )}
            </div>
          </div>

          <div className="chat-column">
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
              {token && !shareToken && incognitoDraftSelected && !selectedSessionId &&
                incognitoMessages.map((msg) => (
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
              {!isLandingMode && token && !shareToken && !selectedSessionId && (!incognitoDraftSelected || incognitoMessages.length === 0) && (
                <div className="empty-state">
                  <div className="empty-state-content">
                    <div className="empty-state-icon">Start</div>
                    <h2>Welcome to NexaCore AI</h2>
                    <p>{incognitoDraftSelected ? "Incognito draft is active. Messages stay unsaved." : "Select a chat or create a new one to get started"}</p>
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
                            <button
                              key={idx}
                              type="button"
                              className={`attachment-badge ${/\[PASTED CODE FILE\]/i.test(msg.content || "") && isLikelyCodeFilename(att.filename) ? "pasted-code-file-card" : ""}`}
                              onClick={() => handleDownloadAttachment(att.id, att.filename)}
                              title={`Download ${att.filename}`}
                            >
                              {/\[PASTED CODE FILE\]/i.test(msg.content || "") && isLikelyCodeFilename(att.filename) ? (
                                <>
                                  <div className="pasted-code-preview">{att.filename}</div>
                                  <span className="pasted-code-tag">PASTED</span>
                                </>
                              ) : (
                                <span>File {att.filename}</span>
                              )}
                            </button>
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
                    <div className="typing-status-text">{activeProcessStatus}</div>
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
              {(thinkingEnabled || deepSearchEnabled || attachedFiles.length > 0) && (
                <div className="composer-active-row">
                  {thinkingEnabled && (
                    <button className="composer-active-pill" onClick={() => setThinkingEnabled(false)}>
                      Thinking On <span className="composer-active-close">x</span>
                    </button>
                  )}
                  {deepSearchEnabled && (
                    <button className="composer-active-pill" onClick={() => setDeepSearchEnabled(false)}>
                      Deep research On <span className="composer-active-close">x</span>
                    </button>
                  )}
                  {attachedFiles.length > 0 && (
                    <button
                      className="composer-active-pill"
                      onClick={() => {
                        setAttachedFiles([]);
                        setPendingAttachmentIds([]);
                      }}
                    >
                      Files selected ({attachedFiles.length}) <span className="composer-active-close">x</span>
                    </button>
                  )}
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
                      <div className="attached-file-copy">
                        <span>{file.name}</span>
                        {file.analysisResult && (
                          <small className="attached-file-summary">
                            {summarizeAttachmentAnalysis(file.analysisResult)}
                          </small>
                        )}
                      </div>
                      <button onClick={() => removeAttachedFile(idx)}>X</button>
                    </div>
                  ))}
                </div>
              )}
              <div className={`input-wrapper ${composerCodeDraft ? "with-code-draft" : ""}`}>
                {composerCodeDraft && (
                  <div className="composer-code-inline">
                    <div className="composer-code-card-name">{composerCodeDraft.filename}</div>
                    <div className="composer-code-card-meta">{composerCodeDraft.lines} lines detected</div>
                    <div className="composer-code-card-actions">
                      <span className="pasted-code-tag">PASTED</span>
                      <button
                        type="button"
                        className="composer-code-download-btn"
                        onClick={() => downloadInlineCodeFile(composerCodeDraft.filename, composerCodeDraft.content)}
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        className="composer-code-clear-btn"
                        onClick={() => setComposerCodeDraft(null)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
                <div className="composer-tools" ref={composerToolsRef}>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileAttachment}
                    style={{ display: 'none' }}
                    multiple
                    accept=".csv,.txt,.json,.pdf,.png,.jpg,.jpeg,.xls,.xlsx,.docx,.pptx,image/*"
                    disabled={uploading}
                  />
                  <button
                    className="attach-btn"
                    onClick={() => setComposerMenuOpen((prev) => !prev)}
                    disabled={uploading}
                    title="Open quick actions"
                  >
                    +
                  </button>
                  {composerMenuOpen && (
                    <div className="composer-menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => {
                          fileInputRef.current?.click();
                          setComposerMenuOpen(false);
                        }}
                        disabled={uploading || !!editingMessageId || !!shareToken || !token || (incognitoDraftSelected && !selectedSessionId)}
                      >
                        Add photos & files
                      </button>
                      <button
                        onClick={() => {
                          handleCaptureScreenshot();
                        }}
                      >
                        Take screenshot
                      </button>
                      <div className="composer-menu-divider" />
                      <button
                        className={thinkingEnabled ? "active" : ""}
                        onClick={() => {
                          setThinkingEnabled((prev) => {
                            const next = !prev;
                            if (next) setDeepSearchEnabled(false);
                            return next;
                          });
                          setComposerMenuOpen(false);
                        }}
                      >
                        {thinkingEnabled ? "Thinking On" : "Thinking"}
                      </button>
                      <button
                        className={deepSearchEnabled ? "active" : ""}
                        onClick={() => {
                          setDeepSearchEnabled((prev) => {
                            const next = !prev;
                            if (next) setThinkingEnabled(false);
                            return next;
                          });
                          setComposerMenuOpen(false);
                        }}
                        disabled={!token}
                      >
                        {deepSearchEnabled ? "Deep research On" : "Deep research"}
                      </button>
                      <div className="composer-model-label">Model: {activeModelLabel}</div>
                    </div>
                  )}
                </div>
                <textarea
                  placeholder={composerCodeDraft ? "Reply..." : "Ask anything"}
                  value={input}
                  onChange={handleComposerInputChange}
                  onKeyDown={handleKeyDown}
                  rows={1}
                />
                <button
                  className="files-inline-btn"
                  onClick={() => setFilesSidebarVisible((prev) => !prev)}
                  disabled={!token}
                  title={token ? "Toggle Files" : "Login to view files"}
                >
                  Files
                </button>
                <button
                  className="send-btn"
                  onClick={() => handleSend(composerCodeDraft ? { codeDraft: composerCodeDraft } : undefined)}
                  disabled={!loading && (!input.trim() && attachedFiles.length === 0 && !composerCodeDraft)}
                >
                  {loading ? "Stop" : editingMessageId ? "Resend" : "Send"}
                </button>
              </div>
            </div>
          </div>

          {/* FILES SIDEBAR */}
          <aside className={`files-sidebar ${filesSidebarVisible ? 'visible' : 'hidden'}`}>
            <div className="files-sidebar-header">
              <h2>Files</h2>
              <button 
                className="close-files-btn"
                onClick={() => setFilesSidebarVisible(false)}
                title="Close"
              >
                X
              </button>
            </div>

            <div className="files-content">
              {(() => {
                const source = selectedSessionId ? sessionAttachments : allUserAttachments;
                const generated = source.filter((att) => att.is_generated);
                const uploaded = source.filter((att) => !att.is_generated);

                if (source.length === 0) {
                  return (
                    <div className="no-session-message">
                      <p>No saved files yet</p>
                      <small>Upload or generate files in any chat to keep them here</small>
                    </div>
                  );
                }

                return (
                  <>
                    <div className="file-category">
                      <h3 className="category-title">Generated Files</h3>
                      <div className="files-list">
                        {generated.length === 0 ? (
                          <div className="empty-files">
                            <p>No generated files</p>
                          </div>
                        ) : (
                          generated.map((attachment) => (
                            <div key={attachment.id} className="file-item">
                              <div className="file-info-wrapper">
                                <div className="file-name-text">{attachment.original_filename}</div>
                                <div className="file-size-text">{(attachment.file_size / 1024).toFixed(1)} KB</div>
                                {attachment.analysis_result && (
                                  <div className="file-analysis-text">
                                    {summarizeAttachmentAnalysis(attachment.analysis_result)}
                                  </div>
                                )}
                              </div>
                              <button
                                onClick={() => handleDownloadAttachment(attachment.id, attachment.original_filename)}
                                className="file-download-btn"
                                title="Download"
                              >
                                Download
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="file-category">
                      <h3 className="category-title">Uploaded Files</h3>
                      <div className="files-list">
                        {uploaded.length === 0 ? (
                          <div className="empty-files">
                            <p>No uploaded files</p>
                          </div>
                        ) : (
                          uploaded.map((attachment) => (
                            <div key={attachment.id} className="file-item">
                              <div className="file-info-wrapper">
                                <div className="file-name-text">{attachment.original_filename}</div>
                                <div className="file-size-text">{(attachment.file_size / 1024).toFixed(1)} KB</div>
                                {attachment.analysis_result && (
                                  <div className="file-analysis-text">
                                    {summarizeAttachmentAnalysis(attachment.analysis_result)}
                                  </div>
                                )}
                              </div>
                              <button
                                onClick={() => handleDownloadAttachment(attachment.id, attachment.original_filename)}
                                className="file-download-btn"
                                title="Download"
                              >
                                Download
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </>
                );
              })()}
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

