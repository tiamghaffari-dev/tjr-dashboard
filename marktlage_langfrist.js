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

/* Mit range=max duennt Yahoo lange Reihen aus: fuer den S&P 500 kamen 168
 * Punkte fuer 501 Monate zurueck (34 %), faktisch Quartalsdaten unter dem
 * Etikett "monatlich". Mit ausdruecklichem Zeitraum statt range=max liefert
 * dieselbe Schnittstelle die vollstaendige Monatsreihe. */
const AB_SEKUNDEN = Math.floor(Date.UTC(1960, 0, 1) / 1000);

async function holeMonatsreihe(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(symbol) + "?interval=1mo"
    + "&period1=" + AB_SEKUNDEN + "&period2=" + Math.floor(Date.now() / 1000);
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
 * davon ab, in welchem Monat man zu zaehlen beginnt.
 *
 * GERECHNET WIRD UEBER ZEITSTEMPEL, NICHT UEBER INDEXPOSITIONEN.
 *
 * Die erste Fassung nahm "i + 60 Eintraege" als fuenf Jahre an. Beim ersten
 * echten Lauf kam fuer den S&P 500 ein Mittelwert von 26 % pro Jahr ueber
 * zehn Jahre heraus - eine Zahl, die es nicht gibt. Ursache: Yahoos
 * max-Reihe hatte Luecken (168 Eintraege fuer den Zeitraum 1984-2026 statt
 * rund 500). "60 Eintraege weiter" waren dort in Wahrheit fuenfzehn Jahre,
 * annualisiert wurden sie aber als fuenf. Das Ergebnis sah voellig plausibel
 * aus und war grober Unsinn.
 *
 * Jetzt wird zu jedem Startpunkt der Eintrag gesucht, der dem Zieldatum am
 * naechsten liegt, und mit der TATSAECHLICH verstrichenen Zeit annualisiert.
 * Liegt kein Eintrag nah genug am Zieldatum (mehr als 45 Tage daneben), wird
 * das Fenster verworfen statt gedehnt. */
const JAHR_SEK = 365.2425 * 86400;
const TOLERANZ_SEK = 45 * 86400;

function rollierend(reihe, jahre) {
  if (reihe.length < 5) return null;
  const spanneJahre = (reihe[reihe.length - 1].ts - reihe[0].ts) / JAHR_SEK;
  if (spanneJahre < jahre * 1.05) return null;

  const renditen = [];
  let j = 0;
  for (let i = 0; i < reihe.length; i++) {
    const zielTs = reihe[i].ts + jahre * JAHR_SEK;
    if (zielTs > reihe[reihe.length - 1].ts) break;

    // Zeiger mitlaufen lassen statt jedes Mal zu suchen.
    if (j < i) j = i;
    while (j + 1 < reihe.length && Math.abs(reihe[j + 1].ts - zielTs) < Math.abs(reihe[j].ts - zielTs)) j++;

    if (Math.abs(reihe[j].ts - zielTs) > TOLERANZ_SEK) continue;
    const von = reihe[i].close, bis = reihe[j].close;
    if (von <= 0 || bis <= 0) continue;

    // Mit der WIRKLICH verstrichenen Zeit annualisieren, nicht mit der
    // gewuenschten - sonst schleicht sich genau der Fehler wieder ein.
    const echteJahre = (reihe[j].ts - reihe[i].ts) / JAHR_SEK;
    if (echteJahre <= 0) continue;
    renditen.push((Math.pow(bis / von, 1 / echteJahre) - 1) * 100);
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
      const spanneMonate = Math.round((reihe[reihe.length - 1].ts - reihe[0].ts) / JAHR_SEK * 12);
      aus.push({
        name: s.name, symbol: s.symbol, hinweis: s.hinweis || null,
        ok: true,
        monate: reihe.length,
        // Wie dicht ist die Reihe wirklich? Steht auf der Seite, damit eine
        // lueckenhafte Quelle nicht als vollstaendige Historie durchgeht.
        spanneMonate,
        dichte: spanneMonate > 0 ? Math.round(reihe.length / spanneMonate * 100) : null,
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
