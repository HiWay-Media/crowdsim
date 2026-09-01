# AGENTS.md — crowdsim

Repo **pubblico** su GitHub (`github.com/HiWay-Media/crowdsim`, MIT): simulatore di carico per eventi
live. Driver bash (`bin/crowdsim`) + generatore k6 (`k6/live-event.js`, con la logica pura in `k6/lib/`)
guidati da un **profilo JSON** (mix di classi di richiesta, pool di URL, header di cache, SLO, allowlist
di sicurezza). Contorno: GUI (`gui/server` Express + `gui/ui` React/Vite, subcomando `serve`), test
(`tests/unit` node:test, `tests/cli` bats, `tests/gui` node:test, `tests/e2e` nginx locale + k6 reale),
`Dockerfile`, job Nomad parametrizzato (`ci/nomad/`), harness A/B cache (`cache-ab/`),
`profiles/example.json`.

Questo file definisce le regole operative per gli agent (Copilot, Claude, altri tool AI) quando lavorano
in questo repository.

## Regole di lavoro (SEMPRE)

- **Ogni modifica = una release**, e si fa con lo script, non a mano:
  `scripts/new-release.sh prepare <minor|patch|major|X.Y.Z>` -> scrivi la sezione di CHANGELOG (in
  **inglese**: repo pubblico) -> commit -> `scripts/new-release.sh tag`. Lo script bumpa root + workspaces +
  lock, rifiuta placeholder / tree sporco / versione non allineata, e **non pusha**. Al push del tag partono
  `release.yml` (GitHub Release con quelle note) e `image.yml` (build -> smoke -> GHCR). Bump `minor` per
  novita sostanziali (nuovi subcomandi/flag/feature, rimozioni), `patch` per fix/doc. Senza chiederlo.
  ATTENZIONE: `package.json` (root + i due workspace) deve sempre combaciare col tag, altrimenti
  `release.yml` fallisce; e gia capitato che restasse a 1.1.0 fino alla 1.2.1. **Esenti** (niente tag/CHANGELOG): commit `chore(roadmap):` che toccano solo
  `.github/roadmap.json`, `scripts/sync-roadmap.sh` o `.github/workflows/`: sono pianificazione e
  plumbing, non prodotto.
- **MAI `git push`**: lo fa sempre l'utente. MAI `Co-Authored-By` nei commit.
- **Repo pubblico: zero dati di infrastruttura.** Nessun hostname reale, IP privato, path interno, hash
  di build, webhook o token in codice, doc, commenti, CHANGELOG o commit message. Negli esempi solo
  domini `*.test` e IP di documentazione (RFC 5737, es. `203.0.113.10`). I profili reali stanno in un
  repo **privato**: qui vive solo `profiles/example.json` (`.gitignore` blocca gli altri; non aggiungere
  eccezioni).
- **Lingua**: chat in italiano, ma tutto cio che finisce nel repo e in inglese (README, CHANGELOG,
  commenti, messaggi a schermo, commit message).
