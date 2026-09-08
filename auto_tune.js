// ============================================================================
// SELBSTJUSTIERUNG - die Engine passt eigene Zahlenwerte an
// ============================================================================
//
// Tiam, 2026-08-14: "ok sie soll selbst dann umschreiben."
// Gewaehlter Umfang: NUR Zahlenwerte innerhalb harter Grenzen - nicht der
// eigene Programmcode. Begruendung siehe unten unter "Warum so vorsichtig".
//
// Funktionsweise in einem Satz: fuer jeden justierbaren Wert werden die
// abgeschlossenen Trades danach gruppiert, WELCHER Wert beim Einstieg aktiv
// war, und die Gruppen am Erwartungswert verglichen. Nur wenn eine Gruppe
// spuerbar besser ist, bewegt sich der Wert einen kleinen Schritt in ihre
// Richtung.
//
// ----------------------------------------------------------------------------
// Warum so vorsichtig - das ist keine Theorie, sondern die Bilanz dieses Projekts
// ----------------------------------------------------------------------------
// - Die Obduktion meldete "Entry zu frueh" als Hauptproblem (14 von 30 Trades).
//   Haette die Engine das selbsttaetig umgesetzt, waere sie schlechter geworden:
//   die markierten Trades liefen in Wahrheit BESSER (43 % vs 19 % Trefferquote).
// - Regel R6 pruefte anfangs das falsche Feld und haette gueltige Signale
//   blockiert, sobald sich der Preis vom Einstieg entfernt.
// - Die erste Gegenrechnung zum Trailing-Stop lieferte -5R fuer einen Trade,
//   dessen Stop bei -1R lag - rechnerisch unmoeglich.
// Jedes Mal hat es nur eine GEGENPRUEFUNG gefangen. Genau die kann eine
// Automatik nicht leisten. Deshalb: enge Grenzen, kleine Schritte, alles
// protokolliert und umkehrbar.
//
// ----------------------------------------------------------------------------
// Die Schutzmechanismen im Einzelnen
// ----------------------------------------------------------------------------
// 1. HARTE GRENZEN   - jeder Wert hat min/max, die die Automatik nie verlaesst.
// 2. KLEINE SCHRITTE - pro Aenderung nur ein `schritt`, nie ein Sprung.
// 3. MINDESTDATEN    - je Vergleichsgruppe `MIN_PRO_GRUPPE` Trades.
// 4. ABKUEHLZEIT     - nach einer Aenderung `COOLDOWN_TAGE` Ruhe, sonst
//                      schwingt der Wert hin und her statt sich einzupendeln.
// 5. EINE PRO LAUF   - hoechstens eine Aenderung, damit Ursache und Wirkung
//                      zuordenbar bleiben.
// 6. ERWARTUNGSWERT  - entschieden wird am Ertrag pro Trade, NICHT an der
//                      Trefferquote. Die liesse sich durch naehere Ziele
//                      beliebig hochtreiben, ohne dass mehr herauskommt.
// 7. PROTOKOLL       - jede Aenderung mit Datum, Zahlen und Begruendung in
//                      tuning.json. Rueckgaengig: den Eintrag entfernen bzw.
//                      `aktiv` auf den alten Wert setzen.
//
// NICHT justierbar und bewusst nicht in dieser Liste: MIN_STOP_ADR_MULT (die
// Untergrenze des Stops). Das ist ein Schutz gegen Stops, die vom blossen
// Rauschen abgeraeumt werden - eine Automatik darf Sicherheiten nicht
// aufweichen, auch wenn die Statistik kurzfristig dafuer spraeche.

const MIN_PRO_GRUPPE = 8;      // Trades je Vergleichsgruppe
const COOLDOWN_TAGE = 14;      // Ruhe nach einer Aenderung
const MIN_UNTERSCHIED_R = 0.20; // Ertrag pro Trade, ab dem es zaehlt

