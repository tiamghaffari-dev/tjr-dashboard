"use strict";
/* ===========================================================================
 * marktlage_verhaeltnisse.js - Kennzahlen, die aus ZWEI Werten entstehen
 * ===========================================================================
 * Tiam, 06.11.2026: "schau, ob du vielleicht bessere Daten hier einfuegen
 * kannst". Mehr Kurse allein sind keine besseren Daten - eine Zeile mehr in
 * einer Tabelle sagt nichts, was die Zeile daneben nicht auch sagt.
 *
 * Was dieses Modul macht: es setzt zwei bereits vorhandene Reihen ins
 * Verhaeltnis und beantwortet damit eine Frage, die man an keiner EINZELNEN
 * Zeile ablesen kann. Beispiel: dass der S&P 500 steigt, steht oben in der
 * Tabelle. Ob ihn alle 500 Firmen tragen oder nur sieben Riesen, steht
 * nirgends - das sagt erst der Vergleich mit dem gleichgewichteten Index.
 *
 * Die Regeln dieses Bereichs gelten hier unveraendert weiter:
 *   - keine Prognose. Nirgends steht, was als Naechstes passiert.
 *   - kein Urteil ueber Tiams Geld. Keine Empfehlung, kein "guenstig".
 *   - KEINE Verbindung zur TJR-Engine. Dieses Modul wird von engine.js und
 *     build.js weder geladen noch gelesen.
 *   - Rauschen wird als Rauschen bezeichnet, nicht huebsch gemacht. Jede
 *     Aussage muss die Zufallsbreite ueberleben (2 Standardfehler), sonst
 *     steht genau das da.
 *   - zu jeder Zahl gehoert ein Satz, was sie bedeutet, UND einer, was sie
 *     nicht bedeutet.
 * ===========================================================================
 */

const kz = require("./marktlage_kennzahlen.js");

// Fenster in Handelstagen. 63 ~ ein Quartal: kurz genug, um die aktuelle Lage
// zu zeigen, lang genug, dass ein einzelner wilder Tag nicht alles dreht.
const FENSTER = 63;

function runde(x, n) {
  if (x === null || x === undefined || !isFinite(x)) return null;
  const f = Math.pow(10, n);
  return Math.round(x * f) / f;
}

function dz(x, n) {
  const r = runde(x, n);
  return r === null ? "?" : r.toFixed(n).replace(".", ",");
}

/* ---------------------------------------------------------------------------
 * paarVergleich - das Arbeitstier.
 *
 * Misst, wie stark sich Wert A ueber das Fenster gegenueber Wert B bewegt hat,
 * und ob dieser Unterschied groesser ist, als reiner Zufall ueber denselben
 * Zeitraum erzeugt. Dieselbe Rechnung wie sektorRangliste() in
 * marktlage_kennzahlen.js, bewusst identisch, damit die Seite ueberall mit
 * demselben Massstab misst: Streuung der TAEGLICHEN Differenz, hochgerechnet
 * auf das Fenster, Grenze bei zwei Breiten.
 * ------------------------------------------------------------------------- */
function paarVergleich(reihen, symbolA, symbolB, fenster) {
  const { tage, closes } = kz.gemeinsameTage(reihen, [symbolA, symbolB]);
  if (tage.length < fenster + 2) {
    return { ok: false, grund: "zu wenige gemeinsame Handelstage (" + tage.length + " von " + (fenster + 2) + " nötig)" };
  }
  const rA = kz.renditen(closes[symbolA]).slice(-fenster);
  const rB = kz.renditen(closes[symbolB]).slice(-fenster);
  if (rA.length < fenster || rB.length < fenster) {
    return { ok: false, grund: "Reihe zu kurz nach dem Abgleich" };
  }

  const summe = (a) => (Math.exp(a.reduce((x, y) => x + y, 0)) - 1) * 100;
  const renditeA = summe(rA);
  const renditeB = summe(rB);
  const vorsprung = renditeA - renditeB;

  const diff = rA.map((x, i) => x - rB[i]);
  const tagesStreuung = kz.stdabw(diff);
  const zufallsbreite = tagesStreuung === null ? null : tagesStreuung * Math.sqrt(fenster) * 100;

  let stufe = "unbekannt";
  if (zufallsbreite !== null && zufallsbreite > 0) {
    const z = Math.abs(vorsprung) / zufallsbreite;
    stufe = z < 2 ? "rauschen" : z < 3 ? "schwach" : "deutlich";
  }

  return {
    ok: true,
    fenster,
    tage: tage.length,
    vonTag: tage[tage.length - fenster - 1],
    bisTag: tage[tage.length - 1],
    renditeA: runde(renditeA, 2),
    renditeB: runde(renditeB, 2),
    vorsprung: runde(vorsprung, 2),
    zufallsbreite: runde(zufallsbreite, 2),
    stufe,
  };
}

