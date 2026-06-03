import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  FiDownload,
  FiMusic,
  FiFilm,
  FiLink,
  FiClock,
  FiSun,
  FiMoon,
  FiEye,
  FiUser,
  FiAlertCircle,
  FiInfo,
  FiThumbsUp,
  FiCalendar,
  FiX,
} from "react-icons/fi";
import "./App.css";

// ─── Constants ───────────────────────────────────────────────────────────────
const SUPPORTED_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "instagram.com",
  "x.com",
  "twitter.com",
];
const HISTORY_KEY = "mdl_history_v2";
const MAX_HISTORY = 5;
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Types ───────────────────────────────────────────────────────────────────
interface Format {
  quality: string;
  height: number;
  ext: string;
  filesize: number | null;
  hasAudio: boolean;
}

interface Meta {
  title: string;
  thumbnail: string;
  duration: number;
  uploader: string;
  viewCount: number;
  likeCount: number;
  uploadDate: string;
  isPlaylist: boolean;
  playlistNote: string | null;
  formats: Format[];
  originalUrl: string;
}

interface HistoryItem {
  url: string;
  title: string;
  ts: number;
}

interface HealthData {
  status: string;
  uptime: number;
  ytDlpVersion?: string;
  queue?: { size: number; max: number };
  memory?: { heapUsed: string };
}