const JUSTIERBAR = {
  MAX_TP1_ADR_MULT: {
    beschreibung: "Wie weit TP1 hoechstens entfernt sein darf (in Tagesranges)",
    min: 0.40, max: 1.00, schritt: 0.05, standard: 0.75,
  },
  MAX_TP2_ADR_MULT: {
    beschreibung: "Wie weit TP2 hoechstens entfernt sein darf (in Tagesranges)",
    min: 0.75, max: 1.75, schritt: 0.10, standard: 1.25,
  },
  NEWS_FENSTER_MIN: {
    beschreibung: "Sperrfenster vor einem High-Impact-Termin (Minuten)",
    min: 0, max: 120, schritt: 15, standard: 30,
  },
  KEY_LEVEL_MAX_ADR: {
    beschreibung: "Wie weit der Sweep hoechstens vom Key-Level weg sein darf",
    min: 0.05, max: 0.50, schritt: 0.05, standard: 0.15,
  },
};

function standardwerte() {
  const w = {};
  for (const [k, d] of Object.entries(JUSTIERBAR)) w[k] = d.standard;
  return w;
}

// Sorgt dafuer, dass ein geladener Stand vollstaendig und innerhalb der
// Grenzen ist - auch wenn jemand die Datei von Hand editiert hat.
function bereinigen(stand) {
  const aktiv = { ...standardwerte(), ...((stand && stand.aktiv) || {}) };
  for (const [k, d] of Object.entries(JUSTIERBAR)) {
    const v = Number(aktiv[k]);
    aktiv[k] = Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.standard;
  }
  return { aktiv, verlauf: (stand && Array.isArray(stand.verlauf)) ? stand.verlauf : [] };
}

