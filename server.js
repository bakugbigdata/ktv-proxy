import express from "express";
import { load } from "cheerio";
import fs from "fs";
import "dotenv/config";

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

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

// --- helpers ---
function mergeSetCookie(existing, setCookieArray) {
  const jar = new Map();

  const put = (cookieStr) => {
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

  // capture cookies
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

// ====== LOGIN (A안: 고정 계정) ======
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

// ====== AUTH STATUS ======
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

// ====== SEARCH (multi-page) ======
app.post("/api/search", async (req, res) => {
  try {
    const keyword = (req.body.keyword || "").trim();
    if (!keyword) return res.status(400).json({ error: "keyword required" });

    if (!cookieHeader) await loginNanuri();

    const maxPages = 5;  // 늘리면 더 많이 가져옴
    const pageSize = 30;

    const collected = [];
    const seen = new Set();

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

      const r1 = await fetch(SEARCH_URL, {
        method: "POST",
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Content-Type": "application/x-www-form-urlencoded",
          "Origin": NANURI_ORIGIN,
          "Referer": `${NANURI_ORIGIN}/search/searchResultMain.do`,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(cookieHeader ? { Cookie: cookieHeader } : {})
        },
        body
      });

      let html = "";
      const loc1 = r1.headers.get("location");

      if (r1.status >= 300 && r1.status < 400 && loc1) {
        const nextUrl = loc1.startsWith("http") ? loc1 : `${NANURI_ORIGIN}${loc1}`;
        const r2 = await fetch(nextUrl, {
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
          }
        });
        html = await r2.text();
      } else {
        html = await r1.text();
      }

      if (pageIndex === 1) {
        fs.writeFileSync("debug_search.html", html, "utf-8");
        console.log("saved debug_search.html");
        console.log("SEARCH html length:", html.length);
        console.log("SEARCH contains fn_detail:", html.includes("fn_detail("));
      }

      const $ = load(html);

      $("a[onclick*='fn_detail']").each((_, a) => {
  const $a = $(a);
  const title = $a.text().trim().replace(/\s+/g, " ");
  const onclick = ($a.attr("onclick") || "").trim();
  const m = onclick.match(/fn_detail\(\s*'([^']+)'\s*\)/i);
  const detailUrl = m ? m[1] : null;

  if (!title || !detailUrl) return;
  if (seen.has(detailUrl)) return;
  seen.add(detailUrl);

  // ✅✅✅ 썸네일 추출 (검색결과 페이지에서)
  let thumbnail = null;

  // 1) 결과 아이템 컨테이너(최대한 넓게) 잡기
  const $card = $a.closest("li, .item, .list, .result, .cont, .tit_area, .thumb_area, .img_area, .video_list, .vod_list");

  // 2) img 태그에서 src/data-src/data-original 등 우선 추출
  const $img = $card.find("img").first();
  if ($img && $img.length) {
    thumbnail =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      $img.attr("data-lazy") ||
      $img.attr("src") ||
      null;
  }

  // 3) 배경이미지(background-image: url(...)) fallback
  if (!thumbnail) {
    const style = ($card.find("[style*='background']").first().attr("style") || "");
    const bgm = style.match(/url\((['"]?)(.*?)\1\)/i);
    if (bgm && bgm[2]) thumbnail = bgm[2];
  }

  // 4) 페이지 어딘가에 nps Catalog jpg가 박혀있는 경우 fallback (제일 강력)
  if (!thumbnail) {
    const any = $card.html() || "";
    const mNps = any.match(/https?:\/\/nps\.ktv\.go\.kr\/[^"'\\s]+\/Catalog\/\d+\.jpg/i);
    if (mNps) thumbnail = mNps[0];
  }

  // 5) 상대경로면 절대경로로 보정
  if (thumbnail && thumbnail.startsWith("/")) thumbnail = `${NANURI_ORIGIN}${thumbnail}`;

  collected.push({ title, detailUrl, thumbnail });
});



      if (collected.length >= 100) break;
    }

    return res.json(collected.slice(0, 100));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error", detail: String(e) });
  }
});

// ====== DETAIL -> M3U8 (expanded) ======
app.post("/api/play-url", async (req, res) => {
  try {
    const detailUrlRaw = (req.body.detailUrl || "").trim();
    if (!detailUrlRaw) return res.status(400).json({ error: "detailUrl required" });

    if (!cookieHeader) await loginNanuri();

    // 오타 섞임 보정
// ✅ 오타가 섞여있어서 "수정"하지 말고 둘 다 시도
// ✅ 오타가 섞여있어서 "수정"하지 말고 둘 다 시도
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

fs.writeFileSync("debug_detail.html", html, "utf-8");
console.log("saved debug_detail.html");

// ===============================
// 썸네일(postImageUrl) 자동 추출
// ===============================
let thumbnail = null;

// 1) gmediaVideoPlugin 설정에서 추출
const thumb1 = html.match(/postImageUrl\s*:\s*['"]([^'"]+)['"]/i);
if (thumb1 && thumb1[1]) {
  thumbnail = thumb1[1];
}

// 2) HTML img 태그 fallback
if (!thumbnail) {
  const thumb2 = html.match(
    /https?:\/\/nps\.ktv\.go\.kr\/[^"'\\s]+\/Catalog\/\d+\.jpg/i
  );
  if (thumb2) {
    thumbnail = thumb2[0];
  }
}


// … (m3u8 추출 로직들)

// ✅ meta는 finalUrl 사용


    // 1) m3u8 직접 찾기
    let m3u8Match = html.match(/https?:\/\/play\.g\.ktv\.go\.kr:4433\/[^"'\\s]+\.m3u8/g);
    let m3u8 = m3u8Match ? m3u8Match[0] : null;

    // ✅ 1. gmediaVideoPlugin 에서 vodUrl_m 추출 (instlVideo/mediaVideoDetail 대응)
if (!m3u8) {
  // vodUrl_m: encodeURI("https://.../playlist.m3u8")
  const mVod = html.match(/vodUrl_m\s*:\s*encodeURI\(\s*"([^"]+)"\s*\)/i);
  if (mVod && mVod[1]) {
    m3u8 = mVod[1];
  }
}

if (!m3u8) {
  // vodUrl_m: "https://.../playlist.m3u8"
  const mVod2 = html.match(/vodUrl_m\s*:\s*"([^"]+)"\s*/i);
  if (mVod2 && mVod2[1]) {
    m3u8 = mVod2[1];
  }
}


    // 2) 없으면 mp4 찾고 playlist.m3u8로 변환
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

    // 3) 그래도 없으면 /vod-proxy 상대경로 찾기
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

// ====== start ======
const PORT = process.env.PORT || 8787;

app.listen(PORT, () => {
  console.log("KTV proxy listening on", PORT);
});
