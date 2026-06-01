import { Router, type IRouter, type Request, type Response } from "express";
import { execSync, execFile } from "child_process";
import https from "https";
import http from "http";
import path from "path";
import fs from "fs";
import { logger } from "../lib/logger";

// ─── Locate system yt-dlp binary ─────────────────────────────────────────────
function findYtDlp(): string {
  try {
    const found = execSync("which yt-dlp", { timeout: 3000 }).toString().trim();
    if (found) return found;
  } catch {}
  try {
    const nix = execSync("ls /nix/store/*/bin/yt-dlp 2>/dev/null | head -1", { timeout: 3000 })
      .toString().trim();
    if (nix) return nix;
  } catch {}
  throw new Error("yt-dlp not found");
}

const YTDLP_BIN = findYtDlp();
logger.info({ bin: YTDLP_BIN }, "yt-dlp binary located");

// ─── Helper: run yt-dlp, return stdout ───────────────────────────────────────
function runYtDlp(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    execFile(YTDLP_BIN, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(t);
      if (err) { reject(new Error(stderr || err.message)); return; }
      resolve(stdout);
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < retries) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

// ─── Twitter/X URL Normalisation ─────────────────────────────────────────────
interface TwitterNorm { canonical: string; tweetId: string; }

function normalizeTwitterUrl(rawUrl: string): TwitterNorm | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }

  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  if (host !== "x.com" && host !== "twitter.com") return null;

  // Match /i/status/{id}  OR  /{user}/status/{id}  (strips trailing /photo/N etc.)
  const match = u.pathname.match(/\/(?:i\/)?(?:\w+\/)?status\/(\d{5,25})/);
  if (!match) return null;

  const tweetId = match[1];
  return { tweetId, canonical: `https://twitter.com/i/status/${tweetId}` };
}

// ─── Twitter Error Classification ────────────────────────────────────────────
type TwitterErrorType =
  | "PRIVATE_ACCOUNT" | "TWEET_DELETED" | "LOGIN_REQUIRED"
  | "AGE_RESTRICTED"  | "NO_VIDEO"      | "RATE_LIMITED"
  | "NETWORK_ERROR"   | "EXTRACTION_FAILED";

const TWITTER_ARABIC: Record<TwitterErrorType, string> = {
  PRIVATE_ACCOUNT:   "هذا الحساب خاص. لا يمكن تحميل فيديوهات الحسابات الخاصة.",
  TWEET_DELETED:     "تم حذف التغريدة أو أن الرابط غير صحيح.",
  LOGIN_REQUIRED:    "هذا المحتوى يتطلب تسجيل الدخول إلى تويتر.",
  AGE_RESTRICTED:    "هذا المحتوى مقيد بالعمر ولا يمكن تحميله.",
  NO_VIDEO:          "هذه التغريدة لا تحتوي على فيديو.",
  RATE_LIMITED:      "تم الوصول للحد المسموح. الرجاء المحاولة بعد قليل.",
  NETWORK_ERROR:     "خطأ في الاتصال. تحقق من اتصالك بالإنترنت.",
  EXTRACTION_FAILED: "تعذر استخراج الفيديو من X/Twitter. قد يكون المقطع خاصًا أو يحتاج تسجيل دخول أو غير مدعوم.",
};

function classifyTwitterError(msg: string): TwitterErrorType {
  const m = msg.toLowerCase();
  if (m.includes("protected") || m.includes("private"))        return "PRIVATE_ACCOUNT";
  if (m.includes("no video") || m.includes("could not find") ||
      m.includes("no media"))                                   return "NO_VIDEO";
  if (m.includes("not found") || m.includes("404") ||
      m.includes("does not exist") || m.includes("deleted") ||
      m.includes("suspended") || m.includes("removed"))        return "TWEET_DELETED";
  if (m.includes("login") || m.includes("sign in") ||
      m.includes("authenticate") || m.includes("401") ||
      m.includes("authorization"))                              return "LOGIN_REQUIRED";
  if (m.includes("age") || m.includes("sensitive") ||
      m.includes("restricted"))                                 return "AGE_RESTRICTED";
  if (m.includes("rate") || m.includes("429") ||
      m.includes("too many"))                                   return "RATE_LIMITED";
  if (m.includes("timeout") || m.includes("connection") ||
      m.includes("network") || m.includes("unreachable") ||
      m.includes("econnrefused") || m.includes("enotfound"))   return "NETWORK_ERROR";
  return "EXTRACTION_FAILED";
}

