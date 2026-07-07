// build.js — fetches live FMP data, runs the TJR engine, optionally adds a
// supplementary AI assessment via the Anthropic API, sends a push notification
// on new ENTRY signals via ntfy.sh, and renders docs/index.html + docs/chart.html.
// Run via: FMP_API_KEY=xxx ANTHROPIC_API_KEY=yyy NTFY_TOPIC=zzz node build.js
// (ANTHROPIC_API_KEY and NTFY_TOPIC are both optional — without them those
// features are skipped, the mechanical engine keeps working on its own.)
const fs = require("fs");
const path = require("path");
const {
  parseTs, loadCandles, resample, buildSignal, buildAnnotations,
} = require("./engine.js");

const API_KEY = process.env.FMP_API_KEY;
if (!API_KEY) {
  console.error("FEHLER: Umgebungsvariable FMP_API_KEY ist nicht gesetzt.");
  process.exit(1);
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const NTFY_TOPIC = process.env.NTFY_TOPIC || null;

const BASE = "https://financialmodelingprep.com/stable";
const STATE_PATH = path.join(__dirname, "state.json");

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
  const ann = buildAnnotations(htf, ltf);
  // 150 15-min-Baren (~1.5 Tage) reichen fuer den Sweep-Lookback (40 Baren)
  // plus genug sichtbaren Kontext davor/danach fuer den Chart.
  return { sig, ann, ltf: ltf.slice(-150) };
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

function loadPrevState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (e) {
    return {};
  }
}

// Tiam tradet nur 15:00-17:00 Wiener Zeit (siehe README/Cron-Kommentar).
// Nutzt Intl mit timeZone "Europe/Vienna" statt eines festen UTC-Offsets,
// damit der Sommer-/Winterzeit-Wechsel automatisch mitgeht (im Sommer ist
// Wien UTC+2, im Winter UTC+1 — ein fixer Offset waere im Winter falsch).
function isViennaTradingWindow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  const mins = hour * 60 + minute;
  return mins >= 15 * 60 && mins < 17 * 60; // 15:00-16:59 Wien
}

// Push-Benachrichtigung ueber ntfy.sh (kein Account/Key noetig, nur ein
// geheimer Topic-Name). Nur bei neuem ENTRY-Signal (rising edge), nicht bei
// jedem Refresh solange das Signal aktiv bleibt — sonst Spam alle 5 Minuten.
async function sendNtfy(asset, sig) {
  if (!NTFY_TOPIC) return;
  const dir = sig.bias === "bullish" ? "LONG" : "SHORT";
  const message = `${dir} ${asset.display} — Entry ${sig.entry}, Stop ${sig.stop}, Target ${sig.target}, R:R ${sig.rr}. ${sig.detail || ""}`.trim();
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        Title: `TJR Entry: ${asset.name} ${dir}`,
        Priority: "high",
        Tags: "chart_with_upwards_trend",
      },
      body: message,
    });
    console.log(`ALERT gesendet: ${asset.name} ${dir}`);
  } catch (e) {
    console.error(`ntfy-Benachrichtigung fehlgeschlagen fuer ${asset.name}:`, e.message || e);
  }
}

function renderFromTemplate(templateFile, outFile, payload) {
  const templatePath = path.join(__dirname, "docs", templateFile);
  const tpl = fs.readFileSync(templatePath, "utf8");
  const out = tpl
    .replace("__PRECOMPUTED_JSON__", JSON.stringify(payload))
    .replace("__GENERATED_AT__", `Zuletzt aktualisiert: ${payload.generatedAt}`);
  fs.writeFileSync(path.join(__dirname, "docs", outFile), out, "utf8");
  console.log(`docs/${outFile} geschrieben.`);
}

async function main() {
  const assets = [];
  for (const asset of ASSETS) {
    try {
      const { sig, ann, ltf } = await analyzeAsset(asset);
      assets.push({
        asset, sig, ann, ltf, error: null, aiNote: null,
      });
      console.log(`OK   ${asset.name}: bias=${sig.bias} signal=${sig.signal}`);
    } catch (e) {
      assets.push({
        asset, sig: null, ann: null, ltf: null, error: e.message || String(e), aiNote: null,
      });
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

  // State (welches Asset zuletzt ENTRY war) wird immer geschrieben, damit
  // git add state.json nie auf eine fehlende Datei trifft. Nur das SENDEN
  // der Push-Benachrichtigung haengt am optionalen NTFY_TOPIC UND am
  // Handelsfenster (Tiam tradet nur 15-17 Uhr Wien wie TJR selbst — ein
  // ENTRY ausserhalb dieses Fensters wird trotzdem angezeigt, aber nicht
  // per Push gemeldet, um Alert-Spam ausserhalb der eigentlichen Handelszeit
  // zu vermeiden).
  const inWindow = isViennaTradingWindow();
  const prevState = loadPrevState();
  const newState = {};
  for (const item of assets) {
    if (item.error) continue;
    const isEntry = item.sig.signal === "ENTRY";
    newState[item.asset.symbol] = isEntry;
    const wasEntry = !!prevState[item.asset.symbol];
    if (isEntry && !wasEntry && NTFY_TOPIC && inWindow) {
      await sendNtfy(item.asset, item.sig);
    } else if (isEntry && !wasEntry && NTFY_TOPIC && !inWindow) {
      console.log(`ALERT uebersprungen (ausserhalb 15-17 Wien): ${item.asset.name}`);
    }
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2), "utf8");
  if (!NTFY_TOPIC) {
    console.log("NTFY_TOPIC nicht gesetzt — Push-Benachrichtigungen werden uebersprungen.");
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    assets,
    news,
    aiEnabled: !!ANTHROPIC_API_KEY,
    alertsEnabled: !!NTFY_TOPIC,
    inTradingWindow: inWindow,
  };

  renderFromTemplate("report_template.html", "index.html", payload);
  renderFromTemplate("chart_template.html", "chart.html", payload);
}

main().catch((e) => {
  console.error("Unerwarteter Fehler:", e);
  process.exit(1);
});
