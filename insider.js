"use strict";
/*
 * insider.js - Insider-KAEUFE aus SEC Form 4 sammeln.
 *
 * BEWUSST GETRENNT von der TJR-Handelslogik. Diese Datei erzeugt KEINE Signale,
 * keine Einstiege, keine Benachrichtigungen. Sie beobachtet und archiviert.
 *
 * Warum nur Kaeufe:
 *   Insider-VERKAEUFE sagen fast nichts aus (Steuern, Streuung, automatische
 *   10b5-1-Plaene, die vor Monaten aufgesetzt wurden). Insider-KAEUFE, vor allem
 *   wenn mehrere Insider derselben Firma kurz hintereinander kaufen, haben in der
 *   Forschung einen kleinen, aber dokumentierten Vorsprung - ueber MONATE, nicht Stunden.
 *
 * Warum Awards verworfen werden:
 *   transactionCode "A" ist Gehalt in Aktienform, keine Kaufentscheidung. Am 28.09.2026
 *   waren von den 12 juengsten Meldungen 4 solche Awards und 3 reine Formulare ohne
 *   jede Transaktion. Ein naiver Bot meldet also ueberwiegend Lohnabrechnungen.
 *
 * Quelle: SEC EDGAR, kostenlos und ohne Schluessel - passt zu Yahoo/ForexFactory
 * im Rest des Projekts. SEC verlangt einen User-Agent mit Kontaktadresse und
 * begrenzt auf 10 Anfragen/Sekunde.
 */

const fs = require("fs");
const path = require("path");

const SEC_UA = process.env.SEC_USER_AGENT || "TJR-Dashboard Kontakt tiamghaffari@gmail.com";
const ABSTAND_MS = 120;          // ~8 Anfragen/s, unter dem SEC-Limit von 10
const MAX_FILINGS_PRO_LAUF = 1500;
const MIN_KAUF_USD = 10000;      // darunter ist es Rauschen (siehe RCG: 756 Stueck = 2.283 USD)

function schlafe(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function hole(url, alsText = true, versuche = 3) {
  let letzterFehler = null;
  for (let i = 0; i < versuche; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate" },
      });
      if (res.status === 404) return null;           // fehlender Tag ist kein Fehler
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return alsText ? await res.text() : await res.json();
    } catch (e) {
      letzterFehler = e;
      await schlafe(400 * (i + 1));
    }
  }
  throw new Error(`${url}: ${letzterFehler ? letzterFehler.message : "unbekannt"}`);
}

function quartal(d) {
  return Math.floor(d.getUTCMonth() / 3) + 1;
}

// "20260925" -> "2026-09-25"; bereits getrennte Datumsangaben bleiben unveraendert.
function normDatum(s) {
  if (!s) return s;
  const m = String(s).trim().match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(s).trim();
}

function datumsStempel(d) {
  const j = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const t = String(d.getUTCDate()).padStart(2, "0");
  return `${j}${m}${t}`;
}

/* ---------- 1. Tagesindex: welche Form-4-Meldungen gab es? ---------- */

async function tagesFilings(datum) {
  const j = datum.getUTCFullYear();
  const url = `https://www.sec.gov/Archives/edgar/daily-index/${j}/QTR${quartal(datum)}/master.${datumsStempel(datum)}.idx`;
  const text = await hole(url);
  if (!text) return [];                              // Wochenende/Feiertag

  const zeilen = text.split("\n");
  const treffer = [];
  for (const z of zeilen) {
    // Format: CIK|Company Name|Form Type|Date Filed|Filename
    const teile = z.split("|");
    if (teile.length !== 5) continue;
    if (teile[2].trim() !== "4") continue;
    treffer.push({
      cik: teile[0].trim(),
      firma: teile[1].trim(),
      // master.idx liefert YYYYMMDD, das Form-4-XML dagegen YYYY-MM-DD.
      // Gefunden im ersten echten Lauf (28.09.2026): ohne diese Angleichung
      // scheitert Date.parse an "20260925", die Verzoegerung wird null und
      // die Archivdatei heisst "insider_2026092.csv". Beides war kaputt.
      meldedatum: normDatum(teile[3].trim()),
      pfad: teile[4].trim(),
    });
  }
  return treffer;
}

