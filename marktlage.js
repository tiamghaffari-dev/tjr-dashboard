"use strict";
/* ===========================================================================
 * marktlage.js - Datenbeschaffung fuer den Marktlage-Bereich (Etappe 1)
 * ===========================================================================
 * Was dieser Bereich IST: eine nackte Uebersicht. Stand und Veraenderung von
 * Indizes, Rohstoffen, Umfeldwerten, Sektoren und zwei Einzelwerten.
 *
 * Was dieser Bereich NICHT ist - und auch spaeter nicht werden darf, ohne dass
 * es vorher an echten Daten gegengerechnet wurde:
 *   - kein Urteil ("bullisch", "guenstig", "Vorsicht")
 *   - keine Prognose
 *   - kein Signal, kein Einstieg, kein Stop
 *   - KEINE Verbindung zur TJR-Engine. Dieses Modul wird von engine.js und
 *     build.js nicht geladen und laedt sie nicht. Ein Fehler hier kann den
 *     TJR-Report nicht kippen.
 *
 * Die Symbolliste ist nicht geraten: jedes Symbol wurde in Etappe 0 mit
 * marktlage_symboltest.js geprueft (Ergebnis in marktlage_symbole.json,
 * 25 von 25 brauchbar). Wer hier ein Symbol ergaenzt, prueft es vorher dort.
 * ===========================================================================
 */

const SYMBOLE = [
  // --- breite Indizes: wie laeuft "der Markt" ueberhaupt ---
  { gruppe: "Index",      name: "MSCI World",        symbol: "URTH",      hinweis: "ETF auf den Weltindex, in USD" },
  { gruppe: "Index",      name: "MSCI World (EUR)",  symbol: "IWDA.AS",   hinweis: "derselbe Weltindex, in Euro notiert" },
  { gruppe: "Index",      name: "S&P 500",           symbol: "^GSPC",     hinweis: "500 größte US-Firmen" },
  { gruppe: "Index",      name: "Nasdaq 100",        symbol: "^NDX",      hinweis: "100 größte Technologiewerte" },
  { gruppe: "Index",      name: "DAX",               symbol: "^GDAXI",    hinweis: "40 größte deutsche Firmen" },
  { gruppe: "Index",      name: "Euro Stoxx 50",     symbol: "^STOXX50E", hinweis: "50 größte Firmen der Eurozone", waehrung: "EUR" },

  // --- Rohstoffe ---
  { gruppe: "Rohstoff",   name: "Oel WTI",           symbol: "CL=F",      hinweis: "US-Sorte, Terminkontrakt" },
  { gruppe: "Rohstoff",   name: "Oel Brent",         symbol: "BZ=F",      hinweis: "Nordsee-Sorte, Terminkontrakt" },
  { gruppe: "Rohstoff",   name: "Gold",              symbol: "GC=F",      hinweis: "Terminkontrakt - die Engine handelt denselben Wert" },
  { gruppe: "Rohstoff",   name: "Silber",            symbol: "SI=F",      hinweis: "Terminkontrakt" },
  { gruppe: "Rohstoff",   name: "Erdgas",            symbol: "NG=F",      hinweis: "Terminkontrakt, sehr sprunghaft" },

  // --- Umfeld: Nervositaet, Zinsen, Dollar ---
  { gruppe: "Umfeld",     name: "VIX",               symbol: "^VIX",      hinweis: "erwartete Schwankung im S&P 500, in Prozentpunkten - kein Kurs", einheit: "pkt" },
  { gruppe: "Umfeld",     name: "US-Zins 10 Jahre",  symbol: "^TNX",      hinweis: "Rendite zehnjähriger US-Staatsanleihen in Prozent", einheit: "%" },
  { gruppe: "Umfeld",     name: "Dollar-Index",      symbol: "DX-Y.NYB",  hinweis: "Dollar gegen einen Korb anderer Währungen", einheit: "pkt" },

  // --- Sektoren: welcher Teil des Marktes laeuft gerade ---
  { gruppe: "Sektor",     name: "Technologie",       symbol: "XLK",       hinweis: "US-Sektor-ETF" },
  { gruppe: "Sektor",     name: "Energie",           symbol: "XLE",       hinweis: "US-Sektor-ETF" },
  { gruppe: "Sektor",     name: "Finanzen",          symbol: "XLF",       hinweis: "US-Sektor-ETF" },
  { gruppe: "Sektor",     name: "Rohstoffe/Material",symbol: "XLB",       hinweis: "US-Sektor-ETF" },
  { gruppe: "Sektor",     name: "Rüstung/Luftfahrt",symbol: "ITA",       hinweis: "US-Sektor-ETF" },

  // --- Einzelwerte, die Tiam ausdruecklich sehen wollte ---
  { gruppe: "Einzelwert", name: "Rheinmetall",       symbol: "RHM.DE",    hinweis: "Rüstung, Frankfurt" },
  { gruppe: "Einzelwert", name: "Tesla",             symbol: "TSLA",      hinweis: "Nasdaq" },

  // --- die sechs Werte, die die Engine wirklich handelt ---
  { gruppe: "Gehandelt",  name: "Bitcoin",           symbol: "BTC-USD",   hinweis: "handelt die Engine" },
  { gruppe: "Gehandelt",  name: "Ethereum",          symbol: "ETH-USD",   hinweis: "handelt die Engine" },
  { gruppe: "Gehandelt",  name: "XRP",               symbol: "XRP-USD",   hinweis: "handelt die Engine" },
  { gruppe: "Gehandelt",  name: "GBP/USD",           symbol: "GBPUSD=X",  hinweis: "handelt die Engine" },
];

