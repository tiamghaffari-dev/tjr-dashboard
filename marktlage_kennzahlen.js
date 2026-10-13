"use strict";
/* ===========================================================================
 * marktlage_kennzahlen.js - Etappe 2 des Marktlage-Bereichs
 * ===========================================================================
 * Vier Umfeld-Kennzahlen, alle REGELBASIERT aus Kursreihen gerechnet. Kein
 * Sprachmodell, keine Prognose, keine Empfehlung.
 *
 * Die wichtigste Eigenschaft dieser Datei ist nicht das Rechnen, sondern das
 * EINGESTEHEN: zu jeder Zahl wird mitgerechnet, wie gross der Zufallsanteil
 * ist. Liegt der Wert innerhalb dieser Unsicherheit, wird er als "Rauschen"
 * ausgewiesen statt huebsch angezeigt. Das ist Tiams ausdrueckliche Vorgabe
 * und deckt sich mit der Projektregel, nie einen Befund zu verwerten, der
 * nicht gegengerechnet wurde.
 *
 * Diese Datei ist von der TJR-Engine getrennt: sie laedt engine.js nicht und
 * wird von ihr nicht geladen. Keine Zahl von hier beeinflusst ein Signal.
 * ===========================================================================
 */

/* Zahlen in den Begruendungstexten deutsch schreiben (Komma statt Punkt).
 * Die Texte stehen so wie sie sind auf der Seite - toFixed() wuerde dort
 * "±0.26" neben "+0,84" setzen. */
function dz(x, stellen) {
  return Number(x).toFixed(stellen).replace(".", ",");
}

/* -------------------------------------------------------------------------
 * Statistik-Grundlagen
 * ------------------------------------------------------------------------- */

