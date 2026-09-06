// ============================================================================
// KERZEN-ARCHIV - eigene Kurshistorie aufbauen
// ============================================================================
//
// Tiam, 2026-09-05: "ich will immer mehr und gute daten der KI geben."
//
// Das Problem, das dieses Modul loest: Yahoo liefert **5-Minuten-Kerzen nur
// 60 Tage rueckwirkend** (nachgemessen am 2026-09-05: 5m/60d = 17.233 Kerzen
// ab 08.07., alles darueber wird mit "must be within the last 60 days"
// abgelehnt). 1h reicht 2 Jahre, 1d sogar 5 - aber die Strategie entsteht auf
// 5min. Ein Rueckwaertstest ueber laengere Zeitraeume ist damit unmoeglich,
// und **jeder Tag, an dem nicht archiviert wird, ist unwiederbringlich weg**.
//
// Deshalb: bei jedem Lauf die ohnehin geholten 5min-Kerzen wegschreiben. Der
// Lauf holt 25 Tage (CHART_HISTORY_DAYS + FETCH_BUFFER_DAYS) und laeuft alle
// paar Minuten - die Ueberlappung ist also riesig, es kann nichts durchrutschen,
// selbst wenn Laeufe ausfallen.
//
// KEINE zusaetzlichen Netzabfragen: es werden nur Daten gespeichert, die
// ohnehin im Speicher liegen. Und **keine Aenderung an der Handelslogik** -
// das Modul liest nur mit, siehe Ruhephase.
//
// Format: eine CSV je Asset und Monat, `daten/5min/BTCUSD_2026-09.csv`.
// CSV statt JSON, weil es etwa halb so gross ist und git es zeilenweise
// vergleichen kann - bei taeglich wachsenden Dateien macht das den Unterschied
// zwischen brauchbarer und aufgeblaehter Repo-Historie.
//
// Zeitbasis: `ts` ist dieselbe Pseudo-Zeit wie ueberall in der Engine
// (ET-Wanduhr als UTC gelesen, siehe etPseudoDateStr in build.js). Bewusst
// NICHT umgerechnet - sonst waere das Archiv mit den Live-Daten unvergleichbar.

const fs = require("fs");
const path = require("path");

const KOPF = "ts,open,high,low,close,volume";

function monatsSchluessel(ts) {
  return new Date(ts).toISOString().slice(0, 7);   // 2026-09
}

function zeileAus(k) {
  // Volumen kann fehlen (Forex bei Yahoo) - dann 0 statt "undefined"
  return [k.ts, k.open, k.high, k.low, k.close, k.volume || 0].join(",");
}

function leseVorhandene(datei) {
  const map = new Map();
  if (!fs.existsSync(datei)) return map;
  const zeilen = fs.readFileSync(datei, "utf8").split("\n");
  for (const z of zeilen) {
    if (!z || z.startsWith("ts,")) continue;
    const ts = Number(z.slice(0, z.indexOf(",")));
    if (Number.isFinite(ts)) map.set(ts, z);
  }
  return map;
}

// Schreibt die Kerzen eines Assets in die Monatsdateien. Gibt zurueck, wie
// viele Zeilen NEU dazugekommen sind (0 = alles war schon da, Normalfall bei
// dicht getakteten Laeufen).
function archiviere(basisOrdner, symbol, kerzen) {
  if (!Array.isArray(kerzen) || !kerzen.length) return { neu: 0, dateien: [] };
  const ordner = path.join(basisOrdner, "daten", "5min");
  fs.mkdirSync(ordner, { recursive: true });

  // Kerzen nach Monat buendeln, damit jede Datei nur einmal geschrieben wird
  const nachMonat = new Map();
  for (const k of kerzen) {
    if (!k || !Number.isFinite(k.ts)) continue;
    const m = monatsSchluessel(k.ts);
    if (!nachMonat.has(m)) nachMonat.set(m, []);
    nachMonat.get(m).push(k);
  }

  let neu = 0;
  const dateien = [];
  const sicher = String(symbol).replace(/[^A-Za-z0-9]/g, "_");  // ^GSPC -> _GSPC
  for (const [monat, liste] of nachMonat) {
    const datei = path.join(ordner, `${sicher}_${monat}.csv`);
    const vorhanden = leseVorhandene(datei);
    const vorher = vorhanden.size;
    for (const k of liste) {
      // Vorhandene Zeitstempel NICHT ueberschreiben: die aelteste Fassung einer
      // Kerze ist die verlaesslichste. Yahoo korrigiert frische Kerzen
      // gelegentlich nach, und eine halbfertige Kerze vom Live-Abruf soll eine
      // bereits abgeschlossene nicht ersetzen.
      if (!vorhanden.has(k.ts)) { vorhanden.set(k.ts, zeileAus(k)); neu++; }
    }
    if (vorhanden.size === vorher) continue;   // nichts Neues, Datei unangetastet
    const sortiert = [...vorhanden.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    fs.writeFileSync(datei, KOPF + "\n" + sortiert.join("\n") + "\n", "utf8");
    dateien.push(path.basename(datei));
  }
  return { neu, dateien };
}

// Ueberblick fuer die Protokollausgabe: wie viel Historie liegt schon da?
function bestand(basisOrdner) {
  const ordner = path.join(basisOrdner, "daten", "5min");
  if (!fs.existsSync(ordner)) return { dateien: 0, zeilen: 0, von: null, bis: null };
  let zeilen = 0, von = null, bis = null;
  const dateien = fs.readdirSync(ordner).filter((f) => f.endsWith(".csv"));
  for (const f of dateien) {
    const inhalt = fs.readFileSync(path.join(ordner, f), "utf8").split("\n").filter((z) => z && !z.startsWith("ts,"));
    zeilen += inhalt.length;
    if (!inhalt.length) continue;
    const erst = Number(inhalt[0].split(",")[0]);
    const letzt = Number(inhalt[inhalt.length - 1].split(",")[0]);
    if (von === null || erst < von) von = erst;
    if (bis === null || letzt > bis) bis = letzt;
  }
  return {
    dateien: dateien.length, zeilen,
    von: von ? new Date(von).toISOString().slice(0, 10) : null,
    bis: bis ? new Date(bis).toISOString().slice(0, 10) : null,
  };
}

if (typeof module !== "undefined") {
  module.exports = { archiviere, bestand, monatsSchluessel, zeileAus };
}
