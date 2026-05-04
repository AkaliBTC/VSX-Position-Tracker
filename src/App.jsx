import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "position_monitor_v1";

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

const loadFromStorage = () => {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; }
  catch { return null; }
};
const saveToStorage = (d) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch {} };

const fetchBinance = async (ticker) => {
  const sym = ticker.toUpperCase().trim();
  const symbol = sym.endsWith("USDT") ? sym : sym + "USDT";
  // 1) Try Spot
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (res.ok) {
      const price = parseFloat((await res.json()).price);
      if (price > 0) return price;
    }
  } catch {}
  // 2) Fallback: Futures (for tokens like HYPE that have no Spot pair)
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
    if (res.ok) {
      const price = parseFloat((await res.json()).price);
      if (price > 0) return price;
    }
  } catch {}
  return null;
};

// ── YAHOO PROXIES ─────────────────────────────────────────────────────────────
const PROXIES = [
  (u) => fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => JSON.parse(d.contents)),
  (u) => fetch(`https://corsproxy.io/?${encodeURIComponent(u)}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
  (u) => fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
  (u) => fetch(`https://yacdn.org/proxy/${u}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
];

// ── YAHOO SINGLE: fallback for individual ticker ──────────────────────────────
const fetchYahooSingle = async (ticker) => {
  const raw = ticker.toUpperCase().trim();
  const pairs = [
    [`https://query1.finance.yahoo.com/v6/finance/quote?symbols=${raw}`, (d) => { const r = d?.quoteResponse?.result?.[0]; return r?.regularMarketPrice || r?.ask || null; }],
    [`https://query2.finance.yahoo.com/v6/finance/quote?symbols=${raw}`, (d) => { const r = d?.quoteResponse?.result?.[0]; return r?.regularMarketPrice || r?.ask || null; }],
    [`https://query1.finance.yahoo.com/v8/finance/chart/${raw}?interval=1d&range=5d`, (d) => { const m = d?.chart?.result?.[0]?.meta; return m?.regularMarketPrice || m?.chartPreviousClose || null; }],
    [`https://query2.finance.yahoo.com/v8/finance/chart/${raw}?interval=1d&range=5d`, (d) => { const m = d?.chart?.result?.[0]?.meta; return m?.regularMarketPrice || m?.chartPreviousClose || null; }],
    [`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${raw}?modules=price`, (d) => d?.quoteSummary?.result?.[0]?.price?.regularMarketPrice?.raw || null],
    [`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${raw}?modules=price`, (d) => d?.quoteSummary?.result?.[0]?.price?.regularMarketPrice?.raw || null],
  ];
  for (const [url, extract] of pairs) {
    for (const px of PROXIES) {
      try {
        const data = await px(url);
        const price = extract(data);
        if (price && price > 0) return price;
      } catch { continue; }
    }
  }
  return null;
};

// ── YAHOO BATCH: sequential chunks of 10 to avoid proxy collisions ────────────
const fetchYahooBatch = async (tickers) => {
  const BATCH_SIZE = 10;
  const results = {};
  tickers.forEach(t => { results[t] = null; });

  const chunks = [];
  for (let i = 0; i < tickers.length; i += BATCH_SIZE)
    chunks.push(tickers.slice(i, i + BATCH_SIZE));

  // Sequential — not parallel — to prevent proxy rate-limit collisions
  for (const chunk of chunks) {
    const symbols = chunk.join(",");
    let items = null;

    for (const base of ["query1", "query2"]) {
      const url = `https://${base}.finance.yahoo.com/v6/finance/quote?symbols=${symbols}`;
      for (const px of PROXIES) {
        try {
          const data = await px(url);
          const res = data?.quoteResponse?.result;
          if (res?.length) { items = res; break; }
        } catch { continue; }
        if (items) break;
      }
      if (items) break;
    }

    if (items) {
      items.forEach(item => {
        const price = item.regularMarketPrice || item.ask || item.bid;
        if (item.symbol && price && price > 0) results[item.symbol] = price;
      });
      // Any ticker in this chunk that batch missed → single fallback
      for (const ticker of chunk) {
        if (results[ticker] === null)
          results[ticker] = await fetchYahooSingle(ticker);
      }
    } else {
      // Whole batch failed → individual fallbacks
      for (const ticker of chunk)
        results[ticker] = await fetchYahooSingle(ticker);
    }
  }
  return results;
};

