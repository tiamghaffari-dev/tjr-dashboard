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
  if (confirmingBos.length === 0) {
    result.detail = `Liquidity Sweep am ${new Date(recentSweep.ts).toISOString()} gefunden, aber noch kein bestaetigender BOS auf LTF.`;
    result.signal = "Watchlist (Sweep ohne Bestaetigung)";
    return result;
  }

  const bosEvent = confirmingBos[0];
  const ob = findOrderBlock(ltfDf, bosEvent.ts, wantDir);

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

  if (candidates.length === 0) {
    result.signal = "Watchlist (BOS bestaetigt, keine Entry-Zone im Discount/Premium)";
    result.detail = `Sweep+BOS am ${new Date(bosEvent.ts).toISOString()} bestaetigt Bias ${biasLabel}, aber keine FVG/OB im ${wantedZone}.`;
    return result;
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

  Object.assign(result, {
    signal: inZoneNow ? "ENTRY" : "Watchlist (auf Retracement in Zone warten)",
    detail: `Sweep ${recentSweep.type} @ ${recentSweep.level.toPrecision(6)} am ${new Date(recentSweep.ts).toISOString()}, `
      + `BOS ${bosEvent.dir} am ${new Date(bosEvent.ts).toISOString()}, Entry-Zone: ${cand.kind} [${cand.bottom.toPrecision(6)} - ${cand.top.toPrecision(6)}] (${zone}).`,
    entry: round6(entry), stop: round6(stop), target: round6(target), rr: rrTarget,
    sweep: recentSweep, bos: bosEvent, zoneKind: cand.kind, zoneRange: [cand.bottom, cand.top],
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
    sweep: null, bos: null, orderBlock: null,
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

  const confirmingBos = ltfBos.filter((b) => b.ts > recentSweep.ts && b.dir === wantDir);
  if (confirmingBos.length === 0) return ann;
  const bosEvent = confirmingBos[0];
  ann.bos = bosEvent;

  const ob = findOrderBlock(ltfDf, bosEvent.ts, wantDir);
  if (ob) ann.orderBlock = ob;

  const fvgs = unmitigatedFvgs(ltfDf, findFvgs(ltfDf));
  const wantedZone = wantDir === "up" ? "discount" : "premium";
  const candidates = [];
  for (const g of fvgs) {
    if (g.ts > recentSweep.ts) {
      const midG = (g.top + g.bottom) / 2;
      const { zone: z } = premiumDiscountZone(legLow, legHigh, midG);
      if ((g.type === "bullish" && wantDir === "up" && z === wantedZone)
        || (g.type === "bearish" && wantDir === "down" && z === wantedZone)) {
        candidates.push({ kind: "FVG", top: g.top, bottom: g.bottom });
      }
    }
  }
  if (ob) {
    const midOb = (ob.top + ob.bottom) / 2;
    const { zone: z } = premiumDiscountZone(legLow, legHigh, midOb);
    if (z === wantedZone) candidates.push({ kind: "OrderBlock", top: ob.top, bottom: ob.bottom });
  }
  if (candidates.length) {
    const currentPrice = ltfDf[ltfDf.length - 1].close;
    candidates.sort((a, b) => (
      Math.abs(currentPrice - (a.top + a.bottom) / 2) - Math.abs(currentPrice - (b.top + b.bottom) / 2)
    ));
    ann.zoneKind = candidates[0].kind;
    ann.zoneRange = [candidates[0].bottom, candidates[0].top];
  }
  return ann;
}

if (typeof module !== "undefined") {
  module.exports = {
    parseTs, loadCandles, resample, findSwings, computeTrendAndBos,
    findLiquiditySweeps, findFvgs, unmitigatedFvgs, findOrderBlock,
    premiumDiscountZone, buildSignal, buildAnnotations,
  };
}
