"use strict";
/*
 * methode_seite.js - erzeugt docs/tjr_methode.html
 *
 * Tiam, 2026-10-02: "ich moechte, dass du kontrollierst, dass die KI das macht
 * [...] damit sie weiss, okay, bei diesem Chart, bei dieser Timeline, muss ich
 * das und das machen."
 *
 * Diese Seite ist die Antwort darauf - und zwar so, dass er es NACHPRUEFEN kann,
 * statt mir glauben zu muessen. Sie stellt nebeneinander:
 *   1. was TJR auf welchem Zeitrahmen macht, mit Beleg aus dem Video
 *   2. was die Engine dort tatsaechlich tut, mit Fundstelle im Code
 *   3. ob eine Stufe ERZWUNGEN wird oder nur GEMESSEN
 *   4. wie oft sie in den echten Trades erfuellt war
 *
 * Punkt 3 und 4 sind der eigentliche Zweck. Am 02.10. kam dabei heraus, dass
 * TJRs Schritt (a) - "wait for price to hit key level" - nie erzwungen wurde
 * und dass genau dort -39,1R der -42,4R Long-Verluste sassen. Solche Luecken
 * sollen kuenftig auf der Seite stehen, nicht in meinen Erklaerungen.
 *
 * Reine Anzeige: beeinflusst kein Signal.
 */

const fs = require("fs");
const path = require("path");

// Die Zeitrahmen-Leiter. Reihenfolge = TJRs Reihenfolge (Weekly runter bis 1min).
const LEITER = [
  {
    tf: "Woche",
    aufgabe: "Gesamtrichtung und Kontext - wohin will der Kurs diese Woche?",
    beleg: '"the daily bias is the start of a weekly time[frame] to figure out where is our overall direction"',
    quelle: "Bootcamp Day 35, Daily Bias pt. 2",
    engine: "Wochenstruktur (Equilibrium der letzten 12 Wochen) -> Regel R10",
    code: "build.js: fetchWeeklyCandles()",
  },
  {
    tf: "Tag",
    aufgabe: "Daily Bias - die Richtung, gegen die nicht gehandelt wird",
    beleg: '"can we go against daily bias? no"',
    quelle: "Bootcamp Tag 49",
    engine: "Daily-Marktstruktur (BOS auf dem Tageschart) -> Regel R9",
    code: "build.js: fetchDailyCandles(), computeDailyBias()",
  },
  {
    tf: "4 Stunden",
    aufgabe: "Struktur und Key-Level (Liquiditaet, Imbalances)",
    beleg: '"key levels: 1hr, 4hr liq and session highs/lows"',
    quelle: "Beginners Guide, Checkliste Punkt 1 - woertlich vom Bildschirm",
    engine: "Trend + BOS, Swing-Level und offene Imbalances als Ziel-Kandidaten",
    code: "build.js: resample(df1h, 240)",
  },
  {
    tf: "1 Stunde",
    aufgabe: "Key-Level: Hochs, Tiefs und Imbalances",
    beleg: '"we have this four hour [FVG] which is overlapping with this one hour [FVG]"',
    quelle: "Beginners Guide",
    engine: "Swing-Level und Imbalances, gleichberechtigt mit 4H",
    code: "engine.js: resample(ltfDf, 60)",
    seit: "seit 01.10.2026 - vorher fehlte dieser Zeitrahmen komplett",
  },
  {
    tf: "Sessions",
    aufgabe: "Session-Hochs und -Tiefs als Liquiditaetspunkte",
    beleg: '"key levels: [...] and session highs/lows"',
    quelle: "Beginners Guide, Checkliste Punkt 1 - woertlich",
    engine: "Asia / London / New York, nur abgeschlossene Sessions",
    code: "engine.js: findSessionLevels()",
    seit: "seit 01.10.2026 - stand vorher nur als Kommentar im Code",
  },
  {
    tf: "15 Minuten",
    aufgabe: "Zwischenstufe: Sweep und Strukturbruch, dann Order-Block-Einstieg",
    beleg: '"we\'re looking for [liquidity] sweeps on a fifteen minute, we\'re looking for [BOS] from a fifteen minute, and then [an] order block entry"',
    quelle: "Bootcamp Day 35",
    engine: "Rueckfall: wird geprueft, wenn auf 5min kein Einstieg steht",
    code: "build.js: resample(ltf, 15)",
    seit: "seit 01.10.2026",
  },
  {
    tf: "5 Minuten",
    aufgabe: "Bestaetigung (BOS/iFVG/SMT) und Continuation-Zone (FVG/OB/BB/EQ)",
    beleg: '"b) scale to 5 min timeframe, wait for confirmation (bos, ifvg, smt)  c) wait for 5 min continuation (fvg, ob, bb, eq)"',
    quelle: "Beginners Guide, Checkliste - woertlich vom Bildschirm",
    engine: "Haupt-Zeitrahmen der Signalerzeugung",
    code: "engine.js: buildSignal(htf, ltf, ...)",
  },
  {
    tf: "1 Minute",
    aufgabe: "Letzte Bestaetigung, dann Einstieg",
    beleg: '"d) wait for 1 min confirmation (bos, ifvg)  e) enter"',
    quelle: "Beginners Guide, Checkliste - woertlich vom Bildschirm",
    engine: "find1minConfirmation(); ohne 1min-Daten bleibt der Einstieg ein Plan",
    code: "engine.js: find1minConfirmation()",
  },
];

