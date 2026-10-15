"use strict";
/* ===========================================================================
 * marktlage_langfrist.js
 * ===========================================================================
 * Die einzige Kennzahl aus dem Thema "langfristig anlegen", die auf eine
 * Marktlage-Seite gehoert: wie stark der ANLAGEHORIZONT die Spannweite der
 * Ergebnisse bestimmt.
 *
 * Gerechnet werden rollierende Zeitfenster ueber die gesamte verfuegbare
 * Monatshistorie: fuer jedes Fenster die annualisierte Rendite, daraus
 * schlechtester Fall, bester Fall, Mittelwert und der Anteil der Fenster mit
 * Verlust. Das Ergebnis ist immer dasselbe Muster - je laenger das Fenster,
 * desto enger die Spanne.
 *
 * WARUM DAS KEINE PROGNOSE IST: hier steht, wie sich die VERGANGENHEIT auf
 * verschiedene Haltedauern verteilt hat. Daraus folgt nichts ueber den
 * naechsten Monat und nichts ueber den naechsten Einstiegszeitpunkt. Der Satz
 * "in 15-Jahres-Fenstern war bisher keines im Minus" ist eine Beobachtung
 * ueber die Vergangenheit, keine Zusage - und die Seite sagt das auch so.
 *
 * Die Reihe stammt aus derselben Quelle wie der Rest (Yahoo, hier Monats-
 * kerzen ueber die volle verfuegbare Historie). Keine Verbindung zur
 * TJR-Engine.
 * ===========================================================================
 */

const HORIZONTE = [1, 5, 10, 15, 20];
const PAUSE_MS = 400;

async function holeMonatsreihe(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(symbol) + "?interval=1mo&range=max";
  const antwort = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tjr-dashboard marktlage)" },
    signal: AbortSignal.timeout(25000),
  });
  if (!antwort.ok) throw new Error("HTTP " + antwort.status);
  const daten = await antwort.json();
  const e = daten && daten.chart && daten.chart.result && daten.chart.result[0];
  if (!e) throw new Error("kein Ergebnis");

  const ts = e.timestamp || [];
  const close = (e.indicators && e.indicators.quote && e.indicators.quote[0]
    && e.indicators.quote[0].close) || [];

  const reihe = [];
  for (let i = 0; i < close.length; i++) {
    if (typeof close[i] === "number" && isFinite(close[i]) && close[i] > 0
        && typeof ts[i] === "number") {
      reihe.push({ ts: ts[i], close: close[i] });
    }
  }
  // Die letzte Monatskerze ist der LAUFENDE Monat und damit unvollstaendig.
  // Fuer eine Fensterrechnung waere das ein halber Monat, der als ganzer
  // zaehlt - raus damit.
  if (reihe.length > 2) {
    const letzter = new Date(reihe[reihe.length - 1].ts * 1000);
    const jetzt = new Date();
    if (letzter.getUTCFullYear() === jetzt.getUTCFullYear()
        && letzter.getUTCMonth() === jetzt.getUTCMonth()) {
      reihe.pop();
    }
  }
  if (reihe.length < 24) throw new Error("zu kurze Historie (" + reihe.length + " Monate)");
  return reihe;
}

/* Rollierende Fenster. Es werden ALLE ueberlappenden Fenster gezaehlt, nicht
 * nur die, die auf einen Jahreswechsel fallen - sonst haengt das Ergebnis
 * davon ab, in welchem Monat man zu zaehlen beginnt. */
function rollierend(reihe, jahre) {
  const monate = jahre * 12;
  if (reihe.length <= monate) return null;

  const renditen = [];
  for (let i = 0; i + monate < reihe.length; i++) {
    const von = reihe[i].close, bis = reihe[i + monate].close;
    if (von <= 0) continue;
    // Annualisiert, damit Fenster verschiedener Laenge vergleichbar sind.
    renditen.push((Math.pow(bis / von, 1 / jahre) - 1) * 100);
  }
  if (renditen.length < 5) return null;

  const sortiert = renditen.slice().sort((a, b) => a - b);
  const med = sortiert.length % 2
    ? sortiert[(sortiert.length - 1) / 2]
    : (sortiert[sortiert.length / 2 - 1] + sortiert[sortiert.length / 2]) / 2;

  const r = (x) => Math.round(x * 10) / 10;
  return {
    jahre,
    fenster: renditen.length,
    schlechtester: r(sortiert[0]),
    bester: r(sortiert[sortiert.length - 1]),
    mittel: r(med),
    anteilVerlust: Math.round(renditen.filter((x) => x < 0).length / renditen.length * 1000) / 10,
    spanne: r(sortiert[sortiert.length - 1] - sortiert[0]),
  };
}

function schlafe(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function sammle(symbole) {
  const aus = [];
  for (const s of symbole) {
    try {
      const reihe = await holeMonatsreihe(s.symbol);
      const zeilen = [];
      for (const j of HORIZONTE) {
        const z = rollierend(reihe, j);
        if (z) zeilen.push(z);
      }
      if (!zeilen.length) throw new Error("keine auswertbaren Fenster");
      aus.push({
        name: s.name, symbol: s.symbol, hinweis: s.hinweis || null,
        ok: true,
        monate: reihe.length,
        von: new Date(reihe[0].ts * 1000).toISOString().slice(0, 7),
        bis: new Date(reihe[reihe.length - 1].ts * 1000).toISOString().slice(0, 7),
        zeilen,
      });
    } catch (e) {
      aus.push({ name: s.name, symbol: s.symbol, ok: false,
        grund: String(e && e.message ? e.message : e).slice(0, 120) });
    }
    await schlafe(PAUSE_MS);
  }
  return aus;
}

module.exports = { HORIZONTE, holeMonatsreihe, rollierend, sammle };
