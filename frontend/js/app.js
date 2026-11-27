const $ = id => document.getElementById(id);

let selected = [];
let results = [];
let authMode = "login";
let lang = "id";

const API = (
  window.AHOY_API_URL ||
  "https://ahoy-s-productions-convert.onrender.com"
).replace(/\/$/, "");

const translations = {
  id: {
    navConverter: "Converter",
    navMembership: "Membership",
    heroText: "Convert audio dengan kontrol penuh, kualitas terjaga, dan workflow yang simpel.",
    start: "MULAI CONVERT",
    converterTitle: "Audio Converter",
    dropTitle: "Letakkan file audio di sini",
    dropSub: "atau klik untuk memilih beberapa file sekaligus"
  },
  en: {
    navConverter: "Converter",
    navMembership: "Membership",
    heroText: "Convert audio with full control, preserved quality, and a simple workflow.",
    start: "START CONVERTING",
    converterTitle: "Audio Converter",
    dropTitle: "Drop audio files here",
    dropSub: "or click to select multiple files at once"
  }
};

// LANGUAGE
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach(e => {
    const value = translations[lang][e.dataset.i18n];
    if (value) e.textContent = value;
  });
  $("langBtn").textContent = lang === "id" ? "EN" : "ID";
}
$("langBtn").onclick = () => {
  lang = lang === "id" ? "en" : "id";
  applyLang();
};

// FILE SELECTION
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function addFiles(list) {
  selected = [...selected, ...Array.from(list)];
  $("fileList").innerHTML = selected.map((f, i) =>
    `<div>${i + 1}. ${escapeHtml(f.name)} · ${(f.size / 1048576).toFixed(2)} MB</div>`
  ).join("");
  if (selected[0]) $("originalPreview").src = URL.createObjectURL(selected[0]);
}
$("browse").onclick = () => $("files").click();
$("dropzone").onclick = e => {
  if (e.target.tagName !== "BUTTON") $("files").click();
};
$("files").onchange = e => addFiles(e.target.files);
$("dropzone").ondragover = e => {
  e.preventDefault();
  $("dropzone").classList.add("drag");
};
$("dropzone").ondrop = e => {
  e.preventDefault();
  $("dropzone").classList.remove("drag");
  addFiles(e.dataTransfer.files);
};

// ROBLOX PLAYBACK COMPENSATION
// OFF: process at the chosen custom speed (including its matching pitch shift),
// then set Roblox PlaybackSpeed to the reciprocal so Studio playback returns
// to the source tempo and pitch. ON keeps the existing target-speed workflow.
function getRobloxTargetSpeed() {
  const originalMode = Boolean($("robloxMode")?.checked);
  if (originalMode) return Math.max(0.05, Math.min(2, Number($("targetSpeed")?.value) || 1));
  const custom = Math.max(0.5, Math.min(3, Number($("manualSpeed")?.value) || 1));
  return 1 / custom;
}

function syncRobloxModeUI({ live = false } = {}) {
  const originalMode = Boolean($("robloxMode")?.checked);
  const custom = Math.max(
    0.5,
    Math.min(3, Number($("manualSpeed")?.value) || 1)
  );
  const target = getRobloxTargetSpeed();

  const targetInput = $("targetSpeed");
  const speedInput = $("manualSpeed");
  const pitchInput = $("pitch");

  if (targetInput && !originalMode) {
    targetInput.value = target.toFixed(4);
  }

  // Properti mode hanya diperbarui saat sinkronisasi penuh.
  if (!live) {
    if (targetInput) targetInput.readOnly = !originalMode;

    if (speedInput) {
      speedInput.min = "0.5";
      speedInput.max = "3";
      speedInput.disabled = originalMode;
    }

    if (pitchInput) pitchInput.disabled = !originalMode;

    if (!originalMode && $("preservePitch")) {
      $("preservePitch").checked = false;
    }
  }

  const speedValue = $("manualSpeedValue");
  const pitchValue = $("pitchValue");

  if (speedValue) {
    speedValue.textContent = originalMode
      ? "AUTO"
      : `${custom.toFixed(2)}x`;
  }

  if (pitchValue) {
    const pitchPercent = (custom - 1) * 100;
    pitchValue.textContent = originalMode
      ? "AUTO"
      : `AUTO ${pitchPercent >= 0 ? "+" : ""}${pitchPercent.toFixed(1)}%`;
  }

  // Hindari penulisan ulang teks panjang selama slider digeser.
  if (!live) {
    const hint = $("speedHint");

    if (hint) {
      hint.textContent = originalMode
        ? `AUTO MODE · Target ${target.toFixed(2)}x · Existing Roblox Original Sound compensation is active.`
        : `MANUAL MODE · Custom Speed ${custom.toFixed(2)}x → Target Roblox PlaybackSpeed ${target.toFixed(4)}x · Pitch is automatically matched and compensated.`;
    }
  }
}

// Batasi sinkronisasi realtime maksimal satu kali per frame.
let speedSyncFrame = 0;

window.addEventListener("input", event => {
  if (!["manualSpeed", "targetSpeed", "robloxMode"].includes(event.target?.id)) {
    return;
  }

  if (speedSyncFrame) return;

  speedSyncFrame = requestAnimationFrame(() => {
    speedSyncFrame = 0;
    syncRobloxModeUI({ live: true });
  });
});

window.addEventListener("change", event => {
  if (!["manualSpeed", "targetSpeed", "robloxMode"].includes(event.target?.id)) {
    return;
  }

  if (speedSyncFrame) {
    cancelAnimationFrame(speedSyncFrame);
    speedSyncFrame = 0;
  }

  syncRobloxModeUI();
});

syncRobloxModeUI();
document.addEventListener("DOMContentLoaded", () => syncRobloxModeUI());


// AUDIO CONVERTER
$("convert").onclick = async () => {
  if (!selected.length) return alert("Select audio files first.");
  $("convert").disabled = true;
  results = [];
  $("jobs").innerHTML = "";

  try {
    for (let i = 0; i < selected.length; i++) {
      const f = selected[i];
      const row = document.createElement("div");
      row.className = "job";
      row.innerHTML = `
        <b>${escapeHtml(f.name)}</b>
        <p>Uploading / converting...</p>
        <progress max="100" value="15"></progress>
      `;
      $("jobs").append(row);

      const fd = new FormData();
      fd.append("file", f);
      const opts = {
        format: $("format").value,
        bitrate: $("bitrate").value,
        sampleRate: $("sampleRate").value,
        targetSpeed: getRobloxTargetSpeed(),
        manualSpeed: $("manualSpeed").value,
        robloxMode: $("robloxMode").checked,
        preservePitch: $("preservePitch").checked,
        gain: $("gain").value,
        pitch: $("pitch").value,
        trimStart: $("trimStart").value,
        trimDuration: $("trimDuration").value,
        wavBits: $("wavBits").value
      };
      fd.append("options", JSON.stringify(opts));

      const token = localStorage.getItem("ahoyToken");
      const res = await fetch(API + "/api/convert", {
        method: "POST",
        headers: token ? { Authorization: "Bearer " + token } : {},
        body: fd
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Conversion failed");

      const convertedRecord = {
        name: data.filename,
        downloadName: data.downloadFilename || data.filename,
        url: API + data.downloadUrl
      };
      results.push(convertedRecord);
      row.querySelector("p").textContent = "Completed";
      row.querySelector("progress").value = 100;

      // Optimistic local update: update the counter immediately without reloading.
      if (localStorage.getItem("ahoyToken")) updateMyUsageAfterConversion();

      row.insertAdjacentHTML(
        "beforeend",
        `<p><a href="${API + data.downloadUrl}" download="${escapeHtml(data.downloadFilename || data.filename)}">Download ${escapeHtml(data.downloadFilename || data.filename)}</a></p>`
      );
      attachRobloxUploadControl(row, convertedRecord);
      if (i === 0) $("convertedPreview").src = API + data.downloadUrl;
    }
    $("downloadZip").disabled = !results.length;
  } catch (err) {
    alert(err.message);
  } finally {
    $("convert").disabled = false;
  }
};

// DOWNLOAD ZIP
$("downloadZip").onclick = async () => {
  const token = localStorage.getItem("ahoyToken");
  const r = await fetch(API + "/api/download-zip", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {})
    },
    body: JSON.stringify({ files: results.map(x => ({ name: x.name, downloadName: x.downloadName })) })
  });
  if (!r.ok) {
    let e = await r.json();
    return alert(e.error || "ZIP unavailable");
  }
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ahoys-converted-audio.zip";
  a.click();
  URL.revokeObjectURL(a.href);
};


