"use strict";
/* ===========================================================================
 * marktlage_beobachtung.js - Beobachtungsliste
 * ===========================================================================
 * Tiams Wunsch vom 18.10.: eine Seite, die ihm bei Themen wie Ruestung,
 * Energie oder Technik zeigt, wo die Dinge stehen - fuer Haltedauern von
 * Monaten, nicht Minuten.
 *
 * WAS DIESER BLOCK NICHT TUT: er sagt nicht, wann man einsteigen soll. Das
 * waere eine Vorhersage, und die kann niemand liefern - auch keine KI. Was
 * hier steht, ist eine Standortbestimmung: wie weit ist ein Wert von seinem
 * Hoch und seinem Tief entfernt, wie lief er ueber mehrere Zeitraeume, wie
 * stark schwankt er, und laeuft er besser oder schlechter als der breite
 * Markt. Daraus eine Entscheidung zu machen ist Tiams Sache.
 *
 * Das Lehrbeispiel dafuer steht in seinen eigenen Daten: Rheinmetall, April
 * 2026 bei 1550 EUR, Juli bei 976 EUR. Die These "Krieg, also steigt die
 * Ruestung" stimmte die ganze Zeit - der Kurs fiel trotzdem um 37 %. Richtig
 * liegen und Geld verdienen sind zwei verschiedene Dinge.
 *
 * SYMBOLE: jedes einzelne wurde mit beobachtung_symboltest.js geprueft. Dabei
 * ist auch aufgefallen, dass ARMY.DE kein Ruestungs-ETF ist, sondern ein
 * Optionsprodukt auf ARM Holdings - nach dem Kuerzel geraten waere das falsch
 * auf der Seite gelandet. Wer hier etwas ergaenzt, testet es vorher dort.
 * ===========================================================================
 */

const kz = require("./marktlage_kennzahlen.js");

/* `kaufbar` meint: als UCITS-Papier an einer europaeischen Boerse handelbar,
 * also ueberhaupt auffindbar bei einem Broker wie Trade Republic. US-ETFs wie
 * XLE, XLK und ITA sind fuer EU-Privatanleger normalerweise NICHT kaufbar -
 * die stehen hier nur als Vergleichsmassstab fuer das Thema. */
const WERTE = [
  { thema: "Breit gestreut", name: "MSCI World",        symbol: "EUNL.DE", kaufbar: true },
  { thema: "Breit gestreut", name: "FTSE All-World",    symbol: "VWCE.DE", kaufbar: true },
  { thema: "Breit gestreut", name: "MSCI ACWI",         symbol: "IUSQ.DE", kaufbar: true },
  { thema: "Breit gestreut", name: "Schwellenländer",     symbol: "EUNM.DE", kaufbar: true },

  { thema: "Rüstung", name: "VanEck Defense",          symbol: "DFEN.DE", kaufbar: true },
  { thema: "Rüstung", name: "WisdomTree Europa Def.",  symbol: "WDEF.MI", kaufbar: true },
  { thema: "Rüstung", name: "Rheinmetall",             symbol: "RHM.DE",  kaufbar: true },
  { thema: "Rüstung", name: "Hensoldt",                symbol: "HAG.DE",  kaufbar: true },
  { thema: "Rüstung", name: "Thales",                  symbol: "HO.PA",   kaufbar: true },
  { thema: "Rüstung", name: "US-Rüstung (Vergleich)", symbol: "ITA",     kaufbar: false },

  { thema: "Energie", name: "Europa Öl & Gas",            symbol: "EXH1.DE", kaufbar: true },
  { thema: "Energie", name: "US-Energie (Vergleich)",   symbol: "XLE",     kaufbar: false },

  { thema: "Technik", name: "S&P 500 Technologie",      symbol: "QDVE.DE", kaufbar: true },
  { thema: "Technik", name: "Welt Technologie",         symbol: "XDWT.DE", kaufbar: true },
  { thema: "Technik", name: "Nasdaq 100",               symbol: "EQQQ.DE", kaufbar: true },
  { thema: "Technik", name: "US-Technik (Vergleich)",   symbol: "XLK",     kaufbar: false },

  { thema: "Einzelwert", name: "Tesla",                 symbol: "TSLA",    kaufbar: true },

  { thema: "Krypto", name: "Bitcoin",                   symbol: "BTC-USD", kaufbar: true },
  { thema: "Krypto", name: "Ethereum",                  symbol: "ETH-USD", kaufbar: true },
  { thema: "Krypto", name: "Solana",                    symbol: "SOL-USD", kaufbar: true },
  { thema: "Krypto", name: "XRP",                       symbol: "XRP-USD", kaufbar: true },
];

