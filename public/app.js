let selectedUrl = null;
let activeSSE = null;

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDuration(sec) {
  if (!sec) return "";
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function watchUrl(url, format) {
  return `/watch?v=${encodeURIComponent(url)}&f=${encodeURIComponent(format || "720")}`;
}

function fetchUrl(url, format) {
  return `/api/fetch?url=${encodeURIComponent(url)}&format=${encodeURIComponent(format || "720")}`;
}

async function search() {
  const q = document.getElementById("searchBox").value.trim();
  if (!q) return;
  const resultsEl = document.getElementById("results");
  resultsEl.innerHTML = `<div class="empty-state">Searching...</div>`;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();

    if (!data.length) {
      resultsEl.innerHTML = `<div class="empty-state">No results.</div>`;
      return;
    }

    resultsEl.innerHTML = "";
    data.forEach(v => {
      const card = document.createElement("div");
      card.className = "result-card";
      card.dataset.url = v.url;

      const thumbHtml = v.thumbnail
        ? `<img class="result-thumb" src="${esc(v.thumbnail)}" alt="" loading="lazy">`
        : `<div class="result-thumb-placeholder">▶</div>`;

      const duration = v.duration ? `${esc(formatDuration(v.duration))} · ` : "";

      card.innerHTML = `
        ${thumbHtml}
        <div class="result-info">
          <div class="result-title">${esc(v.title)}</div>
          <div class="result-meta">${duration}${esc(v.uploader || "")}</div>
        </div>
        <div class="result-actions">
          <a class="btn small" href="${esc(watchUrl(v.url))}" target="_blank">▶ Watch</a>
          <button class="small" onclick="quickFetch('${esc(v.url)}', '720')">↓</button>
          <button class="small select-btn">Select</button>
        </div>
      `;

      card.querySelector(".select-btn").addEventListener("click", e => {
        e.stopPropagation();
        selectResult(v.url, card);
      });
      card.querySelector(".result-thumb, .result-thumb-placeholder, .result-info")?.addEventListener?.("click", () => selectResult(v.url, card));

      resultsEl.appendChild(card);
    });
  } catch {
    resultsEl.innerHTML = `<div class="empty-state">Search failed.</div>`;
  }
}

function selectResult(url, card) {
  document.querySelectorAll(".result-card").forEach(c => c.classList.remove("selected"));
  card.classList.add("selected");
  document.getElementById("url").value = url;
  selectedUrl = url;
  document.getElementById("url").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function quickFetch(url, format) {
  const a = document.createElement("a");
  a.href = fetchUrl(url, format);
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function startDownload() {
  const url = document.getElementById("url").value.trim();
  const format = document.getElementById("format").value;
  if (!url) return;

  const progressWrap = document.getElementById("progressWrap");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const downloadResult = document.getElementById("downloadResult");
  const errorMsg = document.getElementById("errorMsg");

  progressWrap.classList.add("visible");
  downloadResult.classList.remove("visible");
  errorMsg.classList.remove("visible");
  progressBar.style.width = "0%";
  progressText.textContent = "Starting...";

  if (activeSSE) activeSSE.close();

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, format })
    });
    const data = await res.json();
    if (!res.ok || !data.jobId) throw new Error(data.error || "Failed to start");

    activeSSE = new EventSource(`/api/progress/${data.jobId}`);
    activeSSE.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.progress !== undefined) {
        progressBar.style.width = msg.progress + "%";
        progressText.textContent = msg.status || `${msg.progress}%`;
      }
      if (msg.done) {
        activeSSE.close();
        progressBar.style.width = "100%";
        progressText.textContent = "Complete";
        downloadResult.classList.add("visible");
        const link = document.getElementById("downloadLink");
        link.href = msg.file || "/downloads";
        link.textContent = msg.filename || "open file";
        loadHistory();
      }
      if (msg.error) {
        activeSSE.close();
        progressWrap.classList.remove("visible");
        errorMsg.textContent = msg.error;
        errorMsg.classList.add("visible");
      }
    };
    activeSSE.onerror = () => {
      activeSSE.close();
      progressWrap.classList.remove("visible");
      errorMsg.textContent = "Connection lost.";
      errorMsg.classList.add("visible");
    };
  } catch (err) {
    progressWrap.classList.remove("visible");
    errorMsg.textContent = err.message || "Download failed.";
    errorMsg.classList.add("visible");
  }
}

function startFetch() {
  const url = document.getElementById("url").value.trim();
  const format = document.getElementById("format").value;
  if (!url) return;
  quickFetch(url, format);
}

async function loadHistory() {
  const res = await fetch("/api/history");
  const data = await res.json();
  const el = document.getElementById("history");

  if (!data.length) {
    el.innerHTML = `<div class="empty-state">No downloads yet.</div>`;
    return;
  }

  el.innerHTML = "";
  data.forEach(h => {
    const item = document.createElement("div");
    item.className = "history-item";
    const isAudio = h.format === "audio";
    item.innerHTML = `
      <div class="history-info">
        <div class="history-url">${esc(h.url)}</div>
        <div class="history-meta">${esc(timeAgo(h.time))}</div>
      </div>
      <div class="badge ${isAudio ? "audio" : ""}">${esc(isAudio ? "mp3" : h.format + "p")}</div>
      <div class="history-actions">
        ${!isAudio ? `<a class="btn small" href="${esc(watchUrl(h.url, h.format))}" target="_blank">▶</a>` : ""}
        <button class="small" onclick="quickFetch('${esc(h.url)}', '${esc(h.format)}')">↓</button>
        <button class="small" onclick="reuse('${esc(h.url)}', '${esc(h.format)}')">↻</button>
      </div>
    `;
    el.appendChild(item);
  });
}

function reuse(url, format) {
  document.getElementById("url").value = url;
  const sel = document.getElementById("format");
  for (let o of sel.options) if (o.value === format) o.selected = true;
  document.getElementById("download-section").scrollIntoView({ behavior: "smooth" });
}

document.getElementById("searchBox").addEventListener("keydown", e => {
  if (e.key === "Enter") search();
});

loadHistory();