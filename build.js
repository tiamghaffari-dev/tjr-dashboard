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
const SIGNALS_LOG_PATH = path.join(__dirname, "signals_log.json");

// Tiam, 2026-07-11: "man scrollt beim Chart und sieht da wurde mal
// analysiert und das war ein Profit oder Fail" — Chart soll die letzten
// 10-20 Tage Historie zeigen (scrollbar wie bei TradingView), nicht nur die
// letzten ~1.5 Tage. FETCH_BUFFER_DAYS gibt beim Datenabruf etwas Puffer
// (Wochenenden/wenig Aktivitaet), damit am Ende wirklich CHART_HISTORY_DAYS
// Tage mit Kerzen uebrig bleiben.
const CHART_HISTORY_DAYS = 20;
const FETCH_BUFFER_DAYS = 5;
const CANDLES_PER_DAY_15M = 96; // 24h * 60min / 15min
const CHART_HISTORY_CANDLES = CHART_HISTORY_DAYS * CANDLES_PER_DAY_15M;

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
  const from5m = new Date(today); from5m.setDate(from5m.getDate() - (CHART_HISTORY_DAYS + FETCH_BUFFER_DAYS));
  const df1h = await fetchCandles(asset.symbol, "1hour", from1h, today);
  const df5m = await fetchCandles(asset.symbol, "5min", from5m, today);
  const htf = resample(df1h, 240);
  const ltf = resample(df5m, 15);
  const sig = buildSignal(htf, ltf);
  const ann = buildAnnotations(htf, ltf);
  // CHART_HISTORY_CANDLES (~20 Tage) werden an den Client geschickt, damit man
  // im Chart weit genug zurueckscrollen kann, um vergangene Analysen/Signale
  // zu sehen (siehe CHART_HISTORY_DAYS oben). ltfFull (volle Rohreihe inkl.
  // FETCH_BUFFER_DAYS) wird separat zurueckgegeben fuer resolveSignals()
  // weiter unten, die auch aeltere offene Paper-Trades noch aufloesen muss.
  return { sig, ann, ltf: ltf.slice(-CHART_HISTORY_CANDLES), ltfFull: ltf };
}