const GRUPPEN_REIHENFOLGE = ["Index", "Rohstoff", "Umfeld", "Sektor", "Einzelwert", "Gehandelt"];

/* ---------------------------------------------------------------------------
 * Rollen fuer die Kennzahlen aus Etappe 2.
 *
 * GEHANDELT sind exakt die sechs Werte aus ASSETS in build.js - zwei davon
 * (Gold, S&P 500) stehen oben in anderen Gruppen, weil sie dort als Umfeld
 * gelesen werden. Fuer den Gleichlauf zaehlt aber, was die Engine WIRKLICH
 * handelt, darum hier noch einmal ausdruecklich und vollstaendig.
 * Weicht diese Liste je von ASSETS ab, misst der Gleichlauf das Falsche.
 * ------------------------------------------------------------------------- */
const GEHANDELT = [
  { name: "Bitcoin",  symbol: "BTC-USD" },
  { name: "Ethereum", symbol: "ETH-USD" },
  { name: "XRP",      symbol: "XRP-USD" },
  { name: "GBP/USD",  symbol: "GBPUSD=X" },
  { name: "S&P 500",  symbol: "^GSPC" },
  { name: "Gold",     symbol: "GC=F" },
];
const VIX_SYMBOL = "^VIX";
const MARKT_SYMBOL = "^GSPC";   // Massstab fuer den Sektorvergleich (US-Sektor-ETFs)

const PAUSE_MS = 350;        // hoeflich bleiben, kein Hammern auf Yahoo
const VERSUCHE = 3;          // ein einzelner Aussetzer soll keine Zeile kosten
const VERALTET_TAGE = 4;     // ab hier wird der Kurs als alt markiert, nicht verschwiegen

function schlafe(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* --------------------------------------------------------------------------
 * Rohdaten holen: ein Jahr Tageskerzen. Mehr braucht die Uebersicht nicht,
 * und weniger wuerde fuer die Jahresveraenderung nicht reichen.
 * -------------------------------------------------------------------------- */
async function holeReihe(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(symbol) + "?interval=1d&range=1y";
  const antwort = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tjr-dashboard marktlage)" },
  });
  if (!antwort.ok) throw new Error("HTTP " + antwort.status);

  const daten = await antwort.json();
  const ergebnis = daten && daten.chart && daten.chart.result && daten.chart.result[0];
  if (!ergebnis) {
    const fehler = daten && daten.chart && daten.chart.error;
    throw new Error(fehler ? String(fehler.description || fehler.code).slice(0, 80) : "kein Ergebnis");
  }

  const stempel = ergebnis.timestamp || [];
  const quote = (ergebnis.indicators && ergebnis.indicators.quote && ergebnis.indicators.quote[0]) || {};
  const kurse = quote.close || [];

  // Yahoo liefert fuer Feiertage und Datenluecken `null` mit. Solche Tage
  // mitzuzaehlen wuerde die Veraenderungen verfaelschen - in Etappe 0 hatten
  // mehrere Symbole genau solche Luecken.
  const reihe = [];
  for (let i = 0; i < kurse.length; i++) {
    const c = kurse[i];
    if (typeof c === "number" && isFinite(c) && typeof stempel[i] === "number") {
      reihe.push({ ts: stempel[i], close: c });
    }
  }
  if (reihe.length < 2) throw new Error("zu wenige Kurse (" + reihe.length + ")");

  const ausgerichtet = richteStempelAus(reihe);

  // Der LIVE-Kurs aus dem meta-Block. Der haengt an keiner Tageskerze und hat
  // darum auch kein Datumsproblem - genau deshalb wird er fuer die ANZEIGE
  // bevorzugt. Noetig wurde das durch GBPUSD=X: Yahoos Tagesreihe fuer Devisen
  // hinkt dort zwei Sitzungen hinterher, der Live-Kurs aber nicht. Die
  // Veraenderungs-Spalten und alle Kennzahlen rechnen weiterhin ausschliesslich
  // mit der Tagesreihe - der Live-Kurs faerbt keine Statistik ein.
  //
  // Drei Bedingungen, damit ein kaputtes Feld nicht schlimmer ist als keines:
  // echte positive Zahl, nicht aus der Zukunft, nicht aelter als die Reihe.
  const meta = ergebnis.meta || {};
  const lp = meta.regularMarketPrice;
  const lt = meta.regularMarketTime;
  const jetztSek = Math.floor(Date.now() / 1000);
  let live = null;
  if (typeof lp === "number" && isFinite(lp) && lp > 0
      && typeof lt === "number" && isFinite(lt)
      && lt <= jetztSek + 300
      && lt >= ausgerichtet.reihe[ausgerichtet.reihe.length - 1].ts) {
    live = { close: lp, ts: lt };
  }

  return {
    reihe: ausgerichtet.reihe,
    live,
    stempelKorrigiert: ausgerichtet.korrigiert,
    stempelVerworfen: ausgerichtet.verworfen,
    luecken: kurse.length - reihe.length,
    waehrung: meta.currency || null,
    boerse: meta.exchangeName || null,
  };
}

