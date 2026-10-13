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

  const daten = {
    stand: jetztText(),
    standIso: new Date().toISOString(),
    gruppen: ml.GRUPPEN_REIHENFOLGE,
    veraltetTage: ml.VERALTET_TAGE,
    symboltestVom: symboltestDatum(),
    anzahl: eintraege.length,
    anzahlOk: ok.length,
    eintraege,
  };

  // Maschinenlesbarer Stand - fuer spaetere Etappen (z.B. Umfeldwerte neben
  // TJR-Signalen mitschreiben) und damit man nachvollziehen kann, was auf der
  // Seite stand, ohne HTML zu lesen.
  const datenOrdner = path.join(BASIS, "daten", "marktlage");
  fs.mkdirSync(datenOrdner, { recursive: true });
  fs.writeFileSync(path.join(datenOrdner, "stand.json"), JSON.stringify(daten, null, 2), "utf8");
  console.log("  daten/marktlage/stand.json geschrieben");

  const vorlage = fs.readFileSync(path.join(BASIS, "docs", "marktlage_template.html"), "utf8");
  if (vorlage.indexOf("__DATA__") < 0) {
    throw new Error("Vorlage enthaelt keinen __DATA__-Platzhalter");
  }
  const seite = vorlage
    .replace("__DATA__", sicheresJson(daten))
    .replace(/__VERALTET_TAGE__/g, String(ml.VERALTET_TAGE));

  fs.writeFileSync(path.join(BASIS, "docs", "marktlage.html"), seite, "utf8");
  console.log("  docs/marktlage.html geschrieben (" + seite.length + " Zeichen)");
}

main().catch((e) => {
  console.error("Marktlage-Lauf fehlgeschlagen:", e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
