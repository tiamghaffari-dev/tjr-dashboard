"use strict";
/* ===========================================================================
 * marktlage_nachrechnen.js - einmaliger Rueckwaertslauf
 * ===========================================================================
 * Holt die Jahresreihen und rechnet das Umfeld fuer jeden vergangenen
 * Handelstag nach, damit Tiams bereits abgeschlossene Trades ueberhaupt nach
 * Umfeld auswertbar werden. Ohne das waere die Frage erst in Monaten
 * stellbar.
 *
 * Streng ohne Blick in die Zukunft - siehe marktlage_historie.js. Bestehende
 * Zeilen werden nicht ueberschrieben.
 *
 * Von Hand zu starten. Laeuft er zweimal, passiert beim zweiten Mal nichts
 * ausser einer Meldung, weil alle Tage schon dastehen.
 * ===========================================================================
 */

const path = require("path");
const ml = require("./marktlage.js");
const kz = require("./marktlage_kennzahlen.js");
const hist = require("./marktlage_historie.js");

async function main() {
  console.log("Marktlage rueckwaerts nachrechnen - " + new Date().toISOString());
  console.log("=".repeat(78));

  const reihen = {};
  let fehlgeschlagen = 0;
  for (const def of ml.SYMBOLE) {
    const e = await ml.holeEintrag(def);
    if (e.ok && e.reihe) {
      reihen[def.symbol] = e.reihe;
      console.log("  " + def.symbol.padEnd(11) + String(e.reihe.length).padStart(4) + " Tage");
    } else {
      fehlgeschlagen++;
      console.log("  " + def.symbol.padEnd(11) + "FEHLER: " + (e.grund || "unbekannt"));
    }
  }

  if (fehlgeschlagen > ml.SYMBOLE.length * 0.4) {
    console.error("ABBRUCH: zu viele Symbole nicht abrufbar (" + fehlgeschlagen + ").");
    process.exitCode = 1;
    return;
  }

  const ordner = path.join(__dirname, "daten", "marktlage");
  const ab = process.argv[2] || null;   // optional: fruehestes Datum YYYY-MM-DD
  const ergebnis = hist.rechneNach(ordner, reihen, ml.SYMBOLE, ml, kz, { abIso: ab });

  console.log("=".repeat(78));
  if (!ergebnis.ok) {
    console.error("Nachrechnen fehlgeschlagen: " + ergebnis.grund);
    process.exitCode = 1;
    return;
  }
  console.log("Neu nachgerechnet: " + ergebnis.geschrieben + " Handelstage"
    + (ergebnis.von ? " (" + ergebnis.von + " bis " + ergebnis.bis + ")" : ""));
  console.log("Uebersprungen: " + ergebnis.uebersprungenVorhanden + " schon vorhanden, "
    + ergebnis.uebersprungenVorlauf + " ohne genug Vorlauf (< " + hist.MIN_VORLAUF + " Handelstage)");
  console.log("Historie jetzt: " + ergebnis.tageGesamt + " Tage seit " + ergebnis.seit
    + ", " + Math.round(ergebnis.bytes / 1024) + " KB");
}

main().catch((e) => {
  console.error("Unerwartet:", e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