/* --------------------------------------------------------------------------
 * ZEITSTEMPEL-VERSATZ AUSGLEICHEN
 *
 * Gefunden am 13.10.2026 beim Nachpruefen der Korrelationen: GBPUSD=X kostete
 * 28 der gemeinsamen Handelstage, alle anderen Symbole null. Die fehlenden
 * Tage waren 27 Freitage und 1 Montag - kein Feiertagsmuster, sondern ein
 * systematischer Versatz.
 *
 * Ursache: der Devisen-Handelstag beginnt am ABEND davor (17:00 New York).
 * Yahoo stempelt die Tageskerze entsprechend auf 23:00 oder 00:00 UTC. Beim
 * Datum nach UTC landet die FREITAGS-Kerze damit auf Donnerstag - GBP/USD lag
 * gegenueber den anderen fuenf Werten um einen Tag verschoben, und seine
 * Korrelationen waren dadurch systematisch zu niedrig.
 *
 * Die Korrektur haengt nicht an einer Symbolliste, sondern misst sich selbst:
 * liegt die haeufigste Stempel-Uhrzeit eines Symbols am Abend (ab 20:00 UTC),
 * werden ALLE seine Stempel um 12 Stunden verschoben. Dadurch rutscht eine
 * 23:00-Kerze auf den naechsten Tag (11:00) und eine 00:00-Kerze bleibt auf
 * ihrem eigenen (12:00) - beide Schreibweisen, die Yahoo bei GBPUSD=X mischt,
 * landen damit auf dem richtigen Handelstag.
 *
 * Nur das DATUM wird dadurch richtig. Die Kurse selbst sind unveraendert, und
 * die Spalten Tag/Woche/Monat/Jahr aus Etappe 1 rechnen ohnehin innerhalb
 * einer Reihe - die waren nie falsch, nur ihr angezeigtes Datum war es.
 * -------------------------------------------------------------------------- */
const ABEND_AB_UTC = 20;
const VERSATZ_SEKUNDEN = 12 * 3600;
const ABEND_ANTEIL = 0.2;

/* Ausgeloest wird die Korrektur ueber den ANTEIL der Abendstempel, nicht ueber
 * den haeufigsten Stempel. Grund: GBPUSD=X mischt 23:00 und 00:00 (Sommer-
 * gegen Winterzeit), aktuell 150 zu 108. Haenge die Entscheidung am
 * haeufigsten Wert, dann kippt sie lautlos, sobald das Verhaeltnis sich dreht -
 * und der Fehler waere stillschweigend zurueck, ohne dass irgendwo etwas
 * rot wird. Ein Anteil von einem Fuenftel ist dagegen stabil: ein Symbol ohne
 * Abendstempel kommt nie in die Naehe, eines mit Abendstempeln nie darunter. */
function stempelVersatzNoetig(reihe) {
  if (!reihe.length) return false;
  let abends = 0;
  for (const p of reihe) {
    if (new Date(p.ts * 1000).getUTCHours() >= ABEND_AB_UTC) abends++;
  }
  return abends / reihe.length >= ABEND_ANTEIL;
}

