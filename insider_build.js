"use strict";
/*
 * insider_build.js - taeglicher Lauf fuer die Insider-Beobachtung.
 *
 * Laeuft BEWUSST getrennt von build.js:
 *  - andere Taktung (einmal taeglich statt alle 5 Minuten - SEC meldet nur werktags)
 *  - ein Fehler hier darf den TJR-Report nie kippen
 *  - keine gemeinsame Zustandsdatei
 *
 * Aufruf:  node insider_build.js [tageZurueck]
 */

const fs = require("fs");
const path = require("path");
const ins = require("./insider.js");

const BASIS = __dirname;
const TAGE_ZURUECK = Number(process.argv[2] || process.env.INSIDER_TAGE || 4);

function jetztText() {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

async function main() {
  console.log(`Insider-Lauf, ${TAGE_ZURUECK} Tage zurueck ...`);

  let ergebnis;
  try {
    ergebnis = await ins.sammle(TAGE_ZURUECK);
  } catch (e) {
    console.error("Sammeln fehlgeschlagen:", e.message);
    process.exitCode = 1;
    return;
  }

  const { gefunden, angesehen, fehler } = ergebnis;
  console.log(`  ${angesehen} Form-4-Meldungen angesehen`);
  console.log(`  ${gefunden.length} echte Kaeufe ueber ${ins.MIN_KAUF_USD} USD`);
  if (fehler.length) console.log(`  ${fehler.length} Fehler (erste 3): ${fehler.slice(0, 3).join(" | ")}`);

  let neu = 0;
  try {
    neu = ins.archiviere(BASIS, gefunden);
    console.log(`  ${neu} neue Zeilen archiviert`);
  } catch (e) {
    console.error("Archivieren fehlgeschlagen:", e.message);
  }

  const gruppen = ins.buendle(gefunden);
  console.log(`  ${gruppen.length} Firmen, davon ${gruppen.filter((g) => g.anzahlInsider > 1).length} mit mehreren Insidern`);

  const daten = {
    stand: jetztText(),
    tageZurueck: TAGE_ZURUECK,
    angesehen,
    schwelle: ins.MIN_KAUF_USD,
    fehlerAnzahl: fehler.length,
    gruppen: gruppen.map((g) => ({
      symbol: g.symbol, firma: g.firma, anzahlInsider: g.anzahlInsider,
      insider: g.insider, summe: g.summe, kaeufe: g.kaeufe,
      frueheste: g.frueheste, spaeteste: g.spaeteste,
      maxVerzoegerung: g.maxVerzoegerung,
      belege: g.belege.map((b) => ({ quelle: b.quelle })).slice(0, 1),
    })),
  };

  const vorlage = fs.readFileSync(path.join(BASIS, "docs", "insider_template.html"), "utf8");
  const seite = vorlage.replace("__DATA__", JSON.stringify(daten));
  fs.writeFileSync(path.join(BASIS, "docs", "insider.html"), seite);
  console.log(`  docs/insider.html geschrieben (${seite.length} Zeichen)`);
}

main().catch((e) => {
  console.error("Unerwartet:", e);
  process.exitCode = 1;
});
