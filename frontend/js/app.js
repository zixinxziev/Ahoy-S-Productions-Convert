
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

// ===============================
// LANGUAGE
// ===============================

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

// ===============================
// FILE SELECTION
// ===============================

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function addFiles(list) {
  selected = [...selected, ...Array.from(list)];

  $("fileList").innerHTML = selected
    .map((f, i) =>
      `<div>${i + 1}. ${escapeHtml(f.name)} · ${(f.size / 1048576).toFixed(2)} MB</div>`
    )
    .join("");

  if (selected[0]) {
    $("originalPreview").src = URL.createObjectURL(selected[0]);
  }
}

$("browse").onclick = () => $("files").click();

$("dropzone").onclick = e => {
  if (e.target.tagName !== "BUTTON") {
    $("files").click();
  }
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

// ===============================
// SPEED SETTINGS
// ===============================

function updateSpeed() {
  const target = Number($("targetSpeed").value) || 1;
  const calc = 1 / target;

  $("speedHint").textContent =
    `Target ${target.toFixed(2)}x → calculated processing speed ${calc.toFixed(4)}x. Roblox playback may vary after platform encoding.`;
}

["targetSpeed", "robloxMode"].forEach(id => {
  $(id).addEventListener("input", updateSpeed);
});

updateSpeed();

// ===============================
// AUDIO CONVERTER
// ===============================

$("convert").onclick = async () => {
  if (!selected.length) {
    return alert("Select audio files first.");
  }

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
        targetSpeed: $("targetSpeed").value,
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
        headers: token
          ? { Authorization: "Bearer " + token }
          : {},
        body: fd
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Conversion failed");
      }

      results.push({
        name: data.filename,
        url: API + data.downloadUrl
      });

      row.querySelector("p").textContent = "Completed";
      row.querySelector("progress").value = 100;

      if (localStorage.getItem("ahoyToken")) {
        updateMyUsageAfterConversion();
      }

      row.insertAdjacentHTML(
        "beforeend",
        `<p><a href="${API + data.downloadUrl}" download>Download ${escapeHtml(data.filename)}</a></p>`
      );

      if (i === 0) {
        $("convertedPreview").src = API + data.downloadUrl;
      }
    }

    $("downloadZip").disabled = !results.length;

  } catch (err) {
    alert(err.message);

  } finally {
    $("convert").disabled = false;
  }
};

// ===============================
// DOWNLOAD ZIP
// ===============================

$("downloadZip").onclick = async () => {
  const token = localStorage.getItem("ahoyToken");

  const r = await fetch(API + "/api/download-zip", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {})
    },
    body: JSON.stringify({
      files: results.map(x => x.name)
    })
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
// MEMBER USAGE DISPLAY
let usageCountdownTimer = null;
let currentUsage = null;

function stopUsageTimers() {
  if (usageCountdownTimer) clearInterval(usageCountdownTimer);
  usageCountdownTimer = null;
  currentUsage = null;
}

