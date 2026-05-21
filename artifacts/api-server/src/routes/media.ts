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

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 2000): Promise<T> {
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

// ─── Short-URL resolver (follows HTTP redirects) ──────────────────────────────
const TIKTOK_SHORT_HOSTS = new Set(["vt.tiktok.com", "vm.tiktok.com"]);

function followRedirect(inputUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const parsed = (() => { try { return new URL(inputUrl); } catch { return null; } })();
    if (!parsed) { resolve(inputUrl); return; }

    // Use GET — TikTok blocks HEAD requests and won't return Location header
    const lib = parsed.protocol === "https:" ? https : http;
    const options = {
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
    };

    const req = lib.request(options, (res) => {
      const loc = res.headers["location"];
      // Immediately destroy — we only need the Location header, not the body
      req.destroy();
      if (loc) {
        try { resolve(new URL(loc, inputUrl).toString()); }
        catch { resolve(loc); }
      } else {
        resolve(inputUrl);
      }
    });

    req.on("timeout", () => { req.destroy(); resolve(inputUrl); });
    req.on("error",   ()  => resolve(inputUrl));
    req.end();
  });
}

async function resolveShortUrl(url: string, maxHops = 6): Promise<string> {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const host = (() => { try { return new URL(current).hostname.toLowerCase(); } catch { return ""; } })();
    // Only follow redirects if it's a known short-link domain
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
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtube.com" || host === "youtu.be") return "youtube";
    if (host.includes("tiktok.com"))                   return "tiktok";
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
    if (host === "x.com" || host === "twitter.com")   return "twitter";
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
        // android_vr provides adaptive DASH streams up to 4K without bot detection
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
        "--socket-timeout", "25",
      ];
    default:
      return [...base, "--user-agent", UA_DESKTOP, "--socket-timeout", "20"];
  }
}

