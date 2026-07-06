// build.js — fetches live FMP data, runs the TJR engine, optionally adds a
// supplementary AI assessment via the Anthropic API, and renders docs/index.html.
// Run via: FMP_API_KEY=xxx ANTHROPIC_API_KEY=yyy node build.js
// (ANTHROPIC_API_KEY is optional — without it the AI assessment is skipped,
// the mechanical engine keeps working on its own.)
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

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

async function fetchJson(url, label, opts) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), ...(opts || {}) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchCandles(symbol, interval, from, to) {
  const url = `${BASE}/historical-chart/${interval}?symbol=${encodeURIComponent(symbol)}&from=${fmtDate(from)}&to=${fmtDate(to)}&apikey=${API_KEY}`;
  const raw = await fetchJson(url, `${symbol} ${interval}`);
  if (!Array.isArray(raw)) {
    throw new Error(`${symbol} ${interval}: unerwartetes Antwortformat (kein Array) — ${JSON.stringify(raw).slice(0, 200)}`);
  }
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
  if (!Array.isArray(events)) return [];
  return events.filter((e) => NEWS_CURRENCIES.includes(e.currency) && e.impact === "High");
}

// Supplementary, non-authoritative AI read on top of the mechanical engine.
// Never overrides sig.signal — purely an extra text note shown alongside it.
async function getAiAssessment(asset, sig, ltf, newsEvents) {
  if (!ANTHROPIC_API_KEY) return null;

  const recent = ltf.slice(-20).map((c) => (
    `${new Date(c.ts).toISOString().slice(5, 16)} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`
  )).join("\n");
  const newsText = newsEvents.length
    ? newsEvents.map((e) => `${e.date} ${e.event} (${e.currency})`).join("; ")
    : "keine";

  const prompt = `Asset: ${asset.name} (${asset.display})
Mechanische Regel-Engine sagt: Bias=${sig.bias}, Signal=${sig.signal}.
Letzte 20 15-Minuten-Kerzen (UTC):
${recent}
Heutige High-Impact-News (USD/GBP): ${newsText}

Du bist ein erfahrener Daytrader im ICT/Smart-Money-Stil (wie TJR). Gib eine
sehr knappe Einschätzung (max. 2 Sätze, Deutsch): passt das mechanische
Signal gerade zum breiteren Marktbild und den News, oder ist Vorsicht
angebracht? Keine Kauf-/Verkaufsempfehlung, nur eine kurze fachliche
Einordnung.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || "").join("").trim();
    return text || null;
  } catch (e) {
    console.error(`KI-Einschaetzung fehlgeschlagen fuer ${asset.name}:`, e.message || e);
    return null;
  }
}

async function main() {
  const assets = [];
  for (const asset of ASSETS) {
    try {
      const { sig, ltf } = await analyzeAsset(asset);
      assets.push({ asset, sig, ltf, error: null, aiNote: null });
      console.log(`OK   ${asset.name}: bias=${sig.bias} signal=${sig.signal}`);
    } catch (e) {
      assets.push({ asset, sig: null, ltf: null, error: e.message || String(e), aiNote: null });
      console.error(`FEHLER ${asset.name}: ${e.message || e}`);
    }
  }

  let news = [];
  try {
    news = await loadNews();
  } catch (e) {
    console.error("News-Abruf fehlgeschlagen (wird ignoriert):", e.message || e);
  }

  if (ANTHROPIC_API_KEY) {
    for (const item of assets) {
      if (item.error) continue;
      item.aiNote = await getAiAssessment(item.asset, item.sig, item.ltf, news);
      console.log(`KI   ${item.asset.name}: ${item.aiNote ? "ok" : "keine Antwort"}`);
    }
  } else {
    console.log("ANTHROPIC_API_KEY nicht gesetzt — KI-Einschaetzung wird uebersprungen.");
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    assets,
    news,
    aiEnabled: !!ANTHROPIC_API_KEY,
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