function richteStempelAus(reihe, jetztSek) {
  if (!stempelVersatzNoetig(reihe)) return { reihe, korrigiert: false, verworfen: 0 };

  const jetzt = jetztSek || Math.floor(Date.now() / 1000);
  const verschoben = reihe.map((p) => ({ ts: p.ts + VERSATZ_SEKUNDEN, close: p.close }));

  // Kerzen, die nach der Verschiebung in der ZUKUNFT liegen, fliegen raus.
  // Yahoo legt fuer Devisen die Kerze des naechsten Handelstags offenbar schon
  // an, bevor er begonnen hat - beim ersten Lauf nach dieser Korrektur stand
  // GBP/USD dadurch auf dem 14.10., waehrend der 13.10. lief (Alter -0,5 Tage).
  // Ein Kurs mit einem Datum von morgen ist in jedem Fall falsch, egal wie er
  // zustande kam. Also: raus damit, statt ihn anzuzeigen.
  const sauber = verschoben.filter((p) => p.ts <= jetzt);

  return {
    reihe: sauber.length >= 2 ? sauber : verschoben,
    korrigiert: true,
    verworfen: verschoben.length - sauber.length,
  };
}

/* --------------------------------------------------------------------------
 * Veraenderung ueber einen Kalenderzeitraum.
 *
 * Absichtlich KALENDERTAGE, nicht "N Kerzen zurueck": Bitcoin handelt sieben
 * Tage die Woche, der DAX fuenf, Terminkontrakte haben eigene Feiertage. Mit
 * Kerzenzaehlung waere "eine Woche" bei BTC 7 Tage und beim DAX 9 - die
 * Spalten waeren nicht vergleichbar.
 *
 * Bezugspunkt ist der LETZTE Kurs, der am oder vor dem Stichtag liegt.
 * Gibt es keinen (Reihe zu kurz), kommt null zurueck statt einer geschoenten
 * Zahl aus dem aeltesten vorhandenen Kurs.
 * -------------------------------------------------------------------------- */
function veraenderungSeit(reihe, tageZurueck) {
  const letzter = reihe[reihe.length - 1];
  const stichtag = letzter.ts - tageZurueck * 86400;

  let bezug = null;
  for (const p of reihe) {
    if (p.ts <= stichtag) bezug = p; else break;
  }
  if (!bezug || bezug.close <= 0) return null;
  if (bezug.ts === letzter.ts) return null;

  return {
    prozent: ((letzter.close - bezug.close) / bezug.close) * 100,
    vonKurs: bezug.close,
    vonTs: bezug.ts,
  };
}

/* Tagesveraenderung ist ein Sonderfall: hier ist der Bezug die vorherige
 * Handelskerze, nicht ein Kalenderstichtag. Wenn der Handelstag noch laeuft,
 * ist das die laufende Veraenderung - deshalb steht das Datum des letzten
 * Kurses auf der Seite daneben. */
function tagesVeraenderung(reihe) {
  const letzter = reihe[reihe.length - 1];
  const vorher = reihe[reihe.length - 2];
  if (!vorher || vorher.close <= 0) return null;
  return {
    prozent: ((letzter.close - vorher.close) / vorher.close) * 100,
    vonKurs: vorher.close,
    vonTs: vorher.ts,
  };
}

function rund(x, stellen) {
  if (x === null || x === undefined || !isFinite(x)) return null;
  const f = Math.pow(10, stellen);
  return Math.round(x * f) / f;
}

/* Wie viele Dezimalstellen sinnvoll sind, haengt vom Wert ab: XRP bei 1,36
 * braucht vier, der Nasdaq bei 30.664 keine. */
function nachkommastellen(wert) {
  const a = Math.abs(wert);
  if (a >= 1000) return 2;
  if (a >= 10) return 2;
  if (a >= 1) return 4;
  return 6;
}

