import { useState, useEffect, useCallback, useRef } from "react";

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

const PLACEHOLDERS = {
  crypto: "BTC", stocks: "MSFT", indices: "^GSPC", commodities: "GC=F", etfs: "SPY",
};
const STOCK_HINT = "US: MSFT  ·  DE: BAS.DE  ·  IT: ENI.MI  ·  FR: MC.PA  ·  CH: NESN.SW  ·  JP: 7203.T";

const FLAGS = {
  "new_position": { label: "NEW POSITION", short: "NEW POS", color: "212,175,55",  textColor: "#d4af37" },
  "stop_adjust":  { label: "STOP ADJUST",  short: "SL ADJ",  color: "99,182,255",  textColor: "#63b6ff" },
  "added":        { label: "ADDED",        short: "ADDED",   color: "34,197,94",   textColor: "#22c55e" },
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

const loadFromStorage = () => {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
};
const saveToStorage = (d) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch {} };
const loadClosedFromStorage = () => {
  try { const r = localStorage.getItem(CLOSED_STORAGE_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
};
const saveClosedToStorage = (d) => { try { localStorage.setItem(CLOSED_STORAGE_KEY, JSON.stringify(d)); } catch {} };

const isFlagged = (p) => p.flag && p.flaggedAt && (Date.now() - p.flaggedAt) < NEW_TTL;
const isNew = (p) => isFlagged(p);

const fetchBinance = async (ticker) => {
  const sym = ticker.toUpperCase().trim();
  const symbol = sym.endsWith("USDT") ? sym : sym + "USDT";
  try { const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`); if (res.ok) { const price = parseFloat((await res.json()).price); if (price > 0) return price; } } catch {}
  try { const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`); if (res.ok) { const price = parseFloat((await res.json()).price); if (price > 0) return price; } } catch {}
  return null;
};

const PROXIES = [
  (u) => fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => JSON.parse(d.contents)),
  (u) => fetch(`https://corsproxy.io/?${encodeURIComponent(u)}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
  (u) => fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
  (u) => fetch(`https://yacdn.org/proxy/${u}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
];

const fetchYahooSingle = async (ticker) => {
  const raw = ticker.toUpperCase().trim();
  const pairs = [
    [`https://query1.finance.yahoo.com/v6/finance/quote?symbols=${raw}`, (d) => { const r = d?.quoteResponse?.result?.[0]; return r?.regularMarketPrice || r?.ask || null; }],
    [`https://query2.finance.yahoo.com/v6/finance/quote?symbols=${raw}`, (d) => { const r = d?.quoteResponse?.result?.[0]; return r?.regularMarketPrice || r?.ask || null; }],
    [`https://query1.finance.yahoo.com/v8/finance/chart/${raw}?interval=1d&range=5d`, (d) => { const m = d?.chart?.result?.[0]?.meta; return m?.regularMarketPrice || m?.chartPreviousClose || null; }],
    [`https://query2.finance.yahoo.com/v8/finance/chart/${raw}?interval=1d&range=5d`, (d) => { const m = d?.chart?.result?.[0]?.meta; return m?.regularMarketPrice || m?.chartPreviousClose || null; }],
  ];
  for (const [url, extract] of pairs) {
    for (const px of PROXIES) {
      try { const data = await px(url); const price = extract(data); if (price && price > 0) return price; } catch { continue; }
    }
  }
  return null;
};

const fetchYahooBatch = async (tickers) => {
  const BATCH_SIZE = 10; const results = {};
  tickers.forEach(t => { results[t] = null; });
  const chunks = [];
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) chunks.push(tickers.slice(i, i + BATCH_SIZE));
  for (const chunk of chunks) {
    const symbols = chunk.join(","); let items = null;
    for (const base of ["query1", "query2"]) {
      const url = `https://${base}.finance.yahoo.com/v6/finance/quote?symbols=${symbols}`;
      for (const px of PROXIES) {
        try { const data = await px(url); const res = data?.quoteResponse?.result; if (res?.length) { items = res; break; } } catch { continue; }
        if (items) break;
      }
      if (items) break;
    }
    if (items) {
      items.forEach(item => { const price = item.regularMarketPrice || item.ask || item.bid; if (item.symbol && price && price > 0) results[item.symbol] = price; });
      for (const ticker of chunk) { if (results[ticker] === null) results[ticker] = await fetchYahooSingle(ticker); }
    } else { for (const ticker of chunk) results[ticker] = await fetchYahooSingle(ticker); }
  }
  return results;
};

