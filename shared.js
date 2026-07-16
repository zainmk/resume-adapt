// Shared across sidepanel.js and options.js (both load this as a classic
// script, so everything here lives on the global scope).

// ---------------------------------------------------------------------------
// Shared resume style tokens — consumed by render-docx.js, render-pdf.js, and
// the side panel's HTML preview so all three outputs match.
// ---------------------------------------------------------------------------
const RESUME_STYLES = {
  accentColor: "#1a4f8b",
  bodyColor: "#1a1a1a",
  mutedColor: "#5a5a5a",
  fontDocx: "Calibri",
  fontPreview: "'Calibri', 'Segoe UI', sans-serif",
  namePt: 21,
  headerPt: 9.5,
  bodyPt: 10.5,
  smallPt: 9,
};

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const GENERATION_MAX_TOKENS = 4096;
// Ingestion output headroom. The distillation prompt keeps the typical
// inventory well under this; the generous cap exists so the verbose tail of
// the output distribution succeeds on the first (and only) attempt instead of
// truncating mid-JSON.
const INGESTION_MAX_TOKENS = 16000;

// A user-facing error whose message is safe to show verbatim.
class UserError extends Error {}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return apiKey || "";
}

async function getInventory() {
  const { inventory } = await chrome.storage.local.get("inventory");
  return inventory || null;
}

async function getInventoryMeta() {
  const { inventoryMeta } = await chrome.storage.local.get("inventoryMeta");
  return inventoryMeta || null;
}


// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
function formatError(err) {
  console.error(err);
  if (err instanceof UserError) return err.message;
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return "Network error — check your connection and try again.";
  }
  return "Something went wrong: " + (err && err.message ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
// Per-request wall-clock cap so a stuck call fails loudly instead of hanging
// forever. Generous, because ingesting a large master sheet is a one-time,
// non-streaming call that can legitimately take a couple of minutes.
const REQUEST_TIMEOUT_MS = 300000;

async function postMessages(apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new UserError(
        "The request timed out. A very large master sheet can take a while to ingest — try again, or trim the document."
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new UserError("The API rejected your key (401). Check the key in Settings.");
    }
    if (res.status === 429) {
      throw new UserError("Rate limited by the API (429). Wait a moment and try again.");
    }
    let detail = "";
    try {
      const errBody = await res.json();
      if (errBody && errBody.error && errBody.error.message) detail = ": " + errBody.error.message;
    } catch (_) { /* non-JSON error body */ }
    throw new UserError(`API error (HTTP ${res.status})${detail}`);
  }
  return res.json();
}

async function callClaude(system, userContent, maxTokens) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new UserError("No API key saved. Add your Anthropic API key in Settings.");
  }

  const data = await postMessages(apiKey, {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userContent }],
  });
  if (data.usage) {
    // Prompt-cache visibility (DevTools console): "read" tokens billed ~0.1x,
    // "creation" tokens ~2x (1h TTL write), "input" tokens full price.
    console.debug(
      `[ResumeAdapt] tokens — input: ${data.usage.input_tokens}, ` +
        `cache write: ${data.usage.cache_creation_input_tokens || 0}, ` +
        `cache read: ${data.usage.cache_read_input_tokens || 0}, ` +
        `output: ${data.usage.output_tokens}`
    );
  }
  if (data.stop_reason === "refusal") {
    throw new UserError("The model declined this request.");
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { text, stopReason: data.stop_reason };
}

function stripFences(text) {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  // Fall back to the outermost JSON object if any commentary leaked through.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last > first) t = t.slice(first, last + 1);
  return t.trim();
}

// Call the model expecting JSON; on a parse failure, retry up to `attempts`
// total calls (default 2). `onRetry` is invoked before each extra attempt.
// Pass attempts=1 for expensive calls (ingestion) where a silent second try
// would double the cost.
async function callForJson(system, userContent, maxTokens, onRetry, attempts = 2) {
  let lastStopReason = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { text, stopReason } = await callClaude(system, userContent, maxTokens);
    lastStopReason = stopReason;
    try {
      return JSON.parse(stripFences(text));
    } catch (_) {
      if (attempt < attempts - 1 && typeof onRetry === "function") onRetry();
    }
  }
  throw new UserError(
    lastStopReason === "max_tokens"
      ? "The model's output was cut off before the JSON was complete. Try again, or trim the master sheet."
      : `The model returned malformed JSON${attempts > 1 ? " twice" : ""}. Try again.`
  );
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
