// popup/popup.js — boot script for popup mode
document.addEventListener("DOMContentLoaded", () => {
  window.PP_APP.init({ mode: "popup", root: document.getElementById("appRoot") });

  const expandBtn = document.getElementById("expandBtn");
  if (expandBtn) {
    expandBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
      window.close();
    });
  }
});
