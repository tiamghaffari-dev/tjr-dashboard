"use strict";
/* ===========================================================================
 * marktlage_ereignisse.js - Chronik: was ist passiert, und was hat sich
 *                           daraufhin MESSBAR bewegt
 * ===========================================================================
 * Tiam, 15.11.2026, zur Spionageaffaere um den Nvidia-Chef: "Solche Sachen
 * solltest du auch beobachten, vielleicht kurz aufschreiben, so was passiert
 * ist, weil das ist halt was sehr Grosses."
 *
 * Stimmt - und genau dieser Anlass zeigt auch, warum das Aufschreiben so und
 * nicht anders gebaut ist. Tiams eigene Erklaerung dazu lautete: Affaere ->
 * Nvidia faellt -> der ganze Markt faellt -> deshalb faellt Bitcoin. Die
 * Kurse sagen etwas anderes: Nvidia fiel schon gut eine Woche VOR der
 * Meldung, am Tag der Meldung stieg die Aktie sogar, und waehrend Nvidia
 * danach weiter verlor, legte AMD im selben Zeitraum um rund 32 Prozent zu.
 * Die Geschichte klang zwingend und war trotzdem falsch.
 *
 * Deshalb macht dieses Modul genau zwei Dinge, und das dritte ausdruecklich
 * nicht:
 *   1. Es haelt fest, WAS passiert ist - mit Datum und Quelle, von Hand
 *      gepflegt in daten/marktlage/ereignisse.json.
 *   2. Es misst, was sich rund um dieses Datum tatsaechlich bewegt hat, und
 *      vergleicht das mit dem, was dieser Wert ohnehin an einem normalen Tag
 *      macht. Nur was aus dem gewohnten Rahmen faellt, wird als auffaellig
 *      bezeichnet.
 *   3. Es behauptet NIE, dass das Ereignis die Bewegung verursacht hat.
 *      Daneben stehen bewusst auch die Werte, die sich NICHT bewegt haben -
 *      die entlarven eine zu grosse Erzaehlung am schnellsten.
 *
 * Dazu kommt die Gegenrichtung: auffaelligeTage() findet Tage, an denen
 * ungewoehnlich viel passiert ist, OHNE dass jemand ein Ereignis eingetragen
 * hat. Das laeuft von allein weiter und sammelt mit der Zeit genau die
 * Datengrundlage, mit der sich irgendwann pruefen laesst, ob Ereignisse
 * ueberhaupt etwas vorhersagen. Heute laesst sich das nicht pruefen - dafuer
 * sind es viel zu wenige.
 *
 * Keine Prognose. Keine Empfehlung. Keine Verbindung zur TJR-Engine: dieses
 * Modul wird von engine.js und build.js weder geladen noch gelesen.
 * ===========================================================================
 */

const fs = require("fs");
const path = require("path");

const EREIGNIS_DATEI = path.join(__dirname, "daten", "marktlage", "ereignisse.json");

// Fenster fuer "was ist normal": ein halbes Jahr Handelstage.
const NORMAL_FENSTER = 126;
// Ab wie vielen typischen Tagesbewegungen heisst eine Bewegung auffaellig.
// 3 ist streng genug, dass nicht jeder zweite Tag aufleuchtet.
const SCHWELLE = 3;
// Wie viele KALENDERTAGE nach einem Ereignis gemessen werden.
// Bewusst Kalender- und nicht Handelstage: Krypto handelt sieben Tage die
// Woche, Aktien fuenf. Bei "5 Handelstage" haette Bitcoin eine Woche, Nvidia
// aber neun Kalendertage abgedeckt - zwei verschieden lange Zeitraeume, deren
// Prozentzahlen man nebeneinander nicht vergleichen darf. Mit Kalendertagen
// misst jeder Wert dieselbe Spanne; wie viele Handelstage das fuer ihn waren,
// steht bei jedem Eintrag dabei und geht in sein Normalmass ein.
const NACHLAUF = 7;

function runde(x, n) {
  if (x === null || x === undefined || !isFinite(x)) return null;
  const f = Math.pow(10, n);
  return Math.round(x * f) / f;
}

