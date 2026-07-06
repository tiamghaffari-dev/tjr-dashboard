// build.js — fetches live FMP data, runs the TJR engine, and renders docs/index.html.
// Run via: FMP_API_KEY=xxx node build.js
const fs = require("fs");
const path = require("path");
const {
  parseTs, loadCandles, resample, buildSignal,
} = require("./engine.js");

const API_KEY = process.env.FMP_API_KEY;
if (!API_KEY) {
  console.error("FEHLER: Umgebungsvariable FMP_API_KEY ist nicht gesetzt.");
  process.exit(1);
}

const BASE = "https://financialmodelingprep.com/stable";

const ASSETS = [
  { name: "Bitcoin", symbol: "BTCUSD", display: "BTCUSD", icon: "₿" },
  { name: "Ethereum", symbol: "ETHUSD", display: "ETHUSD", icon: "Ξ" },
  { name: "XRP", symbol: "XRPUSD", display: "XRPUSD", icon: "✧" },
  { name: "GBP/USD", symbol: "GBPUSD", display: "GBPUSD", icon: "£" },
  { name: "S&P 500", symbol: "^GSPC", display: "^GSPC", icon: "▦" },
  { name: "Gold", symbol: "GCUSD", display: "XAUUSD (via GCUSD)", icon: "◎" },
];
const NEWS_CURRENCIES = ["USD", "GBP"];

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function fetchJson(url, label) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`${label}: unerwartetes Antwortformat (kein Array) — ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

async function fetchCandles(symbol, interval, from, to) {
  const url = `${BASE}/historical-chart/${interval}?symbol=${encodeURIComponent(symbol)}&from=${fmtDate(from)}&to=${fmtDate(to)}&apikey=${API_KEY}`;
  const raw = await fetchJson(url, `${symbol} ${interval}`);
  return loadCandles(raw);
}

async function analyzeAsset(asset) {
  const today = new Date();
  const from1h = new Date(today); from1h.setDate(from1h.getDate() - 30);
  const from5m = new Date(today); from5m.setDate(from5m.getDate() - 7);
  const df1h = await fetchCandles(asset.symbol, "1hour", from1h, today);
  const df5m = await fetchCandles(asset.symbol, "5min", from5m, today);
  const htf = resample(df1h, 240);
  const ltf = resample(df5m, 15);
  const sig = buildSignal(htf, ltf);
  return { sig, ltf: ltf.slice(-100) };
}

async function loadNews() {
  const today = new Date();
  const d = fmtDate(today);
  const url = `${BASE}/economic-calendar?from=${d}&to=${d}&apikey=${API_KEY}`;
  const events = await fetchJson(url, "economic-calendar");
  return events.filter((e) => NEWS_CURRENCIES.includes(e.currency) && e.impact === "High");
}

async function main() {
  const assets = [];
  for (const asset of ASSETS) {
    try {
      const { sig, ltf } = await analyzeAsset(asset);
      assets.push({ asset, sig, ltf, error: null });
      console.log(`OK   ${asset.name}: bias=${sig.bias} signal=${sig.signal}`);
    } catch (e) {
      assets.push({ asset, sig: null, ltf: null, error: e.message || String(e) });
      console.error(`FEHLER ${asset.name}: ${e.message || e}`);
    }
  }

  let news = [];
  try {
    news = await loadNews();
  } catch (e) {
    console.error("News-Abruf fehlgeschlagen (wird ignoriert):", e.message || e);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    assets,
    news,
  };

  const templatePath = path.join(__dirname, "docs", "report_template.html");
  const tpl = fs.readFileSync(templatePath, "utf8");
  const out = tpl
    .replace("__PRECOMPUTED_JSON__", JSON.stringify(payload))
    .replace("__GENERATED_AT__", `Zuletzt aktualisiert: ${payload.generatedAt}`);

  fs.writeFileSync(path.join(__dirname, "docs", "index.html"), out, "utf8");
  console.log("docs/index.html geschrieben.");
}

main().catch((e) => {
  console.error("Unerwarteter Fehler:", e);
  process.exit(1);
});
