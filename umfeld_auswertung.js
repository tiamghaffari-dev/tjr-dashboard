"use strict";
/* ===========================================================================
 * umfeld_auswertung.js
 * ===========================================================================
 * Beantwortet Tiams Frage: laufen Signale in bestimmten Umfeldern besser?
 *
 * Methode wie bei R9/R10: Erwartungswert in R je Gruppe, mit Standardfehler.
 * Ein Unterschied zaehlt erst, wenn er die Streuung ueberlebt.
 *
 * Laeuft rein lesend und ohne Netz: signals_log.json und
 * daten/marktlage/historie.json liegen beide im Repo.
 *   node umfeld_auswertung.js
 *
 * Die Beobachtungs-Trades sind hier NICHT Beiwerk, sondern die wichtigste
 * Kontrolle: sie sind viermal so zahlreich wie die offiziellen. Zeigt sich ein
 * Effekt nur in der kleinen Gruppe und kippt in der grossen sogar die
 * Richtung, ist er Rauschen - egal wie gut die Standardfehler aussehen.
 * ===========================================================================
 */

const path = require("path");
const h = require("./marktlage_historie.js");
const log = require("./signals_log.json");
const historie = JSON.parse(
  require("fs").readFileSync(path.join(__dirname, "daten", "marktlage", "historie.json"), "utf8")
);

const Y = { BTCUSD:"BTC-USD", ETHUSD:"ETH-USD", XRPUSD:"XRP-USD",
            GBPUSD:"GBPUSD=X", "^GSPC":"^GSPC", GCUSD:"GC=F" };

