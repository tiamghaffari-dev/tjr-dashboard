# TJR Live-Report — läuft ohne Laptop

Dieser Ordner ist ein fertiges GitHub-Repo. Einmal eingerichtet, aktualisiert
sich der Report alle 15 Minuten (Mo–Fr, 06:00–22:00 UTC) komplett automatisch
in der GitHub-Cloud — dein Laptop/Claude muss dafür nicht laufen.

Repo, Code und GitHub Pages sind bereits eingerichtet (hat Claude erledigt).
Es fehlen nur noch die zwei API-Keys, die aus Sicherheitsgründen nur du
selbst eintragen kannst.

## Wie es funktioniert

- `engine.js` — die TJR-Strategie-Logik (Bias/Sweep/BOS/Entry-Zone), 1:1 aus
  `tjr_engine.py` portiert. Rein mechanisch, kein KI-Bestandteil — das ist
  die rückgetestete Basis.
- `build.js` — holt live Kursdaten direkt von der FMP-API und schreibt
  `docs/index.html`. Wenn `ANTHROPIC_API_KEY` gesetzt ist, holt es zusätzlich
  pro Asset eine kurze KI-Einschätzung (Claude Haiku) als ergänzenden
  Kommentar — diese ersetzt nie das mechanische Signal, nur eine zusätzliche
  Karte im Report.
- `docs/report_template.html` — das Dashboard-Template (dunkles Design,
  Tabelle pro Asset statt Fließtext, plus optionaler KI-Kommentar-Block).
- `.github/workflows/update.yml` — GitHub Actions Workflow, der `build.js`
  nach Zeitplan ausführt und das Ergebnis committet.
- `docs/index.html` — die tatsächlich veröffentlichte Seite (wird von GitHub
  Pages ausgeliefert, entsteht automatisch beim ersten Workflow-Lauf).

## Was noch zu tun ist (ca. 5 Minuten)

1. **FMP-API-Key hinterlegen** (Pflicht — ohne den läuft gar nichts):
   - Falls du bereits einen eigenen Financial-Modeling-Prep-API-Key hast
     (nicht den Cowork-Connector, sondern einen echten Key von
     financialmodelingprep.com), kannst du den nutzen.
   - Falls nicht: auf financialmodelingprep.com registrieren und im
     Dashboard einen API-Key erstellen. Für Crypto/Forex/Index/Commodity
     Intraday-Daten kann ein bezahlter Plan nötig sein (der kostenlose Plan
     ist bei manchen dieser Endpunkte eingeschränkt) — probier es zuerst
     mit dem kostenlosen Plan, falls Fehler auftauchen siehst du das direkt
     in der Actions-Log-Ausgabe oder als "FEHLER"-Karte im Report.
   - Im GitHub-Repo: **Settings → Secrets and variables → Actions →
     New repository secret**. Name: `FMP_API_KEY`, Wert: dein Key.

2. **Anthropic-API-Key hinterlegen** (optional — nur für die KI-Einschätzung;
   ohne diesen Key läuft der Report trotzdem, nur ohne die zusätzliche
   KI-Karte):
   - Key erstellen auf console.anthropic.com (kostenpflichtig nach
     Verbrauch, aber bei Claude Haiku und alle 15 Min für 6 Assets nur ein
     paar Cent bis wenige Euro pro Monat).
   - Gleicher Weg wie oben: **Settings → Secrets and variables → Actions →
     New repository secret**. Name: `ANTHROPIC_API_KEY`, Wert: dein Key.

3. **Workflow einmal manuell anstoßen** (nicht auf den ersten Cron-Lauf
   warten): Tab **Actions** → "Update TJR Report" → "Run workflow".

Nach wenigen Minuten ist die Seite live unter:
`https://tiamghaffari-dev.github.io/tjr-dashboard/`

Diesen Link kannst du dir als Lesezeichen speichern oder auf dem Handy
öffnen — er aktualisiert sich von selbst, unabhängig davon ob dein Laptop
an ist.

## Zeitplan anpassen

In `.github/workflows/update.yml` stehen drei Cron-Zeilen (UTC, Wien ist
aktuell Sommerzeit = UTC+2):
```
- cron: "*/15 6-12 * * 1-5"   # 08:00-14:59 Wien: alle 15 Minuten
- cron: "*/5 13-14 * * 1-5"   # 15:00-16:59 Wien: alle 5 Minuten (Fokusfenster)
- cron: "*/15 15-21 * * 1-5"  # 17:00-23:59 Wien: wieder alle 15 Minuten
```
Zwischen 15 und 17 Uhr Wiener Zeit läuft der Report also alle 5 statt alle
15 Minuten. Zeiten/Frequenz kannst du direkt in der Cron-Syntax anpassen —
GitHub Actions erlaubt praktisch keine kürzeren Abstände als 5 Minuten.

## Unterschied zum Cowork-Dashboard

- Das Cowork-Live-Artifact und die Scheduled Tasks laufen nur, während
  Claude Desktop offen und der Laptop wach ist (offizielle Einschränkung,
  keine Cloud-Ausführung).
- Diese GitHub-Variante läuft komplett unabhängig in der GitHub-Cloud —
  dafür ohne die Cowork-typischen Extras (kein `window.cowork`-Bridge,
  kein direkter Chat-Zugriff auf die Seite). Die mechanische Signal-Logik
  ist exakt dieselbe; die KI-Einschätzung ist neu und rein ergänzend.

## Wichtig: KI-Einschätzung ist keine Anlageberatung

Die optionale KI-Karte ist eine zusätzliche, unverbindliche fachliche
Einordnung — kein Kauf-/Verkaufssignal, keine Anlageberatung. Die
mechanische Regel-Engine (rückgetestet, siehe Backtest-Report im
Trading-Ordner) bleibt die eigentliche Entscheidungsgrundlage.