/* Deutsche Kommas in den Begruendungstexten - sie stehen so auf der Seite,
 * neben Zahlen, die ueberall sonst mit Komma geschrieben sind. */
function dz(x, n) { return Number(x).toFixed(n).replace(".", ","); }

/* ZWEI Massstaebe, ausgewaehlt nach Waehrung des jeweiligen Werts.
 *
 * Mit nur einem EUR-Massstab standen beim ersten Lauf sieben von 21 Werten
 * auf "nicht vergleichbar" - alles in Dollar notierte, also die US-ETFs,
 * Tesla und die komplette Kryptoliste. Die Begruendung war richtig (sonst
 * misst man den Wechselkurs mit), aber als Ergebnis unbrauchbar.
 *
 * Mit einem zweiten Massstab in USD bekommt jeder Wert einen Vergleich in
 * seiner eigenen Waehrung. Beides ist derselbe Weltindex, nur in anderer
 * Notierung - die Aussage "laeuft besser als der breite Markt" bleibt damit
 * dieselbe, ohne dass ein Wechselkurs hineinspielt. */
const MASSSTAB_EUR = "EUNL.DE";      // iShares Core MSCI World, Xetra, EUR
const MASSSTAB_USD = "URTH";         // iShares MSCI World ETF, USD
const MASSSTAB = MASSSTAB_EUR;       // fuer die Anzeige
const THEMEN = ["Breit gestreut", "Rüstung", "Energie", "Technik", "Einzelwert", "Krypto"];
const PAUSE_MS = 350;
const JAHR_SEK = 365.2425 * 86400;
const VOL_FENSTER = 60;              // ~3 Monate, passt zur Haltedauer von Monaten

function schlafe(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rund(x, n) { return (typeof x === "number" && isFinite(x)) ? Math.round(x * Math.pow(10, n)) / Math.pow(10, n) : null; }

async function holeReihe(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(symbol) + "?interval=1d&range=2y";
  const a = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tjr-dashboard beobachtung)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!a.ok) throw new Error("HTTP " + a.status);
  const d = await a.json();
  const e = d && d.chart && d.chart.result && d.chart.result[0];
  if (!e) throw new Error("kein Ergebnis");

  const ts = e.timestamp || [];
  const q = (e.indicators && e.indicators.quote && e.indicators.quote[0]) || {};
  const reihe = [];
  for (let i = 0; i < (q.close || []).length; i++) {
    if (typeof q.close[i] === "number" && isFinite(q.close[i]) && typeof ts[i] === "number") {
      reihe.push({ ts: ts[i], close: q.close[i], hoch: q.high ? q.high[i] : null, tief: q.low ? q.low[i] : null });
    }
  }
  if (reihe.length < 80) throw new Error("zu wenige Kurse (" + reihe.length + ")");

  const m = e.meta || {};
  return { reihe, langname: m.longName || m.shortName || null, waehrung: m.currency || null,
           livekurs: (typeof m.regularMarketPrice === "number" && m.regularMarketPrice > 0) ? m.regularMarketPrice : null };
}

/* Veraenderung ueber einen echten Zeitraum - Bezug ist der letzte Kurs am
 * oder vor dem Stichtag. Kalendertage, nicht Kerzenzahl: Krypto handelt
 * sieben Tage, Aktien fuenf. */
function seit(reihe, tage) {
  const letzter = reihe[reihe.length - 1];
  const stichtag = letzter.ts - tage * 86400;
  let bezug = null;
  for (const p of reihe) { if (p.ts <= stichtag) bezug = p; else break; }
  if (!bezug || bezug.close <= 0 || bezug.ts === letzter.ts) return null;
  return ((letzter.close - bezug.close) / bezug.close) * 100;
}

