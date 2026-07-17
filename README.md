# ResumeAdapt — Chrome Extension

**Turn one master résumé into a tailored, job-specific résumé in seconds — grounded only in your real experience, and engineered to keep the LLM cost near zero.**

A Manifest V3 Chrome extension that ingests your career "master sheet" once, then generates ATS-aware résumés tailored to any pasted job description. It runs entirely in the browser against your own Anthropic API key, and is deliberately architected around **caching and indexing** so that the expensive part of the work — reading your full career history — is paid for as few times as possible.

https://github.com/user-attachments/assets/bbd99d3c-15f6-4645-9fb9-590348aa1e6f

---

## Purpose

AI-assisted tools are now used on both sides of the job search — by candidates
writing applications and by employers screening them. That isn't going away;
what matters is using them the way they *should* be used. Here, that means
tailoring a résumé so the candidate's real experience overlaps with a role's
requirements — **without hallucinated facts or misleading terminology.** On a
résumé, a fabrication isn't a harmless glitch: it's a false claim about a
person. That is exactly why the model choice is an engineering decision, not an
afterthought — a cheaper model lowers cost but raises hallucination risk, so the
design has to account for that tradeoff rather than ignore it.

ResumeAdapt is built around that principle. You provide a **master résumé**
holding all of your experience, across every background, in as much detail as
you like — this is the place to be exhaustive, and to include exact metrics
wherever possible. From there the tool works across three tokenization phases,
each a distinct cost surface: it **remembers** the master résumé (ingesting it
once into a cached JSON schema), **understands** the pasted job description, and
**produces** the best-suited résumé from that cached data. Each phase trades cost
against quality, so the whole tool is designed to minimize spend without ever
crossing the truthfulness line — because I built it to use for my own job search.

## What it does

1. **Ingest once.** Drop in a master sheet (`.pdf` or `.docx`) containing everything you've ever done. It's read a single time and distilled into a compact, structured **experience inventory** cached locally.
2. **Generate per job.** Paste a job description; the model selects the relevant experience from the inventory, rewrites it in the posting's own terminology (ATS keyword matching), and returns a structured résumé.
3. **Review & download.** Edit any text inline in the live preview, then download a styled `.docx` (finalize length/layout in Word).

The core guarantee: **it never invents.** Every fact on the résumé traces back to your master sheet; the model selects and rephrases, but does not fabricate employers, titles, dates, metrics, or skills.

## Highlights

