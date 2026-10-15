"use strict";
/* ===========================================================================
 * marktlage_build.js - Etappe 1 des Marktlage-Bereichs
 * ===========================================================================
 * Laeuft BEWUSST getrennt von build.js, nach demselben Muster wie
 * insider_build.js:
 *   - andere Taktung: Tageskurse, einmal pro Werktag genuegt. Der TJR-Report
 *     laeuft alle 5 Minuten - das waeren ueber 7000 unnoetige Abrufe am Tag.
 *   - eigene concurrency-Gruppe, damit sich die Laeufe nicht blockieren.
 *   - keine gemeinsame Zustandsdatei, kein gemeinsames Modul mit der Engine.
 *     Dieses Skript laedt engine.js nicht, und engine.js laedt marktlage.js
 *     nicht. Ein Fehler hier kann den TJR-Report nicht kippen.
 *
 * Aufruf:  node marktlage_build.js
 *
 * SCHREIBSCHUTZ: faellt Yahoo aus oder liefert die Haelfte der Symbole nichts,
 * wird die Seite NICHT ueberschrieben. Dann bleibt die letzte gute Version
 * stehen, statt dass eine leere Tabelle die alte ersetzt. Das Skript endet
 * in diesem Fall mit Fehlercode, der Workflow committet nichts.
 * ===========================================================================
 */

const fs = require("fs");
const path = require("path");
const ml = require("./marktlage.js");
const kz = require("./marktlage_kennzahlen.js");
const hist = require("./marktlage_historie.js");

const BASIS = __dirname;
const MIN_ANTEIL_OK = 0.6;   // weniger als 60 % brauchbar -> Seite nicht anfassen

function jetztText() {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/* JSON landet in einem <script>-Block. Die Namen und Symbole kommen aus der
 * eigenen Liste, die Fehlertexte aber von Yahoo - also von aussen. Ein "<"
 * darin wuerde die Seite zerlegen, deshalb wird es maskiert. */
function sicheresJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    // U+2028 / U+2029 sind in JavaScript-Quelltext Zeilentrenner und wuerden
    // den <script>-Block zerlegen. In JSON sind sie erlaubt, also hier raus.
    .replace(new RegExp("[\\u2028\\u2029]", "g"),
      (c) => c.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029");
}

function symboltestDatum() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(BASIS, "marktlage_symbole.json"), "utf8"));
    return j.geprueft || null;
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Wie weit ist die Umfeld-Auswertung?
 *
 * Die Schwellen sind nicht gegriffen:
 *  - 200 abgeschlossene Trades ist Tiams eigenes Ziel. Der Standardfehler des
 *    Erwartungswerts faellt damit von rund 0,12 auf 0,09 - und die kleinste
 *    Untergruppe (bei der ersten Auswertung n=15) waechst auf etwa 26. Erst
 *    dann hat ein mittelgrosser Unterschied ueberhaupt eine Chance aufzufallen.
 *  - 30 Trades mit BEKANNTEM Terminstand sind das Minimum, um ueberhaupt in
 *    zwei Gruppen zu teilen. Rueckwirkend geht das nicht, weil es fuer
 *    nachgerechnete Tage keinen Terminfeed gibt - diese Zahl waechst nur mit
 *    neuen Handelstagen.
 * ------------------------------------------------------------------------- */
const ZIEL_TRADES = 200;
const ZIEL_TERMINE = 30;

function baueAuswertungsstand() {
  const hist = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(BASIS, "daten", "marktlage", "historie.json"), "utf8"));
    } catch (e) { return null; }
  })();
  if (!hist) return null;

  let log;
  try {
    log = JSON.parse(fs.readFileSync(path.join(BASIS, "signals_log.json"), "utf8"));
  } catch (e) {
    return null;
  }
  if (!Array.isArray(log)) return null;

  const fertig = log.filter((s) =>
    (s.status === "win" || s.status === "loss") && typeof s.rMultiple === "number" && !s.beobachtung);

  let mitUmfeld = 0, mitTermin = 0;
  for (const s of fertig) {
    const zeile = s.umfeld || hist_zeile(hist, s.entryTs);
    if (!zeile) continue;
    mitUmfeld++;
    const t = s.umfeld ? s.umfeld.termineHeute : zeile.termineHeute;
    if (typeof t === "number") mitTermin++;
  }

  let letzte = null;
  try {
    letzte = JSON.parse(fs.readFileSync(path.join(BASIS, "daten", "marktlage", "auswertung_stand.json"), "utf8"));
  } catch (e) { /* noch nie gelaufen */ }

  return {
    trades: mitUmfeld,
    zielTrades: ZIEL_TRADES,
    mitTerminen: mitTermin,
    zielTermine: ZIEL_TERMINE,
    bereit: mitUmfeld >= ZIEL_TRADES,
    termineBereit: mitTermin >= ZIEL_TERMINE,
    letzte,
  };
}

function hist_zeile(hist, epochMs) {
  try {
    return hist && typeof epochMs === "number" ? requireHist().zeileZuZeitpunkt(hist, epochMs) : null;
  } catch (e) { return null; }
}
let _histModul = null;
function requireHist() {
  if (!_histModul) _histModul = require("./marktlage_historie.js");
  return _histModul;
}

