/* marktlage_nachrichten.js
 *
 * Schlagzeilen zu den Themen, die Tiams Maerkte bewegen.
 *
 * Tiams Wunsch vom 21.10.2026: "was gerade abgeht in der Welt, wo welcher
 * Markt beeinflusst werden kann". Das hier ist der Nachrichten-Teil davon.
 *
 * WAS DAS IST: eine Liste von Ueberschriften aus etablierten Redaktionen,
 * nach Thema sortiert, mit dem Datum und der Quelle. Mehr nicht.
 *
 * WAS DAS AUSDRUECKLICH NICHT IST: eine Bewertung. Hier steht nicht, ob eine
 * Nachricht gut oder schlecht fuer einen Kurs ist, und erst recht nicht, ob
 * man deswegen kaufen soll. Der Grund steht in Tiams eigenen Daten:
 * Rheinmetall fiel von 1.550 auf 976 Euro, waehrend die Aufruestungs-Meldungen
 * durchgehend positiv waren. Was in der Zeitung steht, steht im Preis.
 *
 * QUELLEN: Google-News-RSS auf Deutsch, danach nach Herausgeber gefiltert.
 * Die Suche selbst ist unbeschraenkt - gefiltert wird erst das Ergebnis, an
 * einer festen Liste von Redaktionen. Damit landen "Diese 3 Aktien explodieren
 * jetzt"-Seiten nicht auf der Seite. Faellt ein Thema aus, bleiben die
 * anderen; fallen alle aus, sagt die Seite das, statt eine leere Liste wie
 * "keine Nachrichten" aussehen zu lassen.
 */

const TAGE_ZURUECK = 3;
const PRO_THEMA = 3;
const ZEITFENSTER = "when:" + TAGE_ZURUECK + "d";

/* Redaktionen, deren Ueberschriften hier erscheinen duerfen. Bewusst kurz
 * und bewusst ohne Portale, die vom Klick auf Anlageprodukte leben. */
const ERLAUBTE_QUELLEN = [
  "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "wsj.com",
  "handelsblatt.com", "faz.net", "sueddeutsche.de", "zeit.de", "spiegel.de",
  "tagesschau.de", "n-tv.de", "manager-magazin.de", "boerse-online.de",
  "derstandard.at", "diepresse.com", "orf.at", "kurier.at", "krone.at",
  "nzz.ch", "cash.ch", "wiwo.de", "capital.de", "finanzmarktwelt.de",
  "br.de", "zdf.de", "dw.com", "euronews.com", "cnbc.com",
];

/* Jedes Thema sagt dazu, welche von Tiams Werten es ueberhaupt betrifft.
 * Diese Zuordnung ist der ganze Zweck der Uebung - eine Schlagzeile ohne
 * Bezug zu einem seiner Maerkte ist fuer ihn nur Rauschen. */
const THEMEN = [
  { name: "Krypto", frage: "Bitcoin OR Kryptowaehrung OR Ethereum",
    betrifft: ["Bitcoin", "Ethereum", "XRP"] },
  { name: "Aktienmärkte", frage: "Börse OR \"Wall Street\" OR \"S&P 500\" OR Dax",
    betrifft: ["S&P 500", "Nasdaq", "DAX", "breite ETFs"] },
  { name: "Zinsen und Notenbanken", frage: "Leitzins OR EZB OR \"Federal Reserve\" OR Inflation",
    betrifft: ["GBP/USD", "Gold", "S&P 500", "breite ETFs"] },
  { name: "Gold und Rohstoffe", frage: "Goldpreis OR Ölpreis OR Rohstoffe",
    betrifft: ["Gold", "Energie-ETFs"] },
  { name: "Rüstung", frage: "Rüstung OR Verteidigungsausgaben OR Rheinmetall",
    betrifft: ["Rheinmetall", "Hensoldt", "Rüstungs-ETFs"] },
  { name: "Weltlage", frage: "Trump Zölle OR Handelskrieg OR Ukraine OR Nahost",
    betrifft: ["praktisch alles"] },
];

function feedUrl(frage) {
  const q = encodeURIComponent(frage + " " + ZEITFENSTER);
  return "https://news.google.com/rss/search?q=" + q + "&hl=de&gl=AT&ceid=AT:de";
}

async function holeFeed(url) {
  const antwort = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tjr-dashboard marktlage)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!antwort.ok) throw new Error("HTTP " + antwort.status);
  const text = await antwort.text();
  if (text.indexOf("<item>") < 0 && text.indexOf("<item ") < 0) {
    throw new Error("kein RSS-Inhalt");
  }
  return text;
}

/* Winziger RSS-Leser. Eine XML-Bibliothek waere hier Mehrgewicht fuer
 * vier Felder, und der Feed hat ein festes Format. */
function entschaerfe(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function feld(block, tag) {
  const m = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"));
  return m ? entschaerfe(m[1]) : null;
}

function quellHost(block) {
  const m = block.match(/<source[^>]*url="([^"]+)"/);
  if (!m) return null;
  try {
    return new URL(m[1]).hostname.replace(/^www\./, "").toLowerCase();
  } catch (e) {
    return null;
  }
}

/* Auch serioese Redaktionen produzieren Suchmaschinen-Fuellware: Countdowns,
 * Kursziele, "so viel waeren aus 1.000 Euro geworden". Das sind keine
 * Nachrichten, sondern Klickware, und genau das Genre, vor dem Tiam auf
 * dieser Seite ohnehin gewarnt wird. Darum ein zweiter Filter auf die
 * Ueberschrift selbst. Bewusst eng gefasst: "Prognose" allein bleibt drin,
 * weil "IWF senkt Prognose" eine echte Meldung ist. */
