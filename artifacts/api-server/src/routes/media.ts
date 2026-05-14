import { Router, type IRouter, type Request, type Response } from "express";
import { execSync, execFile } from "child_process";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { logger } from "../lib/logger";

// ─── Locate system yt-dlp binary ─────────────────────────────────────────────
function findYtDlp(): string {
  const candidates = [
    "/usr/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
  ];
  // Try `which` first
  try {
    const found = execSync("which yt-dlp", { timeout: 3000 }).toString().trim();
    if (found) return found;
  } catch {}
  // Try nix store glob
  try {
    const nixPath = execSync("ls /nix/store/*/bin/yt-dlp 2>/dev/null | head -1", { timeout: 3000 })
      .toString()
      .trim();
    if (nixPath) return nixPath;
  } catch {}
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("yt-dlp not found. Install it via system packages.");
}

const YTDLP_BIN = findYtDlp();
logger.info({ bin: YTDLP_BIN }, "yt-dlp binary located");

// ─── Helper: run yt-dlp with args, return stdout ─────────────────────────────
function runYtDlp(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);

    execFile(YTDLP_BIN, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) {
        const msg = stderr || err.message;
        reject(new Error(msg));
        return;
      }
      resolve(stdout);
    });
  });
}

// ─── Allowed Domains ─────────────────────────────────────────────────────────
const ALLOWED_SOURCE_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "instagram.com",
  "x.com",
  "twitter.com",
];

