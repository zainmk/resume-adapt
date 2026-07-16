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
  genStatus: document.getElementById("gen-status"),
  errorBox: document.getElementById("error-box"),
  resultSection: document.getElementById("result-section"),
  regenerateBtn: document.getElementById("regenerate-btn"),
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
    renderPreview(savedResume);
    renderMatch(savedResume.meta);
    el.resultSection.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Match assessment — the generation call self-scores how well the produced
// resume covers the job description (meta.match). Shown as a badge above the
// preview; purely informational, a rough estimate.
// ---------------------------------------------------------------------------
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
  el.regenerateBtn.disabled = true;
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
    renderPreview(resume);
    renderMatch(resume.meta);
    el.resultSection.hidden = false;
    el.genStatus.textContent = "";
  } catch (err) {
    el.genStatus.textContent = "";
    showError(err);
  } finally {
    el.generateBtn.disabled = false;
    el.regenerateBtn.disabled = false;
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
// styled from the same RESUME_STYLES tokens as the .docx/.pdf renderers.
//
// Inline editing: most text carries a data-path back into the lastResume JSON
// and is contenteditable. Edits are written back on blur and persisted, so the
// downloads (rendered from the same JSON) include them. Linked (blue) titles
// stay clickable links and are not inline-editable.
// ---------------------------------------------------------------------------
function renderPreview(resume) {
  const S = RESUME_STYLES;
  const root = el.preview;
  root.textContent = "";
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
  // Marks a node as inline-editable, bound to a JSON path in lastResume.
  // `join` makes the committed text split back into an array (skills items).
  const editable = (node, path, join) => {
    node.contentEditable = "true";
    node.spellcheck = false;
    node.dataset.path = path;
    if (join) node.dataset.join = join;
    node.classList.add("ed");
    return node;
  };

  const nameEl = div({ fontSize: S.namePt + "pt", fontWeight: "700", color: S.accentColor });
  nameEl.textContent = resume.name || "";
  editable(nameEl, "name");
  root.appendChild(nameEl);

  // Contact line — links render with the protocol/www stripped for display but
  // keep the full URL as the click target. Not inline-editable (composite).
  const c = resume.contact || {};
  const contactNodes = [];
  if (c.email) contactNodes.push(span(c.email));
  if (c.phone) contactNodes.push(span(c.phone));
  // contact location intentionally not shown (remote-first)
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

  // Heading row from segments: {text, path?, bold?, url?} or {sep}. Linked
  // segments render as anchors (not editable); pathed segments are editable.
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
      if (seg.url) {
        left.appendChild(linkedText(seg.text, seg.url, styles));
      } else {
        const s = span(seg.text, styles);
        if (seg.path) editable(s, seg.path);
        left.appendChild(s);
      }
    });
    row.appendChild(left);
    if (right && right.text) {
      const r = span(right.text, {
        color: S.mutedColor,
        fontSize: S.smallPt + "pt",
        whiteSpace: "nowrap",
      });
      if (right.path) editable(r, right.path);
      row.appendChild(r);
    }
    return row;
  };

  // Bullet list; entryFor(index) -> {text, url?, path?}. Linked items are
  // anchors; pathed items are editable.
  const bulletList = (count, entryFor) => {
    const ul = document.createElement("ul");
    Object.assign(ul.style, { margin: "1pt 0 4pt", paddingLeft: "16pt" });
    for (let j = 0; j < count; j++) {
      const info = entryFor(j);
      const li = document.createElement("li");
      li.style.marginBottom = "1pt";
      if (info.url) {
        li.appendChild(linkedText(info.text, info.url));
      } else {
        const s = span(info.text);
        if (info.path) editable(s, info.path);
        li.appendChild(s);
      }
      ul.appendChild(li);
    }
    return ul;
  };

  if (resume.summary) {
    root.appendChild(sectionHeader("Summary"));
    const p = div({ margin: "2pt 0" });
    p.textContent = resume.summary;
    editable(p, "summary");
    root.appendChild(p);
  }

  if (Array.isArray(resume.skills) && resume.skills.length) {
    root.appendChild(sectionHeader("Skills"));
    resume.skills.forEach((group, i) => {
      const line = div({ margin: "1pt 0" });
      if (group.category) {
        const cat = span(group.category, { fontWeight: "700" });
        editable(cat, `skills.${i}.category`);
        line.appendChild(cat);
        line.appendChild(span(":  ", { fontWeight: "700" }));
      }
      const items = span((group.items || []).join(", "));
      editable(items, `skills.${i}.items`, ",");
      line.appendChild(items);
      root.appendChild(line);
    });
  }

  if (Array.isArray(resume.experience) && resume.experience.length) {
    root.appendChild(sectionHeader("Experience"));
    resume.experience.forEach((role, i) => {
      const segs = [
        { text: role.title || "", bold: true, url: role.url, path: `experience.${i}.title` },
      ];
      if (role.company) {
        segs.push({ sep: " — " });
        segs.push({ text: role.company, path: `experience.${i}.company` });
      }
      if (role.location) {
        segs.push({ sep: " · " });
        segs.push({ text: role.location, path: `experience.${i}.location` });
      }
      root.appendChild(entryHeading(segs, { text: role.dates || "", path: `experience.${i}.dates` }));
      const bullets = role.bullets || [];
      if (bullets.length) {
        root.appendChild(
          bulletList(bullets.length, (j) => ({
            text: bullets[j],
            path: `experience.${i}.bullets.${j}`,
          }))
        );
      }
    });
  }

  if (Array.isArray(resume.projects) && resume.projects.length) {
    root.appendChild(sectionHeader("Projects"));
    resume.projects.forEach((proj, i) => {
      const segs = [
        { text: proj.name || "", bold: true, url: proj.url, path: `projects.${i}.name` },
      ];
      if (proj.description) {
        segs.push({ sep: " — " });
        segs.push({ text: proj.description, path: `projects.${i}.description` });
      }
      root.appendChild(entryHeading(segs, null));
      const bullets = proj.bullets || [];
      if (bullets.length) {
        root.appendChild(
          bulletList(bullets.length, (j) => ({
            text: bullets[j],
            path: `projects.${i}.bullets.${j}`,
          }))
        );
      }
    });
  }

  if (Array.isArray(resume.education) && resume.education.length) {
    root.appendChild(sectionHeader("Education"));
    resume.education.forEach((edu, i) => {
      const segs = [
        { text: edu.institution || "", bold: true, path: `education.${i}.institution` },
      ];
      if (edu.degree) {
        segs.push({ sep: " — " });
        segs.push({ text: edu.degree, path: `education.${i}.degree` });
      }
      root.appendChild(entryHeading(segs, { text: edu.dates || "", path: `education.${i}.dates` }));
      if (edu.details) {
        const p = div({ margin: "1pt 0" });
        p.textContent = edu.details;
        editable(p, `education.${i}.details`);
        root.appendChild(p);
      }
    });
  }

  if (Array.isArray(resume.certifications) && resume.certifications.length) {
    root.appendChild(sectionHeader("Certifications"));
    root.appendChild(
      bulletList(resume.certifications.length, (j) => {
        const cert = resume.certifications[j];
        const isString = typeof cert === "string";
        const cObj = isString ? { name: cert } : cert || {};
        return {
          text: cObj.name || "",
          url: cObj.url,
          path: isString ? `certifications.${j}` : `certifications.${j}.name`,
        };
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Inline-edit plumbing — delegated on the preview container. Committed text is
// written back into lastResume at the element's data-path and persisted, so
// downloads pick the edits up. Enter commits, Escape reverts.
// ---------------------------------------------------------------------------
function setByPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = /^\d+$/.test(keys[i]) ? Number(keys[i]) : keys[i];
    if (o == null || o[k] == null) return;
    o = o[k];
  }
  const last = keys[keys.length - 1];
  o[/^\d+$/.test(last) ? Number(last) : last] = value;
}

el.preview.addEventListener("focusin", (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.path) t.dataset.orig = t.textContent;
});

el.preview.addEventListener("keydown", (e) => {
  const t = e.target;
  if (!t.dataset || !t.dataset.path) return;
  if (e.key === "Enter") {
    e.preventDefault();
    t.blur();
  } else if (e.key === "Escape") {
    t.textContent = t.dataset.orig ?? t.textContent;
    t.blur();
  }
});

el.preview.addEventListener("focusout", async (e) => {
  const t = e.target;
  if (!t.dataset || !t.dataset.path || !lastResume) return;
  const text = (t.textContent || "").replace(/\s+/g, " ").trim();
  if (text === (t.dataset.orig ?? "")) return;
  t.textContent = text; // normalize whatever contenteditable left behind
  const value = t.dataset.join
    ? text.split(t.dataset.join).map((s) => s.trim()).filter(Boolean)
    : text;
  setByPath(lastResume, t.dataset.path, value);
  await saveResult(lastResume, lastJobTitle);
});

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
function sanitizeFilename(s) {
  return s.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim() || "Resume";
}
// Template: "Resume, <name> - <Job & Company>.<ext>". Job title and company
// come from the generation's meta field (extracted from the job description);
// falls back to the first-line-of-JD guess when meta is missing.
function buildFilename(ext) {
  const who = sanitizeFilename(lastResume?.name || "Resume");
  const meta = lastResume?.meta || {};
  const job = sanitizeFilename(meta.job_title || lastJobTitle);
  const company = meta.company ? sanitizeFilename(meta.company) : "";
  const target = company ? `${job} & ${company}` : job;
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
el.regenerateBtn.addEventListener("click", generate);
el.dlDocxBtn.addEventListener("click", downloadDocx);
el.jdInput.addEventListener("input", saveDraft);

checkReadiness();
restoreSession();