/* Abstand zum Hoch und Tief der letzten 52 Wochen. Sagt nichts darueber, ob
 * etwas "billig" ist - ein Wert kann monatelang am Tief stehen und weiter
 * fallen. Es sagt nur, wo man sich in der bisherigen Spanne befindet. */
function spanne52(reihe) {
  const ab = reihe[reihe.length - 1].ts - JAHR_SEK;
  const jahr = reihe.filter((p) => p.ts >= ab);
  if (jahr.length < 50) return null;
  let hoch = -Infinity, tief = Infinity;
  for (const p of jahr) {
    const h = (typeof p.hoch === "number" && isFinite(p.hoch)) ? p.hoch : p.close;
    const t = (typeof p.tief === "number" && isFinite(p.tief)) ? p.tief : p.close;
    if (h > hoch) hoch = h;
    if (t < tief) tief = t;
  }
  const jetzt = reihe[reihe.length - 1].close;
  if (!isFinite(hoch) || !isFinite(tief) || hoch <= tief) return null;
  return {
    hoch: rund(hoch, 2), tief: rund(tief, 2),
    vomHoch: rund((jetzt - hoch) / hoch * 100, 1),
    ueberTief: rund((jetzt - tief) / tief * 100, 1),
    // Wo in der Spanne: 0 = am Jahrestief, 100 = am Jahreshoch.
    inSpanne: rund((jetzt - tief) / (hoch - tief) * 100, 0),
  };
}

/* Vorsprung gegenueber dem breiten Markt ueber drei Monate, MIT Rauschurteil -
 * dieselbe Rechnung wie beim Sektorblock. Nur fuer Werte in derselben
 * Waehrung wie der Massstab: sonst misst man den Wechselkurs mit und nennt
 * es Staerke. */
const REL_TAGE = 90;

/* Maximaler Rueckgang im letzten Jahr (29.10.2026).
 *
 * Tiams Frage ist immer "was kann ich erwarten" - die ehrlichere Zahl ist
 * "was musste ich aushalten". Ein Wert, der ueber ein Jahr 20 % zugelegt hat,
 * dazwischen aber 45 % unter seinem Hoch stand, ist etwas voellig anderes als
 * einer, der dieselben 20 % ruhig gelaufen ist. Bei Haltedauern von Monaten
 * entscheidet genau das, ob man dabeibleibt.
 *
 * Gemessen vom jeweils hoechsten vorherigen Schlusskurs, nicht vom Jahreshoch:
 * so steht da, was ein Einstieg zum schlechtmoeglichsten Zeitpunkt gekostet
 * haette. */
/* Kursverlauf fuer die Miniaturkurve (30.10.2026).
 *
 * Die Seite war bis hier komplett Text und Tabellen. Eine Zahlenspalte sagt
 * "+18 %", eine Kurve sagt, OB es ruhig hochging oder ob zwischendurch die
 * Haelfte weg war. Letzteres liest man in einer Sekunde statt in drei Zahlen.
 *
 * Ausgeduennt auf hoechstens PUNKTE Werte: die volle Tagesreihe waere das
 * Zwanzigfache an Daten fuer eine 110 Pixel breite Grafik, in der man den
 * Unterschied ohnehin nicht saehe. Hoch- und Tiefpunkt bleiben dabei
 * erhalten, damit die Kurve ihre Ausschlaege nicht verliert. */
const VERLAUF_PUNKTE = 64;

function kursverlauf(reihe, tage) {
  if (!reihe || reihe.length < 10) return null;
  const grenze = reihe[reihe.length - 1].ts - tage * 86400;
  const teil = reihe.filter((p) => p.ts >= grenze);
  if (teil.length < 10) return null;
  if (teil.length <= VERLAUF_PUNKTE) return teil.map((p) => rund(p.close, 4));

  // Gleichmaessig ausduennen, aber die Extremwerte jedes Abschnitts behalten.
  const breite = teil.length / VERLAUF_PUNKTE;
  const raus = [];
  for (let i = 0; i < VERLAUF_PUNKTE; i++) {
    const von = Math.floor(i * breite);
    const bis = Math.min(teil.length, Math.floor((i + 1) * breite));
    const abschnitt = teil.slice(von, Math.max(bis, von + 1));
    if (!abschnitt.length) continue;
    // Im Abschnitt den Wert nehmen, der am weitesten vom vorigen Punkt weg
    // ist - so ueberlebt ein Einbruch das Ausduennen.
    const vorher = raus.length ? raus[raus.length - 1] : abschnitt[0].close;
    let gewaehlt = abschnitt[0].close, abstand = -1;
    for (const p of abschnitt) {
      const d = Math.abs(p.close - vorher);
      if (d > abstand) { abstand = d; gewaehlt = p.close; }
    }
    raus.push(rund(gewaehlt, 4));
  }
  return raus;
}

