import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "position_monitor_v1";

// ─── TABS ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "crypto",      label: "Crypto",      icon: "◈", source: "binance" },
  { id: "stocks",      label: "Stocks",      icon: "▸", source: "yahoo"   },
  { id: "indices",     label: "Indices",     icon: "◎", source: "yahoo"   },
  { id: "commodities", label: "Commodities", icon: "◆", source: "yahoo"   },
  { id: "etfs",        label: "ETFs",        icon: "▣", source: "yahoo"   },
];

const PLACEHOLDERS = {
  crypto: "BTC", stocks: "MSFT", indices: "^GSPC", commodities: "GC=F", etfs: "SPY",
};

const HINTS = {
  stocks:      "US: MSFT · DE: BASF.DE · IT: ENI.MI · FR: MC.PA · CH: NESN.SW · JP: 7203.T",
  indices:     "S&P500: ^GSPC · Nasdaq: ^IXIC · Dow: ^DJI · DAX: ^GDAXI · Nikkei: ^N225 · HSI: ^HSI · VIX: ^VIX",
  commodities: "Gold: GC=F · Silver: SI=F · Oil WTI: CL=F · Brent: BZ=F · Nat Gas: NG=F · Copper: HG=F · Wheat: ZW=F",
  etfs:        "US: SPY · QQQ · GLD · TLT · EU: EXS1.DE · IS3N.DE",
};

// ─── STORAGE ───────────────────────────────────────────────────────────────────
const loadFromStorage = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
};

const saveToStorage = (data) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
};

// ─── PRICE FETCHERS ────────────────────────────────────────────────────────────
const fetchBinance = async (ticker) => {
  const sym = ticker.toUpperCase().trim();
  const symbol = sym.endsWith("USDT") ? sym : sym + "USDT";
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (!res.ok) throw new Error();
    const d = await res.json();
    return parseFloat(d.price);
  } catch { return null; }
};

const fetchYahoo = async (ticker) => {
  const sym = encodeURIComponent(ticker.toUpperCase().trim());
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
  const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  try {
    const res = await fetch(proxy);
    if (!res.ok) throw new Error();
    const outer = await res.json();
    const data = JSON.parse(outer.contents);
    const meta = data?.chart?.result?.[0]?.meta;
    // live price first, fallback to previous close
    const price = meta?.regularMarketPrice || meta?.chartPreviousClose || meta?.previousClose;
    return price ?? null;
  } catch { return null; }
};

