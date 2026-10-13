// Einmal-Diagnose: zu welcher Tageszeit stehen Yahoos Tageszeitstempel je
// Symbol? Wenn ein Symbol seine Kerze z.B. um 22:00 UTC stempelt, faellt sie
// bei der UTC-Datumsbildung auf den VORTAG - dann waere die Ausrichtung auf
// gemeinsame Tage um einen Tag verschoben und jede Korrelation falsch.
const ml = require("./marktlage.js");
const kz = require("./marktlage_kennzahlen.js");

(async () => {
  const reihen = {};
  const interessant = [...ml.GEHANDELT.map(g => g.symbol), ...ml.SYMBOLE.filter(s=>s.gruppe==="Sektor").map(s=>s.symbol)];
  for (const sym of interessant) {
    try {
      const r = await ml.holeReihe(sym);
      reihen[sym] = r.reihe;
      const stunden = {};
      for (const p of r.reihe) {
        const d = new Date(p.ts * 1000);
        const k = String(d.getUTCHours()).padStart(2,"0") + ":" + String(d.getUTCMinutes()).padStart(2,"0");
        stunden[k] = (stunden[k] || 0) + 1;
      }
      const top = Object.entries(stunden).sort((a,b)=>b[1]-a[1]).slice(0,3);
      const wochenende = r.reihe.filter(p => { const w = new Date(p.ts*1000).getUTCDay(); return w===0||w===6; }).length;
      console.log(sym.padEnd(10) + String(r.reihe.length).padStart(4) + " Kerzen, " + String(wochenende).padStart(3) + " am Wochenende (UTC), "
        + "Stempel-Uhrzeiten UTC: " + top.map(t=>t[0]+" x"+t[1]).join(", "));
    } catch (e) {
      console.log(sym.padEnd(10) + "FEHLER " + e.message);
    }
    await new Promise(r => setTimeout(r, 350));
  }

  console.log("\n--- Schnittmengen ---");
  const sechs = ml.GEHANDELT.map(g => g.symbol);
  const g6 = kz.gemeinsameTage(reihen, sechs);
  console.log("alle sechs gehandelten:", g6.tage.length, "Tage,", g6.tage[0], "..", g6.tage[g6.tage.length-1]);
  // Wer schneidet am meisten weg?
  for (const weg of sechs) {
    const rest = sechs.filter(s => s !== weg);
    const g = kz.gemeinsameTage(reihen, rest);
    console.log("  ohne " + weg.padEnd(10) + " -> " + String(g.tage.length).padStart(4) + " Tage (+" + (g.tage.length - g6.tage.length) + ")");
  }
})();
