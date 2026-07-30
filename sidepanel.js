// Side panel — job description in, tailored resume out. Reads the cached
// master-sheet inventory and API key set up on the options (Settings) page.
// Lives in Chrome's side panel, so it stays open while you browse other tabs
// (e.g. reading the job posting) and an in-flight generation survives clicks
// outside the extension.

const el = {
  settingsLink: document.getElementById("settings-link"),
  setupNotice: document.getElementById("setup-notice"),
  setupText: document.getElementById("setup-text"),
  openSettingsBtn: document.getElementById("open-settings-btn"),
  mainFlow: document.getElementById("main-flow"),
  jdInput: document.getElementById("jd-input"),
  generateBtn: document.getElementById("generate-btn"),
  clearBtn: document.getElementById("clear-btn"),
  genSpinner: document.getElementById("gen-spinner"),
  genStatus: document.getElementById("gen-status"),
  errorBox: document.getElementById("error-box"),
  resultSection: document.getElementById("result-section"),
  targetRole: document.getElementById("target-role"),
  matchBox: document.getElementById("match-box"),
  preview: document.getElementById("preview"),
  dlDocxBtn: document.getElementById("dl-docx-btn"),
};

let lastResume = null;
let lastJobTitle = "Role";

function showError(err) {
  el.errorBox.textContent = formatError(err);
  el.errorBox.hidden = false;
}
function clearError() {
  el.errorBox.hidden = true;
  el.errorBox.textContent = "";
}

// ---------------------------------------------------------------------------
// Session persistence — the panel's JS context is destroyed when the side
// panel is closed, so the draft job description and the last generated resume
// are kept in chrome.storage.local and restored on every open. Closing the
// panel never loses anything.
// ---------------------------------------------------------------------------
let draftTimer = null;

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    chrome.storage.local.set({ jdDraft: el.jdInput.value });
  }, 300);
}

async function saveResult(resume, jobTitle) {
  await chrome.storage.local.set({ lastResume: resume, lastJobTitle: jobTitle });
}

async function restoreSession() {
  const { jdDraft, lastResume: savedResume, lastJobTitle: savedTitle } =
    await chrome.storage.local.get(["jdDraft", "lastResume", "lastJobTitle"]);
  if (jdDraft && !el.jdInput.value) el.jdInput.value = jdDraft;
  if (savedResume) {
    lastResume = savedResume;
    lastJobTitle = savedTitle || "Role";
    renderTargetRole(savedResume.meta);
    renderMatch(savedResume.meta);
    el.resultSection.hidden = false; // show first so the preview can measure width
    renderPreview(savedResume);
  }
}

// Reset the current job description and everything generated from it. Confirms
// first only when a generated resume would be discarded (regenerating costs an
// API call). Recorded application history / recurring gaps are deliberately NOT
// touched — those have their own "Clear application history" control.
async function clearFlow() {
  if (lastResume && !confirm("Clear the job description and discard the generated resume?")) {
    return;
  }
  clearError();
  el.jdInput.value = "";
  lastResume = null;
  lastJobTitle = "Role";
  el.preview.textContent = "";
  el.targetRole.hidden = true;
  el.matchBox.hidden = true;
  el.resultSection.hidden = true;
  el.genSpinner.hidden = true;
  el.genStatus.textContent = "";
  await chrome.storage.local.remove(["jdDraft", "lastResume", "lastJobTitle"]);
  el.jdInput.focus();
}

