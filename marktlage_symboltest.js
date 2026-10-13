// ============================================================================
// SYMBOLTEST fuer den geplanten Marktlage-Bereich - Etappe 0
// ============================================================================
// Zweck: herausfinden, welche Yahoo-Symbole wirklich brauchbare Daten liefern,
// BEVOR irgendetwas gebaut wird. Weder die Cowork-Sandbox noch Tiams Rechner
// erreichen query1.finance.yahoo.com (beide HTTP 000), und WebFetch blockt es
// per robots.txt. Der GitHub-Runner kommt dran - also wird hier getestet.
//
// Dieses Skript erzeugt KEINE Signale, aendert KEINE Dateien des TJR-Teils und
// schreibt nur `marktlage_symbole.json`. Es ist bewusst ein Wegwerf-Schritt:
// sobald klar ist, welche Symbole taugen, wird daraus die eigentliche
// Marktlage-Seite gebaut - oder dieses Skript geloescht.
//
// Geprueft wird pro Symbol:
//   - kommt ueberhaupt eine Antwort?
//   - wie viele Tage mit Kurs sind drin (Luecken = unbrauchbar)?
//   - wie alt ist der letzte Kurs (veraltet = unbrauchbar)?
//   - welche Waehrung (fuer die spaetere Anzeige wichtig)?
// ============================================================================

const KANDIDATEN = [
  // --- breite Indizes ---
  { gruppe: "Index", name: "MSCI World (ETF)", symbol: "URTH" },
  { gruppe: "Index", name: "MSCI World (Amsterdam)", symbol: "IWDA.AS" },
  { gruppe: "Index", name: "S&P 500", symbol: "^GSPC" },
  { gruppe: "Index", name: "Nasdaq 100", symbol: "^NDX" },
  { gruppe: "Index", name: "DAX", symbol: "^GDAXI" },
  { gruppe: "Index", name: "Euro Stoxx 50", symbol: "^STOXX50E" },

  // --- Rohstoffe ---
  { gruppe: "Rohstoff", name: "Oel WTI", symbol: "CL=F" },
  { gruppe: "Rohstoff", name: "Oel Brent", symbol: "BZ=F" },
  { gruppe: "Rohstoff", name: "Gold", symbol: "GC=F" },
  { gruppe: "Rohstoff", name: "Silber", symbol: "SI=F" },
  { gruppe: "Rohstoff", name: "Erdgas", symbol: "NG=F" },

  // --- Nervositaet / Zinsen ---
  { gruppe: "Umfeld", name: "VIX (Nervositaet)", symbol: "^VIX" },
  { gruppe: "Umfeld", name: "US-Staatsanleihe 10J", symbol: "^TNX" },
  { gruppe: "Umfeld", name: "Dollar-Index", symbol: "DX-Y.NYB" },

  // --- Sektoren ---
  { gruppe: "Sektor", name: "Ruestung/Luftfahrt", symbol: "ITA" },
  { gruppe: "Sektor", name: "Energie", symbol: "XLE" },
  { gruppe: "Sektor", name: "Technologie", symbol: "XLK" },
  { gruppe: "Sektor", name: "Finanzen", symbol: "XLF" },
  { gruppe: "Sektor", name: "Rohstoffe/Material", symbol: "XLB" },

  // --- Einzelwerte, die Tiam genannt hat ---
  { gruppe: "Einzelwert", name: "Rheinmetall", symbol: "RHM.DE" },
  { gruppe: "Einzelwert", name: "Tesla", symbol: "TSLA" },

  // --- Kontrolle: die sechs TJR-Werte, die nachweislich funktionieren ---
  { gruppe: "Kontrolle", name: "Bitcoin", symbol: "BTC-USD" },
  { gruppe: "Kontrolle", name: "Ethereum", symbol: "ETH-USD" },
  { gruppe: "Kontrolle", name: "XRP", symbol: "XRP-USD" },
  { gruppe: "Kontrolle", name: "GBP/USD", symbol: "GBPUSD=X" },
];

const PAUSE_MS = 400;   // hoeflich bleiben, kein Hammern auf Yahoo

