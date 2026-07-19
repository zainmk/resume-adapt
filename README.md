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

### What it actually costs

Rough per-operation estimates on **Claude Sonnet** pricing (~$3 / million input tokens, ~$15 / million output; 1-hour cache write ~2×, cache read ~0.1×). Actual figures depend on how large your master sheet is and how long each résumé runs — the real token counts for every call are logged to the DevTools console (`input / cache write / cache read / output`).

| Operation | When | Approx. cost |
|---|---|---|
| **Ingest master sheet** | Once per master (re-run only on re-upload) | **~$0.05 – $0.15** |
| **Generate résumé — first run of a session** | First job description after opening the panel | **~$0.05 – $0.07** |
| **Generate résumé — each later run within the hour** | Every subsequent generation / regenerate | **~$0.02** |

Why the shape:

- **Ingestion** is output-dominated — reading the master is cheap, but emitting the ~4k-word structured inventory is ~5–6k output tokens at the higher output rate. It happens *once*.
- **The first generation of a session** pays a one-time premium to *write* the system-prompt-plus-inventory prefix into the cache (~2× input on that span).
- **Every generation after that**, within the 1-hour TTL, re-reads that prefix at ~10% price — so the recurring cost collapses to a small cache read + the fresh job description + the résumé output (~1–2k tokens). This is the ~25–30% per-run saving the caching layer buys.

Practically: a full job search of, say, 40 tailored résumés from one master sheet runs on the order of **a dollar or two total**, not per résumé.

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

### What prompt caching does *not* do — and why "cache my best résumés" can't be a feature

Prompt caching stores **input processing, never output**. That one fact rules out a whole category of tempting cost features, so it's worth stating plainly:

- **There is no response cache.** Every generation regenerates the résumé tokens at full output price — the output is the expensive part, and it is never reused. You never get a previously produced résumé back "for free" from the model.
- **You can't cache "the best résumé for *software engineering*."** The intuitive idea — let the user pick a field, then cache the winning result per field to make calls cheaper — doesn't map onto how caching works. Caching reloads the *prefix's internal state*, not answers.
- **A "field of employment" selector wouldn't lower cost either.** The inventory is *already* the single cached prefix, byte-identical across every field. Putting a field tag **before** the cache breakpoint would fragment the cache into a separate, re-paid entry per field; putting it **after** the breakpoint (where the job description lives) has no caching effect at all. Its own text is a few tokens — negligible — and it can't shrink the output tokens that dominate cost.
- **The only true zero-cost reuse is identical-request reuse**, which is application-level, not model-level: the app already persists the last result and, in the recurring-gaps tracker, replaces a job's record on regeneration instead of paying twice. But résumés are tailored per job description, so reusing a generic cached one would defeat the tailoring that justifies the call.

The lesson: prompt caching is a discount on *re-reading the same large input*, not a store of finished work. Design savings around what's genuinely re-read (the inventory), not around what you wish were reusable (the answers). A field selector, if ever added, would earn its place as a **relevance/steering** control on a multi-domain master sheet — not as a cost lever.

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

## Benchmarks

### Cost

