import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { db } from "./firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const STORAGE_KEY = "position_monitor_v1";
const CLOSED_STORAGE_KEY = "closed_positions_v1";
const NEW_TTL = 24 * 60 * 60 * 1000;

const TABS = [
  { id: "crypto",      label: "Crypto",      source: "binance" },
  { id: "stocks",      label: "Stocks",      source: "yahoo"   },
  { id: "indices",     label: "Indices",     source: "yahoo"   },
  { id: "commodities", label: "Commodities", source: "yahoo"   },
  { id: "etfs",        label: "ETFs",        source: "yahoo"   },
];

const DISCORD_WEBHOOKS = {
  crypto:      "https://discord.com/api/webhooks/1511534525824630864/eX28AHnoVCsrJboN-40Puy2B4Te5mbHUIKCCnwby4EHC7ydJGUksecw3Ejv8FEqzIO_L",
  stocks:      "https://discord.com/api/webhooks/1511535014544801852/PoL6psyWo2rhN4q2zoWoLAuC53taTQtWR38SvbTB5EFZPwHbI2kYYSd6kJ7NzAzuyK-y",
  indices:     "https://discord.com/api/webhooks/1511535136074633327/ZwQnf5V2ac6Kxj3JYnakQ58ljK9Hf7R4cudhCFwfjheedwh_e4casaMmwPP9bHl6wwus",
  commodities: "https://discord.com/api/webhooks/1511535267725443224/ZAgFTla-ytfk7ippnSDh7VOhyyug7fUdjjF3G9smaxC312q4BcEQriTGCIgQmfa1upTZ",
  etfs:        "https://discord.com/api/webhooks/1511535403746853104/DPOGxol_dxf5VUw7Zt0LBTriO2LNXWFIn-CQ1c1q8oDwZjFtP4IC_qT4KZqLfsDwS1_i",
};

// ── MOTION TOKENS · Apple-style fluid easing ─────────────────────────────────
const EASE   = "cubic-bezier(0.22, 1, 0.36, 1)";
const SPRING = "cubic-bezier(0.34, 1.4, 0.64, 1)";

const loadHtml2Canvas = () => new Promise((resolve, reject) => {
  if (window.html2canvas) { resolve(window.html2canvas); return; }
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
  s.onload = () => resolve(window.html2canvas);
  s.onerror = reject;
  document.head.appendChild(s);
});

const postScreenshotToDiscord = async (elementId, tabId, tabLabel, webhookUrl, lines = []) => {
  const el = document.getElementById(elementId);
  if (!el) return { ok: false, error: "Element not found" };
  try {
    const html2canvas = await loadHtml2Canvas();
    // Hide elements that look bad in screenshot
    const style = document.createElement("style");
    style.id = "screenshot-hide";
    style.textContent = ".flag-sel, .del-btn, .close-pos-btn { visibility: hidden !important; } .flag-badge { font-size: 9px !important; padding: 3px 9px !important; animation: none !important; } .table-wrap, tbody tr { animation: none !important; backdrop-filter: none !important; } .table-wrap { background: #111 !important; border: 1px solid #222 !important; } .logo-name { animation: none !important; }";
    document.head.appendChild(style);

    // Replace dir selects with readable divs
    const dirSelects = el.querySelectorAll(".dir-sel");
    const replacements = [];
    dirSelects.forEach(sel => {
      const isLong = sel.value === "LONG";
      const div = document.createElement("div");
      div.style.cssText = "display:inline-block;padding:5px 12px;font-size:10px;font-weight:700;letter-spacing:0.15em;border-radius:4px;font-family:Montserrat,sans-serif;" + (isLong ? "background:rgba(34,197,94,0.12);color:#22c55e;" : "background:rgba(239,68,68,0.12);color:#ef4444;");
      div.textContent = isLong ? "LONG" : "SHORT";
      sel.parentNode.insertBefore(div, sel);
      sel.style.display = "none";
      replacements.push({ div, sel });
    });

    const canvas = await html2canvas(el, {
      backgroundColor: "#0a0a0a",
      scale: 2,
      useCORS: true,
      logging: false,
    });
    document.getElementById("screenshot-hide")?.remove();
    replacements.forEach(({ div, sel }) => { sel.style.display = ""; div.remove(); });
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    const fileName = `vsx-${tabId}-${Date.now()}.png`;

    // ── Embed mit kategorisierten Inline-Fields (max 2 nebeneinander) ──
    // lines: [{ presetId, text }] — gruppiert nach Kategorie; ein unsichtbares
    // Spacer-Field nach jedem 2er-Paar verhindert, dass Discord 3 in eine Reihe packt.
    const GROUP_META = {
      new:     "New Positions",
      sl:      "Stop Loss",
      partial: "Partials",
      adding:  "Added",
      closed:  "Closed",
    };
    const groups = {};
    (lines || []).forEach(l => { (groups[l.presetId] = groups[l.presetId] || []).push(l.text); });
    const realFields = Object.keys(GROUP_META)
      .filter(id => groups[id]?.length)
      .map(id => ({ name: GROUP_META[id], value: groups[id].join("\n").slice(0, 1024), inline: true }));
    const fields = [];
    realFields.forEach((f, i) => {
      fields.push(f);
      if (i % 2 === 1 && i < realFields.length - 1) fields.push({ name: "\u200b", value: "\u200b", inline: true });
    });

    const embed = {
      author: { name: "VISIONX · POSITIONING" },
      title: `◆  ${tabLabel.toUpperCase()} PACK`,
      color: 0xd4af37,
      ...(fields.length ? { fields } : {}),
      image: { url: `attachment://${fileName}` },
      footer: { text: "VisionX Market Analytics · Proprietary Positioning Desk" },
      timestamp: new Date().toISOString(),
    };

    const form = new FormData();
    form.append("payload_json", JSON.stringify({ embeds: [embed] }));
    form.append("files[0]", blob, fileName);
    const res = await fetch(webhookUrl, { method: "POST", body: form });
    return { ok: res.ok };
  } catch (e) {
    document.getElementById("screenshot-hide")?.remove();
    if (typeof replacements !== "undefined") replacements.forEach(({ div, sel }) => { sel.style.display = ""; div.remove(); });
    return { ok: false, error: e.message };
  }
};

const PLACEHOLDERS = {
  crypto: "BTC", stocks: "MSFT", indices: "^GSPC", commodities: "GC=F", etfs: "SPY",
};
const STOCK_HINT = "US: MSFT  ·  DE: BAS.DE  ·  IT: ENI.MI  ·  FR: MC.PA  ·  CH: NESN.SW  ·  JP: 7203.T";

const FLAGS = {
  "new_position": { label: "NEW POSITION", short: "NEW POS",  color: "34,197,94",  textColor: "#fff", solidBg: "#22c55e", solidBorder: "#22c55e" },
  "stop_adjust":  { label: "STOP ADJUST",  short: "SL ADJ",   color: "212,175,55", textColor: "#fff", solidBg: "#d4af37", solidBorder: "#d4af37" },
  "added":        { label: "ADDED",        short: "ADDED",    color: "99,182,255", textColor: "#fff", solidBg: "#63b6ff", solidBorder: "#63b6ff" },
  "partials":     { label: "PARTIALS",     short: "PARTIALS", color: "168,85,247", textColor: "#fff", solidBg: "#a855f7", solidBorder: "#a855f7" },
};

const CLOSE_REASONS = {
  "tp":     "Take Profit",
  "sl":     "Stop Loss Hit",
  "manual": "Manual Close",
  "expire": "Position Expired",
};

const getQuarter = (date) => {
  const d = date ? new Date(date) : new Date();
  const q = Math.ceil((d.getMonth() + 1) / 3);
  return `Q${q}-${d.getFullYear()}`;
};
const getQuarterLabel = (q) => q.replace("-", " ");

const getQuarterOptions = () => {
  const now = new Date();
  const opts = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 1; y--) {
    const maxQ = y === now.getFullYear() ? Math.ceil((now.getMonth() + 1) / 3) : 4;
    for (let q = maxQ; q >= 1; q--) opts.push(`Q${q}-${y}`);
  }
  return opts;
};

const sortedQuarters = (list) => [...new Set(list)].sort((a, b) => {
  const [qa, ya] = a.split("-"); const [qb, yb] = b.split("-");
  if (ya !== yb) return parseInt(yb) - parseInt(ya);
  return parseInt(qb.slice(1)) - parseInt(qa.slice(1));
});

// ── FIREBASE STORAGE FUNCTIONS (replacing localStorage) ───────────────────────
const loadFromStorage = async () => {
  try {
    const snap = await getDoc(doc(db, "tracker", STORAGE_KEY));
    return snap.exists() ? snap.data().value : null;
  } catch { return null; }
};

const saveToStorage = async (d) => {
  try {
    await setDoc(doc(db, "tracker", STORAGE_KEY), { value: d });
  } catch {}
};

const loadClosedFromStorage = async () => {
  try {
    const snap = await getDoc(doc(db, "tracker", CLOSED_STORAGE_KEY));
    return snap.exists() ? snap.data().value : {};
  } catch { return {}; }
};

const saveClosedToStorage = async (d) => {
  try {
    await setDoc(doc(db, "tracker", CLOSED_STORAGE_KEY), { value: d });
  } catch {}
};
// ─────────────────────────────────────────────────────────────────────────────

// Multi-Flag: Positionen tragen ein flags-Array; Legacy-Daten (einzelnes flag-Feld
// aus Firestore) werden transparent als Ein-Element-Array gelesen.
const getFlags = (p) => Array.isArray(p.flags) ? p.flags : (p.flag ? [p.flag] : []);
const isFlagged = (p) => getFlags(p).length > 0 && p.flaggedAt && (Date.now() - p.flaggedAt) < NEW_TTL;
const isNew = (p) => isFlagged(p);

const fetchBinance = async (ticker) => {
  const sym = ticker.toUpperCase().trim();
  const symbol = sym.endsWith("USDT") ? sym : sym + "USDT";
  try { const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`); if (res.ok) { const price = parseFloat((await res.json()).price); if (price > 0) return price; } } catch {}
  try { const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`); if (res.ok) { const price = parseFloat((await res.json()).price); if (price > 0) return price; } } catch {}
  return null;
};

const PROXIES = [
  (u) => fetch(u, { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
  (u) => fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => JSON.parse(d.contents)),
  (u) => fetch(`https://corsproxy.io/?${encodeURIComponent(u)}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
  (u) => fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
];

// Our own Vercel API route — no CORS issues
const fetchYahooDirect = async (ticker) => {
  try {
    const r = await fetch(`/api/yahoo?symbols=${ticker}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d?.prices?.[ticker] || null;
  } catch { return null; }
};

const fetchYahooSingle = async (ticker) => {
  return await fetchYahooDirect(ticker.toUpperCase().trim());
};

// Voller Instrumentname. Modul-Cache, damit auch die PnL-Karten (Share/Close)
// ohne Prop-Drilling an die Namen kommen. Quelle: eigene Vercel-Route /api/name
// (kein CORS, edge-gecached) mit der öffentlichen Proxy-Kette als Fallback.
const TICKER_NAME_CACHE = {};
const TICKER_NAME_FAIL = {};   // Fehlschläge mit Timestamp → Retry nach 10 Min statt nie
const getTickerName = (t) => TICKER_NAME_CACHE[(t || "").trim().toUpperCase()] || null;
// Anzeigename für Report/Karten: gespeicherter Name (Closed-Record) → Live-Cache → Ticker
const displayName = (o) => (o?.name) || getTickerName(o?.ticker) || o?.ticker || "—";
const fetchTickerName = async (ticker) => {
  const sym = ticker.toUpperCase().trim();
  try {
    const r = await fetch(`/api/name?symbol=${encodeURIComponent(sym)}`);
    if (r.ok) { const d = await r.json(); if (d?.name) return d.name; }
  } catch {}
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=3&newsCount=0`;
  for (const proxy of PROXIES.slice(1)) { // Direkt-Fetch überspringen — scheitert im Browser immer an CORS
    try {
      const d = await proxy(url);
      const q = d?.quotes?.find(x => (x.symbol || "").toUpperCase() === sym) || d?.quotes?.[0];
      const name = q?.longname || q?.shortname;
      if (name) return name;
    } catch {}
  }
  return null;
};

const fetchYahooBatch = async (tickers) => {
  const results = {};
  tickers.forEach(t => { results[t] = null; });
  try {
    const symbols = tickers.join(",");
    const r = await fetch(`/api/yahoo?symbols=${symbols}`);
    if (r.ok) {
      const d = await r.json();
      if (d?.prices) {
        tickers.forEach(t => { if (d.prices[t]) results[t] = d.prices[t]; });
      }
    }
  } catch {}
  // Fallback: fetch missing ones individually
  for (const ticker of tickers) {
    if (results[ticker] === null) results[ticker] = await fetchYahooSingle(ticker);
  }
  return results;
};

// ── TRADE CLASSIFICATION · win / loss / break-even (scratch) ────────────────
const EPS_USD = 0.005;
const isWin   = (c) => (c.pnlUSD || 0) >  EPS_USD;
const isLoss  = (c) => (c.pnlUSD || 0) < -EPS_USD;
const isBE    = (c) => !isWin(c) && !isLoss(c);

const calcPnL = (dir, entry, cur) => {
  if (!entry || !cur || isNaN(entry) || isNaN(cur)) return null;
  return dir === "LONG" ? ((cur - entry) / entry) * 100 : ((entry - cur) / entry) * 100;
};
// Comma-safe numeric parser: accepts "4256,4", "1.234,56", "1,4033", "204" etc.
// Treats a trailing comma group as the decimal separator (European input).
const num = (v) => {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  let str = String(v).trim().replace(/\s/g, "");
  if (str === "") return NaN;
  const hasComma = str.includes(","), hasDot = str.includes(".");
  if (hasComma && hasDot) {
    // last separator is the decimal one; the other is a thousands grouping
    if (str.lastIndexOf(",") > str.lastIndexOf(".")) str = str.replace(/\./g, "").replace(",", ".");
    else str = str.replace(/,/g, "");
  } else if (hasComma) {
    str = str.replace(",", ".");
  }
  const n = parseFloat(str);
  return isNaN(n) ? NaN : n;
};
const calcPnLUSD = (dir, entry, closePrice, qty) => {
  if (!entry || !closePrice || !qty || isNaN(entry) || isNaN(closePrice) || isNaN(num(qty))) return null;
  const q = num(qty);
  return dir === "LONG" ? (closePrice - entry) * q : (entry - closePrice) * q;
};
const calcSLDist = (dir, cur, sl) => {
  if (!cur || !sl || isNaN(cur) || isNaN(sl)) return null;
  return dir === "LONG" ? ((cur - sl) / cur) * 100 : ((sl - cur) / cur) * 100;
};
const fmtPrice = (p) => {
  if (p == null) return "—";
  if (p < 0.01) return p.toFixed(6);
  if (p < 1) return p.toFixed(4);
  if (p < 100) return p.toFixed(3);
  return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const calcPositionValue = (direction, qty, entryPrice, currentPrice) => {
  if (!qty || isNaN(num(qty))) return null;
  if (!currentPrice || isNaN(currentPrice)) return null;
  const q = num(qty);
  if (direction === "LONG") {
    return q * currentPrice;
  } else {
    if (!entryPrice || isNaN(num(entryPrice))) return null;
    return q * (2 * num(entryPrice) - currentPrice);
  }
};
const fmtValue = (val) => {
  if (val == null) return null;
  return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtUSD = (v) => {
  if (v == null) return "—";
  const abs = Math.abs(v);
  return (v >= 0 ? "+" : "-") + "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const daysBetween = (d1, d2) => {
  const a = new Date(d1), b = new Date(d2);
  return Math.round(Math.abs((b - a) / (1000 * 60 * 60 * 24)));
};

const newRow = () => ({
  id: Math.random().toString(36).slice(2),
  ticker: "", direction: "LONG", qty: "", entry: "", sl: "",
  date: new Date().toISOString().split("T")[0],
  flags: [], flaggedAt: null,
  currentPrice: null, loading: false, error: false,
});
const EMPTY_STATE = Object.fromEntries(TABS.map((t) => [t.id, []]));

// ── PRICE TICK FLASH · discreet live-update indicator ────────────────────────
function FlashPrice({ price }) {
  const prev = useRef(price);
  const [dir, setDir] = useState(null);
  useEffect(() => {
    if (prev.current != null && price != null && price !== prev.current) {
      setDir(price > prev.current ? "up" : "down");
      prev.current = price;
      const t = setTimeout(() => setDir(null), 1250);
      return () => clearTimeout(t);
    }
    prev.current = price;
  }, [price]);
  return <span className={"price-val" + (dir ? " px-" + dir : "")}>{fmtPrice(price)}</span>;
}

// ── BODY SCROLL LOCK · page is frozen while a modal/panel is open ───────────
function useBodyScrollLock() {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    const scrollbarW = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarW > 0) document.body.style.paddingRight = scrollbarW + "px"; // no layout jump
    return () => { document.body.style.overflow = prevOverflow; document.body.style.paddingRight = prevPad; };
  }, []);
}

const VSXLogo = ({ size = 72 }) => (
  <img src="https://i.postimg.cc/pd4xzT1r/87011e66-b8e4-4d2b-9977-a06bb4b29902.png"
    width={size} height={size} alt="VisionX Logo"
    style={{ objectFit: "contain", display: "block", filter: "drop-shadow(0 0 16px rgba(212,175,55,0.5))" }} />
);

// ── ARROW ASSETS · rendered PNGs (preferred) with SVG fallback ──────────────
// Generate the two arrows externally (Octane-style prompt), upload to postimg
// (CORS-safe like the logo), paste the direct image URLs here. Empty string →
// falls back to the built-in SVG arrow automatically.
const ARROW_IMG = {
  // VisionX Bull/Bear v2 · transparent
  win:  "https://i.postimg.cc/GmfPTVcZ/Vision-X-Bull-(2).png",
  loss: "https://i.postimg.cc/kgHNRzn1/Vision-X-Bear-(2).png",
};
const vsxArrowHTML = (win, idp) => {
  const url = win ? ARROW_IMG.win : ARROW_IMG.loss;
  // Transparente PNGs: einfaches contain, kein Crop nötig — Kante existiert nicht mehr
  if (url) return `<img src="${url}" crossorigin="anonymous" alt="" style="width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 8px 12px rgba(0,0,0,0.4))"/>`;
  return vsxArrow3D(win, idp);
};

// ── 3D GOLD ARROW · Bitget-style dark metal (↗ win / ↘ loss) ────────────────
// Exact glyph geometry: flat arm (the "resting" one — top for win, bottom for
// loss), second arm at 90°, shaft at 45°; all three L=150, t=34, square propor-
// tions. Whole body leans ~15° into the background. Result tint (green/red)
// lives ONLY in rim glow + ground shadow — never as an overlay on the metal.
const vsxArrow3D = (win, idp = "vxa") => {
  const tint = win ? "34,197,94" : "239,68,68";
  // Precomputed outlines (240×240 box) — verified: arms & shaft equal length/thickness
  const front = win
    ? "196,44 46,44 46,78 162,78 56,184 80,208 162,126 162,194 196,194"
    : "196,208 46,208 46,174 162,174 56,68 80,44 162,126 162,58 196,58";
  const quads = win
    ? [["46,78 162,78 175,93 59,93", "sb"], ["80,208 162,126 175,141 93,223", "sd"], ["162,194 196,194 209,209 175,209", "sb"], ["196,194 196,44 209,59 209,209", "sr"]]
    : [["196,208 46,208 59,223 209,223", "sb"], ["196,58 196,208 209,223 209,73", "sr"]];
  const seams = win ? ["46,78 162,78", "80,208 162,126", "162,194 196,194 196,44"] : ["46,208 196,208", "196,58 196,208"];
  const rim = win ? "196,44 46,44" : "196,208 46,208";           // bright light on the flat arm's outer edge
  const tintEdge = win ? "196,194 196,44" : "196,58 196,208";    // colored glow on the vertical arm's outer edge
  const shadowY = win ? 226 : 229;
  return `
<svg width="100%" height="100%" viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${idp}f" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="#e8cf82"/>
      <stop offset="20%" stop-color="#a8862e"/>
      <stop offset="46%" stop-color="#6d5516"/>
      <stop offset="72%" stop-color="#3f3009"/>
      <stop offset="100%" stop-color="#261c04"/>
    </linearGradient>
    <linearGradient id="${idp}env" x1="0" y1="0" x2="1" y2="0.12">
      <stop offset="0%"  stop-color="rgba(255,240,190,0)"/>
      <stop offset="28%" stop-color="rgba(255,240,190,0.16)"/>
      <stop offset="44%" stop-color="rgba(0,0,0,0.42)"/>
      <stop offset="60%" stop-color="rgba(255,240,190,0.09)"/>
      <stop offset="78%" stop-color="rgba(0,0,0,0.48)"/>
      <stop offset="100%" stop-color="rgba(255,240,190,0.05)"/>
    </linearGradient>
    <linearGradient id="${idp}sr" x1="0" y1="0" x2="1" y2="0.3">
      <stop offset="0%" stop-color="#54400f"/>
      <stop offset="100%" stop-color="#150e01"/>
    </linearGradient>
    <linearGradient id="${idp}sb" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0%" stop-color="#2c2106"/>
      <stop offset="100%" stop-color="#0e0901"/>
    </linearGradient>
    <linearGradient id="${idp}sd" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3d2f0a"/>
      <stop offset="100%" stop-color="#120c01"/>
    </linearGradient>
    <radialGradient id="${idp}g" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="rgba(212,175,55,0.14)"/>
      <stop offset="75%" stop-color="rgba(${tint},0.06)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </radialGradient>
    <clipPath id="${idp}c"><polygon points="${front}"/></clipPath>
    <filter id="${idp}b" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="${idp}b2" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="${idp}b3" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4"/></filter>
  </defs>
  <circle cx="120" cy="122" r="110" fill="url(#${idp}g)"/>
  <!-- ~15° lean into the background: vertical foreshortening + slight skew -->
  <g transform="translate(13,3) skewX(-6) scale(1,0.957)">
    <!-- ground shadow · under the resting arm, faintly result-tinted -->
    <ellipse cx="122" cy="${shadowY}" rx="86" ry="12" fill="rgba(0,0,0,0.72)" filter="url(#${idp}b)"/>
    <ellipse cx="122" cy="${shadowY}" rx="60" ry="8" fill="rgba(${tint},0.16)" filter="url(#${idp}b)"/>
    <!-- extrusion faces -->
    ${quads.map(([pts, gid]) => `<polygon points="${pts}" fill="url(#${idp}${gid})"/>`).join("\n    ")}
    <!-- seams -->
    ${seams.map(pts => `<polyline points="${pts}" fill="none" stroke="rgba(0,0,0,0.9)" stroke-width="1.5"/>`).join("\n    ")}
    <!-- front face · dark physical gold -->
    <polygon points="${front}" fill="url(#${idp}f)" stroke="rgba(232,207,130,0.30)" stroke-width="1"/>
    <!-- environment reflection bands, clipped to the metal -->
    <g clip-path="url(#${idp}c)">
      <rect x="-20" y="-20" width="280" height="280" fill="url(#${idp}env)" opacity="0.85" transform="rotate(7 120 120)"/>
    </g>
    <!-- rim light on the flat arm -->
    <polyline points="${rim}" fill="none" stroke="rgba(255,244,205,0.9)" stroke-width="2" stroke-linecap="round" filter="url(#${idp}b2)"/>
    <polyline points="${rim}" fill="none" stroke="#fff6d8" stroke-width="0.9" stroke-linecap="round"/>
    <!-- result-colored glow along the vertical arm's outer edge (in the metal's shadow side) -->
    <polyline points="${tintEdge}" fill="none" stroke="rgba(${tint},0.5)" stroke-width="2.4" stroke-linecap="round" filter="url(#${idp}b3)"/>
    <!-- tip glint -->
    <circle cx="196" cy="${win ? 44 : 208}" r="2.6" fill="#fffdf0" filter="url(#${idp}b2)"/>
    <circle cx="196" cy="${win ? 44 : 208}" r="1" fill="#ffffff"/>
  </g>
</svg>`;
};

// ── FREE CONTENT · public-facing performance assets ─────────────────────────
const FREE_CONTENT_WEBHOOKS = {
  aggregatedStats: "https://discord.com/api/webhooks/1514405089270431814/4wjw15gS_mYPbnl4-xbcycTEng_4shodjF8nG12cNUJif3MsZ12OXCWNFg1aWObH1vzg",
  equityCurve: "https://discord.com/api/webhooks/1514405642486677544/tGw-sulX0hbui_R0tgc5j4_Q4czumsEtXUtCTbWB34ucgZSB_Xq4bpjgcCbRyN8w_Pi0",
  trackRecord: "https://discord.com/api/webhooks/1514406453094387853/LlO7-Jka31lkiibbkrtnBCnTsOIcsXDBRPAZ2KKliYH88yXSIWOypufLyp1BS6QjlWcy",
};
const PERF_CONFIG_KEY = "performance_config_v1";
const METHODOLOGY_NOTE = "Cumulative net trading P&L, realized trades only, shown as % of quarter-start capital, chained quarterly. No open positions are displayed. Past performance is not indicative of future results.";

const loadPerfConfig = async () => {
  try {
    const snap = await getDoc(doc(db, "tracker", PERF_CONFIG_KEY));
    if (snap.exists()) return snap.data().value?.segments || [];
  } catch (e) { console.error("perf config load", e); }
  return [];
};
const savePerfConfig = async (segments) => {
  try { await setDoc(doc(db, "tracker", PERF_CONFIG_KEY), { value: { segments } }); } catch (e) { console.error("perf config save", e); }
};

const segStartMs = (s) => new Date(s.startDate + "T00:00:00").getTime();

// Quarterly-chained realized P&L index. Additive within a segment, multiplicative across
// segments: Index = 100 × Π(1 + Q_i_final) × (1 + QTD_active). Realized trades only.
function computePerformanceCurve(closedPositions, segments, nowMs = Date.now()) {
  const segs = [...segments].sort((a, b) => segStartMs(a) - segStartMs(b));
  if (segs.length === 0) return { points: [], index: 100, qtdPct: 0, maxDrawdownPct: 0, totalCloses: 0, activeSeg: null };
  const t0 = segStartMs(segs[0]);
  const trades = closedPositions.filter(c => c.closedAt >= t0 && c.pnlUSD != null).sort((a, b) => a.closedAt - b.closedAt);
  let chain = 1, qtd = 0, segIdx = 0;
  const points = [];
  const advanceTo = (ms) => {
    while (segIdx + 1 < segs.length && ms >= segStartMs(segs[segIdx + 1])) {
      chain *= (1 + qtd); qtd = 0; segIdx++;
    }
  };
  for (const c of trades) {
    advanceTo(c.closedAt);
    const cap = segs[segIdx].startCapitalUsd;
    const delta = cap > 0 ? (c.pnlUSD || 0) / cap : 0;
    qtd += delta;
    points.push({
      t: c.closedAt, date: c.closeDate, ticker: c.ticker, tabLabel: c.tabLabel,
      deltaPct: delta * 100, index: 100 * chain * (1 + qtd), segId: segs[segIdx].id,
    });
  }
  advanceTo(nowMs);
  const index = 100 * chain * (1 + qtd);
  let peak = 100, mdd = 0;
  for (const p of points) { peak = Math.max(peak, p.index); mdd = Math.max(mdd, (peak - p.index) / peak * 100); }
  return { points, index, qtdPct: qtd * 100, maxDrawdownPct: mdd, totalCloses: points.length, activeSeg: segs[segIdx] };
}

// Book impact of a single realized trade against the segment active at its close.
const tradeBookImpactPct = (record, segments) => {
  if (!segments || segments.length === 0) return null;
  const segs = [...segments].sort((a, b) => segStartMs(a) - segStartMs(b));
  if (record.closedAt < segStartMs(segs[0])) return null;
  let seg = segs[0];
  for (const s of segs) { if (record.closedAt >= segStartMs(s)) seg = s; }
  return seg.startCapitalUsd > 0 ? ((record.pnlUSD || 0) / seg.startCapitalUsd) * 100 : null;
};

const fmtSignedPct = (v, digits = 2) => (v >= 0 ? "+" : "") + v.toFixed(digits) + "%";

// ── TRACK RECORD AUTO-POST · fires on every FULL close (no remainder) ───────
// Rich embed + auto-generated VSX PnL card. Whitelisted fields only:
// ticker, asset class, direction, holding days, return %, exit, close date —
// no USD, no sizes, no price levels (public track-record rules).
const EXIT_EMOJI = { tp: "🎯", sl: "🛑", manual: "✋", expire: "⌛" };
const fmtDateDE = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };

// Builds the VSX close-card DOM off-screen (public-safe: % only)
const buildCloseCardEl = (record) => {
  const pnl = record.pnlPct || 0;
  const win = pnl > 0.005, loss = pnl < -0.005;
  const pnlColor = win ? "#22c55e" : loss ? "#ef4444" : "#d4af37";
  const isLong = record.direction === "LONG";
  const exitLabel = CLOSE_REASONS[record.reason] || "Manual Close";
  const dispName = record.name || getTickerName(record.ticker);
  const wrap = document.createElement("div");
  wrap.id = "vsx-close-card-capture";
  wrap.style.cssText = "position:fixed;left:-9999px;top:0;width:520px;z-index:-1;";
  wrap.innerHTML = `
    <div style="position:relative;border-radius:22px;overflow:hidden;background:linear-gradient(155deg,#16150f 0%,#0d0d0d 45%,#0a0a0a 100%);border:1px solid rgba(212,175,55,0.22);padding:0 0 22px;font-family:'Montserrat',sans-serif;">
      <div style="height:4px;background:linear-gradient(90deg,#b99c64,#d4af37,#f8e49b,#d4af37,#b99c64)"></div>
      <div style="position:absolute;top:-80px;right:-80px;width:340px;height:340px;background:radial-gradient(circle,rgba(212,175,55,0.09) 0%,transparent 65%);pointer-events:none"></div>
      <div style="position:absolute;top:52px;right:30px;width:150px;height:150px;pointer-events:none;opacity:0.97;z-index:0">${vsxArrowHTML(win, "vxclose")}</div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 26px 0;position:relative;z-index:1">
        <div style="display:flex;align-items:center;gap:12px">
          <img src="https://i.postimg.cc/pd4xzT1r/87011e66-b8e4-4d2b-9977-a06bb4b29902.png" width="38" height="38" style="object-fit:contain;filter:drop-shadow(0 0 14px rgba(212,175,55,0.5))">
          <div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:19px;letter-spacing:0.26em;color:#d4af37;line-height:1">VISIONX</div>
            <div style="font-size:6.5px;letter-spacing:0.38em;color:#b99c64;text-transform:uppercase;margin-top:3px">Market Analytics</div>
          </div>
        </div>
        <div style="font-size:8px;font-weight:700;letter-spacing:0.24em;color:${pnlColor};text-transform:uppercase;padding:4px 12px;border:1px solid ${pnlColor}55;border-radius:20px;background:${pnlColor}11">TRADE CLOSED</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:24px 26px 0;position:relative;z-index:1">
        <span title="${record.ticker}" style="font-family:'Bebas Neue',sans-serif;font-size:${dispName ? "22px" : "30px"};letter-spacing:0.08em;color:#f8e49b;line-height:1;max-width:290px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block">${dispName || record.ticker}</span>
        ${dispName ? `<span style="font-family:'DM Mono',monospace;font-size:11px;color:#8a8a8a">${record.ticker}</span>` : ""}
        <span style="font-size:10px;font-weight:800;letter-spacing:0.16em;padding:4px 13px;border-radius:5px;background:${isLong ? "rgba(34,197,94,0.14)" : "rgba(239,68,68,0.14)"};border:1px solid ${isLong ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"};color:${isLong ? "#22c55e" : "#ef4444"}">${record.direction}</span>
        <span style="font-size:9px;font-weight:700;letter-spacing:0.14em;color:#b99c64;text-transform:uppercase">${(record.tabLabel || "").toUpperCase()}</span>
      </div>
      <div style="padding:14px 26px 4px">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:74px;letter-spacing:0.02em;line-height:0.95;color:${pnlColor};text-shadow:0 0 44px ${pnlColor}55">${(pnl >= 0 ? "+" : "") + pnl.toFixed(2)}%</div>
      </div>
      <div style="margin:16px 26px 0;display:flex;gap:10px;position:relative;z-index:1">
        <div style="flex:1;background:rgba(19,17,12,0.96);border:1px solid rgba(255,255,255,0.09);border-radius:12px;padding:11px 15px">
          <div style="font-size:7px;font-weight:700;letter-spacing:0.22em;color:#666;text-transform:uppercase;margin-bottom:5px">Holding</div>
          <div style="font-family:'DM Mono',monospace;font-size:14px;color:#e8e8e8">${record.daysHeld != null ? record.daysHeld + "d" : "—"}</div>
        </div>
        <div style="flex:1;background:rgba(19,17,12,0.96);border:1px solid rgba(255,255,255,0.09);border-radius:12px;padding:11px 15px">
          <div style="font-size:7px;font-weight:700;letter-spacing:0.22em;color:#666;text-transform:uppercase;margin-bottom:5px">Exit</div>
          <div style="font-family:'DM Mono',monospace;font-size:14px;color:#e8e8e8">${exitLabel}</div>
        </div>
        <div style="flex:1;background:rgba(19,17,12,0.96);border:1px solid rgba(255,255,255,0.09);border-radius:12px;padding:11px 15px">
          <div style="font-size:7px;font-weight:700;letter-spacing:0.22em;color:#666;text-transform:uppercase;margin-bottom:5px">Closed</div>
          <div style="font-family:'DM Mono',monospace;font-size:14px;color:#e8e8e8">${fmtDateDE(record.closeDate)}</div>
        </div>
      </div>
      <div style="margin:18px 26px 0;padding-top:13px;border-top:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:7px;letter-spacing:0.26em;color:#b99c64;text-transform:uppercase;font-weight:700">Proprietary Trading · Official Track Record</div>
        <div style="font-family:'DM Mono',monospace;font-size:7.5px;color:#444">Realized · Not investment advice</div>
      </div>
    </div>`;
  return wrap;
};

const postTrackRecordToDiscord = async (record) => {
  try {
    const pnl = record.pnlPct || 0;
    const win = pnl > 0.005, loss = pnl < -0.005;
    const resultEmoji = win ? "🟢" : loss ? "🔴" : "⚪";
    const dirEmoji = record.direction === "LONG" ? "📈" : "📉";
    const exitEmoji = EXIT_EMOJI[record.reason] || "✋";
    const exitLabel = CLOSE_REASONS[record.reason] || "Manual Close";
    const embedColor = win ? 0x22c55e : loss ? 0xef4444 : 0xd4af37;

    // 1. Card off-screen rendern & capturen
    let fileBlob = null;
    try {
      const html2canvas = await loadHtml2Canvas();
      const el = buildCloseCardEl(record);
      document.body.appendChild(el);
      // Auf Logo + Pfeil-Asset warten (remote, groß) statt fixer Wartezeit
      const imgs = Array.from(el.querySelectorAll("img"));
      await Promise.race([
        Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; }))),
        new Promise(r => setTimeout(r, 4000)), // Hard-Timeout, falls ein Host lahmt
      ]);
      await new Promise(r => setTimeout(r, 120)); // Decode/Paint settle
      const canvas = await html2canvas(el.firstElementChild, { backgroundColor: null, scale: 3, useCORS: true, logging: false });
      el.remove();
      fileBlob = await new Promise(r => canvas.toBlob(r, "image/png"));
    } catch (cardErr) { console.error("close card render", cardErr); }

    // 2. Embed bauen — Bild als attachment referenziert, Fallback ohne Bild
    const fileName = `vsx-close-${record.ticker}-${Date.now()}.png`;
    const embed = {
      title: `${resultEmoji}  TRADE CLOSED · ${record.ticker}`,
      color: embedColor,
      fields: [
        { name: "🗂️ Asset Class", value: `**${(record.tabLabel || "—").toUpperCase()}**`, inline: true },
        { name: `${dirEmoji} Direction`, value: `**${record.direction}**`, inline: true },
        { name: "⏳ Holding", value: `**${record.daysHeld != null ? record.daysHeld + (record.daysHeld === 1 ? " day" : " days") : "—"}**`, inline: true },
        { name: `${resultEmoji} Result`, value: `**${fmtSignedPct(pnl)}**`, inline: true },
        { name: `${exitEmoji} Exit`, value: exitLabel, inline: true },
        { name: "📅 Closed", value: fmtDateDE(record.closeDate), inline: true },
      ],
      footer: { text: "VisionX Market Analytics · Official Track Record" },
      timestamp: new Date().toISOString(),
    };
    if (fileBlob) embed.image = { url: `attachment://${fileName}` };

    const form = new FormData();
    form.append("payload_json", JSON.stringify({ embeds: [embed] }));
    if (fileBlob) form.append("files[0]", fileBlob, fileName);
    await fetch(FREE_CONTENT_WEBHOOKS.trackRecord, { method: "POST", body: form });
  } catch (e) { console.error("track record post", e); }
};

