# ResumeAdapt — Chrome Extension

Personal-use MV3 extension: configure a master sheet (.pdf/.docx) and API key
once in Settings, then click the toolbar icon to open the **side panel**, paste
a job description, and download a tailored resume as .docx (finalize length/layout in Word). Calls the
Anthropic API directly from the browser with your own API key.



https://github.com/user-attachments/assets/bbd99d3c-15f6-4645-9fb9-590348aa1e6f



## Install (load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this `extension/` folder
4. Click the toolbar icon — the side panel opens (and stays open while you
   browse other tabs, e.g. the job posting)

## First-time setup (Settings page)

Open **Settings** from the link in the panel header (or right-click the toolbar
icon → Options):

1. Save your Anthropic API key (stored in `chrome.storage.local`, never leaves
   this browser except in requests to `api.anthropic.com`). The **"Get your API
   key →"** link opens the Anthropic key management page.
2. Drop your master sheet (.pdf or .docx) into the upload zone. It's converted
   once into a structured "experience inventory" and cached — only the contents
   of the master file are used. Re-upload any time to replace it.
3. Verify what was captured with **"View parsed data"** — it shows the exact
   inventory the generator will use; read it to confirm nothing was invented.

## Usage (side panel)

Click the toolbar icon → paste a job description → **Generate** → review the
preview → **Download .docx** (edit/finalize in Word). **Regenerate** re-runs with
the same inputs. Generation reads only the cached inventory and selects the
content relevant to the specific job. If the API key or master sheet isn't set
up yet, the panel shows a notice with a button to open Settings.

**Session persistence:** the draft job description auto-saves as you type, and
the last generated resume is stored — closing and reopening the panel restores
both, so nothing is lost and no regeneration is needed. Because it's a side
panel (not a popup), it also stays open while you click around other tabs, and
an in-flight generation isn't killed by clicking away.

**Clickable links:** if a company, project, or certification in your master
sheet has a URL next to it, that entry's **title itself is a clickable link**
(shown in the accent color) in the preview and the .docx — using the
first URL found for the entry. Entries without a URL render as plain titles.
Nothing is fetched — the link is just carried through as data.

## Architecture

- **`sidepanel.html` / `sidepanel.js`** — the side panel: job description in,
  tailored resume out (preview + downloads). Reads the cached inventory + key;
  persists the session (JD draft + last result) across open/close.
- **`background.js`** — one-liner service worker that makes the toolbar icon
  open the side panel.
- **`options.html` / `options.js`** — the Settings page: API key input (with
  the reference link), master-sheet upload/ingestion, and the parsed-data view.
- **`shared.js`** — API calls, storage helpers, `RESUME_STYLES`, error
  formatting, shared by both pages.
- **`prompts.js`, `render-docx.js`, `render-pdf.js`** — verbatim prompts and
  the renderers: .docx is the download; the pdfmake renderer is kept for the free in-memory page-count estimate shown in the match badge.


## Design Decisions
- Balancing the cost of API token w. the quality of interpretation/generation of the resulting PDF. The goal is to find the right balance of quality to cost. Cost & Understanding the ingestion pipeline. There are three phases of tokenization; input of resume-master, input job desc., and output resume. There are pros/cons to each of these which affect the quality/cost ratio of the generated resume - and how well it matches the job description. Via Anthropic models; the 'sonnet' model is most capable and balanced for these purposes.
- Model Distillation; Using a higher-order level AI model to generate the 'prompt' (and any other hardcoded instruction sets), for a lesser-level model to 'interpret' and apply.
- git commit accordingly, with feature and context in mind. It is much cheaper & easier to revert commits, then it is to prompt a reversal-change (during code development)
- Using intermediate JSON schema structures, to 'fine-tune' the LLM response as per the input and have it be usable for actual resume generation. These JSON schema's allow a transition from the dynamic answers of the LLM to the static structure required by the application.
- Prompt breakdown is essential. It can be difficult to fine-tune control the model's response, when the input is a contextual-based sentence prompt (ex. asking the LLM to be more professional in 'voice', becomes difficult to assess how the model assesses a 'regular' professional voice to even give a 'more' professional voice - within the context of professionalism)
- Risk of using a lesser model also include the possiblity of hallucinations; given within the context of a resume-generator, the risk of hallucinations is false information in the generated resume, this is HARD limit - therefore an effective model is required (specfically for the 'inventory-selection' token phase)
- The most cost is in the initial resume-master ingetsion token phase. When the model parses through all of the content provided in the resume-master, interprets contextually, then selects accordingly to the JSON schema - to define the response in a usable format.