// TJRs Ausfuehrungs-Checkliste, woertlich vom Bildschirm abgeschrieben,
// und welche Regel die jeweilige Stufe abbildet.
const CHECKLISTE = [
  { schritt: "1", text: "key levels: 1hr, 4hr liq and session highs/lows", regel: "R1-key-levels" },
  { schritt: "2", text: "times to trade: ny session 9:50-10:30 (forex 8:00am-10:00am) london session 3am-4am", regel: "R2-session" },
  { schritt: "a", text: "wait for price to hit key level", regel: "R13-sweep-am-key-level" },
  { schritt: "b", text: "scale to 5 min timeframe, wait for confirmation (bos, ifvg, smt)", regel: "R4-confirmation" },
  { schritt: "c", text: "wait for 5 min continuation (fvg, ob, bb, eq)", regel: "R5-continuation-zone" },
  { schritt: "d", text: "wait for 1 min confirmation (bos, ifvg)", regel: "R7-1min-confirmation" },
  { schritt: "e", text: "enter", regel: null },
  { schritt: "f", text: "stop loss where trade idea is wrong", regel: "R8-stop-placement" },
  { schritt: "g", text: "take profit at other key levels", regel: "R1-key-levels" },
];

// Welche Regeln blockieren wirklich einen Trade, welche werden nur mitgemessen?
// Das ist der ehrlichste Teil der Seite - hier wird sichtbar, wo die Engine von
// TJR abweicht. Stand 02.10.2026, von Hand gepflegt: ein Automatismus waere hier
// irrefuehrend, weil "blockierend" auf mehreren Wegen entstehen kann
// (harte Vorbedingung in buildSignal, Fenstergate, Konfliktpruefung).
const ERZWUNGEN = {
  "R3-reversal-sweep": "erzwungen: ohne Sweep entsteht gar kein Signal",
  "R4-confirmation": "erzwungen: ohne Bestaetigung entsteht gar kein Signal",
  "R5-continuation-zone": "erzwungen: ohne Zone entsteht gar kein Signal",
  "R6-discount-premium": "erzwungen: Zone muss im Discount bzw. Premium liegen",
  "R7-1min-confirmation": "erzwungen, sobald 1min-Daten vorliegen",
  "R8-stop-placement": "erzwungen: der Stop wird nach dieser Regel gesetzt",
  "R2-session": "erzwungen fuer echte Trades (ausserhalb nur Beobachtung)",
  "R9-daily-bias": "erzwungen seit 01.10. ueber die Konfliktpruefung",
  "R10-htf-vorrang": "erzwungen seit 01.10. ueber die Konfliktpruefung",
  "R14-keine-doppelposition": "erzwungen",
  "R12-news-fenster": "erzwungen",
  "R1-key-levels": "NUR GEMESSEN - das Ziel darf auch gerechnet sein",
  "R11-kein-trade-nach-verlust": "NUR GEMESSEN",
  "R13-sweep-am-key-level": "NUR GEMESSEN - seit den 1H/Session-Levels aber faktisch fast immer erfuellt",
};

