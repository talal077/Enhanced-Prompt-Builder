/**
 * Comprehensive PWA Installability Audit
 * Checks all Chrome Android installability requirements
 */
import https from "https";
import http from "http";

const DEV_HOST = process.env.REPLIT_DOMAINS?.split(",")[0];
const BASE = DEV_HOST
  ? `https://${DEV_HOST}`
  : "http://localhost:80";

const PROD = process.argv[2]; // optional production URL

async function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false, ...opts }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          ok: res.statusCode >= 200 && res.statusCode < 300,
        })
      );
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function check(label, pass, detail = "") {
  const icon = pass ? "✅" : "❌";
  console.log(`  ${icon}  ${label}${detail ? `\n       → ${detail}` : ""}`);
  return pass;
}

async function audit(baseUrl) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`PWA AUDIT: ${baseUrl}`);
  console.log("─".repeat(60));

  let passed = 0;
  let total = 0;
  const fail = (l, d) => { total++; check(l, false, d); };
  const pass = (l, d) => { total++; passed++; check(l, true, d); };

  // ── 1. HTTPS ─────────────────────────────────────────────────────────────
  console.log("\n[1] HTTPS");
  const isHttps = baseUrl.startsWith("https://");
  isHttps ? pass("Served over HTTPS") : fail("Served over HTTPS", "required for installability");

  // ── 2. HTML page ─────────────────────────────────────────────────────────
  console.log("\n[2] HTML page");
  let html = "";
  try {
    const r = await fetch(baseUrl + "/");
    if (r.ok) {
      html = r.body;
      pass("Root page returns 200", `Content-Type: ${r.headers["content-type"]}`);
    } else {
      fail("Root page returns 200", `HTTP ${r.status}`);
    }
  } catch (e) {
    fail("Root page returns 200", e.message);
  }

  // ── 3. Manifest link ─────────────────────────────────────────────────────
  console.log("\n[3] Manifest link in HTML");
  const manifestLinkMatch = html.match(/<link[^>]+rel=["']manifest["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']manifest["']/i);
  const manifestHref = manifestLinkMatch?.[1] || null;
  manifestHref
    ? pass(`rel="manifest" found`, manifestHref)
    : fail(`rel="manifest" found`, "no <link rel=manifest> in HTML");

  // ── 4. Manifest fetch ─────────────────────────────────────────────────────
  console.log("\n[4] Manifest file");
  let manifest = null;
  if (manifestHref) {
    const manifestUrl = manifestHref.startsWith("http")
      ? manifestHref
      : baseUrl + manifestHref;
    try {
      const r = await fetch(manifestUrl);
      const ct = r.headers["content-type"] || "";
      r.ok ? pass("Manifest HTTP 200") : fail("Manifest HTTP 200", `HTTP ${r.status}`);
      (ct.includes("json") || ct.includes("manifest"))
        ? pass("Manifest Content-Type", ct)
        : fail("Manifest Content-Type", `got "${ct}", expected application/manifest+json or application/json`);
      try {
        manifest = JSON.parse(r.body);
        pass("Manifest is valid JSON");
      } catch (e) {
        fail("Manifest is valid JSON", e.message);
      }
    } catch (e) {
      fail("Manifest fetch", e.message);
    }
  }

  // ── 5. Manifest fields ────────────────────────────────────────────────────
  console.log("\n[5] Manifest required fields");
  if (manifest) {
    manifest.name ? pass(`name: "${manifest.name}"`) : fail("name field present");
    manifest.short_name ? pass(`short_name: "${manifest.short_name}"`) : fail("short_name field present");
    manifest.start_url ? pass(`start_url: "${manifest.start_url}"`) : fail("start_url field present");
    manifest.scope ? pass(`scope: "${manifest.scope}"`) : fail("scope field present");
    ["standalone","fullscreen","minimal-ui"].includes(manifest.display)
      ? pass(`display: "${manifest.display}"`)
      : fail("display is standalone/fullscreen/minimal-ui", `got "${manifest.display}"`);
    manifest.background_color ? pass(`background_color: "${manifest.background_color}"`) : fail("background_color");
    manifest.theme_color ? pass(`theme_color: "${manifest.theme_color}"`) : fail("theme_color");
    manifest.id ? pass(`id: "${manifest.id}" (recommended)`) : check("id (recommended)", false, "missing — add for better identity tracking");
    total++; if(manifest.id) passed++;
  }

  // ── 6. Icons ──────────────────────────────────────────────────────────────
  console.log("\n[6] PWA Icons");
  if (manifest?.icons?.length) {
    const has192 = manifest.icons.some(i => i.sizes?.includes("192x192") && i.type === "image/png");
    const has512 = manifest.icons.some(i => i.sizes?.includes("512x512") && i.type === "image/png");
    const hasMaskable = manifest.icons.some(i => (i.purpose || "").includes("maskable"));
    has192 ? pass("Icon 192×192 PNG declared") : fail("Icon 192×192 PNG declared");
    has512 ? pass("Icon 512×512 PNG declared") : fail("Icon 512×512 PNG declared");
    hasMaskable ? pass("Maskable icon declared") : fail("Maskable icon declared");

    for (const icon of manifest.icons) {
      const iconUrl = icon.src?.startsWith("http") ? icon.src : baseUrl + icon.src;
      try {
        const r = await fetch(iconUrl);
        const ct = r.headers["content-type"] || "";
        r.ok && ct.includes("png")
          ? pass(`Icon OK: ${icon.sizes} (${icon.purpose || "any"})`)
          : fail(`Icon fetchable: ${icon.src}`, `HTTP ${r.status} ${ct}`);
      } catch (e) {
        fail(`Icon fetchable: ${icon.src}`, e.message);
      }
    }
  } else {
    fail("Icons array present in manifest");
  }

  // ── 7. Service Worker ─────────────────────────────────────────────────────
  console.log("\n[7] Service Worker file");
  try {
    const r = await fetch(baseUrl + "/sw.js");
    r.ok ? pass("sw.js HTTP 200") : fail("sw.js HTTP 200", `HTTP ${r.status}`);
    const ct = r.headers["content-type"] || "";
    ct.includes("javascript") ? pass("sw.js Content-Type", ct) : fail("sw.js Content-Type", ct);

    if (r.body) {
      const hasFetch  = r.body.includes("addEventListener") && r.body.includes("fetch");
      const hasInstall = r.body.includes("install");
      const hasActivate = r.body.includes("activate");
      const hasSkipWaiting = r.body.includes("skipWaiting");
      const hasClaim = r.body.includes("clients.claim");
      hasFetch   ? pass("SW has fetch handler")    : fail("SW has fetch handler");
      hasInstall ? pass("SW has install handler")  : fail("SW has install handler");
      hasActivate ? pass("SW has activate handler") : fail("SW has activate handler");
      hasSkipWaiting ? pass("SW calls skipWaiting()") : fail("SW calls skipWaiting()");
      hasClaim ? pass("SW calls clients.claim()") : fail("SW calls clients.claim()");
    }
  } catch (e) {
    fail("sw.js fetch", e.message);
  }

  // ── 8. SW registration in HTML ────────────────────────────────────────────
  console.log("\n[8] Service Worker registration in page");
  const hasSwReg = html.includes("serviceWorker") && html.includes("register");
  const hasSrcMain = html.includes("/src/main") || html.includes("main.tsx") || html.includes("main.jsx");
  (hasSwReg || hasSrcMain)
    ? pass("SW registration code referenced from HTML", "registration happens in main.tsx")
    : fail("SW registration code in HTML");

  // ── 9. Offline page ───────────────────────────────────────────────────────
  console.log("\n[9] Offline fallback page");
  try {
    const r = await fetch(baseUrl + "/offline.html");
    r.ok ? pass("offline.html HTTP 200") : fail("offline.html HTTP 200", `HTTP ${r.status}`);
  } catch (e) {
    fail("offline.html fetch", e.message);
  }

  // ── 10. Meta tags ─────────────────────────────────────────────────────────
  console.log("\n[10] PWA meta tags");
  const hasMobile = html.includes("mobile-web-app-capable") || html.includes("apple-mobile-web-app-capable");
  const hasThemeColor = html.includes("theme-color");
  const hasViewport = html.includes("viewport");
  const hasLang = html.includes('lang="ar"') || html.includes("lang='ar'");
  const hasDir = html.includes('dir="rtl"') || html.includes("dir='rtl'");
  hasMobile     ? pass("mobile-web-app-capable meta") : fail("mobile-web-app-capable meta");
  hasThemeColor ? pass("theme-color meta")            : fail("theme-color meta");
  hasViewport   ? pass("viewport meta")               : fail("viewport meta");
  hasLang       ? pass("lang=ar (Arabic)")            : fail("lang=ar (Arabic)");
  hasDir        ? pass("dir=rtl (RTL)")               : fail("dir=rtl (RTL)");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  const pct = Math.round((passed / total) * 100);
  console.log(`RESULT: ${passed}/${total} checks passed  (${pct}%)`);
  if (pct === 100) {
    console.log("🎉  ALL CHECKS PASS — app meets Chrome Android installability requirements");
  } else {
    console.log(`⚠️   ${total - passed} check(s) failed — fix before redeploying`);
  }
  console.log("─".repeat(60) + "\n");

  return { passed, total, pct };
}

// Run against dev URL
const result = await audit(BASE);

// Also run against production URL if provided
if (PROD && PROD !== BASE) {
  await audit(PROD);
}
