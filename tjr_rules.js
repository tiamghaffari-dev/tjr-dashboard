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
    check: (sig) => {
      if (!sig || !sig.zone) return { status: "unbekannt", detail: "Zonenlage nicht bestimmt" };
      const want = sig.bias === "bullish" ? "discount" : "premium";
      return sig.zone === want
        ? { status: "ok", detail: `Zone im ${sig.zone} - passt zum ${sig.bias}-Bias.` }
        : { status: "verletzt", detail: `Zone im ${sig.zone}, erwartet ${want} beim ${sig.bias}-Bias.` };
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
];

// ---------------------------------------------------------------------------
// Bekannte Luecken - bewusst NICHT als Regel formuliert, weil kein belegter
// Videofund vorliegt. Diese Liste ist genauso wichtig wie die Regeln selbst:
// sie haelt fest, wo die Engine auf eigener Konvention laeuft statt auf TJR.
// ---------------------------------------------------------------------------
const KNOWN_GAPS = [
  {
    id: "G1-daily-bias",
    title: "Wie TJR den Daily Bias tatsaechlich bestimmt",
    why: "Bootcamp Tag 34/35/36 (Daily Bias 1-3) sind reine Sprech- und Chart-Videos ohne "
      + "eingeblendete Notizen; die Tonspur ist nicht transkribierbar (Whisper-Modelle sind "
      + "im Sandbox-Proxy blockiert). Die Engine benutzt aktuell 'Richtung des letzten 4H-BOS' "
      + "als Bias - das ist eine eigene Vereinfachung, KEINE belegte TJR-Regel.",
    relevanz: "HOCH - die Obduktion zeigt 13x 'These war falsch' gegen 6x 'richtig'. "
      + "Genau hier liegt das groesste ungeloeste Problem.",
  },
  {
    id: "G2-key-level-touch",
    title: "\"wait for price to hit key level\" als Vorbedingung",
    why: "TJRs Checklist-Schritt a) verlangt, dass der Preis zuerst ein Key-Level (1H/4H-Liquiditaet, "
      + "Session-High/Low) erreicht. Die Engine startet stattdessen direkt beim 5min-Sweep und prueft "
      + "NICHT, ob dieser Sweep an einem uebergeordneten Key-Level stattfand.",
    relevanz: "MITTEL-HOCH - koennte erklaeren, warum Sweeps in beliebigen Zwischenbereichen "
      + "zu Fehlrichtungen fuehren. Vor einer Umsetzung erst gegen die Historie pruefen "
      + "(siehe die Lehre aus dem widerlegten Entry-Befund).",
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

if (typeof module !== "undefined") {
  module.exports = { TJR_RULES, KNOWN_GAPS, evaluateRules, ruleSummary };
}
