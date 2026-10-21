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
const TAGE_NOTFALL = 7;          // zweiter Versuch, wenn ein Thema leer bleibt

/* Die Themenabfrage laeuft zweimal: erst ueber drei Tage, und fuer jedes
 * Thema, das danach leer ist, noch einmal ueber sieben. Der Grund steht im
 * dritten Livelauf: nach dem Klickware-Filter blieb beim Thema Krypto gar
 * nichts uebrig, weil die deutschsprachige Krypto-Berichterstattung in den
 * zugelassenen Redaktionen duenn ist und die Suchtreffer von Kaufratgebern
 * belegt waren. Lieber eine vier Tage alte echte Meldung als gar keine -
 * das Datum steht ohnehin bei jeder Zeile. */

/* Redaktionen, deren Ueberschriften hier erscheinen duerfen. Bewusst kurz
 * und bewusst ohne Portale, die vom Klick auf Anlageprodukte leben. */
const ERLAUBTE_QUELLEN = [
  "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "wsj.com",
  "handelsblatt.com", "faz.net", "sueddeutsche.de", "zeit.de", "spiegel.de",
  "tagesschau.de", "n-tv.de", "manager-magazin.de", "boerse-online.de",
  "derstandard.at", "diepresse.com", "orf.at", "kurier.at", "krone.at",
  "nzz.ch", "cash.ch", "wiwo.de", "capital.de", "finanzmarktwelt.de",
  "br.de", "zdf.de", "dw.com", "euronews.com", "cnbc.com", "heise.de", "golem.de",
];

/* Jedes Thema sagt dazu, welche von Tiams Werten es ueberhaupt betrifft.
 * Diese Zuordnung ist der ganze Zweck der Uebung - eine Schlagzeile ohne
 * Bezug zu einem seiner Maerkte ist fuer ihn nur Rauschen. */
const THEMEN = [
  { name: "Krypto", frage: "Bitcoin OR Kryptomarkt OR Kryptowährungen OR Ethereum OR Krypto-Regulierung",
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

function feedUrl(frage, tage) {
  const q = encodeURIComponent(frage + " when:" + (tage || TAGE_ZURUECK) + "d");
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
  /* Dritte Runde: n-tv liefert automatisch erzeugte Produktseiten fuer
   * Hebelzertifikate ("BITCOIN Turbo S 39.7938 open end (HSBC) | Kurs,
   * Chart, Analysen | DE000HT8C950"). Das sind keine Nachrichten, und es
   * sind ausgerechnet die Produkte, bei denen ein Totalverlust eingebaut
   * ist. Erkennbar an der ISIN im Titel und am Produktnamen. */
  /\b[A-Z]{2}[A-Z0-9]{9}\d\b/,
  /\|\s*kurs,?\s*chart/i,
  /\b(turbo|knock[- ]?out|optionsschein|faktor[- ]?zertifikat|open end)\b/i,
  /\bfaktor\s*\d+\s*x\b|\bhebel\s*\d+/i,
  /\bcrash-?(risiko|gefahr)\b/i,
];

function fuellware(titel) {
  return FUELLWARE.some((m) => m.test(String(titel || "")));
}

/* Regionalausgaben: "kaernten.ORF.at" ist formal orf.at, liefert aber
 * Lokalnachrichten ohne jeden Marktbezug. Die Hauptredaktionen bleiben. */
const REGIONAL = /^(kaernten|wien|steiermark|ooe|noe|salzburg|tirol|vorarlberg|burgenland)\./i;

function erlaubt(host) {
  if (!host) return false;
  if (REGIONAL.test(host)) return false;
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

/* Entdopplung ueber die ersten Buchstaben. Ziffern fliegen bewusst mit
 * raus: dieselbe Meldung erschien einmal als "Fuenf-Monats-Hoch" und einmal
 * als "5-Monatshoch" und rutschte zweimal durch. */
function schluessel(titel) {
  return String(titel)
    // "Dax aktuellDax dreht" - in zusammengeklebten Titeln fehlt das
    // Leerzeichen, sonst faellt die Entdopplung darueber auseinander.
    .replace(/([a-zäöüß])([A-ZÄÖÜ])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-zäöüß]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 45);
}

async function sammle() {
  const gesehen = new Set();
  const themen = [];
  const fehler = [];
  const zaehler = { roh: 0, erlaubt: 0, fuellware: 0 };

  /* Holt ein Thema fuer ein bestimmtes Zeitfenster und reicht nur das
     durch, was Quelle, Klickware-Filter und Entdopplung ueberlebt. */
  async function hole(t, tage) {
    const grenze = Date.now() - tage * 86400 * 1000;
    const roh = parseFeed(await holeFeed(feedUrl(t.frage, tage)));
    zaehler.roh += roh.length;

    const raus = [];
    for (const n of roh) {
      if (n.zeit < grenze) continue;
      if (!erlaubt(n.host)) continue;
      zaehler.erlaubt++;
      if (fuellware(n.titel)) { zaehler.fuellware++; continue; }
      const s = schluessel(n.titel);
      if (gesehen.has(s)) continue;      // dieselbe Meldung nicht unter zwei Themen
      gesehen.add(s);
      raus.push({
        titel: n.titel, link: n.link, quelle: n.quelle,
        zeitIso: new Date(n.zeit).toISOString(),
      });
      if (raus.length >= PRO_THEMA) break;
    }
    return raus;
  }

  for (const t of THEMEN) {
    let eintraege, weiterFenster = false;
    try {
      eintraege = await hole(t, TAGE_ZURUECK);
    } catch (e) {
      fehler.push(t.name + ": " + (e && e.message ? e.message : e));
      themen.push({ name: t.name, betrifft: t.betrifft, ok: false, eintraege: [] });
      continue;
    }
    // Leer geblieben? Dann noch einmal mit groesserem Zeitfenster.
    if (!eintraege.length) {
      try {
        eintraege = await hole(t, TAGE_NOTFALL);
        weiterFenster = eintraege.length > 0;
      } catch (e) {
        fehler.push(t.name + " (zweiter Versuch): " + (e && e.message ? e.message : e));
      }
    }
    themen.push({ name: t.name, betrifft: t.betrifft, ok: true, eintraege,
                  tage: weiterFenster ? TAGE_NOTFALL : TAGE_ZURUECK });
  }

  const mitInhalt = themen.filter((t) => t.eintraege.length).length;
  if (!mitInhalt && fehler.length === THEMEN.length) {
    throw new Error("alle Feeds ausgefallen: " + fehler.join(" | "));
  }

  return {
    ok: true,
    themen,
    tageZurueck: TAGE_ZURUECK,
    tageNotfall: TAGE_NOTFALL,
    anzahl: themen.reduce((s, t) => s + t.eintraege.length, 0),
    themenMitInhalt: mitInhalt,
    gepruefteMeldungen: zaehler.roh,
    ausErlaubtenQuellen: zaehler.erlaubt,
    alsFuellwareVerworfen: zaehler.fuellware,
    quellenAnzahl: ERLAUBTE_QUELLEN.length,
    fehler,
  };
}

module.exports = { sammle, THEMEN, ERLAUBTE_QUELLEN, FUELLWARE, parseFeed, erlaubt, fuellware, schluessel, feedUrl };
