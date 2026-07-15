// build.js — fetches live candles from Yahoo Finance (free, no API key), runs
// the TJR engine, adds a supplementary (rule-based, no external API) market-
// context read, sends a push notification on new ENTRY signals via ntfy.sh,
// and renders docs/index.html + docs/chart.html + docs/history.html.
// Run via: NTFY_TOPIC=zzz node build.js
// (NTFY_TOPIC is optional — without it that one feature is skipped, everything
// else keeps working on its own, no paid API key needed anywhere in this file.)
const fs = require("fs");
const path = require("path");
const {
  parseTs, loadCandles, resample, buildSignal, buildAnnotations,
} = require("./engine.js");

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
const CANDLES_PER_DAY_5M = 288; // 24h * 60min / 5min
const CHART_HISTORY_CANDLES = CHART_HISTORY_DAYS * CANDLES_PER_DAY_5M;

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

const YAHOO_INTERVAL_MAP = { "1hour": "1h", "5min": "5m", "1min": "1m" };

async function fetchCandles(asset, interval, from, to) {
  const yahooSymbol = YAHOO_SYMBOL_MAP[asset.symbol];
  if (!yahooSymbol) {
    throw new Error(`${asset.symbol}: keine kostenlose Datenquelle konfiguriert`);
  }
  const yahooInterval = YAHOO_INTERVAL_MAP[interval] || "5m";
  const rangeDays = Math.ceil((to.getTime() - from.getTime()) / 86400000) + 2;
  const raw = await fetchYahooChart(yahooSymbol, yahooInterval, rangeDays);
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
  // Yahoo begrenzt interval=1m auf ca. 7 Tage Lookback - mehr braucht die
  // 1min-Bestaetigungsstufe (siehe engine.js find1minConfirmation()) ohnehin
  // nicht, die schaut immer nur ab dem juengsten 5min-Bestaetigungszeitpunkt
  // nach vorne (typischerweise Minuten bis wenige Stunden zurueck).
  const from1m = new Date(today); from1m.setDate(from1m.getDate() - 5);
  const df1h = await fetchCandles(asset, "1hour", from1h, today);
  const df5m = await fetchCandles(asset, "5min", from5m, today);
  // Tiam, 2026-07-15 (nach TJRs eigenem Execution-Checklist im 5h "Beginners
  // Guide"-Video): "scale to 5 min timeframe, wait for confirmation
  // (bos,ifvg,smt) ... wait for 5 min continuation (fvg,ob,bb,eq)" - ltf war
  // bisher auf 15min resampelt, jetzt bewusst die rohen 5min-Kerzen direkt
  // (kein resample mehr), sowohl fuer die Signal-Logik als auch fuer die
  // Chart-Anzeige (dieselbe Serie - siehe CANDLES_PER_DAY_5M unten), damit
  // Annotation-Zeitstempel (buildAnnotations' zoneTs etc.) IMMER exakt auf
  // eine echte Kerze der angezeigten Chart-Serie treffen (ein Mismatch
  // zwischen einer 5min-basierten Zone und einem 15min-Chart wuerde
  // drawZoneBox()s Kerzen-Lookup in report_template.html sonst brechen).
  let df1m = [];
  try {
    df1m = await fetchCandles(asset, "1min", from1m, today);
  } catch (e) {
    console.error(`1min-Kerzen-Abruf fehlgeschlagen fuer ${asset.name} (1min-Bestaetigungs-Gate wird uebersprungen):`, e.message || e);
  }
  const htf = resample(df1h, 240);
  const ltf = df5m;
  const sig = buildSignal(htf, ltf, df1m);
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
    // Tiam, 2026-07-14: "die KI kann auch manchmal selber denken und schauen ob
    // es vllt doch ein entry gibt [...] da es ja auch auf dem gesamten Markt
    // zugreifen kann" - getAiAssessment() bekam bisher nur die letzten 20
    // LTF-Kerzen (15min). Damit die KI wirklich das GROESSERE Bild sieht (nicht
    // nur einen kleinen Ausschnitt), wird hier zusaetzlich ein HTF (4H)
    // Kontext mitgegeben - genug fuer ein paar Handelstage Trendverlauf.
    htfRecent: htf.slice(-30),
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

// Supplementary, non-authoritative market-context read on top of the
// mechanical engine. Never overrides sig.signal, never gets logged to
// signals_log.json / paper-traded — purely an extra text note shown alongside
// the mechanical result.
//
// Tiam, 2026-07-14: "die KI kann auch manchmal selber denken und schauen ob
// es vllt doch ein entry gibt oder nicht da es ja auch auf dem gesamten Markt
// zugreifen kann um zu sehen ob es steigt oder sinken wurde" - first version
// of this used the Anthropic API (see git branch backup-ai-llm-2026-07-14 for
// that version, kept as a reference/fallback). Tiam then hit "credit balance
// too low" on his fresh Anthropic account and said (same day): "ich dachte
// die gratis dings ist momentan ausreichend fuer eine weile [...] kannst du
// es nicht anders machen? also komplett unabhaengig von solchen sachen und
// die Webseite arbeitet von alleine" - any hosted LLM API needs paid credits
// once a free quota is used/unavailable, that's not something buildable
// around. Explicit choice via follow-up: try a version with NO external
// provider at all first, keep the LLM version backed up in case he wants to
// pay for it later. This function is the result: a fully synchronous,
// deterministic, zero-cost heuristic that reads the SAME broader-market
// inputs (4H trend momentum, weekly bias, 5min momentum, distance from the
// recent range, today's high-impact news) an LLM prompt would have been
// given, and combines them into a short German read - no network call, no
// API key, no billing dependency, runs identically forever.
function pctChange(a, b) {
  if (!a) return 0;
  return (b - a) / Math.abs(a);
}

function computeMarketContextOpinion(asset, sig, ltf, htfRecent, weeklyTrend, newsEvents) {
  const mechDir = sig.bias === "bullish" ? 1 : sig.bias === "bearish" ? -1 : 0;
  if (mechDir === 0) {
    return "Noch kein klarer 4H-Bias vorhanden - fuer eine Kontext-Einschaetzung fehlt aktuell die Grundlage.";
  }

  // Weekly bias agreement (already computed elsewhere, see computeWeeklyContext).
  const weeklyDir = weeklyTrend ? (weeklyTrend.bias === "bullish" ? 1 : weeklyTrend.bias === "bearish" ? -1 : 0) : 0;

  // 4H momentum: majority direction of the last 8 HTF candles (~1-2 Handelstage).
  const htfSample = (htfRecent || []).slice(-8);
  const htfGreens = htfSample.filter((c) => c.close >= c.open).length;
  const htfMomentumDir = htfSample.length ? (htfGreens > htfSample.length / 2 ? 1 : htfGreens < htfSample.length / 2 ? -1 : 0) : 0;

  // Kurzfrist-Momentum: Nettobewegung ueber die letzten 60 LTF-Kerzen (5min
  // seit 2026-07-15, vorher 15min - Fensterbreite bewusst verdreifacht, damit
  // dieselbe ~5h-Zeitspanne wie zuvor abgedeckt bleibt, nicht nur ~100min).
  const ltfSample = ltf.slice(-60);
  const ltfNetDir = ltfSample.length >= 2
    ? Math.sign(pctChange(ltfSample[0].close, ltfSample[ltfSample.length - 1].close))
    : 0;

  // Exhaustion check: where does the current price sit within the recent 4H range?
  // Very close to the top of the range on a bullish bias (or bottom on bearish)
  // suggests the move may already be extended - worth flagging as caution, not
  // as a reason to change the mechanical signal.
  let exhaustionNote = "";
  if (htfSample.length >= 5) {
    const highs = htfSample.map((c) => c.high);
    const lows = htfSample.map((c) => c.low);
    const rangeHigh = Math.max(...highs);
    const rangeLow = Math.min(...lows);
    const range = rangeHigh - rangeLow;
    if (range > 0) {
      const pos = (sig.currentPrice - rangeLow) / range; // 0 = am Tief, 1 = am Hoch
      if (mechDir === 1 && pos > 0.85) exhaustionNote = " Kurs steht nahe am oberen Rand der juengsten 4H-Range - moeglicherweise schon weit gelaufen.";
      if (mechDir === -1 && pos < 0.15) exhaustionNote = " Kurs steht nahe am unteren Rand der juengsten 4H-Range - moeglicherweise schon weit gelaufen.";
    }
  }

  const newsNote = (newsEvents && newsEvents.length) ? " Heute High-Impact-News angekuendigt - kann kurzfristig fuer Ausschlaege sorgen." : "";

  const signals = [
    { label: "Wochentrend", dir: weeklyDir },
    { label: "4H-Momentum", dir: htfMomentumDir },
    { label: "5min-Momentum", dir: ltfNetDir },
  ].filter((s) => s.dir !== 0);
  const agreeing = signals.filter((s) => s.dir === mechDir);
  const disagreeing = signals.filter((s) => s.dir !== mechDir);

  const dirLabel = mechDir === 1 ? "long" : "short";
  const plural = (arr) => arr.length > 1;
  let lead;
  if (signals.length === 0) {
    lead = `Kein zusaetzlicher Kontext (Woche/4H/5min) verfuegbar, um den ${dirLabel}-Bias zu stuetzen oder zu widerlegen.`;
  } else if (agreeing.length === signals.length) {
    const verb = plural(agreeing) ? "zeigen" : "zeigt";
    lead = `Gesamtbild stuetzt den ${dirLabel}-Bias: ${agreeing.map((s) => s.label).join(", ")} ${verb} in dieselbe Richtung.`;
  } else if (agreeing.length === 0) {
    const verb = plural(disagreeing) ? "zeigen" : "zeigt";
    lead = `Gesamtbild widerspricht dem ${dirLabel}-Bias: ${disagreeing.map((s) => s.label).join(", ")} ${verb} in die Gegenrichtung - Vorsicht.`;
  } else {
    const verb1 = plural(agreeing) ? "stuetzen" : "stuetzt";
    lead = `Gemischtes Bild: ${agreeing.map((s) => s.label).join(", ")} ${verb1} den ${dirLabel}-Bias, ${disagreeing.map((s) => s.label).join(", ")} nicht.`;
  }

  return `${lead}${exhaustionNote}${newsNote}`;
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

// Tiam tradet 15:00-17:00 Wiener Zeit (NY-Session, siehe README/Cron-
// Kommentar) UND seit 2026-07-15 zusaetzlich 09:00-10:00 Wiener Zeit
// (London-Session). Quelle: TJRs eigenes verbatim Execution-Checklist im
// 5h "Beginners Guide"-Video ("2: times to trade: ny session 9:50-10:30
// (forex 8:00am-10:00am) london session 3am-4am", sein Chart lief auf
// (UTC-5) New York = ET). ET->Wien ist ganzjaehrig ~+6h (beide Zonen haben
// DST, die Umstellungstermine liegen nur wenige Tage auseinander, siehe
// [[project_tjr_live_data]]): NY-Futures 9:50-10:30 ET ~ 15:50-16:30 Wien
// (liegt schon im bestehenden Fenster), Forex-NY 8-10am ET ~ 14-16 Wien
// (ueberlappt das bestehende Fenster, kein neues Fenster noetig), London
// 3-4am ET ~ 9-10 Wien (KOMPLETT NEU, bisher nicht ueberwacht - siehe
// project_tjr_strategy Memory "Update 2026-07-15").
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
  const inLondonWindow = mins >= 9 * 60 && mins < 10 * 60; // 09:00-09:59 Wien
  const inNyWindow = mins >= 15 * 60 && mins < 17 * 60; // 15:00-16:59 Wien
  return inLondonWindow || inNyWindow;
}

// Fuer die Dashboard-Anzeige: welche der beiden Sessions ist gerade aktiv
// (oder keine). Getrennt von isViennaTradingWindow(), damit die Alert-/
// Log-Logik unangetastet bleibt und nur die Anzeige das Label bekommt.
function activeTradingSessionLabel(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  const mins = hour * 60 + minute;
  if (mins >= 9 * 60 && mins < 10 * 60) return "London";
  if (mins >= 15 * 60 && mins < 17 * 60) return "NY";
  return null;
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
        sig, ann, ltf, ltfFull, weeklyTrend, htfRecent,
      } = await analyzeAsset(asset);
      assets.push({
        asset, sig, ann, ltf, error: null, aiNote: null, weeklyTrend, htfRecent,
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

  for (const item of assets) {
    if (item.error) continue;
    item.aiNote = computeMarketContextOpinion(item.asset, item.sig, item.ltf, item.htfRecent, item.weeklyTrend, news);
  }
  console.log(`Kontext-Einschaetzung (regelbasiert, kein API-Call): ${assets.filter((a) => a.aiNote).length}/${assets.length} Assets.`);

  // State (welches Asset zuletzt ENTRY war) wird immer geschrieben, damit
  // git add state.json nie auf eine fehlende Datei trifft. Nur das SENDEN
  // der Push-Benachrichtigung haengt am optionalen NTFY_TOPIC UND am
  // Handelsfenster (Tiam tradet nur 9-10 + 15-17 Uhr Wien wie TJR selbst — ein
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
    // Tiam, 2026-07-12: neue Trades werden jetzt NUR innerhalb des
    // Handelsfensters geloggt ("die KI soll nur zwischen 15 und 17 Uhr
    // analysieren") - seit 2026-07-15 zusaetzlich 9-10 Uhr Wien (London-
    // Session, siehe isViennaTradingWindow()). Vorher
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
    // Tiam, 2026-07-15: "wieso nimmt er immer ein entry weg? wenn er ein
    // entry hat und ganz sicher ist das es passt soll er es ja laufen
    // lassen" - vorher gewann "inWindow" IMMER, auch wenn ein echter offener
    // Paper-Trade lief: sobald die frische mechanische Neuberechnung (z.B.
    // weil der Sweep aus dem sweepLookbackBars-Fenster faellt) kein ENTRY
    // mehr bestaetigte, fiel die Anzeige innerhalb des Handelsfensters direkt
    // auf "kein Signal" zurueck statt die laufende offene Position zu zeigen
    // - obwohl der Trade selbst (siehe resolveSignals oben) unveraendert
    // offen und gueltig war. offener Trade hat jetzt IMMER Vorrang vor dem
    // reinen Fenster-Status - "wird beobachtet" bleibt sichtbar, bis
    // resolveSignals ihn tatsaechlich per Stop/Target aufloest, nicht bis
    // die Sweep-Erkennung zufaellig aus dem Lookback-Fenster laeuft.
    item.mode = openRec ? "monitoring" : (inWindow ? "analyzing" : "idle");
    if (isEntry && !wasEntry && NTFY_TOPIC && inWindow) {
      await sendNtfy(item.asset, item.sig);
    } else if (isEntry && !wasEntry && NTFY_TOPIC && !inWindow) {
      console.log(`ALERT uebersprungen (ausserhalb Handelsfenster 9-10/15-17 Wien): ${item.asset.name}`);
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
    aiEnabled: true,
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