function maxRueckgang(reihe, tage) {
  if (!reihe || reihe.length < 10) return null;
  const grenze = reihe[reihe.length - 1].ts - tage * 86400;
  const teil = reihe.filter((p) => p.ts >= grenze);
  if (teil.length < 10) return null;

  let hoch = teil[0].close, tiefstTs = null, hochTs = teil[0].ts;
  let schlimmster = 0, schlimmsterHochTs = null, schlimmsterTiefTs = null;
  for (const p of teil) {
    if (p.close > hoch) { hoch = p.close; hochTs = p.ts; }
    const rueck = (p.close - hoch) / hoch * 100;
    if (rueck < schlimmster) {
      schlimmster = rueck;
      schlimmsterHochTs = hochTs;
      schlimmsterTiefTs = p.ts;
    }
  }
  if (schlimmsterTiefTs === null) return null;

  const letzter = teil[teil.length - 1].close;
  const aktuell = (letzter - hoch) / hoch * 100;   // Abstand zum bisherigen Hoch
  const tag = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

  /* Die zweite Haelfte der Frage (30.10.2026): nicht nur wie tief, sondern wie
   * lange bis zurueck. Ein Rueckgang von 20 %, der nach drei Wochen aufgeholt
   * ist, ist etwas anderes als einer, der nach neun Monaten noch steht. Dafuer
   * wird der Kurs nach dem Tiefpunkt gesucht, der das Hoch davor wieder
   * erreicht hat - findet sich keiner, steht der Wert bis heute darunter. */
  const hochVorher = teil.find((x) => x.ts === schlimmsterHochTs);
  const schwelle = hochVorher ? hochVorher.close : null;
  let erholtAm = null;
  if (schwelle !== null) {
    const danach = teil.filter((x) => x.ts > schlimmsterTiefTs && x.close >= schwelle);
    if (danach.length) erholtAm = danach[0].ts;
  }

  return {
    tiefe: rund(schlimmster, 1),
    von: tag(schlimmsterHochTs),
    bis: tag(schlimmsterTiefTs),
    dauerTage: Math.round((schlimmsterTiefTs - schlimmsterHochTs) / 86400),
    erholtAm: erholtAm ? tag(erholtAm) : null,
    erholungTage: erholtAm ? Math.round((erholtAm - schlimmsterTiefTs) / 86400) : null,
    nochDarunter: erholtAm === null,
    tageDarunter: erholtAm === null
      ? Math.round((teil[teil.length - 1].ts - schlimmsterHochTs) / 86400) : null,
    jetzt: rund(aktuell, 1),
    erholt: erholtAm !== null,
  };
}

/* Wie viel von einem Wert ist einfach "der Markt"? (29.10.2026)
 *
 * Die Beobachtungsliste sieht nach zwanzig Wetten aus. Wenn die meisten davon
 * im Gleichschritt mit dem Weltindex laufen, sind es in Wahrheit ein paar
 * wenige. Dieselbe Rechnung wie beim Gleichlauf der sechs gehandelten Werte,
 * nur gegen den Vergleichsindex statt untereinander.
 *
 * Nur bei gleicher Waehrung, sonst misst man den Wechselkurs mit. */