function mittel(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

// Vergleicht die abgeschlossenen Trades danach, welcher Wert beim EINSTIEG
// aktiv war. Ohne `tuningAtEntry` im Datensatz ist kein Vergleich moeglich -
// dann passiert bewusst nichts.
function vergleiche(schluessel, trades, mindestens) {
  const grenze = typeof mindestens === "number" ? mindestens : MIN_PRO_GRUPPE;
  const gruppen = new Map();
  for (const t of trades) {
    const v = t.tuningAtEntry && t.tuningAtEntry[schluessel];
    if (typeof v !== "number" || typeof t.rMultiple !== "number") continue;
    const k = v.toFixed(3);
    if (!gruppen.has(k)) gruppen.set(k, []);
    gruppen.get(k).push(t.rMultiple);
  }
  const brauchbar = [...gruppen.entries()]
    .filter(([, v]) => v.length >= grenze)
    .map(([k, v]) => ({ wert: Number(k), n: v.length, schnittR: mittel(v) }))
    .sort((a, b) => b.schnittR - a.schnittR);
  return brauchbar;
}

// Welche Trades duerfen als Beleg dienen?
//   unfilled       -> der Markt war nie am Einstiegspreis, es gab keinen Trade
//   unzuverlaessig -> vor der Fuellpruefung entstanden, nicht nachrechenbar
//   beobachtung    -> ausserhalb von TJRs Handelsfenster nur mitgeschrieben;
//                     zaehlt fuer die MESSUNG, nie fuer Tiams Bilanz
function auswertbar(signalsLog, mitBeobachtung) {
  return (signalsLog || []).filter(
    (r) => (r.status === "win" || r.status === "loss")
      && !r.unzuverlaessig && typeof r.rMultiple === "number"
      && (mitBeobachtung || !r.beobachtung),
  );
}

// ---------------------------------------------------------------------------
// ERKUNDEN - Tiams Entscheidung 2026-09-08
// ---------------------------------------------------------------------------
// Der Konstruktionsfehler, den diese Funktion behebt: `vergleiche()` braucht
// zwei Gruppen mit unterschiedlichen Werten. Solange ein Wert nie wechselt,
// gibt es nur eine Gruppe - die Automatik wartete also auf Unterschiede, die
// nur sie selbst haette erzeugen koennen. Nachgemessen am 2026-09-08: ueber
// alle 40 bewertbaren Trades hatte JEDER der vier Werte genau einen einzigen
// Wert. In 25 Tagen kam deshalb keine einzige Anpassung zustande.
//
// Loesung: an einem Teil der Tage bewusst den Nachbarwert fahren. Das ist der
// unvermeidliche Einsatz fuers Lernen - ohne Streuung keine Erkenntnis.
//
// Zwei bewusste Festlegungen:
//  - IMMER NUR EIN WERT gleichzeitig, sonst liessen sich Ursache und Wirkung
//    nicht mehr trennen (dieselbe Begruendung wie "eine Aenderung pro Lauf").
//  - Entschieden wird pro TAG, nicht pro Lauf. Der Lauf startet alle paar
//    Minuten; wechselte der Wert dabei, saehe Tiam beim Neuladen staendig
//    andere Ziele, und ein Trade koennte unter einem anderen Wert aufgeloest
//    werden als er eroeffnet wurde.
const ERKUNDUNG_ANTEIL = 0.4;   // Anteil der Tage auf dem Nachbarwert

// Deterministischer Streuwert aus einem Text (FNV-1a). Bewusst KEIN
// Math.random(): gleicher Tag muss immer dasselbe ergeben, auch nach einem
// Neustart des Laufs.
function tagesZahl(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// Welcher Wert wird gerade erkundet? Der erste, dem noch Vergleichsdaten
// fehlen. Hat ein Wert genug Belege, rueckt die Erkundung zum naechsten weiter
// und hoert von selbst auf, wenn alle abgedeckt sind.
function erkundungsZiel(geschlossen) {
  for (const schluessel of Object.keys(JUSTIERBAR)) {
    if (vergleiche(schluessel, geschlossen).length < 2) return schluessel;
  }
  return null;
}

// Welche Werte gelten HEUTE? `datumStr` muss ein tagesstabiler Text sein
// (z.B. "2026-09-08").
function tageswerte(stand, signalsLog, datumStr) {
  const s = bereinigen(stand);
  const werte = { ...s.aktiv };
  const ziel = erkundungsZiel(auswertbar(signalsLog, true));
  if (!ziel) return { werte, erkundet: null };

  const d = JUSTIERBAR[ziel];
  // Nachbarwert: einen Schritt nach oben, sonst nach unten. Nie ueber die
  // harten Grenzen hinaus - die gelten fuers Erkunden genauso.
  let nachbar = Math.round((werte[ziel] + d.schritt) * 1000) / 1000;
  if (nachbar > d.max) nachbar = Math.round((werte[ziel] - d.schritt) * 1000) / 1000;
  if (nachbar < d.min || nachbar > d.max) return { werte, erkundet: null };

  if (tagesZahl(`${datumStr}:${ziel}`) >= ERKUNDUNG_ANTEIL) {
    return { werte, erkundet: null };   // heute der normale Wert
  }
  const statt = werte[ziel];
  werte[ziel] = nachbar;
  return { werte, erkundet: { wert: ziel, statt, probiert: nachbar } };
}

function tageSeit(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 86400000;
}

// Hauptfunktion. Gibt den (ggf. geaenderten) Stand plus einen Bericht zurueck.
// Aendert HOECHSTENS EINEN Wert pro Aufruf.
function justiere(stand, signalsLog, jetztIso) {
  const s = bereinigen(stand);
  const bericht = [];
  // Phantom-Fuellungs-Fund 2026-09-05: Trades, bei denen der Markt nie am
  // Einstiegspreis war ("unfilled"), sind keine Trades - und Altbestaende, die
  // sich nicht mehr ehrlich nachrechnen liessen ("unzuverlaessig"), sind keine
  // Belege. Wuerde die Selbstjustierung sie mitzaehlen, wuerde sie ihre Werte
  // an Ergebnissen ausrichten, die es nie gab.
  // Beobachtungs-Trades (ausserhalb des Handelsfensters) liefern die MENGE,
  // die Fenster-Trades behalten das VETO: zeigen die echten Trades in die
  // Gegenrichtung, wird nichts geaendert. So beschleunigt die Beobachtung das
  // Lernen, ohne dass eine Umstellung allein auf Zeiten beruht, die Tiam nach
  // TJRs Regeln gar nicht handelt.
  const geschlossen = auswertbar(signalsLog, true);
  const nurFenster = auswertbar(signalsLog, false);

  const letzte = s.verlauf.length ? s.verlauf[s.verlauf.length - 1].wann : null;
  if (tageSeit(letzte) < COOLDOWN_TAGE) {
    bericht.push(`Abkuehlzeit laeuft noch (${Math.ceil(COOLDOWN_TAGE - tageSeit(letzte))} Tage) - keine Aenderung.`);
    return { stand: s, bericht, geaendert: null };
  }

  for (const [schluessel, d] of Object.entries(JUSTIERBAR)) {
    const gruppen = vergleiche(schluessel, geschlossen);
    if (gruppen.length < 2) {
      bericht.push(`${schluessel}: noch keine zwei Gruppen mit je ${MIN_PRO_GRUPPE} Trades - nicht bewertbar.`);
      continue;
    }
    const beste = gruppen[0];
    const schlechteste = gruppen[gruppen.length - 1];
    const unterschied = beste.schnittR - schlechteste.schnittR;
    if (unterschied < MIN_UNTERSCHIED_R) {
      bericht.push(`${schluessel}: Unterschied nur ${unterschied.toFixed(2)}R - zu klein, bleibt bei ${s.aktiv[schluessel]}.`);
      continue;
    }
    // VETO der echten Fenster-Trades (siehe oben). Schon ab 3 je Gruppe, weil
    // es hier nicht um einen Beweis geht, sondern nur darum, einen offenen
    // Widerspruch zu bemerken.
    const fensterGruppen = vergleiche(schluessel, nurFenster, 3);
    if (fensterGruppen.length >= 2 && Math.abs(fensterGruppen[0].wert - beste.wert) > 1e-9) {
      bericht.push(`${schluessel}: Beobachtung bevorzugt ${beste.wert}, die echten Fenster-Trades aber `
        + `${fensterGruppen[0].wert} - Widerspruch, keine Aenderung.`);
      continue;
    }

    const jetzt = s.aktiv[schluessel];
    if (Math.abs(beste.wert - jetzt) < 1e-9) {
      bericht.push(`${schluessel}: der aktuelle Wert ist bereits der beste - bleibt bei ${jetzt}.`);
      continue;
    }
    // Einen Schritt in Richtung des besseren Wertes, nie darueber hinaus.
    const richtung = beste.wert > jetzt ? 1 : -1;
    let neu = jetzt + richtung * d.schritt;
    if (richtung > 0) neu = Math.min(neu, beste.wert, d.max);
    else neu = Math.max(neu, beste.wert, d.min);
    neu = Math.round(neu * 1000) / 1000;
    if (Math.abs(neu - jetzt) < 1e-9) {
      bericht.push(`${schluessel}: Schritt wuerde nichts aendern (Grenze erreicht) - bleibt bei ${jetzt}.`);
      continue;
    }
    s.aktiv[schluessel] = neu;
    const eintrag = {
      wann: jetztIso || new Date().toISOString(),
      wert: schluessel, von: jetzt, zu: neu,
      grund: `${beste.wert} brachte ${beste.schnittR.toFixed(2)}R (${beste.n} Trades) gegen `
        + `${schlechteste.schnittR.toFixed(2)}R bei ${schlechteste.wert} (${schlechteste.n} Trades).`,
      gruppen,
    };
    s.verlauf.push(eintrag);
    bericht.push(`GEAENDERT ${schluessel}: ${jetzt} -> ${neu}. ${eintrag.grund}`);
    return { stand: s, bericht, geaendert: eintrag };  // nur eine pro Lauf
  }
  return { stand: s, bericht, geaendert: null };
}

if (typeof module !== "undefined") {
  module.exports = {
    JUSTIERBAR, MIN_PRO_GRUPPE, COOLDOWN_TAGE, MIN_UNTERSCHIED_R, ERKUNDUNG_ANTEIL,
    standardwerte, bereinigen, vergleiche, justiere,
    auswertbar, tagesZahl, erkundungsZiel, tageswerte,
  };
}