function mittel(xs) {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/* Stichproben-Standardabweichung (n-1). Bei weniger als zwei Werten gibt es
 * keine Streuung, die man schaetzen koennte - dann null statt 0, damit
 * niemand mit einer erfundenen Null weiterrechnet. */
function stdabw(xs) {
  if (xs.length < 2) return null;
  const m = mittel(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* Perzentil-Rang: wie viel Prozent der Vergangenheitswerte liegen UNTER dem
 * aktuellen? 90 heisst "hoeher als an 90 % der Tage im Vergleichszeitraum". */
function perzentilRang(wert, verteilung) {
  const gueltig = verteilung.filter((x) => typeof x === "number" && isFinite(x));
  if (gueltig.length < 20) return null;
  let drunter = 0;
  for (const x of gueltig) if (x < wert) drunter++;
  return (drunter / gueltig.length) * 100;
}

/* Logarithmische Tagesrenditen. Log statt einfacher Prozente, weil sie sich
 * addieren lassen - fuer Streuungsrechnungen die saubere Groesse. */
function renditen(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  }
  return r;
}

function korrelation(a, b) {
  if (a.length !== b.length || a.length < 3) return null;
  const ma = mittel(a), mb = mittel(b);
  let zaehler = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    zaehler += da * db; sa += da * da; sb += db * db;
  }
  if (sa <= 0 || sb <= 0) return null;
  return zaehler / Math.sqrt(sa * sb);
}

/* -------------------------------------------------------------------------
 * Reihen auf GEMEINSAME Handelstage bringen.
 *
 * Ohne das waere jede Korrelation Unsinn: Bitcoin handelt sieben Tage pro
 * Woche, der S&P 500 fuenf. Wuerde man die Reihen einfach nebeneinanderlegen,
 * stuende BTCs Sonntag neben dem Montag des Index - man wuerde Kalender
 * korrelieren, nicht Maerkte.
 * ------------------------------------------------------------------------- */
function gemeinsameTage(reihenNachSymbol, symbole) {
  const karten = {};
  for (const s of symbole) {
    const k = new Map();
    for (const p of (reihenNachSymbol[s] || [])) {
      k.set(new Date(p.ts * 1000).toISOString().slice(0, 10), p.close);
    }
    karten[s] = k;
  }
  let tage = null;
  for (const s of symbole) {
    const eigene = new Set(karten[s].keys());
    tage = tage === null ? eigene : new Set([...tage].filter((d) => eigene.has(d)));
  }
  const sortiert = [...(tage || [])].sort();
  const aus = {};
  for (const s of symbole) aus[s] = sortiert.map((d) => karten[s].get(d));

  // Mitschreiben, wie viele Tage jedes Symbol EINZELN hat und wie viele davon
  // die Schnittmenge ueberleben. Beim ersten echten Lauf fiel auf, dass die
  // Schnittmenge deutlich kleiner war als erwartet - ohne diese Zahlen laesst
  // sich nicht sagen, ob das an einem einzelnen Symbol liegt (dann waere es
  // ein Datenproblem) oder an normalen Feiertagsunterschieden.
  const einzeln = {};
  for (const s of symbole) einzeln[s] = karten[s].size;

  return { tage: sortiert, closes: aus, einzeln };
}

/* ===========================================================================
 * 1. NERVOSITAET
 * ===========================================================================
 * Zwei Messungen nebeneinander, weil eine allein in die Irre fuehrt:
 *
 *   a) Der VIX. Der misst die ERWARTETE Schwankung im S&P 500 - und nur dort.
 *      Ueber Bitcoin oder GBP/USD sagt er direkt nichts.
 *   b) Die tatsaechlich GEMESSENE Schwankungsbreite jedes einzelnen Werts,
 *      den die Engine handelt. Das ist der Ersatz, den Tiam gemeint hat.
 *
 * Eingeordnet wird nicht am absoluten Wert ("17 ist viel") - das sagt ohne
 * Vergleichsmassstab nichts -, sondern am Perzentil-Rang im eigenen Jahr.
 * =========================================================================== */

const VOL_FENSTER = 20;      // ~1 Handelsmonat
const HANDELSTAGE_JAHR = 252;

/* Annualisierte Schwankungsbreite aus den letzten `fenster` Renditen. */
function schwankung(closes, fenster) {
  const r = renditen(closes);
  if (r.length < fenster) return null;
  const s = stdabw(r.slice(-fenster));
  return s === null ? null : s * Math.sqrt(HANDELSTAGE_JAHR) * 100;
}

/* Die Verteilung derselben Messung ueber das ganze Jahr - der Massstab,
 * gegen den der aktuelle Wert eingeordnet wird. */
function schwankungsVerlauf(closes, fenster) {
  const r = renditen(closes);
  const aus = [];
  for (let ende = fenster; ende <= r.length; ende++) {
    const s = stdabw(r.slice(ende - fenster, ende));
    if (s !== null) aus.push(s * Math.sqrt(HANDELSTAGE_JAHR) * 100);
  }
  return aus;
}

/* Rauschurteil fuer eine Schwankungsmessung.
 *
 * Eine aus n Beobachtungen geschaetzte Streuung hat selbst einen relativen
 * Standardfehler von rund 1/sqrt(2n). Bei 20 Tagen sind das ~16 %.
 *
 * Das Rauschband ist bewusst ZWEI Standardfehler breit (~32 %), nicht einer.
 * Getestet mit einer kuenstlichen Reihe konstanter Schwankung: bei einem
 * Standardfehler meldete die Funktion in rund einem Drittel der Faelle
 * "unruhiger/ruhiger als ueblich", obwohl sich nachweislich nichts geaendert
 * hatte. Genau das wollte Tiam nicht - lieber eine Meldung zu wenig als eine
 * erfundene. Echte Schwankungsschuebe aendern die Breite um Faktor 2-3 und
 * werden weiterhin zuverlaessig erkannt (auch im Test geprueft). */
function schwankungsUrteil(jetzt, verlauf, fenster) {
  if (jetzt === null || verlauf.length < 20) {
    return { stufe: "unbekannt", text: "Datenreihe zu kurz für eine Einordnung." };
  }
  const med = median(verlauf);
  const relSe = 1 / Math.sqrt(2 * fenster);
  const band = 2 * relSe;
  const abweichung = (jetzt - med) / med;

  if (Math.abs(abweichung) < band) {
    return {
      stufe: "rauschen",
      text: "Unterschied zum üblichen Wert des Jahres kleiner als die Messungenauigkeit (±"
        + Math.round(band * 100) + " %) - also kein Unterschied, den man behaupten sollte.",
    };
  }
  const rang = perzentilRang(jetzt, verlauf);
  if (abweichung > 0) {
    return {
      stufe: "hoch",
      text: "Schwankt stärker als üblich - höher als an " + Math.round(rang) + " % der Tage im letzten Jahr.",
    };
  }
  return {
    stufe: "niedrig",
    text: "Schwankt ruhiger als üblich - niedriger als an " + Math.round(100 - rang) + " % der Tage im letzten Jahr.",
  };
}

function nervositaet(reihenNachSymbol, vixSymbol, gehandelteSymbole) {
  const vixReihe = reihenNachSymbol[vixSymbol] || [];
  const vixCloses = vixReihe.map((p) => p.close);
  let vix = null;
  if (vixCloses.length >= 60) {
    const jetzt = vixCloses[vixCloses.length - 1];
    const rang = perzentilRang(jetzt, vixCloses);
    vix = {
      stand: Math.round(jetzt * 100) / 100,
      perzentil: rang === null ? null : Math.round(rang),
      jahrTief: Math.round(Math.min(...vixCloses) * 100) / 100,
      jahrHoch: Math.round(Math.max(...vixCloses) * 100) / 100,
      median: Math.round(median(vixCloses) * 100) / 100,
      tage: vixCloses.length,
    };
  }

  const werte = [];
  for (const s of gehandelteSymbole) {
    const closes = (reihenNachSymbol[s.symbol] || []).map((p) => p.close);
    const jetzt = schwankung(closes, VOL_FENSTER);
    const verlauf = schwankungsVerlauf(closes, VOL_FENSTER);
    const urteil = schwankungsUrteil(jetzt, verlauf, VOL_FENSTER);
    werte.push({
      name: s.name,
      symbol: s.symbol,
      schwankung: jetzt === null ? null : Math.round(jetzt * 10) / 10,
      jahrMedian: verlauf.length ? Math.round(median(verlauf) * 10) / 10 : null,
      perzentil: (jetzt !== null && verlauf.length >= 20) ? Math.round(perzentilRang(jetzt, verlauf)) : null,
      stufe: urteil.stufe,
      urteil: urteil.text,
    });
  }

  return { vix, fenster: VOL_FENSTER, werte };
}

/* ===========================================================================
 * 2. SEKTOREN - wer laeuft vorn, wer hinten
 * ===========================================================================
 * Gemessen wird NICHT die blanke Rendite (dann stuenden bei steigendem Markt
 * einfach alle vorn), sondern der Vorsprung gegenueber dem Gesamtmarkt.
 *
 * Und dann die eigentliche Frage: ist dieser Vorsprung ueberhaupt mehr als
 * Zufall? Unter einem Zufallspfad waechst die aufsummierte Differenz mit
 * sqrt(n). Aus der Tagesstreuung der Differenz mal sqrt(n) ergibt sich, wie
 * gross ein Vorsprung allein durch Zufall typischerweise wird. Alles darunter
 * ist Rauschen und wird auch so beschriftet.
 * =========================================================================== */

const SEKTOR_FENSTER = 21;   // ~1 Handelsmonat

function sektorRangliste(reihenNachSymbol, sektoren, marktSymbol) {
  const symbole = [marktSymbol, ...sektoren.map((s) => s.symbol)];
  const { tage, closes } = gemeinsameTage(reihenNachSymbol, symbole);
  if (tage.length < SEKTOR_FENSTER + 2) {
    return { ok: false, grund: "zu wenige gemeinsame Handelstage (" + tage.length + ")" };
  }

  const marktR = renditen(closes[marktSymbol]).slice(-SEKTOR_FENSTER);
  const marktRendite = (Math.exp(marktR.reduce((a, b) => a + b, 0)) - 1) * 100;

  const zeilen = [];
  for (const s of sektoren) {
    const sR = renditen(closes[s.symbol]).slice(-SEKTOR_FENSTER);
    if (sR.length < SEKTOR_FENSTER) continue;

    const rendite = (Math.exp(sR.reduce((a, b) => a + b, 0)) - 1) * 100;
    const vorsprung = rendite - marktRendite;

    // Streuung der TAEGLICHEN Differenz -> hochgerechnet auf das Fenster.
    const diff = sR.map((x, i) => x - marktR[i]);
    const tagesStreuung = stdabw(diff);
    const zufallsbreite = tagesStreuung === null
      ? null
      : tagesStreuung * Math.sqrt(SEKTOR_FENSTER) * 100;

    // Die Grenzen liegen bei ZWEI und DREI Zufallsbreiten, nicht bei einer.
    // Im Test mit einer reinen Zufallsreihe ohne jeden echten Vorsprung kam
    // bei einer Breite regelmaessig "schwach" heraus (z lag bei 1,35) - eine
    // Scheinaussage genau der Sorte, die diese Seite vermeiden soll.
    let stufe = "unbekannt", urteil = "Nicht beurteilbar.";
    if (zufallsbreite !== null && zufallsbreite > 0) {
      const z = Math.abs(vorsprung) / zufallsbreite;
      if (z < 2) {
        stufe = "rauschen";
        urteil = "Innerhalb dessen, was reiner Zufall über einen Monat erzeugt (±"
          + dz(2 * zufallsbreite, 1) + " Punkte). Kein belastbarer Unterschied zum Gesamtmarkt.";
      } else if (z < 3) {
        stufe = "schwach";
        urteil = "Außerhalb des Zufallsbereichs (±" + dz(2 * zufallsbreite, 1)
          + " Punkte), aber nicht weit. Mit Vorsicht lesen.";
      } else {
        stufe = "deutlich";
        urteil = "Klar außerhalb des Zufallsbereichs (±" + dz(2 * zufallsbreite, 1) + " Punkte).";
      }
    }

    zeilen.push({
      name: s.name, symbol: s.symbol,
      rendite: Math.round(rendite * 100) / 100,
      vorsprung: Math.round(vorsprung * 100) / 100,
      zufallsbreite: zufallsbreite === null ? null : Math.round(zufallsbreite * 100) / 100,
      stufe, urteil,
    });
  }

  zeilen.sort((a, b) => b.vorsprung - a.vorsprung);
  return {
    ok: true,
    fenster: SEKTOR_FENSTER,
    marktSymbol,
    marktRendite: Math.round(marktRendite * 100) / 100,
    vonTag: tage[tage.length - SEKTOR_FENSTER - 1],
    bisTag: tage[tage.length - 1],
    zeilen,
    alleRauschen: zeilen.length > 0 && zeilen.every((z) => z.stufe === "rauschen"),
  };
}

/* ===========================================================================
 * 3. GLEICHLAUF DER SECHS GEHANDELTEN WERTE
 * ===========================================================================
 * Paarweise Korrelation der Tagesrenditen auf GEMEINSAMEN Handelstagen.
 *
 * Rauschurteil ueber den Standardfehler 1/sqrt(n-3) (Fisher). Bei 60
 * gemeinsamen Tagen sind das ~0,13 - alles unter rund 0,26 ist von "kein
 * Zusammenhang" nicht zu unterscheiden und wird genau so ausgewiesen.
 * =========================================================================== */

const KORR_FENSTER = 60;
const KORR_STARK = 0.6;

function gleichlauf(reihenNachSymbol, gehandelte) {
  const symbole = gehandelte.map((g) => g.symbol);
  const { tage, closes, einzeln } = gemeinsameTage(reihenNachSymbol, symbole);
  if (tage.length < 30) {
    return { ok: false, grund: "zu wenige gemeinsame Handelstage (" + tage.length + ")" };
  }

  // Wie viele Tage bringt jedes Symbol mit, und wie viele bleiben gemeinsam
  // uebrig? Ein Symbol, das deutlich weniger Tage hat als die anderen, zieht
  // die Schnittmenge nach unten - das muss sichtbar sein, sonst steht auf der
  // Seite eine Korrelation auf duennerer Grundlage als behauptet.
  const herkunft = symbole.map((s) => {
    // Wie viele Tage kaemen dazu, wenn man genau dieses Symbol weglaesst?
    // Das zeigt, WER die Schnittmenge klein macht. Ein Symbol mit einem
    // abweichenden Handelskalender faellt hier sofort auf - bei blossen
    // Tageszahlen je Symbol wuerde man das nicht sehen.
    const ohne = gemeinsameTage(reihenNachSymbol, symbole.filter((x) => x !== s));
    return { symbol: s, eigeneTage: einzeln[s], ohneDiesen: ohne.tage.length - tage.length };
  });
  herkunft.sort((a, b) => b.ohneDiesen - a.ohneDiesen);

  const r = {};
  for (const s of symbole) r[s] = renditen(closes[s]).slice(-KORR_FENSTER);
  const n = Math.min(...symbole.map((s) => r[s].length));
  for (const s of symbole) r[s] = r[s].slice(-n);

  const se = 1 / Math.sqrt(n - 3);
  // Auch die Schwelle auf zwei Stellen runden und EINSCHLIESSLICH vergleichen.
  // Sonst waere ein angezeigter Wert von genau "+0,26" als "schwach" markiert,
  // waehrend der Text darueber sagt, alles zwischen -0,26 und +0,26 sei nicht
  // unterscheidbar. Anzeige, Text und Urteil muessen dasselbe sagen.
  const schwelle = Math.round(2 * se * 100) / 100;

  const paare = [];
  for (let i = 0; i < gehandelte.length; i++) {
    for (let j = i + 1; j < gehandelte.length; j++) {
      const a = gehandelte[i], b = gehandelte[j];
      const roh = korrelation(r[a.symbol], r[b.symbol]);
      if (roh === null) continue;
      // Auf zwei Stellen runden, BEVOR geurteilt wird. Sonst kann ein Wert
      // als "+0,26" angezeigt werden und gleichzeitig "liegt innerhalb von
      // ±0,26" danebenstehen - die dritte Nachkommastelle ist bei einem
      // Standardfehler von 0,13 ohnehin bedeutungslos.
      const k = Math.round(roh * 100) / 100;

      let stufe, urteil;
      if (Math.abs(k) <= schwelle) {
        stufe = "rauschen";
        urteil = "Kein erkennbarer Zusammenhang - der Wert liegt innerhalb der Messungenauigkeit (±"
          + dz(schwelle, 2) + ").";
      } else if (k >= KORR_STARK) {
        stufe = "stark-mit";
        urteil = "Laufen deutlich miteinander. Zwei Signale gleichzeitig sind hier eher EINE Wette als zwei.";
      } else if (k <= -KORR_STARK) {
        stufe = "stark-gegen";
        urteil = "Laufen deutlich gegeneinander.";
      } else if (k > 0) {
        stufe = "schwach-mit";
        urteil = "Schwacher Gleichlauf - messbar, aber weit von Gleichschritt entfernt.";
      } else {
        stufe = "schwach-gegen";
        urteil = "Schwacher Gegenlauf - messbar, aber schwach.";
      }

      paare.push({
        a: a.name, b: b.name, aSymbol: a.symbol, bSymbol: b.symbol,
        wert: k, stufe, urteil,
      });
    }
  }

  paare.sort((x, y) => Math.abs(y.wert) - Math.abs(x.wert));
  return {
    ok: true,
    tage: n,
    vonTag: tage[tage.length - n - 1] || tage[0],
    bisTag: tage[tage.length - 1],
    standardfehler: Math.round(se * 1000) / 1000,
    schwelle,
    gemeinsamGesamt: tage.length,
    herkunft,
    paare,
    starkeAnzahl: paare.filter((p) => p.stufe === "stark-mit" || p.stufe === "stark-gegen").length,
  };
}

/* ===========================================================================
 * 4. ANSTEHENDE TERMINE
 * ===========================================================================
 * Derselbe ForexFactory-Feed, den build.js schon benutzt (loadNews) - aber
 * ohne den Filter auf HEUTE, denn hier interessieren die kommenden Termine.
 *
 * WICHTIG und auf der Seite auch so gesagt: der Feed enthaelt nur die
 * AKTUELLE Kalenderwoche. An einem Freitagnachmittag ist er darum fast leer -
 * das heisst dann "diese Woche nichts mehr", nicht "die naechsten Tage frei".
 * =========================================================================== */

const KALENDER_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const KALENDER_WAEHRUNGEN = ["USD", "GBP"];

async function termine() {
  const antwort = await fetch(KALENDER_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tjr-dashboard marktlage)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!antwort.ok) throw new Error("HTTP " + antwort.status);
  const roh = await antwort.json();
  if (!Array.isArray(roh)) throw new Error("unerwartetes Format");

  const jetzt = Date.now();
  const kommend = roh
    .filter((e) => KALENDER_WAEHRUNGEN.includes(e.country) && e.impact === "High")
    .map((e) => ({ zeitIso: e.date, titel: e.title, waehrung: e.country, ts: new Date(e.date).getTime() }))
    .filter((e) => isFinite(e.ts) && e.ts >= jetzt - 2 * 3600 * 1000)  // 2h Nachlauf
    .sort((a, b) => a.ts - b.ts);

  return {
    ok: true,
    geprueft: new Date().toISOString(),
    gesamtImFeed: roh.length,
    kommende: kommend.slice(0, 20),
  };
}

module.exports = {
  mittel, stdabw, median, perzentilRang, renditen, korrelation, gemeinsameTage,
  schwankung, schwankungsVerlauf, schwankungsUrteil,
  nervositaet, sektorRangliste, gleichlauf, termine,
  VOL_FENSTER, SEKTOR_FENSTER, KORR_FENSTER, KALENDER_URL,
};