const fetchPrice = (source, ticker) => {
  if (source === "binance") return fetchBinance(ticker);
  if (source === "yahoo")   return fetchYahoo(ticker);
  return Promise.resolve(null);
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────
const calcPnL = (direction, entry, current) => {
  if (!entry || !current || isNaN(entry) || isNaN(current)) return null;
  return direction === "LONG"
    ? ((current - entry) / entry) * 100
    : ((entry - current) / entry) * 100;
};

const calcRisk = (direction, current, sl) => {
  if (!current || !sl || isNaN(current) || isNaN(sl)) return null;
  return direction === "LONG"
    ? ((current - sl) / current) * 100
    : ((sl - current) / current) * 100;
};

const fmtPrice = (p) => {
  if (p === null || p === undefined) return "—";
  if (p < 0.01)  return p.toFixed(6);
  if (p < 1)     return p.toFixed(4);
  if (p < 100)   return p.toFixed(3);
  return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const newRow = () => ({
  id: Math.random().toString(36).slice(2),
  ticker: "",
  direction: "LONG",
  entry: "",
  sl: "",
  date: new Date().toISOString().split("T")[0],
  currentPrice: null,
  loading: false,
  error: false,
});

const EMPTY_STATE = Object.fromEntries(TABS.map((t) => [t.id, []]));

// ─── TABLE ────────────────────────────────────────────────────────────────────
function PositionTable({ tab, positions, setPositions, onRefresh, isRefreshing }) {
  const update = (id, field, val) =>
    setPositions((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: val } : p)));
  const remove = (id) => {
    if (window.confirm("Delete this position?")) {
      setPositions((prev) => prev.filter((p) => p.id !== id));
    }
  };
  const add = () => setPositions((prev) => [...prev, newRow()]);

  const sourceLabel = {
    binance: "⚡ Binance · 15s auto",
    yahoo:   "⚡ Yahoo Finance · 30s auto",
  }[tab.source];

  return (
    <div>
      {HINTS[tab.id] && <div className="hint-bar">{HINTS[tab.id]}</div>}
      <div className="toolbar">
        <button className="btn btn-add" onClick={add}>＋ Add Position</button>
        <button className="btn btn-refresh" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? <span className="spin">⟳</span> : "⟳"} Refresh
        </button>
        <span className="source-badge">{sourceLabel}</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>TICKER</th>
              <th>DIR</th>
              <th>ENTRY</th>
              <th>STOP LOSS</th>
              <th>SL DIST %</th>
              <th>ENTRY DATE</th>
              <th>LIVE PRICE</th>
              <th>PNL %</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty-cell">
                  No {tab.label} positions yet — hit Add to start
                </td>
              </tr>
            ) : positions.map((p) => {
              const entry = parseFloat(p.entry);
              const sl    = parseFloat(p.sl);
              const pnl   = calcPnL(p.direction, entry, p.currentPrice);
              const risk  = calcRisk(p.direction, p.currentPrice, sl);

              return (
                <tr key={p.id}>
                  <td>
                    <input
                      className="cell-input ticker-inp"
                      placeholder={PLACEHOLDERS[tab.id]}
                      value={p.ticker}
                      onChange={(e) => update(p.id, "ticker", e.target.value.toUpperCase())}
                      onBlur={() => { if (p.ticker.trim()) onRefresh(); }}
                    />
                  </td>
                  <td>
                    <select
                      className={`dir-sel ${p.direction === "LONG" ? "dir-long" : "dir-short"}`}
                      value={p.direction}
                      onChange={(e) => update(p.id, "direction", e.target.value)}
                    >
                      <option value="LONG">LONG</option>
                      <option value="SHORT">SHORT</option>
                    </select>
                  </td>
                  <td>
                    <input className="cell-input num-inp" placeholder="0.00" type="number"
                      value={p.entry} onChange={(e) => update(p.id, "entry", e.target.value)} />
                  </td>
                  <td>
                    <input className="cell-input num-inp" placeholder="0.00" type="number"
                      value={p.sl} onChange={(e) => update(p.id, "sl", e.target.value)} />
                  </td>
                  <td>
                    <span className="risk-val">
                      {risk !== null && !isNaN(risk) ? `${risk.toFixed(2)}%` : "—"}
                    </span>
                  </td>
                  <td>
                    <input className="cell-input date-inp" type="date"
                      value={p.date} onChange={(e) => update(p.id, "date", e.target.value)} />
                  </td>
                  <td>
                    {p.loading ? <span className="fetching">fetching…</span>
                      : p.error ? <span className="price-err">N/A</span>
                      : p.currentPrice !== null
                        ? <span className="price-val">{fmtPrice(p.currentPrice)}</span>
                        : <span className="price-dim">—</span>}
                  </td>
                  <td>
                    {pnl !== null && !isNaN(pnl) ? (
                      <span className={pnl > 0.005 ? "pnl-pos" : pnl < -0.005 ? "pnl-neg" : "pnl-zero"}>
                        {pnl > 0 ? "+" : ""}{pnl.toFixed(2)}%
                      </span>
                    ) : <span className="price-dim">—</span>}
                  </td>
                  <td>
                    <button className="del-btn" onClick={() => remove(p.id)}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState("crypto");
  const [allPositions, setAllPositions] = useState(() => {
    const saved = loadFromStorage();
    return saved || EMPTY_STATE;
  });
  const [refreshing, setRefreshing] = useState({});
  const [lastRefresh, setLastRefresh] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // persist on every change
  useEffect(() => {
    // strip runtime-only fields before saving
    const toSave = Object.fromEntries(
      Object.entries(allPositions).map(([tabId, rows]) => [
        tabId,
        rows.map(({ currentPrice, loading, error, ...rest }) => rest),
      ])
    );
    saveToStorage(toSave);
    setSavedFlash(true);
    const t = setTimeout(() => setSavedFlash(false), 1200);
    return () => clearTimeout(t);
  }, [allPositions]);

  const setPosForTab = (tabId) => (updater) =>
    setAllPositions((prev) => ({
      ...prev,
      [tabId]: typeof updater === "function" ? updater(prev[tabId]) : updater,
    }));

  const refreshTab = useCallback(async (tabId) => {
    const tab = TABS.find((t) => t.id === tabId);
    const positions = allPositions[tabId] || [];
    if (!positions.some((p) => p.ticker.trim())) return;

    setRefreshing((prev) => ({ ...prev, [tabId]: true }));

    const updated = await Promise.all(
      positions.map(async (p) => {
        if (!p.ticker.trim()) return p;
        const price = await fetchPrice(tab.source, p.ticker.trim());
        return { ...p, currentPrice: price, error: price === null, loading: false };
      })
    );

    setAllPositions((prev) => ({ ...prev, [tabId]: updated }));
    setLastRefresh(new Date());
    setRefreshing((prev) => ({ ...prev, [tabId]: false }));
  }, [allPositions]);

  // auto-refresh
  useEffect(() => {
    const intervals = TABS.map((tab) => {
      const ms = tab.source === "binance" ? 15000 : 30000;
      return setInterval(() => {
        if ((allPositions[tab.id] || []).some((p) => p.ticker.trim())) {
          refreshTab(tab.id);
        }
      }, ms);
    });
    return () => intervals.forEach(clearInterval);
  }, [allPositions, refreshTab]);

  // stats
  const totalPositions = Object.values(allPositions).flat().filter((p) => p.ticker).length;
  const currentPositions = allPositions[activeTab] || [];
  const pnlValues = currentPositions
    .map((p) => calcPnL(p.direction, parseFloat(p.entry), p.currentPrice))
    .filter((v) => v !== null && !isNaN(v));
  const avgPnl = pnlValues.length
    ? pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length
    : null;

  const currentTab = TABS.find((t) => t.id === activeTab);

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');

        :root {
          --bg:          #0a0805;
          --bg2:         #0f0c08;
          --bg3:         #13100b;
          --border:      #2a1f0f;
          --gold:        #c9933a;
          --gold-dim:    #7a5520;
          --gold-bright: #e8b558;
          --red-bright:  #e74c3c;
          --green:       #27ae60;
          --green-bright:#2ecc71;
          --text:        #d4b896;
          --text-dim:    #6b5030;
          --text-mute:   #3d2a15;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        .app {
          min-height: 100vh;
          background: var(--bg);
          font-family: 'Share Tech Mono', monospace;
          color: var(--text);
          background-image:
            radial-gradient(ellipse 80% 50% at 50% -10%, rgba(201,147,58,0.06) 0%, transparent 60%),
            repeating-linear-gradient(0deg, transparent, transparent 39px, rgba(42,31,15,0.35) 39px, rgba(42,31,15,0.35) 40px);
        }

        .header {
          padding: 22px 36px 18px;
          border-bottom: 1px solid var(--border);
          display: flex; align-items: flex-end; justify-content: space-between;
          background: linear-gradient(180deg, #0d0a06 0%, var(--bg) 100%);
          position: relative;
        }
        .header::before {
          content: ''; position: absolute;
          top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, var(--gold), transparent);
        }
        .logo-title {
          font-family: 'Rajdhani', sans-serif;
          font-size: 26px; font-weight: 700;
          letter-spacing: 0.18em; color: var(--gold-bright);
          text-shadow: 0 0 28px rgba(201,147,58,0.35);
        }
        .logo-sub {
          font-size: 9px; letter-spacing: 0.3em;
          color: var(--gold-dim); text-transform: uppercase; margin-top: 3px;
        }
        .header-stats { display: flex; gap: 36px; align-items: flex-end; }
        .stat { text-align: right; }
        .stat-label { font-size: 9px; letter-spacing: 0.25em; color: var(--text-dim); text-transform: uppercase; margin-bottom: 2px; }
        .stat-val { font-family: 'Rajdhani', sans-serif; font-size: 22px; font-weight: 700; }

        .status-cluster { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        .live-badge {
          display: flex; align-items: center; gap: 7px;
          padding: 5px 14px; border: 1px solid var(--gold-dim);
          font-size: 9px; letter-spacing: 0.25em;
          color: var(--gold); background: rgba(201,147,58,0.04);
        }
        .live-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--green-bright); box-shadow: 0 0 8px var(--green-bright);
          animation: blink 1.8s ease-in-out infinite;
        }
        .save-indicator {
          font-size: 9px; letter-spacing: 0.15em;
          transition: opacity 0.3s;
        }
        .save-indicator.visible { color: var(--green-bright); opacity: 1; }
        .save-indicator.hidden  { opacity: 0; }
        .refresh-ts { font-size: 9px; color: var(--text-mute); letter-spacing: 0.08em; }

        @keyframes blink {
          0%,100% { opacity: 1; box-shadow: 0 0 8px var(--green-bright); }
          50%      { opacity: 0.35; box-shadow: 0 0 3px var(--green-bright); }
        }

        .tabs-wrap {
          display: flex; border-bottom: 1px solid var(--border);
          background: var(--bg2); padding: 0 36px; gap: 2px;
        }
        .tab {
          display: flex; align-items: center; gap: 8px;
          padding: 13px 20px;
          font-family: 'Rajdhani', sans-serif;
          font-size: 13px; font-weight: 600;
          letter-spacing: 0.15em; text-transform: uppercase;
          color: var(--text-dim); cursor: pointer; border: none;
          background: transparent; border-bottom: 2px solid transparent;
          transition: all 0.18s; position: relative; bottom: -1px;
        }
        .tab:hover { color: var(--text); }
        .tab.active {
          color: var(--gold-bright); border-bottom-color: var(--gold);
          background: linear-gradient(180deg, rgba(201,147,58,0.05) 0%, transparent 100%);
        }
        .tab-count {
          font-size: 9px; padding: 1px 6px;
          background: var(--border); color: var(--text-dim); border-radius: 2px;
        }
        .tab.active .tab-count { background: rgba(201,147,58,0.15); color: var(--gold); }
        .live-pip {
          width: 5px; height: 5px; border-radius: 50%;
          background: var(--green); box-shadow: 0 0 5px var(--green);
          animation: blink 1.8s ease-in-out infinite;
        }

        .content { padding: 26px 36px; }

        .hint-bar {
          font-size: 10px; color: var(--text-dim); letter-spacing: 0.06em;
          margin-bottom: 14px; padding: 8px 12px;
          border-left: 2px solid var(--gold-dim);
          background: rgba(201,147,58,0.03); line-height: 1.6;
        }

        .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }

        .btn {
          padding: 8px 18px;
          font-family: 'Share Tech Mono', monospace;
          font-size: 11px; letter-spacing: 0.1em;
          border: none; cursor: pointer; transition: all 0.15s; text-transform: uppercase;
        }
        .btn-add {
          background: rgba(201,147,58,0.1); color: var(--gold-bright);
          border: 1px solid var(--gold-dim);
        }
        .btn-add:hover { background: rgba(201,147,58,0.18); box-shadow: 0 0 12px rgba(201,147,58,0.18); }
        .btn-refresh {
          background: rgba(39,174,96,0.08); color: var(--green-bright);
          border: 1px solid rgba(39,174,96,0.22);
        }
        .btn-refresh:hover:not(:disabled) { background: rgba(39,174,96,0.14); }
        .btn-refresh:disabled { opacity: 0.4; cursor: not-allowed; }
        .source-badge { font-size: 10px; color: var(--text-dim); letter-spacing: 0.1em; opacity: 0.8; }

        .table-wrap { border: 1px solid var(--border); overflow-x: auto; background: var(--bg2); }
        table { width: 100%; border-collapse: collapse; min-width: 860px; }
        thead tr { background: var(--bg3); border-bottom: 1px solid var(--border); }
        th {
          padding: 10px 14px; font-size: 9px; letter-spacing: 0.25em;
          color: var(--gold-dim); text-align: left;
          font-family: 'Rajdhani', sans-serif; font-weight: 600; white-space: nowrap;
        }
        tbody tr { border-bottom: 1px solid rgba(42,31,15,0.5); transition: background 0.12s; }
        tbody tr:last-child { border-bottom: none; }
        tbody tr:hover { background: rgba(201,147,58,0.03); }
        td { padding: 9px 14px; font-size: 13px; }

        .cell-input {
          background: transparent; border: none; color: var(--text);
          font-family: 'Share Tech Mono', monospace; font-size: 13px;
          outline: none; padding: 3px 6px; transition: background 0.15s;
          border-radius: 1px; width: 100%;
        }
        .cell-input:focus { background: rgba(201,147,58,0.06); color: #fff; }
        .cell-input::placeholder { color: var(--text-mute); }

        .ticker-inp { color: var(--gold-bright); font-weight: 600; letter-spacing: 0.08em; width: 90px; }
        .num-inp    { width: 90px; }
        .date-inp   { width: 130px; color-scheme: dark; }

        .dir-sel {
          border: none; font-family: 'Share Tech Mono', monospace;
          font-size: 11px; font-weight: 600; letter-spacing: 0.12em;
          cursor: pointer; padding: 4px 8px; outline: none; -webkit-appearance: none;
        }
        .dir-long  { background: rgba(39,174,96,0.12); color: var(--green-bright); }
        .dir-short { background: rgba(192,57,43,0.12); color: var(--red-bright); }

        .risk-val  { color: var(--gold); font-size: 12px; }
        .price-val { color: var(--text); }
        .fetching  { color: var(--text-mute); font-size: 11px; animation: blink 1.5s infinite; }
        .price-err { color: var(--red-bright); font-size: 11px; }
        .price-dim { color: var(--text-mute); }

        .pnl-pos  { color: var(--green-bright); font-weight: 600; letter-spacing: 0.05em; }
        .pnl-neg  { color: var(--red-bright);   font-weight: 600; letter-spacing: 0.05em; }
        .pnl-zero { color: var(--text-dim); }

        .del-btn {
          background: none; border: none; color: var(--text-mute);
          cursor: pointer; font-size: 13px; padding: 4px 8px;
          transition: color 0.15s; font-family: 'Share Tech Mono', monospace;
        }
        .del-btn:hover { color: var(--red-bright); }

        .empty-cell {
          text-align: center; padding: 48px;
          color: var(--text-mute); font-size: 12px; letter-spacing: 0.15em;
        }

        .spin { display: inline-block; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* HEADER */}
      <div className="header">
        <div>
          <div className="logo-title">◈ POSITION MONITOR</div>
          <div className="logo-sub">Multi-Asset Live Tracker</div>
        </div>
        <div className="header-stats">
          <div className="stat">
            <div className="stat-label">Positions</div>
            <div className="stat-val" style={{ color: "var(--gold)" }}>{totalPositions}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Tab Avg PnL</div>
            <div className="stat-val" style={{
              color: avgPnl === null ? "var(--text-mute)"
                : avgPnl >= 0 ? "var(--green-bright)"
                : "var(--red-bright)"
            }}>
              {avgPnl !== null ? `${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%` : "—"}
            </div>
          </div>
          <div className="status-cluster">
            <div className="live-badge">
              <div className="live-dot" />
              ALL LIVE
            </div>
            <div className={`save-indicator ${savedFlash ? "visible" : "hidden"}`}>
              ✓ SAVED
            </div>
            {lastRefresh && (
              <div className="refresh-ts">{lastRefresh.toLocaleTimeString()}</div>
            )}
          </div>
        </div>
      </div>

      {/* TABS */}
      <div className="tabs-wrap">
        {TABS.map((t) => {
          const count = (allPositions[t.id] || []).filter((p) => p.ticker).length;
          return (
            <button
              key={t.id}
              className={`tab ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.icon} {t.label}
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
          onRef
