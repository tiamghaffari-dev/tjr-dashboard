// ============================================================================
// TJR-REGELWERK - maschinenlesbar, mit Quellenangabe
// ============================================================================
//
// Tiam, 2026-08-06: "ich will die KI selbstaendig haben [...] immer video auf
// fehler zurueck weisen um die nicht mehr zu machen."
//
// Zweck: TJRs Regeln liegen bisher NUR verstreut im Code (in buildSignal()
// eingebacken) oder gar nicht. Dadurch war nie pruefbar, ob ein Signal
// TJRs Vorgehen tatsaechlich entspricht - und die Engine konnte sich selbst
// nicht daran messen. Diese Datei macht jede Regel einzeln benennbar,
// quellenbelegt und automatisch pruefbar.
//
// WICHTIG - Herkunft und Ehrlichkeit:
// Die Engine kann die Videos NICHT lesen. Sie liegen als MP4 auf Tiams
// Rechner, die Engine laeuft auf GitHub-Servern. Jede Regel hier wurde von
// Hand aus Video-Standbildern abgeschrieben (TJR tippt seine Definitionen
// live auf den Chart) und traegt deshalb ein `source`-Feld mit Video und
// Fundstelle. `quote` ist woertlich abgeschrieben, NICHT paraphrasiert.
//
// Regeln, fuer die es KEINEN belegten Videofund gibt, stehen hier bewusst
// NICHT drin - lieber eine Luecke als eine erfundene Regel mit TJRs Namen
// drauf. Bekannte Luecken sind unten in KNOWN_GAPS dokumentiert.
//
// `check` gibt zurueck:
//   { status: "ok" | "verletzt" | "unbekannt", detail: "..." }
// "unbekannt" = die noetigen Daten lagen nicht vor (z.B. 1min-Fetch
// fehlgeschlagen) - ausdruecklich NICHT "ok", damit fehlende Daten nicht
// stillschweigend als Regelkonformitaet durchgehen.

// Seit 2026-08-14 zur Laufzeit setzbar (Selbstjustierung, siehe auto_tune.js).
// build.js ueberschreibt das beim Start mit dem Stand aus tuning.json; im
// Browser bleiben es die Ausgangswerte. Die Grenzen stehen in auto_tune.js.
const TUNING = { NEWS_FENSTER_MIN: 30, KEY_LEVEL_MAX_ADR: 0.15 };
function setRuleTuning(werte) {
  if (!werte) return;
  for (const k of Object.keys(TUNING)) {
    if (typeof werte[k] === "number") TUNING[k] = werte[k];
  }
}