- **Two-phase LLM pipeline** — a one-time *ingestion* pass (document → structured index) decoupled from cheap, repeatable *generation* passes (index + job description → résumé).
- **Truthfulness by construction** — inventory-only grounding, a "View parsed data" audit panel, and a fully editable preview that writes straight back into the résumé JSON.
- **Cost-minimizing by design** — application-level indexing + model-level prompt caching mean cost scales with the *small* changing input (the job description), not the *large* stable one (your career history). See [Cost engineering](#cost-engineering).
- **Live editing** — click any text in the preview to edit; changes auto-save and flow into the download. Blue titles are clickable links to the underlying project/company URL.
- **Match assessment** — each generation returns a self-scored `%` fit against the job description, with short notes on the strongest alignment and the biggest gap.
- **Recurring skill-gap tracking** — the model also emits the normalized requirements a job asks for that your master sheet doesn't cover; these are aggregated across every application into a "these keep coming up" panel, turning per-job feedback into a strategic *skills-to-build* signal. Rides the existing generation call — no extra API cost. See [Career-signal tracking](#career-signal-tracking-recurring-gaps).
- **Side-panel UX** — lives in Chrome's side panel, so it stays open while you read the job posting in another tab; session state (draft + last result) persists across open/close.
- **Local & private** — the API key and inventory live in `chrome.storage.local`; the only network calls are direct to `api.anthropic.com`. No backend, no third-party services.

---

## How it works — the pipeline

The design separates the work into two token phases with very different cost profiles:

```
                         ┌── one-time, expensive ──┐        ┌──── repeatable, cheap ────┐
 master sheet (.pdf/.docx) → [ INGESTION ] → inventory JSON → [ GENERATION ] → résumé JSON → .docx
   (~30 pages, sent once)      distill &        (cached in       select, tailor,   (rendered
                               index            chrome.storage)  ATS-match          client-side)
```

- **Ingestion** is the heavy step: the model reads the entire master document (a PDF is read *natively*, with layout/vision), interprets it, and emits a dense, structured inventory that captures every distinct fact and "angle" — but strips prose, tutorials, and boilerplate. This runs once and is cached; it re-runs only on re-upload.
- **Generation** consumes the lightweight cached inventory plus the pasted job description, and produces a résumé constrained to a strict JSON schema. Because the heavy document is already indexed, each generation is small and fast.

Intermediate **JSON schemas** act as the contract between the model and the app: they convert the LLM's free-form output into the static, predictable structure the renderers need, and simultaneously constrain the model's response (a schema is a far more reliable control than a prose instruction).

---

## Career-signal tracking (recurring gaps)

Tailoring one résumé is *reactive*. The more useful question over a job search is *strategic*: **which requirements keep coming up that I don't have?** ResumeAdapt answers it without any extra API cost, by reusing work it already does.

Every generation call already returns a match assessment. It now also returns a small `meta.gaps` array — the **normalized** skills/tools/qualifications the job requires that your master sheet doesn't support (e.g. `["Kubernetes", "PHP", "Team leadership"]`). Because these are canonical tags rather than the posting's freeform phrasing, the *same* gap tags identically across different postings — which is what makes "keeps coming up" counting actually work.

Each generation is recorded locally as a lightweight application record (`{title, company, date, score, gaps[]}`), keyed by a hash of the job description so regenerating the same job **updates** its record instead of double-counting. A **Recurring skill gaps** panel then aggregates the tags across all applications — `Kubernetes — 7/12`, `PHP — 4/12` — surfacing exactly where to invest learning time. A recurring "gap" you actually *have* is its own signal: it means your master sheet under-documents it.

**Cost: effectively zero.** The gap tags are ~30–80 extra output tokens piggybacked onto the generation call you're already making; storage and aggregation are entirely client-side. No separate analysis call, no new permissions, all local.

---

## Cost engineering

Every LLM call is billed by tokens, and this app is built around one asymmetry: **your career history is large and stable; the job description is small and changes every time.** ResumeAdapt is designed so you pay for the large stable part as rarely as possible, using **two independent caching layers**.

### 1. Application-level indexing (`chrome.storage.local`)

The master sheet — potentially 30+ pages — is sent to the model **exactly once**, where it's distilled into a compact structured inventory (the index) and cached in the browser. Every future résumé is generated from that lightweight index; the original document is never re-sent. This is the single biggest lever: it turns a recurring large-document cost into a one-time cost.

### 2. Model-level prompt caching (KV cache)

**What "caching" means *inside* the model.** When a transformer reads a prompt, it computes and stores an internal representation of every token — the attention Key/Value tensors, collectively the *KV cache*. Because these models are **causal** (a token's representation depends only on the tokens before it), that internal state is a deterministic function of the exact preceding bytes: an identical prefix always produces identical internal state.

Anthropic's prompt caching exploits this. It stores the processed state of a request's stable **prefix** and, on later requests that share that prefix byte-for-byte, reloads the state instead of recomputing it — billing the reused span at ~10% of normal input price. Crucially, **nothing about the answer is cached**: each résumé is generated fresh. Only the model's "having-read the input" work is reused, so there is no staleness — identical input bytes simply produce identical internal state by construction. (This is also why a single changed byte early in a prompt invalidates everything after it: downstream tokens now attend to different predecessors.)

ResumeAdapt orders every generation request to exploit this:

```
[ system prompt + inventory ][ ⚑ cache breakpoint ][ job description ] → résumé
└──── stable, byte-identical every run: cached (1h TTL) ────┘ └─ small, fresh each run ─┘
```

The first generation of a session writes the prefix to cache (a one-time premium); every generation within the hour re-reads it at ~10% price — roughly a **25–30% saving on each subsequent run**. Because the cache key *is* the content, re-ingesting the master automatically invalidates it with no bookkeeping.

### Full list of cost strategies

| # | Strategy | Effect |
|---|---|---|
| 1 | **Ingest once, cache the index** | The largest input is read a single time; generations reuse the cached inventory. |
| 2 | **Distillation, not transcription** | Ingestion keeps every fact as short atomic phrases and drops prose/theory/boilerplate — shrinking both the one-time output *and* the recurring generation input. |
| 3 | **Fixed ingestion output budget (~4k words)** | Decouples output cost from document size — a bigger master compresses harder instead of costing more. |
| 4 | **Single-attempt ingestion** | The most expensive call never auto-retries; a failure surfaces immediately instead of silently doubling the bill. |
| 5 | **Bounded `max_tokens`** (16k ingest / 4k gen) | High enough to avoid truncation (a truncated run is 100% wasted spend), low enough to cap worst case. |
| 6 | **One call per generation, piggybacked extras** | Filename metadata and the match-score are extra JSON fields on the same call, not separate requests. |
| 7 | **Prompt guidance over measurement loops** | Page length is steered by the prompt; an earlier corrective-regeneration loop was removed — final layout is tuned free-of-cost in Word. |
| 8 | **No per-generation fetching** | Linked project pages are treated as inert data, not fetched at generation time. |
| 9 | **Free local work** | Inline edits, `.docx` rendering, and session persistence all happen client-side — no regeneration to fix a word. |
| 10 | **Anthropic prompt caching** | Stable prefix cached with a 1-hour TTL (see above); hits logged to the DevTools console. |

**Known next lever (not yet implemented):** run *generation* on a smaller model (Haiku) while keeping *ingestion* on the more capable model — the generation prompt is intentionally prescriptive to make a smaller model viable (see [Model distillation](#engineering-notes)). Ingestion stays on the stronger model because the fact-selection phase is where a hallucination becomes a false claim on a résumé — a hard limit.

---

## Setup & usage

**Install (load unpacked):**

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Click the toolbar icon — the **side panel** opens.

**First-time setup (Settings ⚙):**

1. Save your Anthropic API key (stored in `chrome.storage.local`; used only for direct requests to `api.anthropic.com`).
2. Drop in your master sheet (`.pdf`/`.docx`). It's ingested once and cached.
3. Optionally open **"View parsed data"** to confirm exactly what was captured (nothing is invented).

**Generate:** paste a job description → **Generate** → edit inline as needed → **Download .docx**. **Regenerate** re-runs; the side panel persists your draft and last result across open/close.

---

## Architecture

| File | Role |
|---|---|
| `sidepanel.html` / `sidepanel.js` | The panel: job description in, tailored résumé out (preview, inline editing, match badge, download). Reads the cached inventory + key; persists session state. |
| `options.html` / `options.js` | Settings: API key, master-sheet upload/ingestion, and the parsed-data audit view. |
| `background.js` | Minimal service worker — opens the side panel on toolbar click. |
| `shared.js` | API layer (calls, prompt caching, timeouts, error mapping), storage helpers, shared style tokens. |
| `prompts.js` | The ingestion and generation system prompts + request assembly (incl. the cache breakpoint). |
| `render-docx.js` / `render-pdf.js` | Pure renderers from the résumé JSON. `.docx` is the download; the pdfmake renderer supports the in-memory page estimate. |

---

## Engineering notes

- **Model distillation.** A higher-capability model was used to *author* the hardcoded prompts and instruction sets; a balanced production model applies them at runtime. This front-loads reasoning into fixed instructions, which is what makes a smaller/cheaper runtime model viable.
- **Schemas as a control surface.** Intermediate JSON schemas bridge the LLM's dynamic output to the app's static rendering — and act as a stronger constraint on the model than any prose instruction.
- **Prompt decomposition.** Qualitative asks ("sound more professional") are hard to control or verify, because the model's baseline for the quality is itself fuzzy. Instructions are broken into concrete, checkable rules instead.
- **Hallucination is a hard limit.** In a résumé generator, a hallucination is a *false claim about the candidate*. The system enforces truthfulness structurally — inventory-only grounding, a human audit panel, and an editable preview — and reserves the most capable model for the quality-critical selection phase.
- **Cheap reversibility.** Work is committed per feature with clear context; reverting a commit is cheaper and more reliable than prompting a model to undo a change mid-development.

---

## Tech stack

Vanilla JS (no framework), Manifest V3, the Anthropic Messages API, and three vendored client-side libraries:

| File | Package | Version |
|---|---|---|
| `mammoth.browser.min.js` | mammoth | 1.8.0 |
| `docx.min.js` | docx (UMD) | 8.5.0 |
| `pdfmake.min.js` + `vfs_fonts.js` | pdfmake | 0.2.10 |