function mittel(a){ return a.reduce((x,y)=>x+y,0)/a.length; }
function stdabw(a){ if(a.length<2) return null; const m=mittel(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
function ew(rs){
  if(!rs.length) return null;
  const m=mittel(rs), s=stdabw(rs);
  return { n:rs.length, ew:m, se: s===null?null:s/Math.sqrt(rs.length),
           trefferquote: rs.filter(r=>r>0).length/rs.length };
}
function z(a,b){
  if(!a||!b||a.se==null||b.se==null) return null;
  const se=Math.sqrt(a.se*a.se+b.se*b.se);
  return se>0 ? (a.ew-b.ew)/se : null;
}
const f=(x,n)=> x===null||x===undefined ? "  -  " : x.toFixed(n===undefined?2:n);

function zeige(titel, gruppen) {
  const belegt = Object.keys(gruppen).filter((k) => gruppen[k].length > 0);
  if (belegt.length < 2) {
    console.log("\n" + (titel || "") + "\n  Nur " + belegt.length
      + " belegte Gruppe - ohne Vergleichsgruppe nicht auswertbar.");
    return;
  }
  if (titel) console.log("\n" + titel);
  console.log("  " + "Gruppe".padEnd(30) + "n".padStart(5) + "EW (R)".padStart(10)
    + "Std.fehler".padStart(12) + "Treffer".padStart(10));
  const namen = Object.keys(gruppen).filter(k => gruppen[k].length > 0);
  for (const k of namen) {
    const e = ew(gruppen[k]);
    console.log("  " + k.padEnd(30) + String(e.n).padStart(5) + f(e.ew).padStart(10)
      + ("+/-" + f(e.se)).padStart(12) + (Math.round(e.trefferquote*100) + " %").padStart(10));
  }
  // Paarvergleiche
  for (let i=0;i<namen.length;i++) for (let j=i+1;j<namen.length;j++) {
    const a=ew(gruppen[namen[i]]), b=ew(gruppen[namen[j]]);
    const zz=z(a,b);
    if (zz===null) continue;
    const diff=a.ew-b.ew, se=Math.sqrt(a.se*a.se+b.se*b.se);
    const urteil = Math.abs(zz)>=2 ? "ueberlebt die Streuung"
                 : Math.abs(zz)>=1 ? "innerhalb der Streuung (schwach)"
                 : "nicht unterscheidbar";
    console.log("    " + (namen[i]+" vs "+namen[j]).padEnd(44)
      + ("Delta " + (diff>0?"+":"") + f(diff) + " R").padStart(16)
      + (" +/-" + f(se)).padStart(10) + "   " + f(Math.abs(zz),1) + " SE   " + urteil);
  }
}

// --- Datensatz zusammenstellen ---
const alle = log.filter(s => (s.status==="win"||s.status==="loss") && typeof s.rMultiple==="number");
const offiziell = alle.filter(s => !s.beobachtung);
const beobachtet = alle.filter(s => s.beobachtung);

console.log("=".repeat(92));
console.log("UMFELD-AUSWERTUNG  -  " + new Date().toISOString().slice(0,16).replace("T"," ") + " UTC");
console.log("=".repeat(92));
console.log("Abgeschlossene Trades gesamt: " + alle.length
  + "  |  davon offiziell (im Handelsfenster): " + offiziell.length
  + "  |  Beobachtung: " + beobachtet.length);

function umfeldVon(s) {
  if (s.umfeld) return { zeile: s.umfeld, quelle: "im Log" };
  const z = h.zeileZuZeitpunkt(historie, s.entryTs);
  if (!z) return null;
  const y = Y[s.asset];
  return { zeile: {
    handelstag: z.handelstag, quelle: z.quelle || "live",
    vix: z.vix, vixPerzentil: z.vixPerzentil,
    schwankung: y && z.schwankung ? z.schwankung[y] : null,
    schwankungStufe: y && z.schwankungStufe ? z.schwankungStufe[y] : null,
    sektorAllesRauschen: z.sektorAllesRauschen,
    termineHeute: typeof z.termineHeute === "number" ? z.termineHeute : null,
  }, quelle: "nachtraeglich zugeordnet" };
}

function analysiere(menge, titel) {
  console.log("\n" + "=".repeat(92));
  console.log(titel + "  (" + menge.length + " Trades)");
  console.log("=".repeat(92));

  const mitUmfeld = [], ohneUmfeld = [];
  for (const s of menge) {
    const u = umfeldVon(s);
    if (u) mitUmfeld.push({ s, u: u.zeile }); else ohneUmfeld.push(s);
  }
  console.log("Mit Umfelddaten: " + mitUmfeld.length + "  |  OHNE Umfelddaten: " + ohneUmfeld.length
    + (ohneUmfeld.length ? "  <- zaehlen NICHT als neutrales Umfeld, sie fehlen einfach" : ""));
  if (mitUmfeld.length < 10) { console.log("Zu wenig fuer eine Auswertung."); return; }

  const gesamt = ew(mitUmfeld.map(x=>x.s.rMultiple));
  console.log("\nGesamt: EW " + f(gesamt.ew) + " R  +/-" + f(gesamt.se)
    + "   Trefferquote " + Math.round(gesamt.trefferquote*100) + " %");

  // 1) Schwankungsbreite des gehandelten Werts
  const g1 = { "ruhiger als ueblich":[], "im ueblichen Bereich":[], "unruhiger als ueblich":[] };
  for (const x of mitUmfeld) {
    const k = { niedrig:"ruhiger als ueblich", rauschen:"im ueblichen Bereich", hoch:"unruhiger als ueblich" }[x.u.schwankungStufe];
    if (k) g1[k].push(x.s.rMultiple);
  }
  zeige("1) Nach Schwankungsbreite des gehandelten Werts", g1);

  // 2) VIX-Perzentil
  const g2 = { "VIX ruhig (Perz. <33)":[], "VIX mittel (33-66)":[], "VIX hoch (>66)":[] };
  for (const x of mitUmfeld) {
    const p = x.u.vixPerzentil;
    if (typeof p !== "number") continue;
    g2[p<33 ? "VIX ruhig (Perz. <33)" : p<=66 ? "VIX mittel (33-66)" : "VIX hoch (>66)"].push(x.s.rMultiple);
  }
  zeige("2) Nach VIX-Perzentil (Nervositaet des Gesamtmarkts)", g2);

  // 3) Sektorlage
  const g3 = { "Sektoren unterscheidbar":[], "Sektoren alles Rauschen":[] };
  for (const x of mitUmfeld) {
    if (x.u.sektorAllesRauschen === true) g3["Sektoren alles Rauschen"].push(x.s.rMultiple);
    else if (x.u.sektorAllesRauschen === false) g3["Sektoren unterscheidbar"].push(x.s.rMultiple);
  }
  zeige("3) Nach Sektorlage", g3);

  // 4) Termine - nur dort, wo bekannt
  const mitTermin = mitUmfeld.filter(x => typeof x.u.termineHeute === "number");
  console.log("\n4) Nach anstehenden Terminen");
  if (mitTermin.length < 10) {
    console.log("  Nur " + mitTermin.length + " Trades mit bekanntem Terminstand - nicht auswertbar.");
    console.log("  Grund: fuer nachgerechnete Tage gibt es keinen Terminfeed. Das wird sich mit");
    console.log("  jedem weiteren Handelstag von selbst bessern, rueckwirkend nicht.");
  } else {
    const g4 = { "ohne Termine":[], "mit Terminen":[] };
    for (const x of mitTermin) g4[x.u.termineHeute>0 ? "mit Terminen" : "ohne Termine"].push(x.s.rMultiple);
    zeige("", g4);
  }
}

analysiere(offiziell, "OFFIZIELLE TRADES (im Handelsfenster)");
if (beobachtet.length >= 20) analysiere(beobachtet, "BEOBACHTUNGS-TRADES (ausserhalb des Fensters, zaehlen nie zur Bilanz)");

/* ---------------------------------------------------------------------------
 * GEGENPROBE
 * Fuer jede Einteilung dieselbe Frage in BEIDEN Mengen stellen. Ein echter
 * Effekt muesste in der viermal groesseren Beobachtungsmenge mindestens in
 * dieselbe Richtung zeigen. Kippt die Richtung, ist der Befund erledigt -
 * genau an dieser Stelle waere im Projekt schon einmal fast eine Regel aus
 * Rauschen entstanden ("Entry zu frueh").
 * ------------------------------------------------------------------------- */
function richtung(menge, stufeA, stufeB) {
  const a = [], b = [];
  for (const s of menge) {
    const u = umfeldVon(s);
    if (!u) continue;
    if (u.zeile.schwankungStufe === stufeA) a.push(s.rMultiple);
    if (u.zeile.schwankungStufe === stufeB) b.push(s.rMultiple);
  }
  const ea = ew(a), eb = ew(b);
  if (!ea || !eb) return null;
  return { delta: ea.ew - eb.ew, na: ea.n, nb: eb.n,
           se: Math.sqrt(ea.se*ea.se + eb.se*eb.se) };
}

console.log("\n" + "=".repeat(92));
console.log("GEGENPROBE: zeigt der auffaelligste Befund in beiden Mengen dieselbe Richtung?");
console.log("=".repeat(92));
const ro = richtung(offiziell, "niedrig", "hoch");
const rb = richtung(beobachtet, "niedrig", "hoch");
if (ro && rb) {
  console.log("  ruhiger minus unruhiger, offizielle Trades : "
    + (ro.delta>0?"+":"") + f(ro.delta) + " R  +/-" + f(ro.se) + "   (n " + ro.na + " / " + ro.nb + ")");
  console.log("  ruhiger minus unruhiger, Beobachtungen     : "
    + (rb.delta>0?"+":"") + f(rb.delta) + " R  +/-" + f(rb.se) + "   (n " + rb.na + " / " + rb.nb + ")");
  const gleicheRichtung = (ro.delta > 0) === (rb.delta > 0);
  console.log("\n  " + (gleicheRichtung
    ? "Gleiche Richtung in beiden Mengen - der Befund haelt dieser Pruefung stand."
    : "GEGENLAEUFIG. In der viermal groesseren Menge zeigt derselbe Vergleich in die"));
  if (!gleicheRichtung) {
    console.log("  andere Richtung. Ein Effekt, der das tut, ist keiner - das ist Rauschen,");
    console.log("  das in der kleinen Menge zufaellig ordentlich aussieht.");
  }
}

console.log("\n" + "=".repeat(92));
console.log("WICHTIG ZUR LESART");
console.log("=".repeat(92));
console.log("Hier wurden mehrere Einteilungen an denselben Daten durchprobiert. Je mehr man");
console.log("probiert, desto wahrscheinlicher sieht EINE davon zufaellig gut aus. Ein Unterschied");
console.log("von 2 Standardfehlern ist bei einer einzelnen Frage auffaellig - bei acht Vergleichen");
console.log("ist ungefaehr einer davon reiner Zufall. Nichts hiervon ist eine Regel.");
