import express from "express";
import { load } from "cheerio";
import fs from "fs";
import "dotenv/config";

const app = express();

// -------------------------
// Middleware
// -------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.send("KTV proxy alive");
});

// -------------------------
// Constants / env
// -------------------------
const NANURI_ORIGIN = "https://nanuri.ktv.go.kr";
const SEARCH_URL = `${NANURI_ORIGIN}/search/searchResultMain.do`;

// ====== .env ======
const NANURI_ID = process.env.NANURI_ID || "";
const NANURI_PW = process.env.NANURI_PW || "";

const LOGIN_URL = process.env.LOGIN_URL || "https://nanuri.ktv.go.kr/member/doLogin.do";
const LOGIN_ID_FIELD = process.env.LOGIN_ID_FIELD || "userId";
const LOGIN_PW_FIELD = process.env.LOGIN_PW_FIELD || "password";

// ====== session cookie (server holds it) ======
let cookieHeader = "";

// -------------------------
// Helpers
// -------------------------
function mergeSetCookie(existing, setCookieArray) {
  const jar = new Map();

  const put = (cookieStr) => {
    if (!cookieStr) return;
    const pair = cookieStr.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  };

  if (existing) {
    existing
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((kv) => {
        const eq = kv.indexOf("=");
        if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
      });
  }

  (setCookieArray || []).forEach((sc) => put(sc));

  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function absNanuriUrl(maybeRelative) {
  if (!maybeRelative) return null;
  if (maybeRelative.startsWith("http://") || maybeRelative.startsWith("https://")) return maybeRelative;
  if (maybeRelative.startsWith("/")) return `${NANURI_ORIGIN}${maybeRelative}`;
  return `${NANURI_ORIGIN}/${maybeRelative}`;
}

// Generic fetch helper that keeps cookieHeader updated.
async function fetchText(url, options = {}) {
  const res = await fetch(url, {
    redirect: options.redirect ?? "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(options.headers || {})
    },
    method: options.method || "GET",
    body: options.body
  });

  // capture cookies (Node 20+ has getSetCookie, keep fallback)
  try {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies && setCookies.length) cookieHeader = mergeSetCookie(cookieHeader, setCookies);
    else {
      const sc = res.headers.get("set-cookie");
      if (sc) cookieHeader = mergeSetCookie(cookieHeader, [sc]);
    }
  } catch (_) {}

  return { res, text: await res.text() };
}

// -------------------------
// LOGIN (fixed account via .env)
// -------------------------
async function loginNanuri() {
  if (!LOGIN_URL || !NANURI_ID || !NANURI_PW) {
    console.log("[LOGIN] missing env. Check .env");
    return false;
  }

  cookieHeader = ""; // reset

  // 1) GET login page (seed session cookie)
  await fetchText(`${NANURI_ORIGIN}/member/login.do`, { method: "GET" });

  // 2) POST doLogin with redirect: manual (IMPORTANT)
  const body = new URLSearchParams({
    [LOGIN_ID_FIELD]: NANURI_ID,
    [LOGIN_PW_FIELD]: NANURI_PW
  });

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": NANURI_ORIGIN,
      "Referer": `${NANURI_ORIGIN}/member/login.do`,
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    },
    body
  });

  // capture cookies from this response (302/200)
  try {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies && setCookies.length) cookieHeader = mergeSetCookie(cookieHeader, setCookies);
    else {
      const sc = res.headers.get("set-cookie");
      if (sc) cookieHeader = mergeSetCookie(cookieHeader, [sc]);
    }
  } catch (_) {}

  console.log("[LOGIN] status:", res.status);
  console.log("[LOGIN] cookie set?:", cookieHeader ? "YES" : "NO");

  // follow location once (optional but helps session finalize)
  const loc = res.headers.get("location");
  if (loc) {
    const nextUrl = loc.startsWith("http") ? loc : `${NANURI_ORIGIN}${loc}`;
    await fetchText(nextUrl, { method: "GET" });
  }

  return !!cookieHeader;
}

// -------------------------
// AUTH STATUS
// -------------------------
app.get("/api/auth-status", (req, res) => {
  res.json({
    loggedIn: !!cookieHeader,
    hasEnv: {
      NANURI_ID: !!NANURI_ID,
      NANURI_PW: !!NANURI_PW,
      LOGIN_URL: !!LOGIN_URL
    }
  });
});

