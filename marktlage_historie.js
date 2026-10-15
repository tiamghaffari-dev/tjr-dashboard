"use strict";
/* ===========================================================================
 * marktlage_historie.js - Etappe 3 des Marktlage-Bereichs
 * ===========================================================================
 * Schreibt die Umfeld-Werte Tag fuer Tag mit, damit spaeter ueberhaupt die
 * Frage gestellt werden KANN, ob das Umfeld etwas ueber die Trefferquote der
 * TJR-Engine sagt. Heute beantwortet das niemand - dafuer braucht es Monate.
 *
 * WARUM NICHT IN signals_log.json
 * -------------------------------
 * Urspruenglich war geplant, die Umfeldwerte neben jedes TJR-Signal zu
 * schreiben. Das haette build.js und das Signal-Log angefasst - und damit
 * genau die Trennung aufgeweicht, die Tiam fuer den Marktlage-Bereich
 * ausdruecklich verlangt hat ("Ein Fehler dort darf den TJR-Report nie
 * kippen"). Zwei zusaetzliche Gruende dagegen:
 *   - Im Projekt gilt, dass bestehende Eintraege in signals_log.json ihre
 *     alten Werte behalten. Ein neues Feld haette dort 565 Eintraege ohne
 *     diesen Wert hinterlassen - eine Luecke, die man spaeter leicht als
 *     "Umfeld war neutral" fehlliest.
 *   - Ein Abruf-Fehler bei Yahoo haette im schlimmsten Fall den Lauf
 *     getroffen, der Paper-Trades schreibt.
 *
 * Stattdessen fuehrt dieser Bereich seine EIGENE Zeitreihe. Die Verbindung zu
 * den Signalen entsteht erst bei der Auswertung, ueber das Datum - lesend,
 * von dieser Seite aus. build.js wird nicht angefasst, signals_log.json nicht
 * veraendert. Geht hier etwas schief, fehlt ein Tag in dieser Datei und sonst
 * nichts.
 *
 * SCHLUESSEL IST DER HANDELSTAG, NICHT DER LAUFZEITPUNKT
 * ------------------------------------------------------
 * Der Workflow laeuft zweimal taeglich. Um 05:30 UTC ist der letzte
 * abgeschlossene US-Handelstag der von gestern, um 22:40 UTC der von heute.
 * Wuerde man nach Laufdatum schluesseln, bekaeme der Morgenlauf die Werte von
 * gestern unter dem heutigen Datum. Geschluesselt wird darum nach dem letzten
 * Handelstag des S&P 500 - der Laeufe desselben Tages schreiben dieselbe
 * Zeile, der spaetere gewinnt.
 * ===========================================================================
 */

const fs = require("fs");
const path = require("path");

const DATEI = "historie.json";

function r(x, stellen) {
  if (typeof x !== "number" || !isFinite(x)) return null;
  const f = Math.pow(10, stellen);
  return Math.round(x * f) / f;
}

/* Eine Tageszeile aus dem fertigen Marktlage-Stand bauen. Bewusst knapp und
 * gerundet: die Datei waechst taeglich und wird taeglich committet. */
