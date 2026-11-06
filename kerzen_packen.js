"use strict";
/* ===========================================================================
 * kerzen_packen.js - die Chart-Kerzen kompakt in die Seite schreiben
 * ===========================================================================
 * WARUM, gemessen am 06.11.2026:
 *   docs/index.html war 4,24 MB gross. Davon entfielen 3,78 MB - also
 *   93 Prozent - allein auf die 5-Minuten-Kerzen der sechs Assets. Diese
 *   Datei wird im laufenden Betrieb alle fuenf Minuten neu committet. Das
 *   .git-Verzeichnis war nach vier Monaten auf 448 MB gewachsen, und Tiam
 *   will den Ordner als Backup wegkopieren.
 *
 * Der Grund fuer die Groesse ist nicht die Datenmenge, sondern die Schreibweise:
 *   {"ts":1791904500000,"open":83098.921875,"high":83113.1171875,
 *    "low":83080.796875,"close":83105.9375,"volume":0}
 * Von diesen rund 110 Zeichen sind etwa 45 reine Feldnamen, bei jeder
 * einzelnen von 34.560 Kerzen. Dazu der volle Zeitstempel, obwohl die
 * Abstaende fast immer dieselben 300 Sekunden sind.
 *
 * Gepackt steht dort stattdessen:
 *   [300,83098.921875,83113.1171875,83080.796875,83105.9375,0]
 *
 * ---------------------------------------------------------------------------
 * WICHTIG - was hier NICHT passiert:
 *
 * Es wird NICHTS gerundet und NICHTS weggelassen. Jede Zahl geht exakt so
 * hinein, wie sie herauskommt. Das ist kein Schoenheitsanspruch, sondern
 * Pflicht: report_template.html laesst die Engine im Browser auf genau
 * diesen Kerzen mitlaufen. Wuerde hier auch nur die letzte Nachkommastelle
 * verschwinden, koennte der Browser ein anderes Signal zeigen als der
 * Server gerechnet hat - und das waere eine Aenderung an der Handelslogik
 * durch die Hintertuer, mitten in der Ruhephase.
 *
 * Damit das nicht nur behauptet ist, prueft packeKerzen() seine eigene
 * Arbeit: es entpackt das Ergebnis sofort wieder und vergleicht Feld fuer
 * Feld. Stimmt auch nur ein Wert nicht, gibt es die urspruengliche Liste
 * unveraendert zurueck. Die Seite bekommt also im Zweifel die grosse, aber
 * garantiert richtige Fassung.
 *
 * ---------------------------------------------------------------------------
 * EINE QUELLE, ZWEI ORTE: build.js laedt diese Datei als Modul, und
 * report_template.html bekommt denselben Quelltext ueber den Platzhalter
 * __KERZEN_PACKEN_SOURCE__ eingebettet - genau wie engine.js. Deshalb
 * koennen Packer und Entpacker nicht auseinanderlaufen. Wer hier etwas
 * aendert, aendert es automatisch an beiden Stellen.
 * ===========================================================================
 */

function entpackeKerzen(x) {
  // Schon entpackt (oder noch nie gepackt): unveraendert zurueck. Dadurch
  // funktioniert eine alte, noch im Browser-Cache liegende Seite genauso
  // weiter wie eine frisch gebaute.
  if (!x || Array.isArray(x)) return x;
  if (typeof x !== "object" || !Array.isArray(x.k)) return x;

  const einheit = x.e || 1;
  const aus = [];
  let ts = x.b;
  for (let i = 0; i < x.k.length; i++) {
    const r = x.k[i];
    ts = i === 0 ? x.b : ts + r[0] * einheit;
    aus.push({ ts: ts, open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] });
  }
  return aus;
}

function packeKerzen(kerzen) {
  if (!Array.isArray(kerzen) || kerzen.length === 0) return kerzen;

  const basis = kerzen[0].ts;
  // Abstaende in Sekunden statt Millisekunden sparen drei Zeichen je Kerze -
  // aber nur, wenn dabei garantiert nichts verlorengeht.
  let einheit = 1000;
  if (basis % 1000 !== 0) {
    einheit = 1;
  } else {
    for (let i = 1; i < kerzen.length; i++) {
      if ((kerzen[i].ts - kerzen[i - 1].ts) % 1000 !== 0) { einheit = 1; break; }
    }
  }

  const k = new Array(kerzen.length);
  let vor = basis;
  for (let i = 0; i < kerzen.length; i++) {
    const c = kerzen[i];
    k[i] = [i === 0 ? 0 : (c.ts - vor) / einheit, c.open, c.high, c.low, c.close, c.volume || 0];
    vor = c.ts;
  }
  const gepackt = { b: basis, e: einheit, k: k };

  // Gegenprobe gegen das Original. Siehe Kopfkommentar: im Zweifel lieber
  // gross und richtig als klein und falsch.
  const zurueck = entpackeKerzen(gepackt);
  if (!Array.isArray(zurueck) || zurueck.length !== kerzen.length) return kerzen;
  for (let i = 0; i < kerzen.length; i++) {
    const a = kerzen[i], b = zurueck[i];
    if (a.ts !== b.ts || a.open !== b.open || a.high !== b.high
        || a.low !== b.low || a.close !== b.close || (a.volume || 0) !== b.volume) {
      return kerzen;
    }
  }
  return gepackt;
}

/* Alle Kerzenfelder eines fertigen Seiten-Datensatzes entpacken. Muss laufen,
 * BEVOR irgendetwas auf item.ltf zugreift - also direkt hinter der
 * Zuweisung von PRECOMPUTED und noch einmal nach jedem Nachladen. */
function entpackeAlle(p) {
  if (!p || !Array.isArray(p.assets)) return p;
  for (const a of p.assets) {
    if (a && a.ltf) a.ltf = entpackeKerzen(a.ltf);
  }
  return p;
}

if (typeof module !== "undefined") {
  module.exports = { packeKerzen, entpackeKerzen, entpackeAlle };
}