const TJR_RULES = [
  {
    id: "R1-key-levels",
    area: "Vorbereitung",
    title: "Ziele und Referenzen sind echte Key-Level",
    quote: "1: key levels: 1hr, 4hr liq and session highs/lows",
    source: "Beginners Guide To Start Day Trading In 2026, Execution-Checklist (~3h22m+)",
    // Umgesetzt in engine.js: findProminentHtfSwingLevels() + Target-Suche.
    check: (sig) => {
      if (!sig || !sig.entry) return { status: "unbekannt", detail: "kein Signal" };
      if (sig.targetSource === "key-level") {
        return { status: "ok", detail: "Ziel liegt auf einem echten 4H-Key-Level." };
      }
      return {
        status: "verletzt",
        detail: "Ziel ist ein gerechnetes RR-Ziel, kein echtes Key-Level "
          + `(${sig.targetSource || "unbekannte Quelle"}). TJR nimmt Key-Level als Ziel.`,
      };
    },
  },
  {
    id: "R2-session",
    area: "Vorbereitung",
    title: "Nur in TJRs Handelsfenstern",
    quote: "2: times to trade: ny session 9:50-10:30 (forex 8:00am-10:00am) london session 3am-4am",
    source: "Beginners Guide, Execution-Checklist (~3h22m+); Sessions in US/Eastern",
    // Umgesetzt in build.js: isViennaTradingWindow() (09-10 und 15-17 Wien).
    check: (sig, ctx) => {
      if (!ctx || typeof ctx.inTradingWindow !== "boolean") {
        return { status: "unbekannt", detail: "Handelsfenster-Status nicht uebergeben" };
      }
      return ctx.inTradingWindow
        ? { status: "ok", detail: "Innerhalb London- bzw. NY-Fenster." }
        : { status: "verletzt", detail: "Ausserhalb der Handelsfenster - TJR handelt hier nicht." };
    },
  },
  {
    id: "R3-reversal-sweep",
    area: "Setup",
    title: "Umkehrsignal ist ein Liquidity Sweep",
    quote: "reversal: liq sweeps",
    source: "Beginners Guide, TJRs Framework-Glossar (~2h20m-3h22m)",
    check: (sig) => (sig && sig.sweep
      ? { status: "ok", detail: `Sweep gefunden (${sig.sweep.type}).` }
      : { status: "verletzt", detail: "Kein Liquidity Sweep - ohne Umkehrsignal kein TJR-Setup." }),
  },
  {
    id: "R4-confirmation",
    area: "Setup",
    title: "Bestaetigung durch BOS, iFVG oder SMT",
    quote: "confirmation: bos, ifvg, smt",
    source: "Beginners Guide, TJRs Framework-Glossar (~2h20m-3h22m)",
    check: (sig) => (sig && sig.confirmation
      ? { status: "ok", detail: `Bestaetigt durch ${sig.confirmation.kind}.` }
      : { status: "verletzt", detail: "Sweep ohne Bestaetigung - TJR steigt so nicht ein." }),
  },
  {
    id: "R5-continuation-zone",
    area: "Setup",
    title: "Einstieg in einer Continuation-Zone",
    quote: "continuation: fvgs, ob, bb, eq",
    source: "Beginners Guide, TJRs Framework-Glossar (~2h20m-3h22m)",
    check: (sig) => {
      const ok = ["FVG", "OrderBlock", "BreakerBlock", "Equilibrium"];
      if (!sig || !sig.zoneKind) return { status: "verletzt", detail: "Keine Entry-Zone bestimmt." };
      return ok.includes(sig.zoneKind)
        ? { status: "ok", detail: `Zone: ${sig.zoneKind}.` }
        : { status: "verletzt", detail: `Unbekannter Zonentyp: ${sig.zoneKind}.` };
    },
  },
  {
    id: "R6-discount-premium",
    area: "Setup",
    title: "Zone liegt im Discount (Long) bzw. Premium (Short)",
    quote: "Liq sweep + BOS + FVG/OB + EQ: [...] we waited for the price range that has either "
      + "a OB or FVG along with it bein in a discount to enter",
    source: "Bootcamp Tag 30 Ausfuehrung, Notizblock \"Putting The Pieces Together\" (~7min)",
    // ACHTUNG - hier lag am 2026-08-07 ein Fehler in DIESER Regel (nicht in der
    // Engine): geprueft wurde `sig.zone`. Dieses Feld beschreibt aber, wo der
    // AKTUELLE PREIS steht, nicht wo die Entry-Zone liegt (in buildSignal():
    // `premiumDiscountZone(legLow, legHigh, currentPrice)`). Ergebnis war ein
    // Fehlalarm bei GCUSD: Zone lag mit Mitte 4329.40 sauber im Discount
    // (Equilibrium 4340.30), nur der Preis war mit 4348.60 schon darueber
    // gelaufen. Haette man die Regel so scharf geschaltet, waeren voellig
    // gueltige Signale blockiert worden, sobald sich der Preis vom Einstieg
    // entfernt - was staendig vorkommt. Jetzt wird die ZONENMITTE gegen das
    // Equilibrium geprueft, so wie TJRs Zitat es meint.
    blocking: true,
    check: (sig, ctx) => {
      const eq = ctx && ctx.ann && ctx.ann.equilibrium;
      if (!sig || !Array.isArray(sig.zoneRange) || typeof eq !== "number") {
        return { status: "unbekannt", detail: "Zonenbereich oder Equilibrium nicht verfuegbar" };
      }
      const zoneMid = (sig.zoneRange[0] + sig.zoneRange[1]) / 2;
      const long = sig.bias === "bullish";
      const lage = zoneMid < eq ? "Discount" : "Premium";
      const passt = long ? zoneMid < eq : zoneMid > eq;
      return passt
        ? { status: "ok", detail: `Entry-Zone liegt im ${lage} (Mitte ${zoneMid.toFixed(2)} vs. Equilibrium ${eq.toFixed(2)}) - passt zum ${sig.bias}-Bias.` }
        : { status: "verletzt", detail: `Entry-Zone liegt im ${lage} (Mitte ${zoneMid.toFixed(2)} vs. Equilibrium ${eq.toFixed(2)}), erwartet ${long ? "Discount" : "Premium"} beim ${sig.bias}-Bias.` };
    },
  },
  {
    id: "R7-1min-confirmation",
    area: "Ausfuehrung",
    title: "1min-Bestaetigung vor dem Einstieg",
    quote: "d) wait for 1 min confirmation (bos, ifvg)  e) enter",
    source: "Beginners Guide, Execution-Checklist (~3h22m+)",
    check: (sig) => {
      if (!sig) return { status: "unbekannt", detail: "kein Signal" };
      if (!sig.m1Gate) {
        return { status: "unbekannt", detail: "Keine 1min-Daten verfuegbar - Gate uebersprungen." };
      }
      return sig.m1Confirmation
        ? { status: "ok", detail: `1min-Bestaetigung: ${sig.m1Confirmation.kind}.` }
        : { status: "verletzt", detail: "Noch keine 1min-Bestaetigung - TJR wartet hier." };
    },
  },
  {
    id: "R8-stop-placement",
    area: "Risiko",
    title: "Stop dort, wo die Trade-Idee widerlegt ist",
    quote: "f) stop loss where trade idea is wrong",
    source: "Beginners Guide, Execution-Checklist (~3h22m+); ergaenzend Bootcamp Tag 38: \"stop loss above liq sweep\"",
    check: (sig) => {
      if (!sig || !sig.entry || !sig.stop) return { status: "unbekannt", detail: "kein Stop gesetzt" };
      const long = sig.bias === "bullish";
      const richtig = long ? sig.stop < sig.entry : sig.stop > sig.entry;
      return richtig
        ? { status: "ok", detail: "Stop auf der Invalidierungsseite." }
        : { status: "verletzt", detail: "Stop liegt auf der falschen Seite des Einstiegs." };
    },
  },
  {
    id: "R9-daily-bias",
    area: "Bias",
    // NICHT blockierend - siehe Warnung unten. Diese Regel MISST nur.
    blocking: false,
    title: "Nicht gegen den Daily Bias handeln",
    // ACHTUNG, anders als R1-R8: das hier ist KEIN woertliches Zitat vom
    // Bildschirm, sondern sinngemaess aus einem maschinellen Transkript mit
    // erkennbaren Wortfehlern. Bewusst so gekennzeichnet.
    quote: "[sinngemaess, ASR-Transkript] \"we use the daily [...] to figure out my daily bias "
      + "[...] what is the daily market structure?\" - und: wer gegen den Daily Bias handelt, "
      + "\"[will] probably end up being a very short lived trade or you just losing\".",
    source: "Bootcamp Tag 34 \"Taegliche Voreingenommenheit\" (~00:00-02:30), eigenes "
      + "pocketsphinx-Transkript vom 2026-08-10 - fehlerbehaftet, KEIN woertliches Zitat. "
      + "Transkript liegt neben dem Video im Ordner tjr_videos.",
    check: (sig, ctx) => {
      const daily = ctx && ctx.dailyBias;
      if (!sig || !sig.bias || sig.bias === "neutral") {
        return { status: "unbekannt", detail: "Kein gerichteter Bias im Signal." };
      }
      if (!daily || !daily.bias) {
        return { status: "unbekannt", detail: "Keine Daily-Kerzen verfuegbar - Daily-Bias nicht bestimmbar." };
      }
      const wochen = ctx && ctx.weeklyTrend && ctx.weeklyTrend.bias
        ? `, Weekly ${ctx.weeklyTrend.bias}`
        : "";
      if (sig.bias === daily.bias) {
        return {
          status: "ok",
          detail: `Signal (${sig.bias}) stimmt mit der Daily-Struktur ueberein${wochen}.`,
        };
      }
      return {
        status: "verletzt",
        detail: `Signal ist ${sig.bias}, die Daily-Struktur aber ${daily.bias}${wochen}. `
          + "TJR wuerde diesen Trade nicht nehmen. Wird vorerst NUR protokolliert, nicht blockiert.",
      };
    },
  },
  {
    id: "R10-htf-vorrang",
    area: "Bias",
    blocking: false,
    title: "Bei Widerspruch hat der hoehere Zeitrahmen Vorrang",
    quote: "[sinngemaess, ASR-Transkript] \"if we raid[ed] structure to the downside [on] the day "
      + "but we're in a bull[ish] turn on a weekly, odds are it's going [to] be weekly [...] whatever "
      + "the h[igher] time[frame] is [...] higher power [...] going to cause the market [in] that "
      + "direction\" - und an anderer Stelle: \"fifteen minute break [of] structure -> one hour retrace "
      + "[...] four hour -> daily retrace [...] weekly retrace [...] [the] high[er] holds higher power\".",
    source: "Bootcamp Tag 36 \"Daily Bias pt. 3\" (zwei unabhaengige Stellen), eigenes "
      + "pocketsphinx-Transkript vom 2026-08-10 - fehlerbehaftet, KEIN woertliches Zitat. "
      + "Transkripte liegen neben den Videos im Ordner tjr_videos.",
    // Rangfolge nach TJR: Weekly > Daily > 4H. Die Engine triggert auf dem 4H,
    // also dem SCHWAECHSTEN der drei. R9 misst den Konflikt mit dem Daily,
    // R10 den mit dem Weekly - bewusst getrennt, damit die Befund-Validierung
    // beide Effekte unabhaengig voneinander messen kann, statt sie zu vermischen.
    check: (sig, ctx) => {
      const wk = ctx && ctx.weeklyTrend && ctx.weeklyTrend.structureBias;
      const daily = ctx && ctx.dailyBias && ctx.dailyBias.bias;
      if (!sig || !sig.bias || sig.bias === "neutral") {
        return { status: "unbekannt", detail: "Kein gerichteter Bias im Signal." };
      }
      if (!wk) {
        return { status: "unbekannt", detail: "Wochenstruktur nicht bestimmbar." };
      }
      if (sig.bias === wk) {
        const mit = daily && daily !== wk
          ? ` (Daily steht mit ${daily} dagegen - laut TJR schlaegt die Woche den Tag)`
          : "";
        return { status: "ok", detail: `Signal (${sig.bias}) laeuft mit der Wochenstruktur${mit}.` };
      }
      const zusatz = daily === sig.bias
        ? ` Das Daily (${daily}) stuetzt das Signal zwar, steht aber selbst gegen die Woche - `
          + "genau der Fall, den TJR beschreibt: die Woche gewinnt."
        : "";
      return {
        status: "verletzt",
        detail: `Signal ist ${sig.bias}, die Wochenstruktur aber ${wk}.${zusatz} `
          + "Wird vorerst NUR protokolliert, nicht blockiert.",
      };
    },
  },
  {
    id: "R11-kein-trade-nach-verlust",
    area: "Risiko",
    blocking: false,
    title: "Nach einem Verlust nicht sofort nachlegen",
    quote: "[sinngemaess, ASR-Transkript] \"do I want to get another trade in, [put] more risk on "
      + "the table? no [...] it just doesn't make sense to me to take another trade, especially with "
      + "[...] last week's losses [...] there's just no reason\".",
    source: "Bootcamp Tag 49 \"Taegliches Bias Backtesting + 9.000 $ Verlust SPX\", eigenes "
      + "pocketsphinx-Transkript vom 2026-08-10 - fehlerbehaftet, KEIN woertliches Zitat.",
    // Die STUNDENZAHL ist meine Setzung, nicht TJRs: er nennt keine Frist,
    // sondern lehnt im Video den Nachfolgetrade am selben Handelstag ab.
    // COOLDOWN_H = 12 bildet "nicht mehr am selben Tag" ab. Bewusst
    // nicht blockierend - erst messen, ob Trades kurz nach einem Verlust
    // wirklich schlechter laufen, dann ueber eine Sperre entscheiden.
    check: (sig, ctx) => {
      const COOLDOWN_H = 12;
      const ll = ctx && ctx.lastLoss;
      if (!sig || sig.signal !== "ENTRY") {
        return { status: "unbekannt", detail: "Nur fuer aktive ENTRY-Signale relevant." };
      }
      if (!ll || typeof ll.stundenHer !== "number") {
        return { status: "ok", detail: "Kein frueherer Verlust in diesem Wert protokolliert." };
      }
      if (ll.stundenHer < 0) {
        return { status: "unbekannt", detail: "Zeitabstand zum letzten Verlust unplausibel (negativ)." };
      }
      if (ll.stundenHer <= COOLDOWN_H) {
        return {
          status: "verletzt",
          detail: `Letzter Verlust liegt erst ${ll.stundenHer} h zurueck `
            + `(${typeof ll.rMultiple === "number" ? ll.rMultiple.toFixed(2) + "R" : "R unbekannt"}). `
            + "TJR legt nach einem Verlust nicht sofort nach. Wird vorerst NUR protokolliert.",
        };
      }
      return { status: "ok", detail: `Letzter Verlust ${ll.stundenHer} h her - Abstand ausreichend.` };
    },
  },
  {
    id: "R12-news-fenster",
    area: "Risiko",
    blocking: false,
    title: "Nicht kurz vor einer High-Impact-Nachricht einsteigen",
    quote: "[keine woertliche Regel von TJR] Abgeleitet daraus, dass er den Nachrichtenkalender "
      + "aktiv in seine Tagesanalyse einbezieht - Bootcamp Tag 48 ist eine Live-Bias-Analyse zu PPI, "
      + "Day 47 ein Backtest rund um CPI.",
    source: "Eigene Regel, KEIN Videobeleg fuer eine konkrete Zeitspanne. Die 30 Minuten sind "
      + "gesetzt, nicht belegt. Daten aus dem ForexFactory-Kalenderfeed (High Impact, USD/GBP).",
    // Gilt bewusst fuer ALLE Werte, nicht nur die Waehrungspaare: USD-Termine
    // bewegen auch Gold, den S&P und die Kryptos.
    check: (sig, ctx) => {
      const NEWS_FENSTER_MIN = TUNING.NEWS_FENSTER_MIN;
      const nn = ctx && ctx.newsSoon;
      if (!sig || sig.signal !== "ENTRY") {
        return { status: "unbekannt", detail: "Nur fuer aktive ENTRY-Signale relevant." };
      }
      if (!ctx || ctx.newsGeladen !== true) {
        return { status: "unbekannt", detail: "Nachrichtenkalender nicht verfuegbar." };
      }
      if (!nn) {
        return { status: "ok", detail: "Heute kein High-Impact-Termin mehr vor uns." };
      }
      if (nn.minuten <= NEWS_FENSTER_MIN) {
        return {
          status: "verletzt",
          detail: `${nn.event} (${nn.currency}) in ${nn.minuten} min. `
            + "So kurz davor bewegt die Nachricht den Kurs, nicht das Setup. Nur protokolliert.",
        };
      }
      return { status: "ok", detail: `Naechster Termin (${nn.event}) erst in ${nn.minuten} min.` };
    },
  },
  {
    id: "R13-sweep-am-key-level",
    area: "Setup",
    blocking: false,
    title: "Der Sweep muss an einem Key-Level stattfinden",
    quote: "a) wait for price to hit key level",
    source: "Beginners Guide, Execution-Checklist (~3h22m+) - WOERTLICH vom Bildschirm. "
      + "Zusammen mit Punkt 1 der Checkliste: \"key levels: 1hr, 4hr liq and session highs/lows\".",
    // Schliesst die dokumentierte Luecke G2. TJRs Checkliste beginnt damit, dass
    // der Kurs ZUERST ein uebergeordnetes Level erreicht - erst dann wird nach
    // dem Setup gesucht. Die Engine startete direkt beim 5min-Sweep und hat nie
    // geprueft, ob dieser ueberhaupt an einem Key-Level lag.
    //
    // Der Schwellwert ist MEINE Setzung, nicht TJRs: er sagt nicht, wie nah
    // "hit" ist. 0.15x Tagesrange entspricht grob dem, was auf einem Chart noch
    // als "am Level" durchgeht. Deshalb nicht blockierend - erst messen, ob
    // Sweeps fern jedes Levels wirklich schlechter laufen. Genau hier warnt
    // KNOWN_GAPS G2 auch ausdruecklich vor voreiliger Umsetzung.
    check: (sig) => {
      const MAX_ABSTAND_ADR = TUNING.KEY_LEVEL_MAX_ADR;
      if (!sig || !sig.sweep) {
        return { status: "unbekannt", detail: "Kein Sweep im Signal." };
      }
      const kl = sig.sweepKeyLevel;
      if (!kl || typeof kl.abstandAdr !== "number") {
        return { status: "unbekannt", detail: "Kein Key-Level oder keine Tagesrange verfuegbar." };
      }
      if (kl.abstandAdr <= MAX_ABSTAND_ADR) {
        return {
          status: "ok",
          detail: `Sweep lag am 4H-Level ${kl.level} (${kl.abstandAdr}x Tagesrange entfernt).`,
        };
      }
      return {
        status: "verletzt",
        detail: `Sweep lag ${kl.abstandAdr}x Tagesrange vom naechsten Key-Level (${kl.level}) entfernt - `
          + "also im Niemandsland. TJR startet erst, wenn der Kurs ein Level erreicht hat.",
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Confluence-Punktzahl (Tiam, 2026-08-12)
// ---------------------------------------------------------------------------
// Tiam: "es muessen eh ned alle regeln gelten also mehre sollten es schon sein
// aber alle wird meistens schwer."
//
// Richtig - aber nur fuer einen Teil der Regeln. R2-R8 sind KEINE optionalen
// Haken, sondern die Definition des Setups: ohne Liquidity Sweep, ohne
// Bestaetigung, ohne Continuation-Zone gibt es schlicht kein TJR-Trade. Die
// tauchen im Log immer als "ok" auf, weil sonst gar kein Signal entstanden
// waere - eine Punktzahl darueber waere eine Konstante.
//
// Was TJR "confluence" nennt, sind die zusaetzlichen Uebereinstimmungen
// obendrauf. Genau die sind hier gezaehlt. Damit laesst sich Tiams eigentliche
// Frage beantworten: reichen 3 von 5, oder braucht es 5 von 5?
const QUALITY_RULE_IDS = [
  "R1-key-levels",              // Ziel ist ein echtes Key-Level, kein gerechnetes
  "R9-daily-bias",              // Richtung stimmt mit dem Tageschart
  "R10-htf-vorrang",            // Richtung stimmt mit der Wochenstruktur
  "R11-kein-trade-nach-verlust",// kein frischer Verlust im selben Wert
  "R12-news-fenster",           // kein Nachrichtentermin unmittelbar bevor
  "R13-sweep-am-key-level",     // Sweep lag an einem echten Key-Level
];

// "unbekannt" zaehlt weder als erfuellt noch als moeglich - fehlende Daten
// duerfen die Punktzahl weder heben noch druecken.
function confluenceScore(results) {
  if (!Array.isArray(results)) return null;
  let erfuellt = 0, bewertbar = 0;
  const fehlend = [];
  for (const r of results) {
    if (!QUALITY_RULE_IDS.includes(r.id)) continue;
    if (r.status === "ok") { erfuellt++; bewertbar++; }
    else if (r.status === "verletzt") { bewertbar++; fehlend.push(r.id); }
  }
  if (!bewertbar) return null;
  return { erfuellt, bewertbar, fehlend };
}

// ---------------------------------------------------------------------------
// Bekannte Luecken - bewusst NICHT als Regel formuliert, weil kein belegter
// Videofund vorliegt. Diese Liste ist genauso wichtig wie die Regeln selbst:
// sie haelt fest, wo die Engine auf eigener Konvention laeuft statt auf TJR.
// ---------------------------------------------------------------------------
const KNOWN_GAPS = [
  {
    id: "G1-daily-bias",
    title: "Wie TJR den Daily Bias tatsaechlich bestimmt",
    why: "TEILWEISE GESCHLOSSEN am 2026-08-10. Bootcamp Tag 34 wurde selbst transkribiert "
      + "(pocketsphinx, da Whisper im Sandbox-Proxy blockiert ist; Transkript liegt neben dem "
      + "Video). Ergebnis: TJR arbeitet TOP-DOWN Weekly -> Daily -> 4H -> 15/5min und leitet den "
      + "Bias aus der DAILY-Marktstruktur ab, nicht aus dem 4H. Die Engine benutzt weiterhin "
      + "'Richtung des letzten 4H-BOS' als Trigger-Bias; der Daily-Bias wird seit 2026-08-10 "
      + "parallel berechnet und ueber Regel R9 mitprotokolliert - NICHT blockierend, weil die "
      + "Quelle ein fehlerbehaftetes Transkript ist und kein Bildschirmzitat.",
    relevanz: "HOCH - die Obduktion zeigt 13x 'These war falsch' gegen 6x 'richtig'. "
      + "Naechster Schritt: sobald genug Trades mit R9-Status vorliegen, per Befund-Validierung "
      + "in history.html messen, ob 'stimmt mit Daily ueberein' wirklich mit Gewinnen korreliert. "
      + "ERST DANN scharf schalten, und nur mit Tiams Zustimmung. Offen bleibt TJRs zweite "
      + "Bias-Komponente, der 'draw on liquidity' (wohin der Kurs gezogen wird) - dafuer muessen "
      + "Tag 35/36 und die Live-Bias-Videos transkribiert werden.",
  },
  {
    id: "G2-key-level-touch",
    title: "\"wait for price to hit key level\" als Vorbedingung",
    why: "GESCHLOSSEN am 2026-08-12 durch Regel R13. Die Engine misst jetzt den Abstand des "
      + "gesweepten Levels zum naechsten prominenten 4H-Level, normiert auf die Tagesrange. "
      + "Der Schwellwert (0.15x) ist eine eigene Setzung - TJR sagt nicht, wie nah \"hit\" ist.",
    relevanz: "Wird ab jetzt gemessen statt vermutet. R13 ist bewusst nicht blockierend, bis die "
      + "Auswertung zeigt, ob Sweeps fern jedes Levels wirklich schlechter laufen.",
  },
];

function evaluateRules(sig, ctx) {
  return TJR_RULES.map((r) => {
    let res;
    try {
      res = r.check(sig, ctx || {});
    } catch (e) {
      res = { status: "unbekannt", detail: `Pruefung fehlgeschlagen: ${e && e.message}` };
    }
    return {
      id: r.id, area: r.area, title: r.title, quote: r.quote, source: r.source,
      status: res.status, detail: res.detail,
    };
  });
}

// Kompakte Bilanz fuer die Anzeige.
function ruleSummary(results) {
  const n = (s) => results.filter((r) => r.status === s).length;
  return { ok: n("ok"), verletzt: n("verletzt"), unbekannt: n("unbekannt"), gesamt: results.length };
}

// ---------------------------------------------------------------------------
// Scharf geschaltete Regeln (Tiam, 2026-08-07: "ich moechte das sie
// selbststaendig wird").
//
// Nur Regeln mit `blocking: true` duerfen ein ENTRY tatsaechlich verhindern -
// und nur bei Status "verletzt", NIE bei "unbekannt". Fehlende Daten sind kein
// Regelverstoss; sonst wuerde ein Datenausfall stillschweigend alle Signale
// abwuergen (dieselbe Vorsicht wie beim 1min-Gate in engine.js).
//
// Bewusst konservativ: aktuell ist nur R6 (Discount/Premium) blockierend. Die
// Regel ist woertlich belegt ("along with it bein in a discount to enter") und
// binaer pruefbar - im Gegensatz zu statistischen Befunden aus der Obduktion,
// die sich als Scheinkorrelation erweisen koennen (siehe der widerlegte
// "Entry zu frueh"-Befund). Weitere Regeln erst scharf schalten, wenn sie
// denselben Beleg-Standard erfuellen.
function blockingViolations(results) {
  const ids = new Set(TJR_RULES.filter((r) => r.blocking).map((r) => r.id));
  return results.filter((r) => ids.has(r.id) && r.status === "verletzt");
}

if (typeof module !== "undefined") {
  module.exports = { TJR_RULES, KNOWN_GAPS, evaluateRules, ruleSummary, blockingViolations,
    confluenceScore, QUALITY_RULE_IDS, setRuleTuning, TUNING };
}