const CDN_PATTERNS = [
  /\.googlevideo\.com$/,
  /twimg\.com$/,
  /\.tiktokcdn\.com$/,
  /\.tiktokcdn-us\.com$/,
  /\.fbcdn\.net$/,
  /\.cdninstagram\.com$/,
  /\.akamaized\.net$/,
  /tapecontent\.net$/,
  /\.ssncdn\.com$/,
  /^localhost$/,
  /^127\.0\.0\.1$/,
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isAllowedSourceUrl(u: string): boolean {
  try {
    const host = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    return ALLOWED_SOURCE_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

function isCdnUrl(u: string): boolean {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return CDN_PATTERNS.some((p) => p.test(host));
  } catch {
    return false;
  }
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
  ["mp3", "webm", "m4a", "opus", "mp4", "part"].forEach((ext) => {
    const p = base + "." + ext;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  });
}

function fmtError(e: unknown): string {
  const msg = (e as Error)?.message || "";
  if (msg.includes("timeout"))          return "انتهت مهلة الطلب، حاول مجدداً";
  if (msg.includes("cookies"))          return "المحتوى خاص أو يتطلب تسجيل دخول";
  if (msg.includes("Private"))          return "هذا الفيديو خاص ولا يمكن تحميله";
  if (msg.includes("not available"))    return "الفيديو غير متاح في منطقتك";
  if (msg.includes("removed"))          return "تم حذف هذا الفيديو";
  if (msg.includes("HTTP Error 403"))   return "انتهت صلاحية رابط التحميل، أعد الجلب";
  if (msg.includes("HTTP Error 404"))   return "الفيديو غير موجود";
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
      try {
        if (now - fs.statSync(fp).mtimeMs > TMP_MAX_AGE) fs.unlinkSync(fp);
      } catch {}
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
      try {
        await fn();
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        activeDownloads--;
        if (downloadQueue.length > 0) {
          const next = downloadQueue.shift()!;
          next();
        }
      }
    };
    if (activeDownloads < MAX_CONCURRENT) {
      run();
    } else {
      downloadQueue.push(run);
    }
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────
const router: IRouter = Router();

// ─── Health ───────────────────────────────────────────────────────────────────
router.get("/health", (_req: Request, res: Response) => {
  let ytDlpVersion = "unknown";
  try {
    ytDlpVersion = execSync(`${YTDLP_BIN} --version`, { timeout: 3000 }).toString().trim();
  } catch {}

  let tmpCount = 0;
  try { tmpCount = fs.readdirSync(TMP_DIR).length; } catch {}

  res.json({
    status: "ok",
    version: "4.0.0",
    uptime: Math.floor(process.uptime()),
    ytDlpVersion,
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

  if (!url || typeof url !== "string") {
    return void res.json({ success: false, error: "الرجاء إدخال رابط صالح" });
  }
  if (url.length > 2048) {
    return void res.json({ success: false, error: "الرابط طويل جداً" });
  }
  if (!isAllowedSourceUrl(url)) {
    return void res.json({
      success: false,
      error: "الرابط غير مدعوم — يُدعم: يوتيوب، تيك توك، إنستغرام، تويتر",
    });
  }

  try {
    const args = [
      url,
      "--dump-single-json",
      "--no-playlist",
      "--extractor-args", "youtube:player_client=android,web",
      "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "--no-warnings",
      "--no-check-certificates",
      "--socket-timeout", "20",
    ];

    const stdout = await runYtDlp(args, 30_000);
    const info = JSON.parse(stdout) as Record<string, unknown>;

    if (!info) {
      return void res.json({ success: false, error: "لم يتم الحصول على معلومات الفيديو" });
    }

    const isPlaylist = info["_type"] === "playlist" || info["_type"] === "multi_video";

    const seen = new Set<number>();
    const formats = ((info["formats"] as Array<Record<string, unknown>>) || [])
      .filter((f) => f["url"] && f["height"] && (f["ext"] === "mp4" || f["vcodec"] !== "none"))
      .map((f) => ({
        quality:  f["height"] + "p",
        height:   f["height"] as number,
        url:      f["url"] as string,
        ext:      (f["ext"] as string) || "mp4",
        filesize: (f["filesize"] as number) || (f["filesize_approx"] as number) || null,
        vcodec:   (f["vcodec"] as string) || "",
        acodec:   (f["acodec"] as string) || "",
      }))
      .filter((f) => {
        if (seen.has(f.height)) return false;
        seen.add(f.height);
        return true;
      })
      .sort((a, b) => b.height - a.height)
      .slice(0, 6);

    if (!formats.length) {
      return void res.json({ success: false, error: "لا توجد صيغ فيديو متاحة لهذا الرابط" });
    }

    return void res.json({
      success:      true,
      title:        (info["title"] as string)       || "فيديو بدون عنوان",
      thumbnail:    (info["thumbnail"] as string)   || "",
      duration:     (info["duration"] as number)    || 0,
      uploader:     (info["uploader"] as string)    || (info["channel"] as string) || "",
      viewCount:    (info["view_count"] as number)  || 0,
      likeCount:    (info["like_count"] as number)  || 0,
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
  const { url, originalUrl, filename, mode } = req.query as Record<string, string>;

  if (!url || typeof url !== "string") {
    return void res.status(400).json({ error: "رابط مطلوب" });
  }
  if (!isCdnUrl(url)) {
    return void res.status(403).json({ error: "ممنوع: رابط CDN غير معتمد" });
  }

  const name    = safeName(filename);
  const tmpBase = path.join(TMP_DIR, `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  const runDownload = async (): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);

    try {
      // ── MP3 mode ─────────────────────────────────────────────────────────
      if (mode === "mp3") {
        const srcUrl = originalUrl && isAllowedSourceUrl(originalUrl) ? originalUrl : url;
        const mp3Path = tmpBase + ".mp3";

        await runYtDlp([
          srcUrl,
          "--extract-audio",
          "--audio-format", "mp3",
          "--audio-quality", "192K",
          "--output", tmpBase + ".%(ext)s",
          "--user-agent", "Mozilla/5.0",
          "--no-playlist",
          "--no-check-certificates",
          "--no-warnings",
        ], 120_000);

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

      // ── MP4 mode — direct CDN fetch ───────────────────────────────────────
      const { default: fetch } = await import("node-fetch");
      const fetchRes = await fetch(url, {
        method:  "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer:      "https://www.google.com/",
          Accept:       "video/mp4,video/*;q=0.9,*/*;q=0.8",
        },
        signal: controller.signal as Parameters<typeof fetch>[1] extends { signal?: infer S } ? S : never,
      });

      if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);

      res.setHeader("Content-Type",        "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}.mp4`);
      res.setHeader("Cache-Control",       "no-store");

      const cl = fetchRes.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);

      const nodeStream = Readable.fromWeb
        ? Readable.fromWeb(fetchRes.body as Parameters<typeof Readable.fromWeb>[0])
        : (fetchRes.body as unknown as NodeJS.ReadableStream);

      (nodeStream as NodeJS.ReadableStream).pipe(res);
      (nodeStream as NodeJS.EventEmitter).on("error", (err: Error) => {
        logger.error({ err }, "Stream error");
        if (!res.headersSent) res.status(500).end();
      });
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });

    } catch (e) {
      cleanupFiles(tmpBase);
      const msg = (e as Error)?.message?.includes("abort")
        ? "انتهت مهلة التحميل، حاول مجدداً"
        : fmtError(e);
      if (!res.headersSent) res.status(500).json({ error: msg });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    await enqueueDownload(runDownload);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: "خطأ في خادم التحميل" });
  }
});

export default router;