// Update the visible quota immediately after a successful conversion.
// No page reload and no repeated API polling are needed.
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
  if (subEl) subEl.textContent = `${currentUsage.remaining} of ${currentUsage.limit} daily conversions remaining`;
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

  panel.innerHTML = '<div class="ahoy-usage-loading">Loading your usage...</div>';

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
        <div class="ahoy-usage-head"><span>DAILY USAGE</span><span class="ahoy-usage-badge unlimited">UNLIMITED</span></div>
        <p class="ahoy-usage-subtitle">Unlimited conversions enabled</p>
      `;
      return;
    }

    const limit = Math.max(1, Number(data.daily_limit) || 10);
    const used = Math.max(0, Number(data.used) || 0);
    const remaining = Math.max(0, Number(data.remaining) || 0);
    currentUsage = { unlimited: false, limit, used, remaining };
    const percentage = Math.min(100, used / limit * 100);
    const resetAt = data.reset_at;

    panel.innerHTML = `
      <div class="ahoy-usage-head"><span>DAILY USAGE</span><span class="ahoy-usage-badge free">FREE</span></div>
      <div class="ahoy-usage-line"><strong id="ahoyUsageNumber">${remaining}</strong><span id="ahoyUsageSubtext">${remaining} of ${limit} remaining</span></div>
      <div class="ahoy-usage-track"><div id="ahoyUsageFill" class="ahoy-usage-fill" style="width:${percentage}%"></div></div>
      <div class="ahoy-usage-stats"><span id="ahoyUsageUsed">Used: ${used}</span><span id="ahoyUsageRemaining">Remaining: ${remaining}</span></div>
      <div class="ahoy-usage-reset"><span>Resets in</span><strong id="ahoyUsageCountdown">${resetAt ? formatCountdown(resetAt) : "--:--:--"}</strong></div>
    `;

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
      <div class="ahoy-usage-head"><span>MY USAGE</span></div>
      <p class="ahoy-usage-error">${escapeHtml(error.message)}</p>
      <button type="button" id="ahoyRetryUsage" class="outline">Retry</button>
    `;
    $("ahoyRetryUsage")?.addEventListener("click", loadMyUsage);
  }
}

// ACCOUNT PROFILE
// ===============================

function renderAccount() {
  const username = localStorage.getItem("ahoyUsername");
  const membership = localStorage.getItem("ahoyMembership");
  const accountBtn = $("accountBtn");
  let panel = $("accountStatus");

  if (!username || !localStorage.getItem("ahoyToken")) {
    stopUsageTimers();
    if (panel) panel.remove();
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
      <div class="ahoy-usage-loading">Loading your usage...</div>
    </section>
  `;

  $("ahoyLogout").onclick = () => {
    if (!confirm("Are you sure you want to logout?")) return;
    localStorage.removeItem("ahoyToken");
    localStorage.removeItem("ahoyUsername");
    localStorage.removeItem("ahoyMembership");
    renderAccount();
  };

  // Fetch once when the account panel is created; refresh only at daily reset.
  loadMyUsage();
}

// LOGIN / REGISTER MODAL
// ===============================

$("accountBtn").onclick = () => {
  $("authModal").classList.add("open");
};

$("closeModal").onclick = () => {
  $("authModal").classList.remove("open");
};

$("loginTab").onclick = () => {
  authMode = "login";
  $("authMessage").textContent = "";
};

$("registerTab").onclick = () => {
  authMode = "register";
  $("authMessage").textContent = "";
};

// ===============================
// LOGIN & REGISTER REQUEST
// ===============================

$("authForm").onsubmit = async e => {
  e.preventDefault();

  const submitButton = $("authForm").querySelector(
    'button[type="submit"]'
  );

  if (submitButton) submitButton.disabled = true;

  $("authMessage").textContent = "Please wait...";

  try {
    const username = $("username").value.trim();
    const password = $("password").value;

    const r = await fetch(
      API + "/api/auth/" + authMode,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          username,
          password
        })
      }
    );

    const d = await r.json();

    if (!r.ok) {
      throw new Error(d.error || "Authentication failed");
    }

    localStorage.setItem("ahoyToken", d.token);
    localStorage.setItem("ahoyUsername", username);
    localStorage.setItem("ahoyMembership", d.membership || "free");

    $("password").value = "";

    $("authMessage").textContent = "Successfully signed in!";

    $("authModal").classList.remove("open");

    renderAccount();

  } catch (err) {
    $("authMessage").textContent = err.message;

  } finally {
    if (submitButton) submitButton.disabled = false;
  }
};

// ===============================
// INTRO
// ===============================

$("skipIntro").onclick = () => {
  $("intro").remove();
};

if (sessionStorage.getItem("ahoyIntroSeen")) {
  $("intro").remove();
} else {
  sessionStorage.setItem("ahoyIntroSeen", "1");

  setTimeout(() => {
    $("intro")?.remove();
  }, 3100);
}

// ===============================
// INITIALIZE ACCOUNT
// ===============================

renderAccount();