### Breakdown; Cost
The goal is to implement this feature in as cost-effective as possible. Current implementation is to utilize Anthropic's API key to 'fuel' the LLM in the app. It is preferable to limit the costs of using this API through several strategies:

**Cost-saving strategies implemented so far:**

1. **Ingest once, cache forever** — the master sheet (the largest input by far) is read by the API exactly once and distilled into a compact inventory cached in `chrome.storage.local`. Every resume generation reuses the cache; the 30-page document is never re-sent. Re-ingestion happens only when the user re-uploads.
2. **Distillation, not transcription** — the ingestion prompt extracts every distinct fact/angle as short atomic phrases and explicitly omits prose, theory, setup instructions, and low-value IDs. This shrinks the one-time ingestion *output* AND the recurring generation *input* (the inventory is resent on every run), the single biggest recurring token cost.
3. **Fixed output budget on ingestion** (~4,000 words regardless of source size) — decouples output cost from master-document size; a bigger master compresses harder instead of costing more.
4. **Single-attempt ingestion** — the most expensive call in the app never auto-retries; a failure surfaces immediately instead of silently doubling the bill. (Generation, the cheap call, keeps one auto-retry for malformed JSON.)
5. **Generous-but-bounded `max_tokens`** — 16k ingestion / 4k generation: high enough that outputs don't truncate (a truncated run is 100% wasted spend + a retry), low enough to cap worst-case cost.
6. **One API call per generation, with piggybacked extras** — the job-title/company (for the download filename) and the match-score assessment are folded into the same generation call as extra JSON fields (~50 output tokens) instead of separate API calls.
7. **Page-length control via prompt guidance, not measurement loops** — an earlier design measured the rendered page count and ran corrective regeneration calls to hit an exact page target; it was removed in favor of free prompt guidance ("commit to whichever full page boundary is tighter"), with final layout tuned by hand in Word at zero API cost.
8. **No per-generation fetching** — an earlier design fetched linked project pages (first via Claude's server-side `web_fetch` tool — dropped as too costly — then via free client-side fetch); removed entirely so generation input is only the cached inventory + pasted job description.
9. **Free local work wherever possible** — inline preview edits write directly into the cached JSON (no regeneration to fix a word), the .docx renders client-side, and session persistence restores the last result on reopen so nothing is regenerated by accident.
10. **Anthropic prompt caching on generation** — the generation message places the stable prefix (system prompt + inventory) before the per-run job description, with a `cache_control` breakpoint (1-hour TTL) after the inventory. The first generation of a session pays a one-time cache write (~2× on the prefix); every later generation within the hour re-reads that prefix at ~0.1× price — roughly 25-30% off each subsequent run. Cache hits are logged to the DevTools console (`[ResumeAdapt] tokens — …`).

**Not yet implemented (known next lever):** switching generation to Haiku 4.5 (~3× cheaper; the highly prescriptive generation prompt is designed to make a smaller model viable per the Model Distillation principle) while keeping Sonnet for the one-time, quality-critical ingestion.


## Testing checklist

- [ ] In Settings, ingest a PDF master sheet; then re-upload a DOCX and confirm the cache is replaced
- [ ] Popup shows the setup notice when the key or master sheet is missing, and hides it once both are set
- [ ] Spot-check "View parsed data" against the master sheet (no fabricated facts; only what's in the file)
- [ ] Generate for an unrelated job and confirm irrelevant projects are omitted (selection still applies)
- [ ] Open the .docx in Word/Google Docs and confirm styling + clickable links
- [ ] Restart the browser and confirm the cached inventory + key persist, and Reload is enabled
- [ ] Error states: no key saved, invalid key, no master sheet, empty job description


## Vendored libraries (`lib/`)

| File | Package | Version |
|---|---|---|
| `mammoth.browser.min.js` | mammoth | 1.8.0 |
| `docx.min.js` | docx (UMD) | 8.5.0 |
| `pdfmake.min.js` + `vfs_fonts.js` | pdfmake | 0.2.10 |
