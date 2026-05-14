import { Router, type IRouter, type Request, type Response } from "express";
import { execSync, execFile } from "child_process";
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
  // also handle merged files
  try {
    const dir = path.dirname(base);
    const prefix = path.basename(base);
    fs.readdirSync(dir).filter(f => f.startsWith(prefix)).forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    });
  } catch {}
}

function fmtError(e: unknown): string {
  const msg = (e as Error)?.message || "";
  if (msg.includes("timeout"))             return "انتهت مهلة الطلب، حاول مجدداً";
  if (msg.includes("cookies"))             return "المحتوى خاص أو يتطلب تسجيل دخول";
  if (msg.includes("Private"))             return "هذا الفيديو خاص ولا يمكن تحميله";
  if (msg.includes("not available in your country")) return "الفيديو غير متاح في منطقتك";
  if (msg.includes("unavailable"))         return "الفيديو غير متاح";
  if (msg.includes("removed"))             return "تم حذف هذا الفيديو";
  if (msg.includes("HTTP Error 403"))      return "انتهت صلاحية رابط التحميل، أعد الجلب";
  if (msg.includes("HTTP Error 404"))      return "الفيديو غير موجود";
  if (msg.includes("Sign in"))             return "هذا الفيديو يتطلب تسجيل دخول";
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
    status: "ok", version: "4.1.0",
    uptime: Math.floor(process.uptime()), ytDlpVersion,
    queue: { size: activeDownloads, pending: downloadQueue.length, max: MAX_CONCURRENT },
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
    const args = [
      url,
      "--dump-single-json",
      "--no-playlist",
      "--extractor-args", "youtube:player_client=android,ios",
      "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "--no-warnings",
      "--no-check-certificates",
      "--socket-timeout", "20",
    ];

    const stdout = await runYtDlp(args, 30_000);
    const info = JSON.parse(stdout) as Record<string, unknown>;
    if (!info) return void res.json({ success: false, error: "لم يتم الحصول على معلومات الفيديو" });

    const isPlaylist = info["_type"] === "playlist" || info["_type"] === "multi_video";

    // Collect unique heights from ALL video streams (video-only + combined)
    const seenH = new Set<number>();
    const formats = ((info["formats"] as Array<Record<string, unknown>>) || [])
      .filter((f) => {
        const h = f["height"] as number;
        const vcodec = (f["vcodec"] as string) || "";
        // Keep: has height, has video (vcodec not 'none'), not storyboard
        return h && h > 0 && vcodec !== "none" && f["ext"] !== "mhtml";
      })
      .map((f) => ({
        quality:     (f["height"] as number) + "p",
        height:      f["height"] as number,
        ext:         (f["ext"] as string) || "mp4",
        filesize:    (f["filesize"] as number) || (f["filesize_approx"] as number) || null,
        hasAudio:    (f["acodec"] as string) !== "none",
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
      title:        (info["title"]       as string) || "فيديو بدون عنوان",
      thumbnail:    (info["thumbnail"]   as string) || "",
      duration:     (info["duration"]    as number) || 0,
      uploader:     (info["uploader"]    as string) || (info["channel"] as string) || "",
      viewCount:    (info["view_count"]  as number) || 0,
      likeCount:    (info["like_count"]  as number) || 0,
      uploadDate:   (info["upload_date"] as string) || "",
      isPlaylist,
      playlistNote: isPlaylist ? "ملاحظة: تم استخراج الفيديو الأول فقط من القائمة" : null,
      formats,
      originalUrl:  url,
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
      // ── MP3 mode ──────────────────────────────────────────────────────────
      if (mode === "mp3") {
        await runYtDlp([
          originalUrl,
          "--extract-audio",
          "--audio-format", "mp3",
          "--audio-quality", "192K",
          "--output", tmpBase + ".%(ext)s",
          "--extractor-args", "youtube:player_client=android,ios",
          "--user-agent", "Mozilla/5.0",
          "--no-playlist",
          "--no-check-certificates",
          "--no-warnings",
        ], 120_000);

        const mp3Path = tmpBase + ".mp3";
        if (!fs.existsSync(mp3Path)) throw new Error("فشل إنشاء ملف MP3");

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

      // ── MP4 mode — yt-dlp with ffmpeg merge ───────────────────────────────
      const h = parseInt(height || "720");
      const formatSel = [
        `bestvideo[height=${h}][ext=mp4]+bestaudio[ext=m4a]`,
        `bestvideo[height=${h}]+bestaudio`,
        `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${h}]+bestaudio`,
        `best[height<=${h}]`,
        "best",
      ].join("/");

      const outputTemplate = tmpBase + ".%(ext)s";

      await runYtDlp([
        originalUrl,
        "--format", formatSel,
        "--output", outputTemplate,
        "--merge-output-format", "mp4",
        "--extractor-args", "youtube:player_client=android,ios",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "--no-playlist",
        "--no-check-certificates",
        "--no-warnings",
      ], 180_000);

      // Find the output file (yt-dlp may name it .mp4 or .mkv etc.)
      let outFile = tmpBase + ".mp4";
      if (!fs.existsSync(outFile)) {
        const dir = path.dirname(tmpBase);
        const prefix = path.basename(tmpBase);
        const candidates = fs.readdirSync(dir)
          .filter(f => f.startsWith(prefix))
          .map(f => path.join(dir, f));
        if (!candidates.length) throw new Error("فشل إنشاء ملف الفيديو");
        outFile = candidates[0];
      }

      const { size } = fs.statSync(outFile);
      const ext = path.extname(outFile).slice(1) || "mp4";
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
      const msg = (e as Error)?.message?.includes("timeout")
        ? "انتهت مهلة التحميل، حاول مجدداً"
        : fmtError(e);
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
