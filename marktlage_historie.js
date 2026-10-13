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