const calcPnL = (dir, entry, cur) => {
  if (!entry || !cur || isNaN(entry) || isNaN(cur)) return null;
  return dir === "LONG" ? ((cur - entry) / entry) * 100 : ((entry - cur) / entry) * 100;
};
const calcSLDist = (dir, cur, sl) => {
  if (!cur || !sl || isNaN(cur) || isNaN(sl)) return null;
  return dir === "LONG" ? ((cur - sl) / cur) * 100 : ((sl - cur) / cur) * 100;
};
const fmtPrice = (p) => {
  if (p == null) return "—";
  if (p < 0.01) return p.toFixed(6);
  if (p < 1)    return p.toFixed(4);
  if (p < 100)  return p.toFixed(3);
  return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const newRow = () => ({
  id: Math.random().toString(36).slice(2),
  ticker: "", direction: "LONG", entry: "", sl: "",
  date: new Date().toISOString().split("T")[0],
  currentPrice: null, loading: false, error: false,
});
const EMPTY_STATE = Object.fromEntries(TABS.map((t) => [t.id, []]));

const VSXLogo = ({ size = 72 }) => (
  <img
    src="https://i.postimg.cc/pd4xzT1r/87011e66-b8e4-4d2b-9977-a06bb4b29902.png"
    width={size}
    height={size}
    alt="VisionX Logo"
    style={{ objectFit: "contain", display: "block", filter: "drop-shadow(0 0 16px rgba(212,175,55,0.5))" }}
  />
);

// ── TABLE ─────────────────────────────────────────────────────────────────────
function PositionTable({ tab, positions, setPositions, onRefresh, isRefreshing, anyFocused }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [search, setSearch] = useState("");
  const [focusedId, setFocusedId] = useState(null);

  const setFocus = (id) => { setFocusedId(id); if (anyFocused) anyFocused.current = true; };
  const clearFocus = () => { setFocusedId(null); if (anyFocused) anyFocused.current = false; };

  const update = (id, f, v) =>
    setPositions((prev) => prev.map((p) => (p.id === id ? { ...p, [f]: v } : p)));
  const remove = (id) => {
    if (window.confirm("Delete this position?"))
      setPositions((prev) => prev.filter((p) => p.id !== id));
  };
  const add = () => setPositions((prev) => [...prev, newRow()]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const SortTh = ({ label, k }) => (
    <th onClick={() => handleSort(k)} style={{ cursor: "pointer", userSelect: "none" }}>
      {label}
      <span style={{ marginLeft: 4, opacity: sortKey === k ? 1 : 0.25, fontSize: 9 }}>
        {sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "▲"}
      </span>
    </th>
  );

  const filtered = positions.filter(p => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      p.ticker.toLowerCase().includes(q) ||
      p.direction.toLowerCase().includes(q) ||
      p.date.includes(q)
    );
  });

  const sorted = [...filtered].sort((a, b) => {
    if (!sortKey) return 0;
    if (a.id === focusedId || b.id === focusedId) return 0;
    let va, vb;
    if (sortKey === "ticker")    { va = a.ticker; vb = b.ticker; }
    else if (sortKey === "date") { va = a.date;   vb = b.date; }
    else if (sortKey === "entry"){ va = parseFloat(a.entry) || 0; vb = parseFloat(b.entry) || 0; }
    else if (sortKey === "pnl")  {
      va = calcPnL(a.direction, parseFloat(a.entry), a.currentPrice) ?? -Infinity;
      vb = calcPnL(b.direction, parseFloat(b.entry), b.currentPrice) ?? -Infinity;
    }
    else if (sortKey === "dir")  { va = a.direction; vb = b.direction; }
    if (va < vb) return sortDir === "asc" ? -1 : 1;
    if (va > vb) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  return (
    <div>
      {tab.id === "stocks" && (
        <div className="hint-bar">
          <span className="hint-label">FORMAT</span>
          {STOCK_HINT}
        </div>
      )}
      <div className="toolbar">
        <button className="btn btn-add" onClick={add}>+ ADD POSITION</button>
        <button className="btn btn-refresh" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? <span className="spin">↻</span> : "↻"} REFRESH
        </button>
        <input
          className="search-inp"
          placeholder="Search ticker, date, direction…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="source-badge">
          {tab.source === "binance" ? "BINANCE · 15s AUTO" : "YAHOO FINANCE · 30s AUTO"}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortTh label="TICKER" k="ticker" />
              <SortTh label="DIRECTION" k="dir" />
              <SortTh label="ENTRY" k="entry" />
              <th>STOP LOSS</th>
              <th>SL DIST %</th>
              <SortTh label="ENTRY DATE" k="date" />
              <th>LIVE PRICE</th>
              <SortTh label="PNL %" k="pnl" />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={9} className="empty-cell">{search ? "NO RESULTS" : "NO POSITIONS — PRESS ADD TO BEGIN"}</td></tr>
            ) : sorted.map((p) => {
              const entry = parseFloat(p.entry);
              const sl    = parseFloat(p.sl);
              const pnl   = calcPnL(p.direction, entry, p.currentPrice);
              const dist  = calcSLDist(p.direction, p.currentPrice, sl);
              return (
                <tr key={p.id}>
                  <td>
                    <input className="cell-input ticker-inp" placeholder={PLACEHOLDERS[tab.id]}
                      value={p.ticker}
                      onChange={(e) => update(p.id, "ticker", e.target.value.toUpperCase())}
                      onFocus={() => setFocus(p.id)}
                      onBlur={() => { clearFocus(); if (p.ticker.trim()) onRefresh(); }} />
                  </td>
                  <td>
                    <select className={`dir-sel ${p.direction === "LONG" ? "dir-long" : "dir-short"}`}
                      value={p.direction} onChange={(e) => update(p.id, "direction", e.target.value)}>
                      <option value="LONG">LONG</option>
                      <option value="SHORT">SHORT</option>
                    </select>
                  </td>
                  <td><input className="cell-input num-inp" placeholder="0.00" type="number"
                    value={p.entry} onChange={(e) => update(p.id, "entry", e.target.value)}
                    onFocus={() => setFocus(p.id)} onBlur={() => clearFocus()} /></td>
                  <td><input className="cell-input num-inp" placeholder="0.00" type="number"
                    value={p.sl} onChange={(e) => update(p.id, "sl", e.target.value)}
                    onFocus={() => setFocus(p.id)} onBlur={() => clearFocus()} /></td>
                  <td><span className="dist-val">{dist !== null && !isNaN(dist) ? `${dist.toFixed(2)}%` : "—"}</span></td>
                  <td><input className="cell-input date-inp" type="date"
                    value={p.date} onChange={(e) => update(p.id, "date", e.target.value)}
                    onFocus={() => setFocus(p.id)} onBlur={() => clearFocus()} /></td>
                  <td>
                    {p.loading   ? <span className="fetching">LOADING</span>
                    : p.error    ? <span className="price-err">N/A</span>
                    : p.currentPrice !== null
                      ? <span className="price-val">{fmtPrice(p.currentPrice)}</span>
                      : <span className="price-dim">—</span>}
                  </td>
                  <td>
                    {pnl !== null && !isNaN(pnl)
                      ? <span className={pnl > 0.005 ? "pnl-pos" : pnl < -0.005 ? "pnl-neg" : "pnl-zero"}>
                          {pnl > 0 ? "+" : ""}{pnl.toFixed(2)}%
                        </span>
                      : <span className="price-dim">—</span>}
                  </td>
                  <td><button className="del-btn" onClick={() => remove(p.id)}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab]       = useState("crypto");
  const [allPositions, setAllPositions] = useState(() => loadFromStorage() || EMPTY_STATE);
  const [refreshing, setRefreshing]     = useState({});
  const [lastRefresh, setLastRefresh]   = useState(null);
  const [savedFlash, setSavedFlash]     = useState(false);
  const anyFocused = useRef(false);

  // savedFlash only — storage handled synchronously in setPosForTab
  useEffect(() => {
    setSavedFlash(true);
    const t = setTimeout(() => setSavedFlash(false), 1400);
    return () => clearTimeout(t);
  }, [allPositions]);

  const setPosForTab = (tabId) => (updater) =>
    setAllPositions((prev) => {
      const next = {
        ...prev,
        [tabId]: typeof updater === "function" ? updater(prev[tabId]) : updater,
      };
      // Synchronous save — persists immediately before next render cycle
      const toSave = Object.fromEntries(
        Object.entries(next).map(([id, rows]) => [
          id, rows.map(({ currentPrice, loading, error, ...r }) => r),
        ])
      );
      saveToStorage(toSave);
      return next;
    });

  const refreshTab = useCallback(async (tabId) => {
    const tab = TABS.find((t) => t.id === tabId);
    const snapshot = allPositions[tabId] || [];
    const active = snapshot.filter((p) => p.ticker.trim());
    if (!active.length) return;

    setRefreshing((prev) => ({ ...prev, [tabId]: true }));

    let priceMap = {};
    if (tab.source === "binance") {
      await Promise.all(active.map(async (p) => {
        priceMap[p.ticker.trim()] = await fetchBinance(p.ticker.trim());
      }));
    } else {
      priceMap = await fetchYahooBatch(active.map(p => p.ticker.trim()));
    }

    // Always merge into latest state to avoid overwriting edits made during fetch
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

  const portfolioPnlVals = allRows
    .map((p) => calcPnL(p.direction, parseFloat(p.entry), p.currentPrice))
    .filter((v) => v !== null && !isNaN(v));
  const portfolioPnl = portfolioPnlVals.length
    ? portfolioPnlVals.reduce((a, b) => a + b, 0) / portfolioPnlVals.length : null;

  const tabPnlVals = (allPositions[activeTab] || [])
    .map((p) => calcPnL(p.direction, parseFloat(p.entry), p.currentPrice))
    .filter((v) => v !== null && !isNaN(v));
  const tabPnl = tabPnlVals.length
    ? tabPnlVals.reduce((a, b) => a + b, 0) / tabPnlVals.length : null;

  const currentTab = TABS.find((t) => t.id === activeTab);

  // Top & Worst performer for active tab
  const tabRowsWithPnl = (allPositions[activeTab] || [])
    .map((p) => ({ ...p, pnl: calcPnL(p.direction, parseFloat(p.entry), p.currentPrice) }))
    .filter((p) => p.ticker && p.pnl !== null && !isNaN(p.pnl));
  const topPerformer  = tabRowsWithPnl.length ? tabRowsWithPnl.reduce((a, b) => a.pnl > b.pnl ? a : b) : null;
  const worstPerformer = tabRowsWithPnl.length ? tabRowsWithPnl.reduce((a, b) => a.pnl < b.pnl ? a : b) : null;

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&family=Bebas+Neue&family=DM+Mono:wght@300;400;500&display=swap');

        :root {
          --black:   #0a0a0a;
          --black2:  #111111;
          --black3:  #1a1a1a;
          --border:  #222222;
          --border2: #2a2a2a;
          --gold1:   #b99c64;
          --gold2:   #d4af37;
          --gold3:   #c59958;
          --gold4:   #f8e49b;
          --white:   #fdfdfd;
          --text:    #e8e8e8;
          --text-dim:#666;
          --text-mute:#333;
          --green:   #22c55e;
          --red:     #ef4444;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--black); }

        .app {
          min-height: 100vh;
          background: var(--black);
          font-family: 'Montserrat', sans-serif;
          color: var(--text);
        }

        /* ── HEADER ── */
        .header {
          height: 100px; padding: 0 56px;
          display: flex; align-items: center; justify-content: space-between;
          background: rgba(10,10,10,0.85);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          border-bottom: 1px solid var(--border);
          position: sticky; top: 0; z-index: 100;
          transition: background 0.3s;
        }

        .logo-area { display: flex; align-items: center; gap: 16px; }
        .logo-divider {
          width: 1px; height: 40px;
          background: linear-gradient(180deg, transparent, rgba(212,175,55,0.4), transparent);
          margin: 0 6px;
        }
        .logo-wordmark { display: flex; flex-direction: column; gap: 1px; }
        .logo-name {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 32px; letter-spacing: 0.25em;
          color: var(--white); line-height: 1;
          background: linear-gradient(135deg, #fff 0%, #e8e8e8 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .logo-sub {
          font-size: 8px; letter-spacing: 0.4em;
          color: var(--gold1); line-height: 1.6;
          font-family: 'Montserrat', sans-serif; font-weight: 500;
          text-transform: uppercase;
        }

        .header-right { display: flex; align-items: center; gap: 0; }

        .stat-block {
          padding: 0 32px;
          border-left: 1px solid var(--border);
          text-align: right;
          transition: background 0.25s;
          cursor: default;
        }
        .stat-block:hover { background: rgba(255,255,255,0.02); }

        .stat-label {
          font-family: 'Montserrat', sans-serif;
          font-size: 8px; font-weight: 600;
          letter-spacing: 0.22em; color: var(--text-dim);
          text-transform: uppercase; margin-bottom: 4px;
        }
        .stat-val {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 26px; letter-spacing: 0.04em; line-height: 1;
          transition: color 0.4s, transform 0.2s;
        }
        .stat-block:hover .stat-val { transform: scale(1.03); }

        .status-block {
          padding: 0 0 0 32px;
          border-left: 1px solid var(--border);
          display: flex; flex-direction: column;
          align-items: flex-end; gap: 5px;
        }
        .live-badge {
          display: flex; align-items: center; gap: 7px;
          padding: 5px 14px;
          border: 1px solid rgba(34,197,94,0.2);
          background: rgba(34,197,94,0.06);
          border-radius: 20px;
          font-family: 'Montserrat', sans-serif;
          font-size: 8px; font-weight: 600;
          letter-spacing: 0.22em; color: var(--green);
          transition: all 0.3s;
        }
        .live-badge:hover { background: rgba(34,197,94,0.12); transform: scale(1.02); }
        .live-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--green); box-shadow: 0 0 10px var(--green);
          animation: glow 2s ease-in-out infinite;
        }
        @keyframes glow {
          0%,100% { opacity: 1; box-shadow: 0 0 10px var(--green); }
          50%      { opacity: 0.3; box-shadow: 0 0 3px var(--green); }
        }
        .save-flash {
          font-size: 8px; letter-spacing: 0.18em;
          color: var(--gold2); transition: opacity 0.4s;
          font-family: 'Montserrat', sans-serif; font-weight: 500;
        }
        .save-flash.on  { opacity: 1; }
        .save-flash.off { opacity: 0; }
        .refresh-ts { font-size: 9px; color: var(--text-mute); letter-spacing: 0.06em; }

        /* ── PERFORMER BLOCKS ── */
        .performer-block {
          padding: 0 24px;
          border-left: 1px solid var(--border);
          text-align: right;
          cursor: default;
        }
        .performer-ticker {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 20px; letter-spacing: 0.06em; line-height: 1;
        }
        .performer-pnl {
          font-family: 'DM Mono', monospace;
          font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
        }
        .top-ticker  { color: var(--green); }
        .worst-ticker { color: var(--red); }

        /* ── TABS ── */
        .tabs-wrap {
          display: flex; background: var(--black);
          border-bottom: 1px solid var(--border);
          padding: 0 56px; gap: 4px;
        }
        .tab {
          padding: 18px 20px;
          font-family: 'Montserrat', sans-serif;
          font-size: 10px; font-weight: 600; letter-spacing: 0.18em;
          text-transform: uppercase; color: var(--text-dim);
          cursor: pointer; border: none; background: transparent;
          border-bottom: 1px solid transparent;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          position: relative; bottom: -1px;
          display: flex; align-items: center; gap: 9px;
        }
        .tab:hover { color: var(--text); background: rgba(255,255,255,0.02); }
        .tab.active { color: var(--gold4); border-bottom-color: var(--gold2); }

        .tab-count {
          font-size: 9px; padding: 2px 8px;
          border: 1px solid var(--border2);
          border-radius: 20px; color: var(--text-dim);
          font-family: 'DM Mono', monospace;
          background: var(--black3);
          transition: all 0.25s;
        }
        .tab.active .tab-count {
          border-color: rgba(212,175,55,0.3);
          color: var(--gold2);
          background: rgba(212,175,55,0.08);
        }
        .live-pip {
          width: 4px; height: 4px; border-radius: 50%;
          background: var(--green); box-shadow: 0 0 5px var(--green);
          animation: glow 2s ease-in-out infinite;
        }

        /* ── CONTENT ── */
        .content { padding: 36px 56px; }

        .hint-bar {
          display: flex; align-items: center; gap: 20px;
          font-size: 10px; color: var(--text-dim); letter-spacing: 0.06em;
          margin-bottom: 24px; padding: 12px 20px;
          border: 1px solid var(--border);
          background: var(--black2);
          border-radius: 8px;
          transition: border-color 0.3s, background 0.3s;
          font-family: 'DM Mono', monospace;
        }
        .hint-bar:hover { border-color: var(--gold1); background: rgba(212,175,55,0.03); }
        .hint-label {
          font-family: 'Montserrat', sans-serif;
          font-size: 8px; font-weight: 700; letter-spacing: 0.25em;
          color: var(--gold2); white-space: nowrap;
          padding-right: 20px; border-right: 1px solid var(--border);
        }

        /* ── TOOLBAR ── */
        .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }

        .btn {
          padding: 10px 22px;
          font-family: 'Montserrat', sans-serif;
          font-size: 10px; font-weight: 700; letter-spacing: 0.15em;
          border: none; cursor: pointer;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          text-transform: uppercase; border-radius: 6px;
        }
        .btn-add {
          background: linear-gradient(135deg, var(--gold2), var(--gold3));
          color: var(--black);
          box-shadow: 0 0 20px rgba(212,175,55,0.2);
        }
        .btn-add:hover {
          background: linear-gradient(135deg, var(--gold4), var(--gold2));
          box-shadow: 0 0 35px rgba(212,175,55,0.4);
          transform: translateY(-2px) scale(1.02);
        }
        .btn-add:active { transform: translateY(0) scale(0.98); }

        .btn-refresh {
          background: transparent; color: var(--text-dim);
          border: 1px solid var(--border); border-radius: 6px;
        }
        .btn-refresh:hover:not(:disabled) {
          color: var(--text); border-color: var(--border2);
          background: var(--black2); transform: translateY(-1px);
        }
        .btn-refresh:active { transform: translateY(0); }
        .btn-refresh:disabled { opacity: 0.3; cursor: not-allowed; }
        .search-inp {
          background: var(--black2); border: 1px solid var(--border);
          color: var(--text); font-family: 'DM Mono', monospace; font-size: 11px;
          padding: 8px 14px; border-radius: 6px; outline: none;
          width: 220px; letter-spacing: 0.04em;
          transition: border-color 0.2s, background 0.2s;
        }
        .search-inp:focus { border-color: var(--gold1); background: rgba(212,175,55,0.04); }
        .search-inp::placeholder { color: var(--text-mute); }

        .source-badge {
          font-size: 9px; color: var(--text-mute); letter-spacing: 0.12em;
          font-family: 'Montserrat', sans-serif; font-weight: 500; margin-left: 4px;
        }

        /* ── TABLE ── */
        .table-wrap {
          border: 1px solid var(--border);
          overflow-x: auto; background: var(--black2);
          border-radius: 12px; overflow: hidden;
          transition: border-color 0.3s;
        }
        .table-wrap:hover { border-color: var(--border2); }

        table { width: 100%; border-collapse: collapse; min-width: 860px; }
        thead tr { background: var(--black3); border-bottom: 1px solid var(--border); }
        th {
          padding: 14px 18px;
          font-family: 'Montserrat', sans-serif;
          font-size: 8px; font-weight: 700; letter-spacing: 0.28em;
          color: var(--text-dim); text-align: left; white-space: nowrap;
        }
        th:first-child { color: var(--gold1); }

        tbody tr {
          border-bottom: 1px solid var(--border);
          transition: background 0.2s, transform 0.15s;
          cursor: default;
        }
        tbody tr:last-child { border-bottom: none; }
        tbody tr:hover {
          background: rgba(212,175,55,0.03);
        }
        tbody tr:hover .ticker-inp { color: var(--gold4); }
        tbody tr:hover .pnl-pos { text-shadow: 0 0 12px rgba(34,197,94,0.4); }
        tbody tr:hover .pnl-neg { text-shadow: 0 0 12px rgba(239,68,68,0.4); }
        td { padding: 14px 18px; }

        .cell-input {
          background: transparent; border: none; color: var(--text);
          font-family: 'DM Mono', monospace; font-size: 13px;
          outline: none; padding: 4px 6px; width: 100%;
          transition: background 0.2s; border-radius: 4px;
        }
        .cell-input:focus { background: rgba(212,175,55,0.05); }
        .cell-input::placeholder { color: var(--text-mute); }

        .ticker-inp { color: var(--gold4); letter-spacing: 0.06em; width: 90px; transition: color 0.2s; }
        .num-inp    { width: 100px; }
        .date-inp   { width: 130px; color-scheme: dark; }

        .dir-sel {
          border: none; font-family: 'Montserrat', sans-serif;
          font-size: 10px; font-weight: 700; letter-spacing: 0.15em;
          cursor: pointer; padding: 5px 14px; outline: none;
          -webkit-appearance: none; text-transform: uppercase;
          border-radius: 4px; transition: all 0.2s;
        }
        .dir-long  { background: rgba(34,197,94,0.1);  color: var(--green); }
        .dir-short { background: rgba(239,68,68,0.1);  color: var(--red);   }
        .dir-long:hover  { background: rgba(34,197,94,0.2); transform: scale(1.04); }
        .dir-short:hover { background: rgba(239,68,68,0.2); transform: scale(1.04); }

        .dist-val  { color: var(--gold3); font-size: 12px; font-family: 'DM Mono', monospace; }
        .price-val { color: var(--white); font-family: 'DM Mono', monospace; }
        .fetching  { color: var(--text-mute); font-size: 10px; letter-spacing: 0.1em; animation: glow 1.5s infinite; }
        .price-err { color: var(--red); font-size: 10px; letter-spacing: 0.1em; }
        .price-dim { color: var(--text-mute); }

        .pnl-pos  { color: var(--green); font-weight: 600; font-family: 'DM Mono', monospace; transition: text-shadow 0.2s; }
        .pnl-neg  { color: var(--red);   font-weight: 600; font-family: 'DM Mono', monospace; transition: text-shadow 0.2s; }
        .pnl-zero { color: var(--text-dim); font-family: 'DM Mono', monospace; }

        .del-btn {
          background: none; border: none; color: var(--text-mute);
          cursor: pointer; font-size: 12px; padding: 6px 10px;
          transition: all 0.2s; border-radius: 4px;
        }
        .del-btn:hover { color: var(--red); background: rgba(239,68,68,0.08); transform: scale(1.1); }

        .empty-cell {
          text-align: center; padding: 72px;
          font-family: 'Montserrat', sans-serif;
          color: var(--text-mute); font-size: 10px; letter-spacing: 0.3em; font-weight: 500;
        }

        .spin { display: inline-block; animation: spin 0.7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

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
            <div className="stat-val" style={{
              color: tabPnl === null ? "var(--text-dim)" : tabPnl >= 0 ? "var(--green)" : "var(--red)"
            }}>
              {tabPnl !== null ? `${tabPnl >= 0 ? "+" : ""}${tabPnl.toFixed(2)}%` : "—"}
            </div>
          </div>
          <div className="stat-block">
            <div className="stat-label">Portfolio PnL</div>
            <div className="stat-val" style={{
              color: portfolioPnl === null ? "var(--text-dim)" : portfolioPnl >= 0 ? "var(--green)" : "var(--red)"
            }}>
              {portfolioPnl !== null ? `${portfolioPnl >= 0 ? "+" : ""}${portfolioPnl.toFixed(2)}%` : "—"}
            </div>
          </div>
          <div className="stat-block">
            <div className="stat-label">Best Performer</div>
            <div className="stat-val" style={{ color: "var(--green)" }}>
              {topPerformer ? topPerformer.ticker : "—"}
            </div>
            {topPerformer && (
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "var(--green)", letterSpacing: "0.04em", marginTop: "2px" }}>
                +{topPerformer.pnl.toFixed(2)}%
              </div>
            )}
          </div>
          <div className="stat-block">
            <div className="stat-label">Worst Performer</div>
            <div className="stat-val" style={{ color: worstPerformer && worstPerformer.pnl < 0 ? "var(--red)" : "var(--green)" }}>
              {worstPerformer ? worstPerformer.ticker : "—"}
            </div>
            {worstPerformer && (
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: worstPerformer.pnl < 0 ? "var(--red)" : "var(--green)", letterSpacing: "0.04em", marginTop: "2px" }}>
                {worstPerformer.pnl >= 0 ? "+" : ""}{worstPerformer.pnl.toFixed(2)}%
              </div>
            )}
          </div>
          <div className="status-block">
            <div className="live-badge"><div className="live-dot" /> ALL LIVE</div>
            <div className={`save-flash ${savedFlash ? "on" : "off"}`}>✓ SAVED</div>
            {lastRefresh && <div className="refresh-ts">{lastRefresh.toLocaleTimeString()}</div>}
          </div>
        </div>
      </div>

      {/* TABS */}
      <div className="tabs-wrap">
        {TABS.map((t) => {
          const count = (allPositions[t.id] || []).filter((p) => p.ticker).length;
          return (
            <button key={t.id}
              className={`tab ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}>
              {t.label}
              {count > 0 && <span className="tab-count">{count}</span>}
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
        />
      </div>
    </div>
  );
}
