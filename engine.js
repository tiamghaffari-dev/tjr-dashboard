// JS port of tjr_engine.py — must mirror the Python logic 1:1.
// Candle: {ts_ms, open, high, low, close, volume}

function parseTs(dateStr) {
  // "YYYY-MM-DD HH:MM:SS" naive local (ET) string -> treat as UTC pseudo-epoch
  // for deterministic, tz-independent, day-aligned bucketing (same trick as
  // pandas resample origin='start_day': any interval dividing 1440 min evenly
  // aligns to midnight boundaries the same way whether we call it UTC or not).
  const [d, t] = dateStr.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi, se] = (t || "00:00:00").split(":").map(Number);
  return Date.UTC(y, mo - 1, da, h, mi, se || 0);
}

function loadCandles(raw) {
  // raw: array of {date, open, high, low, close, volume}, API order = desc
  const rows = raw.map(r => ({
    ts: parseTs(r.date),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume,
  }));
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

function resample(df, intervalMinutes) {
  const intervalMs = intervalMinutes * 60000;
  const buckets = new Map();
  for (const row of df) {
    const bStart = Math.floor(row.ts / intervalMs) * intervalMs;
    if (!buckets.has(bStart)) {
      buckets.set(bStart, { ts: bStart, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, _lastTs: row.ts });
    } else {
      const b = buckets.get(bStart);
      b.high = Math.max(b.high, row.high);
      b.low = Math.min(b.low, row.low);
      b.volume += row.volume;
      if (row.ts >= b._lastTs) { b.close = row.close; b._lastTs = row.ts; }
      // open stays as first-seen since we iterate in ascending order
    }
  }
  const out = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
  out.forEach(b => delete b._lastTs);
  return out;
}

function findSwings(df) {
  const swings = [];
  for (let i = 0; i < df.length - 1; i++) {
    const upI = df[i].close >= df[i].open;
    const upI1 = df[i + 1].close >= df[i + 1].open;
    if (upI && !upI1) {
      const price = Math.max(df[i].high, df[i + 1].high);
      const ts = df[i].high >= df[i + 1].high ? df[i].ts : df[i + 1].ts;
      swings.push({ ts, price, type: "H" });
    } else if (!upI && upI1) {
      const price = Math.min(df[i].low, df[i + 1].low);
      const ts = df[i].low <= df[i + 1].low ? df[i].ts : df[i + 1].ts;
      swings.push({ ts, price, type: "L" });
    }
  }
  return swings;
}

function computeTrendAndBos(df) {
  const swingsSorted = findSwings(df).sort((a, b) => a.ts - b.ts);
  let trend = 0;
  const bosEvents = [];
  let activeHigh = null, activeLow = null;
  let swingPtr = 0;

  for (const row of df) {
    while (swingPtr < swingsSorted.length && swingsSorted[swingPtr].ts <= row.ts) {
      const s = swingsSorted[swingPtr];
      if (s.type === "H") activeHigh = s.price; else activeLow = s.price;
      swingPtr++;
    }
    if (activeHigh !== null && row.close > activeHigh) {
      bosEvents.push({ ts: row.ts, dir: "up", level: activeHigh });
      trend = 1;
      activeHigh = null;
    }
    if (activeLow !== null && row.close < activeLow) {
      bosEvents.push({ ts: row.ts, dir: "down", level: activeLow });
      trend = -1;
      activeLow = null;
    }
  }
  return { trend, bosEvents, swingsSorted };
}

function findLiquiditySweeps(df, swingsSorted) {
  const sweeps = [];
  let activeHigh = null, activeLow = null, swingPtr = 0;
  for (let pos = 0; pos < df.length; pos++) {
    const row = df[pos];
    while (swingPtr < swingsSorted.length && swingsSorted[swingPtr].ts <= row.ts) {
      const s = swingsSorted[swingPtr];
      if (s.type === "H") activeHigh = s.price; else activeLow = s.price;
      swingPtr++;
    }
    // `level` = the old resting-liquidity swing price that got swept (for
    // reference/labeling). `extreme` = the actual wick low/high the sweep
    // candle reached, which is by definition BEYOND `level` (that's what
    // makes it a sweep) - this is the real invalidation point TJR means by
    // "stop loss above liq sweep" (Bootcamp Day 38), not the pre-sweep
    // level itself. Added 2026-07-22 correctness/stop-placement pass.
    if (activeLow !== null && row.low < activeLow && row.close > activeLow) {
      sweeps.push({
        ts: row.ts, type: "sell_side_sweep", level: activeLow, extreme: row.low, pos,
      });
    }
    if (activeHigh !== null && row.high > activeHigh && row.close < activeHigh) {
      sweeps.push({
        ts: row.ts, type: "buy_side_sweep", level: activeHigh, extreme: row.high, pos,
      });
    }
  }
  return sweeps;
}

function findFvgs(df) {
  const fvgs = [];
  for (let i = 1; i < df.length - 1; i++) {
    if (df[i - 1].high < df[i + 1].low) {
      fvgs.push({ ts: df[i].ts, type: "bullish", bottom: df[i - 1].high, top: df[i + 1].low });
    }
    if (df[i - 1].low > df[i + 1].high) {
      fvgs.push({ ts: df[i].ts, type: "bearish", bottom: df[i + 1].high, top: df[i - 1].low });
    }
  }
  return fvgs;
}

function unmitigatedFvgs(df, fvgs) {
  const out = [];
  for (const gap of fvgs) {
    const after = df.filter(r => r.ts > gap.ts);
    let filled;
    if (gap.type === "bullish") filled = after.some(r => r.low <= gap.bottom);
    else filled = after.some(r => r.high >= gap.top);
    if (!filled) out.push(gap);
  }
  return out;
}

function findOrderBlock(df, bosTs, direction) {
  const window_ = df.filter(r => r.ts < bosTs).slice(-15);
  if (window_.length === 0) return null;
  if (direction === "up") {
    const reds = window_.filter(r => r.close < r.open);
    if (reds.length === 0) return null;
    const c = reds[reds.length - 1];
    return { ts: c.ts, type: "bullish_ob", top: c.high, bottom: c.low };
  } else {
    const greens = window_.filter(r => r.close > r.open);
    if (greens.length === 0) return null;
    const c = greens[greens.length - 1];
    return { ts: c.ts, type: "bearish_ob", top: c.high, bottom: c.low };
  }
}

function premiumDiscountZone(legLow, legHigh, price) {
  const mid = (legLow + legHigh) / 2;
  return { zone: price < mid ? "discount" : "premium", mid };
}

// iFVG (inverse FVG) — TJR's own glossary definition (Bootcamp Day 30 / "Beginners
// Guide"): "fvg that gets disrespected within current trend that shows a change of
// trend". An FVG that later gets closed (not just wicked) through its FAR edge signals
// a trend shift — functions as a CONFIRMATION signal alongside BOS, not an entry zone
// itself. Deliberately stricter than unmitigatedFvgs (which only checks a wick touch):
// this requires a close through the opposite edge, mirroring BOS's close-based rule.
function findIfvg(df, fvgs) {
  const events = [];
  for (const gap of fvgs) {
    const after = df.filter(r => r.ts > gap.ts);
    if (gap.type === "bullish") {
      const broken = after.find(r => r.close < gap.bottom);
      if (broken) events.push({ ts: broken.ts, dir: "down", originTs: gap.ts, top: gap.top, bottom: gap.bottom });
    } else {
      const broken = after.find(r => r.close > gap.top);
      if (broken) events.push({ ts: broken.ts, dir: "up", originTs: gap.ts, top: gap.top, bottom: gap.bottom });
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

// Breaker Block — TJR's own glossary definition: "move up or down prior to the break
// of structure to the up/downside in trend shift". Implemented as: the Order Block of
// the PREVIOUS (opposite) trend direction that existed before the current liquidity
// sweep and has since been broken by a close through it — the old OB flips polarity
// (former resistance becomes support, or vice versa) and becomes the new zone for the
// trend shift. Reuses findOrderBlock's same window logic, just anchored at the last
// opposite-direction BOS before the sweep instead of the confirming BOS/iFVG after it.
function findBreakerBlock(df, bosEvents, sweepTs, direction) {
  const oppositeDir = direction === "up" ? "down" : "up";
  const priorOppositeBos = bosEvents.filter(b => b.ts < sweepTs && b.dir === oppositeDir);
  if (priorOppositeBos.length === 0) return null;
  const anchorTs = priorOppositeBos[priorOppositeBos.length - 1].ts;
  const oldOb = findOrderBlock(df, anchorTs, oppositeDir);
  if (!oldOb) return null;
  const after = df.filter(r => r.ts > oldOb.ts);
  const broken = oppositeDir === "up"
    ? after.some(r => r.close < oldOb.bottom)
    : after.some(r => r.close > oldOb.top);
  if (!broken) return null;
  return { ts: oldOb.ts, type: `breaker_${direction}`, top: oldOb.top, bottom: oldOb.bottom };
}

// TJRs eigenes Execution-Checklist (5h "Beginners Guide"-Video, gefunden
// 2026-07-15): nach der 5min-Continuation-Zone braucht es NOCH eine eigene
// "1 min confirmation (bos,ifvg)" bevor tatsaechlich eingestiegen wird - ein
// zusaetzliches, feineres Gate, das bisher fehlte (die Engine ist bis hierhin
// direkt von der 5min-Zone auf ENTRY gesprungen, sobald der Preis drin war).
// Ablauf: (1) finde die erste 1min-Kerze seit "sinceTs" (dem 5min-
// Bestaetigungszeitpunkt), die die Zone ueberhaupt beruehrt (touch) - (2) ab
// dieser Kerze, suche einen 1min-BOS oder -iFVG in Richtung wantDir
// (confirmed). Degradiert absichtlich sauber, wenn keine m1-Daten da sind
// (m1Df leer/undefined) - der Aufrufer entscheidet dann, ob er ohne dieses
// Gate weiterarbeitet (siehe buildSignal()), damit ein Datenausfall nicht
// automatisch jedes Signal blockiert.
// Fix, 2026-07-22 (Korrektheits-Audit): computeTrendAndBos/findIfvg wurden
// bisher nur auf "afterTouch" (die auf den Touch-Zeitpunkt gekuerzte Slice)
// aufgerufen - das kappt jede Schwing-/Level-Historie von VOR dem Touch weg,
// wodurch das Modell fuer einen 1min-BOS immer erst einen komplett NEUEN
// Schwingpunkt NACH dem Touch bilden musste, statt (wie ueberall sonst im
// Code - siehe ltfBos/htfBos: volle Historie berechnen, dann per Zeitstempel
// filtern) einen bereits bestehenden, kurz vor dem Touch entstandenen Level
// brechen zu duerfen. Das ist der weitaus haeufigere echte Fall und wurde
// bisher systematisch verpasst. Fix: dieselbe "volle Historie -> nach
// Zeitstempel filtern"-Konvention wie ueberall sonst.
function find1minConfirmation(m1Df, zoneBottom, zoneTop, wantDir, sinceTs) {
  if (!m1Df || m1Df.length === 0) return { touched: false, confirmed: false, touchTs: null, event: null };
  const relevant = m1Df.filter((r) => r.ts >= sinceTs);
  const touchCandle = relevant.find((r) => r.low <= zoneTop && r.high >= zoneBottom);
  if (!touchCandle) return { touched: false, confirmed: false, touchTs: null, event: null };
  const { bosEvents: m1Bos } = computeTrendAndBos(m1Df);
  const confirmingBos1m = m1Bos.filter((b) => b.ts >= touchCandle.ts && b.dir === wantDir);
  const ifvgEvents1m = findIfvg(m1Df, findFvgs(m1Df));
  const confirmingIfvg1m = ifvgEvents1m.filter((e) => e.ts >= touchCandle.ts && e.dir === wantDir);
  const cands = [];
  if (confirmingBos1m.length) cands.push({ kind: "BOS", ts: confirmingBos1m[0].ts, event: confirmingBos1m[0] });
  if (confirmingIfvg1m.length) cands.push({ kind: "iFVG", ts: confirmingIfvg1m[0].ts, event: confirmingIfvg1m[0] });
  cands.sort((a, b) => a.ts - b.ts);
  if (cands.length === 0) return { touched: true, confirmed: false, touchTs: touchCandle.ts, event: null };
  return { touched: true, confirmed: true, touchTs: touchCandle.ts, event: cands[0] };
}

// Tiam, 2026-07-15: Screenshot zeigte eine riesige Position-Box - "die KI
// nimmt viel zu grosse trades... tjr sagt immer markier die oldtime highs
// oder lows als target". Bisher war target = entry +/- risk*rrTarget, ein
// rein rechnerisches 2:1-Projektionsziel OHNE jeden Bezug zu echter Struktur
// - genau das widerspricht TJRs eigenem, bereits dokumentiertem Schritt "g)
// take profit at other key levels" (siehe project_tjr_strategy Memory,
// Checklist-Schritt 1: "key levels: 1hr, 4hr liq and session highs/lows").
// Ersetzt den fixen Multiple-Ansatz durch: naechster NOCH NICHT geswepter
// 4H-Swing (Schritt 1's "4hr liq") in Trade-Richtung. Tiam hat sich per
// Rueckfrage explizit fuer HTF-Swing (statt Session-High/Low oder beides)
// entschieden, mit Fallback aufs alte fixe Ziel, falls kein Level in
// sinnvoller Naehe existiert (sonst waere RR zu klein/negativ - ein "target"
// direkt neben dem Entry ist kein echtes Ziel).
const MIN_KEY_LEVEL_RR = 1.0;

// Tiam, 2026-07-15 (Folgefrage direkt danach): "jetzt nimmt er nur den
// letzten high er soll ja den gesamten chart so anschauen und was so
// ungefaehre praktische highs waeren die makiert er und verwenden die als
// referenz fuer take profit". Der urspruengliche Ansatz oben nutzte
// computeTrendAndBos()s swingsSorted (findSwings()'s 2-Kerzen-Richtungs-
// wechsel-Logik) als Kandidatenliste - die ist fuer Trend/BOS genau richtig
// (jeder noch so kleine Richtungswechsel zaehlt), aber fuer "was wuerde TJR
// als echtes Key-Level markieren, wenn er ueber den GANZEN Chart schaut"
// viel zu empfindlich: fast jede kleine Gegenbewegung erzeugt einen
// "Swing", und "naechster ungeswepter Swing" landet dadurch oft auf einem
// belanglosen kleinen Zwischenhoch direkt neben dem Entry statt auf einem
// wirklich sichtbaren High/Low. Separater, groeberer Pivot-Filter NUR fuer
// die Target-Suche (Bias/BOS/Sweep-Logik bleibt unveraendert, die braucht
// weiterhin die feine Swing-Erkennung): ein High/Low zaehlt nur, wenn es
// das tatsaechliche Extremum in einem WEITEN Fenster um sich herum ist
// (Standard-"Fraktal"-Pivot: hoechster/niedrigster Punkt unter den +/-N
// Nachbarkerzen), nicht nur verglichen mit der direkten Nachbarkerze.
const PROMINENT_SWING_WINDOW_BARS = 6; // 4H-Kerzen: +/-6 Kerzen = +/-24h um jeden Kandidaten

function findProminentHtfSwingLevels(htfDf, windowBars = PROMINENT_SWING_WINDOW_BARS) {
  const levels = [];
  for (let i = windowBars; i < htfDf.length - windowBars; i++) {
    const windowSlice = htfDf.slice(i - windowBars, i + windowBars + 1);
    const c = htfDf[i];
    const windowHigh = Math.max(...windowSlice.map((r) => r.high));
    const windowLow = Math.min(...windowSlice.map((r) => r.low));
    if (c.high === windowHigh) levels.push({ ts: c.ts, price: c.high, type: "H" });
    if (c.low === windowLow) levels.push({ ts: c.ts, price: c.low, type: "L" });
  }
  return levels;
}

function findKeyLevelTarget(htfSwings, htfDf, wantDir, entry, risk) {
  if (!risk || risk <= 0) return null;
  const wantType = wantDir === "up" ? "H" : "L";
  const inDirection = htfSwings.filter((s) => (
    s.type === wantType && (wantType === "H" ? s.price > entry : s.price < entry)
  ));
  // "Noch nicht geswept" = keine spaetere HTF-Kerze hat den Level bereits
  // durchbrochen (High >= Swing-High bzw. Low <= Swing-Low) - sonst ist es
  // keine echte, noch offene Liquiditaet mehr, sondern schon abgearbeitet.
  const untouched = inDirection.filter((s) => {
    const after = htfDf.filter((r) => r.ts > s.ts);
    return wantType === "H" ? !after.some((r) => r.high >= s.price) : !after.some((r) => r.low <= s.price);
  });
  untouched.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  for (const cand of untouched) {
    const reward = Math.abs(cand.price - entry);
    if (reward / risk >= MIN_KEY_LEVEL_RR) return cand.price;
  }
  return null;
}

// Tiam, 2026-07-24: "manche take profits sollen ja oldtime highs oder lows
// sein [...] und auch mehrere take profits setzen weil es kann sein das es
// ueber ein oldtime high geht und auch vllt noch ueber ein anderes aber dann
// waere das erste oldtime high ja der stop loss" - TJRs eigener Checklist-
// Schritt g) "take profit AT OTHER key levels" (Plural) wurde bisher nur mit
// EINEM Level umgesetzt (findKeyLevelTarget oben). Diese Funktion sammelt bis
// zu `maxCount` Level (statt nur das naechste), sortiert nach Distanz vom
// Entry - identische "noch nicht geswept" + Mindest-RR-Filterung wie oben,
// nur dass hier weitergesammelt statt beim ersten Treffer abgebrochen wird.
// AskUserQuestion mit Tiam ergab: 2 Level (TP1/TP2), TP1 = Teilausstieg 50%
// + Stop wird auf TP1 nachgezogen (siehe buildSignal()/resolveSignals()).
function findMultipleKeyLevelTargets(htfSwings, htfDf, wantDir, entry, risk, maxCount = 2) {
  if (!risk || risk <= 0) return [];
  const wantType = wantDir === "up" ? "H" : "L";
  const inDirection = htfSwings.filter((s) => (
    s.type === wantType && (wantType === "H" ? s.price > entry : s.price < entry)
  ));
  const untouched = inDirection.filter((s) => {
    const after = htfDf.filter((r) => r.ts > s.ts);
    return wantType === "H" ? !after.some((r) => r.high >= s.price) : !after.some((r) => r.low <= s.price);
  });
  untouched.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const hits = [];
  for (const cand of untouched) {
    const reward = Math.abs(cand.price - entry);
    if (reward / risk >= MIN_KEY_LEVEL_RR) {
      hits.push(cand.price);
      if (hits.length >= maxCount) break;
    }
  }
  return hits;
}

function buildSignal(htfDf, ltfDf, m1Df, assetClass, rrTarget = 2.0, sweepLookbackBars = 40) {
  const { trend: htfTrend, bosEvents: htfBos } = computeTrendAndBos(htfDf);
  // Grobe, "wuerde ein Mensch das beim Ueberfliegen des Charts markieren"
  // Kandidatenliste fuers Target - siehe Kommentar bei findProminentHtfSwingLevels.
  const htfKeyLevels = findProminentHtfSwingLevels(htfDf);
  const bias = htfDf.length ? htfTrend : 0;
  const biasLabel = { 1: "bullish", "-1": "bearish", 0: "neutral" }[bias];

  const { bosEvents: ltfBos, swingsSorted: ltfSwings } = computeTrendAndBos(ltfDf);
  const sweeps = findLiquiditySweeps(ltfDf, ltfSwings);
  const fvgs = unmitigatedFvgs(ltfDf, findFvgs(ltfDf));

  const result = {
    bias: biasLabel,
    htfLastBos: htfBos.length ? htfBos[htfBos.length - 1] : null,
    signal: "kein Setup",
    detail: "",
    entry: null, stop: null, target: null, rr: null, zone: null,
    target2: null, rr2: null, partialExit: false,
  };

  if (bias === 0 || sweeps.length === 0) {
    result.detail = "Kein klarer HTF-Bias oder kein Liquidity Sweep auf LTF gefunden.";
    return result;
  }

  const wantType = bias === 1 ? "sell_side_sweep" : "buy_side_sweep";
  let recentSweep = null;
  for (let i = sweeps.length - 1; i >= 0; i--) {
    const sw = sweeps[i];
    if (sw.type === wantType && sw.pos >= ltfDf.length - sweepLookbackBars) { recentSweep = sw; break; }
  }
  if (recentSweep === null) {
    result.detail = `Kein passender Liquidity Sweep in Richtung ${biasLabel} in den letzten ${sweepLookbackBars} LTF-Kerzen.`;
    return result;
  }

  const wantDir = bias === 1 ? "up" : "down";
  const confirmingBos = ltfBos.filter(b => b.ts > recentSweep.ts && b.dir === wantDir);

  // TJR's own framework (Bootcamp Day 30 / "Beginners Guide" glossary): confirmation =
  // bos, ifvg, smt. SMT (needs a second correlated data feed) is separate, not implemented.
  const ifvgEvents = findIfvg(ltfDf, findFvgs(ltfDf));
  const confirmingIfvg = ifvgEvents.filter(e => e.ts > recentSweep.ts && e.dir === wantDir);

  if (confirmingBos.length === 0 && confirmingIfvg.length === 0) {
    result.detail = `Liquidity Sweep am ${new Date(recentSweep.ts).toISOString()} gefunden, aber noch kein bestaetigender BOS oder iFVG auf LTF.`;
    result.signal = "Watchlist (Sweep ohne Bestaetigung)";
    return result;
  }

  // Confirmation can be BOS OR iFVG — take whichever happened first after the sweep.
  const confCandidates = [];
  if (confirmingBos.length) confCandidates.push({ kind: "BOS", ts: confirmingBos[0].ts, event: confirmingBos[0] });
  if (confirmingIfvg.length) confCandidates.push({ kind: "iFVG", ts: confirmingIfvg[0].ts, event: confirmingIfvg[0] });
  confCandidates.sort((a, b) => a.ts - b.ts);
  const conf = confCandidates[0];

  const bosEvent = confirmingBos.length ? confirmingBos[0] : null;
  const ob = findOrderBlock(ltfDf, conf.ts, wantDir);
  const bb = findBreakerBlock(ltfDf, ltfBos, recentSweep.ts, wantDir);

  const sinceSweep = ltfDf.filter(r => r.ts >= recentSweep.ts);
  let legLow, legHigh;
  if (wantDir === "up") {
    legLow = recentSweep.level;
    legHigh = Math.max(...sinceSweep.map(r => r.high));
  } else {
    legHigh = recentSweep.level;
    legLow = Math.min(...sinceSweep.map(r => r.low));
  }

  const currentPrice = ltfDf[ltfDf.length - 1].close;
  const { zone, mid } = premiumDiscountZone(legLow, legHigh, currentPrice);
  result.zone = zone;

  const wantedZone = wantDir === "up" ? "discount" : "premium";

  const candidates = [];
  for (const g of fvgs) {
    if (g.ts > recentSweep.ts) {
      const midG = (g.top + g.bottom) / 2;
      const { zone: z } = premiumDiscountZone(legLow, legHigh, midG);
      if ((g.type === "bullish" && wantDir === "up" && z === wantedZone) ||
          (g.type === "bearish" && wantDir === "down" && z === wantedZone)) {
        candidates.push({ kind: "FVG", top: g.top, bottom: g.bottom });
      }
    }
  }
  if (ob) {
    const midOb = (ob.top + ob.bottom) / 2;
    const { zone: z } = premiumDiscountZone(legLow, legHigh, midOb);
    if (z === wantedZone) candidates.push({ kind: "OrderBlock", top: ob.top, bottom: ob.bottom });
  }
  if (bb) {
    const midBb = (bb.top + bb.bottom) / 2;
    const { zone: z } = premiumDiscountZone(legLow, legHigh, midBb);
    if (z === wantedZone) candidates.push({ kind: "BreakerBlock", top: bb.top, bottom: bb.bottom });
  }

  if (candidates.length === 0) {
    // Tiam, 2026-07-14: "wende einfach alles an was tjr angewendet hat" - TJRs
    // eigenes, live getipptes Framework (Bootcamp Day 30 / "Beginners Guide"
    // Glossar) listet "eq" (Equilibrium) gleichrangig neben fvg/ob/bb als
    // vierten Continuation-Zonentyp: "continuation: fvgs, ob, bb, eq". Bisher
    // wurde Equilibrium nur als Premium/Discount-FILTER fuer die anderen drei
    // Zonentypen benutzt, nie selbst als eigenstaendige Entry-Zone - dieser
    // Fall fuehrte bisher zu "Watchlist, keine Entry-Zone" obwohl Sweep+
    // Bestaetigung schon vorlagen. Fix: wenn KEINE FVG/OB/Breaker-Zone im
    // Discount/Premium existiert, zaehlt die GANZE Discount/Premium-Haelfte
    // selbst als (breitere, weniger praezise) Entry-Zone - als Fallback,
    // NICHT als Ersatz fuer die praeziseren Zonen (die bleiben durch die
    // bestehende candidates.sort()-Naeherungslogik immer bevorzugt, wenn
    // vorhanden - kein Video zeigt je einen Trade auf Equilibrium ALLEIN
    // ohne FVG/OB/BB, deshalb bewusst als schwaechste/letzte Option).
    const eqTop = wantDir === "up" ? mid : legHigh;
    const eqBottom = wantDir === "up" ? legLow : mid;
    candidates.push({ kind: "Equilibrium", top: eqTop, bottom: eqBottom });
  }

  candidates.sort((a, b) => {
    const distA = Math.abs(currentPrice - (a.top + a.bottom) / 2);
    const distB = Math.abs(currentPrice - (b.top + b.bottom) / 2);
    return distA - distB;
  });
  const cand = candidates[0];
  const entry = (cand.top + cand.bottom) / 2;

  // Tiam, 2026-07-22: "er soll auch geschickter die Stop loss setzen [...]
  // es soll passen und auch ned zu klein sein" - TJRs eigene Regel aus
  // Bootcamp Day 38 ("Stop-Losses"): "stop loss above liq sweep" (analog
  // darunter fuer Longs) - der Stop gehoert jenseits des tatsaechlichen
  // Sweep-Dochts (dem Punkt, wo der Preis wirklich hinlief, BEVOR er
  // zurueckdrehte), nicht nur jenseits des ALTEN, VOR dem Sweep liegenden
  // Swing-Levels. `recentSweep.level` ist per Definition WENIGER extrem als
  // `recentSweep.extreme` (genau das macht es ja zu einem Sweep - der Preis
  // ging drueber hinaus), also war der Stop bisher zu nah dran: ein
  // normaler Retest bis knapp an den alten Level haette schon ausgestoppt,
  // obwohl die eigentliche Sweep-These (Preis nimmt NICHT nochmal den
  // wirklichen Extrempunkt) noch gar nicht widerlegt war. `sweepAnchor`
  // faellt auf `.level` zurueck, falls `.extreme` aus irgendeinem Grund
  // fehlt (sollte nach diesem Fix nicht mehr vorkommen, reine Absicherung).
  const sweepAnchor = recentSweep.extreme ?? recentSweep.level;
  // Tiam, 2026-07-24: "mehrere take profits [...] es kann sein das es ueber
  // ein oldtime high geht und auch vllt noch ueber ein anderes aber dann
  // waere das erste oldtime high ja der stop loss" - bis zu 2 Key-Level als
  // TP1/TP2 statt nur einem (siehe findMultipleKeyLevelTargets()). TP1 =
  // Teilausstieg 50%, Stop wird danach auf TP1 nachgezogen fuer den Rest
  // Richtung TP2 (per AskUserQuestion mit Tiam bestaetigt) - die eigentliche
  // Nachzieh-/Teilausstiegs-Mechanik lebt in build.js' resolveSignals(),
  // hier wird nur berechnet, WELCHE Level ueberhaupt in Frage kommen.
  let stop, target, target2, targetSource;
  if (wantDir === "up") {
    stop = Math.min(cand.bottom, sweepAnchor) * 0.9985;
    const risk = entry - stop;
    const keyLevels = findMultipleKeyLevelTargets(htfKeyLevels, htfDf, wantDir, entry, risk, 2);
    if (keyLevels.length > 0) {
      target = keyLevels[0];
      target2 = keyLevels.length > 1 ? keyLevels[1] : null;
      targetSource = "key-level";
    } else {
      target = entry + risk * rrTarget; target2 = null; targetSource = "fixed-rr-fallback";
    }
  } else {
    stop = Math.max(cand.top, sweepAnchor) * 1.0015;
    const risk = stop - entry;
    const keyLevels = findMultipleKeyLevelTargets(htfKeyLevels, htfDf, wantDir, entry, risk, 2);
    if (keyLevels.length > 0) {
      target = keyLevels[0];
      target2 = keyLevels.length > 1 ? keyLevels[1] : null;
      targetSource = "key-level";
    } else {
      target = entry - risk * rrTarget; target2 = null; targetSource = "fixed-rr-fallback";
    }
  }
  const partialExit = target2 !== null;
  const riskDist = Math.abs(entry - stop);
  const rrActual = riskDist > 0 ? Math.round((Math.abs(target - entry) / riskDist) * 100) / 100 : rrTarget;
  const rr2Actual = (partialExit && riskDist > 0) ? Math.round((Math.abs(target2 - entry) / riskDist) * 100) / 100 : null;

  const inZoneNow = cand.bottom <= currentPrice && currentPrice <= cand.top;

  // TJRs eigenes Checklist verlangt NACH der 5min-Zone noch eine eigene
  // 1min-Bestaetigung (BOS/iFVG), bevor tatsaechlich eingestiegen wird - ohne
  // m1-Daten (Fetch fehlgeschlagen etc.) degradiert das sauber auf die alte
  // "Preis ist in der Zone" Logik, damit ein Datenausfall nie automatisch
  // jedes Signal blockiert.
  const hasM1Data = !!(m1Df && m1Df.length > 0);
  const m1 = hasM1Data
    ? find1minConfirmation(m1Df, cand.bottom, cand.top, wantDir, conf.ts)
    : { touched: inZoneNow, confirmed: inZoneNow, touchTs: null, event: null };
  const zoneTouched = hasM1Data ? m1.touched : inZoneNow;

  let signal;
  if (!zoneTouched) {
    signal = "Watchlist (auf Retracement in Zone warten)";
  } else if (hasM1Data && !m1.confirmed) {
    signal = "Watchlist (in Zone, warte auf 1min-Bestaetigung)";
  } else {
    signal = "ENTRY";
  }

  const confDesc = conf.kind === "BOS"
    ? `BOS ${conf.event.dir} am ${new Date(conf.ts).toISOString()}`
    : `iFVG-Bruch (Richtung ${conf.event.dir}) am ${new Date(conf.ts).toISOString()}`;
  const m1Desc = !hasM1Data
    ? " (keine 1min-Daten - 1min-Gate uebersprungen)"
    : m1.confirmed
      ? `, 1min-Bestaetigung: ${m1.event.kind} am ${new Date(m1.event.ts).toISOString()}`
      : zoneTouched ? ", wartet noch auf 1min-Bestaetigung" : "";
  const targetDesc = targetSource === "key-level"
    ? (partialExit
      ? `TP1: naechstes offenes 4H-Key-Level @ ${target.toPrecision(6)} (RR ${rrActual}, 50% Teilausstieg + Stop-Nachzug), TP2: ${target2.toPrecision(6)} (RR ${rr2Actual})`
      : `Target: naechstes offenes 4H-Key-Level @ ${target.toPrecision(6)} (RR ${rrActual})`)
    : `Target: kein 4H-Key-Level in sinnvoller Naehe - fixes ${rrTarget}:1-Ziel @ ${target.toPrecision(6)}`;

  Object.assign(result, {
    signal,
    detail: `Sweep ${recentSweep.type} @ ${recentSweep.level.toPrecision(6)} am ${new Date(recentSweep.ts).toISOString()}, `
      + `${confDesc}, Entry-Zone: ${cand.kind} [${cand.bottom.toPrecision(6)} - ${cand.top.toPrecision(6)}] (${zone})${m1Desc}. ${targetDesc}.`,
    entry: round6(entry), stop: round6(stop), target: round6(target), rr: rrActual,
    target2: target2 !== null ? round6(target2) : null, rr2: rr2Actual, partialExit,
    sweep: recentSweep, bos: bosEvent, confirmation: conf,
    zoneKind: cand.kind, zoneRange: [cand.bottom, cand.top],
    currentPrice, targetSource,
    m1Gate: hasM1Data, m1Confirmation: m1.confirmed ? m1.event : null, zoneTouchTs: m1.touchTs,
  });
  return result;
}

function round6(x) { return Math.round(x * 1e6) / 1e6; }

// Purely additive, for visualization only — never touches buildSignal's
// validated decision logic. Mirrors the same steps but always surfaces
// whatever partial structure was found (sweep without BOS, BOS without a
// valid zone, etc.), so a chart can show "this is what's been analyzed so
// far" even when the mechanical signal is still "kein Setup"/"Watchlist".
function buildAnnotations(htfDf, ltfDf, sweepLookbackBars = 40) {
  const { trend: htfTrend, bosEvents: htfBos } = computeTrendAndBos(htfDf);
  const bias = htfDf.length ? htfTrend : 0;
  const biasLabel = { 1: "bullish", "-1": "bearish", 0: "neutral" }[bias];

  const ann = {
    bias: biasLabel,
    htfLastBos: htfBos.length ? htfBos[htfBos.length - 1] : null,
    sweep: null, bos: null, orderBlock: null, breakerBlock: null, confirmation: null,
    equilibrium: null, zoneKind: null, zoneRange: null,
  };
  if (bias === 0) return ann;

  const { bosEvents: ltfBos, swingsSorted: ltfSwings } = computeTrendAndBos(ltfDf);
  const sweeps = findLiquiditySweeps(ltfDf, ltfSwings);
  const wantType = bias === 1 ? "sell_side_sweep" : "buy_side_sweep";
  let recentSweep = null;
  for (let i = sweeps.length - 1; i >= 0; i--) {
    const sw = sweeps[i];
    if (sw.type === wantType && sw.pos >= ltfDf.length - sweepLookbackBars) { recentSweep = sw; break; }
  }
  if (!recentSweep) return ann;
  ann.sweep = recentSweep;

  const wantDir = bias === 1 ? "up" : "down";
  const sinceSweep = ltfDf.filter((r) => r.ts >= recentSweep.ts);
  let legLow, legHigh;
  if (wantDir === "up") {
    legLow = recentSweep.level;
    legHigh = sinceSweep.length ? Math.max(...sinceSweep.map((r) => r.high)) : recentSweep.level;
  } else {
    legHigh = recentSweep.level;
    legLow = sinceSweep.length ? Math.min(...sinceSweep.map((r) => r.low)) : recentSweep.level;
  }
  ann.equilibrium = (legLow + legHigh) / 2;
  // Tiam, 2026-07-13: Screenshot von TJRs Fib-Retracement-Equilibrium-Tool
  // geschickt (gruene Box von Swing-Low bis Swing-High, 0.5-Linie
  // hervorgehoben) - der Chart braucht dafuer die volle Spanne, nicht nur
  // den Mittelpunkt. Rein additiv, gleiche legLow/legHigh die eh schon fuer
  // ann.equilibrium berechnet werden.
  ann.equilibriumRange = [legLow, legHigh];

  const confirmingBos = ltfBos.filter((b) => b.ts > recentSweep.ts && b.dir === wantDir);
  const ifvgEvents = findIfvg(ltfDf, findFvgs(ltfDf));
  const confirmingIfvg = ifvgEvents.filter((e) => e.ts > recentSweep.ts && e.dir === wantDir);
  if (confirmingBos.length === 0 && confirmingIfvg.length === 0) return ann;

  const confCandidates = [];
  if (confirmingBos.length) confCandidates.push({ kind: "BOS", ts: confirmingBos[0].ts, event: confirmingBos[0] });
  if (confirmingIfvg.length) confCandidates.push({ kind: "iFVG", ts: confirmingIfvg[0].ts, event: confirmingIfvg[0] });
  confCandidates.sort((a, b) => a.ts - b.ts);
  const conf = confCandidates[0];
  ann.confirmation = conf;
  if (confirmingBos.length) ann.bos = confirmingBos[0];

  const ob = findOrderBlock(ltfDf, conf.ts, wantDir);
  if (ob) ann.orderBlock = ob;

  const bb = findBreakerBlock(ltfDf, ltfBos, recentSweep.ts, wantDir);
  if (bb) ann.breakerBlock = bb;

  const fvgs = unmitigatedFvgs(ltfDf, findFvgs(ltfDf));
  const wantedZone = wantDir === "up" ? "discount" : "premium";
  const candidates = [];
  for (const g of fvgs) {
    if (g.ts > recentSweep.ts) {
      const midG = (g.top + g.bottom) / 2;
      const { zone: z } = premiumDiscountZone(legLow, legHigh, midG);
      if ((g.type === "bullish" && wantDir === "up" && z === wantedZone)
        || (g.type === "bearish" && wantDir === "down" && z === wantedZone)) {
        candidates.push({ kind: "FVG", top: g.top, bottom: g.bottom, ts: g.ts });
      }
    }
  }
  if (ob) {
    const midOb = (ob.top + ob.bottom) / 2;
    const { zone: z } = premiumDiscountZone(legLow, legHigh, midOb);
    if (z === wantedZone) candidates.push({ kind: "OrderBlock", top: ob.top, bottom: ob.bottom, ts: ob.ts });
  }
  if (bb) {
    const midBb = (bb.top + bb.bottom) / 2;
    const { zone: z } = premiumDiscountZone(legLow, legHigh, midBb);
    if (z === wantedZone) candidates.push({ kind: "BreakerBlock", top: bb.top, bottom: bb.bottom, ts: bb.ts });
  }
  if (candidates.length === 0) {
    // Mirrors the same Equilibrium-fallback added to buildSignal() above, so the
    // chart's zone box matches what the actual signal decision used. ts is set to
    // recentSweep.ts (same as the other candidate kinds need for drawZoneBox's
    // startIdx lookup) even though drawZoneBox's call site in report_template.html
    // deliberately SKIPS drawing a separate box when zoneKind === "Equilibrium" —
    // drawEquilibriumBox already renders this exact same discount/premium half with
    // its own dedicated styling, so a second box would just be a redundant,
    // mislabeled duplicate (ZONE_STYLES has no "Equilibrium" entry).
    const eqTop = wantDir === "up" ? ann.equilibrium : legHigh;
    const eqBottom = wantDir === "up" ? legLow : ann.equilibrium;
    candidates.push({ kind: "Equilibrium", top: eqTop, bottom: eqBottom, ts: recentSweep.ts });
  }
  if (candidates.length) {
    const currentPrice = ltfDf[ltfDf.length - 1].close;
    candidates.sort((a, b) => (
      Math.abs(currentPrice - (a.top + a.bottom) / 2) - Math.abs(currentPrice - (b.top + b.bottom) / 2)
    ));
    ann.zoneKind = candidates[0].kind;
    ann.zoneRange = [candidates[0].bottom, candidates[0].top];
    // Box start = the candle where the zone actually originates (OB candle, or the
    // FVG's middle candle). Box end = the confirming BOS candle (bos is always set
    // by this point, see the early-return above) — bounds the box to "the move this
    // zone caused", matching TJR's own on-chart boxes (tight to origin, not stretched
    // to present time) instead of the old full-width horizontal lines.
    ann.zoneTs = candidates[0].ts;
  }
  return ann;
}

if (typeof module !== "undefined") {
  module.exports = {
    parseTs, loadCandles, resample, findSwings, computeTrendAndBos,
    findLiquiditySweeps, findFvgs, unmitigatedFvgs, findOrderBlock,
    findIfvg, findBreakerBlock, find1minConfirmation, findKeyLevelTarget,
    findProminentHtfSwingLevels,
    premiumDiscountZone, buildSignal, buildAnnotations,
  };
}