/* ---------------------------------------------------------------------------
 * Aus einem paarVergleich einen fertigen Kasten fuer die Seite machen.
 * `deutung` beschreibt, was ein Vorsprung von A ueber B heisst, `gegenteil`
 * das Umgekehrte. `niemals` ist der Satz, der verhindert, dass die Zahl
 * ueberdehnt wird - der steht bei JEDER Kennzahl dieses Moduls.
 * ------------------------------------------------------------------------- */
function kasten(titel, v, { nameA, nameB, nameBdat, deutung, gegenteil, niemals, frage }) {
  if (!v.ok) {
    return { titel, frage, ok: false, grund: v.grund, niemals };
  }
  const richtung = v.vorsprung >= 0 ? deutung : gegenteil;
  let satz;
  if (v.stufe === "rauschen") {
    // Hier steht nameB im Nominativ ("A und B liegen ..."), weiter unten im
    // Dativ ("vor B"). Zwei Felder statt einem, sonst kommt Kauderwelsch
    // heraus wie "Der gleichgewichtete S&P 500 und dem normalen liegen".
    satz = "Kein belastbarer Unterschied. " + nameA + " und " + nameB + " liegen über "
      + v.fenster + " Handelstage nur " + dz(Math.abs(v.vorsprung), 1) + " Prozentpunkte auseinander - "
      + "reiner Zufall erzeugt in diesem Zeitraum schon ±" + dz(2 * v.zufallsbreite, 1) + ".";
  } else {
    satz = richtung + " " + nameA + " liegt über " + v.fenster + " Handelstage "
      + dz(Math.abs(v.vorsprung), 1) + " Prozentpunkte "
      + (v.vorsprung >= 0 ? "vor " : "hinter ") + (nameBdat || nameB)
      + (v.stufe === "schwach"
        ? " - außerhalb der Zufallsbreite (±" + dz(2 * v.zufallsbreite, 1) + "), aber nicht weit. Mit Vorsicht lesen."
        : " - klar außerhalb der Zufallsbreite (±" + dz(2 * v.zufallsbreite, 1) + ").");
  }
  return {
    titel, frage, ok: true,
    nameA, nameB,
    vorsprung: v.vorsprung,
    zufallsbreite: v.zufallsbreite,
    stufe: v.stufe,
    fenster: v.fenster,
    vonTag: v.vonTag, bisTag: v.bisTag,
    satz,
    niemals,
  };
}

/* ---------------------------------------------------------------------------
 * 1) ZINSKURVE - 10 Jahre minus 3 Monate.
 *
 * Kein Paarvergleich, sondern eine Differenz zweier Renditen in
 * Prozentpunkten. Normalerweise bekommt man fuer langes Verleihen mehr Zins
 * als fuer kurzes; dreht sich das um, nennt man die Kurve invers.
 *
 * Bewusst OHNE die uebliche Rezessionserzaehlung als Aussage - die waere eine
 * Prognose. Was dasteht, ist, was gemessen wurde, und der historische
 * Zusammenhang als EINORDNUNG mit ausdruecklicher Warnung vor dem Vorlauf.
 * ------------------------------------------------------------------------- */
function zinskurve(reihen, langSymbol, kurzSymbol) {
  const { tage, closes } = kz.gemeinsameTage(reihen, [langSymbol, kurzSymbol]);
  if (tage.length < 30) {
    return { ok: false, grund: "zu wenige gemeinsame Handelstage (" + tage.length + ")" };
  }
  const lang = closes[langSymbol];
  const kurz = closes[kurzSymbol];
  const spanne = lang.map((x, i) => x - kurz[i]);
  const jetzt = spanne[spanne.length - 1];

  const vorN = (n) => (spanne.length > n ? spanne[spanne.length - 1 - n] : null);
  const vorMonat = vorN(21);
  const vorQuartal = vorN(63);
  const vorJahr = vorN(252);

  // Wie viele der verfuegbaren Tage lagen im Minus? Reine Beschreibung der
  // vorliegenden Reihe, keine Hochrechnung auf "die Geschichte".
  const invers = spanne.filter((x) => x < 0).length;

  const form = jetzt >= 0.5 ? "normal"
    : jetzt >= 0 ? "flach"
      : "invers";
  const formSatz = form === "normal"
    ? "Normal: für zehn Jahre gibt es spürbar mehr Zins als für drei Monate."
    : form === "flach"
      ? "Flach: lange und kurze Laufzeiten bringen fast dasselbe."
      : "Invers: kurzes Geld bringt mehr Zins als langes - das ist der ungewöhnliche Fall.";

  return {
    ok: true,
    titel: "Zinskurve",
    frage: "Verlangt der Markt für langes Verleihen mehr Zins als für kurzes?",
    jetzt: runde(jetzt, 2),
    vorMonat: runde(vorMonat, 2),
    vorQuartal: runde(vorQuartal, 2),
    vorJahr: runde(vorJahr, 2),
    form, formSatz,
    tage: spanne.length,
    inverseTage: invers,
    bisTag: tage[tage.length - 1],
    satz: "Zehnjährige US-Staatsanleihen bringen derzeit " + dz(jetzt, 2)
      + " Prozentpunkte " + (jetzt >= 0 ? "mehr" : "weniger") + " als dreimonatige. " + formSatz,
    niemals: "Sagt nichts darüber, was Aktien morgen oder nächsten Monat machen. Eine inverse Kurve "
      + "ging historisch oft Rezessionen voraus, aber mit einem Vorlauf von vielen Monaten bis über "
      + "zwei Jahre und mit Fehlalarmen. Als Zeitpunkt ist sie unbrauchbar.",
  };
}

