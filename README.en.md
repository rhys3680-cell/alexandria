# Alexandria

[한국어](./README.md)

A personal desktop app that organizes what you write and say, finds it again, and shows you what matters before you ask.

Throw in a note or a recording and it comes back with a title, summary, tags, action items and the people involved — indexed so you can find it in any language. Organizing runs through your own `claude` CLI in the background; speech is transcribed on-device with whisper.cpp.

## Design principles

**The vault is the source of truth.** One item is one markdown file. SQLite is a derived index that can always be rebuilt from those files, so a damaged index is never a data loss event. The files stay readable by any other tool — you can point the `claude` CLI straight at the vault directory.

```
~/Alexandria/
  items/2026/08/20260812T0413-alexandria-project-kickoff-6APQFA.md
  media/01KZT2T68XKNV763TNG96APQFA.webm
  dictionary.txt      ← your recurring names and terms; meant to be edited
  .alexandria/
    config.json
    index.db          ← derived; `alx reindex` rebuilds it at any time
    vendor/           ← whisper.cpp binary and models
```

**Nothing needs rebuilding.** The index uses `node:sqlite`, built into both Node and Electron. Speech recognition and LLM calls run as child processes. There is no electron-rebuild step — the single most common source of build failures on Windows simply does not exist here.

| Runtime | SQLite | FTS5 | trigram | Verified |
|---|---|---|---|---|
| Node 24.12 | 3.50.4 | ✓ | ✓ | measured |
| Electron 43 (Node 24.18) | 3.53.1 | ✓ | ✓ | measured |

The one exception is `onnxruntime-node`, used by semantic search. It ships as an N-API prebuilt and was verified to load unchanged in both runtimes. With semantic search off it is never even loaded.

**One core, shared by the CLI and the app.** `@alexandria/core` owns capture, transcription, organizing and indexing; the CLI and the Electron main process open the same vault. SQLite runs in WAL mode, so an item queued by the CLI while the app is open gets picked up by the app's background worker. Folder watching lives in `alx watch`, not in the app.

## Multilingual by design

In the organized output, the title, summary, tags, tasks and highlights stay **in the language of the content**. Only `keywords` is always English — that is what lets a Korean note surface for the query `kickoff meeting`.

Search layers two FTS5 indexes:

- `unicode61` — word matching for space-delimited scripts (Korean, English, …)
- `trigram` — substring matching for scripts without spaces (Japanese, Chinese). Needs a 3+ character query and is only consulted when the word index comes up short.

## Speech

Record, or drop in an audio file: it is transcribed on-device and then follows the same organizing pipeline. Language is auto-detected.

```bash
alx setup whisper --list        # compare models
alx setup whisper               # install (defaults to small)
alx add --file meeting.m4a --now
```

### Choosing a model

Measured on a 20-second Korean memo against a known transcript.