function marktkorrelation(reihe, massstabReihe, gleicheWaehrung) {
  if (!gleicheWaehrung || !massstabReihe) return null;
  const a = kz.gemeinsameTage({ x: reihe, y: massstabReihe }, ["x", "y"]);
  if (a.tage.length < REL_TAGE + 10) return null;
  const rx = kz.renditen(a.closes.x).slice(-REL_TAGE);
  const ry = kz.renditen(a.closes.y).slice(-REL_TAGE);
  if (rx.length < REL_TAGE) return null;
  const roh = kz.korrelation(rx, ry);
  if (roh === null) return null;

  // Auf zwei Stellen runden BEVOR geurteilt wird, damit Anzeige und Urteil
  // nicht auseinanderlaufen (gleiche Logik wie bei gleichlauf()).
  const k = Math.round(roh * 100) / 100;
  const standardfehler = 1 / Math.sqrt(REL_TAGE - 3);
  const schwelle = Math.round(2 * standardfehler * 100) / 100;

  let stufe;
  if (Math.abs(k) <= schwelle) stufe = "eigenstaendig";
  else if (k >= 0.85) stufe = "praktisch der Markt";
  else if (k >= 0.6) stufe = "ueberwiegend Markt";
  else if (k >= 0.3) stufe = "teilweise Markt";
  else stufe = "weitgehend eigenstaendig";

  return { wert: k, stufe, tage: REL_TAGE, standardfehler: rund(standardfehler, 2), schwelle };
}

function relativ(reihe, massstabReihe, gleicheWaehrung) {
  if (!gleicheWaehrung || !massstabReihe) return { stufe: "nicht vergleichbar", grund: "andere Währung als der Vergleichsindex – ein Vergleich würde den Wechselkurs mitmessen" };
  const a = kz.gemeinsameTage({ x: reihe, y: massstabReihe }, ["x", "y"]);
  if (a.tage.length < REL_TAGE + 10) return { stufe: "unbekannt", grund: "zu wenige gemeinsame Handelstage" };

  const rx = kz.renditen(a.closes.x).slice(-REL_TAGE);
  const ry = kz.renditen(a.closes.y).slice(-REL_TAGE);
  if (rx.length < REL_TAGE || ry.length < REL_TAGE) return { stufe: "unbekannt", grund: "zu kurze Reihe" };

  const summe = (arr) => (Math.exp(arr.reduce((s, v) => s + v, 0)) - 1) * 100;
  const vorsprung = summe(rx) - summe(ry);
  const diff = rx.map((v, i) => v - ry[i]);
  const streuung = kz.stdabw(diff);
  if (streuung === null || streuung <= 0) return { stufe: "unbekannt", grund: "keine Streuung messbar" };
  const zufallsbreite = streuung * Math.sqrt(REL_TAGE) * 100;

  const z = Math.abs(vorsprung) / zufallsbreite;
  let stufe, grund;
  if (z < 2) {
    stufe = "rauschen";
    grund = "Vorsprung " + (vorsprung > 0 ? "+" : "") + dz(vorsprung, 1) + " Punkte liegt im Zufallsbereich (±"
      + dz(2 * zufallsbreite, 1) + ") – kein belastbarer Unterschied zum breiten Markt";
  } else if (z < 3) {
    stufe = vorsprung > 0 ? "besser" : "schlechter";
    grund = "außerhalb des Zufallsbereichs (±" + dz(2 * zufallsbreite, 1) + " Punkte), aber nicht weit";
  } else {
    stufe = vorsprung > 0 ? "deutlich besser" : "deutlich schlechter";
    grund = "klar außerhalb des Zufallsbereichs (±" + dz(2 * zufallsbreite, 1) + " Punkte)";
  }
  return { vorsprung: rund(vorsprung, 1), zufallsbreite: rund(2 * zufallsbreite, 1), stufe, grund };
}