function datumIso(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/* Eine Veraenderungsspalte in die flache Form bringen, die die Seite erwartet:
 * den Prozentwert und - zum Nachrechnen - den Bezugskurs mit seinem Datum. */
function spalte(name, v, letzterKurs) {
  const o = {};
  o[name] = v ? rund(v.prozent, 2) : null;
  o[name + "Von"] = v ? rund(v.vonKurs, nachkommastellen(v.vonKurs)) : null;
  o[name + "VonDatum"] = v ? datumIso(v.vonTs) : null;
  return o;
}

/* --------------------------------------------------------------------------
 * Eine Zeile der Uebersicht bauen. Schlaegt der Abruf fehl, kommt eine Zeile
 * mit ok:false zurueck - die Seite zeigt dann "keine Daten" an dieser Stelle
 * und bleibt im Uebrigen vollstaendig.
 * -------------------------------------------------------------------------- */
async function holeEintrag(def) {
  let letzterFehler = null;

  for (let versuch = 1; versuch <= VERSUCHE; versuch++) {
    try {
      const roh = await holeReihe(def.symbol);
      const letzteKerze = roh.reihe[roh.reihe.length - 1];
      // Stand und Datum aus dem Live-Kurs, wenn es ihn gibt; alles Gerechnete
      // bleibt bei der Tagesreihe.
      const letzter = roh.live || letzteKerze;
      const alterTage = (Date.now() / 1000 - letzter.ts) / 86400;

      return {
        gruppe: def.gruppe,
        name: def.name,
        symbol: def.symbol,
        hinweis: def.hinweis || null,
        einheit: def.einheit || null,
        ok: true,
        // ^STOXX50E liefert kein Waehrungsfeld (in Etappe 0 als "?" aufgefallen).
        // Darum darf die Definition eine Waehrung vorgeben; Yahoo gilt nur,
        // wenn dort nichts hinterlegt ist.
        waehrung: def.waehrung || roh.waehrung || null,
        boerse: roh.boerse,
        stand: rund(letzter.close, nachkommastellen(letzter.close)),
        standDatum: datumIso(letzter.ts),
        alterTage: rund(alterTage, 1),
        veraltet: alterTage > VERALTET_TAGE,
        standAusLivekurs: !!roh.live,
        letzteKerzeDatum: datumIso(letzteKerze.ts),
        tage: roh.reihe.length,
        luecken: roh.luecken,
        stempelKorrigiert: !!roh.stempelKorrigiert,
        stempelVerworfen: roh.stempelVerworfen || 0,
        // Zu jeder Prozentzahl wird der Bezugskurs und sein Datum mitgeschrieben.
        // Grund: eine Prozentzahl ohne Bezug kann man nicht nachpruefen - und in
        // diesem Projekt gilt, dass keine Zahl geglaubt wird, die man nicht
        // gegenrechnen kann. Auf der Seite haengen sie als Tooltip an der Zahl.
        ...spalte("tag", tagesVeraenderung(roh.reihe), letzter.close),
        ...spalte("woche", veraenderungSeit(roh.reihe, 7), letzter.close),
        ...spalte("monat", veraenderungSeit(roh.reihe, 30), letzter.close),
        ...spalte("jahr", veraenderungSeit(roh.reihe, 365), letzter.close),
        versuche: versuch,
        // Die Tagesreihe selbst. Wird fuer die Kennzahlen aus Etappe 2
        // gebraucht (Schwankung, Sektorvergleich, Gleichlauf) und von
        // marktlage_build.js vor dem Schreiben wieder entfernt - sie gehoert
        // nicht in stand.json und waere dort 25-mal ein Jahr Kurse.
        reihe: roh.reihe,
      };
    } catch (e) {
      letzterFehler = e && e.message ? e.message : String(e);
      if (versuch < VERSUCHE) await schlafe(PAUSE_MS * 4 * versuch);
    }
  }

  return {
    gruppe: def.gruppe,
    name: def.name,
    symbol: def.symbol,
    hinweis: def.hinweis || null,
    einheit: def.einheit || null,
    ok: false,
    grund: String(letzterFehler).slice(0, 120),
    versuche: VERSUCHE,
  };
}

/* --------------------------------------------------------------------------
 * Alle Symbole der Reihe nach. Bewusst sequenziell mit Pause: 25 Abrufe in
 * ~10 Sekunden sind fuer Yahoo unauffaellig, 25 parallele nicht.
 * -------------------------------------------------------------------------- */
async function sammle(symbole) {
  const liste = symbole || SYMBOLE;
  const eintraege = [];
  for (const def of liste) {
    eintraege.push(await holeEintrag(def));
    await schlafe(PAUSE_MS);
  }
  return eintraege;
}

module.exports = {
  SYMBOLE,
  GRUPPEN_REIHENFOLGE,
  GEHANDELT,
  VIX_SYMBOL,
  MARKT_SYMBOL,
  VERALTET_TAGE,
  holeReihe,
  veraenderungSeit,
  tagesVeraenderung,
  nachkommastellen,
  spalte,
  stempelVersatzNoetig,
  richteStempelAus,
  holeEintrag,
  sammle,
};
