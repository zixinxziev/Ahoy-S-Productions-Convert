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

// SPEED SETTINGS
function updateSpeed() {
  const target = Number($("targetSpeed").value) || 1;
  const calc = 1 / target;
  $("speedHint").textContent =
    `Target ${target.toFixed(2)}x → calculated processing speed ${calc.toFixed(4)}x. Roblox playback may vary after platform encoding.`;
}
["targetSpeed", "robloxMode"].forEach(id => $(id).addEventListener("input", updateSpeed));
updateSpeed();

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
        headers: token ? { Authorization: "Bearer " + token } : {},
        body: fd
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Conversion failed");

      results.push({ name: data.filename, url: API + data.downloadUrl });
      row.querySelector("p").textContent = "Completed";
      row.querySelector("progress").value = 100;

      // Optimistic local update: update the counter immediately without reloading.
      if (localStorage.getItem("ahoyToken")) updateMyUsageAfterConversion();

      row.insertAdjacentHTML(
        "beforeend",
        `<p><a href="${API + data.downloadUrl}" download>Download ${escapeHtml(data.filename)}</a></p>`
      );
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
    body: JSON.stringify({ files: results.map(x => x.name) })
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
function renderAccount() {
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

// INITIALIZE
renderAccount();
initAhoyCursor();