// Nutzt ForexFactory's oeffentlichen Kalender-Feed (via nfs.faireconomy.media,
// dem Datenanbieter hinter forexfactory.com/calendar — kein API-Key noetig,
// kein Scraping der HTML-Seite). Ersetzt den FMP economic-calendar-Endpoint,
// der auf Tiams Plan dauerhaft HTTP 402 (Restricted Endpoint) lieferte.
// Feed liefert die aktuelle Kalenderwoche; wir filtern auf USD/GBP + High-
// Impact + heutiges Datum (UTC-Tag, wie beim Rest von build.js). Gibt exakt
// dieselbe Form {date, event, currency, impact} wie vorher zurueck, damit
// Templates und der KI-Prompt in getAiAssessment() unveraendert bleiben.
async function loadNews() {
  const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
  const events = await fetchJson(url, "forexfactory-calendar");
  if (!Array.isArray(events)) return [];
  const todayUtc = fmtDate(new Date());
  return events
    .filter((e) => NEWS_CURRENCIES.includes(e.country) && e.impact === "High")
    .filter((e) => {
      const d = new Date(e.date);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === todayUtc;
    })
    .map((e) => ({
      date: e.date, event: e.title, currency: e.country, impact: e.impact,
    }));
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

function loadSignalsLog() {
  try {
    return JSON.parse(fs.readFileSync(SIGNALS_LOG_PATH, "utf8"));
  } catch (e) {
    return [];
  }
}

// Automatisches Paper-Trading-Tracking (Tiam, 2026-07-11: "die KI soll selber
// analysieren, schauen ob es profitabel oder nicht ist und lernt dabei dazu"
// - ausdruecklich OHNE manuelles Melden durch Tiam). Jedes ENTRY-Signal wird
// beim Entstehen geloggt (logNewSignal) und bei jedem folgenden Build-Lauf
// gegen die frisch geholten Kerzen aufgeloest (resolveSignals), bis Stop oder
// Target getroffen wird. Gleiche konservative Tie-Break-Regel wie im
// historischen Backtest (Backtest/backtest.py backtest_signals(): Stop wird
// VOR Target geprueft, falls beides in derselben Kerze passiert) - damit
// Live-Tracking und Backtest konsistent bleiben. Ergebnis landet dauerhaft in
// signals_log.json (im Repo committed, siehe .github/workflows/update.yml),
// nicht nur in einem Cowork-Memory - die eigentliche "Lern"-Auswertung
// (wiederkehrende Fehlermuster erkennen) passiert separat beim periodischen
// Review dieser Datei, siehe Memory project_tjr_trade_journal.
const STALE_DAYS = 10;
function resolveSignals(signalsLog, asset, ltfFull) {
  const oldestTs = ltfFull.length ? ltfFull[0].ts : null;
  for (const rec of signalsLog) {
    if (rec.asset !== asset.symbol || rec.status !== "open") continue;
    const candles = ltfFull.filter((c) => c.ts >= rec.entryTs);
    for (const c of candles) {
      const hitStop = rec.direction === "LONG" ? c.low <= rec.stop : c.high >= rec.stop;
      const hitTarget = rec.direction === "LONG" ? c.high >= rec.target : c.low <= rec.target;
      if (hitStop) {
        rec.status = "loss"; rec.resolvedTs = c.ts; rec.rMultiple = -1.0;
        break;
      }
      if (hitTarget) {
        rec.status = "win"; rec.resolvedTs = c.ts; rec.rMultiple = rec.rr;
        break;
      }
    }
    if (rec.status === "open" && oldestTs !== null && rec.entryTs < oldestTs) {
      const ageDays = (Date.now() - rec.entryTs) / 86400000;
      if (ageDays > STALE_DAYS) rec.status = "stale";
    }
  }
}

// Loggt ein neues Paper-Trade-Signal im Moment, wo ENTRY erstmals wahr wird
// (rising edge - dieselbe wasEntry/isEntry-Pruefung wie beim ntfy-Alert, also
// ein Log-Eintrag pro Episode, nicht einer pro 5-15-Minuten-Lauf solange das
// Signal aktiv bleibt).
function logNewSignal(signalsLog, asset, sig, ann, firedAtTs) {
  signalsLog.push({
    id: `${asset.symbol}-${firedAtTs}`,
    asset: asset.symbol,
    direction: sig.bias === "bullish" ? "LONG" : "SHORT",
    entryTs: firedAtTs,
    entry: sig.entry, stop: sig.stop, target: sig.target, rr: sig.rr,
    bias: sig.bias,
    sweepType: ann.sweep ? ann.sweep.type : null,
    confirmationKind: ann.confirmation ? ann.confirmation.kind : null,
    zoneKind: ann.zoneKind,
    status: "open", resolvedTs: null, rMultiple: null,
  });
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
  const ltfFullBySymbol = {};
  for (const asset of ASSETS) {
    try {
      const { sig, ann, ltf, ltfFull } = await analyzeAsset(asset);
      assets.push({
        asset, sig, ann, ltf, error: null, aiNote: null,
      });
      ltfFullBySymbol[asset.symbol] = ltfFull;
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
  const signalsLog = loadSignalsLog();
  const nowTs = Date.now();
  for (const item of assets) {
    if (item.error) continue;
    const isEntry = item.sig.signal === "ENTRY";
    newState[item.asset.symbol] = isEntry;
    const wasEntry = !!prevState[item.asset.symbol];
    if (isEntry && !wasEntry) {
      logNewSignal(signalsLog, item.asset, item.sig, item.ann, nowTs);
      console.log(`PAPER-TRADE geloggt: ${item.asset.name} ${item.sig.bias === "bullish" ? "LONG" : "SHORT"}`);
    }
    if (ltfFullBySymbol[item.asset.symbol]) {
      resolveSignals(signalsLog, item.asset, ltfFullBySymbol[item.asset.symbol]);
    }
    if (isEntry && !wasEntry && NTFY_TOPIC && inWindow) {
      await sendNtfy(item.asset, item.sig);
    } else if (isEntry && !wasEntry && NTFY_TOPIC && !inWindow) {
      console.log(`ALERT uebersprungen (ausserhalb 15-17 Wien): ${item.asset.name}`);
    }
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2), "utf8");
  fs.writeFileSync(SIGNALS_LOG_PATH, JSON.stringify(signalsLog, null, 2), "utf8");
  const closedSignals = signalsLog.filter((r) => r.status === "win" || r.status === "loss");
  const wins = closedSignals.filter((r) => r.status === "win").length;
  console.log(`Paper-Trades: ${signalsLog.length} gesamt, ${closedSignals.length} abgeschlossen (${wins} Gewinn), ${signalsLog.filter((r) => r.status === "open").length} offen.`);
  if (!NTFY_TOPIC) {
    console.log("NTFY_TOPIC nicht gesetzt — Push-Benachrichtigungen werden uebersprungen.");
  }

  // Vergangene Paper-Trade-Signale (win/loss/open/stale) der letzten
  // CHART_HISTORY_DAYS pro Asset anhaengen, damit report_template.html sie
  // direkt im Chart als Marker einzeichnen kann (Tiam, 2026-07-11).
  const chartHistoryCutoff = Date.now() - CHART_HISTORY_DAYS * 86400000;
  for (const item of assets) {
    if (item.error) continue;
    item.signals = signalsLog.filter(
      (r) => r.asset === item.asset.symbol && r.entryTs >= chartHistoryCutoff,
    );
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