async function sammle() {
  const reihen = {}, meta = {};
  // Der USD-Massstab steht nicht in WERTE (er soll keine eigene Zeile
  // bekommen), muss aber mitgeholt werden.
  const abzurufen = WERTE.concat(
    WERTE.some((w) => w.symbol === MASSSTAB_USD) ? [] : [{ symbol: MASSSTAB_USD, nurMassstab: true }]
  );
  for (const w of abzurufen) {
    try {
      const r = await holeReihe(w.symbol);
      reihen[w.symbol] = r.reihe;
      meta[w.symbol] = r;
    } catch (e) {
      meta[w.symbol] = { fehler: String(e && e.message ? e.message : e).slice(0, 100) };
    }
    await schlafe(PAUSE_MS);
  }

  const massstaebe = {
    EUR: { reihe: reihen[MASSSTAB_EUR] || null, symbol: MASSSTAB_EUR,
           waehrung: (meta[MASSSTAB_EUR] && meta[MASSSTAB_EUR].waehrung) || null },
    USD: { reihe: reihen[MASSSTAB_USD] || null, symbol: MASSSTAB_USD,
           waehrung: (meta[MASSSTAB_USD] && meta[MASSSTAB_USD].waehrung) || null },
  };
  function massstabFuer(waehrung) {
    for (const k of Object.keys(massstaebe)) {
      if (massstaebe[k].waehrung && massstaebe[k].waehrung === waehrung) return massstaebe[k];
    }
    return null;
  }

  const eintraege = WERTE.map((w) => {
    const m = meta[w.symbol] || {};
    if (!reihen[w.symbol]) {
      return { ...w, ok: false, grund: m.fehler || "keine Daten" };
    }
    const reihe = reihen[w.symbol];
    const closes = reihe.map((p) => p.close);
    const letzter = m.livekurs || reihe[reihe.length - 1].close;

    return {
      ...w,
      ok: true,
      langname: m.langname,
      waehrung: m.waehrung,
      kurs: rund(letzter, letzter >= 100 ? 2 : 4),
      stand: new Date(reihe[reihe.length - 1].ts * 1000).toISOString().slice(0, 10),
      spanne: spanne52(reihe),
      rueckgang: maxRueckgang(reihe, 365),
      verlauf: kursverlauf(reihe, 365),
      marktkorrelation: (() => {
        if (w.symbol === MASSSTAB_EUR || w.symbol === MASSSTAB_USD) return null;
        const ms = massstabFuer(m.waehrung);
        return ms && ms.reihe ? marktkorrelation(reihe, ms.reihe, true) : null;
      })(),
      /* Kurze Fenster (22.10.2026): Tiam will zu einer Nachricht sehen, was
       * die betroffenen Werte SCHON gemacht haben. Drei und sieben Tage
       * decken das Fenster ab, aus dem die Schlagzeilen stammen. */
      tage3: rund(seit(reihe, 3), 1),
      tage7: rund(seit(reihe, 7), 1),
      monat1: rund(seit(reihe, 30), 1),
      monat3: rund(seit(reihe, 91), 1),
      monat6: rund(seit(reihe, 182), 1),
      jahr1: rund(seit(reihe, 365), 1),
      schwankung: rund(kz.schwankung(closes, VOL_FENSTER), 1),
      relativ: (() => {
        if (w.symbol === MASSSTAB_EUR || w.symbol === MASSSTAB_USD) {
          return { stufe: "massstab", grund: "Das ist der Vergleichsmaßstab selbst." };
        }
        const ms = massstabFuer(m.waehrung);
        if (!ms || !ms.reihe) {
          return { stufe: "nicht vergleichbar",
                   grund: "kein Vergleichsindex in " + (m.waehrung || "dieser Währung") + " verfügbar – ein Vergleich würde den Wechselkurs mitmessen" };
        }
        const r = relativ(reihe, ms.reihe, true);
        r.gegen = ms.symbol;
        return r;
      })(),
    };
  });

  return {
    themen: THEMEN,
    massstab: MASSSTAB_EUR,
    massstabName: (meta[MASSSTAB_EUR] && meta[MASSSTAB_EUR].langname) || MASSSTAB_EUR,
    massstabUsd: MASSSTAB_USD,
    massstabUsdName: (meta[MASSSTAB_USD] && meta[MASSSTAB_USD].langname) || MASSSTAB_USD,
    relTage: REL_TAGE,
    volFenster: VOL_FENSTER,
    eintraege,
  };
}

module.exports = { WERTE, THEMEN, MASSSTAB, MASSSTAB_EUR, MASSSTAB_USD, REL_TAGE, VOL_FENSTER, holeReihe, seit, spanne52, relativ, maxRueckgang, marktkorrelation, kursverlauf, sammle };
