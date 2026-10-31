// SPDX-License-Identifier: GPL-3.0-or-later
// Toolbar logic. No inline script (strict CSP). All history text is rendered via textContent.
const $ = (id) => document.getElementById(id);
const urlInput = $("url");
const panel = $("panel");
const list = $("list");

function normalizeUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(v)) return "https://" + v;
  return "https://www.google.com/search?q=" + encodeURIComponent(v);
}

function renderHistory(items) {
  list.textContent = "";
  if (!items || !items.length) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.textContent = "No history yet.";
    list.appendChild(empty);
    return;
  }
  for (const h of items) {
    const row = document.createElement("div");
    row.className = "item";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = h.title || h.url;
    const u = document.createElement("div");
    u.className = "u";
    u.textContent = h.url;
    row.append(t, u);
    row.addEventListener("click", () => {
      window.app.navigate(h.url);
      panel.classList.remove("open");
    });
    list.appendChild(row);
  }
}

function setWorkspace(p) {
  const btn = $("ws");
  if (p) {
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
    btn.textContent = "Folder: " + name;
    btn.title = p;
  } else {
    btn.textContent = "Folder: none";
    btn.title = "Choose the project folder the agent works in";
  }
}

$("back").addEventListener("click", () => window.app.back());
$("fwd").addEventListener("click", () => window.app.forward());
$("reload").addEventListener("click", () => window.app.reload());
$("ws").addEventListener("click", async () => setWorkspace(await window.app.pickWorkspace()));
$("hist").addEventListener("click", async () => {
  if (!panel.classList.contains("open")) renderHistory(await window.app.getHistory());
  panel.classList.toggle("open");
});
$("clear").addEventListener("click", async () => {
  await window.app.clearHistory();
  renderHistory([]);
});
urlInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const u = normalizeUrl(urlInput.value);
  if (u) window.app.navigate(u);
});

window.app.onUrl((u) => { if (document.activeElement !== urlInput) urlInput.value = u; });
window.app.onHistory((h) => { if (panel.classList.contains("open")) renderHistory(h); });
window.app.onWorkspace(setWorkspace);
window.app.getWorkspace().then(setWorkspace);
