// Makes the toolbar icon open the side panel (there is no default_popup).
// Without this behavior flag, clicking the action button would do nothing.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("sidePanel behavior:", err));