function baueZeile(daten, marktSymbol) {
  const kz = daten.kennzahlen || {};
  const eintraege = daten.eintraege || [];

  const markt = eintraege.find((e) => e.symbol === marktSymbol && e.ok);
  if (!markt || !markt.standDatum) return null;

  const kurse = {};
  for (const e of eintraege) if (e.ok && typeof e.stand === "number") kurse[e.symbol] = e.stand;

  const zeile = {
    handelstag: markt.standDatum,
    geschriebenAm: daten.standIso || new Date().toISOString(),
    kurse,
  };

  const n = kz.nervositaet;
  if (n) {
    if (n.vix) {
      zeile.vix = n.vix.stand;
      zeile.vixPerzentil = n.vix.perzentil;
    }
    zeile.schwankung = {};
    zeile.schwankungStufe = {};
    for (const w of (n.werte || [])) {
      zeile.schwankung[w.symbol] = w.schwankung;
      zeile.schwankungStufe[w.symbol] = w.stufe;
    }
  }

  const sk = kz.sektoren;
  if (sk && sk.ok) {
    zeile.sektorVorsprung = {};
    zeile.sektorStufe = {};
    for (const z of sk.zeilen) {
      zeile.sektorVorsprung[z.symbol] = z.vorsprung;
      zeile.sektorStufe[z.symbol] = z.stufe;
    }
    zeile.sektorMarktRendite = sk.marktRendite;
    zeile.sektorAllesRauschen = !!sk.alleRauschen;
  }

  const gl = kz.gleichlauf;
  if (gl && gl.ok) {
    zeile.gleichlauf = {};
    for (const p of gl.paare) zeile.gleichlauf[p.aSymbol + "|" + p.bSymbol] = p.wert;
    zeile.gleichlaufStark = gl.starkeAnzahl;
    zeile.gleichlaufTage = gl.tage;
  }

  const t = kz.termine;
  if (t && t.ok) {
    // Nur die Anzahl der Termine AN DIESEM Handelstag - das ist die Groesse,
    // die spaeter zu einem Signal passt. Die Titel gehoeren nicht in eine
    // Zeitreihe, die jahrelang waechst.
    zeile.termineHeute = t.kommende.filter(
      (e) => String(e.zeitIso).slice(0, 10) === markt.standDatum
    ).length;
  }

  return zeile;
}

/* Lesen, ergaenzen, schreiben.
 *
 * Der wichtigste Teil ist, was NICHT passiert: laesst sich die vorhandene
 * Datei nicht lesen, wird sie auch nicht ueberschrieben. Lieber ein Tag Luecke
 * und ein Fehler im Lauf-Protokoll als eine stillschweigend geleerte
 * Zeitreihe, die man erst in einem halben Jahr vermisst. */
function schreibe(ordner, daten, marktSymbol) {
  const zeile = baueZeile(daten, marktSymbol);
  if (!zeile) return { ok: false, grund: "kein brauchbarer Marktwert (" + marktSymbol + ") im Stand" };

  const ziel = path.join(ordner, DATEI);

  let bestand = {};
  if (fs.existsSync(ziel)) {
    let roh;
    try {
      roh = fs.readFileSync(ziel, "utf8");
    } catch (e) {
      return { ok: false, grund: "Historie nicht lesbar, NICHT ueberschrieben: " + e.message };
    }
    try {
      bestand = JSON.parse(roh);
    } catch (e) {
      return { ok: false, grund: "Historie ist kein gueltiges JSON, NICHT ueberschrieben: " + e.message };
    }
    if (!bestand || typeof bestand !== "object" || Array.isArray(bestand)) {
      return { ok: false, grund: "Historie hat unerwartete Form, NICHT ueberschrieben" };
    }
  }

  const istNeu = !(zeile.handelstag in bestand);
  bestand[zeile.handelstag] = zeile;

  // Nach Datum sortiert schreiben, damit der tägliche git-Diff genau eine
  // Zeile ist und nicht die ganze Datei.
  const sortiert = {};
  for (const k of Object.keys(bestand).sort()) sortiert[k] = bestand[k];

  fs.mkdirSync(ordner, { recursive: true });
  fs.writeFileSync(ziel, JSON.stringify(sortiert, null, 2), "utf8");

  const tage = Object.keys(sortiert);
  return {
    ok: true,
    handelstag: zeile.handelstag,
    neu: istNeu,
    tage: tage.length,
    seit: tage[0],
    bytes: fs.statSync(ziel).size,
  };
}

/* Lesehilfe fuer spaeter: zu einem Zeitpunkt (echte Epoch-Millisekunden, so
 * wie entryTs in signals_log.json) die Umfeldzeile des passenden Handelstags
 * finden. Faellt der Zeitpunkt auf ein Wochenende oder einen Feiertag, wird
 * der letzte Handelstag davor genommen - bis zu `maxRueck` Tage zurueck.
 *
 * Bewusst hier und nicht in der Engine: diese Funktion liest nur. */