// ── FREE CONTENT SCREENSHOT · custom header, no pack naming ──────────────────
const postFreeContentScreenshot = async (elementId, webhookUrl, title, fileTag) => {
  const el = document.getElementById(elementId);
  if (!el) return { ok: false, error: "Element not found" };
  try {
    const html2canvas = await loadHtml2Canvas();
    const style = document.createElement("style");
    style.id = "screenshot-hide";
    style.textContent = ".free-no-capture { display: none !important; } * { animation: none !important; transition: none !important; }";
    document.head.appendChild(style);
    const canvas = await html2canvas(el, { backgroundColor: "#0a0a0a", scale: 2, useCORS: true, logging: false });
    document.getElementById("screenshot-hide")?.remove();
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    const form = new FormData();
    const now = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    form.append("content", `📊 **${title}** | ${now}`);
    form.append("file", blob, `vsx-${fileTag}-${Date.now()}.png`);
    const res = await fetch(webhookUrl, { method: "POST", body: form });
    return { ok: res.ok };
  } catch (e) {
    document.getElementById("screenshot-hide")?.remove();
    return { ok: false, error: e.message };
  }
};

// ── DAILY EQUITY SNAPSHOTS · captured at 00:00 Europe/Berlin (CET/CEST) ─────
const EQUITY_SNAPSHOT_KEY = "equity_snapshots_v1";
const cestDateStr = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const loadEquitySnapshots = async () => {
  try {
    const snap = await getDoc(doc(db, "tracker", EQUITY_SNAPSHOT_KEY));
    if (snap.exists()) return snap.data().value?.days || {};
  } catch (e) { console.error("equity snapshots load", e); }
  return {};
};
const saveEquitySnapshots = async (days) => {
  try { await setDoc(doc(db, "tracker", EQUITY_SNAPSHOT_KEY), { value: { days } }); } catch (e) { console.error("equity snapshots save", e); }
};

const calcOpenFloatUSD = (p) => {
  const ep = num(p.entry);
  if (!p.currentPrice || !ep || isNaN(ep)) return null;
  return calcPnLUSD(p.direction, ep, p.currentPrice, p.qty);
};

// Daily index incl. open positions: realized chain (identical methodology) plus the
// snapshot's floating P&L as % of the segment-start capital. Snapshot data only — no live prices.
function computeDailyEquityCurve(closedPositions, segments, snapshotDays) {
  const segs = [...segments].sort((a, b) => segStartMs(a) - segStartMs(b));
  if (segs.length === 0) return { points: [], maxDrawdownPct: 0 };
  const t0 = segStartMs(segs[0]);
  const snaps = Object.entries(snapshotDays || {})
    .map(([day, s]) => ({ day, ...s }))
    .filter(s => s.takenAt >= t0)
    .sort((a, b) => a.takenAt - b.takenAt);
  const trades = closedPositions.filter(c => c.closedAt >= t0 && c.pnlUSD != null).sort((a, b) => a.closedAt - b.closedAt);
  let chain = 1, qtd = 0, segIdx = 0, ti = 0;
  const advanceTo = (ms) => {
    while (segIdx + 1 < segs.length && ms >= segStartMs(segs[segIdx + 1])) { chain *= (1 + qtd); qtd = 0; segIdx++; }
  };
  const points = [];
  for (const snap of snaps) {
    while (ti < trades.length && trades[ti].closedAt <= snap.takenAt) {
      advanceTo(trades[ti].closedAt);
      const cap = segs[segIdx].startCapitalUsd;
      qtd += cap > 0 ? (trades[ti].pnlUSD || 0) / cap : 0;
      ti++;
    }
    advanceTo(snap.takenAt);
    const cap = segs[segIdx].startCapitalUsd;
    const fl = cap > 0 ? (snap.floatUSD || 0) / cap : 0;
    points.push({ t: snap.takenAt, day: snap.day, index: 100 * chain * (1 + qtd + fl), floatPct: fl * 100, openCount: snap.openCount });
  }
  let peak = 100, mdd = 0;
  for (const p of points) { peak = Math.max(peak, p.index); mdd = Math.max(mdd, (peak - p.index) / peak * 100); }
  return { points, maxDrawdownPct: mdd };
}

// ── QUARTER EQUITY CURVE · realized base across the FULL selected quarter + current float ──
// Index startet bei 100 am Quartalsanfang. Jeder realisierte Close verschiebt die Basis
// dauerhaft (Stufe). Der aktuelle offene Float wird am rechten Rand als Fortsetzung der
// GLEICHEN Kurve obendrauf addiert (kein separater Marker). Ein Kapital-Basiswert je
// Quartal (quarter-start capital). Deterministisch, keine historischen Preisabrufe.
function quarterBounds(selectedQ) {
  const m = /Q(\d)-(\d{4})/.exec(selectedQ || "");
  if (!m) return null;
  const q = parseInt(m[1], 10), year = parseInt(m[2], 10);
  const start = new Date(year, (q - 1) * 3, 1).getTime();
  const end   = new Date(year, q * 3, 1).getTime() - 1;
  return { start, end };
}
function computeQuarterEquityCurve(closedPositions, segments, currentFloatUSD, selectedQ, snapshotDays = {}, nowMs = Date.now()) {
  const segs = [...segments].sort((a, b) => segStartMs(a) - segStartMs(b));
  const qb = quarterBounds(selectedQ);
  const empty = { points: [], index: 100, baseIndex: 100, basePct: 0, floatPct: 0, maxDrawdownPct: 0, totalCloses: 0, activeSeg: null, floatDays: 0 };
  if (segs.length === 0 || !qb) return empty;

  // One capital basis for the whole quarter: the segment active at quarter start,
  // else the earliest configured segment (best available basis).
  let basisSeg = segs[0];
  for (const s of segs) { if (segStartMs(s) <= qb.start) basisSeg = s; }
  const cap = basisSeg.startCapitalUsd;
  if (!cap || cap <= 0) return { ...empty, activeSeg: basisSeg };

  const isCurrentQuarter = nowMs >= qb.start && nowMs <= qb.end;
  const DAY = 24 * 60 * 60 * 1000;
  const dayFloor = (ms) => new Date(new Date(ms).toISOString().slice(0, 10) + "T00:00:00").getTime();
  const startDay = dayFloor(qb.start);
  const endDay   = dayFloor(Math.min(nowMs, qb.end));
  const trades = closedPositions
    .filter(c => c.pnlUSD != null && c.closedAt >= qb.start && c.closedAt <= Math.min(nowMs, qb.end))
    .sort((a, b) => a.closedAt - b.closedAt);

  // ONE point per day = realized base + that day's floating P&L, combined into a single
  // index value. Float per day comes from saved daily snapshots (one per CEST day); the
  // curve therefore moves every day instead of being flat with a single terminal spike.
  const snaps = snapshotDays || {};

  let cum = 0, ti = 0, lastFloatUSD = null, floatDays = 0;
  const points = [];
  for (let dms = startDay; dms <= endDay; dms += DAY) {
    const dayEnd = dms + DAY - 1;
    while (ti < trades.length && trades[ti].closedAt <= dayEnd) { cum += (trades[ti].pnlUSD || 0); ti++; }
    const baseIndex = 100 * (1 + cum / cap);
    const dayStr = cestDateStr(new Date(dms)); // Berlin date — MUSS zu den Snapshot-Keys passen (die via cestDateStr gespeichert werden)
    const isLast = dms + DAY > endDay;

    // Float for this day: live value for today (current quarter); otherwise the snapshot
    // taken that day; on days WITHOUT a snapshot (weekends, bank holidays, app closed)
    // carry the previous day's value forward so the line stays flat-continuous, never 0.
    const snap = snaps[dayStr];
    let floatUSD, hasFloat;
    if (isLast && isCurrentQuarter) {
      floatUSD = currentFloatUSD || 0; hasFloat = true;
    } else if (snap && snap.floatUSD != null) {
      floatUSD = snap.floatUSD; lastFloatUSD = floatUSD; hasFloat = true; floatDays++;
    } else if (lastFloatUSD != null) {
      floatUSD = lastFloatUSD; hasFloat = true; // ← Fallback: Tag davor (WE / Feiertag)
    } else {
      floatUSD = 0; hasFloat = false;           // vor dem allerersten Snapshot: noch kein Float
    }
    const fl = cap > 0 ? floatUSD / cap : 0;
    // index = realized + float for the day → this single value is the plotted point
    points.push({ t: dms, day: dayStr, baseIndex, index: baseIndex + 100 * fl, floatPct: fl * 100, hasFloat });
  }

  // ── Kill the vertical cliff ─────────────────────────────────────────────────
  // Days BEFORE the first snapshot have no float (base only). Plotting them at 0 float
  // and then jumping to the first snapshot's full total = exactly that vertical spike.
  // Fix: drop the leading no-float days. The curve then STARTS at the first real total
  // and every plotted day carries float (snapshot or carried-forward) → continuous line,
  // no terminal cliff. Only trims when a real float series exists (≥2 float days).
  const floatCount = points.filter(p => p.hasFloat).length;
  const firstFloat = points.findIndex(p => p.hasFloat);
  const plotted = (floatCount >= 2 && firstFloat > 0) ? points.slice(firstFloat) : points;

  const baseFinal = plotted.length ? plotted[plotted.length - 1].baseIndex : 100;
  const idxFinal  = plotted.length ? plotted[plotted.length - 1].index : 100;
  const floatPct  = isCurrentQuarter && cap > 0 ? (currentFloatUSD || 0) / cap * 100 : 0;
  // Drawdown measured on the combined daily index, relative to the curve's own start.
  let peak = plotted.length ? plotted[0].index : 100, mdd = 0;
  for (const pt of plotted) { peak = Math.max(peak, pt.index); mdd = Math.max(mdd, (peak - pt.index) / peak * 100); }

  return { points: plotted, index: idxFinal, baseIndex: baseFinal, basePct: baseFinal - 100, floatPct, maxDrawdownPct: mdd, totalCloses: trades.length, activeSeg: basisSeg, floatDays };
}


