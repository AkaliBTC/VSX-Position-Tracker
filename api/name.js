// api/name.js — Voller Instrumentname via Yahoo-Search, serverseitig (kein CORS).
// Antwort wird am Edge 24h gecached, damit Yahoo nicht bei jedem Load angefragt wird.
export default async function handler(req, res) {
  const symbol = (req.query.symbol || "").toString().trim();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=3&newsCount=0`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    );
    const d = await r.json();
    const q = (d.quotes || []).find(x => (x.symbol || "").toUpperCase() === symbol.toUpperCase()) || (d.quotes || [])[0];
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({ symbol, name: q?.longname || q?.shortname || null });
  } catch (e) {
    return res.status(200).json({ symbol, name: null });
  }
}
