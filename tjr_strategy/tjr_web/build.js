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

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const NTFY_TOPIC = process.env.NTFY_TOPIC || null;

const STATE_PATH = path.join(__dirname, "state.json");
const SIGNALS_LOG_PATH = path.join(__dirname, "signals_log.json");
// Tiam, 2026-07-12: "die KI soll nur zwischen 15 und 17 Uhr analysieren [...]
// nach 17-18 Uhr soll die KI nichts mehr machen ausser zu schauen ob der
// gesetzte Trade [...] in die richtige Richtung geht. Sonst erinnert er sich
// was er gemacht hat und merkt sich das auch fuers naechste Mal." -
// session_log.json haelt EINEN Eintrag pro Handelstag fest (auch wenn kein
// ENTRY gefeuert ist), damit "kein Setup heute" nicht spurlos verschwindet -
// signals_log.json allein erfasst nur tatsaechliche Entries, keine Tage ohne.
const SESSION_LOG_PATH = path.join(__dirname, "session_log.json");

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

// ts-Konvention beibehalten: der gesamte Rest des Systems (Session-Marker in
// report_template.html, Chart-Anzeige etc.) geht davon aus, dass `ts` eine
// naive ET-Uhrzeit ist, die ALS UTC interpretiert wird (siehe engine.js
// parseTs-Kommentar - so hat FMP die Daten geliefert, und alles baut darauf
// auf). Binance/Yahoo liefern echte UTC-Zeitstempel - diese Funktion wandelt
// sie in dieselbe "ET-Uhrzeit-als-UTC-verkleidet"-Konvention um, damit KEIN
// anderer Teil des Codes (Session-Fenster, Chart-Achsen etc.) angepasst
// werden muss.
function etPseudoDateStr(utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  let hh = get("hour");
  if (hh === "24") hh = "00"; // Intl-Eigenheit: Mitternacht kann als "24" kommen
  return `${get("year")}-${get("month")}-${get("day")} ${hh}:${get("minute")}:${get("second")}`;
}

// Kostenlose, kein-Key-noetige Yahoo-Finance-Chart-API (dieselbe Quelle, die
// z.B. die verbreitete 'yfinance'-Bibliothek nutzt) - fuer ALLE 6 Assets,
// auch Krypto. Binance's REST-API (urspruenglich fuer Krypto genutzt) blockt
// GitHub Actions' IP-Bereiche geografisch (HTTP 451 "restricted location") -
// das betrifft nur den Server-seitigen Datenabruf hier, NICHT den Live-Tick-
// WebSocket im Dashboard (der laeuft im Browser des Nutzers, andere IP/Netz,
// funktioniert weiterhin). Liefert die gewuenschte Zeitspanne in EINEM
// Aufruf (kein Paging noetig).
async function fetchYahooChart(yahooSymbol, interval, rangeDays) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${rangeDays}d`;
  const data = await fetchJson(url, `${yahooSymbol} yahoo ${interval}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) {
    const err = data && data.chart && data.chart.error;
    throw new Error(`${yahooSymbol} yahoo ${interval}: kein Ergebnis (${err ? JSON.stringify(err) : "leer"})`);
  }
  const ts = result.timestamp || [];
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!quote) throw new Error(`${yahooSymbol} yahoo ${interval}: keine Kursdaten im Ergebnis`);
  const rows = [];
  for (let i = 0; i < ts.length; i += 1) {
    const o = quote.open[i]; const h = quote.high[i]; const l = quote.low[i]; const c = quote.close[i];
    if (o == null || h == null || l == null || c == null) continue; // Handelsluecke
    rows.push({
      date: etPseudoDateStr(ts[i] * 1000), open: o, high: h, low: l, close: c, volume: (quote.volume && quote.volume[i]) || 0,
    });
  }
  return rows;
}

// S&P500 hat keine kostenlose Echtzeit-Index-Quelle - SPY-ETF folgt dem Index
// fast 1:1 (Tiams Freigabe). Gold als GC=F (COMEX-Future - Yahoos tatsaechlich
// funktionierender Gold-Ticker, "XAUUSD=X" existiert dort nicht/404).
const YAHOO_SYMBOL_MAP = {
  BTCUSD: "BTC-USD", ETHUSD: "ETH-USD", XRPUSD: "XRP-USD",
  GBPUSD: "GBPUSD=X", GCUSD: "GC=F", "^GSPC": "SPY",
};