/* ---------------------------------------------------------------------------
 * 2) GOLD-SILBER-VERHAELTNIS - wie viele Unzen Silber kostet eine Unze Gold.
 *
 * Braucht keinen neuen Abruf, beide Werte stehen schon auf der Seite. Der
 * Quotient ist aber das, was man liest, nicht die beiden Kurse einzeln.
 * ------------------------------------------------------------------------- */
function goldSilber(reihen, goldSymbol, silberSymbol) {
  const { tage, closes } = kz.gemeinsameTage(reihen, [goldSymbol, silberSymbol]);
  if (tage.length < 30) {
    return { ok: false, grund: "zu wenige gemeinsame Handelstage (" + tage.length + ")" };
  }
  const q = closes[goldSymbol].map((g, i) => g / closes[silberSymbol][i]).filter((x) => isFinite(x) && x > 0);
  if (q.length < 30) return { ok: false, grund: "zu wenige brauchbare Werte" };
  const jetzt = q[q.length - 1];
  const rang = kz.perzentilRang(jetzt, q);

  return {
    ok: true,
    titel: "Gold je Silber",
    frage: "Wie viele Unzen Silber kostet eine Unze Gold?",
    jetzt: runde(jetzt, 1),
    perzentil: rang === null ? null : Math.round(rang),
    tage: q.length,
    bisTag: tage[tage.length - 1],
    satz: "Eine Unze Gold kostet gerade " + dz(jetzt, 1) + " Unzen Silber"
      + (rang === null ? "." : " - höher als an " + Math.round(rang) + " % der letzten " + q.length + " Handelstage."),
    niemals: "Ist kein Kauf- oder Verkaufssignal für eines der beiden Metalle. Das Verhältnis kann "
      + "jahrelang in eine Richtung laufen, ohne zurückzukehren.",
  };
}

/* ---------------------------------------------------------------------------
 * 3) WAEHRUNGSEFFEKT - wie viel einer US-Rendite nur der Wechselkurs war.
 *
 * Fuer Tiam der praktischste Wert auf dieser Seite: er investiert in Euro,
 * fast alles hier notiert in Dollar. Steigt ein US-ETF um 5 % und faellt
 * gleichzeitig der Dollar um 5 %, hat er nichts verdient.
 * ------------------------------------------------------------------------- */
function waehrungseffekt(reihen, paarSymbol) {
  const reihe = reihen[paarSymbol];
  if (!reihe || reihe.length < 30) {
    return { ok: false, grund: "Reihe fehlt oder ist zu kurz" };
  }
  const c = reihe.map((p) => p.close).filter((x) => isFinite(x) && x > 0);
  const jetzt = c[c.length - 1];
  const vorN = (n) => (c.length > n ? c[c.length - 1 - n] : null);
  const proz = (alt) => (alt === null ? null : ((jetzt / alt) - 1) * 100);

  const m1 = proz(vorN(21));
  const m3 = proz(vorN(63));
  const j1 = proz(vorN(252));

  // EUR/USD steigt = Euro wird staerker = ein US-Wert ist fuer Tiam WENIGER wert.
  const satzTeil = (p, zeit) => {
    if (p === null) return null;
    if (Math.abs(p) < 0.05) {
      return "In den letzten " + zeit + " hat sich am Wechselkurs praktisch nichts getan - "
        + "eine US-Rendite kam bei dir in Euro fast unverändert an.";
    }
    return "In den letzten " + zeit + " hat der Euro um " + dz(Math.abs(p), 1) + " % "
      + (p >= 0 ? "zugelegt" : "nachgegeben")
      + " - ein US-Wert war dadurch für dich um etwa " + dz(Math.abs(p), 1) + " % "
      + (p >= 0 ? "weniger" : "mehr") + " wert.";
  };

  return {
    ok: true,
    titel: "Euro gegen Dollar",
    frage: "Wie viel einer US-Rendite war bei dir nur Wechselkurs?",
    jetzt: runde(jetzt, 4),
    monat: runde(m1, 2),
    quartal: runde(m3, 2),
    jahr: runde(j1, 2),
    satz: satzTeil(m3, "drei Monaten") || satzTeil(m1, "einem Monat") || "Noch zu wenig Historie.",
    zeilen: [
      { zeit: "1 Monat", wert: runde(m1, 2) },
      { zeit: "3 Monate", wert: runde(m3, 2) },
      { zeit: "1 Jahr", wert: runde(j1, 2) },
    ].filter((z) => z.wert !== null),
    niemals: "Sagt nichts über die künftige Kursrichtung des Euro. Und es gilt nur für Werte, die "
      + "wirklich in Dollar notieren - ein in Euro gehandelter Welt-ETF trägt denselben Effekt "
      + "bereits eingebaut in sich.",
  };
}