/* ---------- 2. Form-4-XML lesen ---------- */

function feld(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
}

function wert(block, name) {
  // <transactionShares><value>1000</value></transactionShares>
  const aussen = feld(block, name);
  if (aussen === null) return null;
  const innen = aussen.match(/<value>([\s\S]*?)<\/value>/);
  return (innen ? innen[1] : aussen).trim();
}

function parseForm4(roh) {
  // Die .txt-Volleinreichung enthaelt das XML eingebettet.
  const m = roh.match(/<ownershipDocument>[\s\S]*?<\/ownershipDocument>/);
  if (!m) return null;
  const xml = m[0];

  const symbol = feld(xml, "issuerTradingSymbol");
  const firma = feld(xml, "issuerName");
  const inhaber = feld(xml, "rptOwnerName");
  const istDirektor = feld(xml, "isDirector") === "1" || feld(xml, "isDirector") === "true";
  const istVorstand = feld(xml, "isOfficer") === "1" || feld(xml, "isOfficer") === "true";
  // Wichtig fuer die Einordnung: Berkshire Hathaway tauchte im ersten Lauf mit
  // 409 Mio USD bei Lennar auf - als 10-Prozent-Eigner, nicht als Vorstand. Das
  // ist etwas voellig anderes als ein Direktor, der eigenes Geld nachschiesst.
  const istGrossaktionaer = feld(xml, "isTenPercentOwner") === "1" || feld(xml, "isTenPercentOwner") === "true";
  const titel = feld(xml, "officerTitle");

  const kaeufe = [];
  const bloecke = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) || [];
  for (const b of bloecke) {
    const code = wert(b, "transactionCode");
    if (code !== "P") continue;                      // NUR echte Kaeufe
    const stueck = Number(wert(b, "transactionShares"));
    const preis = Number(wert(b, "transactionPricePerShare"));
    const datum = wert(b, "transactionDate");
    if (!isFinite(stueck) || !isFinite(preis) || stueck <= 0 || preis <= 0) continue;
    kaeufe.push({ stueck, preis, summe: Math.round(stueck * preis), datum: normDatum(datum) });
  }
  if (!kaeufe.length) return null;

  return { symbol, firma, inhaber, istDirektor, istVorstand, istGrossaktionaer, titel, kaeufe };
}

/* ---------- 3. Sammeln ---------- */

async function sammle(tageZurueck = 1) {
  const heute = new Date();
  const gefunden = [];
  let angesehen = 0;
  const fehler = [];

  for (let t = 0; t < tageZurueck; t++) {
    const tag = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate() - t));
    let filings = [];
    try {
      filings = await tagesFilings(tag);
    } catch (e) {
      fehler.push(`Index ${datumsStempel(tag)}: ${e.message}`);
      continue;
    }
    if (!filings.length) continue;

    for (const f of filings) {
      if (angesehen >= MAX_FILINGS_PRO_LAUF) break;
      angesehen++;
      await schlafe(ABSTAND_MS);
      let roh;
      try {
        roh = await hole(`https://www.sec.gov/Archives/${f.pfad}`);
      } catch (e) {
        fehler.push(`${f.pfad}: ${e.message}`);
        continue;
      }
      if (!roh) continue;
      const p = parseForm4(roh);
      if (!p || !p.symbol) continue;
      // Nicht boersengehandelte Einreicher (Fonds, Zweckgesellschaften) melden
      // "N/A" oder "NONE" als Symbol - fuer eine Aktienbeobachtung wertlos.
      if (/^(n\/?a|none|-)$/i.test(p.symbol)) continue;

      for (const k of p.kaeufe) {
        if (k.summe < MIN_KAUF_USD) continue;
        const verzoegerung = tageZwischen(k.datum, f.meldedatum);
        gefunden.push({
          symbol: p.symbol,
          firma: p.firma || f.firma,
          inhaber: p.inhaber,
          rolle: p.titel || (p.istDirektor ? "Director" : p.istVorstand ? "Officer" : p.istGrossaktionaer ? "10% Eigner" : ""),
          grossaktionaer: p.istGrossaktionaer && !p.istDirektor && !p.istVorstand,
          stueck: k.stueck,
          preis: k.preis,
          summe: k.summe,
          transaktion: k.datum,
          meldung: f.meldedatum,
          verzoegerungTage: verzoegerung,
          quelle: `https://www.sec.gov/Archives/${f.pfad}`,
        });
      }
    }
  }
  return { gefunden, angesehen, fehler };
}

