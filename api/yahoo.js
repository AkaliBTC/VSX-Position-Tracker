export default async function handler(req, res) {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: "no symbols" });
 
  const urls = [
    `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${symbols}`,
    `https://query2.finance.yahoo.com/v6/finance/quote?symbols=${symbols}`,
  ];
 
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!r.ok) continue;
      const data = await r.json();
      const results = data?.quoteResponse?.result;
      if (results?.length) {
        const prices = {};
        results.forEach(item => {
          const price = item.regularMarketPrice || item.ask || item.bid;
          if (item.symbol && price && price > 0) prices[item.symbol] = price;
        });
        return res.status(200).json({ prices });
      }
    } catch {}
  }
 
  // Fallback: chart endpoint per symbol
  const syms = symbols.split(",");
  const prices = {};
  await Promise.all(syms.map(async (sym) => {
    for (const base of ["query1", "query2"]) {
      try {
        const r = await fetch(`https://${base}.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        });
        if (!r.ok) continue;
        const d = await r.json();
        const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice
          || d?.chart?.result?.[0]?.meta?.chartPreviousClose;
        if (price && price > 0) { prices[sym] = price; break; }
      } catch {}
    }
  }));
 
  return res.status(200).json({ prices });
}