function quote(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function erfuellungsQuoten(signalsLog) {
  const mitRegeln = (signalsLog || []).filter((r) => r && r.rules);
  const out = {};
  if (!mitRegeln.length) return out;
  for (const r of mitRegeln) {
    for (const id of Object.keys(r.rules)) {
      if (!out[id]) out[id] = { ok: 0, verletzt: 0, gesamt: 0 };
      out[id].gesamt++;
      if (r.rules[id] === "ok") out[id].ok++;
      else if (r.rules[id] === "verletzt") out[id].verletzt++;
    }
  }
  return out;
}

function baue(basisOrdner, regeln, signalsLog) {
  const quoten = erfuellungsQuoten(signalsLog);
  const regelNach = {};
  for (const r of regeln) regelNach[r.id] = r;

  const leiterZeilen = LEITER.map((s) => `
    <tr>
      <td class="tf">${quote(s.tf)}${s.seit ? `<div class="neu">${quote(s.seit)}</div>` : ""}</td>
      <td>${quote(s.aufgabe)}
        <div class="beleg">${quote(s.beleg)}<div class="quelle">${quote(s.quelle)}</div></div></td>
      <td>${quote(s.engine)}<div class="code">${quote(s.code)}</div></td>
    </tr>`).join("");

  const checkZeilen = CHECKLISTE.map((c) => {
    const q = c.regel ? quoten[c.regel] : null;
    const pct = q && q.gesamt ? Math.round(100 * q.ok / q.gesamt) : null;
    const erz = c.regel ? (ERZWUNGEN[c.regel] || "?") : "ergibt sich aus d)";
    const nurGemessen = /NUR GEMESSEN/.test(erz);
    return `
    <tr class="${nurGemessen ? "warn" : ""}">
      <td class="schritt">${quote(c.schritt)}</td>
      <td class="woertlich">${quote(c.text)}</td>
      <td>${c.regel ? quote(c.regel) : "&ndash;"}</td>
      <td class="${nurGemessen ? "rot" : "gruen"}">${quote(erz)}</td>
      <td class="pct">${pct === null ? "&ndash;" : pct + " %"}</td>
    </tr>`;
  }).join("");

  const eigene = regeln.filter((r) => /Eigene Regel|KEIN Videobeleg|keine woertliche/i.test((r.source || "") + (r.quote || "")));
  const eigeneZeilen = eigene.map((r) => `
    <li><b>${quote(r.id)}</b> &mdash; ${quote(r.title)}<div class="quelle">${quote(r.source)}</div></li>`).join("");

  const asr = regeln.filter((r) => /pocketsphinx|ASR-Transkript/i.test((r.source || "") + (r.quote || "")));
  const asrZeilen = asr.map((r) => `<li><b>${quote(r.id)}</b> &mdash; ${quote(r.title)}</li>`).join("");

  const html = `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TJR-Methode // was die Engine wirklich tut</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; background:
     radial-gradient(circle at 15% 0%, rgba(88,101,242,0.14), transparent 42%),
     radial-gradient(circle at 85% 8%, rgba(57,255,136,0.08), transparent 40%), #05060a;
     color:#e8eaf0; font-family:"SF Mono","Cascadia Code",Menlo,Consolas,monospace; }
  body { padding:22px 24px 48px; }
  h1 { font-size:21px; margin:0 0 4px 0; letter-spacing:.5px;
       background:linear-gradient(90deg,#7dd3fc,#a78bfa 45%,#39ff88 90%);
       -webkit-background-clip:text; background-clip:text; color:transparent; }
  h2 { font-size:15px; margin:30px 0 10px 0; color:#cdd6ff; }
  .sub { color:#7c8399; font-size:12.5px; font-family:-apple-system,sans-serif; margin-bottom:18px; }
  .zurueck { font-family:-apple-system,sans-serif; font-size:11px; font-weight:600; padding:4px 10px;
     border-radius:6px; text-decoration:none; background:rgba(255,255,255,.03);
     border:1px solid rgba(255,255,255,.12); color:#9198ad; float:right; }
  table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:10px; }
  th { text-align:left; padding:8px 10px; color:#6b7185; font-size:10.5px; letter-spacing:.7px;
       text-transform:uppercase; border-bottom:1px solid rgba(255,255,255,.1);
       font-family:-apple-system,sans-serif; }
  td { padding:9px 10px; border-bottom:1px solid rgba(255,255,255,.05); vertical-align:top; }
  tr.warn td { background:rgba(255,196,0,.05); }
  .tf { font-weight:700; color:#7dd3fc; white-space:nowrap; }
  .neu { font-size:10px; color:#ffd25c; font-weight:400; margin-top:3px; font-family:-apple-system,sans-serif; }
  .beleg { margin-top:6px; padding-left:9px; border-left:2px solid rgba(122,140,255,.35);
           color:#b9c2da; font-size:11.5px; font-style:italic; }
  .quelle { color:#6b7185; font-size:10.5px; font-style:normal; margin-top:3px;
            font-family:-apple-system,sans-serif; }
  .code { color:#6b7185; font-size:10.5px; margin-top:4px; }
  .schritt { font-weight:700; color:#ffd25c; text-align:center; width:34px; }
  .woertlich { color:#d7dbe8; }
  .gruen { color:#39ff88; font-size:11px; font-family:-apple-system,sans-serif; }
  .rot { color:#ffb84d; font-size:11px; font-weight:600; font-family:-apple-system,sans-serif; }
  .pct { text-align:right; color:#9198ad; white-space:nowrap; }
  .kasten { border:1px solid rgba(255,196,0,.28); background:rgba(255,196,0,.05);
            border-radius:11px; padding:13px 16px; font-size:12.5px; line-height:1.65;
            font-family:-apple-system,sans-serif; color:#d8cfae; margin-bottom:8px; }
  .kasten b { color:#ffd25c; }
  ul { font-family:-apple-system,sans-serif; font-size:12px; color:#b9c2da; line-height:1.7; padding-left:18px; }
  .fuss { margin-top:28px; padding-top:14px; border-top:1px solid rgba(255,255,255,.06);
          color:#5a6072; font-size:11.5px; line-height:1.7; font-family:-apple-system,sans-serif; }
</style></head><body>

<a class="zurueck" href="index.html">&larr; Dashboard</a>
<h1>TJR-Methode &mdash; und was die Engine wirklich tut</h1>
<div class="sub">Jede Zeile mit Beleg aus dem Video und Fundstelle im Code. Stand: ${quote(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC &middot; Grundlage: ${quote(String((signalsLog || []).filter((r) => r && r.rules).length))} aufgezeichnete Signale.</div>

<div class="kasten">
  <b>Wichtig vorweg:</b> Die Engine sieht die Videos nicht und kann es nicht &mdash; sie laeuft auf GitHubs Servern, die Videos liegen auf Tiams PC (11 GB). Alle Regeln hier wurden von Hand aus TJRs Videos abgeleitet: woertlich von seinen eingeblendeten Notizen, wo moeglich, sonst aus Transkripten. <b>Wo ein Beleg schwach ist, steht das dabei.</b>
</div>

<h2>Die Zeitrahmen-Leiter</h2>
<table>
  <thead><tr><th>Zeitrahmen</th><th>Was TJR dort macht</th><th>Was die Engine dort macht</th></tr></thead>
  <tbody>${leiterZeilen}</tbody>
</table>

<h2>TJRs Ausfuehrungs-Checkliste &mdash; woertlich, und was davon erzwungen wird</h2>
<table>
  <thead><tr><th>Schritt</th><th>TJR woertlich</th><th>Regel</th><th>Status in der Engine</th><th>erfuellt</th></tr></thead>
  <tbody>${checkZeilen}</tbody>
</table>
<div class="kasten">
  <b>Gelb markierte Zeilen werden NICHT erzwungen</b> &mdash; dort kann ein Trade entstehen, obwohl TJRs Schritt nicht erfuellt ist. Das ist die ehrlichste Zahl auf dieser Seite. Am 02.10.2026 zeigte sich, dass bei Schritt (a) &minus;39,1R der insgesamt &minus;42,4R Long-Verluste sassen: Longs, deren Sweep nicht an einem Key-Level lag.
</div>

<h2>Regeln, die NICHT von TJR stammen</h2>
<div class="sub">Von mir ergaenzt. Sie sind als Regel genauso scharf wie die anderen &mdash; aber sie haben keinen Videobeleg und duerfen deshalb nicht als &bdquo;TJR sagt&ldquo; gelesen werden.</div>
<ul>${eigeneZeilen || "<li>keine</li>"}</ul>

<h2>Regeln auf schwacher Quellenlage</h2>
<div class="sub">Belegt nur durch automatisch erzeugte Transkripte (pocketsphinx, fehlerbehaftet). Sinngemaess richtig, aber nicht woertlich zitierfaehig.</div>
<ul>${asrZeilen || "<li>keine</li>"}</ul>

<div class="fuss">
  Diese Seite wird bei jedem Lauf neu aus <code>tjr_rules.js</code> und dem Signal-Log erzeugt &mdash; sie kann also nicht veralten, solange das Regelwerk gepflegt wird.<br>
  Die Prozentzahlen beziehen alle aufgezeichneten Signale ein, auch Beobachtungen ausserhalb der Handelszeit.
</div>
</body></html>`;

  fs.writeFileSync(path.join(basisOrdner, "docs", "tjr_methode.html"), html, "utf8");
  return html.length;
}

module.exports = { baue, LEITER, CHECKLISTE, ERZWUNGEN };