interface DlState {
  active: boolean;
  progress: number;
  done: boolean;
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmtDuration(s: number): string {
  if (!s || s <= 0) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtNumber(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n.toLocaleString();
}

function fmtDate(d: string): string {
  if (!d || d.length !== 8) return "";
  return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

// ─── History ──────────────────────────────────────────────────────────────────
function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveToHistory(url: string, title: string): void {
  const prev = loadHistory().filter((h) => h.url !== url);
  const next = [{ url, title: title || url, ts: Date.now() }, ...prev].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}

// ─── URL Validation ───────────────────────────────────────────────────────────
function isSupportedUrl(u: string): boolean {
  try {
    const host = new URL(u).hostname.replace(/^www\./, "");
    return SUPPORTED_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"video" | "mp3">("video");
  const [formats, setFormats] = useState<Format[]>([]);
  const [selected, setSelected] = useState<Format | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [infoMsg, setInfoMsg] = useState("");
  const [dlState, setDlState] = useState<DlState>({ active: false, progress: 0, done: false });
  const [theme, setTheme] = useState("dark");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHist, setShowHist] = useState(false);
  const [health, setHealth] = useState<HealthData | null>(null);
  const originalUrlRef = useRef("");
  const histRef = useRef<HTMLDivElement>(null);

  // ─── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const savedMode = localStorage.getItem("mdl_mode") as "video" | "mp3" | null;
    const savedTheme = localStorage.getItem("mdl_theme") || "dark";
    if (savedMode === "mp3" || savedMode === "video") setMode(savedMode);
    applyTheme(savedTheme);
    setHistory(loadHistory());

    navigator.clipboard
      ?.readText?.()
      .then((text) => {
        try {
          if (isSupportedUrl(text.trim())) setUrl(text.trim());
        } catch {}
      })
      .catch(() => {});

    fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json())
      .then((d) => setHealth(d as HealthData))
      .catch(() => setHealth(null));

    const handler = (e: MouseEvent) => {
      if (histRef.current && !histRef.current.contains(e.target as Node)) {
        setShowHist(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ─── Theme ────────────────────────────────────────────────────────────────
  function applyTheme(t: string) {
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("mdl_theme", t);
  }
  const toggleTheme = () => applyTheme(theme === "dark" ? "light" : "dark");

  // ─── Fetch Video ──────────────────────────────────────────────────────────
  const fetchVideo = useCallback(
    async (inputUrl?: string) => {
      const target = (inputUrl || url).trim();
      if (!target) return setError("الرجاء إدخال رابط الفيديو");
      if (inputUrl) setUrl(inputUrl);

      setError("");
      setInfoMsg("");
      setLoading(true);
      setFormats([]);
      setMeta(null);
      setSelected(null);
      setShowHist(false);

      try {
        const resp = await fetch(`${BASE}/api/extract`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: target }),
          signal: AbortSignal.timeout(35_000),
        });
        const data = (await resp.json()) as Meta & { success: boolean; error?: string };

        if (data.success) {
          setMeta(data);
          setFormats(data.formats);
          if (data.formats.length) setSelected(data.formats[0]);
          originalUrlRef.current = target;
          saveToHistory(target, data.title);
          setHistory(loadHistory());
          if (data.playlistNote) setInfoMsg(data.playlistNote);
        } else {
          setError(data.error || "حدث خطأ غير متوقع");
        }
      } catch (e) {
        const err = e as { name?: string; message?: string };
        if (err.name === "TimeoutError") setError("انتهت مهلة الطلب، حاول مجدداً");
        else setError("فشل الاتصال بالخادم");
      } finally {
        setLoading(false);
      }
    },
    [url]
  );

  // ─── Download ─────────────────────────────────────────────────────────────
  const download = useCallback(async () => {
    if (!selected) return setError("اختر جودة التحميل أولاً");
    setError("");
    setDlState({ active: true, progress: 3, done: false });

    const params = new URLSearchParams({
      height: String(selected.height),
      originalUrl: originalUrlRef.current,
      filename: meta?.title || "media",
      mode,
    });

    try {
      const response = await fetch(`${BASE}/api/download?${params}`);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const totalSize = parseInt(response.headers.get("content-length") || "0");
      const reader = response.body!.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const progress =
          totalSize > 0
            ? Math.min(Math.round((received / totalSize) * 100), 99)
            : Math.min(Math.round(received / 100_000), 90);
        setDlState({ active: true, progress, done: false });
      }

      const ext = mode === "mp3" ? "mp3" : "mp4";
      const type = mode === "mp3" ? "audio/mpeg" : "video/mp4";
      const blob = new Blob(chunks, { type });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(meta?.title || "media").replace(/[^\w\u0600-\u06FF\s\-]/g, "_")}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);

      setDlState({ active: true, progress: 100, done: true });
      setTimeout(() => setDlState({ active: false, progress: 0, done: false }), 3000);
    } catch (e) {
      setError((e as Error).message || "فشل التحميل، حاول مجدداً");
      setDlState({ active: false, progress: 0, done: false });
    }
  }, [selected, meta, mode]);

  // ─── Mode ─────────────────────────────────────────────────────────────────
  const changeMode = (newMode: "video" | "mp3") => {
    setMode(newMode);
    localStorage.setItem("mdl_mode", newMode);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !loading) fetchVideo();
    if (e.key === "Escape") setShowHist(false);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app" dir="rtl" lang="ar">
      {/* Top Bar */}
      <div className="top-bar">
        <div className="server-status">
          {health ? (
            <span className="status-live" title={`yt-dlp: ${health.ytDlpVersion || ""}`}>
              <span className="status-dot" />
              مباشر
            </span>
          ) : (
            <span className="status-off">غير متصل</span>
          )}
        </div>
        <button className="icon-btn" onClick={toggleTheme} aria-label="تبديل الثيم">
          {theme === "dark" ? <FiSun size={16} /> : <FiMoon size={16} />}
        </button>
      </div>

      {/* Title */}
      <h1 className="title">⬇ Media Downloader</h1>
      <p className="subtitle">يوتيوب · تيك توك · إنستغرام · تويتر</p>

      {/* Card */}
      <div className="card">
        {/* URL Input */}
        <div className="input-group" ref={histRef}>
          <div className="input-wrap">
            <FiLink className="input-icon" size={16} />
            <input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (showHist) setShowHist(false);
              }}
              onKeyDown={handleKey}
              onFocus={() => {
                if (history.length > 0 && !url) setShowHist(true);
              }}
              placeholder="الصق رابط الفيديو هنا..."
              className="input"
              dir="ltr"
              type="url"
              autoComplete="off"
              spellCheck={false}
            />
            {url && (
              <button
                className="input-clear"
                onClick={() => {
                  setUrl("");
                  setMeta(null);
                  setFormats([]);
                  setError("");
                }}
                aria-label="مسح الرابط"
              >
                <FiX size={14} />
              </button>
            )}
          </div>

          {/* History Dropdown */}
          {showHist && history.length > 0 && (
            <div className="hist-drop" role="listbox" aria-label="الروابط السابقة">
              <div className="hist-header">
                <span>الروابط السابقة</span>
                <button
                  className="hist-clear-btn"
                  onClick={() => {
                    localStorage.removeItem(HISTORY_KEY);
                    setHistory([]);
                    setShowHist(false);
                  }}
                >
                  مسح الكل
                </button>
              </div>
              {history.map((h, i) => (
                <button
                  key={i}
                  className="hist-item"
                  role="option"
                  onClick={() => fetchVideo(h.url)}
                >
                  <FiLink size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
                  <span className="hist-title">{h.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Mode Selector */}
        <div className="modes">
          <button
            className={`mode-btn${mode === "video" ? " active" : ""}`}
            onClick={() => changeMode("video")}
            aria-pressed={mode === "video"}
          >
            <FiFilm size={15} />
            فيديو MP4
          </button>
          <button
            className={`mode-btn${mode === "mp3" ? " active" : ""}`}
            onClick={() => changeMode("mp3")}
            aria-pressed={mode === "mp3"}
          >
            <FiMusic size={15} />
            صوت MP3
          </button>
        </div>

        {/* Fetch Button */}
        <button
          className="btn btn-primary"
          onClick={() => fetchVideo()}
          disabled={loading || !url.trim()}
        >
          {loading ? (
            <>
              <span className="spinner" />
              جاري الجلب...
            </>
          ) : (
            <>
              <FiDownload size={16} />
              جلب معلومات الفيديو
            </>
          )}
        </button>

        {/* Error */}
        {error && (
          <div className="alert alert-error" role="alert">
            <FiAlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        {/* Info */}
        {infoMsg && (
          <div className="alert alert-info" role="status">
            <FiInfo size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{infoMsg}</span>
          </div>
        )}

        {/* Meta Card */}
        {meta && (
          <div className="meta-card">
            {meta.thumbnail && (
              <img
                src={meta.thumbnail}
                alt={meta.title}
                className="thumb"
                loading="lazy"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            )}
            <div className="meta-body">
              <p className="video-title">{meta.title}</p>
              <div className="meta-chips">
                {meta.duration > 0 && (
                  <span className="chip">
                    <FiClock size={11} />
                    {fmtDuration(meta.duration)}
                  </span>
                )}
                {meta.uploader && (
                  <span className="chip">
                    <FiUser size={11} />
                    {meta.uploader}
                  </span>
                )}
                {meta.viewCount > 0 && (
                  <span className="chip">
                    <FiEye size={11} />
                    {fmtNumber(meta.viewCount)}
                  </span>
                )}
                {meta.likeCount > 0 && (
                  <span className="chip">
                    <FiThumbsUp size={11} />
                    {fmtNumber(meta.likeCount)}
                  </span>
                )}
                {meta.uploadDate && (
                  <span className="chip">
                    <FiCalendar size={11} />
                    {fmtDate(meta.uploadDate)}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Quality Selector */}
        {formats.length > 0 && (
          <div className="quality-section">
            <p className="section-label">اختر الجودة</p>
            <div className="quals">
              {formats.map((f) => (
                <button
                  key={f.height}
                  onClick={() => setSelected(f)}
                  className={`qual-btn${selected?.height === f.height ? " active" : ""}`}
                  aria-pressed={selected?.height === f.height}
                  title={f.filesize ? fmtSize(f.filesize) : ""}
                >
                  <span className="qual-label-text">{f.quality}</span>
                  {f.filesize && <span className="qual-size">{fmtSize(f.filesize)}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Download Button */}
        {selected && !dlState.active && (
          <button className="btn btn-download" onClick={download}>
            <FiDownload size={16} />
            تحميل {mode === "mp3" ? "MP3" : `${selected.quality} MP4`}
            {selected.filesize && (
              <span className="dl-size">({fmtSize(selected.filesize)})</span>
            )}
          </button>
        )}

        {/* Progress Bar */}
        {dlState.active && (
          <div className={`progress-wrap${dlState.done ? " done" : ""}`}>
            <div
              className="progress-fill"
              style={{ width: `${dlState.progress}%` }}
            />
            <span className="progress-label">
              {dlState.done ? "✅ اكتمل التحميل!" : `جاري التحميل ${dlState.progress}%`}
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <p className="footer">🔒 جميع التحميلات تتم عبر الخادم بشكل آمن — لا يُفتح أي رابط خارجي</p>

      {/* Debug (dev only) */}
      {health && import.meta.env.DEV && (
        <p className="health-debug">
          uptime: {health.uptime}s · queue: {health.queue?.size ?? 0}/{health.queue?.max ?? 3} · mem: {health.memory?.heapUsed}
        </p>
      )}
    </div>
  );
}