// ─── Short-URL resolver (TikTok vt./vm. links need GET-based redirect follow) ─
const TIKTOK_SHORT_HOSTS = new Set(["vt.tiktok.com", "vm.tiktok.com"]);

function followRedirect(inputUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const parsed = (() => { try { return new URL(inputUrl); } catch { return null; } })();
    if (!parsed) { resolve(inputUrl); return; }

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname:           parsed.hostname,
        port:               parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:               parsed.pathname + parsed.search,
        method:             "GET",
        rejectUnauthorized: false,
        headers: {
          "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 8000,
      },
      (res) => {
        const loc = res.headers["location"];
        req.destroy();
        if (loc) { try { resolve(new URL(loc, inputUrl).toString()); } catch { resolve(loc); } }
        else resolve(inputUrl);
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(inputUrl); });
    req.on("error",   ()  => resolve(inputUrl));
    req.end();
  });
}

async function resolveShortUrl(url: string, maxHops = 6): Promise<string> {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const host = (() => { try { return new URL(current).hostname.toLowerCase(); } catch { return ""; } })();
    if (!TIKTOK_SHORT_HOSTS.has(host)) break;
    const next = await followRedirect(current);
    if (next === current) break;
    logger.info({ from: current, to: next }, "TikTok short URL resolved");
    current = next;
  }
  return current;
}

// ─── Platform detection ───────────────────────────────────────────────────────
type Platform = "youtube" | "tiktok" | "instagram" | "twitter" | "unknown";

function detectPlatform(url: string): Platform {
  try {
    const host = new URL(url).hostname.replace(/^(www\.|m\.)/, "").toLowerCase();
    if (host === "youtube.com" || host === "youtu.be")               return "youtube";
    if (host.includes("tiktok.com"))                                  return "tiktok";
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
    if (host === "x.com" || host === "twitter.com")                  return "twitter";
  } catch {}
  return "unknown";
}

// ─── Platform-specific yt-dlp args ───────────────────────────────────────────
const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_MOBILE  = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function extractArgs(platform: Platform): string[] {
  const base = ["--no-warnings", "--no-check-certificates", "--no-playlist"];
  switch (platform) {
    case "youtube":
      return [
        ...base,
        "--extractor-args", "youtube:player_client=android_vr,android",
        "--user-agent", UA_DESKTOP,
        "--socket-timeout", "20",
      ];
    case "tiktok":
      return [
        ...base,
        "--user-agent", UA_DESKTOP,
        "--add-header", "Referer:https://www.tiktok.com/",
        "--add-header", "Accept-Language:en-US,en;q=0.9,ar;q=0.8",
        "--socket-timeout", "30",
      ];
    case "instagram":
      return [
        ...base,
        "--user-agent", UA_MOBILE,
        "--add-header", "Referer:https://www.instagram.com/",
        "--socket-timeout", "25",
      ];
    case "twitter":
      return [
        ...base,
        "--user-agent", UA_DESKTOP,
        "--add-header", "Accept-Language:en-US,en;q=0.9",
        "--add-header", "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "--socket-timeout", "30",
        "--retries", "2",
      ];
    default:
      return [...base, "--user-agent", UA_DESKTOP, "--socket-timeout", "20"];
  }
}

