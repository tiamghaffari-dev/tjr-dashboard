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
function vergleiche(schluessel, trades) {
  const gruppen = new Map();
  for (const t of trades) {
    const v = t.tuningAtEntry && t.tuningAtEntry[schluessel];
    if (typeof v !== "number" || typeof t.rMultiple !== "number") continue;
    const k = v.toFixed(3);
    if (!gruppen.has(k)) gruppen.set(k, []);
    gruppen.get(k).push(t.rMultiple);
  }
  const brauchbar = [...gruppen.entries()]
    .filter(([, v]) => v.length >= MIN_PRO_GRUPPE)
    .map(([k, v]) => ({ wert: Number(k), n: v.length, schnittR: mittel(v) }))
    .sort((a, b) => b.schnittR - a.schnittR);
  return brauchbar;
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
  const geschlossen = (signalsLog || []).filter(
    (r) => (r.status === "win" || r.status === "loss") && typeof r.rMultiple === "number",
  );

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
    JUSTIERBAR, MIN_PRO_GRUPPE, COOLDOWN_TAGE, MIN_UNTERSCHIED_R,
    standardwerte, bereinigen, vergleiche, justiere,
  };
}