async function main() {
  console.log("Marktlage-Lauf, " + ml.SYMBOLE.length + " Werte ...");

  const eintraege = await ml.sammle();

  const ok = eintraege.filter((e) => e.ok);
  const kaputt = eintraege.filter((e) => !e.ok);
  const alt = ok.filter((e) => e.veraltet);

  for (const e of eintraege) {
    if (e.ok) {
      console.log(
        "  OK  " + e.symbol.padEnd(11) + e.name.padEnd(20)
        + String(e.stand).padStart(12) + " " + String(e.waehrung || e.einheit || "").padEnd(4)
        + " vom " + e.standDatum
        + "  Tag " + String(e.tag === null ? "-" : e.tag).padStart(7)
        + "  Woche " + String(e.woche === null ? "-" : e.woche).padStart(7)
        + "  Monat " + String(e.monat === null ? "-" : e.monat).padStart(7)
        + "  Jahr " + String(e.jahr === null ? "-" : e.jahr).padStart(8)
        + (e.veraltet ? "   [ALT]" : "")
        + (e.versuche > 1 ? "   [" + e.versuche + " Versuche]" : "")
      );
    } else {
      console.log("  --  " + e.symbol.padEnd(11) + e.name.padEnd(20) + "FEHLER: " + e.grund);
    }
  }

  console.log("-".repeat(78));
  console.log("Abgerufen: " + ok.length + " von " + eintraege.length
    + (kaputt.length ? "  |  fehlgeschlagen: " + kaputt.map((e) => e.symbol).join(", ") : "")
    + (alt.length ? "  |  alte Kurse: " + alt.map((e) => e.symbol).join(", ") : ""));

  if (ok.length < eintraege.length * MIN_ANTEIL_OK) {
    console.error(
      "ABBRUCH: nur " + ok.length + " von " + eintraege.length + " Werten abrufbar "
      + "(Mindestanteil " + Math.round(MIN_ANTEIL_OK * 100) + " %). "
      + "docs/marktlage.html bleibt unveraendert - die letzte gute Version ist besser "
      + "als eine halb leere Seite."
    );
    process.exitCode = 1;
    return;
  }

  /* ----------------------------------------------------------------------
   * ETAPPE 2 - Umfeld-Kennzahlen.
   *
   * Jede einzeln in try/catch: eine Kennzahl, die nicht rechenbar ist, darf
   * weder die anderen noch die Tabelle aus Etappe 1 mitreissen. Auf der Seite
   * steht dann ehrlich, dass dieser Block fehlt.
   * -------------------------------------------------------------------- */
  const reihen = {};
  for (const e of eintraege) if (e.ok && e.reihe) reihen[e.symbol] = e.reihe;

  const kennzahlen = {};

  try {
    kennzahlen.nervositaet = kz.nervositaet(reihen, ml.VIX_SYMBOL, ml.GEHANDELT);
    const n = kennzahlen.nervositaet;
    console.log("  Nervositaet: VIX " + (n.vix ? n.vix.stand + " (Perzentil " + n.vix.perzentil + ")" : "nicht verfuegbar")
      + ", " + n.werte.filter((w) => w.stufe === "rauschen").length + " von " + n.werte.length + " Werten unauffaellig");
  } catch (e) {
    kennzahlen.nervositaetFehler = String(e && e.message ? e.message : e).slice(0, 150);
    console.error("  Nervositaet fehlgeschlagen:", kennzahlen.nervositaetFehler);
  }

  try {
    const sektoren = ml.SYMBOLE.filter((x) => x.gruppe === "Sektor").map((x) => ({ name: x.name, symbol: x.symbol }));
    kennzahlen.sektoren = kz.sektorRangliste(reihen, sektoren, ml.MARKT_SYMBOL);
    const sk = kennzahlen.sektoren;
    console.log("  Sektoren: " + (sk.ok
      ? sk.zeilen.length + " verglichen, " + sk.zeilen.filter((z) => z.stufe === "rauschen").length + " davon Rauschen"
      : "nicht rechenbar - " + sk.grund));
  } catch (e) {
    kennzahlen.sektorenFehler = String(e && e.message ? e.message : e).slice(0, 150);
    console.error("  Sektoren fehlgeschlagen:", kennzahlen.sektorenFehler);
  }

  try {
    kennzahlen.gleichlauf = kz.gleichlauf(reihen, ml.GEHANDELT);
    const gl = kennzahlen.gleichlauf;
    console.log("  Gleichlauf: " + (gl.ok
      ? gl.paare.length + " Paare auf " + gl.tage + " gemeinsamen Tagen, " + gl.starkeAnzahl + " deutlich, "
        + gl.paare.filter((p) => p.stufe === "rauschen").length + " Rauschen"
      : "nicht rechenbar - " + gl.grund));
    if (gl.ok) {
      console.log("    Schnittmenge insgesamt: " + gl.gemeinsamGesamt + " Tage. Einzeln: "
        + gl.herkunft.map((h) => h.symbol + " " + h.eigeneTage + " (ohne: +" + h.ohneDiesen + ")").join(", "));
      for (const h of gl.herkunft) {
        console.log("      " + h.symbol.padEnd(10) + " Stempel " + h.stempelzeit
          + (h.fehlen ? "  | fehlende Tage nach Wochentag: " + JSON.stringify(h.fehlen.nachWochentag)
             + " | zuletzt: " + h.fehlen.beispiele.join(", ") : ""));
      }
    }
  } catch (e) {
    kennzahlen.gleichlaufFehler = String(e && e.message ? e.message : e).slice(0, 150);
    console.error("  Gleichlauf fehlgeschlagen:", kennzahlen.gleichlaufFehler);
  }

  try {
    kennzahlen.termine = await kz.termine();
    console.log("  Termine: " + kennzahlen.termine.kommende.length + " anstehend (Feed: "
      + kennzahlen.termine.gesamtImFeed + " Eintraege diese Woche)");
  } catch (e) {
    kennzahlen.termineFehler = String(e && e.message ? e.message : e).slice(0, 150);
    console.error("  Terminabruf fehlgeschlagen:", kennzahlen.termineFehler);
  }

  // Die Rohreihen wieder entfernen: sie haben ihren Zweck erfuellt und wuerden
  // stand.json um ein Jahr Kurse je Symbol aufblaehen, taeglich neu committet.
  const schlank = eintraege.map((e) => { const o = { ...e }; delete o.reihe; return o; });

  const daten = {
    stand: jetztText(),
    standIso: new Date().toISOString(),
    gruppen: ml.GRUPPEN_REIHENFOLGE,
    veraltetTage: ml.VERALTET_TAGE,
    symboltestVom: symboltestDatum(),
    anzahl: eintraege.length,
    anzahlOk: ok.length,
    eintraege: schlank,
    kennzahlen,
  };

  // Maschinenlesbarer Stand - fuer spaetere Etappen (z.B. Umfeldwerte neben
  // TJR-Signalen mitschreiben) und damit man nachvollziehen kann, was auf der
  // Seite stand, ohne HTML zu lesen.
  const datenOrdner = path.join(BASIS, "daten", "marktlage");
  fs.mkdirSync(datenOrdner, { recursive: true });
  fs.writeFileSync(path.join(datenOrdner, "stand.json"), JSON.stringify(daten, null, 2), "utf8");
  console.log("  daten/marktlage/stand.json geschrieben");

  /* ----------------------------------------------------------------------
   * STAND DER AUSWERTUNG - die Erinnerung auf der Seite.
   *
   * Tiam wollte keine Terminerinnerung, sondern eine auf der Webseite. Eine
   * nach Datum waere hier auch die schlechtere: ob sich ein neuer Durchlauf
   * lohnt, haengt nicht daran, wie viele Wochen vergangen sind, sondern wie
   * viele abgeschlossene Trades dazugekommen sind. Darum zaehlt diese
   * Anzeige Trades, nicht Tage.
   *
   * Rein lesend: signals_log.json wird nur gezaehlt, nie geschrieben.
   * -------------------------------------------------------------------- */
  let auswertung = null;
  try {
    auswertung = baueAuswertungsstand();
  } catch (e) {
    console.error("  Auswertungsstand nicht ermittelbar (egal):", e.message);
  }

  /* ----------------------------------------------------------------------
   * ETAPPE 3 - Tageszeile in die eigene Zeitreihe schreiben.
   *
   * Nach stand.json und bewusst in try/catch: schlaegt das fehl, fehlt ein
   * Tag in der Historie - die Seite selbst wird trotzdem gebaut.
   * -------------------------------------------------------------------- */
  let historie = null;
  try {
    historie = hist.schreibe(datenOrdner, daten, ml.MARKT_SYMBOL);
    console.log(historie.ok
      ? "  Historie: " + (historie.neu ? "neuer Tag " : "Tag aktualisiert ") + historie.handelstag
        + "  (" + historie.tage + " Tage seit " + historie.seit + ", "
        + Math.round(historie.bytes / 1024) + " KB)"
      : "  Historie NICHT geschrieben: " + historie.grund);
  } catch (e) {
    historie = { ok: false, grund: String(e && e.message ? e.message : e).slice(0, 150) };
    console.error("  Historie fehlgeschlagen:", historie.grund);
  }

  const vorlage = fs.readFileSync(path.join(BASIS, "docs", "marktlage_template.html"), "utf8");
  if (vorlage.indexOf("__DATA__") < 0) {
    throw new Error("Vorlage enthaelt keinen __DATA__-Platzhalter");
  }
  const seite = vorlage
    .replace("__DATA__", sicheresJson(Object.assign({}, daten, { historie, auswertung })))
    .replace(/__VERALTET_TAGE__/g, String(ml.VERALTET_TAGE));

  fs.writeFileSync(path.join(BASIS, "docs", "marktlage.html"), seite, "utf8");
  console.log("  docs/marktlage.html geschrieben (" + seite.length + " Zeichen)");
}

main().catch((e) => {
  console.error("Marktlage-Lauf fehlgeschlagen:", e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