const calcPnL = (dir, entry, cur) => {
  if (!entry || !cur || isNaN(entry) || isNaN(cur)) return null;
  return dir === "LONG" ? ((cur - entry) / entry) * 100 : ((entry - cur) / entry) * 100;
};
const calcPnLUSD = (dir, entry, closePrice, qty) => {
  if (!entry || !closePrice || !qty || isNaN(entry) || isNaN(closePrice) || isNaN(parseFloat(qty))) return null;
  const q = parseFloat(qty);
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
const fmtValue = (qty, price) => {
  if (!qty || !price || isNaN(parseFloat(qty)) || isNaN(price)) return null;
  return (parseFloat(qty) * price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  flag: null, flaggedAt: null,
  currentPrice: null, loading: false, error: false,
});
const EMPTY_STATE = Object.fromEntries(TABS.map((t) => [t.id, []]));

const VSXLogo = ({ size = 72 }) => (
  <img src="https://i.postimg.cc/pd4xzT1r/87011e66-b8e4-4d2b-9977-a06bb4b29902.png"
    width={size} height={size} alt="VisionX Logo"
    style={{ objectFit: "contain", display: "block", filter: "drop-shadow(0 0 16px rgba(212,175,55,0.5))" }} />
);

// ── QUARTERLY REPORT PANEL ────────────────────────────────────────────────────
function QuarterlyReportPanel({ tab, closedPositions, activePositions, onClose }) {
  const [selectedQ, setSelectedQ] = useState(getQuarter(new Date()));

  const tabClosed = closedPositions.filter(c => c.tabId === tab.id);
  const quarters = sortedQuarters(tabClosed.map(c => c.quarter));
  if (!quarters.includes(selectedQ) && quarters.length > 0) {
    // default to most recent available
  }
  const qData = selectedQ ? tabClosed.filter(c => c.quarter === selectedQ) : [];

  // Stats
  const totalTrades = qData.length;
  const winners = qData.filter(c => (c.pnlUSD || 0) > 0);
  const losers  = qData.filter(c => (c.pnlUSD || 0) <= 0);
  const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : null;
  const totalPnL = qData.reduce((s, c) => s + (c.pnlUSD || 0), 0);
  const avgPnLPct = totalTrades > 0 ? qData.reduce((s, c) => s + (c.pnlPct || 0), 0) / totalTrades : null;
  const avgWin = winners.length > 0 ? winners.reduce((s, c) => s + (c.pnlUSD || 0), 0) / winners.length : null;
  const avgLoss = losers.length > 0 ? losers.reduce((s, c) => s + (c.pnlUSD || 0), 0) / losers.length : null;
  const rr = avgWin && avgLoss && avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;
  const avgHold = totalTrades > 0 ? Math.round(qData.reduce((s, c) => s + (c.daysHeld || 0), 0) / totalTrades) : null;
  const bestTrade = totalTrades > 0 ? qData.reduce((a, b) => (a.pnlUSD || 0) > (b.pnlUSD || 0) ? a : b) : null;
  const worstTrade = totalTrades > 0 ? qData.reduce((a, b) => (a.pnlUSD || 0) < (b.pnlUSD || 0) ? a : b) : null;
  const byReason = Object.entries(CLOSE_REASONS).map(([k, v]) => ({
    key: k, label: v, count: qData.filter(c => c.reason === k).length,
    pnl: qData.filter(c => c.reason === k).reduce((s, c) => s + (c.pnlUSD || 0), 0),
  })).filter(r => r.count > 0);
  const longTrades = qData.filter(c => c.direction === "LONG");
  const shortTrades = qData.filter(c => c.direction === "SHORT");
  const longPnL = longTrades.reduce((s, c) => s + (c.pnlUSD || 0), 0);
  const shortPnL = shortTrades.reduce((s, c) => s + (c.pnlUSD || 0), 0);

  // Previous quarter for QoQ
  const qList = getQuarterOptions();
  const qIdx = qList.indexOf(selectedQ);
  const prevQ = qIdx < qList.length - 1 ? qList[qIdx + 1] : null;
  const prevQData = prevQ ? tabClosed.filter(c => c.quarter === prevQ) : [];
  const prevQPnL = prevQData.reduce((s, c) => s + (c.pnlUSD || 0), 0);
  const qoqChange = prevQData.length > 0 ? totalPnL - prevQPnL : null;

  // Active (open) positions for this tab
  const openPositions = (activePositions || []).filter(p => p.ticker.trim());

  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const [qLabel, qYear] = selectedQ.split("-");

  const S = {
    overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 9998, display: "flex", justifyContent: "flex-end", backdropFilter: "blur(6px)" },
    panel: { width: 720, maxWidth: "95vw", height: "100vh", overflowY: "auto", background: "#0d0d0d", borderLeft: "1px solid #222", display: "flex", flexDirection: "column" },
    header: { padding: "28px 32px 20px", borderBottom: "1px solid #1a1a1a", background: "#0a0a0a", position: "sticky", top: 0, zIndex: 10 },
    section: { padding: "24px 32px", borderBottom: "1px solid #111" },
    sectionTitle: { fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.28em", color: "#555", textTransform: "uppercase", marginBottom: 16 },
    statGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 },
    statCard: { background: "#111", border: "1px solid #1a1a1a", borderRadius: 8, padding: "12px 14px" },
    statLabel: { fontFamily: "'Montserrat', sans-serif", fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#444", textTransform: "uppercase", marginBottom: 5 },
    statVal: { fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, letterSpacing: "0.04em", lineHeight: 1 },
    statSub: { fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555", marginTop: 3 },
    divider: { height: 1, background: "#111", margin: "0 32px" },
    tradeRow: { display: "flex", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #0f0f0f" },
  };

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.panel} id="report-print-area">

        {/* PANEL HEADER */}
        <div style={S.header}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.3em", color: "#555", textTransform: "uppercase", marginBottom: 6 }}>
                VISIONX ANALYTICS · QUARTERLY REPORT
              </div>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, letterSpacing: "0.14em", color: "#f8e49b", lineHeight: 1 }}>
                {tab.label.toUpperCase()} PACK
              </div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555", marginTop: 4 }}>
                Generated {today} · Confidential
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <select
                value={selectedQ}
                onChange={e => setSelectedQ(e.target.value)}
                style={{ background: "#111", border: "1px solid #222", color: "#d4af37", fontFamily: "'Bebas Neue', sans-serif", fontSize: 16, letterSpacing: "0.1em", padding: "7px 14px", borderRadius: 6, outline: "none", cursor: "pointer" }}
              >
                {quarters.length > 0 ? quarters.map(q => (
                  <option key={q} value={q}>{getQuarterLabel(q)}</option>
                )) : <option value="">{getQuarterLabel(selectedQ)}</option>}
              </select>
              <button
                onClick={() => {
                  const win = window.open("", "_blank");
                  const qLabel = selectedQ.replace("-", " ");
                  const packLabel = tab.label.toUpperCase() + " PACK";
                  const todayStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
                  const _qData = closedPositions.filter(c => c.tabId === tab.id && c.quarter === selectedQ);
                  const _open  = (activePositions || []).filter(p => p.ticker.trim());
                  const _totalPnL = _qData.reduce((s,c) => s+(c.pnlUSD||0), 0);
                  const _wins  = _qData.filter(c=>(c.pnlUSD||0)>0);
                  const _winRate = _qData.length > 0 ? ((_wins.length/_qData.length)*100).toFixed(0) : null;
                  const _avgHold = _qData.length > 0 ? Math.round(_qData.reduce((s,c)=>s+(c.daysHeld||0),0)/_qData.length) : null;
                  const _avgPct  = _qData.length > 0 ? (_qData.reduce((s,c)=>s+(c.pnlPct||0),0)/_qData.length).toFixed(2) : null;
                  const _best  = _qData.length > 0 ? _qData.reduce((a,b)=>(a.pnlUSD||0)>(b.pnlUSD||0)?a:b) : null;
                  const _worst = _qData.length > 0 ? _qData.reduce((a,b)=>(a.pnlUSD||0)<(b.pnlUSD||0)?a:b) : null;
                  const _long  = _qData.filter(c=>c.direction==="LONG");
                  const _short = _qData.filter(c=>c.direction==="SHORT");
                  const _longPnL  = _long.reduce((s,c)=>s+(c.pnlUSD||0),0);
                  const _shortPnL = _short.reduce((s,c)=>s+(c.pnlUSD||0),0);
                  const gc = (v) => v >= 0 ? "#22c55e" : "#ef4444";
                  const gb = (v) => v >= 0 ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.18)";
                  const fu = (v) => { if(v==null) return "—"; const a=Math.abs(v); return (v>=0?"+":"-")+"$"+a.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); };
                  const fp = (p) => { if(p==null) return "—"; if(p<0.01) return p.toFixed(6); if(p<1) return p.toFixed(4); if(p<100) return p.toFixed(3); return p.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); };
                  const GOLD="#d4af37"; const GOLD2="#f8e49b"; const GOLD3="#b99c64";
                  const BG1="#080808"; const BG2="#0f0f0f"; const BG3="#141414";
                  const BORDER="#1e1e1e"; const BORDER2="#2a2a2a";
                  const TEXT="#e8e8e8"; const MUTE="#555"; const DIM="#333";

                  // ── TRADE LOG ROWS ──
                  const tradeRows = _qData.sort((a,b)=>b.closedAt-a.closedAt).map((c,i) => {
                    const rowBg = i%2===0 ? BG2 : BG3;
                    return `<tr style="background:${rowBg}">
                      <td style="padding:10px 12px;color:${DIM};font-size:10px;font-family:'DM Mono',monospace">${String(i+1).padStart(2,"0")}</td>
                      <td style="padding:10px 12px;color:${GOLD};font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:0.06em">${c.ticker}</td>
                      <td style="padding:10px 12px"><span style="font-size:8px;font-weight:700;letter-spacing:0.1em;padding:3px 9px;border-radius:3px;background:${c.direction==="LONG"?"rgba(34,197,94,0.12)":"rgba(239,68,68,0.12)"};color:${c.direction==="LONG"?"#22c55e":"#ef4444"}">${c.direction}</span></td>
                      <td style="padding:10px 12px;color:#888;font-family:'DM Mono',monospace;font-size:11px">${c.qty||"—"}</td>
                      <td style="padding:10px 12px;color:#888;font-family:'DM Mono',monospace;font-size:11px">${c.entry?fp(parseFloat(c.entry)):"—"}</td>
                      <td style="padding:10px 12px;color:${TEXT};font-family:'DM Mono',monospace;font-size:11px">${fp(c.closePrice)}</td>
                      <td style="padding:10px 12px;color:${MUTE};font-family:'DM Mono',monospace;font-size:10px">${c.entryDate||"—"}</td>
                      <td style="padding:10px 12px;color:${MUTE};font-family:'DM Mono',monospace;font-size:10px">${c.closeDate||"—"}</td>
                      <td style="padding:10px 12px;color:${MUTE};font-family:'DM Mono',monospace;font-size:10px">${c.daysHeld!=null?c.daysHeld+"d":"—"}</td>
                      <td style="padding:10px 12px;color:${gc(c.pnlPct||0)};font-family:'DM Mono',monospace;font-size:11px">${c.pnlPct!=null?(c.pnlPct>=0?"+":"")+c.pnlPct.toFixed(2)+"%":"—"}</td>
                      <td style="padding:10px 12px;color:${gc(c.pnlUSD||0)};font-weight:700;font-family:'DM Mono',monospace;font-size:12px">${fu(c.pnlUSD)}</td>
                      <td style="padding:10px 12px;color:#444;font-family:'DM Mono',monospace;font-size:10px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.note||"—"}</td>
                    </tr>`;
                  }).join("");

                  // ── OPEN POSITION ROWS ──
                  const openRows = _open.map((p,i) => {
                    const ep = parseFloat(p.entry);
                    const upct = p.currentPrice ? (p.direction==="LONG"?((p.currentPrice-ep)/ep)*100:((ep-p.currentPrice)/ep)*100) : null;
                    const uusd = p.currentPrice&&p.qty ? (p.direction==="LONG"?(p.currentPrice-ep)*parseFloat(p.qty):(ep-p.currentPrice)*parseFloat(p.qty)) : null;
                    const rowBg = i%2===0 ? BG2 : BG3;
                    return `<tr style="background:${rowBg}">
                      <td style="padding:10px 12px;color:${GOLD};font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:0.06em">${p.ticker}</td>
                      <td style="padding:10px 12px"><span style="font-size:8px;font-weight:700;letter-spacing:0.1em;padding:3px 9px;border-radius:3px;background:${p.direction==="LONG"?"rgba(34,197,94,0.12)":"rgba(239,68,68,0.12)"};color:${p.direction==="LONG"?"#22c55e":"#ef4444"}">${p.direction}</span></td>
                      <td style="padding:10px 12px;color:#888;font-family:'DM Mono',monospace;font-size:11px">${p.qty||"—"}</td>
                      <td style="padding:10px 12px;color:#888;font-family:'DM Mono',monospace;font-size:11px">${p.entry?fp(ep):"—"}</td>
                      <td style="padding:10px 12px;color:${TEXT};font-family:'DM Mono',monospace;font-size:11px">${p.currentPrice?fp(p.currentPrice):"—"}</td>
                      <td style="padding:10px 12px;color:${upct!=null?gc(upct):DIM};font-family:'DM Mono',monospace;font-size:11px">${upct!=null?(upct>=0?"+":"")+upct.toFixed(2)+"%":"—"}</td>
                      <td style="padding:10px 12px;color:${uusd!=null?gc(uusd):DIM};font-weight:700;font-family:'DM Mono',monospace;font-size:12px">${fu(uusd)}</td>
                      <td style="padding:10px 12px;color:${MUTE};font-family:'DM Mono',monospace;font-size:10px">${p.date||"—"}</td>
                    </tr>`;
                  }).join("");

                  // ── TRADE HIGHLIGHTS ──
                  const highlightsHtml = (_best||_worst) ? `
                  <section style="margin-bottom:36px">
                    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
                      <div style="width:3px;height:16px;background:${GOLD3};border-radius:2px"></div>
                      <div style="font-size:8px;font-weight:700;letter-spacing:0.3em;color:${MUTE};text-transform:uppercase">Trade Highlights</div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                      ${[{label:"BEST TRADE",trade:_best},{label:"WORST TRADE",trade:_worst}].map(({label,trade})=>{
                        if(!trade) return `<div style="background:${BG2};border:1px solid ${BORDER};border-radius:10px;padding:20px 22px"><div style="font-size:7px;letter-spacing:0.24em;color:${DIM};text-transform:uppercase;margin-bottom:10px">${label}</div><div style="color:${DIM};font-size:13px;font-family:'DM Mono',monospace">—</div></div>`;
                        const tc=trade.pnlUSD>=0?"#22c55e":"#ef4444";
                        const trgb=trade.pnlUSD>=0?"34,197,94":"239,68,68";
                        return `<div style="background:${BG2};border:1px solid rgba(${trgb},0.25);border-radius:10px;padding:20px 22px;border-left:3px solid ${tc}">
                          <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:12px">${label}</div>
                          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                            <span style="font-family:'Bebas Neue',sans-serif;font-size:24px;color:${GOLD};letter-spacing:0.06em">${trade.ticker}</span>
                            <span style="font-size:8px;font-weight:700;letter-spacing:0.12em;padding:3px 9px;border-radius:3px;background:${trade.direction==="LONG"?"rgba(34,197,94,0.1)":"rgba(239,68,68,0.1)"};color:${trade.direction==="LONG"?"#22c55e":"#ef4444"}">${trade.direction}</span>
                          </div>
                          <div style="font-family:'Bebas Neue',sans-serif;font-size:30px;color:${tc};letter-spacing:0.02em;margin-bottom:6px">${fu(trade.pnlUSD)}</div>
                          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${trade.pnlPct!=null?(trade.pnlPct>=0?"+":"")+trade.pnlPct.toFixed(2)+"%":""} · ${trade.daysHeld}d hold</div>
                        </div>`;
                      }).join("")}
                    </div>
                  </section>` : "";

                  // ── OPEN SNAPSHOT SECTION ──
                  const openSectionHtml = _open.length > 0 ? `
                  <div style="page-break-before:always;min-height:100vh;padding:52px 56px;display:flex;flex-direction:column;background:${BG1}">
                    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid ${BORDER};padding-bottom:22px;margin-bottom:30px">
                      <div>
                        <div style="font-size:7px;font-weight:700;letter-spacing:0.3em;color:${MUTE};text-transform:uppercase;margin-bottom:8px">VISIONX ANALYTICS · ${qLabel}</div>
                        <div style="font-family:'Bebas Neue',sans-serif;font-size:32px;letter-spacing:0.14em;color:${GOLD2}">${packLabel} — OPEN POSITIONS</div>
                      </div>
                      <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${todayStr}</div>
                    </div>
                    <table style="width:100%;border-collapse:collapse;border:1px solid ${BORDER};border-radius:8px;overflow:hidden">
                      <thead><tr style="background:#0c0c0c;border-bottom:1px solid ${BORDER2}">
                        ${["TICKER","DIR","QTY","ENTRY","LIVE PRICE","UNRLSD %","UNRLSD USD","ENTRY DATE"].map(h=>`<th style="padding:11px 12px;font-family:'Montserrat',sans-serif;font-size:7px;letter-spacing:0.22em;color:${MUTE};text-align:left;font-weight:700;white-space:nowrap">${h}</th>`).join("")}
                      </tr></thead>
                      <tbody>${openRows}</tbody>
                    </table>
                    <div style="flex:1"></div>
                    <div style="border-top:1px solid ${BORDER};padding-top:14px;display:flex;justify-content:space-between">
                      <div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM};letter-spacing:0.08em">VISIONX ANALYTICS · ${packLabel} · ${qLabel} · CONFIDENTIAL</div>
                      <div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM}">2</div>
                    </div>
                  </div>` : "";

                  // ── TRADE LOG PAGE ──
                  const logPageNum = _open.length > 0 ? 3 : 2;
                  const tradeLogHtml = `
                  <div style="page-break-before:always;padding:52px 56px;background:${BG1}">
                    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid ${BORDER};padding-bottom:22px;margin-bottom:30px">
                      <div>
                        <div style="font-size:7px;font-weight:700;letter-spacing:0.3em;color:${MUTE};text-transform:uppercase;margin-bottom:8px">VISIONX ANALYTICS · ${qLabel}</div>
                        <div style="font-family:'Bebas Neue',sans-serif;font-size:32px;letter-spacing:0.14em;color:${GOLD2}">${packLabel} — COMPLETE TRADE LOG</div>
                      </div>
                      <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${todayStr}</div>
                    </div>
                    <table style="width:100%;border-collapse:collapse;border:1px solid ${BORDER};overflow:hidden">
                      <thead><tr style="background:#0c0c0c;border-bottom:2px solid ${BORDER2}">
                        ${["#","TICKER","DIR","QTY","ENTRY","CLOSE","ENTRY DATE","CLOSE DATE","DAYS","PNL %","PNL USD","NOTE"].map(h=>`<th style="padding:11px 12px;font-family:'Montserrat',sans-serif;font-size:7px;letter-spacing:0.2em;color:${MUTE};text-align:left;font-weight:700;white-space:nowrap">${h}</th>`).join("")}
                      </tr></thead>
                      <tbody>${tradeRows}</tbody>
                    </table>
                    <div style="margin-top:18px;padding:16px 20px;background:${BG2};border:1px solid ${BORDER};border-radius:8px;display:flex;justify-content:space-between;align-items:center">
                      <div style="font-size:8px;font-weight:700;letter-spacing:0.2em;color:${MUTE};text-transform:uppercase">${_qData.length} Trades · ${_winRate||"—"}% Win Rate · ${_avgHold!=null?_avgHold+"d avg hold":"—"}</div>
                      <div style="font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:0.04em;color:${gc(_totalPnL)}">${fu(_totalPnL)}</div>
                    </div>
                    <div style="margin-top:28px;border-top:1px solid ${BORDER};padding-top:14px;display:flex;justify-content:space-between">
                      <div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM};letter-spacing:0.08em">VISIONX ANALYTICS · ${packLabel} · ${qLabel} · CONFIDENTIAL</div>
                      <div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM}">${logPageNum}</div>
                    </div>
                  </div>`;

                  // ── LONG/SHORT BREAKDOWN ──
                  const lsHtml = `
                  <section style="margin-bottom:36px">
                    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
                      <div style="width:3px;height:16px;background:${GOLD3};border-radius:2px"></div>
                      <div style="font-size:8px;font-weight:700;letter-spacing:0.3em;color:${MUTE};text-transform:uppercase">Long vs Short Breakdown</div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                      ${[{label:"LONG POSITIONS",trades:_long,pnl:_longPnL},{label:"SHORT POSITIONS",trades:_short,pnl:_shortPnL}].map(({label,trades,pnl})=>{
                        const pc=trades.length===0?DIM:pnl>=0?"#22c55e":"#ef4444";
                        const br=trades.length===0?"80,80,80":pnl>=0?"34,197,94":"239,68,68";
                        const leftColor=trades.length===0?"#333":pnl>=0?"#22c55e":"#ef4444";
                        return `<div style="background:${BG2};border:1px solid rgba(${br},0.18);border-radius:10px;padding:20px 22px;border-left:3px solid ${leftColor}">
                          <div style="font-size:7px;font-weight:700;letter-spacing:0.22em;color:${MUTE};text-transform:uppercase;margin-bottom:12px">${label}</div>
                          <div style="font-family:'Bebas Neue',sans-serif;font-size:28px;color:${pc};margin-bottom:8px">${trades.length>0?fu(pnl):"—"}</div>
                          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${trades.length} trade${trades.length!==1?"s":""}${trades.length>0?" · "+trades.filter(t=>(t.pnlUSD||0)>0).length+"W / "+trades.filter(t=>(t.pnlUSD||0)<=0).length+"L":""}</div>
                        </div>`;
                      }).join("")}
                    </div>
                  </section>`;

                  win.document.write(`<!DOCTYPE html><html><head>
                    <meta charset="utf-8">
                    <title>VisionX ${packLabel} ${qLabel} Report</title>
                    <link rel="preconnect" href="https://fonts.googleapis.com">
                    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Bebas+Neue&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
                    <style>
                      *{box-sizing:border-box;margin:0;padding:0}
                      html,body{background:${BG1};color:${TEXT};font-family:'Montserrat',sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
                      @page{size:A4;margin:0}
                      section{break-inside:avoid}
                    </style>
                  </head><body>

                  <!-- ══ PAGE 1: EXECUTIVE SUMMARY ══ -->
                  <div style="min-height:100vh;padding:0;display:flex;flex-direction:column;background:${BG1}">

                    <!-- Gold top bar -->
                    <div style="height:4px;background:linear-gradient(90deg,${GOLD3},${GOLD},${GOLD2},${GOLD})"></div>

                    <div style="padding:44px 56px;flex:1;display:flex;flex-direction:column">

                      <!-- Header -->
                      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:36px;padding-bottom:24px;border-bottom:1px solid ${BORDER}">
                        <div>
                          <div style="font-size:7px;font-weight:700;letter-spacing:0.36em;color:${MUTE};text-transform:uppercase;margin-bottom:10px">VISIONX ANALYTICS · QUARTERLY PERFORMANCE REPORT</div>
                          <div style="font-family:'Bebas Neue',sans-serif;font-size:54px;letter-spacing:0.14em;color:${GOLD2};line-height:1">${packLabel}</div>
                        </div>
                        <div style="text-align:right;padding-top:6px">
                          <div style="font-family:'Bebas Neue',sans-serif;font-size:26px;letter-spacing:0.1em;color:${GOLD3};margin-bottom:4px">${qLabel}</div>
                          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE}">${todayStr}</div>
                          <div style="font-size:8px;font-weight:700;letter-spacing:0.2em;color:${DIM};text-transform:uppercase;margin-top:4px">Confidential</div>
                        </div>
                      </div>

                      <!-- Hero PnL -->
                      <section style="background:${BG2};border:1px solid ${_totalPnL>=0?"rgba(34,197,94,0.25)":"rgba(239,68,68,0.25)"};border-left:4px solid ${gc(_totalPnL)};border-radius:12px;padding:28px 32px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between">
                        <div>
                          <div style="font-size:8px;font-weight:700;letter-spacing:0.26em;color:${MUTE};text-transform:uppercase;margin-bottom:12px">Total Realised P&L · ${qLabel}</div>
                          <div style="font-family:'Bebas Neue',sans-serif;font-size:60px;color:${gc(_totalPnL)};line-height:1;letter-spacing:0.01em">${fu(_totalPnL)}</div>
                          ${_avgPct!==null?`<div style="font-family:'DM Mono',monospace;font-size:12px;color:${gc(parseFloat(_avgPct))};margin-top:8px;opacity:0.8">Avg ${parseFloat(_avgPct)>=0?"+":""}${_avgPct}% per trade</div>`:""}
                        </div>
                        <div style="text-align:right">
                          <div style="font-size:7px;letter-spacing:0.22em;color:${MUTE};text-transform:uppercase;margin-bottom:6px">Closed Trades</div>
                          <div style="font-family:'Bebas Neue',sans-serif;font-size:44px;color:${GOLD};line-height:1">${_qData.length}</div>
                        </div>
                      </section>

                      <!-- Stats row -->
                      <section style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:28px">
                        <div style="background:${BG2};border:1px solid ${BORDER};border-radius:10px;padding:18px 20px">
                          <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:10px">Win Rate</div>
                          <div style="font-family:'Bebas Neue',sans-serif;font-size:34px;color:${_winRate!=null?(parseFloat(_winRate)>=50?"#22c55e":"#ef4444"):MUTE}">${_winRate!=null?_winRate+"%":"—"}</div>
                          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE};margin-top:5px">${_wins.length}W / ${_qData.length-_wins.length}L</div>
                        </div>
                        <div style="background:${BG2};border:1px solid ${BORDER};border-radius:10px;padding:18px 20px">
                          <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:10px">Avg Hold Time</div>
                          <div style="font-family:'Bebas Neue',sans-serif;font-size:34px;color:${GOLD}">${_avgHold!=null?_avgHold+"D":"—"}</div>
                          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE};margin-top:5px">per trade</div>
                        </div>
                        <div style="background:${BG2};border:1px solid ${BORDER};border-radius:10px;padding:18px 20px">
                          <div style="font-size:7px;font-weight:700;letter-spacing:0.24em;color:${MUTE};text-transform:uppercase;margin-bottom:10px">Open Positions</div>
                          <div style="font-family:'Bebas Neue',sans-serif;font-size:34px;color:${GOLD}">${_open.length}</div>
                          <div style="font-family:'DM Mono',monospace;font-size:10px;color:${MUTE};margin-top:5px">currently active</div>
                        </div>
                      </section>

                      <!-- Long/Short -->
                      ${lsHtml}

                      <!-- Trade highlights -->
                      ${highlightsHtml}

                      <div style="flex:1"></div>
                    </div>

                    <!-- Footer -->
                    <div style="padding:14px 56px;border-top:1px solid ${BORDER};display:flex;justify-content:space-between;align-items:center">
                      <div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM};letter-spacing:0.1em">VISIONX ANALYTICS · ${packLabel} · ${qLabel} · CONFIDENTIAL</div>
                      <div style="font-family:'DM Mono',monospace;font-size:8px;color:${DIM}">1</div>
                    </div>
                    <div style="height:3px;background:linear-gradient(90deg,${GOLD3},${GOLD},${GOLD2},${GOLD})"></div>
                  </div>

                  ${openSectionHtml}
                  ${tradeLogHtml}

                  </body></html>`);
                  win.document.close();
                  setTimeout(() => { win.focus(); win.print(); }, 1000);
                }}
                style={{ background: "rgba(212,175,55,0.07)", border: "1px solid rgba(212,175,55,0.25)", color: "#b99c64", fontFamily: "'Montserrat',sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", padding: "7px 14px", borderRadius: 6, cursor: "pointer", textTransform: "uppercase", transition: "all 0.2s" }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(212,175,55,0.14)"; e.currentTarget.style.color = "#d4af37"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(212,175,55,0.07)"; e.currentTarget.style.color = "#b99c64"; }}
              >⬇ PDF</button>
              <button onClick={onClose} style={{ background: "none", border: "1px solid #222", color: "#444", cursor: "pointer", fontSize: 14, padding: "7px 12px", borderRadius: 6, transition: "color 0.2s, border-color 0.2s" }}
                onMouseEnter={e => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.3)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#444"; e.currentTarget.style.borderColor = "#222"; }}>✕</button>
            </div>
          </div>

          {/* Quarter selector pills */}
          {quarters.length > 1 && (
            <div style={{ display: "flex", gap: 6 }}>
              {quarters.map(q => (
                <button key={q} onClick={() => setSelectedQ(q)}
                  style={{ background: selectedQ === q ? "rgba(212,175,55,0.12)" : "transparent", border: `1px solid ${selectedQ === q ? "rgba(212,175,55,0.35)" : "#1a1a1a"}`, color: selectedQ === q ? "#d4af37" : "#444", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", padding: "5px 14px", borderRadius: 20, cursor: "pointer", transition: "all 0.2s" }}>
                  {getQuarterLabel(q)}
                </button>
              ))}
            </div>
          )}
        </div>

        {totalTrades === 0 ? (
          <div style={{ padding: "72px 32px", textAlign: "center", fontFamily: "'Montserrat', sans-serif", fontSize: 10, letterSpacing: "0.3em", color: "#2a2a2a" }}>
            NO CLOSED POSITIONS FOR {getQuarterLabel(selectedQ)}
          </div>
        ) : (<>

          {/* EXECUTIVE SUMMARY */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Executive Summary</div>

            {/* Headline PnL */}
            <div style={{ background: "#111", border: `1px solid ${totalPnL >= 0 ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`, borderRadius: 10, padding: "18px 22px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.22em", color: "#555", textTransform: "uppercase", marginBottom: 6 }}>
                  Total Realised P&L · {getQuarterLabel(selectedQ)}
                </div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 42, letterSpacing: "0.04em", color: totalPnL >= 0 ? "#22c55e" : "#ef4444", lineHeight: 1 }}>
                  {fmtUSD(totalPnL)}
                </div>
                {avgPnLPct !== null && (
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: totalPnL >= 0 ? "#22c55e" : "#ef4444", marginTop: 4, opacity: 0.7 }}>
                    Avg {avgPnLPct >= 0 ? "+" : ""}{avgPnLPct.toFixed(2)}% per trade
                  </div>
                )}
              </div>
              <div style={{ textAlign: "right" }}>
                {qoqChange !== null && (
                  <div>
                    <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.2em", color: "#444", textTransform: "uppercase", marginBottom: 4 }}>vs {getQuarterLabel(prevQ)}</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, color: qoqChange >= 0 ? "#22c55e" : "#ef4444" }}>
                      {qoqChange >= 0 ? "+" : ""}{fmtUSD(qoqChange).slice(1)}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Stat grid */}
            <div style={S.statGrid}>
              <div style={S.statCard}>
                <div style={S.statLabel}>Win Rate</div>
                <div style={{ ...S.statVal, color: (winRate || 0) >= 50 ? "#22c55e" : "#ef4444" }}>
                  {winRate !== null ? `${winRate.toFixed(0)}%` : "—"}
                </div>
                <div style={S.statSub}>{winners.length}W / {losers.length}L</div>
              </div>
              <div style={S.statCard}>
                <div style={S.statLabel}>Total Trades</div>
                <div style={{ ...S.statVal, color: "#d4af37" }}>{totalTrades}</div>
                <div style={S.statSub}>{avgHold}d avg hold</div>
              </div>
              <div style={S.statCard}>
                <div style={S.statLabel}>Open Positions</div>
                <div style={{ ...S.statVal, color: "#d4af37" }}>{openPositions.length}</div>
                <div style={S.statSub}>currently active</div>
              </div>
            </div>
          </div>

          {/* DIRECTION BREAKDOWN */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Long vs Short Breakdown</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { label: "Long Positions", trades: longTrades, pnl: longPnL },
                { label: "Short Positions", trades: shortTrades, pnl: shortPnL },
              ].map(({ label, trades, pnl }) => {
                const _pnlColor = trades.length === 0 ? "#555" : pnl >= 0 ? "#22c55e" : "#ef4444";
                const _borderRgb = trades.length === 0 ? "255,255,255" : pnl >= 0 ? "34,197,94" : "239,68,68";
                return (
                <div key={label} style={{ background: "#111", border: `1px solid rgba(${_borderRgb},0.12)`, borderRadius: 8, padding: "14px 16px" }}>
                  <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.2em", color: "#444", textTransform: "uppercase", marginBottom: 10 }}>{label}</div>
                  <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 24, color: _pnlColor, marginBottom: 6 }}>
                    {trades.length > 0 ? fmtUSD(pnl) : "—"}
                  </div>
                  <div style={{ display: "flex", gap: 16 }}>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>{trades.length} trade{trades.length !== 1 ? "s" : ""}</div>
                    {trades.length > 0 && (
                      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>
                        {trades.filter(t => (t.pnlUSD || 0) > 0).length}W / {trades.filter(t => (t.pnlUSD || 0) <= 0).length}L
                      </div>
                    )}
                  </div>
                </div>
              );})}
            </div>
          </div>

          {/* BEST & WORST */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Trade Highlights</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { label: "Best Trade", trade: bestTrade },
                { label: "Worst Trade", trade: worstTrade },
              ].map(({ label, trade }) => {
                const _tc = trade ? (trade.pnlUSD >= 0 ? "#22c55e" : "#ef4444") : "#ef4444";
                const _trgb = trade ? (trade.pnlUSD >= 0 ? "34,197,94" : "239,68,68") : "239,68,68";
                return (
                <div key={label} style={{ background: "#111", border: `1px solid rgba(${_trgb},0.15)`, borderRadius: 8, padding: "14px 16px" }}>
                  <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 7, fontWeight: 700, letterSpacing: "0.22em", color: "#444", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
                  {trade ? (<>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, color: "#d4af37", letterSpacing: "0.06em" }}>{trade.ticker}</span>
                      <span style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: trade.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", color: trade.direction === "LONG" ? "#22c55e" : "#ef4444", fontFamily: "'Montserrat', sans-serif", fontWeight: 700, letterSpacing: "0.12em" }}>{trade.direction}</span>
                    </div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 26, color: _tc, marginBottom: 4 }}>{fmtUSD(trade.pnlUSD)}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>
                      {trade.pnlPct != null ? `${trade.pnlPct >= 0 ? "+" : ""}${trade.pnlPct.toFixed(2)}%` : ""} · {trade.daysHeld}d · {CLOSE_REASONS[trade.reason] || trade.reason}
                    </div>
                  </>) : <div style={{ color: "#333", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>—</div>}
                </div>
              );})}
            </div>
          </div>


          {/* OPEN POSITIONS SNAPSHOT */}
          {openPositions.length > 0 && (
            <div style={S.section}>
              <div style={S.sectionTitle}>Open Positions Snapshot (as of report date)</div>
              <div style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "#333", marginBottom: 12, letterSpacing: "0.06em" }}>
                Unrealised P&L calculated at last known live price.
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1a1a1a" }}>
                    {["TICKER", "DIR", "QTY", "ENTRY", "LIVE PRICE", "UNREALISED %", "UNREALISED USD", "ENTRY DATE"].map(h => (
                      <th key={h} style={{ padding: "7px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.2em", color: "#333", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map(p => {
                    const entry = parseFloat(p.entry);
                    const pnlPct = calcPnL(p.direction, entry, p.currentPrice);
                    const pnlUSD = calcPnLUSD(p.direction, entry, p.currentPrice, p.qty);
                    return (
                      <tr key={p.id} style={{ borderBottom: "1px solid #0f0f0f" }}>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#d4af37" }}>{p.ticker}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: p.direction === "LONG" ? "#22c55e" : "#ef4444" }}>{p.direction}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{p.qty || "—"}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{p.entry ? fmtPrice(entry) : "—"}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#e8e8e8" }}>{p.currentPrice ? fmtPrice(p.currentPrice) : <span style={{ color: "#333" }}>—</span>}</td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: pnlPct !== null ? (pnlPct >= 0 ? "#22c55e" : "#ef4444") : "#333" }}>
                          {pnlPct !== null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "—"}
                        </td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontWeight: 600, color: pnlUSD !== null ? (pnlUSD >= 0 ? "#22c55e" : "#ef4444") : "#333" }}>
                          {pnlUSD !== null ? fmtUSD(pnlUSD) : "—"}
                        </td>
                        <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>{p.date || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* FULL TRADE LOG */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Complete Trade Log · {getQuarterLabel(selectedQ)}</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1a1a1a" }}>
                  {["#", "TICKER", "DIR", "QTY", "ENTRY", "CLOSE", "ENTRY DATE", "CLOSE DATE", "DAYS", "EXIT REASON", "PNL %", "PNL USD", "NOTE"].map(h => (
                    <th key={h} style={{ padding: "7px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 7, letterSpacing: "0.2em", color: "#333", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {qData.sort((a, b) => b.closedAt - a.closedAt).map((c, i) => (
                  <tr key={c.id} style={{ borderBottom: "1px solid #0d0d0d" }}>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#333" }}>{String(i + 1).padStart(2, "0")}</td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#d4af37" }}>{c.ticker}</td>
                    <td style={{ padding: "9px 8px", fontFamily: "'Montserrat', sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: c.direction === "LONG" ? "#22c55e" : "#ef4444" }}>{c.direction}</td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{c.qty || "—"}</td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#888" }}>{c.entry ? fmtPrice(parseFloat(c.entry)) : "—"}</td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#e8e8e8" }}>{fmtPrice(c.closePrice)}</td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>{c.entryDate || "—"}</td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#555" }}>{c.closeDate || "—"}</td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#555" }}>{c.daysHeld != null ? `${c.daysHeld}d` : "—"}</td>
                    <td style={{ padding: "9px 8px" }}>
                      <span style={{ fontSize: 8, padding: "2px 7px", borderRadius: 3, background: "#1a1a1a", border: "1px solid #222", color: "#555", letterSpacing: "0.08em", fontFamily: "'Montserrat', sans-serif", fontWeight: 600 }}>
                        {CLOSE_REASONS[c.reason] || c.reason}
                      </span>
                    </td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: c.pnlPct != null ? (c.pnlPct >= 0 ? "#22c55e" : "#ef4444") : "#555" }}>
                      {c.pnlPct != null ? `${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct.toFixed(2)}%` : "—"}
                    </td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontWeight: 600, color: (c.pnlUSD || 0) >= 0 ? "#22c55e" : "#ef4444" }}>
                      {c.pnlUSD != null ? fmtUSD(c.pnlUSD) : "—"}
                    </td>
                    <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#444", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.note || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* FOOTER */}
          <div style={{ padding: "20px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#2a2a2a", letterSpacing: "0.08em" }}>
              VISIONX ANALYTICS · {tab.label.toUpperCase()} PACK · {getQuarterLabel(selectedQ)} · CONFIDENTIAL
            </div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#2a2a2a" }}>{today}</div>
          </div>

        </>)}
      </div>
    </div>
  );
}

// ── CLOSE POSITION MODAL ──────────────────────────────────────────────────────
function ClosePositionModal({ position, tabId, tabLabel, onClose, onConfirm }) {
  const [closePrice, setClosePrice] = useState(position.currentPrice ? String(position.currentPrice) : "");
  const [quarter, setQuarter] = useState(getQuarter(new Date()));
  const [reason, setReason] = useState("tp");
  const [note, setNote] = useState("");

  const entry = parseFloat(position.entry);
  const cp = parseFloat(closePrice);
  const pnlPct = (!isNaN(entry) && !isNaN(cp) && cp > 0) ? calcPnL(position.direction, entry, cp) : null;
  const pnlUSD = (!isNaN(entry) && !isNaN(cp) && cp > 0 && position.qty) ? calcPnLUSD(position.direction, entry, cp, position.qty) : null;
  const daysHeld = position.date ? daysBetween(position.date, new Date().toISOString().split("T")[0]) : null;
  const isPos = pnlUSD !== null ? pnlUSD >= 0 : null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(4px)" }}>
      <div style={{ background: "#111", border: "1px solid #2a2a2a", borderRadius: 14, width: 520, maxWidth: "95vw", padding: "28px 28px 24px", fontFamily: "'Montserrat', sans-serif", color: "#e8e8e8", boxShadow: "0 0 80px rgba(0,0,0,0.8)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 26, letterSpacing: "0.18em", color: "#f8e49b", lineHeight: 1 }}>CLOSE POSITION</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", padding: "3px 10px", borderRadius: 4, background: "rgba(212,175,55,0.1)", border: "1px solid rgba(212,175,55,0.25)", color: "#d4af37", fontWeight: 700 }}>{quarter}</span>
              <span style={{ fontSize: 9, letterSpacing: "0.14em", padding: "3px 10px", borderRadius: 4, background: "rgba(255,255,255,0.04)", border: "1px solid #222", color: "#666", fontWeight: 600 }}>{tabLabel.toUpperCase()} PACK</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 18, padding: "4px 8px", borderRadius: 4, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 8, padding: "14px 16px", marginBottom: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px 12px" }}>
          {[{ label: "Ticker", val: position.ticker, color: "#d4af37" }, { label: "Direction", val: position.direction, color: position.direction === "LONG" ? "#22c55e" : "#ef4444" }, { label: "Quantity", val: position.qty || "—", color: "#e8e8e8" }, { label: "Entry Price", val: fmtPrice(parseFloat(position.entry)), color: "#e8e8e8" }, { label: "Entry Date", val: position.date || "—", color: "#666" }, { label: "Days Held", val: daysHeld !== null ? `${daysHeld}d` : "—", color: "#666" }].map(({ label, val, color }) => (
            <div key={label}>
              <div style={{ fontSize: 8, letterSpacing: "0.22em", color: "#444", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color }}>{val}</div>
            </div>
          ))}
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Close Price (USD)</label>
          <input type="number" value={closePrice} onChange={e => setClosePrice(e.target.value)} placeholder="Enter close price…"
            style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 14, padding: "10px 12px", borderRadius: 6, outline: "none" }} />
          {position.currentPrice && (
            <div style={{ fontSize: 10, color: "#444", marginTop: 5, letterSpacing: "0.04em" }}>
              Live price: {fmtPrice(position.currentPrice)} · <span onClick={() => setClosePrice(String(position.currentPrice))} style={{ color: "#b99c64", cursor: "pointer", textDecoration: "underline" }}>use live price</span>
            </div>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Quarter</label>
            <select value={quarter} onChange={e => setQuarter(e.target.value)} style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "10px 12px", borderRadius: 6, outline: "none" }}>
              {getQuarterOptions().map(q => <option key={q} value={q}>{q.replace("-", " ")}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Close Reason</label>
            <select value={reason} onChange={e => setReason(e.target.value)} style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "10px 12px", borderRadius: 6, outline: "none" }}>
              {Object.entries(CLOSE_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 9, letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Note (optional)</label>
          <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Wave 5 complete, target hit"
            style={{ width: "100%", background: "#0a0a0a", border: "1px solid #222", color: "#e8e8e8", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "10px 12px", borderRadius: 6, outline: "none" }} />
        </div>
        <div style={{ background: "#0a0a0a", border: `1px solid ${isPos === null ? "#1a1a1a" : isPos ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`, borderRadius: 8, padding: "14px 16px", marginBottom: 22, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#444", textTransform: "uppercase", marginBottom: 5 }}>Realised P&L</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: isPos === null ? "#444" : isPos ? "#22c55e" : "#ef4444" }}>
              {pnlPct !== null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "—"}
            </div>
          </div>
          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 30, letterSpacing: "0.04em", color: isPos === null ? "#333" : isPos ? "#22c55e" : "#ef4444" }}>
            {pnlUSD !== null ? fmtUSD(pnlUSD) : "—"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid #222", color: "#666", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 20px", borderRadius: 6, cursor: "pointer", textTransform: "uppercase" }}>CANCEL</button>
          <button onClick={() => {
            const record = { id: position.id, ticker: position.ticker, direction: position.direction, qty: position.qty, entry: position.entry, sl: position.sl, entryDate: position.date, closeDate: new Date().toISOString().split("T")[0], closePrice: cp, closePriceDisplay: fmtPrice(cp), pnlPct, pnlUSD, quarter, reason, note, tabId, tabLabel, daysHeld, closedAt: Date.now() };
            onConfirm(record);
          }} disabled={!closePrice || isNaN(cp) || cp <= 0}
            style={{ background: closePrice && !isNaN(cp) && cp > 0 ? "linear-gradient(135deg, #d4af37, #c59958)" : "#1a1a1a", color: closePrice && !isNaN(cp) && cp > 0 ? "#0a0a0a" : "#333", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 24px", borderRadius: 6, cursor: closePrice && !isNaN(cp) && cp > 0 ? "pointer" : "not-allowed", border: "none", textTransform: "uppercase" }}>
            CONFIRM CLOSE
          </button>
        </div>
      </div>
    </div>
  );
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
  const winners = tabClosed.filter(c => (c.pnlUSD || 0) > 0).length;

  return (
    <div style={{ marginTop: 32, border: "1px solid #1a1a1a", borderRadius: 12, overflow: "hidden" }}>
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
            const qWin = qTrades.filter(c => (c.pnlUSD || 0) > 0).length;
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
                    {/* DELETE QUARTER BUTTON */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete all ${qTrades.length} closed position(s) for ${getQuarterLabel(q)} from ${tabLabel} history?\n\nThis cannot be undone.`)) {
                          onDeleteQuarter(tabId, q);
                        }
                      }}
                      title={`Clear ${getQuarterLabel(q)} — remove after report is sent`}
                      style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)", color: "#555", fontFamily: "'Montserrat', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", padding: "4px 10px", borderRadius: 4, cursor: "pointer", textTransform: "uppercase", transition: "all 0.2s", whiteSpace: "nowrap" }}
                      onMouseEnter={e => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)"; e.currentTarget.style.background = "rgba(239,68,68,0.1)"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = "#555"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.15)"; e.currentTarget.style.background = "rgba(239,68,68,0.06)"; }}
                    >
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
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", color: "#d4af37" }}>{c.ticker}</td>
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
                            <td style={{ padding: "9px 8px", fontFamily: "'DM Mono', monospace", fontWeight: 600, color: (c.pnlUSD || 0) >= 0 ? "#22c55e" : "#ef4444" }}>
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

// ── TABLE ─────────────────────────────────────────────────────────────────────
function PositionTable({ tab, positions, setPositions, onRefresh, isRefreshing, anyFocused, closedPositions, onClosePosition, onDeleteClosed, onDeleteQuarter, onOpenReport }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [search, setSearch] = useState("");
  const [focusedId, setFocusedId] = useState(null);
  const [closingPosition, setClosingPosition] = useState(null);

  const setFocus = (id) => { setFocusedId(id); if (anyFocused) anyFocused.current = true; };
  const clearFocus = () => { setFocusedId(null); if (anyFocused) anyFocused.current = false; };

  const update = (id, f, v) => setPositions((prev) => prev.map((p) => (p.id === id ? { ...p, [f]: v } : p)));
  const remove = (id) => { if (window.confirm("Delete this position?")) setPositions((prev) => prev.filter((p) => p.id !== id)); };
  const add = () => setPositions((prev) => [...prev, newRow()]);
  const setFlag = (id, type) => setPositions((prev) => prev.map((p) => p.id !== id ? p : { ...p, flag: type || null, flaggedAt: type ? Date.now() : null }));

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
  const sorted = [...filtered].sort((a, b) => {
    if (!sortKey) return 0;
    if (a.id === focusedId || b.id === focusedId) return 0;
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

  const tabHasClosedData = closedPositions.some(c => c.tabId === tab.id);

  return (
    <div>
      {closingPosition && (
        <ClosePositionModal position={closingPosition} tabId={tab.id} tabLabel={tab.label}
          onClose={() => setClosingPosition(null)}
          onConfirm={(record) => { onClosePosition(record, closingPosition.id); setClosingPosition(null); }} />
      )}
      {tab.id === "stocks" && (
        <div className="hint-bar"><span className="hint-label">FORMAT</span>{STOCK_HINT}</div>
      )}
      <div className="toolbar">
        <button className="btn btn-add" onClick={add}>+ ADD POSITION</button>
        <button className="btn btn-refresh" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? <span className="spin">↻</span> : "↻"} REFRESH
        </button>
        <input className="search-inp" placeholder="Search ticker, date, direction…" value={search} onChange={e => setSearch(e.target.value)} />
        <span className="source-badge">{tab.source === "binance" ? "BINANCE · 15s AUTO" : "YAHOO FINANCE · 30s AUTO"}</span>
        {/* QUARTERLY REPORT BUTTON */}
        {tabHasClosedData && (
          <button onClick={onOpenReport}
            style={{ marginLeft: "auto", background: "transparent", border: "1px solid rgba(212,175,55,0.25)", color: "#b99c64", fontFamily: "'Montserrat', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", padding: "10px 20px", borderRadius: 6, cursor: "pointer", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 8, transition: "all 0.25s", whiteSpace: "nowrap" }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(212,175,55,0.08)"; e.currentTarget.style.color = "#d4af37"; e.currentTarget.style.borderColor = "rgba(212,175,55,0.45)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#b99c64"; e.currentTarget.style.borderColor = "rgba(212,175,55,0.25)"; }}>
            <span style={{ fontSize: 13 }}>▤</span> QUARTERLY REPORT
          </button>
        )}
      </div>
      <div className="table-wrap">
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
              const entry = parseFloat(p.entry);
              const sl = parseFloat(p.sl);
              const pnl = calcPnL(p.direction, entry, p.currentPrice);
              const dist = calcSLDist(p.direction, p.currentPrice, sl);
              const posValue = fmtValue(p.qty, p.currentPrice);
              const flagged = isFlagged(p);
              const flagCfg = flagged ? FLAGS[p.flag] : null;
              const timeLeft = flagged ? Math.ceil((NEW_TTL - (Date.now() - p.flaggedAt)) / 3600000) : 0;
              const rowBorderColor = flagCfg ? `rgba(${flagCfg.color},0.4)` : "transparent";
              const rowBg = flagCfg ? `rgba(${flagCfg.color},0.04)` : "";
              return (
                <tr key={p.id} style={flagged ? { background: rowBg, borderLeft: `2px solid ${rowBorderColor}` } : {}}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input className="cell-input ticker-inp" placeholder={PLACEHOLDERS[tab.id]} value={p.ticker}
                        onChange={(e) => update(p.id, "ticker", e.target.value.toUpperCase())}
                        onFocus={() => setFocus(p.id)} onBlur={() => { clearFocus(); if (p.ticker.trim()) onRefresh(); }} />
                      {flagged && flagCfg && (
                        <span className="flag-badge" style={{ color: flagCfg.textColor, borderColor: `rgba(${flagCfg.color},0.4)`, background: `rgba(${flagCfg.color},0.12)` }}>{flagCfg.short}</span>
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
                  <td><span className="dist-val">{dist !== null && !isNaN(dist) ? `${dist.toFixed(2)}%` : "—"}</span></td>
                  <td><input className="cell-input date-inp" type="date" value={p.date} onChange={(e) => update(p.id, "date", e.target.value)} onFocus={() => setFocus(p.id)} onBlur={() => clearFocus()} /></td>
                  <td>{p.loading ? <span className="fetching">LOADING</span> : p.error ? <span className="price-err">N/A</span> : p.currentPrice !== null ? <span className="price-val">{fmtPrice(p.currentPrice)}</span> : <span className="price-dim">—</span>}</td>
                  <td>{posValue !== null ? <span className="value-val">{posValue}</span> : <span className="price-dim">—</span>}</td>
                  <td>{pnl !== null && !isNaN(pnl) ? <span className={pnl > 0.005 ? "pnl-pos" : pnl < -0.005 ? "pnl-neg" : "pnl-zero"}>{pnl > 0 ? "+" : ""}{pnl.toFixed(2)}%</span> : <span className="price-dim">—</span>}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <select className="flag-sel" value={flagged ? p.flag : ""} onChange={(e) => setFlag(p.id, e.target.value || null)}
                        style={flagCfg ? { color: flagCfg.textColor, borderColor: `rgba(${flagCfg.color},0.4)`, background: `rgba(${flagCfg.color},0.08)` } : {}}>
                        <option value="">— NONE —</option>
                        <option value="new_position">NEW POSITION</option>
                        <option value="stop_adjust">STOP ADJUST</option>
                        <option value="added">ADDED</option>
                      </select>
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
  const [allPositions, setAllPositions] = useState(() => {
    const stored = loadFromStorage();
    if (!stored) return EMPTY_STATE;
    return Object.fromEntries(Object.entries(stored).map(([id, rows]) => [id, rows.map(r => ({ qty: "", flag: null, flaggedAt: null, ...r }))]));
  });
  const [closedPositions, setClosedPositions] = useState(() => loadClosedFromStorage().list || []);
  const [refreshing, setRefreshing] = useState({});
  const [lastRefresh, setLastRefresh] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [reportTab, setReportTab] = useState(null);
  const anyFocused = useRef(false);

  useEffect(() => {
    const t = setInterval(() => {
      setAllPositions(prev => {
        let changed = false;
        const next = Object.fromEntries(Object.entries(prev).map(([id, rows]) => [id, rows.map(p => {
          if (p.flaggedAt && !isFlagged(p)) { changed = true; return { ...p, flag: null, flaggedAt: null }; }
          return p;
        })]));
        if (changed) { const toSave = Object.fromEntries(Object.entries(next).map(([id, rows]) => [id, rows.map(({ currentPrice, loading, error, ...r }) => r)])); saveToStorage(toSave); }
        return changed ? next : prev;
      });
    }, 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { setSavedFlash(true); const t = setTimeout(() => setSavedFlash(false), 1400); return () => clearTimeout(t); }, [allPositions, closedPositions]);

  const setPosForTab = (tabId) => (updater) => setAllPositions((prev) => {
    const next = { ...prev, [tabId]: typeof updater === "function" ? updater(prev[tabId]) : updater };
    const toSave = Object.fromEntries(Object.entries(next).map(([id, rows]) => [id, rows.map(({ currentPrice, loading, error, ...r }) => r)]));
    saveToStorage(toSave);
    return next;
  });

  const handleClosePosition = (record, positionId) => {
    const newClosed = [...closedPositions, record];
    setClosedPositions(newClosed);
    saveClosedToStorage({ list: newClosed });
    setAllPositions(prev => {
      const next = { ...prev, [record.tabId]: prev[record.tabId].filter(p => p.id !== positionId) };
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
    const snapshot = allPositions[tabId] || [];
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
  }, [allPositions]);

  useEffect(() => {
    const intervals = TABS.map((tab) => {
      const ms = tab.source === "binance" ? 15000 : 30000;
      return setInterval(() => {
        if (!anyFocused.current && (allPositions[tab.id] || []).some((p) => p.ticker.trim())) refreshTab(tab.id);
      }, ms);
    });
    return () => intervals.forEach(clearInterval);
  }, [allPositions, refreshTab]);

  const allRows = Object.values(allPositions).flat();
  const totalPositions = allRows.filter((p) => p.ticker).length;
  const portfolioPnlVals = allRows.map((p) => calcPnL(p.direction, parseFloat(p.entry), p.currentPrice)).filter((v) => v !== null && !isNaN(v));
  const portfolioPnl = portfolioPnlVals.length ? portfolioPnlVals.reduce((a, b) => a + b, 0) / portfolioPnlVals.length : null;
  const tabPnlVals = (allPositions[activeTab] || []).map((p) => calcPnL(p.direction, parseFloat(p.entry), p.currentPrice)).filter((v) => v !== null && !isNaN(v));
  const tabPnl = tabPnlVals.length ? tabPnlVals.reduce((a, b) => a + b, 0) / tabPnlVals.length : null;
  const currentTab = TABS.find((t) => t.id === activeTab);
  const tabRowsWithPnl = (allPositions[activeTab] || []).map((p) => ({ ...p, pnl: calcPnL(p.direction, parseFloat(p.entry), p.currentPrice) })).filter((p) => p.ticker && p.pnl !== null && !isNaN(p.pnl));
  const topPerformer = tabRowsWithPnl.length ? tabRowsWithPnl.reduce((a, b) => a.pnl > b.pnl ? a : b) : null;
  const worstPerformer = tabRowsWithPnl.length ? tabRowsWithPnl.reduce((a, b) => a.pnl < b.pnl ? a : b) : null;
  const newCount = allRows.filter(p => isNew(p)).length;
  const currentQ = getQuarter(new Date());
  const currentQPnL = closedPositions.filter(c => c.quarter === currentQ).reduce((s, c) => s + (c.pnlUSD || 0), 0);
  const hasCurrentQData = closedPositions.some(c => c.quarter === currentQ);

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&family=Bebas+Neue&family=DM+Mono:wght@300;400;500&display=swap');
        :root { --black:#0a0a0a; --black2:#111111; --black3:#1a1a1a; --border:#222222; --border2:#2a2a2a; --gold1:#b99c64; --gold2:#d4af37; --gold3:#c59958; --gold4:#f8e49b; --white:#fdfdfd; --text:#e8e8e8; --text-dim:#666; --text-mute:#333; --green:#22c55e; --red:#ef4444; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--black); }
        .app { min-height: 100vh; background: var(--black); font-family: 'Montserrat', sans-serif; color: var(--text); }
        .header { height: 100px; padding: 0 56px; display: flex; align-items: center; justify-content: space-between; background: rgba(10,10,10,0.85); backdrop-filter: blur(24px); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 100; }
        .logo-area { display: flex; align-items: center; gap: 16px; }
        .logo-divider { width: 1px; height: 40px; background: linear-gradient(180deg, transparent, rgba(212,175,55,0.4), transparent); margin: 0 6px; }
        .logo-name { font-family: 'Bebas Neue', sans-serif; font-size: 32px; letter-spacing: 0.25em; color: var(--white); line-height: 1; background: linear-gradient(135deg, #fff 0%, #e8e8e8 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .logo-sub { font-size: 8px; letter-spacing: 0.4em; color: var(--gold1); line-height: 1.6; font-family: 'Montserrat', sans-serif; font-weight: 500; text-transform: uppercase; }
        .header-right { display: flex; align-items: center; gap: 0; }
        .stat-block { padding: 0 22px; border-left: 1px solid var(--border); text-align: right; transition: background 0.25s; cursor: default; }
        .stat-block:hover { background: rgba(255,255,255,0.02); }
        .stat-label { font-size: 8px; font-weight: 600; letter-spacing: 0.22em; color: var(--text-dim); text-transform: uppercase; margin-bottom: 4px; }
        .stat-val { font-family: 'Bebas Neue', sans-serif; font-size: 22px; letter-spacing: 0.04em; line-height: 1; transition: color 0.4s, transform 0.2s; }
        .stat-block:hover .stat-val { transform: scale(1.03); }
        .status-block { padding: 0 0 0 22px; border-left: 1px solid var(--border); display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
        .live-badge { display: flex; align-items: center; gap: 7px; padding: 5px 14px; border: 1px solid rgba(34,197,94,0.2); background: rgba(34,197,94,0.06); border-radius: 20px; font-size: 8px; font-weight: 600; letter-spacing: 0.22em; color: var(--green); }
        .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); box-shadow: 0 0 10px var(--green); animation: glow 2s ease-in-out infinite; }
        @keyframes glow { 0%,100% { opacity: 1; box-shadow: 0 0 10px var(--green); } 50% { opacity: 0.3; box-shadow: 0 0 3px var(--green); } }
        .save-flash { font-size: 8px; letter-spacing: 0.18em; color: var(--gold2); transition: opacity 0.4s; font-weight: 500; }
        .save-flash.on { opacity: 1; } .save-flash.off { opacity: 0; }
        .refresh-ts { font-size: 9px; color: var(--text-mute); letter-spacing: 0.06em; }
        .new-count-badge { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; padding: 3px 10px; border-radius: 20px; background: rgba(212,175,55,0.12); color: var(--gold2); border: 1px solid rgba(212,175,55,0.3); }
        .tabs-wrap { display: flex; background: var(--black); border-bottom: 1px solid var(--border); padding: 0 56px; gap: 4px; }
        .tab { padding: 18px 20px; font-size: 10px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-dim); cursor: pointer; border: none; background: transparent; border-bottom: 1px solid transparent; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); position: relative; bottom: -1px; display: flex; align-items: center; gap: 9px; }
        .tab:hover { color: var(--text); background: rgba(255,255,255,0.02); }
        .tab.active { color: var(--gold4); border-bottom-color: var(--gold2); }
        .tab-count { font-size: 9px; padding: 2px 8px; border: 1px solid var(--border2); border-radius: 20px; color: var(--text-dim); font-family: 'DM Mono', monospace; background: var(--black3); transition: all 0.25s; }
        .tab.active .tab-count { border-color: rgba(212,175,55,0.3); color: var(--gold2); background: rgba(212,175,55,0.08); }
        .live-pip { width: 4px; height: 4px; border-radius: 50%; background: var(--green); box-shadow: 0 0 5px var(--green); animation: glow 2s ease-in-out infinite; }
        .content { padding: 36px 56px; }
        .hint-bar { display: flex; align-items: center; gap: 20px; font-size: 10px; color: var(--text-dim); letter-spacing: 0.06em; margin-bottom: 24px; padding: 12px 20px; border: 1px solid var(--border); background: var(--black2); border-radius: 8px; font-family: 'DM Mono', monospace; }
        .hint-bar:hover { border-color: var(--gold1); }
        .hint-label { font-size: 8px; font-weight: 700; letter-spacing: 0.25em; color: var(--gold2); white-space: nowrap; padding-right: 20px; border-right: 1px solid var(--border); }
        .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
        .btn { padding: 10px 22px; font-size: 10px; font-weight: 700; letter-spacing: 0.15em; border: none; cursor: pointer; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); text-transform: uppercase; border-radius: 6px; }
        .btn-add { background: linear-gradient(135deg, var(--gold2), var(--gold3)); color: var(--black); box-shadow: 0 0 20px rgba(212,175,55,0.2); }
        .btn-add:hover { background: linear-gradient(135deg, var(--gold4), var(--gold2)); box-shadow: 0 0 35px rgba(212,175,55,0.4); transform: translateY(-2px) scale(1.02); }
        .btn-refresh { background: transparent; color: var(--text-dim); border: 1px solid var(--border); border-radius: 6px; }
        .btn-refresh:hover:not(:disabled) { color: var(--text); border-color: var(--border2); background: var(--black2); transform: translateY(-1px); }
        .btn-refresh:disabled { opacity: 0.3; cursor: not-allowed; }
        .search-inp { background: var(--black2); border: 1px solid var(--border); color: var(--text); font-family: 'DM Mono', monospace; font-size: 11px; padding: 8px 14px; border-radius: 6px; outline: none; width: 220px; letter-spacing: 0.04em; transition: border-color 0.2s; }
        .search-inp:focus { border-color: var(--gold1); background: rgba(212,175,55,0.04); }
        .search-inp::placeholder { color: var(--text-mute); }
        .source-badge { font-size: 9px; color: var(--text-mute); letter-spacing: 0.12em; font-weight: 500; margin-left: 4px; }
        .table-wrap { border: 1px solid var(--border); overflow-x: auto; background: var(--black2); border-radius: 12px; overflow: hidden; }
        .table-wrap:hover { border-color: var(--border2); }
        table { width: 100%; border-collapse: collapse; min-width: 1100px; }
        thead tr { background: var(--black3); border-bottom: 1px solid var(--border); }
        th { padding: 14px 12px; font-size: 8px; font-weight: 700; letter-spacing: 0.28em; color: var(--text-dim); text-align: left; white-space: nowrap; }
        th:first-child { color: var(--gold1); }
        tbody tr { border-bottom: 1px solid var(--border); transition: background 0.2s; }
        tbody tr:last-child { border-bottom: none; }
        tbody tr:hover { background: rgba(212,175,55,0.03); }
        tbody tr:hover .ticker-inp { color: var(--gold4); }
        tbody tr:hover .pnl-pos { text-shadow: 0 0 12px rgba(34,197,94,0.4); }
        tbody tr:hover .pnl-neg { text-shadow: 0 0 12px rgba(239,68,68,0.4); }
        td { padding: 12px 12px; }
        .cell-input { background: transparent; border: none; color: var(--text); font-family: 'DM Mono', monospace; font-size: 13px; outline: none; padding: 4px 6px; width: 100%; transition: background 0.2s; border-radius: 4px; }
        .cell-input:focus { background: rgba(212,175,55,0.05); }
        .cell-input::placeholder { color: var(--text-mute); }
        .ticker-inp { color: var(--gold4); letter-spacing: 0.06em; width: 80px; transition: color 0.2s; }
        .num-inp { width: 85px; } .qty-inp { color: var(--gold3); width: 75px; } .date-inp { width: 130px; color-scheme: dark; }
        .dir-sel { border: none; font-size: 10px; font-weight: 700; letter-spacing: 0.15em; cursor: pointer; padding: 5px 12px; outline: none; -webkit-appearance: none; text-transform: uppercase; border-radius: 4px; transition: all 0.2s; }
        .dir-long { background: rgba(34,197,94,0.1); color: var(--green); } .dir-short { background: rgba(239,68,68,0.1); color: var(--red); }
        .dir-long:hover { background: rgba(34,197,94,0.2); } .dir-short:hover { background: rgba(239,68,68,0.2); }
        .dist-val { color: var(--gold3); font-size: 12px; font-family: 'DM Mono', monospace; }
        .price-val { color: var(--white); font-family: 'DM Mono', monospace; }
        .value-val { color: var(--gold2); font-family: 'DM Mono', monospace; font-size: 12px; }
        .fetching { color: var(--text-mute); font-size: 10px; letter-spacing: 0.1em; animation: glow 1.5s infinite; }
        .price-err { color: var(--red); font-size: 10px; } .price-dim { color: var(--text-mute); }
        .pnl-pos { color: var(--green); font-weight: 600; font-family: 'DM Mono', monospace; transition: text-shadow 0.2s; }
        .pnl-neg { color: var(--red); font-weight: 600; font-family: 'DM Mono', monospace; transition: text-shadow 0.2s; }
        .pnl-zero { color: var(--text-dim); font-family: 'DM Mono', monospace; }
        .del-btn { background: none; border: none; color: var(--text-mute); cursor: pointer; font-size: 12px; padding: 6px 8px; transition: all 0.2s; border-radius: 4px; }
        .del-btn:hover { color: var(--red); background: rgba(239,68,68,0.08); }
        .close-pos-btn { background: rgba(212,175,55,0.07); border: 1px solid rgba(212,175,55,0.2); color: var(--gold1); cursor: pointer; font-size: 8px; font-weight: 700; letter-spacing: 0.14em; padding: 5px 9px; transition: all 0.2s; border-radius: 4px; white-space: nowrap; }
        .close-pos-btn:hover { background: rgba(212,175,55,0.15); border-color: var(--gold2); color: var(--gold2); }
        .empty-cell { text-align: center; padding: 72px; color: var(--text-mute); font-size: 10px; letter-spacing: 0.3em; font-weight: 500; }
        .spin { display: inline-block; animation: spin 0.7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .flag-badge { font-size: 8px; font-weight: 700; letter-spacing: 0.16em; padding: 2px 7px; border-radius: 4px; border: 1px solid; white-space: nowrap; animation: newpulse 2.5s ease-in-out infinite; }
        @keyframes newpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .flag-sel { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; padding: 4px 8px; border-radius: 4px; cursor: pointer; border: 1px solid var(--border2); background: transparent; color: var(--text-mute); transition: all 0.2s; outline: none; -webkit-appearance: none; appearance: none; text-transform: uppercase; }
        .flag-sel:hover { border-color: rgba(212,175,55,0.3); }
        .flag-sel option { background: var(--black3); color: var(--text); }
      `}</style>

      {/* QUARTERLY REPORT PANEL */}
      {reportTab && (
        <QuarterlyReportPanel
          tab={reportTab}
          closedPositions={closedPositions}
          activePositions={allPositions[reportTab.id] || []}
          onClose={() => setReportTab(null)}
        />
      )}

      {/* HEADER */}
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
            <div className="live-badge"><div className="live-dot" /> ALL LIVE</div>
            {newCount > 0 && <div className="new-count-badge">{newCount} NEW</div>}
            <div className={`save-flash ${savedFlash ? "on" : "off"}`}>✓ SAVED</div>
            {lastRefresh && <div className="refresh-ts">{lastRefresh.toLocaleTimeString()}</div>}
          </div>
        </div>
      </div>

      {/* TABS */}
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

      {/* CONTENT */}
      <div className="content">
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
          onOpenReport={() => setReportTab(currentTab)}
        />
      </div>
    </div>
  );
}