function zeileZuZeitpunkt(historie, epochMs, maxRueck) {
  const grenze = typeof maxRueck === "number" ? maxRueck : 5;
  const d = new Date(epochMs);
  if (!isFinite(d.getTime())) return null;
  for (let i = 0; i <= grenze; i++) {
    const tag = new Date(d.getTime() - i * 86400000).toISOString().slice(0, 10);
    if (historie[tag]) return historie[tag];
  }
  return null;
}

module.exports = { DATEI, baueZeile, schreibe, zeileZuZeitpunkt };

/* ===========================================================================
 * RUECKWIRKEND NACHRECHNEN
 * ===========================================================================
 * Die Historie faengt erst am 13.10.2026 an. Tiams abgeschlossene Trades
 * reichen aber bis Mitte Juli zurueck - wartet man auf neue Daten, ist die
 * Frage "laufen Signale in bestimmten Umfeldern besser" erst in Monaten
 * ueberhaupt stellbar. Yahoo liefert ein Jahr Tageskurse; damit laesst sich
 * das Umfeld jedes vergangenen Handelstags nachrechnen.
 *
 * DIE EINE REGEL, DIE HIER ALLES ENTSCHEIDET: KEIN BLICK IN DIE ZUKUNFT.
 *
 * Fuer den Tag D wird die Kursreihe hart bei D abgeschnitten und danach
 * EXAKT DIESELBEN Funktionen aufgerufen wie im Live-Betrieb. Damit kann kein
 * Wert aus der Zukunft einfliessen - weder in ein Perzentil noch in eine
 * Korrelation. Wuerde man stattdessen die volle Reihe nehmen und nur das
 * Fenster verschieben, haette der 15. Juli ein VIX-Perzentil, das September
 * schon kennt. Genau so entstehen Rueckrechnungen, die grossartig aussehen
 * und nichts wert sind.
 *
 * Was nicht nachrechenbar ist, wird auch nicht erfunden: der
 * ForexFactory-Feed enthaelt nur die laufende Woche, fuer vergangene Tage
 * gibt es keine Termine. Diese Zeilen haben darum KEIN Feld `termineHeute` -
 * nicht etwa eine 0, die man spaeter als "keine Termine" fehlliest.
 *
 * Jede nachgerechnete Zeile traegt quelle:"nachgerechnet" und die Zahl der
 * Handelstage, die ihr an Vorlauf zur Verfuegung standen.
 * ===========================================================================
 */

const MIN_VORLAUF = 120;   // Handelstage, die vor einem nachgerechneten Tag liegen muessen

function schneideAb(reihenNachSymbol, bisTs) {
  const aus = {};
  for (const s of Object.keys(reihenNachSymbol)) {
    aus[s] = reihenNachSymbol[s].filter((p) => p.ts <= bisTs);
  }
  return aus;
}

/* Baut fuer einen Stichtag dasselbe Objekt, das der Live-Lauf an baueZeile
 * uebergibt - nur eben aus abgeschnittenen Reihen. */
function standFuerTag(reihenNachSymbol, bisTs, symbolDefs, ml, kz) {
  const reihen = schneideAb(reihenNachSymbol, bisTs);

  const eintraege = [];
  for (const def of symbolDefs) {
    const r = reihen[def.symbol];
    if (!r || !r.length) { eintraege.push({ symbol: def.symbol, ok: false, grund: "keine Daten bis zum Stichtag" }); continue; }
    const letzter = r[r.length - 1];
    eintraege.push({
      symbol: def.symbol,
      ok: true,
      stand: Math.round(letzter.close * 1e4) / 1e4,
      standDatum: new Date(letzter.ts * 1000).toISOString().slice(0, 10),
    });
  }

  const sektoren = symbolDefs.filter((x) => x.gruppe === "Sektor").map((x) => ({ name: x.name, symbol: x.symbol }));
  const kennzahlen = {};
  try { kennzahlen.nervositaet = kz.nervositaet(reihen, ml.VIX_SYMBOL, ml.GEHANDELT); } catch (e) { /* Zeile bleibt ohne */ }
  try { kennzahlen.sektoren = kz.sektorRangliste(reihen, sektoren, ml.MARKT_SYMBOL); } catch (e) { /* dito */ }
  try { kennzahlen.gleichlauf = kz.gleichlauf(reihen, ml.GEHANDELT); } catch (e) { /* dito */ }
  // termine bewusst NICHT - fuer vergangene Tage gibt es den Feed nicht.

  return {
    standIso: new Date(bisTs * 1000).toISOString(),
    eintraege,
    kennzahlen,
  };
}

