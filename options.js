// Settings page — where the API key and master sheet are configured. The master
// sheet is ingested into an inventory; the side panel consumes the inventory + key
// from chrome.storage.local.

const el = {
  apiKeyInput: document.getElementById("api-key-input"),
  saveKeyBtn: document.getElementById("save-key-btn"),
  keyStatus: document.getElementById("key-status"),
  dropZone: document.getElementById("drop-zone"),
  browseBtn: document.getElementById("browse-btn"),
  fileInput: document.getElementById("file-input"),
  masterStatus: document.getElementById("master-status"),
  masterSpinner: document.getElementById("master-spinner"),
  inventoryDetails: document.getElementById("inventory-details"),
  inventoryView: document.getElementById("inventory-view"),
  errorBox: document.getElementById("error-box"),
};

function showError(err) {
  el.errorBox.textContent = formatError(err);
  el.errorBox.hidden = false;
}
function clearError() {
  el.errorBox.hidden = true;
  el.errorBox.textContent = "";
}

// ---------------------------------------------------------------------------
// API key
//
// When a key is saved we show the field filled with asterisks as a "populated"
// indicator. The asterisks are a placeholder only — the real key is never
// loaded into the DOM. Focusing the field clears the mask so a fresh key can be
// typed (hidden, via type=password).
// ---------------------------------------------------------------------------
const KEY_MASK = "*".repeat(24);

function showMaskedKey() {
  el.apiKeyInput.type = "text";
  el.apiKeyInput.value = KEY_MASK;
  el.apiKeyInput.dataset.masked = "true";
}

function unmaskKeyForEditing() {
  if (el.apiKeyInput.dataset.masked === "true") {
    el.apiKeyInput.dataset.masked = "false";
    el.apiKeyInput.type = "password";
    el.apiKeyInput.value = "";
  }
}

async function saveKey() {
  if (el.apiKeyInput.dataset.masked === "true") {
    el.keyStatus.textContent = "A key is already saved. Click the field to replace it.";
    return;
  }
  const key = el.apiKeyInput.value.trim();
  if (!key) {
    el.keyStatus.textContent = "Enter a key first.";
    return;
  }
  await chrome.storage.local.set({ apiKey: key });
  showMaskedKey();
  el.keyStatus.textContent = "Key saved.";
}

// ---------------------------------------------------------------------------
// Master sheet status / reports
// ---------------------------------------------------------------------------
function setMasterStatus(text) {
  el.masterStatus.hidden = false;
  el.masterStatus.textContent = text;
}

// Busy state for the (potentially slow) ingestion read: shows a spinner plus a
// ticking elapsed counter so it's clearly working, not frozen, and blocks
// re-triggering a second read while one is running.
let isIngesting = false;
let busyTimer = null;
let busyLabel = "";
let busyStart = 0;

function startBusy(label) {
  isIngesting = true;
  busyLabel = label;
  busyStart = Date.now();
  el.masterSpinner.hidden = false;
  el.dropZone.classList.add("busy");
  const tick = () => {
    const secs = Math.round((Date.now() - busyStart) / 1000);
    setMasterStatus(`${busyLabel} (${secs}s)`);
  };
  tick();
  busyTimer = setInterval(tick, 1000);
}

function setBusyLabel(text) {
  busyLabel = text;
}

function stopBusy() {
  isIngesting = false;
  el.masterSpinner.hidden = true;
  el.dropZone.classList.remove("busy");
  if (busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
}
function renderMasterStatus(meta) {
  if (!meta) {
    el.masterStatus.hidden = true;
    return;
  }
  const when = new Date(meta.ingestedAt).toLocaleString();
  setMasterStatus(`Cached: ${meta.filename} · ingested ${when}`);
}

function renderInventoryView(inventory) {
  if (!inventory) {
    el.inventoryDetails.hidden = true;
    return;
  }
  el.inventoryView.textContent = JSON.stringify(inventory, null, 2);
  el.inventoryDetails.hidden = false;
}

// ---------------------------------------------------------------------------
// Master sheet ingestion — the master file is the only source.
// ---------------------------------------------------------------------------
async function ingestFile(file) {
  if (isIngesting) return;
  clearError();
  const name = file.name || "";
  const ext = name.toLowerCase().split(".").pop();
  if (ext !== "pdf" && ext !== "docx") {
    showError(new UserError("Unsupported file type — upload a .pdf or .docx master sheet."));
    return;
  }

  // Build the API user content from the file.
  let userContent;
  try {
    const buffer = await file.arrayBuffer();
    if (ext === "docx") {
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      const docText = (result.value || "").trim();
      if (!docText) throw new UserError("Couldn't extract any text from that .docx file.");
      userContent =
        "Here is the master career document (text extracted from a .docx file):\n\n" + docText;
    } else {
      userContent = [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: arrayBufferToBase64(buffer),
          },
        },
        { type: "text", text: "Convert this master career document into the JSON inventory now." },
      ];
    }
  } catch (err) {
    showError(err);
    return;
  }

  startBusy(`Reading “${name}”…`);
  try {
    // Single attempt (attempts=1): ingesting a large master is the most
    // expensive call in the app, so a failure surfaces immediately instead of
    // silently doubling the cost with an automatic retry.
    const inventory = await callForJson(
      INGESTION_SYSTEM_PROMPT,
      userContent,
      INGESTION_MAX_TOKENS,
      null,
      1
    );
    const meta = { filename: name, ingestedAt: new Date().toISOString() };
    await chrome.storage.local.set({ inventory, inventoryMeta: meta });
    stopBusy();
    renderMasterStatus(meta);
    renderInventoryView(inventory);
  } catch (err) {
    stopBusy();
    renderMasterStatus(await getInventoryMeta());
    showError(err);
  } finally {
    stopBusy();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
el.saveKeyBtn.addEventListener("click", saveKey);
el.apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveKey();
});
// Clear the asterisk mask when the user starts editing; re-apply it if they
// leave the field empty while a key is still saved.
el.apiKeyInput.addEventListener("focus", unmaskKeyForEditing);
el.apiKeyInput.addEventListener("blur", async () => {
  if (el.apiKeyInput.dataset.masked !== "true" && el.apiKeyInput.value.trim() === "") {
    if (await getApiKey()) showMaskedKey();
  }
});

el.browseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  el.fileInput.click();
});
el.dropZone.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => {
  if (el.fileInput.files.length) ingestFile(el.fileInput.files[0]);
  el.fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropZone.classList.add("dragging");
  })
);
["dragleave", "drop"].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropZone.classList.remove("dragging");
  })
);
el.dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) ingestFile(file);
});

async function restoreState() {
  const [meta, apiKey, inventory] = await Promise.all([
    getInventoryMeta(),
    getApiKey(),
    getInventory(),
  ]);

  renderMasterStatus(meta);
  renderInventoryView(inventory);

  if (apiKey) {
    showMaskedKey();
    el.keyStatus.textContent = "A key is saved for this browser.";
  } else {
    el.keyStatus.textContent = "No key saved yet.";
  }
}

restoreState();