// ── DONUT SVG helpers ────────────────────────────────────────────────────────
const polarXY = (cx, cy, r, ang) => [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
const donutArc = (cx, cy, rOuter, rInner, a0, a1) => {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polarXY(cx, cy, rOuter, a0), [x1, y1] = polarXY(cx, cy, rOuter, a1);
  const [x2, y2] = polarXY(cx, cy, rInner, a1), [x3, y3] = polarXY(cx, cy, rInner, a0);
  return `M ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${rInner} ${rInner} 0 ${large} 0 ${x3} ${y3} Z`;
};
const PACK_COLORS = { crypto: "#f8e49b", stocks: "#d4af37", indices: "#b99c64", commodities: "#8a7340", etfs: "#5d4f2e" };

// ── FREE CONTENT PANEL ───────────────────────────────────────────────────────
function FreeContentPanel({ allPositions, closedPositions, perfSegments, onSaveSegments, onClose }) {
  useBodyScrollLock();
  const [posting, setPosting] = useState({});
  const [postResult, setPostResult] = useState({});
  const [capitalInput, setCapitalInput] = useState("");
  const [rebaseNote, setRebaseNote] = useState("");

  const flash = (key, ok) => { setPostResult(p => ({ ...p, [key]: ok })); setTimeout(() => setPostResult(p => ({ ...p, [key]: undefined })), 3000); };
  const doPost = async (key, elementId, webhook, title, tag) => {
    setPosting(p => ({ ...p, [key]: true }));
    const res = await postFreeContentScreenshot(elementId, webhook, title, tag);
    setPosting(p => ({ ...p, [key]: false }));
    flash(key, res.ok);
  };

  // Asset allocation (open positions, counts only — no sizes)
  const alloc = TABS.map(t => ({ tab: t, count: (allPositions[t.id] || []).length })).filter(a => a.count > 0);
  const totalOpen = alloc.reduce((s, a) => s + a.count, 0);

  // Performance curve
  const curve = computePerformanceCurve(closedPositions, perfSegments);
  const hasCurve = perfSegments.length > 0;

  // Chart geometry
  const CW = 760, CH = 300, PAD = { l: 56, r: 18, t: 18, b: 34 };
  let chart = null;
  if (hasCurve) {
    const t0 = Math.min(...perfSegments.map(segStartMs));
    const t1 = Math.max(Date.now(), ...(curve.points.length ? [curve.points[curve.points.length - 1].t] : []));
    const span = Math.max(t1 - t0, 1);
    const idxVals = [100, ...curve.points.map(p => p.index)];
    const yMin = Math.min(...idxVals), yMax = Math.max(...idxVals);
    const yPad = Math.max((yMax - yMin) * 0.15, 1.5);
    const y0 = yMin - yPad, y1 = yMax + yPad;
    const X = (t) => PAD.l + ((t - t0) / span) * (CW - PAD.l - PAD.r);
    const Y = (v) => CH - PAD.b - ((v - y0) / (y1 - y0)) * (CH - PAD.t - PAD.b);
    let d = `M ${X(t0)} ${Y(100)}`;
    let prevIdx = 100;
    for (const p of curve.points) { d += ` L ${X(p.t)} ${Y(prevIdx)} L ${X(p.t)} ${Y(p.index)}`; prevIdx = p.index; }
    d += ` L ${X(t1)} ${Y(prevIdx)}`;
    const gridVals = [y0, (y0 + y1) / 2, y1].map(v => Math.round(v * 10) / 10);
    chart = { d, X, Y, t0, t1, gridVals, lastIdx: prevIdx };
  }

  const greenRed = (v) => v > 0.005 ? "#22c55e" : v < -0.005 ? "#ef4444" : "#d4af37";
  const inputStyle = { background: "#0d0d0d", border: "1px solid #2a2a2a", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "9px 12px", borderRadius: 8, outline: "none", width: "100%" };
  const postBtn = (key, onClick) => (
    <button className="free-no-capture" onClick={onClick} disabled={posting[key]}
      style={{ background: postResult[key] === true ? "rgba(34,197,94,0.15)" : postResult[key] === false ? "rgba(239,68,68,0.15)" : "rgba(88,101,242,0.12)", border: "1px solid " + (postResult[key] === true ? "rgba(34,197,94,0.5)" : postResult[key] === false ? "rgba(239,68,68,0.5)" : "rgba(88,101,242,0.4)"), color: postResult[key] === true ? "#22c55e" : postResult[key] === false ? "#ef4444" : "#8b96f8", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", padding: "9px 18px", borderRadius: 8, cursor: posting[key] ? "wait" : "pointer", textTransform: "uppercase", transition: "all 0.3s cubic-bezier(0.22, 1, 0.36, 1)" }}>
      {posting[key] ? "POSTING…" : postResult[key] === true ? "✓ POSTED" : postResult[key] === false ? "✕ FAILED" : "🎮 POST TO DISCORD"}
    </button>
  );
  const sectionCard = { background: "#111", border: "1px solid #222", borderRadius: 16, padding: "26px 28px", marginBottom: 24 };

  // ── Admin: quarter / rebase actions ──
  const activeSeg = [...perfSegments].sort((a, b) => segStartMs(a) - segStartMs(b)).slice(-1)[0] || null;
  const today = () => new Date().toISOString().split("T")[0];
  const quarterIdFor = (dateStr) => { const d = new Date(dateStr); return `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`; };
  const startSegment = (rebase) => {
    const cap = parseFloat(capitalInput);
    if (!cap || cap <= 0) { window.alert("Enter a valid quarter-start capital (USD)."); return; }
    if (rebase && !rebaseNote.trim()) { window.alert("A rebase requires a note (reason)."); return; }
    const baseId = quarterIdFor(today());
    const siblings = perfSegments.filter(s => s.id === baseId || s.id.startsWith(baseId));
    const id = siblings.length === 0 ? baseId : baseId + String.fromCharCode(97 + siblings.length); // 2026-Q3, 2026-Q3b, …
    const next = perfSegments.map(s => s.status === "active" ? { ...s, status: "closed", finalReturnPct: curve.qtdPct } : s);
    next.push({ id, startDate: today(), startCapitalUsd: cap, status: "active", finalReturnPct: null, rebaseNote: rebase ? rebaseNote.trim() : null });
    onSaveSegments(next);
    setCapitalInput(""); setRebaseNote("");
  };

  return createPortal(
    <div className="report-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 9998, backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }} onClick={onClose}>
      <div className="report-panel" onClick={e => e.stopPropagation()}
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 920, maxWidth: "96vw", background: "#0d0d0d", borderLeft: "1px solid #2a2a2a", overflowY: "auto", fontFamily: "'Montserrat', sans-serif", color: "#e8e8e8" }}>

        {/* Sticky header */}
        <div style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(13,13,13,0.85)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderBottom: "1px solid #222", padding: "22px 32px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.3em", color: "#8a8a8a", textTransform: "uppercase", marginBottom: 5 }}>VISIONX ANALYTICS · PUBLIC ASSETS</div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, letterSpacing: "0.12em", color: "#d4af37" }}>FREE CONTENT</div>
          </div>
          <button onClick={onClose}
            onMouseEnter={e => { e.currentTarget.style.color = "#d4af37"; e.currentTarget.style.transform = "rotate(90deg)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "#555"; e.currentTarget.style.transform = "none"; }}
            style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 20, padding: "4px 8px", borderRadius: 8, transition: "all 0.35s cubic-bezier(0.22, 1, 0.36, 1)" }}>✕</button>
        </div>

        <div style={{ padding: "28px 32px 40px" }}>

          {/* ── ASSET ALLOCATION ── */}
          <div style={sectionCard}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.28em", color: "#8a8a8a", textTransform: "uppercase" }}>ASSET CLASS ALLOCATION · ╠🧮-aggregated-stats</div>
              {postBtn("alloc", () => doPost("alloc", "free-allocation-capture", FREE_CONTENT_WEBHOOKS.aggregatedStats, "ASSET CLASS ALLOCATION", "allocation"))}
            </div>
            <div id="free-allocation-capture" style={{ background: "#0d0d0d", borderRadius: 12, padding: "26px 28px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
                <VSXLogo size={30} />
                <div>
                  <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, letterSpacing: "0.18em", color: "#d4af37" }}>VISIONX · ASSET ALLOCATION</div>
                  <div style={{ fontSize: 8, letterSpacing: "0.24em", color: "#8a8a8a" }}>OPEN POSITIONS BY ASSET CLASS · {new Date().toLocaleDateString("en-GB")}</div>
                </div>
              </div>
              {totalOpen === 0 ? (
                <div style={{ textAlign: "center", padding: 48, color: "#555", fontSize: 10, letterSpacing: "0.24em" }}>NO OPEN POSITIONS</div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 36, flexWrap: "wrap" }}>
                  <svg width="220" height="220" viewBox="0 0 220 220">
                    {(() => {
                      let ang = -Math.PI / 2;
                      return alloc.map(({ tab, count }) => {
                        const frac = count / totalOpen;
                        const a0 = ang, a1 = ang + frac * Math.PI * 2 - 0.012;
                        ang += frac * Math.PI * 2;
                        return <path key={tab.id} d={donutArc(110, 110, 96, 58, a0, Math.max(a1, a0 + 0.002))} fill={PACK_COLORS[tab.id]} opacity="0.92" />;
                      });
                    })()}
                    <text x="110" y="104" textAnchor="middle" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 30, fill: "#fdfdfd" }}>{totalOpen}</text>
                    <text x="110" y="124" textAnchor="middle" style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.25em", fill: "#8a8a8a" }}>OPEN POSITIONS</text>
                  </svg>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    {alloc.map(({ tab, count }) => (
                      <div key={tab.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: "1px solid #1a1a1a" }}>
                        <div style={{ width: 11, height: 11, borderRadius: 3, background: PACK_COLORS[tab.id] }} />
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", color: "#e8e8e8", flex: 1 }}>{tab.label.toUpperCase()}</div>
                        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#8a8a8a" }}>{count} pos</div>
                        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 17, color: "#d4af37", width: 56, textAlign: "right" }}>{((count / totalOpen) * 100).toFixed(1)}%</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ marginTop: 16, fontSize: 7.5, lineHeight: 1.5, color: "#555", letterSpacing: "0.04em" }}>Distribution by position count. No position sizes, price levels or USD values are displayed.</div>
            </div>
          </div>

          {/* ── EQUITY CURVE ── */}
          <div style={sectionCard}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.28em", color: "#8a8a8a", textTransform: "uppercase" }}>EQUITY CURVE · ╠📈-equity-curve</div>
              {postBtn("curve", () => doPost("curve", "free-equity-capture", FREE_CONTENT_WEBHOOKS.equityCurve, "EQUITY CURVE — REALIZED INDEX", "equity-curve"))}
            </div>
            <div id="free-equity-capture" style={{ background: "#0d0d0d", borderRadius: 12, padding: "26px 28px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <VSXLogo size={30} />
                  <div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, letterSpacing: "0.18em", color: "#d4af37" }}>VISIONX · REALIZED PERFORMANCE INDEX</div>
                    <div style={{ fontSize: 8, letterSpacing: "0.24em", color: "#8a8a8a" }}>BASE 100 · REALIZED TRADES ONLY · {new Date().toLocaleDateString("en-GB")}</div>
                  </div>
                </div>
                {hasCurve && (
                  <div style={{ display: "flex", gap: 22 }}>
                    {[
                      ["INDEX", curve.index.toFixed(2), curve.index >= 100 ? "#22c55e" : "#ef4444"],
                      ["QTD", fmtSignedPct(curve.qtdPct), greenRed(curve.qtdPct)],
                      ["MAX DD", "-" + curve.maxDrawdownPct.toFixed(2) + "%", "#ef4444"],
                      ["CLOSES", String(curve.totalCloses), "#d4af37"],
                    ].map(([l, v, c]) => (
                      <div key={l} style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#666" }}>{l}</div>
                        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 19, color: c }}>{v}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {!hasCurve ? (
                <div style={{ textAlign: "center", padding: "52px 20px", color: "#555", fontSize: 10, letterSpacing: "0.2em", lineHeight: 2 }}>
                  NO QUARTER CONFIGURED YET<br />
                  <span style={{ fontSize: 9, color: "#444" }}>SET THE QUARTER-START CAPITAL IN THE ADMIN SECTION BELOW</span>
                </div>
              ) : (
                <svg width="100%" viewBox={`0 0 ${CW} ${CH}`} style={{ display: "block" }}>
                  {chart.gridVals.map((v, i) => (
                    <g key={i}>
                      <line x1={PAD.l} x2={CW - PAD.r} y1={chart.Y(v)} y2={chart.Y(v)} stroke="#1d1d1d" strokeWidth="1" />
                      <text x={PAD.l - 8} y={chart.Y(v) + 3} textAnchor="end" style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, fill: "#666" }}>{v.toFixed(1)}</text>
                    </g>
                  ))}
                  <line x1={PAD.l} x2={CW - PAD.r} y1={chart.Y(100)} y2={chart.Y(100)} stroke="rgba(212,175,55,0.25)" strokeWidth="1" strokeDasharray="4 4" />
                  <path d={chart.d + ` L ${chart.X(chart.t1)} ${CH - PAD.b} L ${PAD.l} ${CH - PAD.b} Z`} fill="rgba(212,175,55,0.06)" stroke="none" />
                  <path d={chart.d} fill="none" stroke="#d4af37" strokeWidth="2" strokeLinejoin="round" />
                  {curve.points.map((p, i) => (
                    <circle key={i} cx={chart.X(p.t)} cy={chart.Y(p.index)} r="3.2" fill="#0d0d0d" stroke={greenRed(p.deltaPct)} strokeWidth="2">
                      <title>{`${p.date} · ${p.ticker} · ${fmtSignedPct(p.deltaPct)} book impact · Index ${p.index.toFixed(2)}`}</title>
                    </circle>
                  ))}
                  {curve.points.length === 0 && (
                    <text x={CW / 2} y={CH / 2 - 6} textAnchor="middle" style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 11, letterSpacing: "0.24em", fill: "#555" }}>LIVE SINCE {new Date(segStartMs([...perfSegments].sort((a, b) => segStartMs(a) - segStartMs(b))[0])).toLocaleDateString("en-GB")} — INDEX 100.00</text>
                  )}
                  <text x={CW - PAD.r} y={PAD.t + 4} textAnchor="end" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 16, fill: chart.lastIdx >= 100 ? "#22c55e" : "#ef4444" }}>{chart.lastIdx.toFixed(2)}</text>
                  <line x1={PAD.l} x2={CW - PAD.r} y1={CH - PAD.b} y2={CH - PAD.b} stroke="#2a2a2a" strokeWidth="1" />
                  <text x={PAD.l} y={CH - 12} style={{ fontFamily: "'DM Mono', monospace", fontSize: 8.5, fill: "#555" }}>{new Date(chart.t0).toLocaleDateString("en-GB")}</text>
                  <text x={CW - PAD.r} y={CH - 12} textAnchor="end" style={{ fontFamily: "'DM Mono', monospace", fontSize: 8.5, fill: "#555" }}>{new Date(chart.t1).toLocaleDateString("en-GB")}</text>
                </svg>
              )}

              <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #1a1a1a", fontSize: 7.5, lineHeight: 1.6, color: "#555", letterSpacing: "0.04em" }}>{METHODOLOGY_NOTE}</div>
            </div>
          </div>

          {/* ── ADMIN: QUARTER MANAGEMENT (never part of any capture) ── */}
          <div className="free-no-capture" style={{ ...sectionCard, border: "1px solid rgba(212,175,55,0.18)", marginBottom: 0 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.28em", color: "#b99c64", textTransform: "uppercase", marginBottom: 6 }}>QUARTER MANAGEMENT · INTERNAL</div>
            <div style={{ fontSize: 9, color: "#666", lineHeight: 1.6, marginBottom: 18 }}>Quarter-start capital stays internal — it is stored privately and never appears on any public asset. Rebase only if mid-quarter capital injection exceeds ~20–25% of quarter-start capital.</div>
            {perfSegments.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                {[...perfSegments].sort((a, b) => segStartMs(b) - segStartMs(a)).map(s => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 0", borderBottom: "1px solid #1a1a1a", fontSize: 10 }}>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 15, color: "#d4af37", width: 86 }}>{s.id.toUpperCase()}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", color: "#666", width: 90 }}>{s.startDate}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", color: "#8a8a8a", flex: 1 }}>${Number(s.startCapitalUsd).toLocaleString("en-US")}</div>
                    {s.rebaseNote && <div style={{ fontSize: 8, color: "#b99c64", fontStyle: "italic", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.rebaseNote}</div>}
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", padding: "3px 9px", borderRadius: 4, background: s.status === "active" ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.04)", color: s.status === "active" ? "#22c55e" : "#666" }}>{s.status.toUpperCase()}</div>
                    {s.status === "closed" && s.finalReturnPct != null && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: greenRed(s.finalReturnPct), width: 64, textAlign: "right" }}>{fmtSignedPct(s.finalReturnPct)}</div>}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 180px" }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.2em", color: "#666", marginBottom: 6 }}>QUARTER-START CAPITAL (USD)</div>
                <input type="number" value={capitalInput} onChange={e => setCapitalInput(e.target.value)} placeholder="e.g. 250000" style={inputStyle} />
              </div>
              <div style={{ flex: "1 1 220px" }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.2em", color: "#666", marginBottom: 6 }}>REBASE NOTE (ONLY FOR REBASE)</div>
                <input value={rebaseNote} onChange={e => setRebaseNote(e.target.value)} placeholder="Reason for intra-quarter rebase" style={inputStyle} />
              </div>
              <button onClick={() => startSegment(false)}
                style={{ background: "linear-gradient(135deg, #d4af37, #c59958)", border: "none", color: "#0a0a0a", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", padding: "11px 18px", borderRadius: 8, cursor: "pointer", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                {activeSeg ? "▸ NEW QUARTER" : "▸ START FIRST QUARTER"}
              </button>
              {activeSeg && (
                <button onClick={() => startSegment(true)}
                  style={{ background: "rgba(212,175,55,0.08)", border: "1px solid rgba(212,175,55,0.3)", color: "#b99c64", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", padding: "11px 18px", borderRadius: 8, cursor: "pointer", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                  ⟳ INTRA-QUARTER REBASE
                </button>
              )}
            </div>
            <div style={{ marginTop: 16, fontSize: 9, color: "#555", lineHeight: 1.6 }}>Auto-post on full close is active: every position closed without remainder is posted to ╔📊-track-record (ticker, asset class, direction, holding days, return %, book impact % — no USD, no sizes, no price levels). Partial closes are not posted.</div>
          </div>

        </div>
      </div>
    </div>
  , document.body);
}

// ── QUARTERLY REPORT PANEL ────────────────────────────────────────────────────
function QuarterlyReportPanel({ closedPositions, allPositions, perfSegments, equitySnapshots, onClose }) {
  useBodyScrollLock();
  const [selectedQ, setSelectedQ] = useState(getQuarter(new Date()));

  const quarters = sortedQuarters(closedPositions.map(c => c.quarter));
  const qData = closedPositions.filter(c => c.quarter === selectedQ);

  const packData = TABS.map(t => {
    const pClosed = qData.filter(c => c.tabId === t.id);
    const pOpen   = (allPositions[t.id] || []).filter(p => p.ticker.trim());
    const pPnL    = pClosed.reduce((s, c) => s + (c.pnlUSD || 0), 0);
    const pWins   = pClosed.filter(isWin).length;
    return { tab: t, closed: pClosed, open: pOpen, pnl: pPnL, wins: pWins };
  }).filter(p => p.closed.length > 0 || p.open.length > 0);

  const totalTrades = qData.length;
  const winners     = qData.filter(isWin);
  const losers      = qData.filter(isLoss);
  const scratches   = qData.filter(isBE);
  const decided     = winners.length + losers.length;
  const winRate     = decided > 0 ? (winners.length / decided) * 100 : null;
  const totalPnL    = qData.reduce((s, c) => s + (c.pnlUSD || 0), 0);
  const avgPnLPct   = totalTrades > 0 ? qData.reduce((s, c) => s + (c.pnlPct || 0), 0) / totalTrades : null;

  // ── Adjusted trade average · excludes break-even / scratch trades ──────────
  // Any closed trade whose realised return sits within ±5% is treated as flat
  // (noise / break-even) and removed, so the average reflects only trades that
  // resolved with a meaningful directional outcome. Threshold is one constant.
  const BE_PCT_THRESHOLD  = 5;
  const significantTrades = qData.filter(c => Math.abs(c.pnlPct || 0) > BE_PCT_THRESHOLD);
  const beTradesCount     = totalTrades - significantTrades.length;
  const avgPnLPctExBE     = significantTrades.length > 0 ? significantTrades.reduce((s, c) => s + (c.pnlPct || 0), 0) / significantTrades.length : null;
  const avgHold     = totalTrades > 0 ? Math.round(qData.reduce((s, c) => s + (c.daysHeld || 0), 0) / totalTrades) : null;

  // ── Win/Loss-Ratio (Ø Gewinn ÷ Ø Verlust) und Ø Stop-Distanz der offenen Positionen ──
  const pAvgWinPct  = winners.length > 0 ? winners.reduce((s, c) => s + (c.pnlPct || 0), 0) / winners.length : null;
  const pAvgLossPct = losers.length  > 0 ? Math.abs(losers.reduce((s, c) => s + (c.pnlPct || 0), 0) / losers.length) : null;
  const pProfitFactor = pAvgWinPct && pAvgLossPct ? (pAvgWinPct / pAvgLossPct) : null;
  const bestTrade   = totalTrades > 0 ? qData.reduce((a, b) => (a.pnlPct || 0) > (b.pnlPct || 0) ? a : b) : null;
  const worstTrade  = totalTrades > 0 ? qData.reduce((a, b) => (a.pnlPct || 0) < (b.pnlPct || 0) ? a : b) : null;
  const longTrades  = qData.filter(c => c.direction === "LONG");
  const shortTrades = qData.filter(c => c.direction === "SHORT");
  const longPnL     = longTrades.reduce((s, c) => s + (c.pnlUSD || 0), 0);
  const shortPnL    = shortTrades.reduce((s, c) => s + (c.pnlUSD || 0), 0);
  const allOpen     = TABS.flatMap(t => (allPositions[t.id] || []).filter(p => p.ticker.trim()).map(p => ({ ...p, tabLabel: t.label })));

  // Floating PnL calculations
  const calcFloatUSD = (p) => {
    const ep = num(p.entry); const q = num(p.qty);
    if (!p.currentPrice || !ep || !q || isNaN(ep) || isNaN(q)) return null;
    return p.direction === "LONG" ? (p.currentPrice - ep) * q : (ep - p.currentPrice) * q;
  };
  const totalFloatUSD = allOpen.reduce((s, p) => s + (calcFloatUSD(p) || 0), 0);
  const floatByPack = TABS.map(t => {
    const positions = allOpen.filter(p => p.tabLabel === t.label);
    const pnl = positions.reduce((s, p) => s + (calcFloatUSD(p) || 0), 0);
    const winners = positions.filter(p => (calcFloatUSD(p) || 0) > 0).length;
    return { tab: t, positions, pnl, winners };
  }).filter(p => p.positions.length > 0);
  const hasFloatData = allOpen.some(p => p.currentPrice);
  const slDists = allOpen.map(p => calcSLDist(p.direction, p.currentPrice, parseFloat(p.sl))).filter(v => v != null && !isNaN(v));
  const pAvgSLDist = slDists.length ? slDists.reduce((a, b) => a + b, 0) / slDists.length : null;

  const qList   = getQuarterOptions();
  const qIdx    = qList.indexOf(selectedQ);
  const prevQ   = qIdx < qList.length - 1 ? qList[qIdx + 1] : null;
  const prevQPnL = prevQ ? closedPositions.filter(c => c.quarter === prevQ).reduce((s, c) => s + (c.pnlUSD || 0), 0) : null;
  const qoqChange = prevQPnL !== null && closedPositions.some(c => c.quarter === prevQ) ? totalPnL - prevQPnL : null;

  const today  = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const qLabel = getQuarterLabel(selectedQ);

  const S = {
    overlay:      { position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 9998, display: "flex", justifyContent: "flex-end", backdropFilter: "blur(6px)" },
    panel:        { width: 780, maxWidth: "96vw", height: "100vh", overflowY: "auto", background: "#0d0d0d", borderLeft: "1px solid #222", display: "flex", flexDirection: "column" },
    stickyHdr:    { padding: "24px 32px 18px", borderBottom: "1px solid #1a1a1a", background: "rgba(10,10,10,0.85)", backdropFilter: "blur(20px)", position: "sticky", top: 0, zIndex: 10 },
    section:      { padding: "22px 32px", borderBottom: "1px solid #111" },
    sectionTitle: { fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.28em", color: "#555", textTransform: "uppercase", marginBottom: 14 },
    statCard:     { background: "#111", border: "1px solid #1a1a1a", borderRadius: 10, padding: "12px 14px", transition: `all 0.3s ${EASE}` },
    statLabel:    { fontFamily: "'Montserrat', sans-serif", fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#444", textTransform: "uppercase", marginBottom: 5 },
    statVal:      { fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, letterSpacing: "0.04em", lineHeight: 1 },
    statSub:      { fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555", marginTop: 3 },
  };

  const generatePDF = () => {
    const win = window.open("", "_blank");
    const gc  = (v) => v >= 0 ? "#22c55e" : "#ef4444";
    const fu  = (v) => { if (v == null) return "—"; const a = Math.abs(v); return (v >= 0 ? "+" : "-") + "$" + a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    const fp  = (p) => { if (p == null) return "—"; if (p < 0.01) return p.toFixed(6); if (p < 1) return p.toFixed(4); if (p < 100) return p.toFixed(3); return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    const GOLD = "#d4af37"; const GOLD2 = "#f8e49b"; const GOLD3 = "#b99c64";
    const BG1 = "#080808"; const BG2 = "#0f0f0f"; const BG3 = "#141414";
    const BORDER = "#1e1e1e"; const BORDER2 = "#2a2a2a";
    const TEXT = "#e8e8e8"; const MUTE = "#555"; const DIM = "#333";
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const qLabel = getQuarterLabel(selectedQ);

    // ── Calculations ──────────────────────────────────────────────────────────
    const calcFloatUSD = (p) => {
      const ep = num(p.entry); const q = num(p.qty);
      if (!p.currentPrice || !ep || !q || isNaN(ep) || isNaN(q)) return null;
      return p.direction === "LONG" ? (p.currentPrice - ep) * q : (ep - p.currentPrice) * q;
    };
    const allOpenFull = TABS.flatMap(t => (allPositions[t.id] || []).filter(p => p.ticker.trim()).map(p => ({ ...p, tabId: t.id, tabLabel: t.label })));
    const totalFloatUSD = allOpenFull.reduce((s, p) => s + (calcFloatUSD(p) || 0), 0);
    const totalPortfolioValue = allOpenFull.reduce((s, p) => {
      const ep = num(p.entry); const q = num(p.qty);
      if (!ep || !q || isNaN(ep) || isNaN(q)) return s;
      return s + (p.currentPrice ? p.currentPrice * q : ep * q);
    }, 0);
    const longPositions = allOpenFull.filter(p => p.direction === "LONG");
    const shortPositions = allOpenFull.filter(p => p.direction === "SHORT");
    const longPct = allOpenFull.length > 0 ? ((longPositions.length / allOpenFull.length) * 100).toFixed(0) : 0;
    const shortPct = allOpenFull.length > 0 ? ((shortPositions.length / allOpenFull.length) * 100).toFixed(0) : 0;
    const avgSLDist = allOpenFull.filter(p => p.sl && p.currentPrice).map(p => {
      const sl = parseFloat(p.sl); const cur = p.currentPrice;
      return p.direction === "LONG" ? ((cur - sl) / cur) * 100 : ((sl - cur) / cur) * 100;
    }).filter(v => !isNaN(v) && v > 0).reduce((s, v, _, a) => s + v / a.length, 0);
    const closedWinners = qData.filter(isWin);
    const closedLosers  = qData.filter(isLoss);
    const avgWinPct  = closedWinners.length > 0 ? closedWinners.reduce((s, c) => s + (c.pnlPct || 0), 0) / closedWinners.length : null;
    const avgLossPct = closedLosers.length  > 0 ? Math.abs(closedLosers.reduce((s, c) => s + (c.pnlPct || 0), 0) / closedLosers.length) : null;
    const profitFactor = avgWinPct && avgLossPct ? (avgWinPct / avgLossPct).toFixed(2) : null;
    const winRate = (winners.length + losers.length) > 0 ? (winners.length / (winners.length + losers.length)) * 100 : null;
    const avgHold = totalTrades > 0 ? Math.round(qData.reduce((s, c) => s + (c.daysHeld || 0), 0) / totalTrades) : null;
    const bestTrade  = totalTrades > 0 ? qData.reduce((a, b) => (a.pnlPct || 0) > (b.pnlPct || 0) ? a : b) : null;
    const worstTrade = totalTrades > 0 ? qData.reduce((a, b) => (a.pnlPct || 0) < (b.pnlPct || 0) ? a : b) : null;

    // Pack breakdown — both open and closed
    const packStats = TABS.map(t => {
      const closed = qData.filter(c => c.tabId === t.id);
      const open   = allOpenFull.filter(p => p.tabId === t.id);
      const realPnL = closed.reduce((s, c) => s + (c.pnlUSD || 0), 0);
      const floatPnL = open.reduce((s, p) => s + (calcFloatUSD(p) || 0), 0);
      const wins = closed.filter(isWin).length;
      const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(0) + "%" : "—";
      return { tab: t, closed, open, realPnL, floatPnL, wins, wr };
    });

    const thStyle = `padding:10px 12px;font-family:'Montserrat',sans-serif;font-size:7px;letter-spacing:0.2em;color:${MUTE};text-align:left;font-weight:700;white-space:nowrap`;
    const goldBar = `<div style="height:4px;background:linear-gradient(90deg,${GOLD3},${GOLD},${GOLD2},${GOLD})"></div>`;
    let pdfPageNo = 0;
    const footer = () => { pdfPageNo += 1; return `<div style="page-break-inside:avoid;padding:14px 56px;border-top:1px solid ${BORDER};display:flex;justify-content:space-between;align-items:center"><div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM};letter-spacing:0.1em">VISIONX MARKET ANALYTICS · QUARTERLY PERFORMANCE MEMORANDUM · ${qLabel} · CONFIDENTIAL</div><div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM}">${pdfPageNo}</div></div>`; };
    const sectionHdr = (title) => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px"><div style="width:3px;height:16px;background:${GOLD3};border-radius:2px"></div><div style="font-size:8px;font-weight:700;letter-spacing:0.3em;color:${MUTE};text-transform:uppercase">${title}</div></div>`;
    const statCard = (label, val, sub, color) => `<div style="background:${BG2};border:1px solid ${BORDER};border-radius:10px;padding:16px 18px"><div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:8px">${label}</div><div style="font-family:'Bebas Neue',sans-serif;font-size:28px;color:${color || GOLD};line-height:1">${val}</div>${sub ? `<div style="font-family:'DM Mono',monospace;font-size:9px;color:${MUTE};margin-top:4px">${sub}</div>` : ""}</div>`;

    // ── PAGE 1: COVER ─────────────────────────────────────────────────────────
    const coverPage = `
    <div style="min-height:100vh;background:${BG1};display:flex;flex-direction:column;position:relative;overflow:hidden">
      ${goldBar}
      <div style="position:absolute;top:0;right:0;width:400px;height:400px;background:radial-gradient(circle,rgba(212,175,55,0.04) 0%,transparent 70%);pointer-events:none"></div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-between;padding:64px 72px">
        <div style="display:flex;align-items:center;gap:20px">
          <img src="https://i.postimg.cc/pd4xzT1r/87011e66-b8e4-4d2b-9977-a06bb4b29902.png" width="60" height="60" style="object-fit:contain;filter:drop-shadow(0 0 16px rgba(212,175,55,0.4))">
          <div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:0.3em;color:#fff">VISIONX</div>
            <div style="font-size:8px;letter-spacing:0.4em;color:${GOLD3};text-transform:uppercase">Market Analytics</div>
          </div>
        </div>
        <div>
          <div style="font-size:9px;font-weight:700;letter-spacing:0.4em;color:${GOLD3};text-transform:uppercase;margin-bottom:20px">Quarterly Performance Memorandum</div>
          <div style="font-family:'Bebas Neue',sans-serif;font-size:80px;letter-spacing:0.06em;color:${GOLD2};line-height:0.9;margin-bottom:16px">${qLabel.split(" ")[0]}<br><span style="font-size:56px;color:${GOLD3}">${qLabel.split(" ")[1] || ""}</span></div>
          <div style="width:80px;height:3px;background:linear-gradient(90deg,${GOLD},transparent);margin-bottom:24px"></div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:${MUTE}">Generated ${today}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:32px">
          ${statCard("Realised P&L", fu(totalPnL), qLabel, gc(totalPnL))}
          ${statCard("Floating P&L", fu(totalFloatUSD), "Unrealised", gc(totalFloatUSD))}
          ${statCard("Active Positions", String(allOpenFull.length), "across all packs", GOLD)}
        </div>
        <div style="border-top:1px solid ${BORDER};padding-top:20px">
          <div style="font-family:'DM Mono',monospace;font-size:9px;color:${DIM};line-height:1.8">
            This report is prepared exclusively for internal use by VisionX Market Analytics. All trading activity represents proprietary capital only. Past performance does not guarantee future results. This document does not constitute investment advice.
          </div>
        </div>
      </div>
      ${footer()}
      ${goldBar}
    </div>`;

    // ── PAGE 2: PERFORMANCE OVERVIEW ─────────────────────────────────────────
    const overviewPage = `
    <div style="page-break-before:always;min-height:100vh;background:${BG1};display:flex;flex-direction:column">
      ${goldBar}
      <div style="padding:44px 56px;flex:1;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid ${BORDER};padding-bottom:22px;margin-bottom:32px">
          <div>
            <div style="font-size:7px;font-weight:700;letter-spacing:0.3em;color:${MUTE};text-transform:uppercase;margin-bottom:8px">VISIONX MARKET ANALYTICS · ${qLabel}</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:0.14em;color:${GOLD2}">PERFORMANCE OVERVIEW</div>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${today}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px">
          <div style="background:${BG2};border:1px solid ${totalPnL >= 0 ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"};border-left:4px solid ${gc(totalPnL)};border-radius:12px;padding:24px 28px">
            <div style="font-size:8px;font-weight:700;letter-spacing:0.26em;color:${MUTE};text-transform:uppercase;margin-bottom:10px">Realised P&L · ${qLabel}</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:52px;color:${gc(totalPnL)};line-height:1">${fu(totalPnL)}</div>
            ${avgPnLPct !== null ? `<div style="font-family:'DM Mono',monospace;font-size:11px;color:${gc(avgPnLPct)};margin-top:6px">Avg ${avgPnLPct >= 0 ? "+" : ""}${avgPnLPct.toFixed(2)}% per trade</div>` : ""}
          </div>
          <div style="background:${BG2};border:1px solid ${totalFloatUSD >= 0 ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)"};border-left:4px solid ${gc(totalFloatUSD)};border-radius:12px;padding:24px 28px">
            <div style="font-size:8px;font-weight:700;letter-spacing:0.26em;color:${MUTE};text-transform:uppercase;margin-bottom:10px">Floating P&L · Open Positions</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:52px;color:${gc(totalFloatUSD)};line-height:1">${fu(totalFloatUSD)}</div>
            <div style="font-family:'DM Mono',monospace;font-size:11px;color:${MUTE};margin-top:6px">${allOpenFull.filter(p => p.currentPrice).length} positions with live price</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px">
          ${statCard("Win Rate", winRate != null ? winRate.toFixed(0) + "%" : "—", `${winners.length}W / ${totalTrades - winners.length}L`, winRate != null ? (winRate >= 50 ? "#22c55e" : "#ef4444") : MUTE)}
          ${statCard("Win/Loss Ratio", profitFactor || "—", avgWinPct && avgLossPct ? `+${avgWinPct.toFixed(1)}% avg win · -${avgLossPct.toFixed(1)}% avg loss` : "—", profitFactor >= 1 ? "#22c55e" : "#ef4444")}
          ${statCard("Avg Hold Time", avgHold != null ? avgHold + "D" : "—", "per closed trade", GOLD)}
          ${statCard("Avg SL Distance", avgSLDist > 0 ? avgSLDist.toFixed(1) + "%" : "—", "open positions", GOLD3)}
        </div>

        <div style="margin-bottom:28px">
          ${sectionHdr("Adjusted Trade Average — Excluding Break-Even Trades")}
          <div style="display:grid;grid-template-columns:200px 1fr;gap:16px">
            <div style="background:${BG2};border:1px solid ${avgPnLPctExBE === null ? BORDER : avgPnLPctExBE >= 0 ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'};border-left:4px solid ${avgPnLPctExBE === null ? MUTE : gc(avgPnLPctExBE)};border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;justify-content:center">
              <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:8px">Avg per Trade · Ex BE</div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:42px;line-height:1;color:${avgPnLPctExBE === null ? MUTE : gc(avgPnLPctExBE)}">${avgPnLPctExBE !== null ? (avgPnLPctExBE >= 0 ? "+" : "") + avgPnLPctExBE.toFixed(2) + "%" : "—"}</div>
              <div style="font-family:'DM Mono',monospace;font-size:9px;color:${MUTE};margin-top:6px">${significantTrades.length} of ${totalTrades} trades counted</div>
            </div>
            <div style="background:${BG2};border:1px solid ${BORDER};border-radius:12px;padding:18px 22px;display:flex;flex-direction:column;justify-content:center">
              <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${GOLD3};text-transform:uppercase;margin-bottom:8px">Methodology</div>
              <div style="font-family:'DM Mono',monospace;font-size:9.5px;color:#888;line-height:1.75">The headline figure <span style="color:#bbb">Avg ${avgPnLPct !== null ? (avgPnLPct >= 0 ? "+" : "") + avgPnLPct.toFixed(2) + "%" : "—"} per trade</span> counts every closed position. This adjusted average removes <span style="color:${GOLD}">break-even trades</span> — any trade closed within <span style="color:${GOLD}">±${BE_PCT_THRESHOLD}%</span> of entry — so near-flat scratches do not dilute it, isolating the average outcome of trades that resolved with genuine directional conviction.${beTradesCount > 0 ? ` ${beTradesCount} trade${beTradesCount !== 1 ? "s" : ""} excluded for ${qLabel}.` : (totalTrades > 0 ? " No break-even trades were excluded this quarter." : "")}</div>
            </div>
          </div>
        </div>

        <div style="margin-bottom:28px">
          ${sectionHdr("Portfolio Composition — Open Positions")}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
            <div style="background:${BG2};border:1px solid ${BORDER};border-radius:10px;padding:18px 20px">
              <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:12px">Direction Split</div>
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                <div style="flex:${longPct};height:6px;background:#22c55e;border-radius:3px"></div>
                <div style="flex:${shortPct};height:6px;background:#ef4444;border-radius:3px"></div>
              </div>
              <div style="display:flex;justify-content:space-between">
                <div style="font-family:'DM Mono',monospace;font-size:10px;color:#22c55e">LONG ${longPct}%</div>
                <div style="font-family:'DM Mono',monospace;font-size:10px;color:#ef4444">SHORT ${shortPct}%</div>
              </div>
            </div>
            <div style="background:${BG2};border:1px solid ${BORDER};border-radius:10px;padding:18px 20px">
              <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:12px">Total Portfolio Value</div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:24px;color:${GOLD};line-height:1">${totalPortfolioValue > 0 ? "$" + totalPortfolioValue.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—"}</div>
              <div style="font-family:'DM Mono',monospace;font-size:9px;color:${MUTE};margin-top:4px">Proprietary capital · ${allOpenFull.length} positions</div>
            </div>
            <div style="background:${BG2};border:1px solid ${BORDER};border-radius:10px;padding:18px 20px">
              <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:12px">Closed Trades</div>
              <div style="font-family:'Bebas Neue',sans-serif;font-size:24px;color:${GOLD};line-height:1">${totalTrades}</div>
              <div style="font-family:'DM Mono',monospace;font-size:9px;color:${MUTE};margin-top:4px">${qLabel} · ${winners.length} winners</div>
            </div>
          </div>
        </div>

        <div>
          ${sectionHdr("Trade Highlights")}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            ${[{ label: "BEST TRADE", trade: bestTrade }, { label: "WORST TRADE", trade: worstTrade }].map(({ label, trade }) => {
              if (!trade) return `<div style="background:${BG2};border:1px solid ${BORDER};border-radius:10px;padding:20px 22px"><div style="font-size:7px;letter-spacing:0.24em;color:${DIM};text-transform:uppercase;margin-bottom:8px">${label}</div><div style="color:${DIM};font-size:13px;font-family:'DM Mono',monospace">—</div></div>`;
              const tc = trade.pnlPct >= 0 ? "#22c55e" : "#ef4444";
              const trgb = trade.pnlPct >= 0 ? "34,197,94" : "239,68,68";
              return `<div style="background:${BG2};border:1px solid rgba(${trgb},0.25);border-left:3px solid ${tc};border-radius:10px;padding:20px 22px">
                <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:10px">${label}</div>
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  <span style="font-family:'Bebas Neue',sans-serif;font-size:${displayName(trade).length > 18 ? "17px" : "24px"};color:${GOLD};letter-spacing:0.06em">${displayName(trade)}</span>
                  <span style="font-family:'DM Mono',monospace;font-size:9px;color:${MUTE}">${trade.ticker}</span>
                  <span style="font-size:8px;padding:2px 8px;border-radius:3px;font-weight:700;letter-spacing:0.1em;background:${trade.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)"};color:${trade.direction === "LONG" ? "#22c55e" : "#ef4444"}">${trade.direction}</span>
                  <span style="font-size:8px;color:${GOLD3};font-family:'Montserrat',sans-serif;font-weight:600">${trade.tabLabel || ""}</span>
                </div>
                <div style="font-family:'Bebas Neue',sans-serif;font-size:32px;color:${tc};margin-bottom:4px">${trade.pnlPct != null ? (trade.pnlPct >= 0 ? "+" : "") + trade.pnlPct.toFixed(2) + "%" : "—"}</div>
                <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${fu(trade.pnlUSD)} · ${trade.daysHeld}d hold</div>
              </div>`;
            }).join("")}
          </div>
        </div>
        <div style="flex:1"></div>
      </div>
      ${footer()}
      ${goldBar}
    </div>`;

    // ── PAGE 3: PACK BREAKDOWN ────────────────────────────────────────────────
    const packRows = packStats.map((ps, i) => {
      const rowBg = i % 2 === 0 ? BG2 : BG3;
      const totalPnLPack = ps.realPnL + ps.floatPnL;
      return `<tr style="background:${rowBg}">
        <td style="padding:12px 14px;font-family:'Bebas Neue',sans-serif;font-size:18px;color:${GOLD};letter-spacing:0.08em">${ps.tab.label.toUpperCase()}</td>
        <td style="padding:12px 14px;font-family:'DM Mono',monospace;font-size:11px;color:${MUTE}">${ps.closed.length}</td>
        <td style="padding:12px 14px;font-family:'DM Mono',monospace;font-size:11px;color:${MUTE}">${ps.wr}</td>
        <td style="padding:12px 14px;font-family:'DM Mono',monospace;font-size:11px;color:${MUTE}">${ps.open.length}</td>
        <td style="padding:12px 14px;font-family:'Bebas Neue',sans-serif;font-size:16px;color:${ps.closed.length > 0 ? gc(ps.realPnL) : DIM}">${ps.closed.length > 0 ? fu(ps.realPnL) : "—"}</td>
        <td style="padding:12px 14px;font-family:'Bebas Neue',sans-serif;font-size:16px;color:${ps.open.length > 0 ? gc(ps.floatPnL) : DIM}">${ps.open.length > 0 ? fu(ps.floatPnL) : "—"}</td>
        <td style="padding:12px 14px;font-family:'Bebas Neue',sans-serif;font-size:18px;color:${gc(totalPnLPack)};font-weight:700">${fu(totalPnLPack)}</td>
      </tr>`;
    }).join("");

    const openRows = allOpenFull.map((p, i) => {
      const ep = num(p.entry);
      const floatUSD = calcFloatUSD(p);
      const upct = p.currentPrice ? (p.direction === "LONG" ? ((p.currentPrice - ep) / ep) * 100 : ((ep - p.currentPrice) / ep) * 100) : null;
      const rowBg = i % 2 === 0 ? BG2 : BG3;
      return `<tr style="background:${rowBg}">
        <td style="padding:9px 11px;color:${GOLD};font-family:'Bebas Neue',sans-serif;font-size:15px;letter-spacing:0.06em">${displayName(p)}<div style="font-family:'DM Mono',monospace;font-size:8px;color:${MUTE};letter-spacing:0.04em">${p.ticker}</div></td>
        <td style="padding:9px 11px;font-size:9px;font-weight:700;letter-spacing:0.08em;color:${GOLD3};font-family:'Montserrat',sans-serif">${p.tabLabel}</td>
        <td style="padding:9px 11px"><span style="font-size:8px;font-weight:700;letter-spacing:0.1em;padding:3px 8px;border-radius:3px;background:${p.direction === "LONG" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)"};color:${p.direction === "LONG" ? "#22c55e" : "#ef4444"}">${p.direction}</span></td>
        <td style="padding:9px 11px;color:#888;font-family:'DM Mono',monospace;font-size:11px">${p.qty || "—"}</td>
        <td style="padding:9px 11px;color:#888;font-family:'DM Mono',monospace;font-size:11px">${p.entry ? fp(ep) : "—"}</td>
        <td style="padding:9px 11px;color:${TEXT};font-family:'DM Mono',monospace;font-size:11px">${p.currentPrice ? fp(p.currentPrice) : "—"}</td>
        <td style="padding:9px 11px;color:${upct != null ? gc(upct) : DIM};font-family:'DM Mono',monospace;font-size:11px">${upct != null ? (upct >= 0 ? "+" : "") + upct.toFixed(2) + "%" : "—"}</td>
        <td style="padding:9px 11px;color:${floatUSD != null ? gc(floatUSD) : DIM};font-weight:700;font-family:'DM Mono',monospace;font-size:12px">${floatUSD != null ? fu(floatUSD) : "—"}</td>
        <td style="padding:9px 11px;color:${MUTE};font-family:'DM Mono',monospace;font-size:10px">${p.date || "—"}</td>
      </tr>`;
    });

    const tradeRows = qData.sort((a, b) => b.closedAt - a.closedAt).map((c, i) => {
      const rowBg = i % 2 === 0 ? BG2 : BG3;
      return `<tr style="background:${rowBg};page-break-inside:avoid">
        <td style="padding:7px 8px;color:${DIM};font-size:9px;font-family:'DM Mono',monospace">${String(i + 1).padStart(2, "0")}</td>
        <td style="padding:7px 8px;color:${GOLD};font-family:'Bebas Neue',sans-serif;font-size:13px">${displayName(c)}${c.partialPct ? ` <span style="font-size:8px;color:${GOLD3}">[${c.partialPct}%]</span>` : ""}<div style="font-family:'DM Mono',monospace;font-size:8px;color:${MUTE};letter-spacing:0.04em">${c.ticker}</div></td>
        <td style="padding:7px 8px;font-size:8px;font-weight:700;color:${GOLD3};font-family:'Montserrat',sans-serif">${c.tabLabel || "—"}</td>
        <td style="padding:7px 8px"><span style="font-size:7px;font-weight:700;padding:2px 6px;border-radius:3px;background:${c.direction === "LONG" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)"};color:${c.direction === "LONG" ? "#22c55e" : "#ef4444"}">${c.direction}</span></td>
        <td style="padding:7px 8px;color:#888;font-family:'DM Mono',monospace;font-size:10px">${c.qty || "—"}</td>
        <td style="padding:7px 8px;color:#888;font-family:'DM Mono',monospace;font-size:10px">${c.entry ? fp(parseFloat(c.entry)) : "—"}</td>
        <td style="padding:7px 8px;color:${TEXT};font-family:'DM Mono',monospace;font-size:10px">${fp(c.closePrice)}</td>
        <td style="padding:7px 8px;color:${MUTE};font-family:'DM Mono',monospace;font-size:10px">${c.closeDate || "—"}</td>
        <td style="padding:7px 8px;color:${MUTE};font-family:'DM Mono',monospace;font-size:10px">${c.daysHeld != null ? c.daysHeld + "d" : "—"}</td>
        <td style="padding:7px 8px;color:${isWin(c) ? "#22c55e" : isLoss(c) ? "#ef4444" : GOLD};font-family:'DM Mono',monospace;font-size:10px">${c.pnlPct != null ? (c.pnlPct >= 0 ? "+" : "") + c.pnlPct.toFixed(2) + "%" : "—"}</td>
        <td style="padding:7px 8px;color:${isWin(c) ? "#22c55e" : isLoss(c) ? "#ef4444" : GOLD};font-weight:700;font-family:'DM Mono',monospace;font-size:11px">${fu(c.pnlUSD)}</td>
      </tr>`;
    });

    const packBreakdownPage = `
    <div style="page-break-before:always;min-height:100vh;background:${BG1};display:flex;flex-direction:column">
      ${goldBar}
      <div style="padding:44px 56px;flex:1;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid ${BORDER};padding-bottom:22px;margin-bottom:32px">
          <div>
            <div style="font-size:7px;font-weight:700;letter-spacing:0.3em;color:${MUTE};text-transform:uppercase;margin-bottom:8px">VISIONX MARKET ANALYTICS · ${qLabel}</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:0.14em;color:${GOLD2}">PACK BREAKDOWN</div>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${today}</div>
        </div>

        <div style="margin-bottom:28px">
          ${sectionHdr("Performance by Pack — Realised & Floating")}
          <table style="width:100%;border-collapse:collapse;border:1px solid ${BORDER}">
            <thead><tr style="background:#0c0c0c;border-bottom:2px solid ${BORDER2}">
              ${["PACK", "CLOSED", "WIN RATE", "OPEN", "REALISED P&L", "FLOATING P&L", "TOTAL P&L"].map((h, i) => `<th style="${thStyle}${i >= 4 ? ";color:" + GOLD3 : ""}">${h}</th>`).join("")}
            </tr></thead>
            <tbody>${packRows}</tbody>
            <tfoot><tr style="background:#0c0c0c;border-top:2px solid ${BORDER2}">
              <td style="padding:12px 14px;font-family:'Montserrat',sans-serif;font-size:8px;font-weight:700;letter-spacing:0.2em;color:${MUTE}">TOTAL</td>
              <td style="padding:12px 14px;font-family:'DM Mono',monospace;font-size:11px;color:${MUTE}">${totalTrades}</td>
              <td style="padding:12px 14px;font-family:'DM Mono',monospace;font-size:11px;color:${MUTE}">${winRate != null ? winRate.toFixed(0) + "%" : "—"}</td>
              <td style="padding:12px 14px;font-family:'DM Mono',monospace;font-size:11px;color:${MUTE}">${allOpenFull.length}</td>
              <td style="padding:12px 14px;font-family:'Bebas Neue',sans-serif;font-size:18px;color:${gc(totalPnL)}">${fu(totalPnL)}</td>
              <td style="padding:12px 14px;font-family:'Bebas Neue',sans-serif;font-size:18px;color:${gc(totalFloatUSD)}">${fu(totalFloatUSD)}</td>
              <td style="padding:12px 14px;font-family:'Bebas Neue',sans-serif;font-size:20px;color:${gc(totalPnL + totalFloatUSD)};font-weight:700">${fu(totalPnL + totalFloatUSD)}</td>
            </tr></tfoot>
          </table>
        </div>
        <div style="flex:1"></div>
      </div>
      ${footer()}
      ${goldBar}
    </div>
    ${allOpenFull.length > 0 ? (() => {
      const OPEN_CHUNK = 17;
      const openChunks = [];
      for (let i = 0; i < openRows.length; i += OPEN_CHUNK) openChunks.push(openRows.slice(i, i + OPEN_CHUNK));
      const openHdr = `<thead><tr style="background:#0c0c0c;border-bottom:2px solid ${BORDER2}">${["TICKER","PACK","DIR","QTY","ENTRY","LIVE PRICE *","UNRLSD %","UNRLSD USD","ENTRY DATE"].map(h=>`<th style="${thStyle}">${h}</th>`).join("")}</tr></thead>`;
      return openChunks.map((chunk, ci) => `
    <div style="page-break-before:always;min-height:100vh;background:${BG1};display:flex;flex-direction:column">
      ${goldBar}
      <div style="padding:44px 56px;flex:1;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid ${BORDER};padding-bottom:16px;margin-bottom:20px">
          <div>
            <div style="font-size:7px;font-weight:700;letter-spacing:0.3em;color:${MUTE};text-transform:uppercase">VISIONX MARKET ANALYTICS · ${qLabel}${ci > 0 ? " · CONT." : ""}</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:0.14em;color:${GOLD2}">OPEN POSITIONS — ALL PACKS</div>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${today}</div>
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid ${BORDER}">
          ${openHdr}
          <tbody>${chunk.join("")}</tbody>
        </table>
        <div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM};margin-top:10px;padding:8px 4px">* Live Price reflects last available market data at time of report generation. Dashes indicate positions pending next scheduled price refresh.</div>
        <div style="flex:1"></div>
      </div>
      ${footer()}
      ${goldBar}
    </div>`).join("");
    })() : ""}`;

    // ── PAGE 4: TRADE LOG ─────────────────────────────────────────────────────
    const CHUNK = 16;
    const tradeChunks = [];
    for (let i = 0; i < tradeRows.length; i += CHUNK) tradeChunks.push(tradeRows.slice(i, i + CHUNK));
    const tradeHeader = `<thead><tr style="background:#0c0c0c;border-bottom:2px solid ${BORDER2}">${["#", "TICKER", "PACK", "DIR", "QTY", "ENTRY", "CLOSE", "CLOSE DATE", "DAYS", "PNL %", "PNL USD"].map(h => `<th style="${thStyle}">${h}</th>`).join("")}</tr></thead>`;
    const tradeLogPage = totalTrades > 0 ? tradeChunks.map((chunk, ci) => `
    <div style="page-break-before:always;min-height:100vh;width:100%;background:${BG1};display:flex;flex-direction:column">
      ${goldBar}
      <div style="padding:44px 40px;flex:1;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid ${BORDER};padding-bottom:22px;margin-bottom:32px">
          <div>
            <div style="font-size:7px;font-weight:700;letter-spacing:0.3em;color:${MUTE};text-transform:uppercase;margin-bottom:8px">VISIONX MARKET ANALYTICS · ${qLabel}${ci > 0 ? " · CONT." : ""}</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:0.14em;color:${GOLD2}">COMPLETE TRADE LOG</div>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${today}</div>
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid ${BORDER}">
          ${tradeHeader}
          <tbody>${chunk.join("")}</tbody>
        </table>
        ${ci === tradeChunks.length - 1 ? `
        <div style="margin-top:18px;padding:16px 20px;background:${BG2};border:1px solid ${BORDER};border-radius:8px;display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:8px;font-weight:700;letter-spacing:0.2em;color:${MUTE};text-transform:uppercase">${totalTrades} Trades · ${winRate != null ? winRate.toFixed(0) + "%" : "—"} Win Rate · Win/Loss Ratio ${profitFactor || "—"} · ${avgHold != null ? avgHold + "d avg hold" : "—"}</div>
          <div style="font-family:'Bebas Neue',sans-serif;font-size:24px;color:${gc(totalPnL)}">${fu(totalPnL)}</div>
        </div>` : ""}
        <div style="flex:1"></div>
      </div>
      ${footer()}
      ${goldBar}
    </div>`).join("") : "";

    // ── PAGE 5: DISCLAIMER ────────────────────────────────────────────────────
    const disclaimerPage = `
    <div style="page-break-before:always;min-height:100vh;background:${BG1};display:flex;flex-direction:column">
      ${goldBar}
      <div style="padding:64px 72px;flex:1;display:flex;flex-direction:column;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:20px;margin-bottom:48px">
          <img src="https://i.postimg.cc/pd4xzT1r/87011e66-b8e4-4d2b-9977-a06bb4b29902.png" width="48" height="48" style="object-fit:contain;filter:drop-shadow(0 0 12px rgba(212,175,55,0.4))">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:0.3em;color:#fff">VISIONX <span style="color:${GOLD3}">MARKET ANALYTICS</span></div>
        </div>
        <div style="flex:1">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:0.2em;color:${GOLD3};margin-bottom:32px">LEGAL DISCLAIMER</div>
          ${[
            ["Proprietary Capital Only", "All trading activity documented in this report represents exclusively the proprietary capital of VisionX Market Analytics. No third-party or client funds are involved in any of the positions described herein."],
            ["No Investment Advice", "This report is prepared for internal documentation and transparency purposes only. Nothing contained in this report constitutes financial advice, investment recommendations, or solicitation to buy or sell any financial instrument."],
            ["Past Performance", "Past performance results documented in this report are not indicative of future results. Trading in financial markets involves substantial risk of loss. Performance data is presented for informational purposes only."],
            ["Analytical Services", "VisionX Market Analytics provides independent market analysis and educational content. Our analytical services are distinct from and do not constitute portfolio management, asset management, or investment advisory services."],
            ["Data Accuracy", "All performance data, prices, and calculations contained in this report are derived from our internal tracking systems. While we endeavour to ensure accuracy, we make no warranty regarding the completeness or accuracy of the information presented."],
            ["Confidentiality", "This document is confidential and intended solely for internal use by VisionX Market Analytics. Unauthorized distribution or reproduction of this report is strictly prohibited."],
          ].map(([title, text]) => `
            <div style="margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid ${BORDER}">
              <div style="font-family:'Montserrat',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.22em;color:${GOLD3};text-transform:uppercase;margin-bottom:8px">${title}</div>
              <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE};line-height:1.8">${text}</div>
            </div>`).join("")}
        </div>
        <div style="border-top:1px solid ${BORDER};padding-top:24px;display:flex;justify-content:space-between;align-items:flex-end">
          <div>
            <div style="font-family:'DM Mono',monospace;font-size:9px;color:${DIM};margin-bottom:4px">VisionX Market Analytics · ${qLabel} · Quarterly Performance Memorandum</div>
            <div style="font-family:'DM Mono',monospace;font-size:9px;color:${DIM}">Generated ${today} · Confidential</div>
          </div>
          <div style="text-align:right">
            <div style="width:160px;height:1px;background:${BORDER2};margin-bottom:6px"></div>
            <div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM}">Authorised Signatory</div>
          </div>
        </div>
      </div>
      ${footer()}
      ${goldBar}
    </div>`;

    win.document.write(`<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>VisionX Market Analytics · ${qLabel} · Quarterly Performance Memorandum</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Bebas+Neue&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
      <style>
        *{box-sizing:border-box;margin:0;padding:0;zoom:1}
        html,body{background:${BG1};color:${TEXT};font-family:'Montserrat',sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
        @page{size:A4;margin:0}
        section{break-inside:avoid}

        tr{page-break-inside:avoid}
        thead{display:table-header-group}
        tfoot{display:table-footer-group}
      </style>
    </head><body>
      ${coverPage}
      ${overviewPage}
      ${packBreakdownPage}
      ${tradeLogPage}
      ${disclaimerPage}
    </body></html>`);
    win.document.close();
    setTimeout(() => { win.focus(); win.print(); }, 1200);
  };

  return createPortal(
    <div className="report-overlay" style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="report-panel" style={S.panel}>
        <div style={S.stickyHdr}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.3em", color: "#555", textTransform: "uppercase", marginBottom: 6 }}>VISIONX ANALYTICS · QUARTERLY REPORT</div>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, letterSpacing: "0.14em", color: "#d4af37", lineHeight: 1 }}>FULL PORTFOLIO</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555", marginTop: 4 }}>Generated {today} · Confidential</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <select value={selectedQ} onChange={e => setSelectedQ(e.target.value)}
                style={{ background: "#111", border: "1px solid #222", color: "#d4af37", fontFamily: "'Bebas Neue', sans-serif", fontSize: 16, letterSpacing: "0.1em", padding: "7px 14px", borderRadius: 8, outline: "none", cursor: "pointer", transition: `all 0.3s ${EASE}` }}>
                {quarters.length > 0 ? quarters.map(q => <option key={q} value={q}>{getQuarterLabel(q)}</option>) : <option value="">{getQuarterLabel(selectedQ)}</option>}
              </select>
              <button onClick={generatePDF}
                style={{ background: "rgba(212,175,55,0.07)", border: "1px solid rgba(212,175,55,0.25)", color: "#b99c64", fontFamily: "'Montserrat',sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", padding: "7px 14px", borderRadius: 8, cursor: "pointer", textTransform: "uppercase", transition: `all 0.3s ${EASE}` }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(212,175,55,0.14)"; e.currentTarget.style.color = "#d4af37"; e.currentTarget.style.boxShadow = "0 4px 18px rgba(212,175,55,0.18)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(212,175,55,0.07)"; e.currentTarget.style.color = "#b99c64"; e.currentTarget.style.boxShadow = "none"; }}>
                ⬇ PDF
              </button>
              <button onClick={onClose}
                style={{ background: "none", border: "1px solid #222", color: "#444", cursor: "pointer", fontSize: 14, padding: "7px 12px", borderRadius: 8, transition: `all 0.25s ${EASE}` }}
                onMouseEnter={e => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.3)"; e.currentTarget.style.transform = "rotate(90deg)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.transform = "none"; }}>✕</button>
            </div>
          </div>
          {quarters.length > 1 && (
            <div style={{ display: "flex", gap: 6 }}>
              {quarters.map(q => (
                <button key={q} onClick={() => setSelectedQ(q)}
                  style={{ background: selectedQ === q ? "rgba(212,175,55,0.12)" : "transparent", border: `1px solid ${selectedQ === q ? "rgba(212,175,55,0.35)" : "#1a1a1a"}`, color: selectedQ === q ? "#d4af37" : "#444", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", padding: "5px 14px", borderRadius: 20, cursor: "pointer", transition: `all 0.35s ${EASE}` }}>
                  {getQuarterLabel(q)}
                </button>
              ))}
            </div>
          )}
        </div>

        {totalTrades === 0 && allOpen.length === 0 ? (
          <div style={{ padding: "72px 32px", textAlign: "center", fontFamily: "'Montserrat', sans-serif", fontSize: 10, letterSpacing: "0.3em", color: "#2a2a2a" }}>NO DATA FOR {getQuarterLabel(selectedQ)}</div>
        ) : (<>
          <div style={S.section}>
            <div style={S.sectionTitle}>Executive Summary</div>
            <div style={{ background: "#111", border: `1px solid ${totalPnL >= 0 ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`, borderLeft: `3px solid ${totalPnL >= 0 ? "#22c55e" : "#ef4444"}`, borderRadius: 12, padding: "20px 22px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.22em", color: "#555", textTransform: "uppercase", marginBottom: 8 }}>Total Realised P&L · {qLabel}</div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 42, letterSpacing: "0.04em", color: totalPnL >= 0 ? "#22c55e" : "#ef4444", lineHeight: 1 }}>{fmtUSD(totalPnL)}</div>
                {avgPnLPct !== null && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: totalPnL >= 0 ? "#22c55e" : "#ef4444", marginTop: 5, opacity: 0.7 }}>Avg {avgPnLPct >= 0 ? "+" : ""}{avgPnLPct.toFixed(2)}% per trade</div>}
              </div>
              <div style={{ textAlign: "right" }}>
                {qoqChange !== null && <div style={{ marginBottom: 8 }}>
                  <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.2em", color: "#444", textTransform: "uppercase", marginBottom: 3 }}>vs {getQuarterLabel(prevQ)}</div>
                  <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, color: qoqChange >= 0 ? "#22c55e" : "#ef4444" }}>{qoqChange >= 0 ? "+" : ""}{fmtUSD(qoqChange).slice(1)}</div>
                </div>}
                <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.2em", color: "#444", textTransform: "uppercase", marginBottom: 3 }}>Closed Trades</div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: "#d4af37" }}>{totalTrades}</div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
              {[
                { label: "Win Rate", val: winRate !== null ? `${winRate.toFixed(0)}%` : "—", sub: `${winners.length}W / ${totalTrades - winners.length}L`, color: winRate !== null ? (winRate >= 50 ? "#22c55e" : "#ef4444") : "#555" },
                { label: "Win/Loss Ratio", val: pProfitFactor !== null ? pProfitFactor.toFixed(2) : "—", sub: pAvgWinPct && pAvgLossPct ? `+${pAvgWinPct.toFixed(1)}% / -${pAvgLossPct.toFixed(1)}%` : "avg win / avg loss", color: pProfitFactor === null ? "#555" : pProfitFactor >= 1 ? "#22c55e" : "#ef4444" },
                { label: "Avg Hold Time", val: avgHold !== null ? `${avgHold}D` : "—", sub: "per trade", color: "#d4af37" },
                { label: "Avg SL Distance", val: pAvgSLDist !== null ? `${pAvgSLDist.toFixed(1)}%` : "—", sub: `${slDists.length} open w/ stop`, color: "#b99c64" },
                { label: "Open Positions", val: String(allOpen.length), sub: "across all packs", color: "#d4af37" },
              ].map(({ label, val, sub, color }) => (
                <div key={label} style={S.statCard}>
                  <div style={S.statLabel}>{label}</div>
                  <div style={{ ...S.statVal, color }}>{val}</div>
                  <div style={S.statSub}>{sub}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── ADJUSTED TRADE AVERAGE · EX BREAK-EVEN ── */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Adjusted Trade Average · Ex Break-Even</div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(170px,210px) 1fr", gap: 12, alignItems: "stretch" }}>
              <div style={{ background: "#111", border: `1px solid ${avgPnLPctExBE === null ? "rgba(255,255,255,0.08)" : avgPnLPctExBE >= 0 ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`, borderLeft: `3px solid ${avgPnLPctExBE === null ? "#555" : avgPnLPctExBE >= 0 ? "#22c55e" : "#ef4444"}`, borderRadius: 12, padding: "18px 20px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#444", textTransform: "uppercase", marginBottom: 8 }}>Avg per Trade · Ex BE</div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 40, letterSpacing: "0.04em", lineHeight: 1, color: avgPnLPctExBE === null ? "#555" : avgPnLPctExBE >= 0 ? "#22c55e" : "#ef4444" }}>{avgPnLPctExBE !== null ? `${avgPnLPctExBE >= 0 ? "+" : ""}${avgPnLPctExBE.toFixed(2)}%` : "—"}</div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555", marginTop: 6 }}>{significantTrades.length} of {totalTrades} trades counted</div>
              </div>
              <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#b99c64", textTransform: "uppercase", marginBottom: 8 }}>How this is calculated</div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#777", lineHeight: 1.7 }}>
                  The headline <span style={{ color: "#999" }}>Avg per trade</span> counts every closed position. This adjusted figure removes <span style={{ color: "#d4af37" }}>break-even trades</span> — any close landing within <span style={{ color: "#d4af37" }}>±{BE_PCT_THRESHOLD}%</span> — so small scratches and near-flat exits don’t dilute the average. It isolates trades that resolved with a clear directional outcome.
                  {beTradesCount > 0 && <span style={{ color: "#555" }}> {beTradesCount} trade{beTradesCount !== 1 ? "s" : ""} excluded this quarter.</span>}
                  {beTradesCount === 0 && totalTrades > 0 && <span style={{ color: "#555" }}> No break-even trades excluded this quarter.</span>}
                </div>
              </div>
            </div>
          </div>

          {packData.length > 0 && (
            <div style={S.section}>
              <div style={S.sectionTitle}>Performance by Pack</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 0, border: "1px solid #1a1a1a", borderRadius: 10, overflow: "hidden" }}>
                {packData.map(({ tab, closed, open, pnl, wins }, i) => (
                  <div key={tab.id} style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: i < packData.length - 1 ? "1px solid #111" : "none", background: i % 2 === 0 ? "#0f0f0f" : "#111", transition: `background 0.25s ${EASE}` }}>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 16, color: "#d4af37", letterSpacing: "0.1em", width: 110 }}>{tab.label.toUpperCase()}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555", width: 70 }}>{closed.length} trade{closed.length !== 1 ? "s" : ""}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555", width: 60 }}>{closed.length > 0 ? `${((wins / closed.length) * 100).toFixed(0)}% WR` : "—"}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555", flex: 1 }}>{open.length} open</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, color: closed.length > 0 ? (pnl >= 0 ? "#22c55e" : "#ef4444") : "#333" }}>{closed.length > 0 ? fmtUSD(pnl) : "—"}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={S.section}>
            <div style={S.sectionTitle}>Long vs Short Breakdown</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[{ label: "Long Positions", trades: longTrades, pnl: longPnL }, { label: "Short Positions", trades: shortTrades, pnl: shortPnL }].map(({ label, trades, pnl }) => {
                const pnlColor = trades.length === 0 ? "#555" : pnl >= 0 ? "#22c55e" : "#ef4444";
                const borderRgb = trades.length === 0 ? "255,255,255" : pnl >= 0 ? "34,197,94" : "239,68,68";
                return (
                  <div key={label} style={{ background: "#111", border: `1px solid rgba(${borderRgb},0.12)`, borderLeft: `3px solid ${pnlColor}`, borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.2em", color: "#444", textTransform: "uppercase", marginBottom: 10 }}>{label}</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 24, color: pnlColor, marginBottom: 6 }}>{trades.length > 0 ? fmtUSD(pnl) : "—"}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>{trades.length} trade{trades.length !== 1 ? "s" : ""}{trades.length > 0 ? ` · ${trades.filter(t => (t.pnlUSD || 0) > 0).length}W / ${trades.filter(t => (t.pnlUSD || 0) <= 0).length}L` : ""}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {(bestTrade || worstTrade) && (
            <div style={S.section}>
              <div style={S.sectionTitle}>Trade Highlights</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[{ label: "Best Trade", trade: bestTrade }, { label: "Worst Trade", trade: worstTrade }].map(({ label, trade }) => {
                  const _tc   = trade ? (trade.pnlUSD >= 0 ? "#22c55e" : "#ef4444") : "#ef4444";
                  const _trgb = trade ? (trade.pnlUSD >= 0 ? "34,197,94" : "239,68,68") : "239,68,68";
                  return (
                    <div key={label} style={{ background: "#111", border: `1px solid rgba(${_trgb},0.15)`, borderLeft: `3px solid ${_tc}`, borderRadius: 10, padding: "14px 16px" }}>
                      <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#444", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
                      {trade ? (<>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <span title={trade.ticker} style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: displayName(trade).length > 18 ? 15 : 22, color: "#d4af37", letterSpacing: "0.06em" }}>{displayName(trade)}</span>
                          <span style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: trade.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", color: trade.direction === "LONG" ? "#22c55e" : "#ef4444", fontFamily: "'Montserrat', sans-serif", fontWeight: 700, letterSpacing: "0.12em" }}>{trade.direction}</span>
                          <span style={{ fontSize: 8, color: "#b99c64", fontFamily: "'Montserrat', sans-serif", fontWeight: 600, letterSpacing: "0.1em" }}>{trade.tabLabel}</span>
                        </div>
                        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 26, color: _tc, marginBottom: 4 }}>{fmtUSD(trade.pnlUSD)}</div>
                        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>{trade.pnlPct != null ? `${trade.pnlPct >= 0 ? "+" : ""}${trade.pnlPct.toFixed(2)}%` : ""} · {trade.daysHeld}d hold</div>
                      </>) : <div style={{ color: "#333", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>—</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {hasFloatData && allOpen.length > 0 && (
            <div style={S.section}>
              <div style={S.sectionTitle}>Floating P&L — Open Positions</div>
              <div style={{ background: "#111", border: `1px solid ${totalFloatUSD >= 0 ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`, borderLeft: `3px solid ${totalFloatUSD >= 0 ? "#22c55e" : "#ef4444"}`, borderRadius: 12, padding: "20px 22px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.22em", color: "#555", textTransform: "uppercase", marginBottom: 8 }}>Total Floating P&L — All Packs</div>
                  <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 42, letterSpacing: "0.04em", color: totalFloatUSD >= 0 ? "#22c55e" : "#ef4444", lineHeight: 1 }}>{fmtUSD(totalFloatUSD)}</div>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555", marginTop: 5 }}>Unrealised · {allOpen.filter(p => p.currentPrice).length} positions with live price</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.2em", color: "#444", textTransform: "uppercase", marginBottom: 3 }}>Open Positions</div>
                  <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: "#d4af37" }}>{allOpen.length}</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 0, border: "1px solid #1a1a1a", borderRadius: 10, overflow: "hidden" }}>
                {floatByPack.map(({ tab, positions, pnl, winners }, i) => (
                  <div key={tab.id} style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: i < floatByPack.length - 1 ? "1px solid #111" : "none", background: i % 2 === 0 ? "#0f0f0f" : "#111" }}>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 16, color: "#d4af37", letterSpacing: "0.1em", width: 110 }}>{tab.label.toUpperCase()}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555", width: 80 }}>{positions.length} position{positions.length !== 1 ? "s" : ""}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555", flex: 1 }}>{winners}↑ / {positions.length - winners}↓</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, color: pnl >= 0 ? "#22c55e" : "#ef4444" }}>{fmtUSD(pnl)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {allOpen.length > 0 && (
            <div style={S.section}>
              <div style={S.sectionTitle}>Open Positions Snapshot — All Packs</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1a1a1a" }}>
                    {["TICKER", "PACK", "DIR", "QTY", "ENTRY", "LIVE PRICE", "UNRLSD %", "UNRLSD USD", "ENTRY DATE"].map(h => (
                      <th key={h} style={{ padding: "7px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.2em", color: "#333", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allOpen.map(p => {
                    const ep   = num(p.entry);
                    const upct = p.currentPrice ? (p.direction === "LONG" ? ((p.currentPrice - ep) / ep) * 100 : ((ep - p.currentPrice) / ep) * 100) : null;
                    const uusd = p.currentPrice && p.qty ? (p.direction === "LONG" ? (p.currentPrice - ep) * num(p.qty) : (ep - p.currentPrice) * num(p.qty)) : null;
                    return (
                      <tr key={p.id} style={{ borderBottom: "1px solid #0f0f0f" }}>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#d4af37" }}>{displayName(p)}<div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#555" }}>{p.ticker}</div></td>
                        <td style={{ padding: "9px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 600, color: "#b99c64", letterSpacing: "0.08em" }}>{p.tabLabel}</td>
                        <td style={{ padding: "9px 8px" }}><span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", padding: "2px 7px", borderRadius: 3, background: p.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", color: p.direction === "LONG" ? "#22c55e" : "#ef4444" }}>{p.direction}</span></td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{p.qty || "—"}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{p.entry ? fmtPrice(ep) : "—"}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#e8e8e8" }}>{p.currentPrice ? fmtPrice(p.currentPrice) : "—"}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: upct != null ? (upct >= 0 ? "#22c55e" : "#ef4444") : "#333" }}>{upct != null ? `${upct >= 0 ? "+" : ""}${upct.toFixed(2)}%` : "—"}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontWeight: 600, color: uusd != null ? (uusd >= 0 ? "#22c55e" : "#ef4444") : "#333" }}>{fmtUSD(uusd)}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>{p.date || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {totalTrades > 0 && (
            <div style={S.section}>
              <div style={S.sectionTitle}>Complete Trade Log · {qLabel} · All Packs</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1a1a1a" }}>
                    {["#", "TICKER", "PACK", "DIR", "QTY", "ENTRY", "CLOSE", "CLOSE DATE", "DAYS", "PNL %", "PNL USD", "NOTE"].map(h => (
                      <th key={h} style={{ padding: "8px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.22em", color: "#333", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {qData.sort((a, b) => b.closedAt - a.closedAt).map((c, i) => (
                    <tr key={c.id} style={{ borderBottom: "1px solid #111" }}>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#333" }}>{String(i + 1).padStart(2, "0")}</td>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#d4af37" }}>
                        {displayName(c)}
                        {c.partialPct && <span style={{ fontSize: 9, color: "#d4af37", marginLeft: 4 }}>[{c.partialPct}%]</span>}
                        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#555" }}>{c.ticker}</div>
                      </td>
                      <td style={{ padding: "9px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 600, color: "#b99c64", letterSpacing: "0.08em" }}>{c.tabLabel}</td>
                      <td style={{ padding: "9px 8px" }}><span style={{ fontSize: 8, padding: "2px 7px", borderRadius: 3, background: c.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", color: c.direction === "LONG" ? "#22c55e" : "#ef4444", fontFamily: "'Montserrat', sans-serif", fontWeight: 700, letterSpacing: "0.12em" }}>{c.direction}</span></td>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{c.qty || "—"}</td>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{c.entry ? fmtPrice(parseFloat(c.entry)) : "—"}</td>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#e8e8e8" }}>{fmtPrice(c.closePrice)}</td>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>{c.closeDate || "—"}</td>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#555" }}>{c.daysHeld != null ? `${c.daysHeld}d` : "—"}</td>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: c.pnlPct != null ? (c.pnlPct >= 0 ? "#22c55e" : "#ef4444") : "#555" }}>{c.pnlPct != null ? `${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct.toFixed(2)}%` : "—"}</td>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontWeight: 600, color: isWin(c) ? "#22c55e" : isLoss(c) ? "#ef4444" : "#d4af37" }}>{c.pnlUSD != null ? fmtUSD(c.pnlUSD) : "—"}</td>
                      <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#444", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.note || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ padding: "18px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#2a2a2a", letterSpacing: "0.08em" }}>VISIONX ANALYTICS · FULL PORTFOLIO · {qLabel} · CONFIDENTIAL</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#2a2a2a" }}>{today}</div>
          </div>
        </>)}
      </div>
    </div>
  , document.body);
}

// ── CLOSE POSITION MODAL ──────────────────────────────────────────────────────
function ClosePositionModal({ position, tabId, tabLabel, onClose, onConfirm }) {
  useBodyScrollLock();
  const [closePrice, setClosePrice] = useState(position.currentPrice ? String(position.currentPrice) : "");
  const [quarter, setQuarter] = useState(getQuarter(new Date()));
  const [reason, setReason] = useState("tp");
  const [note, setNote] = useState("");

  const [isPartial, setIsPartial] = useState(false);
  const [partialMode, setPartialMode] = useState("pct");
  const [partialPct, setPartialPct] = useState(50);
  const [partialPctInput, setPartialPctInput] = useState("50");
  const [partialQtyInput, setPartialQtyInput] = useState("");

  const entry = parseFloat(position.entry);
  const cp = parseFloat(closePrice);
  const totalQty = parseFloat(position.qty) || 0;

  const handleSliderChange = (v) => {
    const n = Math.min(99, Math.max(1, parseInt(v) || 1));
    setPartialPct(n);
    setPartialPctInput(String(n));
    if (totalQty > 0) setPartialQtyInput(String(parseFloat((totalQty * n / 100).toFixed(8)).toString()));
  };
  const handlePctInput = (v) => {
    setPartialPctInput(v);
    const n = parseFloat(v);
    if (!isNaN(n) && n >= 0.01 && n <= 99.99) {
      setPartialPct(Math.round(n));
      if (totalQty > 0) setPartialQtyInput(String(parseFloat((totalQty * n / 100).toFixed(8))));
    }
  };
  const handleQtyInput = (v) => {
    setPartialQtyInput(v);
    const q = parseFloat(v);
    if (!isNaN(q) && q > 0 && q < totalQty && totalQty > 0) {
      const pct = Math.min(99, Math.max(1, Math.round((q / totalQty) * 100)));
      setPartialPct(pct);
      setPartialPctInput(String(pct));
    }
  };
  const togglePartial = () => {
    if (!isPartial && totalQty > 0) setPartialQtyInput(String(parseFloat((totalQty * 0.5).toFixed(8))));
    setIsPartial(p => !p);
  };

  const effectiveQty = isPartial
    ? (partialMode === "qty" && parseFloat(partialQtyInput) > 0 && parseFloat(partialQtyInput) < totalQty
        ? parseFloat(partialQtyInput)
        : totalQty * (partialPct / 100))
    : totalQty;
  const remainingQty = totalQty - effectiveQty;
  const effectivePct = totalQty > 0 ? (effectiveQty / totalQty) * 100 : partialPct;

  const pnlPct = (!isNaN(entry) && !isNaN(cp) && cp > 0) ? calcPnL(position.direction, entry, cp) : null;
  const pnlUSD = (!isNaN(entry) && !isNaN(cp) && cp > 0 && effectiveQty > 0)
    ? (position.direction === "LONG" ? (cp - entry) * effectiveQty : (entry - cp) * effectiveQty)
    : null;
  const daysHeld = position.date ? daysBetween(position.date, new Date().toISOString().split("T")[0]) : null;
  const isPos = pnlUSD !== null ? pnlUSD >= 0 : null;

  const qtyDisplay = (n) => {
    if (n == null || isNaN(n)) return "—";
    return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, "");
  };

  return createPortal(
    <div className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(8px)" }}>
      <div className="modal-card" style={{ background: "#111", border: "1px solid #2a2a2a", borderRadius: 18, width: 540, maxWidth: "95vw", padding: "28px 28px 24px", fontFamily: "'Montserrat', sans-serif", color: "#e8e8e8", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 26, letterSpacing: "0.18em", color: "#f8e49b", lineHeight: 1 }}>CLOSE POSITION</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", padding: "3px 10px", borderRadius: 4, background: "rgba(212,175,55,0.1)", border: "1px solid rgba(212,175,55,0.25)", color: "#d4af37", fontWeight: 700 }}>{quarter}</span>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", padding: "3px 10px", borderRadius: 4, background: "rgba(255,255,255,0.04)", border: "1px solid #222", color: "#666", fontWeight: 600 }}>{tabLabel.toUpperCase()} PACK</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 18, padding: "4px 8px", borderRadius: 4, transition: `all 0.25s ${EASE}` }}
            onMouseEnter={e => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.transform = "rotate(90deg)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.transform = "none"; }}>✕</button>
        </div>

        <div style={{ background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 10, padding: "14px 16px", marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px 12px" }}>
          {[
            { label: "Ticker", val: position.ticker, color: "#d4af37" },
            { label: "Direction", val: position.direction, color: position.direction === "LONG" ? "#22c55e" : "#ef4444" },
            { label: "Total Qty", val: position.qty || "—", color: "#e8e8e8" },
            { label: "Entry Price", val: fmtPrice(parseFloat(position.entry)), color: "#e8e8e8" },
            { label: "Entry Date", val: position.date || "—", color: "#666" },
            { label: "Days Held", val: daysHeld !== null ? `${daysHeld}d` : "—", color: "#666" },
          ].map(({ label, val, color }) => (
            <div key={label}>
              <div style={{ fontSize: 8, letterSpacing: "0.22em", color: "#444", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color }}>{val}</div>
            </div>
          ))}
        </div>

        <div style={{ marginBottom: 14, background: isPartial ? "rgba(212,175,55,0.04)" : "#0a0a0a", border: `1px solid ${isPartial ? "rgba(212,175,55,0.3)" : "#1a1a1a"}`, borderRadius: 10, padding: "14px 16px", transition: `all 0.35s ${EASE}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isPartial ? 14 : 0 }}>
            <div>
              <div style={{ fontSize: 9, letterSpacing: "0.2em", color: isPartial ? "#d4af37" : "#888", textTransform: "uppercase", fontWeight: 700, marginBottom: 2, transition: `color 0.3s ${EASE}` }}>PARTIAL CLOSE</div>
              <div style={{ fontSize: 10, color: "#444" }}>Close only a portion — rest stays open</div>
            </div>
            <div onClick={togglePartial} style={{ cursor: "pointer", width: 42, height: 22, borderRadius: 11, background: isPartial ? "rgba(212,175,55,0.7)" : "#222", border: `1px solid ${isPartial ? "rgba(212,175,55,0.4)" : "#333"}`, position: "relative", transition: `all 0.35s ${SPRING}`, flexShrink: 0, boxShadow: isPartial ? "0 0 14px rgba(212,175,55,0.25)" : "none" }}>
              <div style={{ position: "absolute", top: 2, left: isPartial ? 20 : 2, width: 16, height: 16, borderRadius: 8, background: isPartial ? "#d4af37" : "#555", transition: `left 0.35s ${SPRING}, background 0.3s ${EASE}` }} />
            </div>
          </div>

          {isPartial && (
            <div>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                {[{ id: "pct", label: "BY %" }, { id: "qty", label: "BY QTY" }].map(m => (
                  <button key={m.id} onClick={() => setPartialMode(m.id)}
                    style={{ padding: "5px 14px", background: partialMode === m.id ? "rgba(212,175,55,0.14)" : "transparent", border: `1px solid ${partialMode === m.id ? "rgba(212,175,55,0.4)" : "#222"}`, color: partialMode === m.id ? "#d4af37" : "#444", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", borderRadius: 6, cursor: "pointer", transition: `all 0.25s ${EASE}` }}>
                    {m.label}
                  </button>
                ))}
              </div>

              {partialMode === "pct" ? (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <input type="range" min="1" max="99" value={partialPct} onChange={e => handleSliderChange(e.target.value)}
                      style={{ flex: 1, accentColor: "#d4af37", height: 4, cursor: "pointer" }} />
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                      <input type="number" min="1" max="99" step="0.1" value={partialPctInput}
                        onChange={e => handlePctInput(e.target.value)}
                        onBlur={() => handleSliderChange(partialPctInput)}
                        style={{ width: 52, background: "#111", border: "1px solid rgba(212,175,55,0.3)", color: "#d4af37", fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, letterSpacing: "0.04em", padding: "4px 8px", borderRadius: 6, outline: "none", textAlign: "center" }} />
                      <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, color: "#d4af37" }}>%</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                    {[10, 25, 33, 50, 75].map(v => (
                      <button key={v} onClick={() => handleSliderChange(v)}
                        style={{ padding: "3px 10px", background: partialPct === v ? "rgba(212,175,55,0.15)" : "transparent", border: `1px solid ${partialPct === v ? "rgba(212,175,55,0.4)" : "#222"}`, color: partialPct === v ? "#d4af37" : "#555", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", borderRadius: 5, cursor: "pointer", transition: `all 0.25s ${EASE}` }}>
                        {v}%
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <input type="number" min="0" max={totalQty} step="any" value={partialQtyInput}
                      onChange={e => handleQtyInput(e.target.value)}
                      placeholder={`Max ${totalQty}`}
                      style={{ flex: 1, background: "#111", border: "1px solid rgba(212,175,55,0.3)", color: "#d4af37", fontFamily: "'DM Mono', monospace", fontSize: 15, padding: "9px 12px", borderRadius: 8, outline: "none" }} />
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555", flexShrink: 0 }}>/ {totalQty || "—"} total</div>
                  </div>
                  {totalQty > 0 && (
                    <div style={{ display: "flex", gap: 6 }}>
                      {[10, 25, 33, 50, 75].map(v => {
                        const qv = parseFloat((totalQty * v / 100).toFixed(8));
                        return (
                          <button key={v} onClick={() => handleQtyInput(String(qv))}
                            style={{ padding: "3px 8px", background: "transparent", border: "1px solid #222", color: "#555", fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", borderRadius: 5, cursor: "pointer", transition: `all 0.25s ${EASE}` }}>
                            {v}%
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {totalQty > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
                  <div style={{ background: "#111", border: "1px solid rgba(212,175,55,0.12)", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "#d4af37", textTransform: "uppercase", marginBottom: 4, fontWeight: 700 }}>Closing</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, color: "#d4af37" }}>{qtyDisplay(effectiveQty)}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#555", marginTop: 2 }}>{effectivePct.toFixed(1)}% of position</div>
                  </div>
                  <div style={{ background: "#111", border: "1px solid #1a1a1a", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "#555", textTransform: "uppercase", marginBottom: 4, fontWeight: 700 }}>Remaining Open</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, color: "#888" }}>{qtyDisplay(remainingQty)}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#555", marginTop: 2 }}>{(100 - effectivePct).toFixed(1)}% of position</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Close Price (USD)</label>
          <input type="number" value={closePrice} onChange={e => setClosePrice(e.target.value)} placeholder="Enter close price…"
            style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 14, padding: "10px 12px", borderRadius: 8, outline: "none", transition: `border-color 0.3s ${EASE}, box-shadow 0.3s ${EASE}` }}
            onFocus={e => { e.target.style.borderColor = "rgba(212,175,55,0.5)"; e.target.style.boxShadow = "0 0 0 3px rgba(212,175,55,0.1)"; }}
            onBlur={e => { e.target.style.borderColor = "#222"; e.target.style.boxShadow = "none"; }} />
          {position.currentPrice && (
            <div style={{ fontSize: 10, color: "#444", marginTop: 5 }}>
              Live price: {fmtPrice(position.currentPrice)} · <span onClick={() => setClosePrice(String(position.currentPrice))} style={{ color: "#b99c64", cursor: "pointer", textDecoration: "underline" }}>use live price</span>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Quarter</label>
            <select value={quarter} onChange={e => setQuarter(e.target.value)} style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "10px 12px", borderRadius: 8, outline: "none" }}>
              {getQuarterOptions().map(q => <option key={q} value={q}>{q.replace("-", " ")}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Close Reason</label>
            <select value={reason} onChange={e => setReason(e.target.value)} style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "10px 12px", borderRadius: 8, outline: "none" }}>
              {Object.entries(CLOSE_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Note (optional)</label>
          <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Wave 5 complete, target hit"
            style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "10px 12px", borderRadius: 8, outline: "none", transition: `border-color 0.3s ${EASE}, box-shadow 0.3s ${EASE}` }}
            onFocus={e => { e.target.style.borderColor = "rgba(212,175,55,0.5)"; e.target.style.boxShadow = "0 0 0 3px rgba(212,175,55,0.1)"; }}
            onBlur={e => { e.target.style.borderColor = "#222"; e.target.style.boxShadow = "none"; }} />
        </div>

        <div style={{ background: "#0a0a0a", border: `1px solid ${isPos === null ? "#1a1a1a" : isPos ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`, borderRadius: 10, padding: "14px 16px", marginBottom: 22, display: "flex", alignItems: "center", justifyContent: "space-between", transition: `border-color 0.4s ${EASE}` }}>
          <div>
            <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#444", textTransform: "uppercase", marginBottom: 5 }}>
              {isPartial ? `Realised P&L (${effectivePct.toFixed(1)}%)` : "Realised P&L"}
            </div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: isPos === null ? "#444" : isPos ? "#22c55e" : "#ef4444", transition: `color 0.4s ${EASE}` }}>
              {pnlPct !== null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "—"}
            </div>
            {isPartial && effectiveQty > 0 && (
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555", marginTop: 3 }}>
                {qtyDisplay(effectiveQty)} units closed
              </div>
            )}
          </div>
          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 30, letterSpacing: "0.04em", color: isPos === null ? "#333" : isPos ? "#22c55e" : "#ef4444", transition: `color 0.4s ${EASE}` }}>
            {pnlUSD !== null ? fmtUSD(pnlUSD) : "—"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #222", color: "#666", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 20px", borderRadius: 8, cursor: "pointer", textTransform: "uppercase", transition: `all 0.25s ${EASE}` }}>CANCEL</button>
          <button
            onClick={() => {
              const closedQty = isPartial ? qtyDisplay(effectiveQty) : position.qty;
              const record = {
                id: position.id,
                ticker: position.ticker,
                name: getTickerName(position.ticker) || null, // Klarname für Report & Karte festhalten
                direction: position.direction,
                qty: closedQty,
                entry: position.entry,
                sl: position.sl,
                entryDate: position.date,
                closeDate: new Date().toISOString().split("T")[0],
                closePrice: cp,
                closePriceDisplay: fmtPrice(cp),
                pnlPct,
                pnlUSD,
                quarter,
                reason,
                note,
                tabId,
                tabLabel,
                daysHeld,
                closedAt: Date.now(),
                isPartial,
                partialPct: isPartial ? partialPct : null,
                remainingQty: isPartial ? qtyDisplay(remainingQty) : null,
              };
              onConfirm(record, isPartial ? qtyDisplay(remainingQty) : null);
            }}
            disabled={!closePrice || isNaN(cp) || cp <= 0}
            style={{ background: closePrice && !isNaN(cp) && cp > 0 ? "linear-gradient(135deg, #d4af37, #c59958)" : "#1a1a1a", color: closePrice && !isNaN(cp) && cp > 0 ? "#0a0a0a" : "#333", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 24px", borderRadius: 8, cursor: closePrice && !isNaN(cp) && cp > 0 ? "pointer" : "not-allowed", border: "none", textTransform: "uppercase", transition: `all 0.3s ${SPRING}`, boxShadow: closePrice && !isNaN(cp) && cp > 0 ? "0 4px 18px rgba(212,175,55,0.25)" : "none" }}>
            {isPartial ? `CLOSE ${partialPct}%` : "CONFIRM CLOSE"}
          </button>
        </div>
      </div>
    </div>
  , document.body);
}


// ── DISCORD POST MODAL ───────────────────────────────────────────────────────
const DISCORD_PRESETS = [
  {
    id: "new",
    label: "New Position",
    icon: "NEW",
    emoji: "🟢",
    color: "34,197,94",
    textColor: "#22c55e",
    generate: (ticker, pack) => "🟢 " + (ticker ? "New position opened on **" + ticker + "**." : "New position opened."),
  },
  {
    id: "closed",
    label: "Position Closed",
    icon: "CLOSED",
    emoji: "🔴",
    color: "239,68,68",
    textColor: "#ef4444",
    generate: (ticker, pack) => "🔴 " + (ticker ? "Position closed on **" + ticker + "**." : "Position closed."),
  },
  {
    id: "partial",
    label: "Partials Taken",
    icon: "PARTIAL",
    emoji: "🟣",
    color: "168,85,247",
    textColor: "#a855f7",
    generate: (ticker, pack) => "🟣 " + (ticker ? "Partials taken on **" + ticker + "**." : "Partials taken."),
  },
  {
    id: "sl",
    label: "Stop Loss Moved",
    icon: "SL MOV",
    emoji: "🟠",
    color: "251,146,60",
    textColor: "#fb923c",
    generate: (ticker, pack) => "🟡 " + (ticker ? "Stop loss moved on **" + ticker + "**." : "Stop loss moved."),
  },
  {
    id: "adding",
    label: "Added to Position",
    icon: "ADDED",
    emoji: "🔵",
    color: "99,182,255",
    textColor: "#63b6ff",
    generate: (ticker, pack) => "🔵 " + (ticker ? "Added to **" + ticker + "**." : "Added to position."),
  },
];

function DiscordPostModal({ tab, positions, onClose, onConfirm }) {
  useBodyScrollLock();
  const [ticker, setTicker] = useState("");
  // Auto-Prefill: gesetzte Flags aller Positionen dieses Tabs werden beim Öffnen
  // direkt als Nachrichtenzeilen übernommen (Flag → passendes Preset + Ticker).
  const FLAG_TO_PRESET = { new_position: "new", stop_adjust: "sl", added: "adding", partials: "partial" };
  const [lines, setLines] = useState(() => {
    const auto = [];
    (positions || []).forEach(p => {
      if (!isFlagged(p) || !p.ticker.trim()) return;
      getFlags(p).forEach(k => {
        const preset = DISCORD_PRESETS.find(d => d.id === FLAG_TO_PRESET[k]);
        if (preset) auto.push({ presetId: preset.id, text: preset.generate(getTickerName(p.ticker) || p.ticker.trim().toUpperCase(), tab.label.toUpperCase()) });
      });
    });
    return auto;
  });

  const addPreset = (preset) => {
    const text = preset.generate(getTickerName(ticker) || ticker.trim().toUpperCase(), tab.label.toUpperCase());
    setLines(prev => [...prev, { presetId: preset.id, text }]);
  };

  const removeLine = (idx) => setLines(prev => prev.filter((_, i) => i !== idx));
  const editLine = (idx, text) => setLines(prev => prev.map((l, i) => i === idx ? { ...l, text } : l));
  const fullMessage = lines.map(l => l.text).join("\n\n");

  return createPortal(
    <div className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}>
      <div className="modal-card" style={{ background: "rgba(17,17,17,0.97)", border: "1px solid #2a2a2a", borderRadius: 18, width: 580, maxWidth: "95vw", maxHeight: "92vh", overflowY: "auto", padding: "28px 28px 24px", fontFamily: "'Montserrat', sans-serif", color: "#e8e8e8" }}>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 22 }}>
          <div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 26, letterSpacing: "0.18em", color: "#f8e49b", lineHeight: 1 }}>POST TO DISCORD</div>
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", padding: "3px 10px", borderRadius: 4, background: "rgba(88,101,242,0.12)", border: "1px solid rgba(88,101,242,0.3)", color: "#8b9cf4", fontWeight: 700 }}>{tab.label.toUpperCase()} CHANNEL</span>
            </div>
          </div>
          <button onClick={onClose} onMouseEnter={e => { e.currentTarget.style.color = "#d4af37"; e.currentTarget.style.transform = "rotate(90deg)"; }} onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.transform = "none"; }} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 18, padding: "4px 8px", borderRadius: 8, transition: "all 0.35s cubic-bezier(0.22, 1, 0.36, 1)" }}>✕</button>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", marginBottom: 8 }}>
            Ticker <span style={{ color: "#444", fontSize: 9, letterSpacing: 0, textTransform: "none" }}>(optional — gets woven into the text)</span>
          </div>
          <input type="text" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="e.g. BTC, SOL, MSFT"
            style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#f8e49b", fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, letterSpacing: "0.1em", padding: "10px 14px", borderRadius: 6, outline: "none" }} />
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", marginBottom: 10 }}>Click to add a block</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {DISCORD_PRESETS.map(p => (
              <button key={p.id} onClick={() => { if (!ticker.trim()) return; addPreset(p); setTicker(""); }}
                disabled={!ticker.trim()}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: ticker.trim() ? "rgba(" + p.color + ",0.08)" : "#0d0d0d", border: "1px solid rgba(" + p.color + "," + (ticker.trim() ? "0.3" : "0.1") + ")", borderRadius: 7, cursor: ticker.trim() ? "pointer" : "not-allowed", transition: "all 0.15s", opacity: ticker.trim() ? 1 : 0.35 }}
                onMouseEnter={e => { if (!ticker.trim()) return; e.currentTarget.style.background = "rgba(" + p.color + ",0.18)"; e.currentTarget.style.borderColor = "rgba(" + p.color + ",0.6)"; }}
                onMouseLeave={e => { if (!ticker.trim()) return; e.currentTarget.style.background = "rgba(" + p.color + ",0.08)"; e.currentTarget.style.borderColor = "rgba(" + p.color + ",0.3)"; }}>
                <span style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: p.textColor, textTransform: "uppercase" }}>{p.label}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: p.textColor, opacity: 0.5 }}>+</span>
              </button>
            ))}
          </div>
        </div>

        {lines.length === 0 && (
          <div style={{ padding: "28px", textAlign: "center", border: "1px dashed #1a1a1a", borderRadius: 8, marginBottom: 22 }}>
            <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#2a2a2a", textTransform: "uppercase" }}>Click a preset above to build your message</div>
          </div>
        )}

        {lines.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", marginBottom: 10 }}>
              Message blocks <span style={{ color: "#444", fontSize: 9, letterSpacing: 0, textTransform: "none" }}>(click X to remove)</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {lines.map((line, idx) => {
                const preset = DISCORD_PRESETS.find(p => p.id === line.presetId);
                return (
                  <div key={idx} style={{ background: "#0a0a0a", border: "1px solid rgba(" + (preset?.color || "255,255,255") + ",0.15)", borderLeft: "3px solid " + (preset?.textColor || "#555"), borderRadius: 7, padding: "12px 14px", position: "relative" }}>
                    <button onClick={() => removeLine(idx)} style={{ position: "absolute", top: 8, right: 10, background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "'Montserrat', sans-serif" }}
                      onMouseEnter={e => e.currentTarget.style.color = "#ef4444"}
                      onMouseLeave={e => e.currentTarget.style.color = "#333"}>✕</button>
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.2em", color: preset?.textColor || "#555", textTransform: "uppercase", marginBottom: 6 }}>{preset?.label} <span style={{ color: "#444", letterSpacing: 0, textTransform: "none", fontWeight: 500 }}>· editierbar</span></div>
                    <input value={line.text} onChange={(e) => editLine(idx, e.target.value)}
                      style={{ width: "100%", boxSizing: "border-box", background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 6, color: "#c8c8c8", fontFamily: "'DM Mono', monospace", fontSize: 11, lineHeight: 1.7, padding: "7px 10px", paddingRight: 26, outline: "none" }}
                      onFocus={e => e.currentTarget.style.borderColor = "rgba(212,175,55,0.4)"}
                      onBlur={e => e.currentTarget.style.borderColor = "#1e1e1e"} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {lines.length > 0 && (
          <div style={{ background: "#1e1f22", border: "1px solid #2a2a2a", borderRadius: 8, padding: "14px 16px", marginBottom: 22 }}>
            <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "#444", textTransform: "uppercase", marginBottom: 10 }}>Discord Preview</div>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: "linear-gradient(135deg, #d4af37, #c59958)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Bebas Neue', sans-serif", fontSize: 16, color: "#000", flexShrink: 0 }}>V</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 12, fontWeight: 700, color: "#d4af37" }}>VisionX</span>
                  <span style={{ fontSize: 9, color: "#555" }}>Today at {new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#dcddde", lineHeight: 1.8, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {fullMessage}{"\n"}<span style={{ color: "#555", fontSize: 10 }}>[screenshot attached]</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #222", color: "#666", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 20px", borderRadius: 6, cursor: "pointer", textTransform: "uppercase" }}>CANCEL</button>
          <button onClick={() => onConfirm(lines)}  disabled={false}
            style={{ background: "linear-gradient(135deg, #5865f2, #4752c4)", color: "#fff", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 24px", borderRadius: 6, cursor: "pointer", border: "none", textTransform: "uppercase" }}>
            SHOOT & POST
          </button>
        </div>
      </div>
    </div>
  , document.body);
}


// ── ADD POSITION MODAL ───────────────────────────────────────────────────────
function AddPositionModal({ tab, onClose, onConfirm }) {
  useBodyScrollLock();
  const [ticker, setTicker] = useState("");
  const [direction, setDirection] = useState("LONG");
  const [qty, setQty] = useState("");
  const [entry, setEntry] = useState("");
  const [sl, setSl] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [flag, setFlag] = useState("");

  const PLACEHOLDERS_MAP = { crypto: "BTC", stocks: "MSFT", indices: "^GSPC", commodities: "GC=F", etfs: "SPY" };

  const ep = num(entry);
  const slp = parseFloat(sl);
  const slDist = ep && slp ? calcSLDist(direction, ep, slp) : null;

  const canConfirm = ticker.trim().length > 0;

  return createPortal(
    <div className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}>
      <div className="modal-card" style={{ background: "rgba(17,17,17,0.97)", border: "1px solid #2a2a2a", borderRadius: 18, width: 500, maxWidth: "95vw", padding: "28px 28px 24px", fontFamily: "'Montserrat', sans-serif", color: "#e8e8e8" }}>

        {/* HEADER */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 22 }}>
          <div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 26, letterSpacing: "0.18em", color: "#f8e49b", lineHeight: 1 }}>NEW POSITION</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", padding: "3px 10px", borderRadius: 4, background: "rgba(212,175,55,0.1)", border: "1px solid rgba(212,175,55,0.25)", color: "#d4af37", fontWeight: 700 }}>{tab.label.toUpperCase()} PACK</span>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", padding: "3px 10px", borderRadius: 4, background: "rgba(255,255,255,0.04)", border: "1px solid #222", color: "#666", fontWeight: 600 }}>{tab.source === "binance" ? "BINANCE" : "YAHOO FINANCE"}</span>
            </div>
          </div>
          <button onClick={onClose} onMouseEnter={e => { e.currentTarget.style.color = "#d4af37"; e.currentTarget.style.transform = "rotate(90deg)"; }} onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.transform = "none"; }} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 18, padding: "4px 8px", borderRadius: 8, transition: "all 0.35s cubic-bezier(0.22, 1, 0.36, 1)" }}>✕</button>
        </div>

        {/* TICKER + DIRECTION */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Ticker</label>
            <input autoFocus type="text" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder={PLACEHOLDERS_MAP[tab.id] || "BTC"}
              style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#f8e49b", fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, letterSpacing: "0.1em", padding: "10px 12px", borderRadius: 6, outline: "none" }} />
          </div>
          <div>
            <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Direction</label>
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              {["LONG", "SHORT"].map(d => (
                <button key={d} onClick={() => setDirection(d)}
                  style={{ flex: 1, padding: "10px", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", borderRadius: 6, cursor: "pointer", border: `1px solid ${direction === d ? (d === "LONG" ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)") : "#222"}`, background: direction === d ? (d === "LONG" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)") : "transparent", color: direction === d ? (d === "LONG" ? "#22c55e" : "#ef4444") : "#444", transition: "all 0.15s" }}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* QTY + ENTRY + SL */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
          {[
            { label: "Quantity", val: qty, set: setQty, placeholder: "0" },
            { label: "Entry Price", val: entry, set: setEntry, placeholder: "0.00" },
            { label: "Stop Loss", val: sl, set: setSl, placeholder: "0.00" },
          ].map(({ label, val, set, placeholder }) => (
            <div key={label}>
              <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>{label}</label>
              <input type="number" value={val} onChange={e => set(e.target.value)} placeholder={placeholder}
                style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 14, padding: "10px 12px", borderRadius: 6, outline: "none" }} />
            </div>
          ))}
        </div>

        {/* SL DIST PREVIEW */}
        {slDist !== null && !isNaN(slDist) && (
          <div style={{ background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 6, padding: "8px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 8, letterSpacing: "0.2em", color: "#555", textTransform: "uppercase" }}>SL Distance</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: slDist >= 0 ? "#c59958" : "#ef4444" }}>{slDist.toFixed(2)}%</span>
          </div>
        )}

        {/* DATE + FLAG */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 22 }}>
          <div>
            <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Entry Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 13, padding: "10px 12px", borderRadius: 6, outline: "none", colorScheme: "dark" }} />
          </div>
          <div>
            <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Flag</label>
            <select value={flag} onChange={e => setFlag(e.target.value)}
              style={{ width: "100%", background: "#0a0a0a", border: `1px solid ${flag && FLAGS[flag] ? `rgba(${FLAGS[flag].color},0.4)` : "#222"}`, color: flag && FLAGS[flag] ? FLAGS[flag].textColor : "#555", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", padding: "10px 12px", borderRadius: 6, outline: "none", textTransform: "uppercase" }}>
              <option value="">— NONE —</option>
              <option value="new_position">NEW POSITION</option>
              <option value="stop_adjust">STOP ADJUST</option>
              <option value="added">ADDED</option>
              <option value="partials">PARTIALS</option>
            </select>
          </div>
        </div>

        {/* ACTIONS */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #222", color: "#666", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 20px", borderRadius: 6, cursor: "pointer", textTransform: "uppercase" }}>CANCEL</button>
          <button onClick={() => canConfirm && onConfirm({ ...newRow(), ticker, direction, qty, entry, sl, date, flags: flag ? [flag] : [], flaggedAt: flag ? Date.now() : null })}
            disabled={!canConfirm}
            style={{ background: canConfirm ? "linear-gradient(135deg, #d4af37, #c59958)" : "#1a1a1a", color: canConfirm ? "#0a0a0a" : "#333", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 24px", borderRadius: 6, cursor: canConfirm ? "pointer" : "not-allowed", border: "none", textTransform: "uppercase" }}>
            + ADD POSITION
          </button>
        </div>
      </div>
    </div>
  , document.body);
}

// ── CLOSED POSITIONS PANEL ────────────────────────────────────────────────────
function ClosedPositionsPanel({ closedPositions, tabId, tabLabel, onDelete, onDeleteQuarter }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedQ, setExpandedQ] = useState(null);

  const tabClosed = closedPositions.filter(c => c.tabId === tabId);
  if (tabClosed.length === 0) return null;

  const byQuarter = {};
  tabClosed.forEach(c => { if (!byQuarter[c.quarter]) byQuarter[c.quarter] = []; byQuarter[c.quarter].push(c); });
  const sortedQs = sortedQuarters(Object.keys(byQuarter));
  const totalPnL = tabClosed.reduce((s, c) => s + (c.pnlUSD || 0), 0);
  const totalTrades = tabClosed.length;
  const winners = tabClosed.filter(isWin).length;

  return (
    <div style={{ marginTop: 32, border: "1px solid #1a1a1a", borderRadius: 16, overflow: "hidden", background: "rgba(13,13,13,0.6)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", transition: "border-color 0.4s cubic-bezier(0.22, 1, 0.36, 1)" }}>
      <div onClick={() => setExpanded(e => !e)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", background: "#0d0d0d", cursor: "pointer", userSelect: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.22em", color: "#666", textTransform: "uppercase" }}>CLOSED POSITIONS — {tabLabel.toUpperCase()}</div>
          <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 4, background: "#1a1a1a", border: "1px solid #222", color: "#555", fontFamily: "'DM Mono', monospace" }}>{totalTrades}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8, letterSpacing: "0.18em", color: "#444", textTransform: "uppercase", marginBottom: 2 }}>Total Realised P&L</div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, letterSpacing: "0.06em", color: totalPnL >= 0 ? "#22c55e" : "#ef4444" }}>{fmtUSD(totalPnL)}</div>
          </div>
          <div style={{ fontSize: 8, letterSpacing: "0.18em", color: "#444", textTransform: "uppercase" }}>{winners}/{totalTrades} WIN · {expanded ? "▲" : "▼"}</div>
        </div>
      </div>

      {expanded && (
        <div style={{ background: "#0a0a0a", padding: "0 0 12px" }}>
          {sortedQs.map(q => {
            const qTrades = byQuarter[q];
            const qPnL = qTrades.reduce((s, c) => s + (c.pnlUSD || 0), 0);
            const qWin = qTrades.filter(isWin).length;
            const isExpQ = expandedQ === q;

            return (
              <div key={q} style={{ borderTop: "1px solid #161616" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px" }}>
                  <div onClick={() => setExpandedQ(isExpQ ? null : q)} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer", flex: 1 }}>
                    <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 15, letterSpacing: "0.12em", color: "#d4af37" }}>{getQuarterLabel(q)}</span>
                    <span style={{ fontSize: 9, color: "#444", fontFamily: "'DM Mono', monospace" }}>{qTrades.length} trades · {qWin}/{qTrades.length} win</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 600, color: qPnL >= 0 ? "#22c55e" : "#ef4444" }}>{fmtUSD(qPnL)}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete all ${qTrades.length} closed position(s) for ${getQuarterLabel(q)} from ${tabLabel} history?\n\nThis cannot be undone.`)) {
                          onDeleteQuarter(tabId, q);
                        }
                      }}
                      title={`Clear ${getQuarterLabel(q)}`}
                      style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)", color: "#555", fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", padding: "4px 10px", borderRadius: 4, cursor: "pointer", textTransform: "uppercase", whiteSpace: "nowrap" }}
                      onMouseEnter={e => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)"; e.currentTarget.style.background = "rgba(239,68,68,0.1)"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = "#555"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.15)"; e.currentTarget.style.background = "rgba(239,68,68,0.06)"; }}>
                      ✕ CLEAR QUARTER
                    </button>
                    <span onClick={() => setExpandedQ(isExpQ ? null : q)} style={{ fontSize: 10, color: "#333", cursor: "pointer" }}>{isExpQ ? "▲" : "▼"}</span>
                  </div>
                </div>

                {isExpQ && (
                  <div style={{ padding: "0 20px 8px" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #1a1a1a" }}>
                          {["TICKER", "DIR", "QTY", "ENTRY", "CLOSE", "DAYS", "REASON", "PNL %", "PNL USD", "NOTE", ""].map(h => (
                            <th key={h} style={{ padding: "8px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.22em", color: "#333", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {qTrades.sort((a, b) => b.closedAt - a.closedAt).map(c => (
                          <tr key={c.id} style={{ borderBottom: "1px solid #111" }}>
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#d4af37" }}>
                              {c.ticker}
                              {c.partialPct && <span style={{ fontSize: 9, color: "#d4af37", marginLeft: 4 }}>[{c.partialPct}%]</span>}
                            </td>
                            <td style={{ padding: "9px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: c.direction === "LONG" ? "#22c55e" : "#ef4444" }}>{c.direction}</td>
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{c.qty || "—"}</td>
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{c.entry ? fmtPrice(parseFloat(c.entry)) : "—"}</td>
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#e8e8e8" }}>{fmtPrice(c.closePrice)}</td>
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#555" }}>{c.daysHeld != null ? `${c.daysHeld}d` : "—"}</td>
                            <td style={{ padding: "9px 8px" }}>
                              <span style={{ fontSize: 8, padding: "2px 7px", borderRadius: 4, background: "#1a1a1a", border: "1px solid #222", color: "#555", letterSpacing: "0.1em", fontFamily: "'Montserrat', sans-serif", fontWeight: 600 }}>{CLOSE_REASONS[c.reason] || c.reason}</span>
                            </td>
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: c.pnlPct >= 0 ? "#22c55e" : "#ef4444" }}>
                              {c.pnlPct != null ? `${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct.toFixed(2)}%` : "—"}
                            </td>
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontWeight: 600, color: isWin(c) ? "#22c55e" : isLoss(c) ? "#ef4444" : "#d4af37" }}>
                              {c.pnlUSD != null ? fmtUSD(c.pnlUSD) : "—"}
                            </td>
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#444", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.note || "—"}</td>
                            <td style={{ padding: "9px 8px" }}>
                              <button onClick={() => onDelete(c.id)} style={{ background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 11, padding: "3px 6px", borderRadius: 3 }}
                                onMouseEnter={e => e.target.style.color = "#ef4444"} onMouseLeave={e => e.target.style.color = "#333"}>✕</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── PNL SHARE CARD · VSX-branded share image (Bitget-style) ─────────────────
function PnLShareModal({ position, tab, onClose }) {
  useBodyScrollLock();
  const p = position;
  const entry = num(p.entry);
  const live = p.currentPrice;
  const q = num(p.qty);
  const pnlPct = calcPnL(p.direction, entry, live);
  const pnlUSD = (live && !isNaN(entry) && !isNaN(q)) ? (p.direction === "LONG" ? (live - entry) * q : (entry - live) * q) : null;
  const days = p.date ? daysBetween(p.date, new Date().toISOString().split("T")[0]) : null;
  const isLong = p.direction === "LONG";
  const win = pnlPct != null && pnlPct >= 0;
  const pnlColor = win ? "#22c55e" : "#ef4444";

  // Toggles — defaults follow VSX public rules: percentages yes, sizes/USD no
  const [showUSD, setShowUSD] = useState(false);
  const [showPrices, setShowPrices] = useState(true);
  const [showQty, setShowQty] = useState(false);
  const [busy, setBusy] = useState(null); // copy | download | discord
  const [result, setResult] = useState(null);

  const flash = (r) => { setResult(r); setTimeout(() => setResult(null), 2500); };

  const capture = async () => {
    const html2canvas = await loadHtml2Canvas();
    const el = document.getElementById("vsx-pnl-card-capture");
    return await html2canvas(el, { backgroundColor: null, scale: 3, useCORS: true, logging: false });
  };
  const doCopy = async () => {
    try {
      setBusy("copy");
      const canvas = await capture();
      const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash("copy-ok");
    } catch (e) { console.error(e); flash("err"); }
    setBusy(null);
  };
  const doDownload = async () => {
    try {
      setBusy("download");
      const canvas = await capture();
      const a = document.createElement("a");
      a.download = `vsx-pnl-${p.ticker}-${Date.now()}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
      flash("dl-ok");
    } catch (e) { console.error(e); flash("err"); }
    setBusy(null);
  };

  const toggle = (label, val, set) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
      <div onClick={() => set(v => !v)} style={{ width: 34, height: 18, borderRadius: 9, background: val ? "rgba(212,175,55,0.7)" : "#222", border: `1px solid ${val ? "rgba(212,175,55,0.4)" : "#333"}`, position: "relative", transition: `all 0.3s ${SPRING}`, flexShrink: 0 }}>
        <div style={{ position: "absolute", top: 1.5, left: val ? 16 : 2, width: 13, height: 13, borderRadius: 7, background: val ? "#d4af37" : "#555", transition: `left 0.3s ${SPRING}` }} />
      </div>
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: val ? "#d4af37" : "#555", textTransform: "uppercase" }}>{label}</span>
    </label>
  );

  const shareBtn = (label, key, onClick, primary = false) => (
    <button onClick={onClick} disabled={!!busy}
      style={{ background: primary ? "linear-gradient(135deg, #d4af37, #c59958)" : "rgba(255,255,255,0.03)", border: primary ? "none" : "1px solid rgba(255,255,255,0.1)", color: primary ? "#0a0a0a" : "#b99c64", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 18px", borderRadius: 8, cursor: busy ? "wait" : "pointer", textTransform: "uppercase", transition: `all 0.25s ${EASE}`, boxShadow: primary ? "0 4px 18px rgba(212,175,55,0.25)" : "none" }}>
      {busy === key ? "…" : label}
    </button>
  );

  return createPortal(
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: "95vw", maxHeight: "94vh", overflowY: "auto", fontFamily: "'Montserrat', sans-serif" }}>

        {/* ── THE CARD (captured) ── */}
        <div id="vsx-pnl-card-capture" style={{ position: "relative", borderRadius: 22, overflow: "hidden", background: "linear-gradient(155deg, #16150f 0%, #0d0d0d 45%, #0a0a0a 100%)", border: "1px solid rgba(212,175,55,0.22)", padding: "0 0 22px", boxShadow: "0 24px 90px rgba(0,0,0,0.8)" }}>
          {/* gold top bar */}
          <div style={{ height: 4, background: "linear-gradient(90deg, #b99c64, #d4af37, #f8e49b, #d4af37, #b99c64)" }} />
          {/* ambient glow + grid */}
          <div style={{ position: "absolute", top: -80, right: -80, width: 340, height: 340, background: "radial-gradient(circle, rgba(212,175,55,0.09) 0%, transparent 65%)", pointerEvents: "none" }} />
          {/* 3D gold arrow · adaptiv: kleiner, wenn die Strips-Reihe ausgeblendet ist */}
          <div style={{ position: "absolute", top: (showPrices || showQty) ? 58 : 50, right: (showPrices || showQty) ? 24 : 30, width: (showPrices || showQty) ? 188 : 146, height: (showPrices || showQty) ? 188 : 146, pointerEvents: "none", opacity: 0.97, zIndex: 0 }}
            dangerouslySetInnerHTML={{ __html: vsxArrowHTML(win, "vxshare") }} />
          <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(212,175,55,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(212,175,55,0.03) 1px, transparent 1px)", backgroundSize: "44px 44px", maskImage: "radial-gradient(ellipse 420px 300px at 30% 0%, black, transparent 75%)", WebkitMaskImage: "radial-gradient(ellipse 420px 300px at 30% 0%, black, transparent 75%)", pointerEvents: "none" }} />

          {/* header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 26px 0", position: "relative", zIndex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <VSXLogo size={38} />
              <div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 19, letterSpacing: "0.26em", color: "#d4af37", lineHeight: 1 }}>VISIONX</div>
                <div style={{ fontSize: 6.5, letterSpacing: "0.38em", color: "#b99c64", textTransform: "uppercase", marginTop: 3 }}>Market Analytics</div>
              </div>
            </div>
            <div style={{ textAlign: "right", fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#555" }}>
              {new Date().toLocaleDateString("en-GB")} · {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>

          {/* ticker + direction */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "24px 26px 0", position: "relative", zIndex: 1 }}>
            {(() => {
              const dispName = getTickerName(p.ticker);
              return (<>
                <span title={p.ticker} style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: dispName ? 22 : 30, letterSpacing: "0.08em", color: "#f8e49b", lineHeight: 1, maxWidth: 305, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}>{dispName || p.ticker}</span>
                {dispName && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#8a8a8a" }}>{p.ticker}</span>}
              </>);
            })()}
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.16em", padding: "4px 13px", borderRadius: 5, background: isLong ? "rgba(34,197,94,0.14)" : "rgba(239,68,68,0.14)", border: `1px solid ${isLong ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}`, color: isLong ? "#22c55e" : "#ef4444" }}>{p.direction}</span>
            {days != null && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>{days}d</span>}
          </div>

          {/* big pnl */}
          <div style={{ padding: "14px 26px 4px" }}>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 74, letterSpacing: "0.02em", lineHeight: 0.95, color: pnlColor, textShadow: `0 0 44px ${pnlColor}55` }}>
              {pnlPct != null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "—"}
            </div>
            {showUSD && pnlUSD != null && (
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 15, color: pnlColor, marginTop: 8, opacity: 0.85 }}>{fmtUSD(pnlUSD)}</div>
            )}
          </div>

          {/* glass info strip */}
          {(showPrices || showQty) && (
            <div style={{ margin: "16px 26px 0", display: "flex", gap: 10, position: "relative", zIndex: 1 }}>
              {showPrices && (
                <>
                  <div style={{ flex: 1, background: "rgba(19,17,12,0.96)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "11px 15px" }}>
                    <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#666", textTransform: "uppercase", marginBottom: 5 }}>Entry</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, color: "#e8e8e8" }}>{!isNaN(entry) ? fmtPrice(entry) : "—"}</div>
                  </div>
                  <div style={{ flex: 1, background: "rgba(19,17,12,0.96)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "11px 15px" }}>
                    <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#666", textTransform: "uppercase", marginBottom: 5 }}>Current</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, color: "#fdfdfd" }}>{live ? fmtPrice(live) : "—"}</div>
                  </div>
                </>
              )}
              {showQty && (
                <div style={{ flex: 1, background: "rgba(19,17,12,0.96)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "11px 15px" }}>
                  <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#666", textTransform: "uppercase", marginBottom: 5 }}>Qty</div>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, color: "#c59958" }}>{p.qty || "—"}</div>
                </div>
              )}
            </div>
          )}

          {/* footer */}
          <div style={{ margin: "18px 26px 0", paddingTop: 13, borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 7, letterSpacing: "0.26em", color: "#b99c64", textTransform: "uppercase", fontWeight: 700 }}>Proprietary Trading · Official Track Record</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 7.5, color: "#444" }}>Unrealized · Not investment advice</div>
          </div>
        </div>

        {/* ── CONTROLS (not captured) ── */}
        <div style={{ marginTop: 16, background: "rgba(17,17,17,0.92)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "16px 20px", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}>
          <div style={{ display: "flex", gap: 18, marginBottom: 14, flexWrap: "wrap" }}>
            {toggle("PnL USD", showUSD, setShowUSD)}
            {toggle("Prices", showPrices, setShowPrices)}
            {toggle("Quantity", showQty, setShowQty)}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
            {result && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: result === "err" ? "#ef4444" : "#22c55e", marginRight: "auto" }}>{result === "err" ? "✕ FAILED" : result === "copy-ok" ? "✓ COPIED" : result === "dl-ok" ? "✓ SAVED" : "✓ POSTED"}</span>}
            <button onClick={onClose} style={{ background: "transparent", border: "1px solid #222", color: "#666", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 16px", borderRadius: 8, cursor: "pointer", textTransform: "uppercase", marginRight: "auto" }}>CLOSE</button>
            {shareBtn("⧉ COPY", "copy", doCopy)}
            {shareBtn("⬇ PNG", "download", doDownload, true)}
          </div>
        </div>
      </div>
    </div>
  , document.body);
}

// ── POSITION DETAIL PANEL · broker-style overview on row click ───────────────
function PositionDetailPanel({ position, tab, onClose, onRequestClose, onDelete, onSetFlag }) {
  useBodyScrollLock();
  const p = position;
  const entry = num(p.entry);
  const sl = parseFloat(p.sl);
  const q = num(p.qty);
  const live = p.currentPrice;
  const pnlPct = calcPnL(p.direction, entry, live);
  const pnlUSD = (live && !isNaN(entry) && !isNaN(q)) ? (p.direction === "LONG" ? (live - entry) * q : (entry - live) * q) : null;
  const dist = calcSLDist(p.direction, live, sl);
  const slLock = (!isNaN(entry) && !isNaN(sl)) ? (p.direction === "LONG" ? sl - entry : entry - sl) : null;
  const riskUSD = (!isNaN(entry) && !isNaN(sl) && !isNaN(q)) ? (p.direction === "LONG" ? (entry - sl) * q : (sl - entry) * q) : null;
  const posValue = calcPositionValue(p.direction, p.qty, p.entry, live);
  const days = p.date ? daysBetween(p.date, new Date().toISOString().split("T")[0]) : null;
  const isLong = p.direction === "LONG";
  const dirColor = isLong ? "#22c55e" : "#ef4444";
  const pnlColor = pnlPct == null ? "#555" : pnlPct > 0.005 ? "#22c55e" : pnlPct < -0.005 ? "#ef4444" : "#d4af37";
  const flagged = isFlagged(p);
  const activeFlags = flagged ? getFlags(p) : [];

  const cell = (label, val, color = "#e8e8e8", sub = null) => (
    <div style={{ padding: "13px 16px", background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)" }}>
      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.2em", color: "#555", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 15, color }}>{val}</div>
      {sub && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#555", marginTop: 3 }}>{sub}</div>}
    </div>
  );

  const [showShare, setShowShare] = useState(false);

  return createPortal(
    <div className="modal-overlay" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ background: "linear-gradient(160deg, rgba(24,24,24,0.88), rgba(13,13,13,0.92))", border: "1px solid rgba(212,175,55,0.16)", borderRadius: 20, width: 660, maxWidth: "95vw", maxHeight: "92vh", overflowY: "auto", padding: "26px 28px 22px", fontFamily: "'Montserrat', sans-serif", color: "#e8e8e8", backdropFilter: "blur(32px) saturate(160%)", WebkitBackdropFilter: "blur(32px) saturate(160%)", boxShadow: "0 24px 90px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 60px rgba(212,175,55,0.05)" }}>
        {showShare && <PnLShareModal position={p} tab={tab} onClose={() => setShowShare(false)} />}

        {/* HEADER · ticker + direction + pack + flag */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 34, letterSpacing: "0.1em", color: "#f8e49b", lineHeight: 1 }}>{p.ticker || "—"}</span>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.15em", padding: "4px 12px", borderRadius: 5, background: isLong ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)", color: dirColor }}>{p.direction}</span>
              {activeFlags.map(k => {
                const f = FLAGS[k];
                return <span key={k} style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", padding: "3px 10px", borderRadius: 5, background: f.solidBg, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.8)" }}>{f.short}</span>;
              })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", padding: "3px 10px", borderRadius: 4, background: "rgba(212,175,55,0.1)", border: "1px solid rgba(212,175,55,0.25)", color: "#d4af37", fontWeight: 700 }}>{tab.label.toUpperCase()} PACK</span>
            </div>
          </div>
          <button onClick={onClose}
            onMouseEnter={e => { e.currentTarget.style.color = "#d4af37"; e.currentTarget.style.transform = "rotate(90deg)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.transform = "none"; }}
            style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 18, padding: "4px 8px", borderRadius: 8, transition: `all 0.35s ${EASE}` }}>✕</button>
        </div>

        {/* PNL HERO */}
        <div style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${pnlPct == null ? "rgba(255,255,255,0.06)" : pnlPct >= 0 ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`, borderLeft: `3px solid ${pnlColor}`, borderRadius: 14, padding: "16px 20px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)" }}>
          <div>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.22em", color: "#555", textTransform: "uppercase", marginBottom: 6 }}>Unrealized PnL</div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 36, letterSpacing: "0.04em", color: pnlColor, lineHeight: 1, textShadow: pnlPct != null ? `0 0 24px ${pnlColor}44` : "none" }}>{pnlUSD != null ? fmtUSD(pnlUSD) : "—"}</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: pnlColor, marginTop: 4, opacity: 0.75 }}>{pnlPct != null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "—"}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.2em", color: "#555", textTransform: "uppercase", marginBottom: 4 }}>Live Price</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 20, color: "#fdfdfd" }}>{live ? fmtPrice(live) : "—"}</div>
            {days != null && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#555", marginTop: 4 }}>{days}d held</div>}
          </div>
        </div>

        {/* STATS GRID */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          {cell("Entry Price", !isNaN(entry) ? fmtPrice(entry) : "—")}
          {cell("Quantity", p.qty || "—", "#c59958")}
          {cell("Position Value", posValue != null ? "$" + fmtValue(posValue) : "—", "#d4af37")}
          {cell("Entry Date", p.date || "—", "#8a8a8a")}
          {cell("Stop Loss", !isNaN(sl) ? fmtPrice(sl) : "—")}
          {cell("SL Distance", dist != null && !isNaN(dist) ? `${dist.toFixed(2)}%` : "—",
            slLock == null ? "#c59958" : slLock > 1e-9 ? "#c59958" : slLock < -1e-9 ? "#ef4444" : "#8a8a8a",
            slLock == null ? null : slLock > 1e-9 ? "profit locked" : slLock < -1e-9 ? "open risk" : "break-even")}
          {cell("Risk to Stop", riskUSD != null ? (riskUSD > 0 ? "-" + fmtUSD(riskUSD).slice(1) : "locked " + fmtUSD(-riskUSD)) : "—",
            riskUSD == null ? "#555" : riskUSD > 0 ? "#ef4444" : "#22c55e",
            "if stopped out")}
          {cell("Breakeven", !isNaN(entry) ? fmtPrice(entry) : "—", "#8a8a8a", "excl. fees")}
        </div>

        {/* QUICK FLAG */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
          <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.2em", color: "#555", textTransform: "uppercase", marginRight: 4 }}>Set Flag</span>
          {Object.entries(FLAGS).map(([key, f]) => {
            const on = activeFlags.includes(key);
            return (
              <button key={key} onClick={() => onSetFlag(p.id, key)}
                style={{ padding: "5px 12px", background: on ? `rgba(${f.color},0.18)` : "transparent", border: `1px solid rgba(${f.color},${on ? "0.55" : "0.2"})`, color: f.solidBg, fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", borderRadius: 6, cursor: "pointer", textTransform: "uppercase", transition: `all 0.25s ${EASE}` }}>
                {on ? "✓ " : ""}{f.short}
              </button>
            );
          })}
        </div>

        {/* ACTIONS */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", borderTop: "1px solid #1a1a1a", paddingTop: 18 }}>
          <button onClick={() => { onDelete(p.id); }}
            style={{ background: "transparent", border: "1px solid rgba(239,68,68,0.25)", color: "#ef4444", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 18px", borderRadius: 8, cursor: "pointer", textTransform: "uppercase", marginRight: "auto", transition: `all 0.25s ${EASE}` }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(239,68,68,0.1)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
            ✕ DELETE
          </button>
          <button onClick={onClose}
            style={{ background: "transparent", border: "1px solid #222", color: "#666", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 20px", borderRadius: 8, cursor: "pointer", textTransform: "uppercase" }}>
            BACK
          </button>
          <button onClick={() => setShowShare(true)}
            style={{ background: "rgba(212,175,55,0.08)", border: "1px solid rgba(212,175,55,0.35)", color: "#d4af37", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 20px", borderRadius: 8, cursor: "pointer", textTransform: "uppercase", transition: `all 0.25s ${EASE}` }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(212,175,55,0.16)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "rgba(212,175,55,0.08)"; }}>
            ⇪ SHARE PNL
          </button>
          <button onClick={onRequestClose}
            style={{ background: "linear-gradient(135deg, #d4af37, #c59958)", color: "#0a0a0a", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 26px", borderRadius: 8, cursor: "pointer", border: "none", textTransform: "uppercase", boxShadow: "0 4px 18px rgba(212,175,55,0.25)", transition: `all 0.3s ${SPRING}` }}>
            ◼ CLOSE POSITION
          </button>
        </div>
      </div>
    </div>
  , document.body);
}

// ── TABLE ─────────────────────────────────────────────────────────────────────
function PositionTable({ tab, positions, setPositions, onRefresh, isRefreshing, anyFocused, closedPositions, onClosePosition, onDeleteClosed, onDeleteQuarter }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [search, setSearch] = useState("");
  const [focusedId, setFocusedId] = useState(null);
  const frozenOrder = useRef(null);
  const [closingPosition, setClosingPosition] = useState(null);
  const [detailPosition, setDetailPosition] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDiscordModal, setShowDiscordModal] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState(null);

  // ── Ticker-Namen-Maske: sequentielle Queue (öffentliche Proxies vertragen keine
  // 30 parallelen Requests), Modul-Cache, Retry fehlgeschlagener Lookups nach 10 Min.
  const [tickerNames, setTickerNames] = useState({});
  const nameQueue = useRef([]);
  const nameBusy = useRef(false);
  const pumpNames = useCallback(async () => {
    if (nameBusy.current) return;
    nameBusy.current = true;
    while (nameQueue.current.length) {
      const t = nameQueue.current.shift();
      const name = await fetchTickerName(t);
      if (name) { TICKER_NAME_CACHE[t] = name; setTickerNames(prev => ({ ...prev, [t]: name })); }
      else TICKER_NAME_FAIL[t] = Date.now();
      await new Promise(r => setTimeout(r, 350)); // sanfter Takt gegen Rate-Limits
    }
    nameBusy.current = false;
  }, []);
  useEffect(() => {
    if (tab.source !== "yahoo") return;
    positions.forEach(p => {
      const t = p.ticker.trim().toUpperCase();
      if (!t || p.currentPrice == null) return;                      // erst nach erfolgreichem Preis-Fetch
      if (TICKER_NAME_CACHE[t]) {
        if (tickerNames[t] !== TICKER_NAME_CACHE[t]) setTickerNames(prev => ({ ...prev, [t]: TICKER_NAME_CACHE[t] }));
        return;
      }
      if (TICKER_NAME_FAIL[t] && Date.now() - TICKER_NAME_FAIL[t] < 10 * 60 * 1000) return;
      if (nameQueue.current.includes(t)) return;
      nameQueue.current.push(t);
    });
    pumpNames();
  }, [positions, tab.source, tickerNames, pumpNames]);

  const handleDiscordPost = async (lines) => {
    setShowDiscordModal(false);
    setPosting(true);
    setPostResult(null);
    const result = await postScreenshotToDiscord(
      `table-capture-${tab.id}`,
      tab.id,
      tab.label,
      DISCORD_WEBHOOKS[tab.id],
      lines
    );
    setPosting(false);
    setPostResult(result.ok ? "ok" : "error");
    if (result.ok) {
      // Clear all flags on this tab after successful post
      setPositions(prev => prev.map(p => ({ ...p, flags: [], flag: null, flaggedAt: null })));
    }
    setTimeout(() => setPostResult(null), 3000);
  };

  const setFocus = (id) => {
    setFocusedId(id);
    if (anyFocused) anyFocused.current = true;
    // Freeze the current row order when editing starts
    if (!frozenOrder.current) {
      frozenOrder.current = sorted.map(p => p.id);
    }
  };
  const clearFocus = () => {
    setFocusedId(null);
    frozenOrder.current = null;
    if (anyFocused) anyFocused.current = false;
  };

  const update = (id, f, v) => setPositions((prev) => prev.map((p) => (p.id === id ? { ...p, [f]: v } : p)));
  const remove = (id) => { if (window.confirm("Delete this position?")) setPositions((prev) => prev.filter((p) => p.id !== id)); };
  const add = (row) => setPositions((prev) => [...prev, row]);
  // Slot-Setter für die zwei gestapelten Flag-Buttons: Slot 0 / Slot 1 direkt setzen,
  // leeren oder überschreiben. Duplikat im anderen Slot wird automatisch entfernt.
  const setFlagSlot = (id, slot, type) => setPositions((prev) => prev.map((p) => {
    if (p.id !== id) return p;
    let next = getFlags(p).slice(0, 2);
    if (!type) {
      next.splice(slot, 1);
    } else {
      const dup = next.findIndex((f, i) => f === type && i !== slot);
      if (dup !== -1) next.splice(dup, 1);
      if (slot < next.length) next[slot] = type; else next.push(type);
      next = next.slice(0, 2);
    }
    return { ...p, flags: next, flag: null, flaggedAt: next.length ? Date.now() : null };
  }));
  const setFlag = (id, type) => setPositions((prev) => prev.map((p) => {
    if (p.id !== id) return p;
    const cur = getFlags(p);
    const next = type == null ? [] : cur.includes(type) ? cur.filter(f => f !== type) : [...cur, type].slice(-2);
    return { ...p, flags: next, flag: null, flaggedAt: next.length ? Date.now() : null };
  }));

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };
  const SortTh = ({ label, k }) => (
    <th onClick={() => handleSort(k)} style={{ cursor: "pointer", userSelect: "none" }}>
      {label}<span style={{ marginLeft: 4, opacity: sortKey === k ? 1 : 0.25, fontSize: 9 }}>{sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "▲"}</span>
    </th>
  );

  const filtered = positions.filter(p => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return p.ticker.toLowerCase().includes(q) || p.direction.toLowerCase().includes(q) || p.date.includes(q);
  });
  const sorted = (() => {
    const base = [...filtered].sort((a, b) => {
      if (!sortKey) return 0;
      let va, vb;
      if (sortKey === "ticker") { va = a.ticker; vb = b.ticker; }
      else if (sortKey === "date") { va = a.date; vb = b.date; }
      else if (sortKey === "entry") { va = parseFloat(a.entry) || 0; vb = parseFloat(b.entry) || 0; }
      else if (sortKey === "pnl") { va = calcPnL(a.direction, parseFloat(a.entry), a.currentPrice) ?? -Infinity; vb = calcPnL(b.direction, parseFloat(b.entry), b.currentPrice) ?? -Infinity; }
      else if (sortKey === "dir") { va = a.direction; vb = b.direction; }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    // If editing, use frozen order to prevent rows jumping
    if (frozenOrder.current) {
      const orderMap = Object.fromEntries(frozenOrder.current.map((id, i) => [id, i]));
      return [...base].sort((a, b) => (orderMap[a.id] ?? 999) - (orderMap[b.id] ?? 999));
    }
    return base;
  })();

  return (
    <div>
      {showDiscordModal && (
        <DiscordPostModal
          tab={tab}
          positions={positions}
          onClose={() => setShowDiscordModal(false)}
          onConfirm={(message, emoji) => handleDiscordPost(message, emoji)}
        />
      )}
      {showAddModal && (
        <AddPositionModal
          tab={tab}
          onClose={() => setShowAddModal(false)}
          onConfirm={(row) => { add(row); setShowAddModal(false); }}
        />
      )}
      {detailPosition && (() => {
        const liveP = positions.find(x => x.id === detailPosition); // live lookup → Panel tickt mit Preis-Updates mit
        if (!liveP) return null;
        return (
          <PositionDetailPanel
            position={liveP}
            tab={tab}
            onClose={() => setDetailPosition(null)}
            onRequestClose={() => { setDetailPosition(null); setClosingPosition(liveP); }}
            onDelete={(id) => { setDetailPosition(null); remove(id); }}
            onSetFlag={(id, type) => setFlag(id, type)}
          />
        );
      })()}
      {closingPosition && (
        <ClosePositionModal
          position={closingPosition}
          tabId={tab.id}
          tabLabel={tab.label}
          onClose={() => setClosingPosition(null)}
          onConfirm={(record, remainingQty) => {
            onClosePosition(record, closingPosition.id, remainingQty);
            setClosingPosition(null);
          }}
        />
      )}
      {tab.id === "stocks" && (
        <div className="hint-bar"><span className="hint-label">FORMAT</span>{STOCK_HINT}</div>
      )}
      <div className="toolbar">
        <button className="btn btn-add" onClick={() => setShowAddModal(true)}>+ ADD POSITION</button>
        <button className="btn btn-refresh" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? <span className="spin">↻</span> : "↻"} REFRESH
        </button>
        <input className="search-inp" placeholder="Search ticker, date, direction…" value={search} onChange={e => setSearch(e.target.value)} />
        <span className="source-badge">{tab.source === "binance" ? "BINANCE · 15s AUTO" : "YAHOO FINANCE · 60s AUTO"}</span>
        <button className="btn btn-discord" onClick={() => setShowDiscordModal(true)} disabled={posting}
          style={{ marginLeft: "auto", background: posting ? "#1a1a1a" : postResult === "ok" ? "rgba(34,197,94,0.15)" : postResult === "error" ? "rgba(239,68,68,0.15)" : "rgba(88,101,242,0.15)", border: `1px solid ${postResult === "ok" ? "rgba(34,197,94,0.4)" : postResult === "error" ? "rgba(239,68,68,0.4)" : "rgba(88,101,242,0.4)"}`, color: postResult === "ok" ? "#22c55e" : postResult === "error" ? "#ef4444" : "#8b9cf4", fontFamily: "'Montserrat',sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", padding: "8px 16px", borderRadius: 6, cursor: posting ? "not-allowed" : "pointer", textTransform: "uppercase", transition: "all 0.2s", opacity: posting ? 0.5 : 1 }}>
          {posting ? "⏳ POSTING..." : postResult === "ok" ? "✓ POSTED!" : postResult === "error" ? "✕ FAILED" : "📸 POST TO DISCORD"}
        </button>
      </div>
      <div id={`table-capture-${tab.id}`} className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortTh label="TICKER" k="ticker" />
              <SortTh label="DIRECTION" k="dir" />
              <th>QTY</th>
              <SortTh label="ENTRY" k="entry" />
              <th>STOP LOSS</th>
              <th>SL DIST %</th>
              <SortTh label="ENTRY DATE" k="date" />
              <th>LIVE PRICE</th>
              <th>VALUE</th>
              <SortTh label="PNL %" k="pnl" />
              <th>FLAG</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={12} className="empty-cell">{search ? "NO RESULTS" : "NO POSITIONS — PRESS ADD TO BEGIN"}</td></tr>
            ) : sorted.map((p) => {
              const entry = num(p.entry);
              const sl = parseFloat(p.sl);
              const pnl = calcPnL(p.direction, entry, p.currentPrice);
              const dist = calcSLDist(p.direction, p.currentPrice, sl); // Live → Stop, unverändert
              // Stop relativ zum Entry: > 0 = im Gewinn (Puffer) · < 0 = noch im Verlust (Risiko)
              const slLock = (!isNaN(entry) && !isNaN(sl))
                ? (p.direction === "LONG" ? sl - entry : entry - sl)
                : null;
              const posValueNum = calcPositionValue(p.direction, p.qty, p.entry, p.currentPrice);
              const posValue = fmtValue(posValueNum);
              const flagged = isFlagged(p);
              const rowFlags = flagged ? getFlags(p) : [];
              const flagCfg = rowFlags.length ? FLAGS[rowFlags[0]] : null;
              const timeLeft = flagged ? Math.ceil((NEW_TTL - (Date.now() - p.flaggedAt)) / 3600000) : 0;
              const rowBorderColor = flagCfg ? `rgba(${flagCfg.color},0.4)` : "transparent";
              const rowBg = flagCfg ? `rgba(${flagCfg.color},0.04)` : "";
              return (
                <tr key={p.id}
                  onClick={(e) => {
                    // Klicks auf Edit-Felder/Buttons/Selects öffnen KEIN Panel — nur echte Zeilen-Klicks
                    if (e.target.closest("input, select, button, a, label, [data-noopen]")) return;
                    if (p.ticker.trim()) setDetailPosition(p.id);
                  }}
                  style={{ cursor: p.ticker.trim() ? "pointer" : "default", ...(flagged ? { background: rowBg, borderLeft: `2px solid ${rowBorderColor}` } : {}) }}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input className="cell-input ticker-inp" placeholder={PLACEHOLDERS[tab.id]} value={p.ticker}
                        title={tickerNames[p.ticker.trim().toUpperCase()] || ""}
                        onChange={(e) => update(p.id, "ticker", e.target.value.toUpperCase())}
                        onFocus={() => setFocus(p.id)}
                        onBlur={() => { clearFocus(); if (p.ticker.trim()) onRefresh(); }} />
                      {rowFlags.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
                          {rowFlags.map(k => {
                            const f = FLAGS[k];
                            return <span key={k} className="flag-badge" style={{ color: "#fff", borderColor: f.solidBorder, background: f.solidBg, textShadow: "0 1px 2px rgba(0,0,0,0.8)", fontWeight: 800 }}>{f.short}</span>;
                          })}
                        </div>
                      )}
                    </div>
                  </td>
                  <td>
                    <select className={`dir-sel ${p.direction === "LONG" ? "dir-long" : "dir-short"}`} value={p.direction} onChange={(e) => update(p.id, "direction", e.target.value)}>
                      <option value="LONG">LONG</option>
                      <option value="SHORT">SHORT</option>
                    </select>
                  </td>
                  <td><input className="cell-input num-inp qty-inp" placeholder="0" type="number" value={p.qty} onChange={(e) => update(p.id, "qty", e.target.value)} onFocus={() => setFocus(p.id)} onBlur={() => clearFocus()} /></td>
                  <td><input className="cell-input num-inp" placeholder="0.00" type="number" value={p.entry} onChange={(e) => update(p.id, "entry", e.target.value)} onFocus={() => setFocus(p.id)} onBlur={() => clearFocus()} /></td>
                  <td><input className="cell-input num-inp" placeholder="0.00" type="number" value={p.sl} onChange={(e) => update(p.id, "sl", e.target.value)} onFocus={() => setFocus(p.id)} onBlur={() => clearFocus()} /></td>
                  <td>
                    {dist !== null && !isNaN(dist) ? (
                      <span className="dist-val"
                        title={slLock == null ? "" : slLock > 0 ? "Stop im Gewinn — abgesichert" : slLock < 0 ? "Stop noch im Verlust — offenes Risiko" : "Stop auf Break-Even"}
                        style={{ color:
                          slLock == null ? "var(--gold3)" :
                          slLock > 1e-9  ? "var(--gold3)" :   // Puffer  → gold
                          slLock < -1e-9 ? "var(--red)"   :   // Risiko  → rot
                                           "var(--text-dim)"  // Break-Even → neutral
                        }}>
                        {dist.toFixed(2)}%
                      </span>
                    ) : <span className="price-dim">—</span>}
                  </td>
                  <td><input className="cell-input date-inp" type="date" value={p.date} onChange={(e) => update(p.id, "date", e.target.value)} onFocus={() => setFocus(p.id)} onBlur={() => clearFocus()} /></td>
                  <td>{p.loading ? <span className="fetching">LOADING</span> : p.error ? <span className="price-err">N/A</span> : p.currentPrice !== null ? <FlashPrice price={p.currentPrice} /> : <span className="price-dim">—</span>}</td>
                  <td>
                    {posValue !== null
                      ? <span className="value-val">{posValue}</span>
                      : <span className="price-dim">—</span>}
                  </td>
                  <td>{pnl !== null && !isNaN(pnl) ? <span className={pnl > 0.005 ? "pnl-pos" : pnl < -0.005 ? "pnl-neg" : "pnl-zero"}>{pnl > 0 ? "+" : ""}{pnl.toFixed(2)}%</span> : <span className="price-dim">—</span>}</td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                      {[0, 1].map(slot => {
                        const val = rowFlags[slot] || "";
                        const cfg = val ? FLAGS[val] : null;
                        return (
                          <select key={slot} className="flag-sel" value={val} onChange={(e) => setFlagSlot(p.id, slot, e.target.value || null)}
                            style={cfg ? { color: cfg.textColor, borderColor: `rgba(${cfg.color},0.4)`, background: `rgba(${cfg.color},0.08)` } : {}}>
                            <option value="">{val ? "— CLEAR —" : "+ FLAG"}</option>
                            <option value="new_position">NEW POSITION</option>
                            <option value="stop_adjust">STOP ADJUST</option>
                            <option value="added">ADDED</option>
                            <option value="partials">PARTIALS</option>
                          </select>
                        );
                      })}
                      {flagged && <span style={{ fontSize: 9, color: "var(--text-mute)", fontFamily: "'DM Mono',monospace" }}>{timeLeft}h</span>}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {p.ticker.trim() && (
                        <button className="close-pos-btn" onClick={() => setClosingPosition(p)} title="Close position">◼ CLOSE</button>
                      )}
                      <button className="del-btn" onClick={() => remove(p.id)}>✕</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ClosedPositionsPanel closedPositions={closedPositions} tabId={tab.id} tabLabel={tab.label} onDelete={onDeleteClosed} onDeleteQuarter={onDeleteQuarter} />
    </div>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState("crypto");
  const [allPositions, setAllPositions] = useState(EMPTY_STATE);
  const [closedPositions, setClosedPositions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState({});
  const [lastRefresh, setLastRefresh] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showFreeContent, setShowFreeContent] = useState(false);
  const [perfSegments, setPerfSegments] = useState([]);
  const anyFocused = useRef(false);
  const allPositionsRef = useRef(allPositions);
  const contentRef = useRef(null);

  // Load performance-curve config (quarter segments) on startup
  useEffect(() => { loadPerfConfig().then(setPerfSegments); }, []);
  const handleSaveSegments = (segments) => { setPerfSegments(segments); savePerfConfig(segments); };

  // ── Daily equity snapshots · 00:00 Europe/Berlin ──
  const [equitySnapshots, setEquitySnapshots] = useState({});

  // Re-trigger the content fade on tab switch WITHOUT remounting PositionTable
  // (keeps per-tab search/sort state alive)
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.style.animation = "none";
    void el.offsetHeight; // force reflow to restart the CSS animation
    el.style.animation = "";
  }, [activeTab]);

  // ── Load from Firebase on startup ─────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const stored = await loadFromStorage();
      if (stored) {
        setAllPositions(Object.fromEntries(
          Object.entries(stored).map(([id, rows]) => [id, rows.map(r => ({ qty: "", flaggedAt: null, ...r, flags: Array.isArray(r.flags) ? r.flags : (r.flag ? [r.flag] : []), flag: null }))])
        ));
      }
      const closedStored = await loadClosedFromStorage();
      setClosedPositions(closedStored.list || []);
      setIsLoading(false);
      // Directly trigger refresh for all tabs with positions
      if (stored) {
        const loadedPositions = Object.fromEntries(
          Object.entries(stored).map(([id, rows]) => [id, rows.map(r => ({ qty: "", flaggedAt: null, ...r, flags: Array.isArray(r.flags) ? r.flags : (r.flag ? [r.flag] : []), flag: null }))])
        );
        allPositionsRef.current = loadedPositions;
        setTimeout(() => {
          TABS.forEach(async (tab) => {
            const rows = loadedPositions[tab.id] || [];
            const active = rows.filter(p => p.ticker?.trim());
            if (!active.length) return;
            setRefreshing(prev => ({ ...prev, [tab.id]: true }));
            let priceMap = {};
            if (tab.source === "binance") {
              await Promise.all(active.map(async (p) => { priceMap[p.ticker.trim()] = await fetchBinance(p.ticker.trim()); }));
            } else {
              const r = await fetch(`/api/yahoo?symbols=${active.map(p => p.ticker.trim()).join(",")}`);
              if (r.ok) { const d = await r.json(); priceMap = d?.prices || {}; }
            }
            setAllPositions(prev => ({
              ...prev,
              [tab.id]: (prev[tab.id] || []).map(p => {
                if (!p.ticker?.trim()) return p;
                const fetched = priceMap[p.ticker.trim()];
                return fetched ? { ...p, currentPrice: fetched, error: false, loading: false } : p;
              }),
            }));
            setRefreshing(prev => ({ ...prev, [tab.id]: false }));
            setLastRefresh(new Date());
          });
        }, 800);
      }
    };
    init();
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      setAllPositions(prev => {
        let changed = false;
        const next = Object.fromEntries(Object.entries(prev).map(([id, rows]) => [id, rows.map(p => {
          if (p.flaggedAt && !isFlagged(p)) { changed = true; return { ...p, flags: [], flag: null, flaggedAt: null }; }
          return p;
        })]));
        if (changed) {
          const toSave = Object.fromEntries(Object.entries(next).map(([id, rows]) => [id, rows.map(({ currentPrice, loading, error, ...r }) => r)]));
          saveToStorage(toSave);
        }
        return changed ? next : prev;
      });
    }, 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { setSavedFlash(true); const t = setTimeout(() => setSavedFlash(false), 1400); return () => clearTimeout(t); }, [allPositions, closedPositions]);

  useEffect(() => { allPositionsRef.current = allPositions; }, [allPositions]);

  const setPosForTab = (tabId) => (updater) => setAllPositions((prev) => {
    const next = { ...prev, [tabId]: typeof updater === "function" ? updater(prev[tabId]) : updater };
    const toSave = Object.fromEntries(Object.entries(next).map(([id, rows]) => [id, rows.map(({ currentPrice, loading, error, ...r }) => r)]));
    saveToStorage(toSave);
    return next;
  });

  const handleClosePosition = (record, positionId, remainingQty) => {
    if (!record.isPartial) {
      postTrackRecordToDiscord(record); // ╔📊-track-record · full closes only
    }
    const newClosed = [...closedPositions, record];
    setClosedPositions(newClosed);
    saveClosedToStorage({ list: newClosed });
    setAllPositions(prev => {
      let next;
      if (record.isPartial && remainingQty != null) {
        next = {
          ...prev,
          [record.tabId]: prev[record.tabId].map(p =>
            p.id !== positionId ? p : { ...p, qty: remainingQty }
          ),
        };
      } else {
        next = { ...prev, [record.tabId]: prev[record.tabId].filter(p => p.id !== positionId) };
      }
      const toSave = Object.fromEntries(Object.entries(next).map(([id, rows]) => [id, rows.map(({ currentPrice, loading, error, ...r }) => r)]));
      saveToStorage(toSave);
      return next;
    });
  };

  const handleDeleteClosed = (id) => {
    if (!window.confirm("Remove this closed position from history?")) return;
    const newClosed = closedPositions.filter(c => c.id !== id);
    setClosedPositions(newClosed); saveClosedToStorage({ list: newClosed });
  };

  const handleDeleteQuarter = (tabId, quarter) => {
    const newClosed = closedPositions.filter(c => !(c.tabId === tabId && c.quarter === quarter));
    setClosedPositions(newClosed); saveClosedToStorage({ list: newClosed });
  };

  const refreshTab = useCallback(async (tabId) => {
    const tab = TABS.find((t) => t.id === tabId);
    const snapshot = allPositionsRef.current[tabId] || [];
    const active = snapshot.filter((p) => p.ticker.trim());
    if (!active.length) return;
    setRefreshing((prev) => ({ ...prev, [tabId]: true }));
    let priceMap = {};
    if (tab.source === "binance") {
      await Promise.all(active.map(async (p) => { priceMap[p.ticker.trim()] = await fetchBinance(p.ticker.trim()); }));
    } else { priceMap = await fetchYahooBatch(active.map(p => p.ticker.trim())); }
    setAllPositions((prev) => {
      const latest = prev[tabId] || [];
      const updated = latest.map((p) => {
        if (!p.ticker.trim()) return p;
        const fetched = priceMap[p.ticker.trim()];
        const price = (fetched != null && fetched > 0) ? fetched : p.currentPrice;
        const isError = fetched == null && p.currentPrice === null;
        return { ...p, currentPrice: price, error: isError, loading: false };
      });
      return { ...prev, [tabId]: updated };
    });
    setLastRefresh(new Date());
    setRefreshing((prev) => ({ ...prev, [tabId]: false }));
  }, []);

  useEffect(() => {
    if (isLoading) return;
    const intervals = TABS.map((tab) => {
      const ms = tab.source === "binance" ? 15000 : 60000;
      return setInterval(() => {
        if (!anyFocused.current && (allPositionsRef.current[tab.id] || []).some((p) => p.ticker.trim())) refreshTab(tab.id);
      }, ms);
    });
    return () => intervals.forEach(clearInterval);
  }, [allPositions, refreshTab, isLoading]);

  const allRows = Object.values(allPositions).flat();
  const totalPositions = allRows.filter((p) => p.ticker).length;
  const portfolioPnlVals = allRows.map((p) => calcPnL(p.direction, num(p.entry), p.currentPrice)).filter((v) => v !== null && !isNaN(v));
  const portfolioPnl = portfolioPnlVals.length ? portfolioPnlVals.reduce((a, b) => a + b, 0) / portfolioPnlVals.length : null;
  const tabPnlVals = (allPositions[activeTab] || []).map((p) => calcPnL(p.direction, num(p.entry), p.currentPrice)).filter((v) => v !== null && !isNaN(v));
  const tabPnl = tabPnlVals.length ? tabPnlVals.reduce((a, b) => a + b, 0) / tabPnlVals.length : null;
  const currentTab = TABS.find((t) => t.id === activeTab);
  const tabRowsWithPnl = (allPositions[activeTab] || []).map((p) => ({ ...p, pnl: calcPnL(p.direction, num(p.entry), p.currentPrice) })).filter((p) => p.ticker && p.pnl !== null && !isNaN(p.pnl));
  const topPerformer = tabRowsWithPnl.length ? tabRowsWithPnl.reduce((a, b) => a.pnl > b.pnl ? a : b) : null;
  const worstPerformer = tabRowsWithPnl.length ? tabRowsWithPnl.reduce((a, b) => a.pnl < b.pnl ? a : b) : null;
  const newCount = allRows.filter(p => isNew(p)).length;
  const currentQ = getQuarter(new Date());
  const currentQPnL = closedPositions.filter(c => c.quarter === currentQ).reduce((s, c) => s + (c.pnlUSD || 0), 0);
  const hasCurrentQData = closedPositions.some(c => c.quarter === currentQ);

  if (isLoading) {
    return (
      <div style={{ minHeight: "100vh", background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 20, animation: "vsxFadeIn 0.6s cubic-bezier(0.22, 1, 0.36, 1) both" }}>
        <img src="https://i.postimg.cc/pd4xzT1r/87011e66-b8e4-4d2b-9977-a06bb4b29902.png" width={72} height={72} alt="VisionX" style={{ filter: "drop-shadow(0 0 16px rgba(212,175,55,0.5))", animation: "spin 2s linear infinite" }} />
        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, letterSpacing: "0.3em", color: "#d4af37" }}>LOADING VISIONX...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes vsxFadeIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
      </div>
    );
  }

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&family=Bebas+Neue&family=DM+Mono:wght@300;400;500&display=swap');
        :root {
          --black:#0a0a0a; --black2:#111111; --black3:#1a1a1a; --border:#222222; --border2:#2a2a2a;
          --gold1:#b99c64; --gold2:#d4af37; --gold3:#c59958; --gold4:#f8e49b;
          --white:#fdfdfd; --text:#ececec; --text-dim:#8a8a8a; --text-mute:#4a4a4a;
          --green:#22c55e; --red:#ef4444;
          --ease: cubic-bezier(0.22, 1, 0.36, 1);
          --spring: cubic-bezier(0.34, 1.4, 0.64, 1);
          --r-sm: 10px; --r-md: 16px; --r-lg: 22px;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html { scroll-behavior: smooth; }
        body { background: var(--black); }
        ::selection { background: rgba(212,175,55,0.25); color: var(--gold4); }
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: var(--black); }
        ::-webkit-scrollbar-thumb { background: #1e1e1e; border-radius: 6px; border: 2px solid var(--black); transition: background 0.3s; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(212,175,55,0.35); }
        :focus-visible { outline: 2px solid rgba(212,175,55,0.6); outline-offset: 2px; border-radius: 4px; }

        .app { min-height: 100vh; background: var(--black); font-family: 'Montserrat', sans-serif; color: var(--text); }
        .app::before { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
          background:
            radial-gradient(ellipse 900px 480px at 50% -10%, rgba(212,175,55,0.06), transparent 60%),
            radial-gradient(ellipse 700px 500px at 85% 110%, rgba(185,156,100,0.04), transparent 65%); }
        .app::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: 0.5;
          background-image:
            linear-gradient(rgba(212,175,55,0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(212,175,55,0.025) 1px, transparent 1px);
          background-size: 56px 56px;
          -webkit-mask-image: radial-gradient(ellipse 1100px 600px at 50% 0%, black, transparent 75%);
          mask-image: radial-gradient(ellipse 1100px 600px at 50% 0%, black, transparent 75%); }

        /* ── HEADER · frosted glass ───────────────────────────────── */
        .header { min-height: 100px; padding: 16px 56px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;
          background: rgba(10,10,10,0.6); backdrop-filter: blur(32px) saturate(170%); -webkit-backdrop-filter: blur(32px) saturate(170%);
          border-bottom: 1px solid rgba(255,255,255,0.06); position: sticky; top: 0; z-index: 100;
          animation: headerIn 0.7s var(--ease) both; }
        @keyframes headerIn { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: none; } }
        .logo-area { display: flex; align-items: center; gap: 16px; }
        .logo-divider { width: 1px; height: 40px; background: linear-gradient(180deg, transparent, rgba(212,175,55,0.4), transparent); margin: 0 6px; }
        .logo-name { font-family: 'Bebas Neue', sans-serif; font-size: 32px; letter-spacing: 0.25em; color: var(--gold2); line-height: 1;
          background: linear-gradient(110deg, #b99c64 0%, #d4af37 30%, #f8e49b 50%, #d4af37 70%, #b99c64 100%);
          background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
          animation: goldShimmer 8s var(--ease) infinite; }
        @keyframes goldShimmer { 0%, 50% { background-position: 100% 0; } 92%, 100% { background-position: 0% 0; } }
        .logo-sub { font-size: 8px; letter-spacing: 0.4em; color: var(--gold1); line-height: 1.6; font-weight: 500; text-transform: uppercase; }
        .header-right { display: flex; align-items: center; gap: 0; }
        .stat-block { padding: 0 24px; text-align: right; cursor: default;
          border-left: 1px solid rgba(255,255,255,0.07);
          transition: background 0.4s var(--ease); animation: statIn 0.7s var(--ease) both; }
        .stat-block:hover { background: rgba(212,175,55,0.035); }
        .stat-block:hover .stat-label { color: var(--gold1); }
        .stat-block:hover .stat-val { transform: translateY(-1px); text-shadow: 0 0 18px currentColor; }
        .stat-block:nth-child(1) { animation-delay: 0.08s; } .stat-block:nth-child(2) { animation-delay: 0.14s; }
        .stat-block:nth-child(3) { animation-delay: 0.20s; } .stat-block:nth-child(4) { animation-delay: 0.26s; }
        .stat-block:nth-child(5) { animation-delay: 0.32s; } .stat-block:nth-child(6) { animation-delay: 0.38s; }
        @keyframes statIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
        .stat-label { font-size: 8px; font-weight: 600; letter-spacing: 0.22em; color: var(--text-dim); text-transform: uppercase; margin-bottom: 5px;
          transition: color 0.4s var(--ease); }
        .stat-val { font-family: 'Bebas Neue', sans-serif; font-size: 22px; letter-spacing: 0.04em; line-height: 1; font-variant-numeric: tabular-nums;
          transition: color 0.45s var(--ease), transform 0.35s var(--spring), text-shadow 0.45s var(--ease); }
        .status-block { padding: 2px 0 2px 24px; border-left: 1px solid rgba(255,255,255,0.07); display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        .live-badge { display: flex; align-items: center; gap: 9px; padding: 7px 18px; border: 1px solid rgba(34,197,94,0.35);
          background: rgba(34,197,94,0.09); border-radius: 20px; font-size: 10px; font-weight: 700; letter-spacing: 0.24em; color: var(--green);
          box-shadow: 0 0 22px rgba(34,197,94,0.12); transition: all 0.3s var(--ease); }
        .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 12px var(--green); position: relative; animation: glow 2s ease-in-out infinite; }
        .live-dot::before { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 1px solid rgba(34,197,94,0.5); animation: livePulse 2s var(--ease) infinite; }
        @keyframes livePulse { 0% { transform: scale(0.6); opacity: 1; } 100% { transform: scale(1.9); opacity: 0; } }
        @keyframes glow { 0%,100% { opacity: 1; box-shadow: 0 0 10px var(--green); } 50% { opacity: 0.3; box-shadow: 0 0 3px var(--green); } }
        .save-flash { font-size: 8px; letter-spacing: 0.18em; color: var(--gold2); transition: opacity 0.5s var(--ease), transform 0.5s var(--ease); font-weight: 500; }
        .save-flash.on { opacity: 1; transform: translateY(0); } .save-flash.off { opacity: 0; transform: translateY(3px); }
        .refresh-ts { font-size: 9px; color: var(--text-mute); letter-spacing: 0.06em; font-variant-numeric: tabular-nums; }
        .new-count-badge { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; padding: 3px 10px; border-radius: 20px;
          background: rgba(212,175,55,0.12); color: var(--gold2); border: 1px solid rgba(212,175,55,0.3); animation: badgePop 0.5s var(--spring) both; }
        @keyframes badgePop { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: scale(1); } }

        /* ── TABS · animated gold indicator ─────────────────────── */
        .tabs-wrap { display: flex; background: rgba(10,10,10,0.7); backdrop-filter: blur(24px) saturate(160%); -webkit-backdrop-filter: blur(24px) saturate(160%);
          border-bottom: 1px solid var(--border); padding: 0 56px; gap: 4px; position: sticky; top: 100px; z-index: 90; }
        .tab { padding: 18px 20px; font-size: 10px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase;
          color: var(--text-dim); cursor: pointer; border: none; background: transparent; position: relative;
          transition: color 0.4s var(--ease), background 0.4s var(--ease); display: flex; align-items: center; gap: 9px; border-radius: 8px 8px 0 0; }
        .tab::after { content: ""; position: absolute; left: 14px; right: 14px; bottom: -1px; height: 2px; border-radius: 2px;
          background: linear-gradient(90deg, var(--gold3), var(--gold2), var(--gold4));
          transform: scaleX(0); transform-origin: center; transition: transform 0.5s var(--ease), box-shadow 0.5s var(--ease); }
        .tab:hover { color: var(--text); background: rgba(255,255,255,0.025); }
        .tab:hover::after { transform: scaleX(0.45); }
        .tab.active { color: var(--gold4); }
        .tab.active::after { transform: scaleX(1); box-shadow: 0 0 14px rgba(212,175,55,0.45); }
        .tab:active { transform: scale(0.98); }
        .tab-count { font-size: 9px; padding: 2px 8px; border: 1px solid var(--border2); border-radius: 20px; color: var(--text-dim);
          font-family: 'DM Mono', monospace; background: var(--black3); transition: all 0.4s var(--ease); }
        .tab.active .tab-count { border-color: rgba(212,175,55,0.3); color: var(--gold2); background: rgba(212,175,55,0.08); }
        .live-pip { width: 4px; height: 4px; border-radius: 50%; background: var(--green); box-shadow: 0 0 5px var(--green); animation: glow 2s ease-in-out infinite; }

        /* ── CONTENT · fluid tab transitions ─────────────────────── */
        .content { padding: 36px 56px; animation: contentIn 0.5s var(--ease) both; position: relative; z-index: 1; }
        @keyframes contentIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        .hint-bar { display: flex; align-items: center; gap: 20px; font-size: 10px; color: var(--text-dim); letter-spacing: 0.06em;
          margin-bottom: 24px; padding: 12px 20px; border: 1px solid var(--border); background: rgba(17,17,17,0.7); backdrop-filter: blur(10px);
          border-radius: var(--r-md); font-family: 'DM Mono', monospace; transition: border-color 0.5s var(--ease), transform 0.5s var(--ease), box-shadow 0.5s var(--ease); }
        .hint-bar:hover { border-color: rgba(212,175,55,0.3); transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
        .hint-label { font-size: 8px; font-weight: 700; letter-spacing: 0.25em; color: var(--gold2); white-space: nowrap; padding-right: 20px; border-right: 1px solid var(--border); }
        .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }

        /* ── BUTTONS · Apple-style press & lift ─────────────────── */
        .btn { padding: 10px 22px; font-size: 10px; font-weight: 700; letter-spacing: 0.15em; border: none; cursor: pointer;
          text-transform: uppercase; border-radius: 12px; transition: all 0.4s var(--spring); will-change: transform;
          position: relative; overflow: hidden; }
        .btn::after { content: ""; position: absolute; top: 0; bottom: 0; left: -80%; width: 50%;
          background: linear-gradient(105deg, transparent, rgba(255,255,255,0.35), transparent);
          transform: skewX(-20deg); transition: left 0.6s var(--ease); pointer-events: none; }
        .btn-add:hover::after { left: 130%; }
        .btn:active { transform: scale(0.96) !important; transition-duration: 0.1s; }
        .btn-add { background: linear-gradient(135deg, var(--gold2), var(--gold3)); color: var(--black); box-shadow: 0 4px 20px rgba(212,175,55,0.2), inset 0 1px 0 rgba(255,255,255,0.25); }
        .btn-add:hover { background: linear-gradient(135deg, var(--gold4), var(--gold2)); box-shadow: 0 8px 32px rgba(212,175,55,0.4), inset 0 1px 0 rgba(255,255,255,0.35); transform: translateY(-2px); }
        .btn-refresh { background: rgba(255,255,255,0.02); color: var(--text-dim); border: 1px solid var(--border); }
        .btn-refresh:hover:not(:disabled) { color: var(--text); border-color: var(--border2); background: rgba(255,255,255,0.05); transform: translateY(-1px); }
        .btn-refresh:disabled { opacity: 0.3; cursor: not-allowed; }
        .search-inp { background: rgba(17,17,17,0.8); border: 1px solid var(--border); color: var(--text); font-family: 'DM Mono', monospace;
          font-size: 11px; padding: 9px 16px; border-radius: 12px; outline: none; width: 220px; letter-spacing: 0.04em;
          transition: border-color 0.3s var(--ease), box-shadow 0.3s var(--ease), width 0.4s var(--ease), background 0.3s var(--ease); }
        .search-inp:focus { border-color: rgba(212,175,55,0.5); background: rgba(212,175,55,0.04); width: 280px;
          box-shadow: 0 0 0 3px rgba(212,175,55,0.1); }
        .search-inp::placeholder { color: var(--text-mute); }
        .source-badge { font-size: 9px; color: var(--text-mute); letter-spacing: 0.12em; font-weight: 500; margin-left: 4px; }

        /* ── TABLE · soft card, staggered rows ───────────────────── */
        .table-wrap { overflow-x: auto; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(212,175,55,0.14); background: rgba(17,17,17,0.92);
          border-radius: var(--r-lg); overflow-y: hidden; -webkit-overflow-scrolling: touch; touch-action: pan-x pan-y; box-shadow: 0 8px 40px rgba(0,0,0,0.4); transition: box-shadow 0.4s var(--ease), border-color 0.4s var(--ease); }
        .table-wrap:hover { border-color: rgba(212,175,55,0.24); box-shadow: 0 12px 48px rgba(0,0,0,0.5), 0 0 32px rgba(212,175,55,0.06); }
        table { width: 100%; border-collapse: collapse; min-width: 1100px; }
        thead tr { background: rgba(26,26,26,0.9); border-bottom: 1px solid var(--border); }
        th { padding: 16px 14px; font-size: 8px; font-weight: 700; letter-spacing: 0.28em; color: var(--text-dim); text-align: left; white-space: nowrap; transition: color 0.25s var(--ease); }
        th:hover { color: var(--gold1); }
        th:first-child { color: var(--gold1); }
        tbody tr { border-bottom: 1px solid rgba(42,42,42,0.7); transition: background 0.35s var(--ease), box-shadow 0.35s var(--ease); animation: rowIn 0.55s var(--ease) both; }
        tbody tr:nth-child(1) { animation-delay: 0.03s; } tbody tr:nth-child(2) { animation-delay: 0.07s; }
        tbody tr:nth-child(3) { animation-delay: 0.11s; } tbody tr:nth-child(4) { animation-delay: 0.15s; }
        tbody tr:nth-child(5) { animation-delay: 0.19s; } tbody tr:nth-child(6) { animation-delay: 0.23s; }
        tbody tr:nth-child(7) { animation-delay: 0.27s; } tbody tr:nth-child(8) { animation-delay: 0.31s; }
        tbody tr:nth-child(n+9) { animation-delay: 0.35s; }
        @keyframes rowIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        tbody tr:last-child { border-bottom: none; }
        tbody tr:hover { background: rgba(212,175,55,0.035); box-shadow: inset 3px 0 0 rgba(212,175,55,0.55); }
        tbody tr:hover .ticker-inp { color: var(--gold4); }
        tbody tr:hover .pnl-pos { text-shadow: 0 0 14px rgba(34,197,94,0.5); }
        tbody tr:hover .pnl-neg { text-shadow: 0 0 14px rgba(239,68,68,0.5); }
        td { padding: 14px 14px; }
        .cell-input { background: transparent; border: 1px solid transparent; color: var(--text); font-family: 'DM Mono', monospace; font-size: 13px;
          outline: none; padding: 5px 7px; width: 100%; border-radius: 7px; transition: background 0.25s var(--ease), border-color 0.25s var(--ease), box-shadow 0.25s var(--ease); }
        .cell-input:hover { background: rgba(255,255,255,0.03); }
        .cell-input:focus { background: rgba(212,175,55,0.06); border-color: rgba(212,175,55,0.3); box-shadow: 0 0 0 3px rgba(212,175,55,0.08); }
        .cell-input::placeholder { color: var(--text-mute); }
        .ticker-inp { color: var(--gold4); letter-spacing: 0.06em; width: 80px; transition: color 0.25s var(--ease), background 0.25s var(--ease), border-color 0.25s var(--ease), box-shadow 0.25s var(--ease); }
        .num-inp { width: 85px; } .qty-inp { color: var(--gold3); width: 75px; } .date-inp { width: 130px; color-scheme: dark; }
        .dir-sel { border: none; font-size: 10px; font-weight: 700; letter-spacing: 0.15em; cursor: pointer; padding: 5px 12px;
          outline: none; -webkit-appearance: none; text-transform: uppercase; border-radius: 7px; transition: all 0.3s var(--spring); }
        .dir-sel:active { transform: scale(0.95); }
        .dir-long { background: rgba(34,197,94,0.1); color: var(--green); } .dir-short { background: rgba(239,68,68,0.1); color: var(--red); }
        .dir-long:hover { background: rgba(34,197,94,0.2); box-shadow: 0 0 14px rgba(34,197,94,0.15); }
        .dir-short:hover { background: rgba(239,68,68,0.2); box-shadow: 0 0 14px rgba(239,68,68,0.15); }
        .dist-val { color: var(--gold3); font-size: 12px; font-family: 'DM Mono', monospace; font-variant-numeric: tabular-nums; }
        .price-val { color: var(--white); font-family: 'DM Mono', monospace; font-variant-numeric: tabular-nums; transition: color 0.4s var(--ease); }
        .px-up { animation: pxUp 1.2s var(--ease) both; }
        .px-down { animation: pxDown 1.2s var(--ease) both; }
        @keyframes pxUp { 0% { color: var(--green); text-shadow: 0 0 12px rgba(34,197,94,0.55); } 100% { color: var(--white); text-shadow: none; } }
        @keyframes pxDown { 0% { color: var(--red); text-shadow: 0 0 12px rgba(239,68,68,0.55); } 100% { color: var(--white); text-shadow: none; } }
        .value-val { color: var(--gold2); font-family: 'DM Mono', monospace; font-size: 12px; font-variant-numeric: tabular-nums; }
        .fetching { color: var(--text-mute); font-size: 10px; letter-spacing: 0.1em; animation: glow 1.5s infinite; }
        .price-err { color: var(--red); font-size: 10px; } .price-dim { color: var(--text-mute); }
        .pnl-pos { color: var(--green); font-weight: 700; font-size: 14px; font-family: 'DM Mono', monospace; font-variant-numeric: tabular-nums; transition: text-shadow 0.3s var(--ease); }
        .pnl-neg { color: var(--red); font-weight: 700; font-size: 14px; font-family: 'DM Mono', monospace; font-variant-numeric: tabular-nums; transition: text-shadow 0.3s var(--ease); }
        .pnl-zero { color: var(--text-dim); font-family: 'DM Mono', monospace; }
        .del-btn { background: none; border: none; color: var(--text-mute); cursor: pointer; font-size: 12px; padding: 6px 8px;
          transition: all 0.25s var(--spring); border-radius: 7px; }
        .del-btn:hover { color: var(--red); background: rgba(239,68,68,0.08); transform: scale(1.12); }
        .del-btn:active { transform: scale(0.92); }
        .close-pos-btn { background: rgba(212,175,55,0.07); border: 1px solid rgba(212,175,55,0.2); color: var(--gold1); cursor: pointer;
          font-size: 8px; font-weight: 700; letter-spacing: 0.14em; padding: 5px 9px; border-radius: 7px; white-space: nowrap;
          transition: all 0.3s var(--spring); }
        .close-pos-btn:hover { background: rgba(212,175,55,0.15); border-color: var(--gold2); color: var(--gold2); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(212,175,55,0.15); }
        .close-pos-btn:active { transform: scale(0.95); }
        .empty-cell { text-align: center; padding: 72px; color: var(--text-mute); font-size: 10px; letter-spacing: 0.3em; font-weight: 500; }
        .spin { display: inline-block; animation: spin 0.7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .flag-badge { font-size: 8px; font-weight: 700; letter-spacing: 0.16em; padding: 2px 7px; border-radius: 5px; border: 1px solid;
          white-space: nowrap; animation: newpulse 2.5s ease-in-out infinite; }
        @keyframes newpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
        .flag-sel { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; padding: 4px 8px; border-radius: 7px; cursor: pointer;
          border: 1px solid var(--border2); background: transparent; color: var(--text-mute); outline: none;
          -webkit-appearance: none; appearance: none; text-transform: uppercase; transition: all 0.3s var(--ease); }
        .flag-sel:hover { border-color: rgba(212,175,55,0.3); background: rgba(212,175,55,0.04); }
        .flag-sel option { background: var(--black3); color: var(--text); }

        /* ── MODALS · scale-in with depth ─────────────────────────── */
        .modal-overlay { animation: overlayIn 0.45s var(--ease) both; }
        @keyframes overlayIn { from { opacity: 0; } to { opacity: 1; } }
        .modal-card { animation: modalIn 0.6s var(--ease) both; box-shadow: 0 24px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(212,175,55,0.06), inset 0 1px 0 rgba(255,255,255,0.04) !important; }
        @keyframes modalIn {
          0% { opacity: 0; transform: scale(0.96) translateY(14px); filter: blur(6px); }
          60% { filter: blur(0); }
          100% { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); } }
        .modal-card { overflow-anchor: none; overscroll-behavior: contain; }
        .modal-card > * { animation: modalChild 0.5s var(--ease) 0.1s both; }
        @keyframes modalChild { from { opacity: 0; } to { opacity: 1; } }

        /* ── REPORT PANEL · slide from right ─────────────────────── */
        .report-overlay { animation: overlayIn 0.45s var(--ease) both; }
        .report-panel { animation: panelIn 0.7s var(--ease) both; box-shadow: -24px 0 80px rgba(0,0,0,0.6); overflow-anchor: none; overscroll-behavior: contain; }
        @keyframes panelIn { from { transform: translateX(56px); opacity: 0; filter: blur(5px); } to { transform: none; opacity: 1; filter: blur(0); } }
        .report-panel > * { animation: panelChild 0.6s var(--ease) both; }
        .report-panel > *:nth-child(1) { animation-delay: 0.15s; }
        .report-panel > *:nth-child(2) { animation-delay: 0.22s; }
        .report-panel > *:nth-child(3) { animation-delay: 0.29s; }
        .report-panel > *:nth-child(4) { animation-delay: 0.36s; }
        .report-panel > *:nth-child(5) { animation-delay: 0.43s; }
        .report-panel > *:nth-child(n+6) { animation-delay: 0.5s; }
        @keyframes panelChild { from { opacity: 0; } to { opacity: 1; } }

        /* ── MOBILE · responsive layout ───────────────────────────── */
        @media (max-width: 900px) {
          .header { height: auto; min-height: 0; padding: 14px 16px; flex-wrap: wrap; gap: 12px; position: static; }
          .logo-area { gap: 10px; }
          .logo-area img { width: 44px !important; height: 44px !important; }
          .logo-name { font-size: 22px; letter-spacing: 0.18em; }
          .logo-sub { font-size: 7px; letter-spacing: 0.28em; }
          .logo-divider { display: none; }
          .header-right { width: 100%; justify-content: flex-start; overflow-x: auto; -webkit-overflow-scrolling: touch; gap: 0; padding-bottom: 2px; }
          .stat-block { padding: 0 14px; flex: 0 0 auto; text-align: left; animation: none; }
          .stat-block:first-child { border-left: none; padding-left: 0; }
          .stat-val { font-size: 18px; }
          .status-block { padding: 0 0 0 14px; flex: 0 0 auto; align-items: flex-start; }
          .tabs-wrap { padding: 0 8px; top: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
          .tabs-wrap::-webkit-scrollbar { display: none; }
          .tab { padding: 14px 12px; font-size: 9px; letter-spacing: 0.12em; flex: 0 0 auto; }
          .content { padding: 20px 14px; }
          .hint-bar { flex-wrap: wrap; gap: 10px; padding: 10px 14px; font-size: 9px; }
          .hint-label { border-right: none; padding-right: 0; }
          .toolbar { flex-wrap: wrap; }
          .search-inp { width: 100%; flex: 1 1 100%; order: 10; }
          .search-inp:focus { width: 100%; }
          .table-wrap { -webkit-overflow-scrolling: touch; border-radius: var(--r-md); }
          .app::after { display: none; }
          .logo-name { animation: none; background-position: 50% 0; }
          .empty-cell { padding: 48px 20px; }
          .report-panel { width: 100vw !important; max-width: 100vw !important; }
          .modal-card { border-radius: 14px !important; }
        }
        @media (max-width: 480px) {
          .header { padding: 12px 12px; }
          .logo-name { font-size: 19px; }
          .stat-label { font-size: 7px; }
          .stat-val { font-size: 16px; }
          .content { padding: 16px 10px; }
          .btn { padding: 9px 16px; font-size: 9px; }
        }

        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
        }
      `}</style>

      {showReport && (
        <QuarterlyReportPanel closedPositions={closedPositions} allPositions={allPositions} perfSegments={perfSegments} equitySnapshots={equitySnapshots} onClose={() => setShowReport(false)} />
      )}
      {showFreeContent && (
        <FreeContentPanel allPositions={allPositions} closedPositions={closedPositions} perfSegments={perfSegments} onSaveSegments={handleSaveSegments} onClose={() => setShowFreeContent(false)} />
      )}

      <div className="header">
        <div className="logo-area">
          <VSXLogo size={72} />
          <div className="logo-divider" />
          <div>
            <div className="logo-name">VISIONX</div>
            <div className="logo-sub">Portfolio Tracker</div>
          </div>
        </div>
        <div className="header-right">
          <div className="stat-block">
            <div className="stat-label">Positions</div>
            <div className="stat-val" style={{ color: "var(--gold2)" }}>{totalPositions}</div>
          </div>
          <div className="stat-block">
            <div className="stat-label">Pack Avg PnL</div>
            <div className="stat-val" style={{ color: tabPnl === null ? "var(--text-dim)" : tabPnl >= 0 ? "var(--green)" : "var(--red)" }}>
              {tabPnl !== null ? `${tabPnl >= 0 ? "+" : ""}${tabPnl.toFixed(2)}%` : "—"}
            </div>
          </div>
          <div className="stat-block">
            <div className="stat-label">Portfolio PnL</div>
            <div className="stat-val" style={{ color: portfolioPnl === null ? "var(--text-dim)" : portfolioPnl >= 0 ? "var(--green)" : "var(--red)" }}>
              {portfolioPnl !== null ? `${portfolioPnl >= 0 ? "+" : ""}${portfolioPnl.toFixed(2)}%` : "—"}
            </div>
          </div>
          {hasCurrentQData && (
            <div className="stat-block">
              <div className="stat-label">{currentQ.replace("-", " ")} Realised</div>
              <div className="stat-val" style={{ color: currentQPnL >= 0 ? "var(--green)" : "var(--red)" }}>{fmtUSD(currentQPnL)}</div>
            </div>
          )}
          <div className="stat-block">
            <div className="stat-label">Best Performer</div>
            <div className="stat-val" style={{ color: "var(--green)" }}>{topPerformer ? topPerformer.ticker : "—"}</div>
            {topPerformer && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "var(--green)", letterSpacing: "0.04em", marginTop: "2px" }}>+{topPerformer.pnl.toFixed(2)}%</div>}
          </div>
          <div className="stat-block">
            <div className="stat-label">Worst Performer</div>
            <div className="stat-val" style={{ color: worstPerformer && worstPerformer.pnl < 0 ? "var(--red)" : "var(--green)" }}>{worstPerformer ? worstPerformer.ticker : "—"}</div>
            {worstPerformer && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: worstPerformer.pnl < 0 ? "var(--red)" : "var(--green)", letterSpacing: "0.04em", marginTop: "2px" }}>{worstPerformer.pnl >= 0 ? "+" : ""}{worstPerformer.pnl.toFixed(2)}%</div>}
          </div>
          <div className="status-block">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>

              <div className="live-badge"><div className="live-dot" /> ALL LIVE</div>

              {newCount > 0 && <div className="new-count-badge">{newCount} NEW</div>}

            </div>
            {closedPositions.length > 0 && (
              <button onClick={() => setShowReport(true)}
                style={{ background: "rgba(212,175,55,0.07)", border: "1px solid rgba(212,175,55,0.28)", color: "#b99c64", fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", padding: "5px 13px", borderRadius: 5, cursor: "pointer", textTransform: "uppercase", whiteSpace: "nowrap", transition: "all 0.2s" }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(212,175,55,0.14)"; e.currentTarget.style.color = "#d4af37"; e.currentTarget.style.borderColor = "rgba(212,175,55,0.5)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(212,175,55,0.07)"; e.currentTarget.style.color = "#b99c64"; e.currentTarget.style.borderColor = "rgba(212,175,55,0.28)"; }}>
                ▤ QUARTERLY REPORT
              </button>
            )}
            <button onClick={() => setShowFreeContent(true)}
              style={{ background: "rgba(212,175,55,0.07)", border: "1px solid rgba(212,175,55,0.28)", color: "#b99c64", fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", padding: "5px 13px", borderRadius: 5, cursor: "pointer", textTransform: "uppercase", whiteSpace: "nowrap", transition: "all 0.2s" }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(212,175,55,0.14)"; e.currentTarget.style.color = "#d4af37"; e.currentTarget.style.borderColor = "rgba(212,175,55,0.5)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "rgba(212,175,55,0.07)"; e.currentTarget.style.color = "#b99c64"; e.currentTarget.style.borderColor = "rgba(212,175,55,0.28)"; }}>
              ◈ FREE CONTENT
            </button>
            <div className={`save-flash ${savedFlash ? "on" : "off"}`}>✓ SAVED</div>
            {lastRefresh && <div className="refresh-ts">{lastRefresh.toLocaleTimeString()}</div>}
          </div>
        </div>
      </div>

      <div className="tabs-wrap">
        {TABS.map((t) => {
          const count = (allPositions[t.id] || []).filter((p) => p.ticker).length;
          const tabNew = (allPositions[t.id] || []).filter(p => isNew(p)).length;
          const tabClosedCount = closedPositions.filter(c => c.tabId === t.id).length;
          return (
            <button key={t.id} className={`tab ${activeTab === t.id ? "active" : ""}`} onClick={() => setActiveTab(t.id)}>
              {t.label}
              {count > 0 && <span className="tab-count">{count}</span>}
              {tabNew > 0 && <span style={{ fontSize: 8, padding: "1px 6px", borderRadius: 20, background: "rgba(212,175,55,0.15)", color: "var(--gold2)", border: "1px solid rgba(212,175,55,0.3)", letterSpacing: "0.1em", fontWeight: 700 }}>{tabNew}N</span>}
              {tabClosedCount > 0 && <span style={{ fontSize: 8, padding: "1px 6px", borderRadius: 20, background: "rgba(99,102,241,0.1)", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.2)", letterSpacing: "0.1em", fontWeight: 700 }}>{tabClosedCount}C</span>}
              <span className="live-pip" />
            </button>
          );
        })}
      </div>

      <div className="content" ref={contentRef}>
        <PositionTable
          tab={currentTab}
          positions={allPositions[activeTab] || []}
          setPositions={setPosForTab(activeTab)}
          onRefresh={() => refreshTab(activeTab)}
          isRefreshing={!!refreshing[activeTab]}
          anyFocused={anyFocused}
          closedPositions={closedPositions}
          onClosePosition={handleClosePosition}
          onDeleteClosed={handleDeleteClosed}
          onDeleteQuarter={handleDeleteQuarter}
        />
      </div>
    </div>
  );
}