const FUELLWARE = [
  /live[- ]?(kurs|countdown|ticker|chart)/i,
  /kursziel|kursprognose|preisprognose|kursentwicklung bis/i,
  /jetzt (kaufen|einsteigen|zugreifen|verkaufen)/i,
  /\b(kaufen|einsteigen|verkaufen|investieren)\s*\?/i,
  /diese\s+\d+\s+(aktien|coins|etfs|werte)/i,
  /\btop\s*\d+\b/i,
  /so viel (w(ä|ae)re|h(ä|ae)tten|bekommst|bekommen)/i,
  /aus\s+[\d.]+\s*(euro|dollar)\s+(w(ä|ae)ren|geworden)/i,
  /explodier|verzehnfach|vervielfach|rakete|geheimtipp/i,
  /was anleger jetzt (tun|wissen|beachten)/i,
  /(halving|hal\u00adving)\s*20\d\d/i,
  /\bprognose\s+20\d\d\b/i,
  /lohnt sich (ein|der|das) (einstieg|kauf)/i,
  /* Zweite Runde nach dem ersten Livelauf: der Krypto-Block bestand
   * komplett aus "Bitcoin kaufen"-Ratgebern einer serioesen Zeitung.
   * Kaufanleitungen und Anbietervergleiche sind Werbeumfeld, keine
   * Nachrichten. */
  /\b(bitcoin|ethereum|xrp|solana|krypto\w*|aktien|etfs?|gold|silber)\s+kaufen\b/i,
  /\bkaufen\s+(in|bei|f(ü|ue)r|20\d\d)\b/i,
  /seri(ö|oe)se\s+anbieter|anbieter(vergleich|test)|brokervergleich|broker[- ]test/i,
  /\banleitung\b|\bratgeber\b|\bschritt f(ü|ue)r schritt\b/i,
  /\bvergleich\s+20\d\d\b|\bbeste[nrs]?\s+(anbieter|broker|plattform)/i,
  /wo (kann man|kaufe ich|kauft man)/i,
  /\w-prognose\b/i,
];

function fuellware(titel) {
  return FUELLWARE.some((m) => m.test(String(titel || "")));
}

function erlaubt(host) {
  if (!host) return false;
  return ERLAUBTE_QUELLEN.some((q) => host === q || host.endsWith("." + q));
}

function parseFeed(xml) {
  const bloecke = xml.split(/<item[\s>]/).slice(1);
  const raus = [];
  for (const roh of bloecke) {
    const block = "<item>" + roh;
    const titelRoh = feld(block, "title");
    const link = feld(block, "link");
    const datum = feld(block, "pubDate");
    if (!titelRoh || !link || !datum) continue;
    const zeit = Date.parse(datum);
    if (!isFinite(zeit)) continue;

    const host = quellHost(block);
    // Google haengt " - Quelle" an jede Ueberschrift. Weg damit, die Quelle
    // steht ohnehin eigens daneben.
    const quelle = feld(block, "source");
    let titel = titelRoh;
    if (quelle && titel.endsWith(" - " + quelle)) {
      titel = titel.slice(0, -(" - " + quelle).length).trim();
    }
    raus.push({ titel, link, zeit, quelle: quelle || host, host });
  }
  return raus;
}

function schluessel(titel) {
  return String(titel).toLowerCase().replace(/[^a-zäöüß0-9]+/g, " ").trim().slice(0, 60);
}

async function sammle() {
  const grenze = Date.now() - TAGE_ZURUECK * 86400 * 1000;
  const gesehen = new Set();
  const themen = [];
  const fehler = [];
  let gesamtRoh = 0, gesamtErlaubt = 0, gesamtFuellware = 0;

  for (const t of THEMEN) {
    let roh;
    try {
      roh = parseFeed(await holeFeed(feedUrl(t.frage)));
    } catch (e) {
      fehler.push(t.name + ": " + (e && e.message ? e.message : e));
      themen.push({ name: t.name, betrifft: t.betrifft, ok: false, eintraege: [] });
      continue;
    }
    gesamtRoh += roh.length;

    const eintraege = [];
    for (const n of roh) {
      if (n.zeit < grenze) continue;
      if (!erlaubt(n.host)) continue;
      gesamtErlaubt++;
      if (fuellware(n.titel)) { gesamtFuellware++; continue; }
      const s = schluessel(n.titel);
      if (gesehen.has(s)) continue;      // dieselbe Meldung nicht unter zwei Themen
      gesehen.add(s);
      eintraege.push({
        titel: n.titel, link: n.link, quelle: n.quelle,
        zeitIso: new Date(n.zeit).toISOString(),
      });
      if (eintraege.length >= PRO_THEMA) break;
    }
    themen.push({ name: t.name, betrifft: t.betrifft, ok: true, eintraege });
  }

  const mitInhalt = themen.filter((t) => t.eintraege.length).length;
  if (!mitInhalt && fehler.length === THEMEN.length) {
    throw new Error("alle Feeds ausgefallen: " + fehler.join(" | "));
  }

  return {
    ok: true,
    themen,
    tageZurueck: TAGE_ZURUECK,
    anzahl: themen.reduce((s, t) => s + t.eintraege.length, 0),
    themenMitInhalt: mitInhalt,
    gepruefteMeldungen: gesamtRoh,
    ausErlaubtenQuellen: gesamtErlaubt,
    alsFuellwareVerworfen: gesamtFuellware,
    quellenAnzahl: ERLAUBTE_QUELLEN.length,
    fehler,
  };
}

module.exports = { sammle, THEMEN, ERLAUBTE_QUELLEN, FUELLWARE, parseFeed, erlaubt, fuellware, schluessel, feedUrl };
