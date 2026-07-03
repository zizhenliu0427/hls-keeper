const DEFAULT_SERVER = "http://127.0.0.1:17888";

const $ = (id) => document.getElementById(id);

function toast(text) {
  $("toast").textContent = text;
}

function serverUrl() {
  return $("serverUrl").value.trim() || DEFAULT_SERVER;
}

async function api(path, options = {}) {
  const res = await fetch(`${serverUrl()}${path}`, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(typeof body === "string" ? body : JSON.stringify(body));
  return body;
}

async function loadSettings() {
  const value = await chrome.storage.local.get({ serverUrl: DEFAULT_SERVER, enabled: false, discover: false });
  $("serverUrl").value = value.serverUrl;
  $("enabled").checked = value.enabled;
  $("discover").checked = value.discover;
}

async function saveSettings() {
  await chrome.storage.local.set({
    serverUrl: serverUrl(),
    enabled: $("enabled").checked,
    discover: $("discover").checked
  });
  toast("Saved");
  await refresh();
}

function renderCandidates(candidates) {
  const box = $("candidates");
  if (!candidates.length) {
    box.innerHTML = '<div class="muted">No candidates yet. Enable Discover, then play a video.</div>';
    return;
  }
  box.innerHTML = "";
  for (const item of candidates.slice(0, 5)) {
    const variants = item.variants || [];
    const qualities = variants.length
      ? variants.map(v => v.resolution || "auto").filter(Boolean).join(", ")
      : item.resolution || "auto";
    const tags = [
      item.playlist_url ? "playlist" : "",
      item.segment_url ? "segment" : "",
      item.key_url ? "key" : "",
      item.subtitle_urls && Object.keys(item.subtitle_urls).length ? "subtitle" : "",
      item.subtitle_hints && Object.keys(item.subtitle_hints).length ? "subtitle hint" : ""
    ].filter(Boolean).join(" / ");
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="row between">
        <div class="item-title">${item.product || "unknown"}</div>
        <span class="muted">${item.seen || 0} hits</span>
      </div>
      <div class="muted">${qualities}</div>
      <div class="muted">${tags || "media"}</div>
    `;
    box.appendChild(div);
  }
}

function renderJobs(jobs) {
  const box = $("jobs");
  const active = jobs.filter(job => !["complete", "failed"].includes(job.status));
  const show = active.length ? active : jobs.slice(0, 3);
  const totalSpeed = jobs.reduce((sum, job) => sum + Number(job.speed_mbps || 0), 0);
  $("speed").textContent = `${totalSpeed.toFixed(2)} MB/s`;
  if (!show.length) {
    box.innerHTML = '<div class="muted">No active jobs.</div>';
    return;
  }
  box.innerHTML = "";
  for (const job of show) {
    const total = Number(job.total || 0);
    const done = Number(job.done || 0);
    const pct = total ? Math.round(done / total * 100) : 0;
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="row between">
        <div class="item-title">${job.product || "job"} ${job.chosen_resolution || job.resolution || ""}</div>
        <span class="${job.status === "failed" ? "bad" : job.status === "complete" ? "ok" : "warn"}">${job.status || ""}</span>
      </div>
      <progress value="${done}" max="${total || 1}"></progress>
      <div class="muted">${done}/${total} ${pct}% · ${job.speed_mbps || 0} MB/s · failed ${job.failed || 0}</div>
    `;
    box.appendChild(div);
  }
}

async function refresh() {
  try {
    const status = await api("/api/status");
    $("connection").textContent = "connected";
    $("connection").className = "pill ok";
    $("candidateCount").textContent = status.candidates.length;
    $("jobCount").textContent = status.jobs.length;
    $("savedCount").textContent = status.counters.saved || 0;
    renderCandidates(status.candidates || []);
    renderJobs(status.jobs || []);
    toast(status.last_ping ? `Last: ${status.last_ping.reason}` : "Ready");
  } catch (err) {
    $("connection").textContent = "offline";
    $("connection").className = "pill bad";
    $("candidateCount").textContent = "0";
    $("jobCount").textContent = "0";
    $("savedCount").textContent = "0";
    $("candidates").innerHTML = '<div class="muted">Start the local server first.</div>';
    $("jobs").innerHTML = '<div class="muted">No connection.</div>';
    toast(err.message);
  }
}

$("save").addEventListener("click", saveSettings);
$("refresh").addEventListener("click", refresh);
$("start").addEventListener("click", async () => {
  $("discover").checked = true;
  $("enabled").checked = true;
  await saveSettings();
});
$("stop").addEventListener("click", async () => {
  $("enabled").checked = false;
  await saveSettings();
});
$("open").addEventListener("click", () => chrome.tabs.create({ url: `${serverUrl()}/` }));
$("discover").addEventListener("change", saveSettings);
$("enabled").addEventListener("change", saveSettings);

loadSettings().then(refresh);
setInterval(refresh, 1000);