- **Allineare tutto**: ogni modifica fattuale va propagata a `README.md`, header di `bin/crowdsim`
  (e anche l'`--help`), commenti di `k6/live-event.js`, `profiles/example.json`, `Dockerfile`,
  `ci/nomad/crowdsim.nomad.hcl`, `cache-ab/README.md`, `CHANGELOG.md`. Un flag nuovo tocca almeno: parsing
  args + env passato a k6 + header usage + README + **test** (+ `gui/server/lib/args.js` e form della GUI
  se va esposto anche li).
- **`make test` verde prima di ogni commit** (unit + ui + gui + cli: non genera traffico). Logica nuova
  nel generatore -> va in `k6/lib/` con test in `tests/unit/`, non dentro `live-event.js`. Una decisione del **front end** va in `gui/ui/src/lib/` con test in `tests/ui/`, e il componente resta cablaggio; il testo che non si può ammorbidire (safe-peak, rifiuto, `unknown` ≠ `MISS`) sta in `lib/messages.js`. Unica eccezione: una modifica puramente visiva (spaziatura, un colore) non prende un test.
  Ogni bug corretto parte da un test che lo riproduce. `make test-e2e` (docker + k6, carico reale su loopback) quando si
  toccano driver, generatore o API.
- **I gate di sicurezza non si toccano** (vedi sotto): non indebolirli, non aggiungere default, non
  aggiungere prompt interattivi.
- **Documentare SEMPRE, senza chiederlo.** Ogni cosa user-facing esce con: comandi copia-incollabili
  (**provati** davvero, non plausibili), reference di env/volumi/porte/exit code, e troubleshooting con
  sintomi reali. La doc serve all'utente per far capire ad altri come si installa e si usa: se manca, la
  feature non e finita. Le pagine stanno in `docs/` (indice `docs/index.md`, piu `install`, `docker`,
  `running-a-test`, `reading-results`, `profile`, `cli`, `gui`, `architecture`, `development`): pagina nuova
  -> va in **`docs/index.md` e nell'indice del README**, altrimenti non esiste. Struttura pensata per
  GitHub Pages (markdown puro, link relativi). Scrivere la doc provando i comandi ha gia trovato due bug
  reali (500 invece di 409 su mount read-only, `insecure` per-target ignorato dal driver): l'ordine e
  provare -> scrivere.
- **Il tono della documentazione e parte del prodotto**: spiega il perche (incluse le trappole
  misurate), non elenca feature. Niente marketing, niente numeri inventati.

## Gate di sicurezza (invarianti, non negoziabili)

1. **Allowlist obbligatoria**: l'host del target deve combaciare con `CROWDSIM_ALLOW_TARGETS` o
   `safety.allow_hosts` del profilo. **Nessun default**, ne nello script ne nel `Dockerfile` ne nel job
   Nomad: senza allowlist il tool deve rifiutare di partire (exit 3).
2. **Safe peak**: sopra `safety.safe_peak_rps` serve `--i-know-this-breaks-production` sulla riga di
   comando. Non metterlo mai in un profilo, in un file di config, nel job Nomad o in CI.
3. **Nessuna conferma interattiva**, per scelta: girando su scheduler un prompt si appende o viene
   auto-risposto. I gate sono argomenti espliciti.
4. **Exit code**: `0` = eseguito (freno scattato = esito, non errore), `2` usage, `3` gate,
   `4` target non raggiungibile, `5` k6 mancante. Non cambiare la semantica: ci si appoggiano gli
   scheduler, i test bats e la GUI.
5. **La GUI non re-implementa nulla**: ogni run e un processo figlio di `bin/crowdsim`, i gate restano li
   e gli exit code passano invariati. In `gui/server/lib/args.js` solo flag noti con valori validati, mai
   shell, mai `extraArgs`. L'override safe-peak richiede `force` **+** il nome del profilo digitato per
   quella run (mai memorizzato lato server). Una run alla volta (409). Stop = SIGINT (il summary si
   salva). Bind `127.0.0.1`: altri indirizzi solo con `CROWDSIM_GUI_TOKEN`. La GUI **legge** `out/` e non
   tiene stato proprio: la verita sono i file del driver.

## Pattern per una modifica al tool

1. **Test prima**: il caso che stai sistemando o aggiungendo va scritto in `tests/` e deve fallire.
2. **`make lint`** (`bash -n` + `node --check`) e **`make test`**: unit + gui + cli, zero traffico.
3. **`crowdsim doctor`** e `--dry-run`: prerequisiti e composizione degli argomenti k6 senza generare
   traffico.
4. **Provare contro un target locale**: `make test-e2e` (nginx in container su loopback) oppure
   `cache-ab/` come origine finta; mai contro produzione per provare una modifica al codice.
5. **Rileggere l'output**: `out/summary-<run>.json` + `out/history.tsv`. Se `generator_ok: false` la run
   non si interpreta, si scarta.
6. **Chiusura**: README/commenti allineati + CHANGELOG + tag.

## Trappole note / regole tecniche

- **`generator_ok: false` -> run da buttare.** Una run generator-bound e indistinguibile da un sistema
  sano sotto carico: e il modo piu comune di avere torto con sicurezza. Non "aggiustare" il flag,
  spostare il generatore vicino al target.
- **Mai far girare il container su un laptop macOS/Windows** verso un target remoto: il layer di rete di
  Docker satura prima del target (misurato). k6 nativo in locale, container su host Linux vicino al
  target (e a questo che serve il job Nomad).
- `usage()` estrae l'header di commento **per struttura** (dalla riga 2 alla prima riga non commentata):
  l'header **e** l'help e puo crescere quanto serve. Prima leggeva `sed -n '1,60p'` e sbagliava in due modi
  silenziosi: stampava lo shebang senza il `#` come prima riga di `--help`, e troncava l'help appena
  l'header passava riga 60. Entrambi asseriti in `tests/cli/cli.bats`, che verifica anche che ogni
  subcomando dispatchato compaia nell'header.
- Lo script gira con `set -eo pipefail` (**senza `-u`**, di proposito: molte variabili sono opzionali).
  Non aggiungere `-u` senza inizializzare tutto.
- Il freno fa uscire k6 non-zero: la chiamata e dentro `set +e` + `PIPESTATUS[0]` cosi il wrapper scrive
  comunque summary e history. Non semplificare in `if k6 run ...`.
- `die()` usa `"$1"`, non `"$*"`: il secondo argomento e l'exit code.
- `JOURNEY` va passato **solo** con `--shape journey`: in `mix` mode k6 aprirebbe un file mai usato e un
  profilo che nomina un journey inesistente muore nell'init context con uno stack trace.
- Target = singola app instance -> serve `skip_classes` (le route servite solo dal reverse proxy fanno
  404, la classe va al 100% failed e il freno scatta a pochi req/s).
- Il `TIMEOUT` di k6 (default `10s`) deve **superare** il read timeout del proxy (`guillotine_ms`):
  altrimenti i 504 non si vedono.
- `--touch-and-go` **non** significa "pochi secondi": un 504 richiede una coda, e la coda richiede
  tempo. Attendersi 20-40s di errori.
- `rsc.mode`: `repeat` (default) replica la realta Next.js (pochi URL distinti); `random` misura
  l'ipotesi opposta (cache-buster). Non scambiarli nei confronti tra run.
- Numeri comparabili **solo tra run con pool identico**: un pool sintetico di URL freddi e piu severo
  del traffico reale. Il tool misura i delta onestamente e gli assoluti in modo ottimistico.
- Immagine k6 pinnata (`grafana/k6:0.52.0`) e `ENTRYPOINT []` resettato (l'entrypoint originale e k6
  stesso, ma qui e crowdsim a pilotare k6). Dipendenze runtime: `bash`, `curl`, `python3`.
- Parsing JSON solo con `python3` inline (no `jq`: non e nell'immagine k6). Non introdurre `jq`.
  Vale per `bin/crowdsim` e per il generatore; `scripts/sync-roadmap.sh` usa `gh` e `jq` di proposito
  (gira solo su workstation/CI, non nell'immagine).
- `CROWDSIM_SLACK_WEBHOOK` da env: mai un webhook hardcoded qui (e un repo pubblico). `/api/env` della
  GUI riporta solo se e configurato, mai il valore.
- `cache-ab/candidate.conf.template` ignora il `Cache-Control` dell'origine: l'avviso in testa al file
  non si rimuove ne si ammorbidisce.
- `k6/lib/*.js` girano **sia in k6 sia in node**: ES2019 (niente optional chaining o `??`), nessun import
  di `k6/*` o di moduli node. La randomness va iniettata (vedi `rscQuery`), altrimenti non e testabile.
- Header cache assente != MISS: `layerHit` torna `null` e la Rate non viene alimentata (una Rate a zero
  campioni riporterebbe "0% hit" per un layer mai attraversato). Test in `tests/unit/classify.test.js`.
- Le soglie k6 `p(95)>=0` sono decorative (servono a far emergere le sub-metriche per classe): non
  contarle mai come "freno scattato", segnerebbe ogni run come abortita.
- `node --test tests/unit/` (directory) non funziona su Node 23: serve il glob quotato
  `node --test "tests/unit/*.test.js"`, come in `package.json` e nel `Makefile`.
- bats arriva da `npm install` (devDependency, `npx bats`): non serve `brew install bats-core`. In
  `tests/cli/helper.bash` il PATH senza k6 e costruito con symlink, non filtrando `$PATH`: su macOS k6 e
  python3 stanno nella stessa dir di brew e il filtro romperebbe il test.
- **Immagine unica** `ghcr.io/hiway-media/crowdsim` (driver + generatore + GUI, ~189MB): non ne esistono
  due. Nell'immagine il driver sta in `/usr/local/bin` e il resto in `/crowdsim`, quindi serve
  `CROWDSIM_ROOT=/crowdsim`: altrimenti `ROOT` diventa `/usr/local` e `serve`/`cache-ab` si rompono senza
  un errore utile. Dentro un container "bind loopback" = raggiungibile da nessuno: si binda `0.0.0.0` e si
  pubblica con `-p 127.0.0.1:8787:8787`; il token resta obbligatorio.
- **`make image-smoke` prima di ogni modifica a Dockerfile, `bin`, `k6` o `gui`** (la CI lo esegue prima
  del push su GHCR). L'assert che conta: l'immagine **non** dichiara un default per
  `CROWDSIM_ALLOW_TARGETS`. Non aggiungerlo mai, nemmeno "per comodita di test".

## Puntatori

- Verita funzionale: `README.md` (sezioni Safety, The container, The GUI, Tests, Reading a result) e
  header di `bin/crowdsim`
- **Guida Docker: `docs/docker.md`** (unica verita su install/uso via container); `docker-compose.yml` +
  `.env.example` avviano la GUI; indice doc in README sezione Documentation
- Immagine: `Dockerfile` (3 stage), `make image|image-smoke|image-run`, CI `.github/workflows/image.yml`
  (pubblica sui tag `v*`; un push su main costruisce e testa senza pubblicare)
- **Doc completa: `docs/` (indice `docs/index.md`)**: install, docker, running-a-test,
  reading-results, profile, cli, gui, architecture, development
- Release: `scripts/new-release.sh prepare|tag|notes`; workflow `release.yml` + `image.yml`
- Test: `make test`, `make test-e2e`, `make image-smoke`; perimetro in `docs/development.md`
- Doc verificata da sé: `make check-docs` = `scripts/check-doc-versions.sh` + `check-doc-commands.sh` + `check-doc-output.sh --self-test` (l'ultimo asserisce che l'**output citato** nei blocchi di `docs/` esista ancora nei sorgenti; un blocco non verificabile va marcato `<!-- illustrative: … -->`, non lasciato passare in silenzio)
- GUI: `gui/server/lib/{args,validate,profiles,runner,history,app}.js` + `gui/ui/src/`; avvio con
  `crowdsim serve` (build UI: `npm run gui:build`)
- Anatomia del profilo: `profiles/example.json` (commentato inline con chiavi `_comment`)
- Mix misurato: `crowdsim weights <access.log>` (regole in `lib/weights.mjs`, test in `tests/unit/weights.test.js`) · la chiave di profilo `log_match` dice come una classe si riconosce in un log e **non** influenza una run · `crowdsim init --access-log` misura i pesi invece di scriverli come TODO. Il log non viene mai scaricato dal tool né scritto in `out/`
- A/B cache: `cache-ab/README.md` - Esecuzione remota: `ci/nomad/crowdsim.nomad.hcl` (batch parametrizzato,
  profilo scaricato al dispatch da repo privato)
- Output di una run: `out/summary-<run_id>.json`, `out/load-<run_id>.log`, `out/history.tsv` (`out/` e
  gitignorata: non committarla mai)
- **Report disegnato**: `crowdsim report <run> --html` → una pagina autonoma (zero risorse esterne, niente script) con la rampa come curva, la banda del ginocchio, p95 per classe contro il limite di quella classe, cache per layer. Geometria pura e testata in `lib/report-html.mjs` + `tests/unit/report-html.test.js`: uno scale sbagliato non lancia niente, produce un grafico convincente e falso. **Regola non negoziabile**: una run con `generator_ok: false` o `target_unreachable` NON prende grafici di latenza — solo quello che mostra perché è invalida. Il summary porta `slo` (dal 1.19.0) perché una soglia non si ricostruisce da una frase.
- **Roadmap = `.github/roadmap.json`** (sorgente unica: label, milestone, issue).
  `scripts/sync-roadmap.sh --dry-run` prima, poi senza flag; il workflow `roadmap-sync` lo rigioca al push
  su main. Il sync e additivo: **non chiude issue e non riscrive i body** esistenti, quindi una decisione
  va messa anche in un commento sull'issue, non solo nel file. Le issue si abbinano per `key`, non per
  titolo. Milestone: `v1.1.0` e `v1.2.0` sono consegnate dentro la release 1.1.0 (per questo non esiste
  una 1.2.0: la prossima e `v1.3.0`, milestone #4); `Backlog` = accettato ma non schedulato.
- Repo affini: `devops_hiway` (doc infrastruttura, incident, runbook: i report delle run reali vanno
  **la**, non qui)