function tageZwischen(a, b) {
  const d1 = Date.parse(a), d2 = Date.parse(b);
  if (!isFinite(d1) || !isFinite(d2)) return null;
  return Math.round((d2 - d1) / 86400000);
}

/* ---------- 4. Buendeln: mehrere Insider derselben Firma ---------- */

function buendle(eintraege) {
  const proSymbol = new Map();
  for (const e of eintraege) {
    if (!proSymbol.has(e.symbol)) {
      proSymbol.set(e.symbol, {
        symbol: e.symbol, firma: e.firma, insider: new Set(),
        summe: 0, kaeufe: 0, frueheste: e.transaktion, spaeteste: e.transaktion,
        maxVerzoegerung: 0, nurGrossaktionaer: true, belege: [],
      });
    }
    const g = proSymbol.get(e.symbol);
    g.insider.add(e.inhaber);
    g.summe += e.summe;
    g.kaeufe++;
    if (e.transaktion < g.frueheste) g.frueheste = e.transaktion;
    if (e.transaktion > g.spaeteste) g.spaeteste = e.transaktion;
    if (e.verzoegerungTage != null && e.verzoegerungTage > g.maxVerzoegerung) {
      g.maxVerzoegerung = e.verzoegerungTage;
    }
    if (!e.grossaktionaer) g.nurGrossaktionaer = false;
    g.belege.push(e);
  }
  return [...proSymbol.values()]
    .map((g) => ({ ...g, anzahlInsider: g.insider.size, insider: [...g.insider] }))
    // Mehrere Insider zaehlen mehr als ein grosser Einzelkauf - so steht es in der Forschung.
    .sort((a, b) => b.anzahlInsider - a.anzahlInsider || b.summe - a.summe);
}

/* ---------- 5. Archiv (gleiches Muster wie kerzen_archiv.js) ---------- */

function archiviere(basisOrdner, eintraege) {
  if (!eintraege.length) return 0;
  const ordner = path.join(basisOrdner, "daten", "insider");
  fs.mkdirSync(ordner, { recursive: true });

  const proMonat = new Map();
  for (const e of eintraege) {
    const monat = (e.meldung || "").slice(0, 7);          // YYYY-MM
    if (!monat) continue;
    if (!proMonat.has(monat)) proMonat.set(monat, []);
    proMonat.get(monat).push(e);
  }

  const KOPF = "meldung,transaktion,verzoegerungTage,symbol,firma,inhaber,rolle,stueck,preis,summe,quelle";
  let neu = 0;
  for (const [monat, liste] of proMonat) {
    const datei = path.join(ordner, `insider_${monat}.csv`);
    const vorhanden = new Set();
    if (fs.existsSync(datei)) {
      for (const z of fs.readFileSync(datei, "utf8").split("\n").slice(1)) {
        if (z.trim()) vorhanden.add(schluessel(z.split(",")));
      }
    } else {
      fs.writeFileSync(datei, KOPF + "\n");
    }
    const zeilen = [];
    for (const e of liste) {
      const felder = [e.meldung, e.transaktion, e.verzoegerungTage, e.symbol,
        (e.firma || "").replace(/,/g, " "), (e.inhaber || "").replace(/,/g, " "),
        (e.rolle || "").replace(/,/g, " "), e.stueck, e.preis, e.summe, e.quelle];
      if (vorhanden.has(schluessel(felder))) continue;    // nie ueberschreiben
      vorhanden.add(schluessel(felder));
      zeilen.push(felder.join(","));
      neu++;
    }
    if (zeilen.length) fs.appendFileSync(datei, zeilen.join("\n") + "\n");
  }
  return neu;
}

function schluessel(f) {
  // Meldung + Symbol + Inhaber + Stueck identifiziert eine Transaktion eindeutig genug
  return [f[0], f[3], f[5], f[7]].join("|").trim();
}

module.exports = { sammle, buendle, archiviere, parseForm4, tagesFilings, normDatum, MIN_KAUF_USD };