/* Alle Handelstage des Marktsymbols nachrechnen, die noch fehlen.
 * Bestehende Zeilen werden NICHT ueberschrieben: eine live geschriebene
 * Zeile kennt die Termine des Tages, eine nachgerechnete nicht - die
 * schlechtere darf die bessere nicht verdraengen. */
function rechneNach(ordner, reihenNachSymbol, symbolDefs, ml, kz, optionen) {
  const o = optionen || {};
  const marktReihe = reihenNachSymbol[ml.MARKT_SYMBOL] || [];
  if (marktReihe.length < MIN_VORLAUF + 5) {
    return { ok: false, grund: "Marktreihe zu kurz (" + marktReihe.length + " Tage)" };
  }

  const ziel = path.join(ordner, DATEI);
  let bestand = {};
  if (fs.existsSync(ziel)) {
    try {
      bestand = JSON.parse(fs.readFileSync(ziel, "utf8"));
    } catch (e) {
      return { ok: false, grund: "Historie nicht lesbar, NICHT angefasst: " + e.message };
    }
    if (!bestand || typeof bestand !== "object" || Array.isArray(bestand)) {
      return { ok: false, grund: "Historie hat unerwartete Form, NICHT angefasst" };
    }
  }

  const abTs = o.abIso ? Math.floor(new Date(o.abIso + "T23:59:59Z").getTime() / 1000) : 0;

  let geschrieben = 0, uebersprungenVorhanden = 0, uebersprungenVorlauf = 0;
  const geschriebeneTage = [];

  for (let i = 0; i < marktReihe.length; i++) {
    const p = marktReihe[i];
    const tag = new Date(p.ts * 1000).toISOString().slice(0, 10);
    if (p.ts < abTs) continue;
    if (bestand[tag]) { uebersprungenVorhanden++; continue; }
    if (i < MIN_VORLAUF) { uebersprungenVorlauf++; continue; }

    const daten = standFuerTag(reihenNachSymbol, p.ts, symbolDefs, ml, kz);
    const zeile = baueZeile(daten, ml.MARKT_SYMBOL);
    if (!zeile) continue;

    zeile.quelle = "nachgerechnet";
    zeile.vorlaufTage = i;
    zeile.geschriebenAm = new Date().toISOString();
    bestand[tag] = zeile;
    geschrieben++;
    geschriebeneTage.push(tag);
  }

  const sortiert = {};
  for (const k of Object.keys(bestand).sort()) sortiert[k] = bestand[k];
  fs.mkdirSync(ordner, { recursive: true });
  fs.writeFileSync(ziel, JSON.stringify(sortiert, null, 2), "utf8");

  const alle = Object.keys(sortiert);
  return {
    ok: true,
    geschrieben,
    uebersprungenVorhanden,
    uebersprungenVorlauf,
    von: geschriebeneTage[0] || null,
    bis: geschriebeneTage[geschriebeneTage.length - 1] || null,
    tageGesamt: alle.length,
    seit: alle[0],
    bytes: fs.statSync(ziel).size,
  };
}

module.exports.MIN_VORLAUF = MIN_VORLAUF;
module.exports.schneideAb = schneideAb;
module.exports.standFuerTag = standFuerTag;
module.exports.rechneNach = rechneNach;
