# TJR Live-Report — läuft ohne Laptop

Dieser Ordner ist ein fertiges GitHub-Repo. Einmal eingerichtet, aktualisiert
sich der Report alle 15 Minuten (Mo–Fr, 06:00–22:00 UTC) komplett automatisch
in der GitHub-Cloud — dein Laptop/Claude muss dafür nicht laufen.

Repo und Code sind bereits angelegt (Claude hat das erledigt). Es fehlen nur
noch zwei Schritte, die aus Sicherheitsgründen nur du selbst machen kannst.

## Wie es funktioniert

- `engine.js` — die TJR-Strategie-Logik (Bias/Sweep/BOS/Entry-Zone), 1:1 aus
  `tjr_engine.py` portiert.
- `build.js` — holt live Kursdaten direkt von der FMP-API (kein Cowork-Bridge
  nötig) und schreibt `docs/index.html`.
- `docs/report_template.html` — das Dashboard-Template (dunkles Design, Tabelle
  pro Asset statt Fließtext).
- `.github/workflows/update.yml` — GitHub Actions Workflow, der `build.js` nach
  Zeitplan ausführt und das Ergebnis committet.
- `docs/index.html` — die tatsächlich veröffentlichte Seite (wird von GitHub
  Pages ausgeliefert, entsteht automatisch beim ersten Workflow-Lauf).

## Was noch zu tun ist (ca. 5 Minuten)

1. **FMP-API-Key hinterlegen**:
   - Falls du bereits einen eigenen Financial-Modeling-Prep-API-Key hast
     (nicht den Cowork-Connector, sondern einen echten Key von
     financialmodelingprep.com), kannst du den nutzen.
   - Falls nicht: auf financialmodelingprep.com registrieren und im
     Dashboard einen API-Key erstellen. Für Crypto/Forex/Index/Commodity
     Intraday-Daten kann ein bezahlter Plan nötig sein (der kostenlose
     Plan ist bei manchen dieser Endpunkte eingeschränkt) — probier es
     zuerst mit dem kostenlosen Plan, falls Fehler auftauchen siehst du
     das direkt in der Actions-Log-Ausgabe oder als "FEHLER"-Karte im
     Report.
   - Im GitHub-Repo: **Settings → Secrets and variables → Actions →
     New repository secret**. Name: `FMP_API_KEY`, Wert: dein Key.

2. **GitHub Pages aktivieren**: **Settings → Pages** → unter "Build and
   deployment" → Source: "Deploy from a branch" → Branch: `main`,
   Ordner: `/docs` → Save.

3. **Workflow einmal manuell anstoßen** (nicht auf den ersten Cron-Lauf
   warten): Tab **Actions** → "Update TJR Report" → "Run workflow".

Nach wenigen Minuten ist die Seite live unter:
`https://tiamghaffari-dev.github.io/tjr-dashboard/`

Diesen Link kannst du dir als Lesezeichen speichern oder auf dem Handy
öffnen — er aktualisiert sich von selbst, unabhängig davon ob dein Laptop
an ist.

## Zeitplan anpassen

In `.github/workflows/update.yml` steht:
```
cron: "*/15 6-21 * * 1-5"
```
Das ist UTC-Zeit, alle 15 Minuten von 06:00–21:59 UTC, Montag–Freitag.
Wien ist aktuell (Sommerzeit) UTC+2, das deckt also ca. 08:00–23:59 Wiener
Zeit ab. Zeiten/Frequenz kannst du direkt in der Cron-Syntax anpassen.

## Unterschied zum Cowork-Dashboard

- Das Cowork-Live-Artifact und die Scheduled Tasks laufen nur, während
  Claude Desktop offen und der Laptop wach ist (offizielle Einschränkung,
  keine Cloud-Ausführung).
- Diese GitHub-Variante läuft komplett unabhängig in der GitHub-Cloud —
  dafür ohne die Cowork-typischen Extras (kein `window.cowork`-Bridge,
  kein direkter Chat-Zugriff auf die Seite). Die Signal-Logik ist exakt
  dieselbe.