function downloadFormatSel(platform: Platform, height: number): string {
  if (platform === "tiktok") {
    return [
      "download",
      `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[height=${height}]+bestaudio`,
      `bestvideo[height<=${height}][ext=mp4]+bestaudio`,
      `best[height<=${height}]`,
      "best",
    ].join("/");
  }
  return [
    `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height=${height}]+bestaudio`,
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}]+bestaudio`,
    `best[height<=${height}]`,
    "best",
  ].join("/");
}

// ─── Allowed Domains ─────────────────────────────────────────────────────────
const ALLOWED_SOURCE_DOMAINS = [
  "youtube.com", "youtu.be",
  "tiktok.com",
  "instagram.com",
  "x.com", "twitter.com",
];

function isAllowedSourceUrl(u: string): boolean {
  try {
    // Strip www. and m. prefixes before checking
    const host = new URL(u).hostname.replace(/^(www\.|m\.)/, "").toLowerCase();
    return ALLOWED_SOURCE_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch { return false; }
}

function safeName(s: string): string {
  return (s || "media")
    .toString()
    .replace(/[^\w\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/, "")
    .slice(0, 80) || "media";
}

function cleanupFiles(base: string): void {
  ["mp3", "webm", "m4a", "opus", "mp4", "part", "temp"].forEach((ext) => {
    const p = base + "." + ext;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  });
  try {
    const dir = path.dirname(base);
    const prefix = path.basename(base);
    fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).forEach((f) => {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    });
  } catch {}
}

function fmtError(e: unknown): string {
  const msg = String((e as Error)?.message || e || "");
  if (msg.includes("timeout"))                         return "انتهت مهلة الطلب، حاول مجدداً";
  if (msg.includes("cookies"))                         return "المحتوى خاص أو يتطلب تسجيل دخول";
  if (/private/i.test(msg))                            return "هذا الفيديو خاص ولا يمكن تحميله";
  if (msg.includes("not available in your country"))   return "الفيديو غير متاح في منطقتك";
  if (msg.includes("Unable to extract webpage video")) return "تيك توك يحجب الطلب مؤقتاً، أعد المحاولة لاحقاً";
  if (/unavailable|not available/i.test(msg))          return "الفيديو غير متاح";
  if (/removed|deleted/i.test(msg))                    return "تم حذف هذا الفيديو";
  if (msg.includes("HTTP Error 403"))                  return "الوصول مرفوض، أعد الجلب";
  if (msg.includes("HTTP Error 404"))                  return "الفيديو غير موجود";
  if (/sign.?in|login/i.test(msg))                     return "هذا الفيديو يتطلب تسجيل دخول";
  if (/geo.?restrict|region/i.test(msg))               return "الفيديو مقيّد جغرافياً";
  if (msg.includes("Unable to extract"))               return "تعذّر استخراج الفيديو، حاول مجدداً بعد قليل";
  return "فشل استخراج الفيديو، تحقق من الرابط وحاول مجدداً";
}

// ─── Tmp Dir ─────────────────────────────────────────────────────────────────
const TMP_DIR = path.join(process.cwd(), "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
const TMP_MAX_AGE = 10 * 60 * 1000;

function cleanTmp(): void {
  try {
    const now = Date.now();
    fs.readdirSync(TMP_DIR).forEach((f) => {
      const fp = path.join(TMP_DIR, f);
      try { if (now - fs.statSync(fp).mtimeMs > TMP_MAX_AGE) fs.unlinkSync(fp); } catch {}
    });
  } catch {}
}
cleanTmp();
setInterval(cleanTmp, 60 * 60 * 1000);

// ─── Download Queue ───────────────────────────────────────────────────────────
const MAX_CONCURRENT = 3;
let activeDownloads = 0;
const downloadQueue: Array<() => void> = [];

function enqueueDownload(fn: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeDownloads++;
      try { await fn(); resolve(); }
      catch (e) { reject(e); }
      finally {
        activeDownloads--;
        if (downloadQueue.length > 0) downloadQueue.shift()!();
      }
    };
    if (activeDownloads < MAX_CONCURRENT) run();
    else downloadQueue.push(run);
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────
const router: IRouter = Router();

// ─── Health ───────────────────────────────────────────────────────────────────
router.get("/health", (_req: Request, res: Response) => {
  let ytDlpVersion = "unknown";
  try { ytDlpVersion = execSync(`${YTDLP_BIN} --version`, { timeout: 3000 }).toString().trim(); } catch {}
  let tmpCount = 0;
  try { tmpCount = fs.readdirSync(TMP_DIR).length; } catch {}
  res.json({
    status: "ok", version: "6.0.0",
    uptime: Math.floor(process.uptime()), ytDlpVersion,
    queue: { active: activeDownloads, pending: downloadQueue.length, max: MAX_CONCURRENT },
    tmp: { files: tmpCount, maxAgeMins: TMP_MAX_AGE / 60000 },
    memory: {
      heapUsed:  Math.round(process.memoryUsage().heapUsed  / 1e6) + "MB",
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1e6) + "MB",
    },
  });
});

// ─── Extract ─────────────────────────────────────────────────────────────────
router.post("/extract", async (req: Request, res: Response) => {
  const startMs     = Date.now();
  const { url }     = (req.body as { url?: string }) || {};
  const rawPlatform = url ? detectPlatform(url) : "unknown";

  if (!url || typeof url !== "string")
    return void res.json({ success: false, error: "الرجاء إدخال رابط صالح" });
  if (url.length > 2048)
    return void res.json({ success: false, error: "الرابط طويل جداً" });
  if (!isAllowedSourceUrl(url))
    return void res.json({ success: false, error: "الرابط غير مدعوم — يُدعم: يوتيوب، تيك توك، إنستغرام، تويتر" });

  // Twitter/X: validate tweet ID format early
  if (rawPlatform === "twitter" && !normalizeTwitterUrl(url))
    return void res.json({
      success: false,
      error:   "رابط X/Twitter غير صالح. يجب أن يحتوي على معرّف التغريدة الرقمي.",
    });

  try {
    // Resolve final URL: Twitter -> canonical  |  TikTok -> follow redirects
    let resolvedUrl:   string;
    let normalizedUrl: string | undefined;
    let tweetId:       string | undefined;

    const twitterNorm = normalizeTwitterUrl(url);
    if (twitterNorm) {
      resolvedUrl   = twitterNorm.canonical;
      normalizedUrl = twitterNorm.canonical;
      tweetId       = twitterNorm.tweetId;
    } else {
      resolvedUrl = await resolveShortUrl(url);
    }

    const platform = detectPlatform(resolvedUrl);

    logger.info({
      event:          "extract_start",
      timestamp:      new Date().toISOString(),
      original_url:   url,
      normalized_url: normalizedUrl ?? resolvedUrl,
      tweet_id:       tweetId ?? null,
      platform,
    });

    const args    = [resolvedUrl, "--dump-single-json", ...extractArgs(platform)];
    const retries = platform === "twitter" ? 3 : platform === "tiktok" ? 2 : 1;
    const timeout = platform === "twitter" ? 40_000 : platform === "tiktok" ? 45_000 : 30_000;

    let stdout: string;
    try {
      stdout = await withRetry(() => runYtDlp(args, timeout), retries);
    } catch (rawErr) {
      const errMsg = String((rawErr as Error)?.message || "");
      const respMs = Date.now() - startMs;

      if (platform === "twitter") {
        const errType = classifyTwitterError(errMsg);
        logger.warn({
          event: "extract_failed", timestamp: new Date().toISOString(),
          original_url: url, normalized_url: normalizedUrl ?? resolvedUrl,
          tweet_id: tweetId ?? null, platform,
          success: false, error_type: errType, response_time_ms: respMs,
        });
        return void res.json({ success: false, error: TWITTER_ARABIC[errType] });
      }

      logger.error({
        event: "extract_failed", timestamp: new Date().toISOString(),
        original_url: url, normalized_url: normalizedUrl ?? resolvedUrl,
        platform, success: false, error_type: "EXTRACTION_FAILED",
        response_time_ms: respMs, err: errMsg,
      });
      return void res.json({ success: false, error: fmtError(rawErr) });
    }

    const info = JSON.parse(stdout) as Record<string, unknown>;
    if (!info) return void res.json({ success: false, error: "لم يتم الحصول على معلومات الفيديو" });

    const isPlaylist  = info["_type"] === "playlist" || info["_type"] === "multi_video";
    const seenH       = new Set<number>();
    const rawFormats  = ((info["formats"] as Array<Record<string, unknown>>) || []);
    const hasTikTokDl = platform === "tiktok" && rawFormats.some((f) => f["format_id"] === "download");

    const formats = rawFormats
      .filter((f) => {
        const h = f["height"] as number;
        const vcodec = (f["vcodec"] as string) || "";
        return h && h > 0 && vcodec !== "none" && f["ext"] !== "mhtml";
      })
      .map((f) => ({
        quality:     (f["height"] as number) + "p",
        height:      f["height"] as number,
        ext:         (f["ext"] as string) || "mp4",
        filesize:    (f["filesize"] as number) || (f["filesize_approx"] as number) || null,
        hasAudio:    (f["acodec"] as string) !== "none",
        noWatermark: platform === "tiktok" && hasTikTokDl,
      }))
      .filter((f) => { if (seenH.has(f.height)) return false; seenH.add(f.height); return true; })
      .sort((a, b) => b.height - a.height)
      .slice(0, 8);

    if (!formats.length) {
      if (platform === "twitter") {
        logger.warn({
          event: "extract_failed", timestamp: new Date().toISOString(),
          original_url: url, normalized_url: normalizedUrl ?? resolvedUrl,
          tweet_id: tweetId ?? null, platform,
          success: false, error_type: "NO_VIDEO",
          response_time_ms: Date.now() - startMs,
        });
        return void res.json({ success: false, error: TWITTER_ARABIC["NO_VIDEO"] });
      }
      return void res.json({ success: false, error: "لا توجد صيغ فيديو متاحة لهذا الرابط" });
    }

    logger.info({
      event: "extract_success", timestamp: new Date().toISOString(),
      original_url: url, normalized_url: normalizedUrl ?? resolvedUrl,
      tweet_id: tweetId ?? null, platform, success: true,
      format_count: formats.length, max_quality: formats[0]?.quality,
      response_time_ms: Date.now() - startMs,
    });

    return void res.json({
      success:      true,
      title:        (info["title"]      as string) || "فيديو بدون عنوان",
      thumbnail:    (info["thumbnail"]  as string) || "",
      duration:     (info["duration"]   as number) || 0,
      uploader:     (info["uploader"]   as string) || (info["channel"] as string) || "",
      viewCount:    (info["view_count"] as number) || 0,
      likeCount:    (info["like_count"] as number) || 0,
      uploadDate:   (info["upload_date"] as string) || "",
      isPlaylist,
      playlistNote: isPlaylist ? "ملاحظة: تم استخراج الفيديو الأول فقط من القائمة" : null,
      formats,
      originalUrl:  resolvedUrl,
      noWatermark:  hasTikTokDl,
    });

  } catch (e) {
    logger.error({
      event: "extract_error", timestamp: new Date().toISOString(),
      original_url: url, platform: rawPlatform,
      success: false, response_time_ms: Date.now() - startMs, err: e,
    });
    return void res.json({ success: false, error: fmtError(e) });
  }
});

// ─── Download ─────────────────────────────────────────────────────────────────
router.get("/download", async (req: Request, res: Response) => {
  const { originalUrl, filename, mode, height } = req.query as Record<string, string>;

  if (!originalUrl || !isAllowedSourceUrl(originalUrl))
    return void res.status(400).json({ error: "رابط المصدر غير صالح" });

  const name    = safeName(filename);
  const tmpBase = path.join(TMP_DIR, `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  const runDownload = async (): Promise<void> => {
    try {
      // Normalise Twitter or resolve TikTok short links
      let resolvedUrl = originalUrl;
      const twNorm = normalizeTwitterUrl(originalUrl);
      if (twNorm) resolvedUrl = twNorm.canonical;
      else        resolvedUrl = await resolveShortUrl(originalUrl);

      const platform = detectPlatform(resolvedUrl);
      const baseArgs  = extractArgs(platform);
      const retries   = platform === "twitter" ? 3 : platform === "tiktok" ? 2 : 1;

      // ── MP3 mode ────────────────────────────────────────────────────────
      if (mode === "mp3") {
        await withRetry(() => runYtDlp([
          resolvedUrl,
          "--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K",
          "--output", tmpBase + ".%(ext)s",
          ...baseArgs,
        ], 120_000), retries);

        let mp3Path = tmpBase + ".mp3";
        if (!fs.existsSync(mp3Path)) {
          const cands = fs.readdirSync(TMP_DIR)
            .filter((f) => f.startsWith(path.basename(tmpBase)) && f.endsWith(".mp3"))
            .map((f) => path.join(TMP_DIR, f));
          if (!cands.length) throw new Error("فشل إنشاء ملف MP3");
          mp3Path = cands[0];
        }

        const { size } = fs.statSync(mp3Path);
        res.setHeader("Content-Type",        "audio/mpeg");
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}.mp3`);
        res.setHeader("Content-Length",      size);
        res.setHeader("Cache-Control",       "no-store");

        const stream = fs.createReadStream(mp3Path);
        stream.pipe(res);
        const del = () => { try { fs.unlinkSync(mp3Path); } catch {} };
        stream.on("end", del);
        stream.on("error", () => { del(); if (!res.headersSent) res.status(500).end(); });
        return;
      }

      // ── MP4 mode — yt-dlp + ffmpeg merge ────────────────────────────────
      const h = parseInt(height || "720");
      await withRetry(() => runYtDlp([
        resolvedUrl,
        "--format", downloadFormatSel(platform, h),
        "--output", tmpBase + ".%(ext)s",
        "--merge-output-format", "mp4",
        ...baseArgs,
      ], 180_000), retries);

      let outFile = tmpBase + ".mp4";
      if (!fs.existsSync(outFile)) {
        const dir    = path.dirname(tmpBase);
        const prefix = path.basename(tmpBase);
        const cands  = fs.readdirSync(dir)
          .filter((f) => f.startsWith(prefix) && !f.endsWith(".part"))
          .map((f) => path.join(dir, f));
        if (!cands.length) throw new Error("فشل إنشاء ملف الفيديو");
        outFile = cands[0];
      }

      const { size } = fs.statSync(outFile);
      const ext  = path.extname(outFile).slice(1) || "mp4";
      const mime = ext === "mp4" ? "video/mp4" : "video/webm";

      res.setHeader("Content-Type",        mime);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}.${ext}`);
      res.setHeader("Content-Length",      size);
      res.setHeader("Cache-Control",       "no-store");

      const stream = fs.createReadStream(outFile);
      stream.pipe(res);
      const del = () => { try { fs.unlinkSync(outFile); } catch {} };
      stream.on("end", del);
      stream.on("error", () => { del(); if (!res.headersSent) res.status(500).end(); });

    } catch (e) {
      cleanupFiles(tmpBase);
      const platform = detectPlatform(originalUrl);
      const msg = platform === "twitter"
        ? TWITTER_ARABIC[classifyTwitterError(String((e as Error)?.message || ""))]
        : fmtError(e);
      if (!res.headersSent) res.status(500).json({ error: msg });
    }
  };

  try {
    await enqueueDownload(runDownload);
  } catch {
    if (!res.headersSent) res.status(500).json({ error: "خطأ في خادم التحميل" });
  }
});

export default router;