/* ---------------------------------------------------------------------------
 * Alles zusammen. Jede Kennzahl einzeln in try/catch, nach demselben Muster
 * wie marktlage_build.js: eine fehlende Reihe darf nie den ganzen Block
 * kippen, es soll ehrlich dastehen, was fehlt.
 * ------------------------------------------------------------------------- */
function alle(reihen) {
  const aus = {};
  const sicher = (name, fn) => {
    try {
      aus[name] = fn();
    } catch (e) {
      aus[name] = { ok: false, grund: String(e && e.message ? e.message : e).slice(0, 150) };
    }
  };

  sicher("zinskurve", () => zinskurve(reihen, "^TNX", "^IRX"));

  sicher("marktbreite", () => kasten(
    "Marktbreite",
    paarVergleich(reihen, "RSP", "^GSPC", FENSTER),
    {
      nameA: "Der gleichgewichtete S&P 500",
      nameB: "der normale",
      nameBdat: "dem normalen",
      frage: "Tragen viele Firmen den Markt - oder nur ein paar Riesen?",
      deutung: "Die Bewegung ist breit getragen:",
      gegenteil: "Die Bewegung hängt an wenigen Schwergewichten:",
      niemals: "Sagt nichts darüber, ob der Markt steigt oder fällt - nur, wie viele Firmen daran "
        + "beteiligt sind. Ein schmaler Markt kann jahrelang weiterlaufen.",
    }));

  sicher("risikoneigung", () => kasten(
    "Risikoneigung",
    paarVergleich(reihen, "XLY", "XLP", FENSTER),
    {
      nameA: "Zyklischer Konsum",
      nameB: "defensiver Konsum",
      nameBdat: "defensivem Konsum",
      frage: "Greifen Anleger zu oder suchen sie Deckung?",
      deutung: "Anleger greifen eher zu:",
      gegenteil: "Anleger suchen eher Deckung:",
      niemals: "Ist keine Aussage über den Gesamtmarkt und kein Einstiegszeitpunkt. Beide Sektoren "
        + "können gleichzeitig fallen.",
    }));

  sicher("kreditstress", () => kasten(
    "Kreditstress",
    paarVergleich(reihen, "HYG", "IEF", FENSTER),
    {
      nameA: "Der Korb mit Hochzinsanleihen",
      nameB: "der Korb mit sicheren Staatsanleihen",
      nameBdat: "sicheren Staatsanleihen",
      frage: "Trauen Anleger schwächeren Schuldnern noch?",
      deutung: "Entspannt:",
      gegenteil: "Angespannt:",
      niemals: "Ein Vorsprung der Staatsanleihen kann auch einfach heißen, dass die Zinsen gefallen "
        + "sind - nicht zwingend, dass jemand in Not ist.",
    }));

  sicher("inflationserwartung", () => kasten(
    "Inflationserwartung",
    paarVergleich(reihen, "TIP", "IEF", FENSTER),
    {
      nameA: "Der Korb inflationsgeschützter Anleihen",
      nameB: "der mit normalen Staatsanleihen",
      nameBdat: "normalen Staatsanleihen",
      frage: "Rechnet der Anleihemarkt mit mehr oder weniger Inflation?",
      deutung: "Der Markt preist eher steigende Inflation ein:",
      gegenteil: "Der Markt preist eher nachlassende Inflation ein:",
      niemals: "Ist eine grobe Annäherung über zwei ETFs, nicht die amtliche Inflationserwartung. "
        + "Unterschiedliche Laufzeiten der beiden Körbe verzerren den Vergleich zusätzlich.",
    }));

  sicher("goldSilber", () => goldSilber(reihen, "GC=F", "SI=F"));
  sicher("waehrung", () => waehrungseffekt(reihen, "EURUSD=X"));

  return aus;
}

module.exports = { alle, paarVergleich, zinskurve, goldSilber, waehrungseffekt, FENSTER };