Cost optimization is never free — most levers trade some quality, UX, or control for spend. These tables put the two side by side so the tradeoff is explicit. **Dollar figures are estimates** on Claude Sonnet pricing (~$3 / M input, ~$15 / M output; see [What it actually costs](#what-it-actually-costs)); real per-call token counts are logged to the DevTools console.

**Shipped cost levers — and what each one costs in quality/UX.** Ratings: cost saving *(High / Medium / Low)*, quality impact *(None / Minor / Moderate / Negative)*.

| Cost lever | Cost effect | Quality / UX effect | Verdict |
|---|---|---|---|
| **Ingest-once caching** (index the master a single time) | **High** — turns a recurring large-doc cost into a one-time ~$0.05–0.15 | **None** — every résumé uses the full distilled index | ✅ Kept |
| **Distillation, not transcription** | **Medium** — smaller one-time output *and* smaller recurring input | **Minor** — drops verbatim prose/theory; keeps every fact & angle | ✅ Kept |
| **Fixed ingestion output budget (~4k words)** | **Medium** — decouples cost from document size | **Minor** — a very large master compresses phrasing harder | ✅ Kept |
| **Single-attempt ingestion** (no auto-retry) | **Medium** — never double-bills the most expensive call | **Tradeoff** — a transient failure needs a manual re-upload | ✅ Kept |
| **Prompt caching** (KV, 1h TTL) | **Medium** — ~25–30%/run (cached run ~$0.02 vs ~$0.03) | **None** — output is regenerated identically | ✅ Kept |
| **One call/gen + piggybacked meta** (match %, gaps) | **Low** — extras ride the same call, zero added requests | **None** — same output, richer JSON | ✅ Kept |
| **Prompt-guided page length** (removed correction loop) | **Medium** — eliminates 1+ measurement/regeneration call per run | **Moderate** — exact page count not guaranteed; finalized in Word | ✅ Kept |
| **Free local work** (inline edit, `.docx` render, session persist) | **Low** — edits/fixes cost $0, no regeneration | **None** — pure UX gain | ✅ Kept |
| **Word-count target control** | ~free (a few extra tokens) | **Negative** — false precision under the truthfulness floor; undershoots and reads as broken | ↩︎ Reverted |
| **Page-break preview estimate** | free (client-side) | **Negative** — couldn't match Word's real pagination; misleading | ✖ Removed |
| **Haiku for generation** (candidate next lever) | **High** — ~5× cheaper generation | **Risk** — weaker instruction-following on the prescriptive gen prompt | ⏳ Not yet |

**Alternatives compared — the architectural choices behind the current design.**

| Option | Cost / run | Quality | Chosen? |
|---|---|---|---|
| **Sonnet + prompt caching** *(current)* | ~$0.02 cached · ~$0.05–0.07 first run | **High** — strong truthful selection & instruction-following | ✅ |
| Haiku + prompt caching | ~5× cheaper generation | Medium — fidelity/selection risk on a résumé's hard truth constraint | Candidate next lever |
| Local / on-device open model | ~$0 marginal | Low & uneven — weaker output, heavier setup, no cache economics | No |
| No caching (re-send inventory each run) | ~$0.03 (~25–30% more) | Identical | No |
| Re-ingest the master every generation | Very high — full document every run | Identical | No — the anti-pattern this app is built to avoid |
| Measurement + corrective regeneration for exact pages | +1 or more calls/run | Marginally better page fit | No — reverted for cost; Word does it free |

*Reading the tables:* the biggest wins (ingest-once, caching) cost **nothing** in quality — they're pure architecture. The levers that *do* cost quality are accepted only where the loss is minor and recoverable (length is finalized in Word; a failed ingest is re-run). The two **Negative** rows are the counter-examples — features whose savings weren't worth the quality/clarity cost, so they were pulled (see [Not every prompt lever should become a UI control](#engineering-notes)).

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
- **Not every prompt lever should become a UI control (word count vs. page count).** A parameter inside the prompt is only worth exposing to the user if the model can actually *honor* it within the system's hard constraints. A **target word count** looked like finer-grained control than "one page or two," so it was built as a numeric input. In practice it gave *less* real control: truthfulness is a hard floor here — the model is forbidden from padding with invented content — so an arbitrary word target (e.g. 550) is only a soft ceiling, and the resume stops wherever the candidate's *real, relevant* material runs out (often well short, e.g. 379/550). The knob implied a precision the realism constraint can't deliver, which reads to the user as the feature being broken. **Page count is the coarser but honest granularity:** "commit to a full one or two pages" is something the model *can* satisfy by selecting and trimming truthful material, and it matches how résumés are actually judged. So the word-count control was reverted back to prompt-driven one/two-page sizing. The general principle: when a hard constraint (truthfulness) dominates an output dimension, expose the axis at the granularity the model can guarantee — not the finest axis you can technically parameterize.

---

## Tech stack

Vanilla JS (no framework), Manifest V3, the Anthropic Messages API, and three vendored client-side libraries:

| File | Package | Version |
|---|---|---|
| `mammoth.browser.min.js` | mammoth | 1.8.0 |
| `docx.min.js` | docx (UMD) | 8.5.0 |
| `pdfmake.min.js` + `vfs_fonts.js` | pdfmake | 0.2.10 |