// ---------------------------------------------------------------------------
// Application history logging (tier B). Each generation records
// {jdKey, title, company, date, score, gaps[], jd} locally — no extra API call,
// the gaps come from the same generation response. The full job description text
// (jd) is kept so the history is a complete, exportable log of what was applied
// for. Records are keyed by a hash of the job description so regenerating the
// same job updates its record rather than double-counting. The history is
// viewed/edited and its recurring gaps aggregated on the Settings page.
// ---------------------------------------------------------------------------
function hashJd(s) {
  let h = 5381;
  const t = (s || "").trim();
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function getApplications() {
  const { applications } = await chrome.storage.local.get("applications");
  return Array.isArray(applications) ? applications : [];
}

async function recordApplication(jd, resume) {
  const meta = (resume && resume.meta) || {};
  const record = {
    jdKey: hashJd(jd),
    title: (meta.job_title || "").trim() || "Role",
    company: (meta.company || "").trim(),
    date: new Date().toISOString(),
    score: meta.match && typeof meta.match.score === "number" ? meta.match.score : null,
    gaps: Array.isArray(meta.gaps) ? meta.gaps.map((g) => String(g).trim()).filter(Boolean) : [],
    jd: (jd || "").trim(),
  };
  const apps = await getApplications();
  const idx = apps.findIndex((a) => a.jdKey === record.jdKey);
  if (idx >= 0) apps[idx] = record; // same job re-generated → replace
  else apps.push(record);
  await chrome.storage.local.set({ applications: apps });
}

// ---------------------------------------------------------------------------
// Match assessment — the generation call self-scores how well the produced
// resume covers the job description (meta.match). Shown as a badge above the
// preview; purely informational, a rough estimate.
// ---------------------------------------------------------------------------
// The role this resume was tailored to, as "Job Title @ Company" (company
// omitted when the job description didn't name one). Both come from the
// generation's meta; falls back to the job-title guess from the JD's first line.
function renderTargetRole(meta) {
  const m = meta || {};
  const job = (m.job_title || lastJobTitle || "").trim();
  const company = (m.company || "").trim();
  if (!job && !company) {
    el.targetRole.hidden = true;
    return;
  }
  el.targetRole.textContent = company && job ? `${job} @ ${company}` : job || company;
  el.targetRole.hidden = false;
}

function renderMatch(meta) {
  const m = meta && meta.match;
  if (!m || typeof m.score !== "number" || !isFinite(m.score)) {
    el.matchBox.hidden = true;
    return;
  }
  el.matchBox.textContent = "";
  const score = Math.max(0, Math.min(100, Math.round(m.score)));

  const badge = document.createElement("span");
  badge.className = "match-score " + (score >= 75 ? "good" : score >= 50 ? "mid" : "low");
  badge.textContent = score + "%";
  el.matchBox.appendChild(badge);

  const text = document.createElement("span");
  text.className = "match-text";
  const notes = Array.isArray(m.notes) ? m.notes.filter(Boolean) : [];
  text.textContent = "estimated match" + (notes.length ? " — " + notes.join(" · ") : "");
  el.matchBox.appendChild(text);

  el.matchBox.hidden = false;
}

// ---------------------------------------------------------------------------
// Readiness — need both an API key and a cached master sheet before generating.
// ---------------------------------------------------------------------------
async function checkReadiness() {
  const [apiKey, inventory] = await Promise.all([getApiKey(), getInventory()]);
  const missing = [];
  if (!apiKey) missing.push("an API key");
  if (!inventory) missing.push("a master sheet");

  if (missing.length) {
    el.setupText.textContent =
      "Add " + missing.join(" and ") + " in Settings before generating.";
    el.setupNotice.hidden = false;
    el.generateBtn.disabled = true;
  } else {
    el.setupNotice.hidden = true;
    el.generateBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
function deriveJobTitle(jd) {
  const line = jd
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0) || "Role";
  return line.length > 40 ? line.slice(0, 40).trim() : line;
}

async function generate() {
  clearError();

  const jd = el.jdInput.value.trim();
  if (!jd) {
    showError(new UserError("Paste a job description first."));
    return;
  }
  const inventory = await getInventory();
  if (!inventory) {
    showError(new UserError("No master sheet cached. Add one in Settings."));
    return;
  }

  // Generation reads only the cached inventory built from the master sheet.
  // One API call per Generate — the prompt instructs the model to commit to
  // whichever clean length (one or two full pages) the content lands tighter
  // on; final layout is tuned by the user in Word.
  el.generateBtn.disabled = true;
  el.clearBtn.disabled = true; // avoid clearing a flow that's about to repopulate
  el.genSpinner.hidden = false;
  el.genStatus.textContent = "Generating…";
  try {
    const resume = await callForJson(
      GENERATION_SYSTEM_PROMPT,
      buildGenerationUserMessage(inventory, jd),
      GENERATION_MAX_TOKENS,
      () => { el.genStatus.textContent = "Response was malformed — retrying once…"; }
    );

    lastResume = resume;
    lastJobTitle = deriveJobTitle(jd);
    await saveResult(resume, lastJobTitle);
    await recordApplication(jd, resume);
    renderTargetRole(resume.meta);
    renderMatch(resume.meta);
    el.resultSection.hidden = false; // show first so the preview can measure width
    renderPreview(resume);
    el.genStatus.textContent = "";
  } catch (err) {
    el.genStatus.textContent = "";
    showError(err);
  } finally {
    el.genSpinner.hidden = true;
    el.generateBtn.disabled = false;
    el.clearBtn.disabled = false;
  }
}

// URL display helpers: links keep their full URL as the target but are shown
// with the protocol/"www." stripped (https://www.github.com/x -> github.com/x).
function prettyUrl(u) {
  return String(u).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
}
function ensureHttp(u) {
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}

// ---------------------------------------------------------------------------
// HTML preview — built with DOM APIs (no innerHTML with model output),
// styled from the same RESUME_STYLES tokens as the .docx renderer, so the
// preview mirrors the download. Read-only; company/project/certification names
// with a URL render as clickable accent-colored links.
// ---------------------------------------------------------------------------
function renderPreview(resume) {
  const S = RESUME_STYLES;
  // Content is built into a fixed Letter-geometry "sheet" (612pt wide, 42pt
  // margins → 528pt content column, matching the .docx renderer) so line
  // wrapping resembles the real document. The sheet is scaled to fit the panel
  // width via CSS zoom afterward.
  el.preview.textContent = "";
  const root = document.createElement("div");
  root.className = "page-sheet";
  el.preview.appendChild(root);
  root.style.fontFamily = S.fontPreview;
  root.style.color = S.bodyColor;
  root.style.fontSize = S.bodyPt + "pt";
  root.style.lineHeight = "1.35";

  const div = (styles = {}) => {
    const d = document.createElement("div");
    Object.assign(d.style, styles);
    return d;
  };
  const span = (text, styles = {}) => {
    const s = document.createElement("span");
    s.textContent = text;
    Object.assign(s.style, styles);
    return s;
  };
  const nameEl = div({ fontSize: S.namePt + "pt", fontWeight: "700", color: S.accentColor });
  nameEl.textContent = resume.name || "";
  root.appendChild(nameEl);

  // Contact line — links render with the protocol/www stripped for display but
  // keep the full URL as the click target.
  const c = resume.contact || {};
  const contactNodes = [];
  // location may carry a relocation note, e.g. "Calgary, AB | Open to Relocating Vancouver, BC"
  if (c.location) contactNodes.push(span(c.location));
  if (c.email) contactNodes.push(span(c.email));
  if (c.phone) contactNodes.push(span(c.phone));
  (c.links || []).forEach((l) => {
    const a = document.createElement("a");
    a.href = ensureHttp(l);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = prettyUrl(l);
    Object.assign(a.style, { color: S.mutedColor, textDecoration: "none" });
    contactNodes.push(a);
  });
  if (contactNodes.length) {
    const contactEl = div({ color: S.mutedColor, fontSize: S.smallPt + "pt", marginBottom: "10pt" });
    contactNodes.forEach((node, i) => {
      if (i) contactEl.appendChild(span("   ·   "));
      contactEl.appendChild(node);
    });
    root.appendChild(contactEl);
  }

  const sectionHeader = (title) => {
    const h = div({
      fontVariant: "small-caps",
      fontWeight: "700",
      color: S.accentColor,
      fontSize: S.headerPt + "pt",
      letterSpacing: "0.06em",
      borderBottom: "1px solid " + S.accentColor,
      paddingBottom: "1pt",
      margin: "10pt 0 4pt",
    });
    h.textContent = title;
    return h;
  };

  // Title text that is itself the clickable link when a URL is present
  // (accent-colored as the visual cue).
  const linkedText = (text, url, extraStyles = {}) => {
    if (!url) return span(text, extraStyles);
    const a = document.createElement("a");
    a.href = ensureHttp(url);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = text;
    Object.assign(a.style, extraStyles, { color: S.accentColor, textDecoration: "none" });
    return a;
  };

  // Heading row from segments: {text, bold?, url?} or {sep}. A segment with a
  // url renders as an accent-colored link.
  const entryHeading = (segments, right) => {
    const row = div({
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      gap: "12px",
      margin: "4pt 0 1pt",
    });
    const left = div();
    segments.forEach((seg) => {
      if (seg.sep != null) {
        left.appendChild(span(seg.sep));
        return;
      }
      const styles = seg.bold ? { fontWeight: "700" } : {};
      left.appendChild(seg.url ? linkedText(seg.text, seg.url, styles) : span(seg.text, styles));
    });
    row.appendChild(left);
    if (right && right.text) {
      row.appendChild(span(right.text, {
        color: S.mutedColor,
        fontSize: S.smallPt + "pt",
        whiteSpace: "nowrap",
      }));
    }
    return row;
  };

  // Bullet list; entryFor(index) -> {text, url?}. A url renders as a link.
  const bulletList = (count, entryFor) => {
    const ul = document.createElement("ul");
    Object.assign(ul.style, { margin: "1pt 0 4pt", paddingLeft: "16pt" });
    for (let j = 0; j < count; j++) {
      const info = entryFor(j);
      const li = document.createElement("li");
      li.style.marginBottom = "1pt";
      li.appendChild(info.url ? linkedText(info.text, info.url) : span(info.text));
      ul.appendChild(li);
    }
    return ul;
  };

  if (resume.summary) {
    root.appendChild(sectionHeader("Summary"));
    const p = div({ margin: "2pt 0" });
    p.textContent = resume.summary;
    root.appendChild(p);
  }

  if (Array.isArray(resume.skills) && resume.skills.length) {
    root.appendChild(sectionHeader("Skills"));
    resume.skills.forEach((group) => {
      const line = div({ margin: "1pt 0" });
      if (group.category) {
        line.appendChild(span(group.category, { fontWeight: "700" }));
        line.appendChild(span(":  ", { fontWeight: "700" }));
      }
      line.appendChild(span((group.items || []).join(", ")));
      root.appendChild(line);
    });
  }

  if (Array.isArray(resume.experience) && resume.experience.length) {
    root.appendChild(sectionHeader("Experience"));
    resume.experience.forEach((role) => {
      // The company URL hyperlinks the company NAME (not the job title).
      const segs = [{ text: role.title || "", bold: true }];
      if (role.company) {
        segs.push({ sep: " — " });
        segs.push({ text: role.company, url: role.url });
      }
      if (role.location) {
        segs.push({ sep: " · " });
        segs.push({ text: role.location });
      }
      root.appendChild(entryHeading(segs, { text: role.dates || "" }));
      const bullets = role.bullets || [];
      if (bullets.length) {
        root.appendChild(bulletList(bullets.length, (j) => ({ text: bullets[j] })));
      }
    });
  }

  if (Array.isArray(resume.projects) && resume.projects.length) {
    root.appendChild(sectionHeader("Projects"));
    resume.projects.forEach((proj) => {
      const segs = [{ text: proj.name || "", bold: true, url: proj.url }];
      if (proj.description) {
        segs.push({ sep: " — " });
        segs.push({ text: proj.description });
      }
      root.appendChild(entryHeading(segs, null));
      const bullets = proj.bullets || [];
      if (bullets.length) {
        root.appendChild(bulletList(bullets.length, (j) => ({ text: bullets[j] })));
      }
    });
  }

  if (Array.isArray(resume.education) && resume.education.length) {
    root.appendChild(sectionHeader("Education"));
    resume.education.forEach((edu) => {
      // Support degrees[] (dual/double degree); fall back to a single degree.
      const degrees = Array.isArray(edu.degrees) && edu.degrees.length
        ? edu.degrees.filter(Boolean)
        : edu.degree ? [edu.degree] : [];
      if (degrees.length > 1) {
        // One institution, multiple degrees: heading + each degree as a bullet.
        root.appendChild(entryHeading([{ text: edu.institution || "", bold: true }], { text: edu.dates || "" }));
        root.appendChild(bulletList(degrees.length, (j) => ({ text: degrees[j] })));
      } else {
        const segs = [{ text: edu.institution || "", bold: true }];
        if (degrees[0]) {
          segs.push({ sep: " — " });
          segs.push({ text: degrees[0] });
        }
        root.appendChild(entryHeading(segs, { text: edu.dates || "" }));
      }
      if (edu.details) {
        const p = div({ margin: "1pt 0" });
        p.textContent = edu.details;
        root.appendChild(p);
      }
    });
  }

  if (Array.isArray(resume.certifications) && resume.certifications.length) {
    root.appendChild(sectionHeader("Certifications"));
    root.appendChild(
      bulletList(resume.certifications.length, (j) => {
        const cert = resume.certifications[j];
        const cObj = typeof cert === "string" ? { name: cert } : cert || {};
        return { text: cObj.name || "", url: cObj.url };
      })
    );
  }

  fitSheetWidth(root);
}

// ---------------------------------------------------------------------------
// Sheet fit. Pure client-side, no API cost. The preview is laid out at true
// Letter width so wrapping is realistic; we scale that sheet to fit the panel.
// (Word-count and page-break gauges were removed: page-break estimation
// couldn't match Word's real pagination, and a word-count target gave the user
// less honest control than the model's own one/two-page sizing — see the README
// "Where a prompt lever should not become a UI control" note.)
// ---------------------------------------------------------------------------
const PX_PER_PT = 96 / 72; // CSS: 1pt = 1.333px at 96dpi
const SHEET_WIDTH_PT = 612; // Letter width

function fitSheetWidth(sheet) {
  const avail = el.preview.clientWidth - 4;
  const naturalPx = SHEET_WIDTH_PT * PX_PER_PT;
  const k = avail > 0 ? avail / naturalPx : 1;
  sheet.style.zoom = k > 0.2 && k < 1 ? String(k) : "1";
}

// Re-fit the sheet to the panel when the side panel is resized (geometry is
// fixed, so only the display scale changes).
let fitRaf = null;
window.addEventListener("resize", () => {
  if (fitRaf) cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    const sheet = el.preview.querySelector(".page-sheet");
    if (sheet) fitSheetWidth(sheet);
  });
});

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
function sanitizeFilename(s) {
  return s.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim() || "Resume";
}
// Template: "Resume, <name> - <Job @ Company>.<ext>". Job title and company
// come from the generation's meta field (extracted from the job description);
// falls back to the first-line-of-JD guess when meta is missing.
function buildFilename(ext) {
  const who = sanitizeFilename(lastResume?.name || "Resume");
  const meta = lastResume?.meta || {};
  const job = sanitizeFilename(meta.job_title || lastJobTitle);
  const company = meta.company ? sanitizeFilename(meta.company) : "";
  const target = company ? `${job} @ ${company}` : job;
  return `Resume, ${who} - ${target}.${ext}`;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
async function downloadDocx() {
  if (!lastResume) return;
  clearError();
  try {
    downloadBlob(await resumeJsonToDocx(lastResume, RESUME_STYLES), buildFilename("docx"));
  } catch (err) {
    showError(err);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
el.settingsLink.addEventListener("click", () => chrome.runtime.openOptionsPage());
el.openSettingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
el.generateBtn.addEventListener("click", generate);
el.dlDocxBtn.addEventListener("click", downloadDocx);
el.clearBtn.addEventListener("click", clearFlow);
el.jdInput.addEventListener("input", saveDraft);

checkReadiness();
restoreSession();