// ===============================
// AHOY'S AUTO SPLIT
// ===============================
function initAhoyAutoSplit() {
  if ($("ahoyAutoSplit")) return;
  const anchor = $("jobs") || $("downloadZip");
  if (!anchor?.parentElement) return;

  const style = document.createElement("style");
  style.id = "ahoyAutoSplitStyles";
  style.textContent = `
    #ahoyAutoSplit{margin:22px 0;padding:18px;border:1px solid rgba(214,174,91,.28);border-radius:16px;background:linear-gradient(145deg,rgba(24,24,27,.96),rgba(10,10,12,.96));color:#f4f0e8}
    #ahoyAutoSplit h3{margin:0 0 6px;color:#e5c47e;font-size:17px;letter-spacing:.04em}
    #ahoyAutoSplit p{margin:0;color:#aaa;font-size:12px;line-height:1.6}
    #ahoyAutoSplit .as-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
    #ahoyAutoSplit button,#ahoyAutoSplit select{border:1px solid rgba(218,183,112,.4);border-radius:9px;padding:10px 13px;background:#171717;color:#f0d69b;font-weight:700}
    #ahoyAutoSplit button{cursor:pointer}
    #ahoyAutoSplit button:disabled{opacity:.5;cursor:wait}
    #ahoyAutoSplit .as-file{color:#ddd;font-size:12px;overflow-wrap:anywhere}
    #ahoyAutoSplit .as-parts{display:grid;gap:7px;margin-top:14px}
    #ahoyAutoSplit .as-part{display:block;padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:rgba(255,255,255,.025);font-size:12px}
    #ahoyAutoSplit .as-part-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
    #ahoyAutoSplit .as-part-name{color:#eee;font-weight:700;overflow-wrap:anywhere}
    #ahoyAutoSplit .as-part a{color:#e5c47e;text-decoration:none;font-weight:700}
    #ahoyAutoSplit .as-part-range{margin-top:4px;color:#999;font-size:11px}
    #ahoyAutoSplit .as-preview-label{margin-top:12px;color:#c8b27f;font-size:10px;font-weight:800;letter-spacing:.08em}
    #ahoyAutoSplit .as-preview{display:block;width:100%;height:38px;margin-top:6px;filter:sepia(.12);}
    #ahoyAutoSplit .as-status{margin-top:12px;color:#e5c47e;font-size:12px}
    @media(max-width:560px){#ahoyAutoSplit{padding:14px}#ahoyAutoSplit .as-row>*{width:100%;box-sizing:border-box}}
  `;
  document.head.appendChild(style);

  anchor.insertAdjacentHTML("afterend", `
    <section id="ahoyAutoSplit">
      <h3>AHOY'S AUTO SPLIT</h3>
      <p>Potong audio panjang menjadi beberapa part. Kedua mode menerapkan Fade In dan Fade Out otomatis; Split + Convert juga menerapkan pengaturan format converter.</p>
      <div class="as-row"><label for="ahoySplitMode">Mode</label><select id="ahoySplitMode"><option value="split-convert" selected>Split + Convert</option><option value="split-only">Split Only</option></select>
        <label for="ahoySplitBaseName">Nama hasil</label><input id="ahoySplitBaseName" type="text" maxlength="80" placeholder="Otomatis dari nama file" style="min-width:210px;border:1px solid rgba(218,183,112,.4);border-radius:9px;padding:10px 13px;background:#171717;color:#f0d69b">
        <label for="ahoySplitFade">Fade In/Out</label><select id="ahoySplitFade"><option value="1">1 detik</option><option value="2">2 detik</option><option value="3" selected>3 detik</option><option value="5">5 detik</option><option value="8">8 detik</option></select></div>
      <input id="ahoySplitFile" type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus" hidden>
      <div class="as-row">
        <button type="button" id="ahoySplitBrowse">Pilih Audio</button>
        <span class="as-file" id="ahoySplitFileName">Belum ada file dipilih</span>
        <label for="ahoySplitMinutes">Durasi setiap part</label>
        <select id="ahoySplitMinutes">
          <option value="6" selected>6 menit</option>
          <option value="5">5 menit</option>
          <option value="4">4 menit</option>
          <option value="3">3 menit</option>
          <option value="2">2 menit</option>
          <option value="1">1 menit</option>
        </select>
        <button type="button" id="ahoySplitStart">AUTO SPLIT</button>
        <button type="button" id="ahoySplitZip" disabled>DOWNLOAD ZIP</button>
      </div>
      <div class="as-status" id="ahoySplitStatus" aria-live="polite"></div>
      <div class="as-row"><button type="button" id="ahoySplitUploadAll" disabled>UPLOAD SEMUA PART KE ROBLOX</button></div>
      <div class="as-parts" id="ahoySplitParts"></div>
    </section>
  `);

  let splitFile = null;
  let splitResults = [];
  $("ahoySplitBrowse").onclick = () => $("ahoySplitFile").click();
  $("ahoySplitFile").onchange = event => {
    splitFile = event.target.files?.[0] || null;
    $("ahoySplitFileName").textContent = splitFile ? `${splitFile.name} · ${(splitFile.size / 1048576).toFixed(2)} MB` : "Belum ada file dipilih";
    splitResults = [];
    $("ahoySplitBaseName").value = splitFile ? splitFile.name.replace(/\.[^.]+$/, "") : "";
    $("ahoySplitParts").innerHTML = "";
    $("ahoySplitZip").disabled = true;
    $("ahoySplitStatus").textContent = "";
  };

  $("ahoySplitStart").onclick = async () => {
    if (!splitFile) return alert("Pilih satu file audio terlebih dahulu.");
    const button = $("ahoySplitStart");
    button.disabled = true;
    $("ahoySplitZip").disabled = true;
    $("ahoySplitParts").innerHTML = "";
    $("ahoySplitStatus").textContent = "Memproses audio dan membagi part...";
    try {
      const form = new FormData();
      form.append("file", splitFile);
      // Auto Split applies the same audio effects as the main converter to EACH part.
      // Trim is intentionally excluded so the complete source timeline is preserved.
      form.append("options", JSON.stringify({
        format: $("format")?.value || "mp3",
        bitrate: $("bitrate")?.value || "320",
        sampleRate: $("sampleRate")?.value || "48000",
        wavBits: $("wavBits")?.value || "24",
        targetSpeed: getRobloxTargetSpeed(),
        manualSpeed: $("manualSpeed")?.value || "1",
        robloxMode: Boolean($("robloxMode")?.checked),
        preservePitch: Boolean($("preservePitch")?.checked),
        gain: $("gain")?.value || "0",
        pitch: $("pitch")?.value || "0",
        partMinutes: $("ahoySplitMinutes").value,
        splitOnly: $("ahoySplitMode").value === "split-only",
        baseName: $("ahoySplitBaseName").value.trim(),
        fadeSeconds: Number($("ahoySplitFade").value || 3),
        sourceFormat: (splitFile.name.split(".").pop() || "mp3").toLowerCase()
      }));
      const token = localStorage.getItem("ahoyToken");
      const response = await fetch(API + "/api/split", {
        method: "POST",
        headers: token ? { Authorization: "Bearer " + token } : {},
        body: form
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Auto Split failed");
      splitResults = data.files || [];
      $("ahoySplitStatus").textContent = `Selesai · ${data.partCount} part · Fade In/Out ${data.appliedEffects?.fadeIn || 0}s · ${(data.duration / 60).toFixed(2)} menit total`;
      $("ahoySplitParts").innerHTML = "";
      splitResults.forEach(file => {
        const item = document.createElement("div");
        item.className = "as-part";

        const head = document.createElement("div");
        head.className = "as-part-head";
        const details = document.createElement("div");
        const name = document.createElement("div");
        name.className = "as-part-name";
        name.textContent = file.downloadFilename;
        const range = document.createElement("div");
        range.className = "as-part-range";
        const formatTime = seconds => {
          const total = Math.max(0, Math.floor(Number(seconds) || 0));
          return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
        };
        range.textContent = `Sumber ${formatTime(file.start)} – ${formatTime((Number(file.start) || 0) + (Number(file.duration) || 0))}`;
        details.append(name, range);

        const download = document.createElement("a");
        download.href = API + file.downloadUrl;
        download.download = file.downloadFilename;
        download.textContent = "Download";
        head.append(details, download);

        const previewLabel = document.createElement("div");
        previewLabel.className = "as-preview-label";
        previewLabel.textContent = "PREVIEW AUDIO PART · FADE IN / FADE OUT";
        const preview = document.createElement("audio");
        preview.className = "as-preview";
        preview.controls = true;
        preview.preload = "none";
        preview.src = API + (file.previewUrl || ("/api/preview/" + encodeURIComponent(file.filename)));
        preview.setAttribute("aria-label", `Preview ${file.downloadFilename}`);
        preview.addEventListener("play", () => {
          document.querySelectorAll("#ahoySplitParts audio.as-preview").forEach(other => {
            if (other !== preview) other.pause();
          });
        });

        item.append(head, previewLabel, preview);
        attachRobloxUploadControl(item, file);
        $("ahoySplitParts").append(item);
      });
      $("ahoySplitZip").disabled = !splitResults.length;
      $("ahoySplitUploadAll").disabled = !splitResults.length;
      if (localStorage.getItem("ahoyToken")) updateMyUsageAfterConversion();
    } catch (error) {
      $("ahoySplitStatus").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };

  $("ahoySplitUploadAll").onclick = async () => {
    if (!splitResults.length) return;
    const button = $("ahoySplitUploadAll");
    button.disabled = true;
    let completed = 0;
    for (const file of splitResults) {
      const result = await uploadAudioToRoblox(file);
      completed++;
      if (!result.ok) {
        $("ahoySplitStatus").textContent = `Upload ${completed}/${splitResults.length}: ${result.error}`;
        break;
      }
      const row = [...$("ahoySplitParts").children].find(el => el.textContent.includes(file.downloadFilename));
      const status = row?.querySelector(".ahoy-roblox-upload-status");
      if (status) status.textContent = `Uploaded · Audio ID: ${result.assetId}`;
      $("ahoySplitStatus").textContent = `Roblox upload ${completed}/${splitResults.length} selesai...`;
    }
    if (completed === splitResults.length) $("ahoySplitStatus").textContent = `Semua ${completed} part berhasil dikirim ke Roblox secara berurutan.`;
    button.disabled = false;
  };

  $("ahoySplitZip").onclick = async () => {
    if (!splitResults.length) return;
    const button = $("ahoySplitZip");
    button.disabled = true;
    try {
      const token = localStorage.getItem("ahoyToken");
      const response = await fetch(API + "/api/download-zip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {})
        },
        body: JSON.stringify({ files: splitResults.map(file => ({ name: file.filename, downloadName: file.downloadFilename })) })
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "ZIP unavailable");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "ahoys-auto-split.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  };
}

// ===============================
// ROBLOX CREATOR HUB CONNECTION + UPLOAD
// ===============================
async function robloxRequest(path, options = {}) {
  const token = localStorage.getItem("ahoyToken");
  const response = await fetch(API + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Roblox request failed");
  return data;
}

async function uploadAudioToRoblox(file) {
  try {
    const data = await robloxRequest("/api/roblox/upload", {
      method: "POST",
      body: JSON.stringify({
        filename: file.filename || file.name,
        displayName: (file.downloadFilename || file.downloadName || "Audio").replace(/\.[^.]+$/, ""),
        description: "Uploaded with Ahoy's Audio Converter"
      })
    });
    return { ok: true, assetId: data.assetId, username: data.robloxUsername };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function attachRobloxUploadControl(parent, file) {
  const wrap = document.createElement("div");
  wrap.className = "ahoy-roblox-upload-wrap";
  wrap.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:7px";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ahoy-roblox-upload-button";
  button.textContent = "UPLOAD TO ROBLOX";
  button.style.cssText = "border:1px solid rgba(218,183,112,.4);border-radius:8px;padding:8px 11px;background:#171717;color:#f0d69b;font-size:11px;font-weight:800;cursor:pointer";
  const status = document.createElement("span");
  status.className = "ahoy-roblox-upload-status";
  status.style.cssText = "font-size:11px;color:#e5c47e;overflow-wrap:anywhere";
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Uploading to Roblox...";
    const result = await uploadAudioToRoblox(file);
    if (result.ok) {
      status.textContent = `Uploaded · Audio ID: ${result.assetId}`;
      status.title = `Creator: ${result.username || "Roblox account"}`;
      window.dispatchEvent(new Event("ahoy:roblox-uploaded"));
    } else {
      status.textContent = result.error;
    }
    button.disabled = false;
  });
  wrap.append(button, status);
  parent.append(wrap);
}

function initAhoyRobloxUpload() {
  if ($("ahoyRobloxUploadPanel")) return;
  const anchor = $("ahoyAutoSplit") || $("jobs") || $("downloadZip");
  if (!anchor?.parentElement) return;
  const style = document.createElement("style");
  style.id = "ahoyRobloxUploadStyles";
  style.textContent = `
    #ahoyRobloxUploadPanel{margin:18px 0;padding:18px;border:1px solid rgba(214,174,91,.28);border-radius:16px;background:linear-gradient(145deg,rgba(24,24,27,.96),rgba(10,10,12,.96));color:#f4f0e8}
    #ahoyRobloxUploadPanel h3{margin:0 0 6px;color:#e5c47e;font-size:17px;letter-spacing:.04em}
    #ahoyRobloxUploadPanel p{margin:0;color:#aaa;font-size:12px;line-height:1.6}
    #ahoyRobloxUploadPanel .aru-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:13px}
    #ahoyRobloxUploadPanel button{border:1px solid rgba(218,183,112,.4);border-radius:9px;padding:10px 13px;background:#171717;color:#f0d69b;font-weight:700;cursor:pointer}
    #ahoyRobloxUploadPanel button:disabled{opacity:.5;cursor:wait}
    #ahoyRobloxUploadStatus{margin-top:10px;color:#e5c47e;font-size:12px;overflow-wrap:anywhere}
    @media(max-width:560px){#ahoyRobloxUploadPanel{padding:14px}#ahoyRobloxUploadPanel .aru-row>*{width:100%;box-sizing:border-box}}
  `;
  document.head.appendChild(style);
  anchor.insertAdjacentHTML("afterend", `
    <section id="ahoyRobloxUploadPanel">
      <h3>ROBLOX CREATOR HUB</h3>
      <p>Hubungkan akun Roblox milikmu. Setelah terhubung, file hasil Convert dan Auto Split bisa langsung di-upload ke akun tersebut.</p>
      <div class="aru-row">
        <button type="button" id="ahoyRobloxConnect">CONNECT ROBLOX ACCOUNT</button>
        <button type="button" id="ahoyRobloxDisconnect" hidden>DISCONNECT</button>
      </div>
      <div id="ahoyRobloxUploadStatus" aria-live="polite">Login ke Ahoy terlebih dahulu untuk menghubungkan Roblox.</div>
    </section>
  `);

  const connect = $("ahoyRobloxConnect");
  const disconnect = $("ahoyRobloxDisconnect");
  const status = $("ahoyRobloxUploadStatus");
  async function refresh() {
    if (!localStorage.getItem("ahoyToken")) {
      status.textContent = "Login ke Ahoy terlebih dahulu untuk menghubungkan Roblox.";
      connect.disabled = true;
      disconnect.hidden = true;
      return;
    }
    connect.disabled = true;
    try {
      const data = await robloxRequest("/api/roblox/status");
      if (data.connected) {
        status.textContent = `Terhubung sebagai @${data.robloxUsername} · Roblox User ID ${data.robloxUserId}`;
        connect.textContent = "ROBLOX CONNECTED";
        disconnect.hidden = false;
      } else {
        status.textContent = "Belum ada akun Roblox yang terhubung.";
        connect.textContent = "CONNECT ROBLOX ACCOUNT";
        disconnect.hidden = true;
      }
    } catch (error) {
      status.textContent = error.message;
      connect.textContent = "CONNECT ROBLOX ACCOUNT";
      disconnect.hidden = true;
    } finally {
      connect.disabled = false;
    }
  }
  connect.onclick = async () => {
    if (!localStorage.getItem("ahoyToken")) {
      status.textContent = "Login ke Ahoy terlebih dahulu.";
      return;
    }
    connect.disabled = true;
    status.textContent = "Mengarahkan ke halaman izin resmi Roblox...";
    try {
      const data = await robloxRequest("/api/roblox/oauth/start", { method: "POST", body: "{}" });
      window.location.assign(data.authorizeUrl);
    } catch (error) {
      status.textContent = error.message;
      connect.disabled = false;
    }
  };
  disconnect.onclick = async () => {
    if (!confirm("Putuskan koneksi akun Roblox dari Ahoy?")) return;
    disconnect.disabled = true;
    try {
      await robloxRequest("/api/roblox/disconnect", { method: "POST", body: "{}" });
      status.textContent = "Akun Roblox berhasil diputuskan.";
      connect.textContent = "CONNECT ROBLOX ACCOUNT";
      disconnect.hidden = true;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      disconnect.disabled = false;
    }
  };
  refresh();
  const params = new URLSearchParams(window.location.search);
  if (params.get("roblox") === "connected") {
    status.textContent = "Akun Roblox berhasil dihubungkan.";
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    refresh();
  } else if (params.get("roblox") === "error") {
    status.textContent = params.get("message") || "Koneksi Roblox gagal.";
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }
  window.ahoyRefreshRobloxStatus = refresh;
}

initAhoyAutoSplit();
initAhoyRobloxUpload();

// MEMBER USAGE
let usageCountdownTimer = null;
let currentUsage = null;

function stopUsageTimers() {
  if (usageCountdownTimer) clearInterval(usageCountdownTimer);
  usageCountdownTimer = null;
  currentUsage = null;
}
function updateMyUsageAfterConversion() {
  if (!currentUsage || currentUsage.unlimited) return;
  currentUsage.used = Math.min(currentUsage.limit, currentUsage.used + 1);
  currentUsage.remaining = Math.max(0, currentUsage.limit - currentUsage.used);

  const usedEl = $("ahoyUsageUsed");
  const remainingEl = $("ahoyUsageRemaining");
  const numberEl = $("ahoyUsageNumber");
  const fillEl = $("ahoyUsageFill");
  const subEl = $("ahoyUsageSubtext");
  if (usedEl) usedEl.textContent = `Used: ${currentUsage.used}`;
  if (remainingEl) remainingEl.textContent = `Remaining: ${currentUsage.remaining}`;
  if (numberEl) numberEl.textContent = currentUsage.remaining;
  if (fillEl) fillEl.style.width = `${Math.min(100, currentUsage.used / currentUsage.limit * 100)}%`;
  if (subEl) subEl.textContent = `${currentUsage.remaining} of ${currentUsage.limit} remaining`;
}
function formatCountdown(resetAt) {
  const secondsLeft = Math.max(0, Math.floor((new Date(resetAt).getTime() - Date.now()) / 1000));
  const h = String(Math.floor(secondsLeft / 3600)).padStart(2, "0");
  const m = String(Math.floor((secondsLeft % 3600) / 60)).padStart(2, "0");
  const s = String(secondsLeft % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
async function loadMyUsage() {
  const panel = $("memberUsage");
  const token = localStorage.getItem("ahoyToken");
  if (!panel || !token) return;
  panel.innerHTML = '<div class="ahoy-usage-loading">Loading usage...</div>';

  try {
    const response = await fetch(API + "/api/member/my-usage", {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load usage");

    if (data.unlimited) {
      currentUsage = { unlimited: true };
      if (usageCountdownTimer) clearInterval(usageCountdownTimer);
      usageCountdownTimer = null;
      panel.innerHTML = `
        <div class="ahoy-usage-head">
          <span>DAILY USAGE</span>
          <span class="ahoy-usage-badge unlimited">UNLIMITED</span>
          <button type="button" class="ahoy-usage-hide" id="ahoyUsageHide" aria-label="Hide account panel">−</button>
        </div>
        <p class="ahoy-usage-subtitle">Unlimited conversions enabled</p>
      `;
      $("ahoyUsageHide").onclick = hideAccountPanel;
      return;
    }

    const limit = Math.max(1, Number(data.daily_limit) || 10);
    const used = Math.max(0, Number(data.used) || 0);
    const remaining = Math.max(0, Number(data.remaining) || 0);
    currentUsage = { unlimited: false, limit, used, remaining };
    const percentage = Math.min(100, used / limit * 100);
    const resetAt = data.reset_at;

    panel.innerHTML = `
      <div class="ahoy-usage-head">
        <span>DAILY USAGE</span>
        <span class="ahoy-usage-badge free">FREE</span>
        <button type="button" class="ahoy-usage-hide" id="ahoyUsageHide" aria-label="Hide account panel">−</button>
      </div>
      <div class="ahoy-usage-line"><strong id="ahoyUsageNumber">${remaining}</strong><span id="ahoyUsageSubtext">${remaining} of ${limit} remaining</span></div>
      <div class="ahoy-usage-track"><div id="ahoyUsageFill" class="ahoy-usage-fill" style="width:${percentage}%"></div></div>
      <div class="ahoy-usage-stats"><span id="ahoyUsageUsed">Used: ${used}</span><span id="ahoyUsageRemaining">Remaining: ${remaining}</span></div>
      <div class="ahoy-usage-reset"><span>Resets in</span><strong id="ahoyUsageCountdown">${resetAt ? formatCountdown(resetAt) : "--:--:--"}</strong></div>
    `;
    $("ahoyUsageHide").onclick = hideAccountPanel;

    if (usageCountdownTimer) clearInterval(usageCountdownTimer);
    if (resetAt) {
      usageCountdownTimer = setInterval(() => {
        const el = $("ahoyUsageCountdown");
        if (!el) {
          clearInterval(usageCountdownTimer);
          usageCountdownTimer = null;
          return;
        }
        el.textContent = formatCountdown(resetAt);
        if (Date.now() >= new Date(resetAt).getTime()) {
          clearInterval(usageCountdownTimer);
          usageCountdownTimer = null;
          loadMyUsage();
        }
      }, 1000);
    }
  } catch (error) {
    panel.innerHTML = `
      <div class="ahoy-usage-head"><span>DAILY USAGE</span></div>
      <p class="ahoy-usage-error">${escapeHtml(error.message)}</p>
      <button type="button" id="ahoyRetryUsage" class="outline">Retry</button>
    `;
    $("ahoyRetryUsage")?.addEventListener("click", loadMyUsage);
  }
}

// ACCOUNT PANEL: auto-hide on scroll, with a small restore tab.
let accountManuallyHidden = false;
let accountScrollHidden = false;

function ensureAccountRestoreButton() {
  let button = $("ahoyShowAccount");
  if (button) return button;
  button = document.createElement("button");
  button.id = "ahoyShowAccount";
  button.type = "button";
  button.textContent = "ACCOUNT";
  button.setAttribute("aria-label", "Show account panel");
  document.body.appendChild(button);
  button.addEventListener("click", () => {
    accountManuallyHidden = false;
    accountScrollHidden = false;
    $("accountStatus")?.classList.remove("ahoy-account-hidden");
    button.classList.remove("visible");
  });
  return button;
}
function hideAccountPanel() {
  accountManuallyHidden = true;
  $("accountStatus")?.classList.add("ahoy-account-hidden");
  ensureAccountRestoreButton().classList.add("visible");
}
function updateAccountScrollState() {
  const panel = $("accountStatus");
  if (!panel || accountManuallyHidden) return;
  accountScrollHidden = window.scrollY > 90;
  panel.classList.toggle("ahoy-account-hidden", accountScrollHidden);
  ensureAccountRestoreButton().classList.toggle("visible", accountScrollHidden);
}
window.addEventListener("scroll", updateAccountScrollState, { passive: true });

// ACCOUNT PROFILE
function syncPageAccess() {
  const authenticated = Boolean(localStorage.getItem("ahoyToken") && localStorage.getItem("ahoyUsername"));
  document.body.classList.toggle("is-authenticated", authenticated);
  const authPanel = $("authModal");
  if (authPanel) authPanel.classList.toggle("open", !authenticated);
}
function renderAccount() {
  syncPageAccess();
  const username = localStorage.getItem("ahoyUsername");
  const membership = localStorage.getItem("ahoyMembership");
  const accountBtn = $("accountBtn");
  let panel = $("accountStatus");

  if (!username || !localStorage.getItem("ahoyToken")) {
    stopUsageTimers();
    if (panel) panel.remove();
    $("ahoyShowAccount")?.remove();
    accountManuallyHidden = false;
    accountScrollHidden = false;
    accountBtn.style.display = "";
    return;
  }

  accountBtn.style.display = "none";
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "accountStatus";
    accountBtn.insertAdjacentElement("afterend", panel);
  }

  panel.innerHTML = `
    <div class="ahoy-account">
      <div class="ahoy-account-info">
        <span class="ahoy-online-dot"></span>
        <div class="ahoy-account-details">
          <strong>${escapeHtml(username)}</strong>
          <small>ONLINE · ${escapeHtml((membership || "free").toUpperCase())}</small>
        </div>
      </div>
      <button type="button" id="ahoyLogout">Logout</button>
    </div>
    <section id="memberUsage" class="ahoy-usage">
      <div class="ahoy-usage-loading">Loading usage...</div>
    </section>
  `;

  $("ahoyLogout").onclick = () => {
    if (!confirm("Are you sure you want to logout?")) return;
    localStorage.removeItem("ahoyToken");
    localStorage.removeItem("ahoyUsername");
    localStorage.removeItem("ahoyMembership");
    stopMembershipUpdates();
    $('ahoyAdminPanel')?.remove();
    renderAccount();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  loadMyUsage();
  startMembershipUpdates();
  loadAdminPanel();
  updateAccountScrollState();
}

// ===============================
// REALTIME MEMBERSHIP UPDATES
// ===============================
let membershipStreamController = null;
let membershipFallbackTimer = null;

function applyMembershipChange(membership) {
  if (!['free', 'unlimited'].includes(membership)) return;
  const previous = localStorage.getItem('ahoyMembership') || 'free';
  localStorage.setItem('ahoyMembership', membership);
  const status = document.querySelector('.ahoy-account-details small');
  if (status) status.textContent = `ONLINE · ${membership.toUpperCase()}`;
  if (previous !== membership) loadMyUsage();
}

function stopMembershipUpdates() {
  if (membershipStreamController) membershipStreamController.abort();
  membershipStreamController = null;
  if (membershipFallbackTimer) clearInterval(membershipFallbackTimer);
  membershipFallbackTimer = null;
}

async function startMembershipUpdates() {
  stopMembershipUpdates();
  const token = localStorage.getItem('ahoyToken');
  if (!token) return;

  // SSE provides immediate updates. A light polling fallback covers proxies
  // or hosts that interrupt long-lived streaming connections.
  membershipFallbackTimer = setInterval(async () => {
    const currentToken = localStorage.getItem('ahoyToken');
    if (!currentToken) return stopMembershipUpdates();
    try {
      const response = await fetch(API + '/api/member/my-usage', {
        headers: { Authorization: 'Bearer ' + currentToken },
        cache: 'no-store'
      });
      if (response.ok) {
        const data = await response.json();
        applyMembershipChange(data.membership);
      }
    } catch (_) {}
  }, 15000);

  membershipStreamController = new AbortController();
  const signal = membershipStreamController.signal;
  (async () => {
    while (!signal.aborted && localStorage.getItem('ahoyToken')) {
      try {
        const response = await fetch(API + '/api/member/events', {
          headers: { Authorization: 'Bearer ' + localStorage.getItem('ahoyToken') },
          cache: 'no-store',
          signal
        });
        if (!response.ok || !response.body) throw new Error('Realtime stream unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || '';
          for (const eventText of events) {
            const dataLine = eventText.split(/\r?\n/).find(line => line.startsWith('data:'));
            if (!dataLine) continue;
            try { applyMembershipChange(JSON.parse(dataLine.slice(5).trim()).membership); }
            catch (_) {}
          }
        }
      } catch (error) {
        if (signal.aborted) break;
      }
      if (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 2500));
    }
  })();
}

// ===============================
// ADMIN PANEL
// ===============================
function ensureAdminStyles() {
  if ($('ahoyAdminStyles')) return;
  const style = document.createElement('style');
  style.id = 'ahoyAdminStyles';
  style.textContent = `
    #ahoyAdminPanel{width:min(920px,calc(100% - 32px));margin:24px auto;padding:22px;border:1px solid rgba(214,174,91,.28);border-radius:18px;background:linear-gradient(145deg,rgba(24,24,27,.97),rgba(10,10,12,.97));color:#f4f0e8;box-shadow:0 18px 55px rgba(0,0,0,.28)}
    #ahoyAdminPanel .ahoy-admin-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
    #ahoyAdminPanel h2{margin:0;font-size:18px;letter-spacing:.12em;color:#e5c47e}
    #ahoyAdminPanel .ahoy-admin-meta{font-size:12px;color:#aaa}
    #ahoyAdminPanel input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #45413a;border-radius:10px;background:#111;color:#fff;margin-bottom:14px;outline:none}
    #ahoyAdminPanel .ahoy-admin-list{display:grid;gap:9px}
    #ahoyAdminPanel .ahoy-admin-user{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:rgba(255,255,255,.025)}
    #ahoyAdminPanel .ahoy-admin-user strong{display:block;font-size:14px;overflow-wrap:anywhere}
    #ahoyAdminPanel .ahoy-admin-user small{display:block;margin-top:4px;color:#aaa;font-size:11px}
    #ahoyAdminPanel .ahoy-admin-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
    #ahoyAdminPanel button{border:1px solid rgba(218,183,112,.55);border-radius:9px;padding:9px 12px;background:rgba(190,150,75,.12);color:#f0d69b;font-weight:700;cursor:pointer}
    #ahoyAdminPanel button:disabled{opacity:.45;cursor:wait}
    #ahoyAdminPanel .ahoy-admin-user.is-unlimited{border-color:rgba(218,183,112,.3)}
    #ahoyAdminPanel .ahoy-admin-error{color:#ff9b9b;font-size:13px}
    @media(max-width:560px){#ahoyAdminPanel{padding:16px}#ahoyAdminPanel .ahoy-admin-user{align-items:flex-start;flex-direction:column}#ahoyAdminPanel .ahoy-admin-actions{width:100%}#ahoyAdminPanel .ahoy-admin-actions button{flex:1}}
  `;
  document.head.appendChild(style);
}

let adminUsersCache = [];
async function loadAdminPanel() {
  const account = $('accountStatus');
  if (!account) return;
  const token = localStorage.getItem('ahoyToken');
  if (!token) return;
  try {
    const response = await fetch(API + '/api/admin/users', {
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store'
    });
    if (response.status === 401 || response.status === 403) {
      $('ahoyAdminPanel')?.remove();
      return;
    }
    if (!response.ok) throw new Error('Unable to load admin users');
    adminUsersCache = await response.json();
    ensureAdminStyles();
    let panel = $('ahoyAdminPanel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'ahoyAdminPanel';
      account.insertAdjacentElement('afterend', panel);
    }
    renderAdminUsers();
  } catch (error) {
    let panel = $('ahoyAdminPanel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'ahoyAdminPanel';
      account.insertAdjacentElement('afterend', panel);
    }
    panel.innerHTML = `<p class="ahoy-admin-error">${escapeHtml(error.message)}</p><button type="button" id="ahoyAdminRetry">Retry</button>`;
    $('ahoyAdminRetry')?.addEventListener('click', loadAdminPanel);
  }
}

function renderAdminUsers(filter = '') {
  const panel = $('ahoyAdminPanel');
  if (!panel) return;
  const query = filter.trim().toLowerCase();
  const users = adminUsersCache.filter(user =>
    String(user.username || '').toLowerCase().includes(query)
  );
  panel.innerHTML = `
    <div class="ahoy-admin-head"><div><h2>ADMIN CONTROL</h2><div class="ahoy-admin-meta">Manage member access · ${adminUsersCache.length} accounts</div></div><button type="button" id="ahoyAdminRefresh">Refresh</button></div>
    <input id="ahoyAdminSearch" type="search" placeholder="Search username..." autocomplete="off">
    <div class="ahoy-admin-list" id="ahoyAdminList"></div>
  `;
  $('ahoyAdminSearch').value = filter;
  const list = $('ahoyAdminList');
  if (!users.length) {
    list.innerHTML = '<div class="ahoy-admin-meta">No users found.</div>';
  } else {
    list.innerHTML = users.map(user => {
      const unlimited = user.membership === 'unlimited';
      const role = user.is_admin ? 'ADMIN ACCOUNT' : (unlimited ? 'UNLIMITED' : 'FREE');
      const action = unlimited ? 'Revoke Unlimited' : 'Grant Unlimited';
      const disabled = user.is_admin ? 'disabled title="Admin accounts are protected"' : '';
      return `<div class="ahoy-admin-user ${unlimited ? 'is-unlimited' : ''}" data-username="${escapeHtml(user.username).toLowerCase()}">
        <div><strong>${escapeHtml(user.username)}</strong><small>${role} · Joined ${user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}</small></div>
        <div class="ahoy-admin-actions"><button type="button" data-membership-id="${escapeHtml(user.id)}" data-membership-next="${unlimited ? 'free' : 'unlimited'}" ${disabled}>${action}</button></div>
      </div>`;
    }).join('');
  }
  $('ahoyAdminSearch').addEventListener('input', e => {
    const value = e.target.value.trim().toLowerCase();
    list.querySelectorAll('.ahoy-admin-user').forEach(row => {
      row.style.display = row.dataset.username.includes(value) ? '' : 'none';
    });
  });
  $('ahoyAdminRefresh').addEventListener('click', loadAdminPanel);
  list.querySelectorAll('[data-membership-id]').forEach(button => {
    button.addEventListener('click', () => updateAdminMembership(button));
  });
}

async function updateAdminMembership(button) {
  const id = button.dataset.membershipId;
  const membership = button.dataset.membershipNext;
  const user = adminUsersCache.find(item => String(item.id) === String(id));
  if (!user || !confirm(`${membership === 'unlimited' ? 'Grant' : 'Revoke'} Unlimited for ${user.username}?`)) return;
  const token = localStorage.getItem('ahoyToken');
  button.disabled = true;
  button.textContent = 'Saving...';
  try {
    const response = await fetch(API + '/api/admin/users/' + encodeURIComponent(id) + '/membership', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ membership })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Membership update failed');
    await loadAdminPanel();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = membership === 'unlimited' ? 'Grant Unlimited' : 'Revoke Unlimited';
  }
}

// LOGIN / REGISTER MODAL
$("accountBtn").onclick = () => $("authModal").classList.add("open");
$("closeModal").onclick = () => $("authModal").classList.remove("open");
$("loginTab").onclick = () => {
  authMode = "login";
  $("authMessage").textContent = "";
};
$("registerTab").onclick = () => {
  authMode = "register";
  $("authMessage").textContent = "";
};

// LOGIN & REGISTER REQUEST
$("authForm").onsubmit = async e => {
  e.preventDefault();
  const submitButton = $("authForm").querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  $("authMessage").textContent = "Please wait...";
  try {
    const username = $("username").value.trim();
    const password = $("password").value;
    const r = await fetch(API + "/api/auth/" + authMode, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Authentication failed");
    localStorage.setItem("ahoyToken", d.token);
    localStorage.setItem("ahoyUsername", username);
    localStorage.setItem("ahoyMembership", d.membership || "free");
    $("password").value = "";
    $("authMessage").textContent = "Successfully signed in!";
    $("authModal").classList.remove("open");
    accountManuallyHidden = false;
    renderAccount();
    document.getElementById("converter")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.ahoyRefreshRobloxStatus?.();
  } catch (err) {
    $("authMessage").textContent = err.message;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
};

// INTRO
$("skipIntro").onclick = () => $("intro").remove();
if (sessionStorage.getItem("ahoyIntroSeen")) {
  $("intro").remove();
} else {
  sessionStorage.setItem("ahoyIntroSeen", "1");
  setTimeout(() => $("intro")?.remove(), 3100);
}

// CUSTOM SILVER-BLUE / DARK-GOLD CURSOR (desktop only)
function initAhoyCursor() {
  if (window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const glow = document.createElement("div");
  const dot = document.createElement("div");
  glow.className = "ahoy-cursor-glow";
  dot.className = "ahoy-cursor-dot";
  document.body.append(glow, dot);

  let x = -100, y = -100, gx = -100, gy = -100;
  let frame = 0;
  document.addEventListener("mousemove", e => {
    x = e.clientX;
    y = e.clientY;
    dot.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%)`;
    if (!frame) {
      frame = requestAnimationFrame(function moveGlow() {
        gx += (x - gx) * 0.22;
        gy += (y - gy) * 0.22;
        glow.style.transform = `translate3d(${gx}px,${gy}px,0) translate(-50%,-50%)`;
        if (Math.abs(x - gx) > .5 || Math.abs(y - gy) > .5) {
          frame = requestAnimationFrame(moveGlow);
        } else frame = 0;
      });
    }
  }, { passive: true });

  document.addEventListener("mouseover", e => {
    if (e.target.closest("button,a,input,select,textarea,[role='button']")) {
      dot.classList.add("is-hover");
      glow.classList.add("is-hover");
    } else {
      dot.classList.remove("is-hover");
      glow.classList.remove("is-hover");
    }
  });
  document.addEventListener("mouseleave", () => {
    dot.classList.add("cursor-away");
    glow.classList.add("cursor-away");
  });
  document.addEventListener("mouseenter", () => {
    dot.classList.remove("cursor-away");
    glow.classList.remove("cursor-away");
  });
}


// Public navigation is visible on the landing page; protected sections require login.
document.querySelectorAll('header nav a[href="#converter"],header nav a[href="#membership"]').forEach(link => {
  link.addEventListener("click", event => {
    if (!localStorage.getItem("ahoyToken")) {
      event.preventDefault();
      $("username")?.focus();
      $("authMessage").textContent = "Login atau register untuk melanjutkan.";
    }
  });
});

// INITIALIZE
renderAccount();
initAhoyCursor();


// ===============================
// AHOY WORKSPACES: SPLIT + ROBLOX UPLOAD HISTORY
// Existing converter/split/upload logic is preserved; this only adds navigation and history UI.
// ===============================
function initAhoyWorkspaces() {
  if (document.getElementById("ahoyHistoryWorkspace")) return;

  const nav = document.querySelector("header nav");
  const membership = $("membership");
  const converter = $("converter");
  const splitPanel = $("ahoyAutoSplit");
  if (!nav || !membership || !converter) return;

  // Add dedicated navigation entries.
  const addNav = (id, label, href) => {
    if (!document.getElementById(id)) {
      const a = document.createElement("a");
      a.id = id; a.href = href; a.textContent = label;
      nav.insertBefore(a, nav.querySelector("#langBtn") || nav.lastElementChild);
    }
  };
  addNav("ahoySplitNav", "Split", "#ahoySplitWorkspace");
  addNav("ahoyDirectUploadNav", "Upload To Roblox", "#ahoyDirectUploadWorkspace");
  addNav("ahoyHistoryNav", "Roblox History", "#ahoyHistoryWorkspace");
  addNav("ahoyDownloaderNav", "Audio Downloader", "#ahoyDownloaderWorkspace");

  // Move the existing Auto Split panel intact into its own workspace.
  const splitWorkspace = document.createElement("section");
  splitWorkspace.id = "ahoySplitWorkspace";
  splitWorkspace.className = "panel ahoy-workspace";
  splitWorkspace.innerHTML = '<div class="section-head"><div><div class="eyebrow">02 / AUDIO WORKSPACE</div><h2>Audio Split</h2></div><span class="pill">AUTO SPLIT</span></div>';
  if (splitPanel) splitWorkspace.appendChild(splitPanel);
  converter.insertAdjacentElement("afterend", splitWorkspace);

  // Dedicated direct-device upload workspace (not tied to Convert / Auto Split outputs).
  const directUploadWorkspace = document.createElement("section");
  directUploadWorkspace.id = "ahoyDirectUploadWorkspace";
  directUploadWorkspace.className = "panel ahoy-workspace";
  directUploadWorkspace.innerHTML = `
    <div class="section-head">
      <div><div class="eyebrow">03 / ROBLOX CREATOR HUB</div><h2>Upload To Roblox</h2></div>
      <span class="pill">DIRECT UPLOAD</span>
    </div>
    <p class="ahoy-history-subtitle">Pilih MP3, WAV, OGG, atau FLAC langsung dari perangkat. Bisa upload beberapa file sekaligus; setiap file diproses satu per satu ke akun Roblox yang terhubung.</p>
    <div class="aru-direct-drop" id="aruDirectDrop">
      <input id="aruDirectFiles" type="file" accept=".mp3,.wav,.ogg,.flac,audio/mpeg,audio/wav,audio/ogg,audio/flac" multiple hidden>
      <div class="aru-direct-icon">↑</div>
      <strong>Drop audio files here</strong>
      <span>atau pilih file dari perangkat · MP3 / WAV / OGG / FLAC · Maks. 20 MB dan 7 menit per file</span>
      <button type="button" class="outline" id="aruDirectBrowse">CHOOSE AUDIO FILES</button>
    </div>
    <div class="aru-direct-toolbar">
      <span id="aruDirectCount">Belum ada file dipilih</span>
      <div><button type="button" class="outline" id="aruDirectClear">CLEAR LIST</button><button type="button" class="gold-btn" id="aruDirectStart">UPLOAD ALL TO ROBLOX</button></div>
    </div>
    <div class="aru-direct-queue" id="aruDirectQueue"><div class="aru-direct-empty">File yang dipilih akan muncul di sini.</div></div>
    <div class="aru-direct-foot" id="aruDirectFoot" aria-live="polite">Upload memakai akun Roblox yang sudah kamu hubungkan. Kuota convert tidak digunakan oleh fitur upload langsung.</div>
  `;
  splitWorkspace.insertAdjacentElement("afterend", directUploadWorkspace);

  // Dedicated upload history table.
  const historyWorkspace = document.createElement("section");
  historyWorkspace.id = "ahoyHistoryWorkspace";
  historyWorkspace.className = "panel ahoy-workspace";
  historyWorkspace.innerHTML = `
    <div class="section-head">
      <div><div class="eyebrow">03 / ROBLOX CREATOR HUB</div><h2>Roblox Upload History</h2></div>
      <button type="button" id="ahoyHistoryRefresh" class="outline">REFRESH</button>
    </div>
    <p class="ahoy-history-subtitle">Riwayat upload audio ke Roblox dan status moderasi terbaru dari Creator Hub.</p>
    <div class="ahoy-history-summary" id="ahoyHistorySummary">
      <div><strong id="ahoyHistoryTotal">—</strong><span>Total Upload</span></div>
      <div><strong id="ahoyHistoryPending">—</strong><span>Pending</span></div>
      <div><strong id="ahoyHistoryApproved">—</strong><span>Approved</span></div>
      <div><strong id="ahoyHistoryRejected">—</strong><span>Rejected</span></div>
    </div>
    <div class="ahoy-history-table-wrap">
      <table class="ahoy-history-table">
        <thead><tr><th>Audio</th><th>Upload Date</th><th>Asset ID</th><th>Status</th><th>Creator</th></tr></thead>
        <tbody id="ahoyHistoryRows"><tr><td colspan="5" class="ahoy-history-empty">Login untuk melihat riwayat upload Roblox.</td></tr></tbody>
      </table>
    </div>
    <div class="ahoy-history-foot" id="ahoyHistoryFoot" aria-live="polite">Status pending diperbarui otomatis saat halaman riwayat dibuka.</div>
  `;
  directUploadWorkspace.insertAdjacentElement("afterend", historyWorkspace);

  const downloaderWorkspace = document.createElement("section");
  downloaderWorkspace.id = "ahoyDownloaderWorkspace";
  downloaderWorkspace.className = "panel ahoy-workspace";
  downloaderWorkspace.innerHTML = `
    <div class="section-head"><div><div class="eyebrow">04 / MEDIA TOOLS</div><h2>Universal Audio Downloader</h2></div><span class="pill">MULTI-PLATFORM</span></div>
    <p class="ahoy-history-subtitle">Tempel URL dari platform media yang didukung. AHOY akan mendeteksi sumber, mengambil audio yang dapat diakses publik, lalu menyiapkan file pilihanmu.</p>
    <form id="ahoyDownloaderForm" class="ahoy-downloader-form">
      <label for="ahoyDownloaderUrl">MEDIA URL</label>
      <input id="ahoyDownloaderUrl" type="url" required maxlength="2048" autocomplete="url" placeholder="Paste YouTube, SoundCloud, TikTok, Vimeo, atau direct media URL">
      <div class="ahoy-downloader-options">
        <div><label for="ahoyDownloaderFormat">OUTPUT FORMAT</label><select id="ahoyDownloaderFormat"><option value="mp3">MP3</option><option value="wav">WAV</option><option value="m4a">M4A</option><option value="opus">OPUS</option><option value="original">Original Audio</option></select></div>
        <button class="gold-btn" id="ahoyDownloaderStart" type="submit">ANALYZE & DOWNLOAD</button>
      </div>
    </form>
    <div class="ahoy-downloader-usage" id="ahoyDownloaderUsage">Login untuk melihat kuota downloader.</div>
    <div class="ahoy-downloader-progress-wrap" id="ahoyDownloaderProgressWrap" hidden><div class="ahoy-downloader-progress-head"><span id="ahoyDownloaderProgressLabel">Preparing download...</span><strong id="ahoyDownloaderProgressValue">0%</strong></div><progress id="ahoyDownloaderProgress" max="100" value="0"></progress></div>
    <div class="ahoy-downloader-status" id="ahoyDownloaderStatus" aria-live="polite">Mendukung platform yang kompatibel dengan extractor yt-dlp serta direct media URL. Konten privat, DRM, paywall, dan login wall tidak didukung.</div>
    <div class="ahoy-downloader-meta" id="ahoyDownloaderMeta" hidden></div>
    <a id="ahoyDownloaderResult" class="ahoy-downloader-result" hidden>Download file</a>
  `;
  historyWorkspace.insertAdjacentElement("afterend", downloaderWorkspace);
  const downloaderStyle = document.createElement("style");
  downloaderStyle.textContent = `
    #ahoyDownloaderWorkspace .ahoy-downloader-form{display:grid;gap:10px;max-width:900px;margin-top:22px}
    #ahoyDownloaderWorkspace label{display:block;color:#cbd6e5;font-size:11px;letter-spacing:.08em;margin-bottom:7px}
    #ahoyDownloaderWorkspace input,#ahoyDownloaderWorkspace select{width:100%;box-sizing:border-box;min-height:48px;padding:12px 15px;border-radius:14px;border:1px solid var(--line,#ffffff24);background:#090d14;color:#f2f5fa}
    #ahoyDownloaderWorkspace .ahoy-downloader-options{display:grid;grid-template-columns:minmax(180px,240px) auto;gap:12px;align-items:end}
    #ahoyDownloaderWorkspace button{justify-self:start;padding:13px 20px;min-height:46px}
    .ahoy-downloader-usage{margin-top:15px;padding:12px 14px;border:1px solid #aebed322;border-radius:12px;color:#b8c5d3;background:#11141c;font-size:11px}
    .ahoy-downloader-progress-wrap{margin-top:15px;padding:13px 14px;border:1px solid #aebed322;border-radius:12px;background:#10131a}
    .ahoy-downloader-progress-head{display:flex;justify-content:space-between;gap:10px;color:#cbd6e5;font-size:11px;margin-bottom:9px}
    .ahoy-downloader-progress-wrap progress{width:100%;height:6px;accent-color:#b9cde0}
    .ahoy-downloader-status{margin-top:14px;color:#aab5c5;font-size:12px;line-height:1.7}
    .ahoy-downloader-meta{margin-top:12px;color:#d5dfeb;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
    .ahoy-downloader-result{display:inline-block;margin-top:12px;color:#dce9f7;text-decoration:none;border:1px solid #aebed344;padding:11px 16px;border-radius:12px}
    .ahoy-downloader-result:hover{background:#aebed311}
    @media(max-width:600px){#ahoyDownloaderWorkspace .ahoy-downloader-options{grid-template-columns:1fr}#ahoyDownloaderWorkspace .ahoy-downloader-options button{width:100%}}
  `;
  document.head.appendChild(downloaderStyle);
  $("ahoyDownloaderForm").addEventListener("submit", downloadDirectMedia);
  loadAhoyDownloaderUsage();

  const styles = document.createElement("style");
  styles.id = "ahoyWorkspaceStyles";
  styles.textContent = `
    .ahoy-workspace{display:none;max-width:1500px;margin:28px auto}
    body.ahoy-view-split #converter,body.ahoy-view-split #ahoyDirectUploadWorkspace,body.ahoy-view-split #ahoyHistoryWorkspace,body.ahoy-view-split #ahoyDownloaderWorkspace,body.ahoy-view-split #membership{display:none!important}
    body.ahoy-view-split #ahoySplitWorkspace{display:block!important}
    body.ahoy-view-directupload #converter,body.ahoy-view-directupload #ahoySplitWorkspace,body.ahoy-view-directupload #ahoyHistoryWorkspace,body.ahoy-view-directupload #ahoyDownloaderWorkspace,body.ahoy-view-directupload #membership{display:none!important}
    body.ahoy-view-directupload #ahoyDirectUploadWorkspace{display:block!important}
    body.ahoy-view-history #converter,body.ahoy-view-history #ahoySplitWorkspace,body.ahoy-view-history #ahoyDirectUploadWorkspace,body.ahoy-view-history #ahoyDownloaderWorkspace,body.ahoy-view-history #membership{display:none!important}
    body.ahoy-view-history #ahoyHistoryWorkspace{display:block!important}
    body.ahoy-view-downloader #converter,body.ahoy-view-downloader #ahoySplitWorkspace,body.ahoy-view-downloader #ahoyDirectUploadWorkspace,body.ahoy-view-downloader #ahoyHistoryWorkspace,body.ahoy-view-downloader #membership{display:none!important}
    body.ahoy-view-downloader #ahoyDownloaderWorkspace{display:block!important}
    body.ahoy-view-converter #ahoySplitWorkspace,body.ahoy-view-converter #ahoyDirectUploadWorkspace,body.ahoy-view-converter #ahoyHistoryWorkspace,body.ahoy-view-converter #ahoyDownloaderWorkspace{display:none!important}
    .ahoy-history-subtitle{color:#aaa;font-size:13px;margin:0 0 18px}
    .ahoy-history-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:18px 0}
    .ahoy-history-summary>div{padding:15px;border:1px solid rgba(180,160,220,.16);border-radius:12px;background:linear-gradient(145deg,#171522,#0d0c13);display:grid;gap:5px}
    .ahoy-history-summary strong{font-size:22px;color:#eee}
    .ahoy-history-summary span{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#999}
    .ahoy-history-table-wrap{width:100%;overflow-x:auto;border:1px solid rgba(180,160,220,.16);border-radius:12px}
    .ahoy-history-table{width:100%;border-collapse:collapse;min-width:680px;background:#0e0d13}
    .ahoy-history-table th,.ahoy-history-table td{padding:13px 14px;text-align:left;border-bottom:1px solid rgba(255,255,255,.07);font-size:12px}
    .ahoy-history-table th{color:#bdb2d8;font-size:10px;letter-spacing:.09em;text-transform:uppercase;background:#151320}
    .ahoy-history-table td{color:#ddd}
    .ahoy-history-table tr:last-child td{border-bottom:0}
    .ahoy-history-empty{text-align:center!important;color:#999!important;padding:28px!important}
    .ahoy-history-status{display:inline-flex;padding:5px 9px;border-radius:20px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
    .ahoy-history-status.pending{color:#f2cf79;background:#8d681c24;border:1px solid #a9843c55}
    .ahoy-history-status.approved{color:#8ce0ad;background:#1d8a4b20;border:1px solid #4ab87955}
    .ahoy-history-status.rejected{color:#ff9b9b;background:#a52c2c20;border:1px solid #d45c5c55}
    .ahoy-history-table a{color:#c8b4f0;text-decoration:none}
    .ahoy-history-table a:hover{text-decoration:underline}
    .ahoy-history-foot{font-size:11px;color:#888;margin-top:12px}
    #ahoyDirectUploadWorkspace .aru-direct-drop{display:grid;justify-items:center;gap:10px;text-align:center;padding:30px 18px;border:1px dashed rgba(164,196,218,.38);border-radius:12px;background:radial-gradient(ellipse at 50% 0,rgba(84,104,143,.13),transparent 65%),#0c0b10;transition:.2s ease}
    #ahoyDirectUploadWorkspace .aru-direct-drop.drag{border-color:#c8dff0;background:#121522;box-shadow:0 0 24px rgba(126,169,199,.13)}
    .aru-direct-icon{font-size:28px;color:#c7ddec;text-shadow:0 0 18px #9fc5df66}
    .aru-direct-drop strong{font-size:14px;color:#e8e6ed}.aru-direct-drop span{font-size:11px;color:#999;line-height:1.6}
    .aru-direct-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0;color:#aaa;font-size:11px}
    .aru-direct-toolbar>div{display:flex;gap:8px;flex-wrap:wrap}.aru-direct-toolbar button{font-size:10px;padding:9px 12px}
    .aru-direct-queue{display:grid;gap:9px}.aru-direct-empty{padding:22px;text-align:center;border:1px solid rgba(180,160,220,.12);border-radius:9px;color:#777;font-size:12px}
    .aru-direct-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 14px;align-items:center;padding:13px;border:1px solid rgba(180,160,220,.14);border-radius:9px;background:linear-gradient(145deg,#15141c,#0c0b10)}
    .aru-direct-file{min-width:0}.aru-direct-file strong{display:block;color:#e5e2ec;font-size:12px;overflow-wrap:anywhere}.aru-direct-file small{display:block;margin-top:4px;color:#888;font-size:10px}
    .aru-direct-state{font-size:10px;color:#b9c9d9;text-align:right}.aru-direct-progress{grid-column:1/-1;width:100%;height:4px;border:0;border-radius:9px;overflow:hidden;background:#292631;accent-color:#9ebbd0}
    .aru-direct-progress::-webkit-progress-bar{background:#292631}.aru-direct-progress::-webkit-progress-value{background:linear-gradient(90deg,#758da8,#d3e5f1)}
    .aru-direct-result{grid-column:1/-1;color:#a9c6d9;font-size:10px;overflow-wrap:anywhere}.aru-direct-result a{color:#c7dff0;text-decoration:none}
    .aru-direct-foot{margin-top:13px;color:#888;font-size:10px;line-height:1.6}
    @media(max-width:800px){body.is-authenticated header nav a#ahoySplitNav,body.is-authenticated header nav a#ahoyDirectUploadNav,body.is-authenticated header nav a#ahoyHistoryNav,body.is-authenticated header nav a#ahoyDownloaderNav{display:inline-flex;font-size:10px}}
    @media(max-width:650px){.ahoy-history-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.ahoy-history-summary>div{padding:12px}.aru-direct-toolbar{align-items:stretch;flex-direction:column}.aru-direct-toolbar>div{display:grid;grid-template-columns:1fr 1fr}.aru-direct-item{grid-template-columns:1fr}.aru-direct-state{text-align:left}}

  `;
  document.head.appendChild(styles);

  const showView = view => {
    document.body.classList.remove("ahoy-view-converter","ahoy-view-split","ahoy-view-directupload","ahoy-view-history","ahoy-view-downloader");
    document.body.classList.add("ahoy-view-" + view);
    if (view === "history") loadAhoyRobloxHistory();
    if (view === "downloader") loadAhoyDownloaderUsage();
    if (view === "directupload") refreshDirectRobloxConnection();
  };
  $("ahoySplitNav").addEventListener("click", () => showView("split"));
  $("ahoyDirectUploadNav").addEventListener("click", () => showView("directupload"));
  $("ahoyHistoryNav").addEventListener("click", () => showView("history"));
  $("ahoyDownloaderNav").addEventListener("click", () => showView("downloader"));
  const converterNav = nav.querySelector('a[href="#converter"]');
  converterNav?.addEventListener("click", () => showView("converter"));
  $("ahoyHistoryRefresh").addEventListener("click", loadAhoyRobloxHistory);
  initAhoyDirectUpload();
  window.addEventListener("hashchange", () => {
    if (location.hash === "#ahoySplitWorkspace") showView("split");
    else if (location.hash === "#ahoyDirectUploadWorkspace") showView("directupload");
    else if (location.hash === "#ahoyHistoryWorkspace") showView("history");
    else if (location.hash === "#ahoyDownloaderWorkspace") showView("downloader");
    else if (location.hash === "#converter") showView("converter");
  });
  if (location.hash === "#ahoyHistoryWorkspace") showView("history");
  else if (location.hash === "#ahoyDownloaderWorkspace") showView("downloader");
  else if (location.hash === "#ahoyDirectUploadWorkspace") showView("directupload");
  else if (location.hash === "#ahoySplitWorkspace") showView("split");
  else showView("converter");

  // Keep the history current while the user is viewing its dedicated tab.
  if (!window.ahoyHistoryRefreshTimer) {
    window.ahoyHistoryRefreshTimer = setInterval(() => {
      if (document.body.classList.contains("ahoy-view-history")) loadAhoyRobloxHistory(true);
    }, 25000);
  }
}



async function downloadDirectMedia(event) {
  event.preventDefault();
  const button = $("ahoyDownloaderStart");
  const status = $("ahoyDownloaderStatus");
  const result = $("ahoyDownloaderResult");
  const progressWrap = $("ahoyDownloaderProgressWrap");
  const progress = $("ahoyDownloaderProgress");
  const progressLabel = $("ahoyDownloaderProgressLabel");
  const progressValue = $("ahoyDownloaderProgressValue");
  const meta = $("ahoyDownloaderMeta");
  const token = localStorage.getItem("ahoyToken");

  result.hidden = true;
  meta.hidden = true;
  progressWrap.hidden = false;
  progress.value = 0;
  progressValue.textContent = "0%";
  button.disabled = true;

  if (!token) {
    status.textContent = "Login terlebih dahulu untuk menggunakan AHOY Universal Downloader.";
    progressWrap.hidden = true;
    button.disabled = false;
    return;
  }

  const apiFetch = async (path, options = {}) => fetch(API + path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: "Bearer " + token }
  });

  let jobId = "";
  try {
    status.textContent = "Memvalidasi URL dan membuat antrean download...";
    const createResponse = await apiFetch("/api/downloader/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: $("ahoyDownloaderUrl").value.trim(),
        format: $("ahoyDownloaderFormat").value
      })
    });
    const created = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok) throw new Error(created.error || "Tidak dapat memulai download.");
    jobId = created.job_id;
    if (!jobId) throw new Error("Server tidak mengembalikan ID download.");

    let completed = false;
    for (let attempt = 0; attempt < 1800; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const pollResponse = await apiFetch("/api/downloader/jobs/" + encodeURIComponent(jobId));
      const data = await pollResponse.json().catch(() => ({}));
      if (!pollResponse.ok) throw new Error(data.error || "Gagal memeriksa status download.");

      const pct = Math.max(0, Math.min(100, Number(data.progress) || 0));
      progress.value = pct;
      progressValue.textContent = Math.round(pct) + "%";
      progressLabel.textContent = data.status === "processing" ? "Processing media..." :
        data.status === "downloading" ? "Downloading media..." :
        data.status === "completed" ? "Download ready" : "Preparing media...";
      status.textContent = data.status === "queued" ? "Masuk antrean server AHOY..." :
        data.status === "extracting" ? "Mendeteksi platform dan mengambil metadata..." :
        data.status === "downloading" ? "Mengunduh media dari sumber..." :
        data.status === "processing" ? "Mengonversi audio menggunakan FFmpeg..." :
        "Menyiapkan file hasil download...";

      if (data.title || data.extractor) {
        meta.hidden = false;
        meta.textContent = [data.title, data.extractor ? "Source: " + data.extractor : ""].filter(Boolean).join(" · ");
      }

      if (data.status === "failed") throw new Error(data.error || "Download gagal.");
      if (data.status === "completed") {
        completed = true;
        progress.value = 100;
        progressValue.textContent = "100%";
        break;
      }
    }
    if (!completed) throw new Error("Proses terlalu lama. Coba lagi nanti.");

    status.textContent = "Download selesai. Mengambil file hasil...";
    const fileResponse = await apiFetch("/api/downloader/jobs/" + encodeURIComponent(jobId) + "/file");
    if (!fileResponse.ok) {
      const errorData = await fileResponse.json().catch(() => ({}));
      throw new Error(errorData.error || "File hasil tidak dapat diambil.");
    }
    const blob = await fileResponse.blob();
    const disposition = fileResponse.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] || "ahoy-universal-download";
    const objectUrl = URL.createObjectURL(blob);
    result.href = objectUrl;
    result.download = filename;
    result.textContent = `SAVE ${filename} · ${(blob.size / 1048576).toFixed(2)} MB`;
    result.hidden = false;
    result.click();
    status.textContent = "Berhasil! File sudah siap disimpan. Kuota dihitung setelah proses download berhasil.";
    await new Promise(resolve => setTimeout(resolve, 350));
    const usageResponse = await apiFetch("/api/downloader/usage");
    const usage = await usageResponse.json().catch(() => ({}));
    if (usageResponse.ok) {
      $("ahoyDownloaderUsage").textContent = usage.unlimited
        ? `AHOY UNLIMITED · ${usage.active || 0} download aktif · Maks. ${usage.concurrency_limit} proses bersamaan`
        : `AHOY FREE · ${usage.used}/${usage.daily_limit} download berhasil hari ini · Sisa ${usage.remaining} · Maks. ${usage.concurrency_limit} proses bersamaan`;
    }
  } catch (error) {
    status.textContent = error.message || "Download gagal. Periksa URL atau coba lagi.";
  } finally {
    button.disabled = false;
  }
}

async function loadAhoyDownloaderUsage() {
  const target = $("ahoyDownloaderUsage");
  if (!target) return;
  const token = localStorage.getItem("ahoyToken");
  if (!token) {
    target.textContent = "Login untuk melihat kuota downloader.";
    return;
  }
  try {
    const response = await fetch(API + "/api/downloader/usage", { headers: { Authorization: "Bearer " + token } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Kuota belum tersedia.");
    target.textContent = data.unlimited
      ? `AHOY UNLIMITED · ${data.active || 0} download aktif · Maks. ${data.concurrency_limit} proses bersamaan`
      : `AHOY FREE · ${data.used}/${data.daily_limit} download berhasil hari ini · Sisa ${data.remaining} · Maks. ${data.concurrency_limit} proses bersamaan`;
  } catch (error) {
    target.textContent = error.message;
  }
}

function initAhoyDirectUpload() {
  const input = $("aruDirectFiles");
  const drop = $("aruDirectDrop");
  const queue = $("aruDirectQueue");
  if (!input || !drop || drop.dataset.ready === "1") return;
  drop.dataset.ready = "1";
  let files = [];
  let busy = false;
  const allowed = new Set(["mp3", "wav", "ogg", "flac"]);
  const sizeLabel = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(2) + " MB" : (bytes / 1024).toFixed(0) + " KB";
  const render = () => {
    $("aruDirectCount").textContent = files.length ? `${files.length} file dipilih` : "Belum ada file dipilih";
    queue.replaceChildren();
    if (!files.length) {
      const empty = document.createElement("div"); empty.className = "aru-direct-empty"; empty.textContent = "File yang dipilih akan muncul di sini."; queue.append(empty); return;
    }
    files.forEach((entry, index) => {
      const row = document.createElement("div"); row.className = "aru-direct-item";
      const info = document.createElement("div"); info.className = "aru-direct-file";
      const name = document.createElement("strong"); name.textContent = entry.file.name;
      const meta = document.createElement("small"); meta.textContent = `${sizeLabel(entry.file.size)} · ${entry.file.type || "audio"}`;
      info.append(name, meta);
      const state = document.createElement("div"); state.className = "aru-direct-state"; state.textContent = entry.state;
      const progress = document.createElement("progress"); progress.className = "aru-direct-progress"; progress.max = 100; progress.value = entry.progress;
      const result = document.createElement("div"); result.className = "aru-direct-result";
      if (entry.assetId) {
        const link = document.createElement("a"); link.href = "https://www.roblox.com/library/" + encodeURIComponent(entry.assetId); link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = `Audio ID: ${entry.assetId} · Open Roblox asset`;
        result.append(link);
      } else result.textContent = entry.error || "Menunggu upload";
      row.append(info, state, progress, result); queue.append(row);
    });
  };
  const add = list => {
    const incoming = Array.from(list || []);
    let rejected = 0;
    for (const file of incoming) {
      const ext = file.name.split(".").pop().toLowerCase();
      if (!allowed.has(ext) || file.size > 20 * 1024 * 1024 || !file.size) { rejected++; continue; }
      if (files.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
      files.push({ file, state: "Queued", progress: 0, assetId: null, error: "" });
    }
    if (rejected) $("aruDirectFoot").textContent = `${rejected} file dilewati. Format harus MP3/WAV/OGG/FLAC dan ukuran maksimal 20 MB per file.`;
    else $("aruDirectFoot").textContent = "File siap diunggah. Maksimal 20 MB dan 7 menit per file.";
    render();
  };
  $("aruDirectBrowse").addEventListener("click", () => input.click());
  drop.addEventListener("click", event => { if (event.target.id !== "aruDirectBrowse") input.click(); });
  input.addEventListener("change", () => { add(input.files); input.value = ""; });
  drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", event => { event.preventDefault(); drop.classList.remove("drag"); add(event.dataTransfer.files); });
  $("aruDirectClear").addEventListener("click", () => { if (busy) return; files = []; render(); });

  const uploadOne = (entry) => new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", entry.file, entry.file.name);
    form.append("displayName", entry.file.name.replace(/\.[^.]+$/, "").slice(0, 50));
    entry.state = "Uploading…"; entry.error = ""; render();
    xhr.open("POST", API + "/api/roblox/upload-direct");
    const token = localStorage.getItem("ahoyToken");
    if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) { entry.progress = Math.min(95, Math.round(event.loaded / event.total * 95)); entry.state = "Sending…"; render(); }
    };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data.assetId) {
        entry.progress = 100; entry.assetId = data.assetId; entry.state = String(data.status || "pending").toUpperCase();
        entry.error = "Roblox menerima audio. Status moderasi dapat berubah setelah pemeriksaan.";
        window.dispatchEvent(new Event("ahoy:roblox-uploaded"));
      } else { entry.state = "Failed"; entry.error = data.error || `Upload gagal (HTTP ${xhr.status || 0}).`; }
      render(); resolve();
    };
    xhr.onerror = () => { entry.state = "Failed"; entry.error = "Koneksi terputus saat upload."; render(); resolve(); };
    xhr.onabort = () => { entry.state = "Cancelled"; entry.error = "Upload dibatalkan."; render(); resolve(); };
    xhr.send(form);
  });

  $("aruDirectStart").addEventListener("click", async () => {
    if (busy) return;
    if (!localStorage.getItem("ahoyToken")) { $("aruDirectFoot").textContent = "Login ke akun AHOY terlebih dahulu."; return; }
    const pending = files.filter(entry => !entry.assetId);
    if (!pending.length) { $("aruDirectFoot").textContent = "Pilih file audio yang ingin di-upload."; return; }
    busy = true; $("aruDirectStart").disabled = true; $("aruDirectClear").disabled = true;
    let done = 0;
    for (const entry of pending) {
      await uploadOne(entry); done++;
      $("aruDirectFoot").textContent = `Proses upload ${done}/${pending.length} selesai. File berikutnya akan diproses otomatis.`;
    }
    busy = false; $("aruDirectStart").disabled = false; $("aruDirectClear").disabled = false;
    const success = files.filter(entry => entry.assetId).length;
    $("aruDirectFoot").textContent = `Selesai: ${success} berhasil dari ${files.length} file. Cek Roblox Upload History untuk status moderasi terbaru.`;
    window.dispatchEvent(new Event("ahoy:roblox-uploaded"));
  });
  render();
}

async function refreshDirectRobloxConnection() {
  const foot = $("aruDirectFoot");
  if (!foot) return;
  if (!localStorage.getItem("ahoyToken")) { foot.textContent = "Login ke akun AHOY terlebih dahulu, lalu hubungkan akun Roblox."; return; }
  try {
    const data = await robloxRequest("/api/roblox/status");
    foot.textContent = data.connected
      ? `Terhubung sebagai @${data.robloxUsername}. Upload langsung akan masuk ke akun Roblox ini; kuota convert tidak digunakan.`
      : "Akun Roblox belum terhubung. Buka panel Roblox Creator Hub di halaman Converter untuk menghubungkannya terlebih dahulu.";
  } catch (error) { foot.textContent = error.message || "Gagal memeriksa koneksi Roblox."; }
}

function loadAhoyRobloxHistory(silent = false) {
  const rows = $("ahoyHistoryRows");
  if (!rows || window.ahoyHistoryLoading) return;
  if (!localStorage.getItem("ahoyToken")) {
    rows.innerHTML = '<tr><td colspan="5" class="ahoy-history-empty">Login ke akun AHOY untuk melihat riwayat upload.</td></tr>';
    $("ahoyHistoryFoot").textContent = "Riwayat upload hanya terlihat oleh pemilik akun.";
    return;
  }
  window.ahoyHistoryLoading = true;
  if (!silent) rows.innerHTML = '<tr><td colspan="5" class="ahoy-history-empty">Memuat riwayat upload Roblox…</td></tr>';
  robloxRequest("/api/roblox/history").then(data => {
    const history = Array.isArray(data.history) ? data.history : [];
    const counts = {pending:0,approved:0,rejected:0};
    history.forEach(item => { if (counts[item.status] !== undefined) counts[item.status]++; });
    $("ahoyHistoryTotal").textContent = history.length;
    $("ahoyHistoryPending").textContent = counts.pending;
    $("ahoyHistoryApproved").textContent = counts.approved;
    $("ahoyHistoryRejected").textContent = counts.rejected;
    if (!history.length) {
      rows.innerHTML = '<tr><td colspan="5" class="ahoy-history-empty">Belum ada upload ke Roblox.</td></tr>';
    } else {
      rows.replaceChildren();
      history.forEach(item => {
        const tr = document.createElement("tr");
        const name = document.createElement("td"); name.textContent = item.display_name || "Untitled audio";
        const date = document.createElement("td");
        const parsed = item.created_at ? new Date(item.created_at) : null;
        date.textContent = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleString() : "—";
        const asset = document.createElement("td");
        const link = document.createElement("a");
        link.href = "https://www.roblox.com/library/" + encodeURIComponent(item.asset_id);
        link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = item.asset_id || "—";
        asset.appendChild(link);
        const status = document.createElement("td");
        const badge = document.createElement("span");
        const state = ["approved","pending","rejected"].includes(item.status) ? item.status : "pending";
        badge.className = "ahoy-history-status " + state; badge.textContent = state;
        status.appendChild(badge);
        const creator = document.createElement("td"); creator.textContent = item.roblox_username ? "@" + item.roblox_username : "—";
        tr.append(name,date,asset,status,creator); rows.appendChild(tr);
      });
    }
    $("ahoyHistoryFoot").textContent = "Menampilkan maksimal 50 upload terbaru. Pending akan dicek ulang dari Roblox saat refresh.";
  }).catch(error => {
    if (!silent) rows.innerHTML = '<tr><td colspan="5" class="ahoy-history-empty"></td></tr>';
    const cell = rows.querySelector(".ahoy-history-empty");
    if (cell) cell.textContent = error.message || "Gagal memuat riwayat.";
    $("ahoyHistoryFoot").textContent = "Periksa koneksi akun Roblox dan backend.";
  }).finally(() => { window.ahoyHistoryLoading = false; });
}

document.addEventListener("DOMContentLoaded", initAhoyWorkspaces);
window.addEventListener("ahoy:roblox-uploaded", () => loadAhoyRobloxHistory());


/* AHOY — INTERACTIVE GLASS CURSOR */
(() => {
    const selectors = [
        'a[href="#converter"]',
        'a[href="#membership"]',
        'a[href="#ahoySplitWorkspace"]',
        'a[href="#ahoyDirectUploadWorkspace"]',
        'a[href="#ahoyHistoryWorkspace"]'
    ];

    const buttons = document.querySelectorAll(
        selectors.map(s => `header nav ${s}`).join(',')
    );

    buttons.forEach(button => {
        button.addEventListener('pointermove', event => {
            const rect = button.getBoundingClientRect();

            const x = ((event.clientX - rect.left) / rect.width) * 100;
            const y = ((event.clientY - rect.top) / rect.height) * 100;

            button.style.setProperty('--mx', `${x}%`);
            button.style.setProperty('--my', `${y}%`);
        });

        button.addEventListener('pointerleave', () => {
            button.style.setProperty('--mx', '50%');
            button.style.setProperty('--my', '50%');
        });
    });
})();


/* ==========================================
   AHOY'S — GLOBAL INTERACTIVE GLASS CURSOR
   ========================================== */

(() => {
  const selector = [
    'button',
    'input[type="button"]',
    'input[type="submit"]',
    'input[type="reset"]',
    '[role="button"]',
    '.btn',
    '.button',
    '.gold-btn',
    '.outline',
    '.tab',
    '.tabs button',
    '.auth-tabs button',
    'header nav a[href^="#"]'
  ].join(',');

  let activeButton = null;

  document.addEventListener('pointerover', event => {
    const button = event.target.closest(selector);
    if (!button || button.disabled) return;

    activeButton = button;
    button.classList.add('ahoy-glass-hover');
  });

  document.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;

    const button = event.target.closest(selector);

    if (!button || button.disabled) {
      if (activeButton) {
        activeButton.classList.remove('ahoy-glass-hover');
        activeButton = null;
      }
      return;
    }

    activeButton = button;

    const rect = button.getBoundingClientRect();

    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;

    button.style.setProperty('--ahoy-mx', `${x}%`);
    button.style.setProperty('--ahoy-my', `${y}%`);

    button.classList.add('ahoy-glass-hover');
  });

  document.addEventListener('pointerout', event => {
    const button = event.target.closest(selector);

    if (!button) return;

    if (event.relatedTarget && button.contains(event.relatedTarget)) {
      return;
    }

    button.classList.remove('ahoy-glass-hover');
    button.style.setProperty('--ahoy-mx', '50%');
    button.style.setProperty('--ahoy-my', '50%');

    if (activeButton === button) activeButton = null;
  });
})();