| Model | Download | Errors | Time |
|---|---|---|---|
| `base` | ~142 MB | 6 (including a person's name and a product name) | 18.1s |
| **`small`** (default) | ~466 MB | 2 | 42.9s |

**`base` transcribed English word for word but got a person's name wrong in Korean.** A wrong name flows straight into the item's `people` field, where nothing downstream can catch it. Wrong data is worse than slow data, so `small` is the default. If you only capture English, `base` is plenty.

### A dictionary beats a bigger model

Put your recurring names, product names and jargon in `dictionary.txt` at the vault root, one per line. Transcription is biased toward those terms, and the organizing pass uses them to repair misheard spellings.

```bash
alx dict add Alexandria "app deployment" 박서연
alx dict                                    # show the current list
```

Measured on the same 20-second memo:

| Model | Without dictionary | With dictionary | Time |
|---|---|---|---|
| `base` | 6 errors | **1 error** | 18.1s |
| `small` | 2 errors | **0 errors** | 42.9s |

Without it, `base` got both the person's name and the product name wrong; with it, five errors including the name were fixed at once. **`base` with a dictionary (18s) is more accurate than `small` without one (43s)** — if speed matters, the small model plus a dictionary is the better trade.

The file is re-read on every run, so editing it by hand while the app is running is fine. To apply it to items already organized, requeue them with `alx retry`.

### Known limits

Misheard common words that are not in the dictionary still get through. The one error `base` had left was `만료되니까` → `말려드니까` — a verb, not a name.

The organizing pass cannot be relied on to fix transcription errors **by itself**. Running the same audio through both models, one run recovered `애패포` into `앱 배포` ("app deployment") and the other left `에페포` sitting in the title. That is precisely why the dictionary exists.

These numbers come from **clean TTS-generated speech**. Real recordings vary with noise and speaking habits.

## Semantic search

Lexical search cannot reach a note phrased differently from the query — "the thing we decided in that meeting" — which is most of what a personal vault gets asked. So each item also gets a local embedding, and search **fuses the lexical and semantic rankings (RRF)**. Raw scores are deliberately not blended: bm25 and cosine are not on comparable scales, and the embedding scores sit in a narrow band (0.825 for a direct hit against 0.790 for an unrelated note), so noise would outvote real matches.

Off by default. To turn it on:

```bash
alx setup embeddings --list     # available models
alx setup embeddings            # download, enable, backfill existing items
alx search "why the database stays out of the UI process"
```

Every result is labelled with the index that found it (`어휘` lexical / `의미` semantic / `둘다` both). If the model is missing or fails, search degrades quietly to lexical, so the app works fine without this feature. Embeddings are computed entirely on-device: **no cost, nothing leaves the machine.**

### Choosing a model

Measured on 5 items and 10 queries mixing Korean, Japanese and English. **The sample is small — read this as direction, not proof.** Scoring full marks across 5 documents is easy.

| Model | Download | Dims | rank1 | MRR |
|---|---|---|---|---|
| `multilingual-e5-small` | ~60 MB | 384 | 4/10 | 0.633 |
| **`multilingual-e5-base`** (default) | ~110 MB | 768 | 7/10 | 0.783 |
| `bge-m3` | ~570 MB | 1024 | 10/10 | 1.000 |

The failures point one way: **a Korean query struggles to reach a non-Korean note.** English queries find Korean notes well on e5-base; the reverse is weak. If cross-lingual retrieval matters to you, switch with `alx setup embeddings -m Xenova/bge-m3`. Changing the model discards the old vectors and re-embeds automatically.

## Web browser

Browse inside the app and **capture the page you are looking at** into the vault.

That is the difference from fetching a URL: a page behind a sign-in, or one assembled by scripts, is captured as rendered. A captured page is then organized, tagged and embedded like any other item, so it becomes searchable.

Built on `WebContentsView` rather than the deprecated `<webview>` tag. The page is owned by the main process and floats above the renderer; the React side draws only the address bar and buttons, then reports the rectangle the viewport should occupy.

Isolation: no preload, `sandbox: true`, `contextIsolation: true`, and its own session partition, so the page can never reach the app's IPC. Popups are handed to the system browser. The session persists, so a sign-in survives between visits.

**A known limit** — what gets captured is `innerText`, not extracted article content. Capturing a GitHub page brings its navigation text along. The organize pass still produces a good title, summary and tags, but the stored body carries boilerplate.

## Conversation console

Talk to the model inside the app. It drives the same `claude` CLI the organize pass uses, so there is no separate authentication.

```bash
alx ask "summarise what we decided about whisper" --search "whisper benchmark"
alx ask --tools web --save "what is the latest whisper.cpp release? include the URL"
```

- **Context injection** — feed in the open item or search results and the answer cites items by their short id.
- **Save to the vault** — a saved answer becomes an item like any other, so it is organized, tagged and embedded. Something found on the web turns into a searchable record immediately.
- **Streaming** — the answer appears as it is written.

### Tool level is the cost

Every granted tool ships its schema with each call. Measured on the same question:

| Mode | Input tokens | Per call | What it can do |
|---|---|---|---|
| `none` | 190 | $0.0013 | The conversation and given context only |
| `web` | 1,892 | $0.012–0.033 | Search and read the web |
| `vault` | 3,240 | ~$0.02 | Read vault files directly |

For comparison, leaving the CLI's full default tool set on costs 26,676 tokens. That is why the mode is the user's choice and defaults to `none`.

Declaring a tool is **not enough**: without an accompanying permission the CLI denies it silently in non-interactive mode and the model replies that it has no web access. The adapter passes `--allowedTools` alongside.

## Related records

Opening an item shows the past records connected to it, from two independent signals:

- **Shared facets** — items sharing a tag, keyword or named person. Exact, and above all able to **say why** two notes connect.
- **Semantic neighbours** — connections nobody thought to tag (when semantic search is on).

```
$ alx related 6APQFA
Records connected to "알렉산드리아 프로젝트 킥오프 회의"

  both    9SFKK2  STT benchmark interim results shared
      ↳ shared: STT, base model, 김지훈
  shared  PH3M5V  Whisper base model transcription test
      ↳ shared: whisper, base model, medium model
```

### Nothing related means nothing shown

The hard part is the floor, not the ranking. Show the top N by similarity and the whole vault comes back as "related", which teaches the reader to ignore the section entirely.

An absolute cut-off provably cannot supply that floor. Across five **mutually unrelated** notes, every pair scored between 0.739 and 0.815 — and the highest-scoring pair had nothing in common. The embedding space is anisotropic: nothing is ever far from anything. Mean-centering widened the spread but left the ordering just as wrong, because there was no signal to recover.

So the test is **relative to each item's own baseline**: how similar is this item to the vault in general, and does this candidate stand clearly above that? It self-calibrates to whatever model is configured and returns nothing when nothing fits. In practice the Electron design note reports "no related records", which is correct.

## Showing you things first

The app opens on a **briefing**, not a list. It aggregates the `tasks`, `due` dates and `people` the organizing pass already extracted, so there is no model call — it renders instantly and costs nothing to open.

- **Overdue / Today / Soon (7 days) / Someday** — tasks bucketed by due date. Ticking one writes to the source file's frontmatter, so completion survives a reindex.
- **Done today** — what you finished, and it can be undone.
- **Recently organized** — items that finished organizing in the last 48 hours.
- **A month ago / a year ago today** — records left on this date, brought back up.
- **Needs attention** — failed items and queued work.

The terminal gives you the same thing. Bare `alx` opens the briefing.

```
$ alx
2026-08-12 Wednesday

Today (2)
  JS1HZ9·1  Submit the code signing certificate renewal  2026-08-12
      ↳ Code signing certificate renewal and design draft reply

$ alx done JS1HZ9 1
Done  Submit the code signing certificate renewal
```

## Cost

Organizing runs through your own `claude` CLI, so **if you are signed in with a subscription there is no separate bill — it consumes your subscription's usage allowance.** If the CLI is running on an `ANTHROPIC_API_KEY`, that amount is actually charged. The figures shown in the app and by `alx stats` are what the call *would* have cost on API pricing.

Per-call cost matters either way, because it sets how fast a subscription allowance burns down. Measured on this machine:

| Call shape | Input tokens | Output tokens | Cost equivalent |
|---|---|---|---|
| Default (tool schemas included) | 26,676 | 9 | $0.161 |
| `--disallowedTools` listing every tool | 11,781 | 9 | $0.0043 |
| **`--agents '{...,"tools":[]}'` + `--agent`** | **194** | 9 | **$0.0013** |
| Above + `--effort low` (a real organize call) | 329 | 255 | $0.0055 |
| Same but `--effort medium` | 329 | 635 | $0.0112 |

Two things did the work. Declaring an agent with no tools strips every tool schema from the request. And organizing is a shallow extraction task, so `--effort low` halves the output (i.e. thinking) tokens with no quality loss — it actually returns cleaner JSON, without code fences. A real note costs roughly $0.009–0.015 to organize.

## Getting started

```bash
pnpm install
pnpm build
```

The `claude` CLI must be on PATH and signed in. Check with:

```bash
pnpm alx doctor
```

For speech, fetch the whisper.cpp binary and a model (automatic on Windows x64; other platforms print build instructions). ffmpeg is also required.

```bash
pnpm alx setup whisper
```

Desktop app:

```bash
pnpm desktop
```

The vault defaults to `~/Alexandria`; override it with the `ALEXANDRIA_VAULT` environment variable or the `--vault` option.

## Building an installer

```bash
pnpm --filter @alexandria/desktop package
```

The NSIS installer lands in `apps/desktop/release/`.

What actually mattered here:

- **pnpm layout** — electron-builder has to walk the production dependency tree to decide what ships, and pnpm's default symlinked layout puts a package's dependencies in the store as siblings rather than inside the package. The walk failed and it packed every devDependency instead, producing a **695 MB** `app.asar`. `nodeLinker: hoisted` in `pnpm-workspace.yaml` fixes it.
- **An explicit allowlist** — rather than trusting the automatic sweep, `electron-builder.yml` names the runtime closure of the three modules the main bundle keeps external (`@huggingface/transformers`, `onnxruntime-node`, `sharp`). Miss one and it fails **loudly** at runtime (`Cannot find module 'detect-libc'`), which beats silently shipping the whole workspace.
- **`.node` outside the asar** — `dlopen` needs a real path on disk, so those files must be in `asarUnpack`.
- **Per-platform binaries** — `onnxruntime-node` ships prebuilts for every platform it supports (210 MB); only the target one is kept. Browser-only `onnxruntime-web` (128 MB) is dropped too, and embedding was verified to still work without it.

Result: **1,216 MB → 438 MB** unpacked, with `app.asar` down from 695 MB to 12 MB.

> **Windows note** — renaming a freshly extracted directory sometimes fails with `EPERM`. It is a race: electron-builder renames before the extractor has released its handles. Re-running the build gets past it.

## CLI

```bash
alx                                                  # briefing (= alx today)
alx done 6APQFA 1                                    # complete a task (--undo to reopen)
alx add "kickoff at 3 tomorrow, share the benchmark" # capture only (organizing is queued)
alx add --file recording.m4a --now                   # capture, then transcribe and organize now
echo "long text" | alx add                           # stdin
alx watch ~/Downloads ~/Documents/notes              # watch folders, capture and organize
alx run --follow                                     # keep draining the queue
alx ls -n 20                                         # recent items
alx search "kickoff meeting"                         # fused lexical + semantic search
alx setup embeddings                                 # enable semantic search
alx embed                                            # fill in missing embeddings
alx show 6APQFA                                      # detail (last 6 characters work as an id)
alx related 6APQFA                                   # connected past records
alx dict add Alexandria "app deployment"              # transcription dictionary
alx stats                                            # status and accumulated cost
alx reindex                                          # rebuild the index from the files
alx retry                                            # requeue failed jobs
alx config set llm.model haiku                       # change settings
```

## How work flows

Capture must never fail, so the file is written first and the slow work is queued.

```
captureText ──────────────────────────┐
                                      ├─→ organize ─→ organized
captureAudio ─→ transcribe ─→ ────────┘
```

- Jobs live in a SQLite queue and retry up to three times. Anything left `running` by a crash is requeued at the next start.
- An item only gets a title once organizing finishes, so that is the single point at which its file is renamed.
- An item that fails for good keeps its `failed` status and the reason in the file, and `alx retry` brings it back.

## Layout

```
packages/core     capture, transcription, organizing, indexing. No Electron dependency
packages/cli      alx — uses the core directly
apps/desktop      Electron + React. The main process owns one core instance
```

The renderer only sees the narrow API exposed over `contextBridge`. No database handle, no writable file path, and no Node ever crosses into it.

## Tests

```bash
pnpm test
```

38 tests run against the built artifacts: frontmatter round-trips, filename normalisation, FTS query escaping, cross-lingual search, CJK trigram search, queue retries, task completion reaching the file, briefing due-date bucketing, rank fusion, vector storage, the relatedness floor, the dictionary reaching both whisper and the organize prompt, context injection and session resume for the console, and the whole capture-to-organized path with the model and embedder stubbed.

## What's next

Capture, organizing, briefing, search, related records, speech, the console, the browser and packaging all work. Remaining:

- **Code signing** — the installer is unsigned today, so SmartScreen warns on first run
- **Korean → non-Korean retrieval** — the one direction that consistently failed above
- **System audio capture** — pick up video call audio too
