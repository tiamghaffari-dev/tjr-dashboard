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
    if (activeLow !== null && row.low < activeLow && row.close > activeLow) {
      sweeps.push({ ts: row.ts, type: "sell_side_sweep", level: activeLow, pos });
    }
    if (activeHigh !== null && row.high > activeHigh && row.close < activeHigh) {
      sweeps.push({ ts: row.ts, type: "buy_side_sweep", level: activeHigh, pos });
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

function buildSignal(htfDf, ltfDf, assetClass, rrTarget = 2.0, sweepLookbackBars = 40) {
  const { trend: htfTrend, bosEvents: htfBos } = computeTrendAndBos(htfDf);
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

  let stop, target;
  if (wantDir === "up") {
    stop = Math.min(cand.bottom, recentSweep.level) * 0.9985;
    const risk = entry - stop;
    target = entry + risk * rrTarget;
  } else {
    stop = Math.max(cand.top, recentSweep.level) * 1.0015;
    const risk = stop - entry;
    target = entry - risk * rrTarget;
  }

  const inZoneNow = cand.bottom <= currentPrice && currentPrice <= cand.top;

  const confDesc = conf.kind === "BOS"
    ? `BOS ${conf.event.dir} am ${new Date(conf.ts).toISOString()}`
    : `iFVG-Bruch (Richtung ${conf.event.dir}) am ${new Date(conf.ts).toISOString()}`;

  Object.assign(result, {
    signal: inZoneNow ? "ENTRY" : "Watchlist (auf Retracement in Zone warten)",
    detail: `Sweep ${recentSweep.type} @ ${recentSweep.level.toPrecision(6)} am ${new Date(recentSweep.ts).toISOString()}, `
      + `${confDesc}, Entry-Zone: ${cand.kind} [${cand.bottom.toPrecision(6)} - ${cand.top.toPrecision(6)}] (${zone}).`,
    entry: round6(entry), stop: round6(stop), target: round6(target), rr: rrTarget,
    sweep: recentSweep, bos: bosEvent, confirmation: conf,
    zoneKind: cand.kind, zoneRange: [cand.bottom, cand.top],
    currentPrice,
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
    findIfvg, findBreakerBlock,
    premiumDiscountZone, buildSignal, buildAnnotations,
  };
}