async function fetchCandles(asset, interval, from, to) {
  const yahooSymbol = YAHOO_SYMBOL_MAP[asset.symbol];
  if (!yahooSymbol) {
    throw new Error(`${asset.symbol}: keine kostenlose Datenquelle konfiguriert`);
  }
  const rangeDays = Math.ceil((to.getTime() - from.getTime()) / 86400000) + 2;
  const raw = await fetchYahooChart(yahooSymbol, interval === "1hour" ? "1h" : "5m", rangeDays);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${asset.symbol} ${interval}: keine Kerzen erhalten`);
  }
  return loadCandles(raw);
}

// Tiam, 2026-07-14 (nach TJR Boot Camp Day 43 "Weekly Analysis"): TJR startet
// seine Wochenvorbereitung immer auf Monats-/Wochenchart-Ebene und wendet
// dort dasselbe Equilibrium-Tool (Mittelpunkt zwischen Hoch/Tief, TJRs
// 0/0.5/1-Fib) an, das er auch auf 4H/15min nutzt, BEVOR er auf Daily/15min
// runterzoomt. Rein informativer Kontext ("wo stehen wir im groesseren
// Bild") - fliesst bewusst NICHT in buildSignal()/die Entry-Gating-Logik
// ein, aus derselben Vorsicht wie bei SMT Divergence/Equilibrium-als-Entry-
// Trigger (siehe Memory project_tjr_strategy - beide warten noch auf Tiams
// Bestaetigung, bevor sie den Trigger selbst beeinflussen duerfen).
const WEEKLY_LOOKBACK_WEEKS = 12;

async function fetchWeeklyCandles(asset) {
  const yahooSymbol = YAHOO_SYMBOL_MAP[asset.symbol];
  if (!yahooSymbol) return [];
  const raw = await fetchYahooChart(yahooSymbol, "1wk", 400);
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return loadCandles(raw);
}

// bias: liegt der aktuelle Wochenschlusskurs ueber oder unter dem
// Equilibrium der letzten WEEKLY_LOOKBACK_WEEKS Wochen.
function computeWeeklyContext(weeklyCandles) {
  if (!weeklyCandles || weeklyCandles.length < 2) return null;
  const recent = weeklyCandles.slice(-WEEKLY_LOOKBACK_WEEKS);
  const high = Math.max(...recent.map((c) => c.high));
  const low = Math.min(...recent.map((c) => c.low));
  const equilibrium = (high + low) / 2;
  const current = recent[recent.length - 1].close;
  const bias = current >= equilibrium ? "bullish" : "bearish";
  return {
    bias, equilibrium, high, low, current, weeksUsed: recent.length,
  };
}

async function analyzeAsset(asset) {
  const today = new Date();
  const from1h = new Date(today); from1h.setDate(from1h.getDate() - 30);
  const from5m = new Date(today); from5m.setDate(from5m.getDate() - (CHART_HISTORY_DAYS + FETCH_BUFFER_DAYS));
  const df1h = await fetchCandles(asset, "1hour", from1h, today);
  const df5m = await fetchCandles(asset, "5min", from5m, today);
  const htf = resample(df1h, 240);
  const ltf = resample(df5m, 15);
  const sig = buildSignal(htf, ltf);
  const ann = buildAnnotations(htf, ltf);
  // CHART_HISTORY_CANDLES (~20 Tage) werden an den Client geschickt, damit man
  // im Chart weit genug zurueckscrollen kann, um vergangene Analysen/Signale
  // zu sehen (siehe CHART_HISTORY_DAYS oben). ltfFull (volle Rohreihe inkl.
  // FETCH_BUFFER_DAYS) wird separat zurueckgegeben fuer resolveSignals()
  // weiter unten, die auch aeltere offene Paper-Trades noch aufloesen muss.
  let weeklyTrend = null;
  try {
    const weeklyCandles = await fetchWeeklyCandles(asset);
    weeklyTrend = computeWeeklyContext(weeklyCandles);
  } catch (e) {
    console.error(`Wochentrend-Abruf fehlgeschlagen fuer ${asset.name} (wird ignoriert):`, e.message || e);
  }
  return {
    sig, ann, ltf: ltf.slice(-CHART_HISTORY_CANDLES), ltfFull: ltf, weeklyTrend,
  };
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

function loadSessionLog() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_LOG_PATH, "utf8"));
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

// Tiam will ausserhalb des Handelsfensters nicht "nichts sehen", sondern
// konkret erkennen, ob ein offener Paper-Trade gerade in die richtige
// Richtung laeuft ("schaut ob der Trade wirklich in die richtige Richtung
// geht") - nicht erst beim finalen Win/Loss. unrealizedR druckt den
// aktuellen Fortschritt in R-Vielfachen aus (Distanz Entry->aktueller Preis
// relativ zur Distanz Entry->Stop, Richtung beruecksichtigt): positiv =
// Richtung Target, negativ = Richtung Stop.
function unrealizedR(rec, currentPrice) {
  if (rec.status !== "open" || currentPrice == null) return null;
  const riskDist = Math.abs(rec.entry - rec.stop);
  if (!riskDist) return null;
  const moveDist = rec.direction === "LONG" ? currentPrice - rec.entry : rec.entry - currentPrice;
  return Math.round((moveDist / riskDist) * 100) / 100;
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

// Kalendertag in Wiener Zeit als YYYY-MM-DD (fuer session_log.json - ein
// Eintrag pro Handelstag, unabhaengig von UTC-Tagesgrenze).
function viennaDateStr(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna" }).format(date);
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
      const {
        sig, ann, ltf, ltfFull, weeklyTrend,
      } = await analyzeAsset(asset);
      assets.push({
        asset, sig, ann, ltf, error: null, aiNote: null, weeklyTrend,
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
    // Tiam, 2026-07-12: neue Trades werden jetzt NUR innerhalb 15-17 Wien
    // geloggt ("die KI soll nur zwischen 15 und 17 Uhr analysieren") - vorher
    // wurde ein mechanisches ENTRY ausserhalb des Fensters trotzdem als
    // Paper-Trade erfasst (nur der Push-Alert war gesperrt). Jetzt: ausserhalb
    // des Fensters wird ein erkanntes Setup zwar noch angezeigt (siehe
    // outsideBadge im Template), aber nicht mehr geloggt/getradet.
    if (isEntry && !wasEntry && inWindow) {
      logNewSignal(signalsLog, item.asset, item.sig, item.ann, nowTs);
      console.log(`PAPER-TRADE geloggt: ${item.asset.name} ${item.sig.bias === "bullish" ? "LONG" : "SHORT"}`);
    } else if (isEntry && !wasEntry && !inWindow) {
      console.log(`Setup erkannt, aber ausserhalb Handelsfenster - kein Paper-Trade geloggt: ${item.asset.name}`);
    }
    if (ltfFullBySymbol[item.asset.symbol]) {
      resolveSignals(signalsLog, item.asset, ltfFullBySymbol[item.asset.symbol]);
    }
    // Modus pro Asset fuers Dashboard: "analyzing" (aktiv im Handelsfenster),
    // "monitoring" (ausserhalb, aber ein offener Paper-Trade laeuft noch -
    // "nichts machen ausser schauen ob der Trade in die richtige Richtung
    // geht"), "idle" (ausserhalb, nichts offen - komplett pausiert).
    const openRec = signalsLog.find((r) => r.asset === item.asset.symbol && r.status === "open");
    item.hasOpenTrade = !!openRec;
    item.mode = inWindow ? "analyzing" : (openRec ? "monitoring" : "idle");
    if (isEntry && !wasEntry && NTFY_TOPIC && inWindow) {
      await sendNtfy(item.asset, item.sig);
    } else if (isEntry && !wasEntry && NTFY_TOPIC && !inWindow) {
      console.log(`ALERT uebersprungen (ausserhalb 15-17 Wien): ${item.asset.name}`);
    }
  }
  const meta = prevState._meta || {};
  const todayVienna = viennaDateStr();
  if (meta.windowOpen && !inWindow && meta.lastSessionLogDate !== todayVienna) {
    const sessionLog = loadSessionLog();
    sessionLog.push({
      date: todayVienna,
      closedAt: new Date().toISOString(),
      perAsset: assets.filter((a) => !a.error).map((item) => ({
        symbol: item.asset.symbol,
        bias: item.sig.bias,
        signal: item.sig.signal,
        zoneKind: item.ann.zoneKind,
        sweepType: item.ann.sweep ? item.ann.sweep.type : null,
        hasOpenTrade: item.hasOpenTrade,
      })),
    });
    fs.writeFileSync(SESSION_LOG_PATH, JSON.stringify(sessionLog, null, 2), "utf8");
    console.log(`Session-Log geschrieben fuer ${todayVienna} (Handelsfenster geschlossen).`);
    meta.lastSessionLogDate = todayVienna;
  }
  meta.windowOpen = inWindow;
  newState._meta = meta;

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
    item.signals = signalsLog
      .filter((r) => r.asset === item.asset.symbol && r.entryTs >= chartHistoryCutoff)
      .map((r) => (r.status === "open"
        ? { ...r, unrealizedR: unrealizedR(r, item.sig.currentPrice) }
        : r));
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

  // Tiam, 2026-07-12: "mach auf der Webseite eine Seite die man anklicken
  // kann [...] wo man den Verlauf aller Assets sieht wie die Analyse lief,
  // also erfolgreich oder nicht." - eigene Seite mit der KOMPLETTEN
  // signals_log.json-Historie (nicht nur die letzten CHART_HISTORY_DAYS wie
  // beim Chart), pro Asset gruppiert mit Win-Rate. Offene Trades bekommen
  // denselben unrealizedR-Fortschritt wie im Haupt-Dashboard.
  const historyPayload = {
    generatedAt: new Date().toISOString(),
    assetsMeta: ASSETS.map((a) => ({
      symbol: a.symbol, name: a.name, display: a.display, icon: a.icon,
    })),
    signals: signalsLog.map((r) => {
      if (r.status !== "open") return r;
      const item = assets.find((a) => !a.error && a.asset.symbol === r.asset);
      const currentPrice = item ? item.sig.currentPrice : null;
      return { ...r, unrealizedR: unrealizedR(r, currentPrice) };
    }),
  };
  renderFromTemplate("history_template.html", "history.html", historyPayload);
}

main().catch((e) => {
  console.error("Unerwarteter Fehler:", e);
  process.exit(1);
});
