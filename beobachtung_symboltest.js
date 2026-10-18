// Einmaliger Symboltest fuer die Beobachtungsliste - dasselbe Vorgehen wie
// bei Etappe 0: erst pruefen, welche Symbole brauchbare Daten liefern, dann
// erst bauen. Besonderes Augenmerk auf europaeische UCITS-Papiere, weil
// US-ETFs (XLE, XLK, ITA) fuer EU-Privatanleger normalerweise NICHT kaufbar
// sind - die taugen zum Beobachten, nicht zum Kaufen.
const KANDIDATEN = [
  // --- breit gestreut, EU-kaufbar ---
  { thema: "Welt",    name: "MSCI World (Acc)",        symbol: "IWDA.AS" },
  { thema: "Welt",    name: "MSCI World (Xetra)",      symbol: "EUNL.DE" },
  { thema: "Welt",    name: "FTSE All-World (Acc)",    symbol: "VWCE.DE" },
  { thema: "Welt",    name: "MSCI ACWI",               symbol: "IUSQ.DE" },
  { thema: "Welt",    name: "MSCI EM",                 symbol: "EUNM.DE" },

  // --- Ruestung ---
  { thema: "Ruestung", name: "Rheinmetall",            symbol: "RHM.DE" },
  // Zweite Runde: DFEN ist laut Deutsche Boerse das Xetra-Kuerzel des
  // VanEck Defense UCITS ETF (ISIN IE000YYE6WK5). Die erste Runde hatte
  // DFNS/WDEF geraten - beide 404.
  { thema: "Ruestung", name: "VanEck Defense",         symbol: "DFEN.DE" },
  { thema: "Ruestung", name: "VanEck Defense (AS)",    symbol: "DFEN.AS" },
  { thema: "Ruestung", name: "WisdomTree Europe Def.", symbol: "WDEF.MI" },
  { thema: "Ruestung", name: "Global X Defence Tech",  symbol: "ARMY.DE" },
  { thema: "Ruestung", name: "Thales",                 symbol: "HO.PA" },
  { thema: "Ruestung", name: "BAE Systems",            symbol: "BA.L" },
  { thema: "Ruestung", name: "US Aerospace/Defense",   symbol: "ITA" },
  { thema: "Ruestung", name: "Hensoldt",               symbol: "HAG.DE" },

  // --- Energie ---
  { thema: "Energie", name: "STOXX Europe Oil & Gas",  symbol: "EXH1.DE" },
  { thema: "Energie", name: "US Energie-Sektor",       symbol: "XLE" },

  // --- Technologie ---
  { thema: "Technik", name: "S&P 500 Info Tech",       symbol: "QDVE.DE" },
  { thema: "Technik", name: "MSCI World Info Tech",    symbol: "XDWT.DE" },
  { thema: "Technik", name: "Nasdaq 100 (Acc)",        symbol: "EQQQ.DE" },
  { thema: "Technik", name: "US Technologie-Sektor",   symbol: "XLK" },

  // --- Einzelwerte, die Tiam genannt hat ---
  { thema: "Einzeln", name: "Tesla",                   symbol: "TSLA" },

  // --- Krypto ---
  { thema: "Krypto",  name: "Bitcoin",                 symbol: "BTC-USD" },
  { thema: "Krypto",  name: "Ethereum",                symbol: "ETH-USD" },
  { thema: "Krypto",  name: "Solana",                  symbol: "SOL-USD" },
  { thema: "Krypto",  name: "XRP",                     symbol: "XRP-USD" },
];

async function hole(symbol) {
  const u = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(symbol) + "?interval=1d&range=2y";
  const a = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (compatible; tjr-dashboard)" } });
  if (!a.ok) return { ok: false, grund: "HTTP " + a.status };
  const d = await a.json();
  const e = d && d.chart && d.chart.result && d.chart.result[0];
  if (!e) return { ok: false, grund: "kein Ergebnis" };
  const c = (e.indicators && e.indicators.quote && e.indicators.quote[0] && e.indicators.quote[0].close) || [];
  const gueltig = c.filter((x) => typeof x === "number" && isFinite(x));
  if (gueltig.length < 60) return { ok: false, grund: "nur " + gueltig.length + " Kurse" };
  const m = e.meta || {};
  return {
    ok: true, tage: gueltig.length,
    langname: m.longName || m.shortName || "?",
    waehrung: m.currency || "?", boerse: m.exchangeName || "?",
    kurs: Math.round((m.regularMarketPrice || gueltig[gueltig.length - 1]) * 100) / 100,
  };
}

(async () => {
  console.log("Symboltest Beobachtungsliste\n" + "=".repeat(96));
  const gut = [];
  for (const k of KANDIDATEN) {
    let r; try { r = await hole(k.symbol); } catch (e) { r = { ok: false, grund: e.message }; }
    if (r.ok) {
      gut.push(k.symbol);
      console.log("OK  " + k.thema.padEnd(9) + k.symbol.padEnd(11) + String(r.tage).padStart(4) + " Tage  "
        + String(r.kurs).padStart(10) + " " + r.waehrung.padEnd(4) + r.boerse.padEnd(6) + "  " + r.langname.slice(0, 44));
    } else {
      console.log("--  " + k.thema.padEnd(9) + k.symbol.padEnd(11) + "FEHLER: " + r.grund);
    }
    await new Promise((x) => setTimeout(x, 350));
  }
  console.log("=".repeat(96));
  console.log("Brauchbar: " + gut.length + " von " + KANDIDATEN.length);
})();
