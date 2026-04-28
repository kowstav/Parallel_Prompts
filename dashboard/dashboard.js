// dashboard/dashboard.js — boot script for dashboard mode
document.addEventListener("DOMContentLoaded", () => {
  window.PP_APP.init({ mode: "dashboard", root: document.getElementById("appRoot") });
});