// For download, TikTok watermark-free format selector
function downloadFormatSel(platform: Platform, height: number): string {
  if (platform === "tiktok") {
    // TikTok 'download' format is the no-watermark version
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
    const host = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
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
  if (msg.includes("timeout"))                            return "انتهت مهلة الطلب، حاول مجدداً";
  if (msg.includes("cookies"))                            return "المحتوى خاص أو يتطلب تسجيل دخول";
  if (/private/i.test(msg))                               return "هذا الفيديو خاص ولا يمكن تحميله";
  if (msg.includes("not available in your country"))      return "الفيديو غير متاح في منطقتك";
  if (msg.includes("Unable to extract webpage video"))    return "تيك توك يحجب الطلب مؤقتاً، أعد المحاولة لاحقاً";
  if (/unavailable|not available/i.test(msg))             return "الفيديو غير متاح";
  if (/removed|deleted/i.test(msg))                       return "تم حذف هذا الفيديو";
  if (msg.includes("HTTP Error 403"))                     return "الوصول مرفوض، أعد الجلب";
  if (msg.includes("HTTP Error 404"))                     return "الفيديو غير موجود";
  if (/sign.?in|login/i.test(msg))                        return "هذا الفيديو يتطلب تسجيل دخول";
  if (/geo.?restrict|region/i.test(msg))                  return "الفيديو مقيّد جغرافياً";
  if (msg.includes("Unable to extract"))                  return "تعذّر استخراج الفيديو، حاول مجدداً بعد قليل";
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
    status: "ok", version: "5.0.0",
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
  const { url } = (req.body as { url?: string }) || {};

  if (!url || typeof url !== "string")
    return void res.json({ success: false, error: "الرجاء إدخال رابط صالح" });
  if (url.length > 2048)
    return void res.json({ success: false, error: "الرابط طويل جداً" });
  if (!isAllowedSourceUrl(url))
    return void res.json({ success: false, error: "الرابط غير مدعوم — يُدعم: يوتيوب، تيك توك، إنستغرام، تويتر" });

  try {
    // Resolve TikTok short URLs before passing to yt-dlp
    const resolvedUrl = await resolveShortUrl(url);
    if (resolvedUrl !== url)
      logger.info({ original: url, resolved: resolvedUrl }, "Short URL resolved");

    const platform = detectPlatform(resolvedUrl);
    const args = [resolvedUrl, "--dump-single-json", ...extractArgs(platform)];

    // Retry up to 2 times on failure (TikTok can be intermittent)
    const retries = platform === "tiktok" ? 2 : 1;
    const stdout = await withRetry(() => runYtDlp(args, platform === "tiktok" ? 45_000 : 30_000), retries);

    const info = JSON.parse(stdout) as Record<string, unknown>;
    if (!info) return void res.json({ success: false, error: "لم يتم الحصول على معلومات الفيديو" });

    const isPlaylist = info["_type"] === "playlist" || info["_type"] === "multi_video";

    // Collect unique heights from ALL video streams (video-only + combined)
    const seenH = new Set<number>();
    const rawFormats = ((info["formats"] as Array<Record<string, unknown>>) || []);

    // For TikTok, also check for format_id "download" (no-watermark)
    const hasTikTokDownload = platform === "tiktok" && rawFormats.some((f) => f["format_id"] === "download");

    const formats = rawFormats
      .filter((f) => {
        const h = f["height"] as number;
        const vcodec = (f["vcodec"] as string) || "";
        return h && h > 0 && vcodec !== "none" && f["ext"] !== "mhtml";
      })
      .map((f) => ({
        quality:           (f["height"] as number) + "p",
        height:            f["height"] as number,
        ext:               (f["ext"] as string) || "mp4",
        filesize:          (f["filesize"] as number) || (f["filesize_approx"] as number) || null,
        hasAudio:          (f["acodec"] as string) !== "none",
        noWatermark:       platform === "tiktok" && hasTikTokDownload,
      }))
      .filter((f) => {
        if (seenH.has(f.height)) return false;
        seenH.add(f.height);
        return true;
      })
      .sort((a, b) => b.height - a.height)
      .slice(0, 8);

    if (!formats.length)
      return void res.json({ success: false, error: "لا توجد صيغ فيديو متاحة لهذا الرابط" });

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
      originalUrl:  resolvedUrl,  // Return resolved URL for use in download
      noWatermark:  hasTikTokDownload,
    });

  } catch (e) {
    logger.error({ err: e }, "Extract error");
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
      // Resolve short URL (in case download is called with original short URL)
      const resolvedUrl = await resolveShortUrl(originalUrl);
      const platform    = detectPlatform(resolvedUrl);
      const baseArgs    = extractArgs(platform);

      // ── MP3 mode ──────────────────────────────────────────────────────────
      if (mode === "mp3") {
        await withRetry(() => runYtDlp([
          resolvedUrl,
          "--extract-audio",
          "--audio-format", "mp3",
          "--audio-quality", "192K",
          "--output", tmpBase + ".%(ext)s",
          ...baseArgs,
        ], platform === "tiktok" ? 120_000 : 120_000), platform === "tiktok" ? 2 : 1);

        // yt-dlp may output .mp3 directly or convert
        let mp3Path = tmpBase + ".mp3";
        if (!fs.existsSync(mp3Path)) {
          const candidates = fs.readdirSync(TMP_DIR)
            .filter((f) => f.startsWith(path.basename(tmpBase)) && f.endsWith(".mp3"))
            .map((f) => path.join(TMP_DIR, f));
          if (!candidates.length) throw new Error("فشل إنشاء ملف MP3");
          mp3Path = candidates[0];
        }

        const { size } = fs.statSync(mp3Path);
        res.setHeader("Content-Type",        "audio/mpeg");
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}.mp3`);
        res.setHeader("Content-Length",      size);
        res.setHeader("Cache-Control",       "no-store");

        const stream = fs.createReadStream(mp3Path);
        stream.pipe(res);
        const cleanup = () => { try { fs.unlinkSync(mp3Path); } catch {} };
        stream.on("end",   cleanup);
        stream.on("error", () => { cleanup(); if (!res.headersSent) res.status(500).end(); });
        return;
      }

      // ── MP4 mode — yt-dlp + ffmpeg merge ─────────────────────────────────
      const h = parseInt(height || "720");
      const formatSel = downloadFormatSel(platform, h);

      await withRetry(() => runYtDlp([
        resolvedUrl,
        "--format", formatSel,
        "--output", tmpBase + ".%(ext)s",
        "--merge-output-format", "mp4",
        ...baseArgs,
      ], platform === "tiktok" ? 180_000 : 180_000), platform === "tiktok" ? 2 : 1);

      // Find the output file (yt-dlp may use .mp4 or .mkv depending on codecs)
      let outFile = tmpBase + ".mp4";
      if (!fs.existsSync(outFile)) {
        const dir    = path.dirname(tmpBase);
        const prefix = path.basename(tmpBase);
        const candidates = fs.readdirSync(dir)
          .filter((f) => f.startsWith(prefix) && !f.endsWith(".part"))
          .map((f) => path.join(dir, f));
        if (!candidates.length) throw new Error("فشل إنشاء ملف الفيديو");
        outFile = candidates[0];
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
      const cleanup = () => { try { fs.unlinkSync(outFile); } catch {} };
      stream.on("end",   cleanup);
      stream.on("error", () => { cleanup(); if (!res.headersSent) res.status(500).end(); });

    } catch (e) {
      cleanupFiles(tmpBase);
      const msg = fmtError(e);
      if (!res.headersSent) res.status(500).json({ error: msg });
    }
  };

  try {
    await enqueueDownload(runDownload);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: "خطأ في خادم التحميل" });
  }
});

export default router;