function tagIso(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/* Robustes Mass fuer "was macht dieser Wert an einem normalen Tag".
 * Bewusst der Median der absoluten Abweichungen statt der Standardabweichung:
 * ein einzelner Crash-Tag wuerde die Standardabweichung so aufblaehen, dass
 * danach gar nichts mehr auffaellig waere - ausgerechnet das Ereignis wuerde
 * sich also selbst unsichtbar machen. Der Faktor 1,4826 rechnet den Median
 * auf das um, was bei einer Normalverteilung die Standardabweichung waere. */
function typischeTagesbewegung(renditen) {
  if (!renditen || renditen.length < 20) return null;
  const med = median(renditen);
  const abw = renditen.map((r) => Math.abs(r - med));
  const m = median(abw);
  return m > 0 ? m * 1.4826 : null;
}

function median(a) {
  if (!a || !a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* Reihe in ein nach Datum durchsuchbares Format bringen. */
function alsTabelle(reihe) {
  const t = new Map();
  for (const p of reihe) {
    if (!p || !isFinite(p.close)) continue;
    t.set(tagIso(p.ts), p.close);
  }
  return t;
}

function tageSortiert(tab) {
  return [...tab.keys()].sort();
}

/* ---------------------------------------------------------------------------
 * Bewegung eines Wertes rund um ein Datum, gemessen am eigenen Normalmass.
 * ------------------------------------------------------------------------- */
function bewegungUm(reihe, datum, nachlauf) {
  const tab = alsTabelle(reihe);
  const tage = tageSortiert(tab);
  if (tage.length < 30) return null;

  // Letzter Handelstag VOR dem Ereignis (das Ereignis selbst zaehlt schon mit).
  let i = tage.findIndex((d) => d >= datum);
  if (i <= 0) return null;                       // Ereignis vor Reihenbeginn
  const vorTag = tage[i - 1];
  // Letzter vorhandener Handelstag innerhalb des Kalenderfensters.
  const zielDatum = new Date(Date.parse(datum + "T00:00:00Z") + nachlauf * 86400000)
    .toISOString().slice(0, 10);
  let bis = i - 1;
  while (bis + 1 < tage.length && tage[bis + 1] <= zielDatum) bis++;
  if (bis <= i - 1) return null;                 // noch keine Tage danach
  const bisTag = tage[bis];

  const a = tab.get(vorTag), b = tab.get(bisTag);
  if (!isFinite(a) || !isFinite(b) || a <= 0) return null;
  const veraenderung = ((b / a) - 1) * 100;

  // Normalmass aus den Tagen VOR dem Ereignis - sonst flosse die Reaktion
  // selbst in den Massstab ein, an dem sie gemessen wird.
  const vorher = tage.slice(Math.max(0, i - 1 - NORMAL_FENSTER), i);
  const rend = [];
  for (let k = 1; k < vorher.length; k++) {
    const x = tab.get(vorher[k - 1]), y = tab.get(vorher[k]);
    if (x > 0 && y > 0) rend.push(Math.log(y / x));
  }
  const typisch = typischeTagesbewegung(rend);
  if (typisch === null) return null;

  // Ueber mehrere Tage waechst die gewohnte Schwankung mit der Wurzel der Zeit.
  const tageGezaehlt = bis - (i - 1);
  const gewohnt = typisch * Math.sqrt(tageGezaehlt) * 100;
  const vielfaches = gewohnt > 0 ? Math.abs(veraenderung) / gewohnt : null;

  return {
    vonTag: vorTag,
    bisTag,
    tage: tageGezaehlt,
    veraenderung: runde(veraenderung, 2),
    gewohnt: runde(gewohnt, 2),
    vielfaches: runde(vielfaches, 2),
    auffaellig: vielfaches !== null && vielfaches >= 2,
  };
}

/* ---------------------------------------------------------------------------
 * Ein eingetragenes Ereignis auswerten.
 * ------------------------------------------------------------------------- */
function ereignisAuswerten(e, reihen, symbole) {
  const treffer = [];
  for (const s of symbole) {
    const r = reihen[s.symbol];
    if (!r || r.length < 40) continue;
    const b = bewegungUm(r, e.datum, e.nachlauf || NACHLAUF);
    if (!b) continue;
    treffer.push({ symbol: s.symbol, name: s.name || s.symbol, gruppe: s.gruppe, ...b });
  }
  if (!treffer.length) {
    return { ...e, ok: false, grund: "keine Kursreihe deckt dieses Datum ab" };
  }

  treffer.sort((a, b) => (b.vielfaches || 0) - (a.vielfaches || 0));
  const bewegt = treffer.filter((t) => t.auffaellig);
  const ruhig = treffer.filter((t) => !t.auffaellig);

  // Der Satz beschreibt ausschliesslich, WAS sich bewegt hat. Dass das
  // Ereignis die Ursache war, steht hier bewusst nicht - siehe Kopfkommentar.
  let satz;
  if (!bewegt.length) {
    satz = "In den " + (e.nachlauf || NACHLAUF) + " Tagen danach hat sich kein verfolgter Wert "
      + "stärker bewegt als in einem gewöhnlichen Zeitraum dieser Länge.";
  } else {
    const spitze = bewegt.slice(0, 3).map((t) => t.name + " "
      + (t.veraenderung > 0 ? "+" : "") + String(t.veraenderung).replace(".", ",") + " %").join(", ");
    satz = bewegt.length + " von " + treffer.length + " verfolgten Werten bewegten sich in den "
      + (e.nachlauf || NACHLAUF) + " Tagen danach stärker als gewohnt: " + spitze + ".";
  }

  return {
    ...e,
    ok: true,
    satz,
    bewegt: bewegt.slice(0, 8),
    ruhig: ruhig.slice(0, 6).map((t) => ({ name: t.name, veraenderung: t.veraenderung })),
    anzahlGeprueft: treffer.length,
    niemals: "Das ist gemessen, nicht erklärt. Dass dieses Ereignis die Bewegung ausgelöst hat, "
      + "steht hier ausdrücklich nicht - an jedem Tag passiert vieles gleichzeitig. Die ruhig "
      + "gebliebenen Werte stehen bewusst daneben: sie zeigen am schnellsten, wenn eine "
      + "Erklärung zu weit greift.",
  };
}

/* ---------------------------------------------------------------------------
 * Die Gegenrichtung: Tage finden, an denen ungewoehnlich viel passiert ist,
 * ohne dass jemand etwas eingetragen hat. Laeuft von allein weiter.
 * ------------------------------------------------------------------------- */
function auffaelligeTage(reihen, symbole, tageZurueck) {
  const proTag = new Map();

  for (const s of symbole) {
    const r = reihen[s.symbol];
    if (!r || r.length < 40) continue;
    const tab = alsTabelle(r);
    const tage = tageSortiert(tab);
    if (tage.length < 40) continue;

    const rend = [];
    for (let k = 1; k < tage.length; k++) {
      const x = tab.get(tage[k - 1]), y = tab.get(tage[k]);
      if (x > 0 && y > 0) rend.push({ tag: tage[k], r: Math.log(y / x) });
    }
    const typisch = typischeTagesbewegung(rend.slice(-NORMAL_FENSTER).map((o) => o.r));
    if (typisch === null) continue;

    for (const o of rend.slice(-tageZurueck)) {
      const vielfaches = Math.abs(o.r) / typisch;
      if (vielfaches < SCHWELLE) continue;
      if (!proTag.has(o.tag)) proTag.set(o.tag, []);
      proTag.get(o.tag).push({
        name: s.name || s.symbol,
        symbol: s.symbol,
        gruppe: s.gruppe,
        veraenderung: runde((Math.exp(o.r) - 1) * 100, 2),
        vielfaches: runde(vielfaches, 1),
      });
    }
  }

  const liste = [...proTag.entries()]
    .map(([tag, werte]) => {
      werte.sort((a, b) => b.vielfaches - a.vielfaches);
      return {
        tag,
        anzahl: werte.length,
        werte: werte.slice(0, 6),
        satz: werte.length === 1
          ? werte[0].name + " bewegte sich um das " + String(werte[0].vielfaches).replace(".", ",")
            + "-fache einer gewöhnlichen Tagesbewegung."
          : werte.length + " Werte bewegten sich um mehr als das " + SCHWELLE
            + "-fache einer gewöhnlichen Tagesbewegung.",
      };
    })
    .sort((a, b) => (a.tag < b.tag ? 1 : -1));

  return liste.slice(0, 12);
}

/* ------------------------------------------------------------------------- */
function laden() {
  try {
    const roh = JSON.parse(fs.readFileSync(EREIGNIS_DATEI, "utf8"));
    const liste = Array.isArray(roh) ? roh : (roh.ereignisse || []);
    return liste.filter((e) => e && e.datum && e.titel);
  } catch (e) {
    return [];
  }
}

function alle(reihen, symbole, tageZurueck) {
  const eingetragen = laden();
  const aus = { eingetragen: [], auffaellig: [], quelleDatei: "daten/marktlage/ereignisse.json" };

  try {
    aus.eingetragen = eingetragen
      .slice()
      .sort((a, b) => (a.datum < b.datum ? 1 : -1))
      .slice(0, 10)
      .map((e) => {
        try {
          return ereignisAuswerten(e, reihen, symbole);
        } catch (err) {
          return { ...e, ok: false, grund: String(err && err.message ? err.message : err).slice(0, 120) };
        }
      });
  } catch (err) {
    aus.eingetragenFehler = String(err && err.message ? err.message : err).slice(0, 150);
  }

  try {
    aus.auffaellig = auffaelligeTage(reihen, symbole, tageZurueck || 90);
  } catch (err) {
    aus.auffaelligFehler = String(err && err.message ? err.message : err).slice(0, 150);
  }

  return aus;
}

module.exports = {
  alle, laden, ereignisAuswerten, auffaelligeTage, bewegungUm,
  typischeTagesbewegung, SCHWELLE, NACHLAUF, NORMAL_FENSTER,
};