function schlafe(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function hole(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(symbol) + "?interval=1d&range=1mo";
  const antwort = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tjr-dashboard symboltest)" },
  });
  if (!antwort.ok) {
    return { ok: false, grund: "HTTP " + antwort.status };
  }
  const daten = await antwort.json();
  const ergebnis = daten && daten.chart && daten.chart.result && daten.chart.result[0];
  if (!ergebnis) {
    const fehler = daten && daten.chart && daten.chart.error;
    return { ok: false, grund: fehler ? JSON.stringify(fehler).slice(0, 80) : "kein Ergebnis" };
  }
  const stempel = ergebnis.timestamp || [];
  const kurse = (ergebnis.indicators
    && ergebnis.indicators.quote
    && ergebnis.indicators.quote[0]
    && ergebnis.indicators.quote[0].close) || [];

  // Nur Tage zaehlen, die wirklich einen Kurs haben - Yahoo liefert fuer
  // Feiertage und Datenluecken `null` mit, das waere sonst geschoent.
  const gueltig = [];
  for (let i = 0; i < kurse.length; i++) {
    if (typeof kurse[i] === "number" && isFinite(kurse[i])) {
      gueltig.push({ ts: stempel[i], close: kurse[i] });
    }
  }
  if (gueltig.length === 0) return { ok: false, grund: "Antwort ohne Kurse" };

  const letzter = gueltig[gueltig.length - 1];
  const alterTage = (Date.now() / 1000 - letzter.ts) / 86400;
  const erster = gueltig[0];
  const veraenderung = erster.close > 0
    ? ((letzter.close - erster.close) / erster.close) * 100
    : null;

  return {
    ok: true,
    tage: gueltig.length,
    luecken: kurse.length - gueltig.length,
    letzterKurs: Math.round(letzter.close * 1e4) / 1e4,
    alterTage: Math.round(alterTage * 10) / 10,
    waehrung: (ergebnis.meta && ergebnis.meta.currency) || "?",
    boerse: (ergebnis.meta && ergebnis.meta.exchangeName) || "?",
    monatProzent: veraenderung === null ? null : Math.round(veraenderung * 100) / 100,
  };
}

// Ein Symbol gilt nur als brauchbar, wenn es GENUG Tage hat UND der letzte
// Kurs frisch ist. Ein Symbol, das 20 Tage liefert aber seit einer Woche
// steht, ist fuer eine Lageuebersicht wertlos - genau solche Faelle soll
// dieser Test aufdecken, statt sie spaeter im Betrieb zu entdecken.
function urteil(e) {
  if (!e.ok) return "unbrauchbar";
  if (e.tage < 10) return "zu wenig Daten";
  if (e.alterTage > 5) return "veraltet";
  if (e.luecken > e.tage * 0.3) return "zu lueckenhaft";
  return "brauchbar";
}

async function main() {
  const ergebnisse = [];
  console.log("Symboltest Marktlage - " + new Date().toISOString());
  console.log("=".repeat(78));

  for (const k of KANDIDATEN) {
    let e;
    try {
      e = await hole(k.symbol);
    } catch (err) {
      e = { ok: false, grund: String(err && err.message ? err.message : err).slice(0, 80) };
    }
    const u = urteil(e);
    ergebnisse.push({ ...k, ...e, urteil: u });

    const marke = u === "brauchbar" ? "OK  " : "--  ";
    if (e.ok) {
      console.log(
        marke + k.symbol.padEnd(12) + k.name.padEnd(26)
        + String(e.tage).padStart(3) + " Tage, "
        + "Kurs " + String(e.letzterKurs).padStart(10) + " " + e.waehrung.padEnd(4)
        + " Alter " + String(e.alterTage).padStart(5) + "d"
        + "  -> " + u
      );
    } else {
      console.log(marke + k.symbol.padEnd(12) + k.name.padEnd(26) + "FEHLER: " + e.grund);
    }
    await schlafe(PAUSE_MS);
  }

  console.log("=".repeat(78));
  const brauchbar = ergebnisse.filter((e) => e.urteil === "brauchbar");
  console.log("Brauchbar: " + brauchbar.length + " von " + KANDIDATEN.length);
  for (const g of ["Index", "Rohstoff", "Umfeld", "Sektor", "Einzelwert", "Kontrolle"]) {
    const inGruppe = ergebnisse.filter((e) => e.gruppe === g);
    const ok = inGruppe.filter((e) => e.urteil === "brauchbar").length;
    console.log("  " + g.padEnd(12) + ok + " von " + inGruppe.length);
  }
  const kaputt = ergebnisse.filter((e) => e.urteil !== "brauchbar");
  if (kaputt.length) {
    console.log("\nNicht brauchbar:");
    for (const e of kaputt) {
      console.log("  " + e.symbol.padEnd(12) + (e.grund || e.urteil));
    }
  }

  require("fs").writeFileSync(
    __dirname + "/marktlage_symbole.json",
    JSON.stringify({ geprueft: new Date().toISOString(), ergebnisse }, null, 2),
    "utf8"
  );
  console.log("\nGeschrieben: marktlage_symbole.json");
}

main().catch((e) => {
  console.error("Symboltest fehlgeschlagen:", e);
  process.exit(1);
});