// -------------------------
// SEARCH (multi-page) + optional debug
// -------------------------
app.post("/api/search", async (req, res) => {
  try {
    const keyword = (req.body.keyword || "").trim();
    if (!keyword) return res.status(400).json({ error: "keyword required" });

    if (!cookieHeader) await loginNanuri();
    if (!cookieHeader) return res.status(401).json({ error: "login failed (check .env)" });

    const maxPages = Number(req.body.maxPages || 5);
    const pageSize = Number(req.body.pageSize || 30);

    const collected = [];
    const seen = new Set();

    // debug snapshot (page 1 only)
    const debugOn = req.body?.debug === true || req.query?.debug === "1";
    let debugPage1 = null;

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const body = new URLSearchParams({
        cntntsTy: "original",
        baseKeyword: keyword,
        category: "ALL",
        clorYn: "N",
        koglTyYn: "N",
        mediaTyYn: "N",
        dwldPosblAtYn: "N",
        pageIndex: String(pageIndex),
        pageUnit: String(pageSize),
        pageSize: String(pageSize)
      });

      // POST can redirect - handle 302 manually, then GET
      const r1 = await fetch(SEARCH_URL, {
        method: "POST",
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Content-Type": "application/x-www-form-urlencoded",
          "Origin": NANURI_ORIGIN,
          "Referer": SEARCH_URL,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(cookieHeader ? { Cookie: cookieHeader } : {})
        },
        body
      });

      // capture cookies
      try {
        const setCookies = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
        if (setCookies && setCookies.length) cookieHeader = mergeSetCookie(cookieHeader, setCookies);
        else {
          const sc = r1.headers.get("set-cookie");
          if (sc) cookieHeader = mergeSetCookie(cookieHeader, [sc]);
        }
      } catch (_) {}

      let html = "";
      const loc1 = r1.headers.get("location");

      if (r1.status >= 300 && r1.status < 400 && loc1) {
        const nextUrl = loc1.startsWith("http") ? loc1 : `${NANURI_ORIGIN}${loc1}`;
        const r2 = await fetchText(nextUrl, {
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            Referer: SEARCH_URL,
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
          }
        });
        html = r2.text;
      } else {
        html = await r1.text();
      }

      if (pageIndex === 1) {
        try {
          fs.writeFileSync("debug_search.html", html, "utf-8");
          console.log("saved debug_search.html");
          console.log("SEARCH html length:", html.length);
          console.log("SEARCH contains fn_detail:", html.includes("fn_detail("));
        } catch (_) {}
      }

      const $ = load(html);

      // ---- DEBUG (page 1 snapshot) ----
      if (debugOn && pageIndex === 1) {
        const htmlLen = html?.length || 0;
        const hasFnDetail = html.includes("fn_detail(");
        const looksLikeLoginPage = /login|로그인|member\/login\.do|doLogin/i.test(html);
        const foundFnDetail = $("a[onclick*='fn_detail']").length;
        const head = (html || "").slice(0, 1200);

        debugPage1 = {
          received: { keyword, debug: req.body?.debug, qdebug: req.query?.debug },
          pageSize,
          maxPages,
          page1: { htmlLen, hasFnDetail, foundFnDetail, looksLikeLoginPage, head }
        };
      }
      // ---------------------------------

      $("[onclick*='fn_detail']").each((_, a) => {
        const $a = $(a);
        const title = $a.text().trim().replace(/\s+/g, " ");
        const onclick = ($a.attr("onclick") || "").trim();
        const m = onclick.match(/fn_detail\(\s*'([^']+)'/i);
        const detailUrl = m ? m[1] : null;

        if (!title || !detailUrl) return;
        if (seen.has(detailUrl)) return;
        seen.add(detailUrl);

        // ✅ Thumbnail extraction (search list page)
        let thumbnail = null;

        const $card = $a.closest(
          "li, .item, .list, .result, .cont, .tit_area, .thumb_area, .img_area, .video_list, .vod_list"
        );

        const $img = $card.find("img").first();
        if ($img && $img.length) {
          thumbnail =
            $img.attr("data-src") ||
            $img.attr("data-original") ||
            $img.attr("data-lazy") ||
            $img.attr("src") ||
            null;
        }

        if (!thumbnail) {
          const style = ($card.find("[style*='background']").first().attr("style") || "");
          const bgm = style.match(/url\((['"]?)(.*?)\1\)/i);
          if (bgm && bgm[2]) thumbnail = bgm[2];
        }

        if (!thumbnail) {
          const any = $card.html() || "";
          const mNps = any.match(/https?:\/\/nps\.ktv\.go\.kr\/[^"'\\s]+\/Catalog\/\d+\.jpg/i);
          if (mNps) thumbnail = mNps[0];
        }

        if (thumbnail && thumbnail.startsWith("/")) thumbnail = `${NANURI_ORIGIN}${thumbnail}`;

        collected.push({ title, detailUrl, thumbnail });
      });

      if (collected.length >= 100) break;
    }

    const payload = { items: collected.slice(0, 100) };
    if (debugOn && debugPage1) payload.debug = debugPage1;

    return res.json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error", detail: String(e) });
  }
});

// -------------------------
// DETAIL -> M3U8 + thumbnail
// -------------------------
app.post("/api/play-url", async (req, res) => {
  try {
    const detailUrlRaw = (req.body.detailUrl || "").trim();
    if (!detailUrlRaw) return res.status(400).json({ error: "detailUrl required" });

    if (!cookieHeader) await loginNanuri();
    if (!cookieHeader) return res.status(401).json({ error: "login failed (check .env)" });

    // 오타 섞임 보정: "수정"하지 말고 둘 다 시도
    const candidates = [];
    const raw = detailUrlRaw;

    candidates.push(raw);
    if (raw.includes("selectOriganlShotDetail")) {
      candidates.push(raw.replace("selectOriganlShotDetail", "selectOrignalShotDetail"));
    }
    if (raw.includes("selectOrignalShotDetail")) {
      candidates.push(raw.replace("selectOrignalShotDetail", "selectOriganlShotDetail"));
    }

    let html = "";
    let finalUrl = "";
    let upstreamStatus = 0;

    for (const c of candidates) {
      const u = absNanuriUrl(c);
      const r = await fetchText(u, {
        method: "GET",
        headers: { Referer: `${NANURI_ORIGIN}/` }
      });

      upstreamStatus = r.res.status;
      if (r.res.ok) {
        html = r.text;
        finalUrl = u;
        break;
      }
    }

    if (!html) {
      return res.status(502).json({
        error: "nanuri detail fetch failed",
        status: upstreamStatus,
        tried: candidates.map(absNanuriUrl)
      });
    }

    try {
      fs.writeFileSync("debug_detail.html", html, "utf-8");
      console.log("saved debug_detail.html");
    } catch (_) {}

    // 썸네일(postImageUrl) 자동 추출
    let thumbnail = null;
    const thumb1 = html.match(/postImageUrl\s*:\s*['"]([^'"]+)['"]/i);
    if (thumb1 && thumb1[1]) thumbnail = thumb1[1];

    if (!thumbnail) {
      const thumb2 = html.match(/https?:\/\/nps\.ktv\.go\.kr\/[^"'\\s]+\/Catalog\/\d+\.jpg/i);
      if (thumb2) thumbnail = thumb2[0];
    }

    // m3u8 추출
    let m3u8Match = html.match(/https?:\/\/play\.g\.ktv\.go\.kr:4433\/[^"'\\s]+\.m3u8/g);
    let m3u8 = m3u8Match ? m3u8Match[0] : null;

    // gmediaVideoPlugin vodUrl_m 추출
    if (!m3u8) {
      const mVod = html.match(/vodUrl_m\s*:\s*encodeURI\(\s*"([^"]+)"\s*\)/i);
      if (mVod && mVod[1]) m3u8 = mVod[1];
    }
    if (!m3u8) {
      const mVod2 = html.match(/vodUrl_m\s*:\s*"([^"]+)"\s*/i);
      if (mVod2 && mVod2[1]) m3u8 = mVod2[1];
    }

    // mp4 -> playlist.m3u8
    if (!m3u8) {
      const mp4Match = html.match(/https?:\/\/play\.g\.ktv\.go\.kr:4433\/[^"'\\s]+\.mp4[^"'\\s]*/g);
      const mp4Url = mp4Match ? mp4Match[0] : null;

      if (mp4Url) {
        if (mp4Url.includes("playlist.m3u8")) {
          m3u8 = mp4Url;
        } else {
          m3u8 = mp4Url.endsWith("/") ? `${mp4Url}playlist.m3u8` : `${mp4Url}/playlist.m3u8`;
        }
      }
    }

    // 상대경로 /vod-proxy
    if (!m3u8) {
      const proxy = html.match(/\/vod-proxy\/[^"'\\s]+playlist\.m3u8/g);
      if (proxy && proxy[0]) {
        m3u8 = `https://play.g.ktv.go.kr:4433${proxy[0]}`;
      }
    }

    const meta = { detailPage: finalUrl, extractedAt: new Date().toISOString() };

    if (!m3u8) {
      return res.status(404).json({
        error: "m3u8 not found on detail page",
        meta
      });
    }

    return res.json({ m3u8, thumbnail, meta });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error", detail: String(e) });
  }
});

// -------------------------
// Start
// -------------------------
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log("KTV proxy listening on", PORT);
});
