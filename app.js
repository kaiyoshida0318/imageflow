/* ==============================================================
   ImageFlow — Frontend app
   GitHub REST API を使って data.json と images/ を直接 commit する
   (PromptGallery v1.19.2 ベース / マインドマップ機能を削除)
   ============================================================== */

const STORAGE_KEY = "imageFlow.auth.v1";
const DATA_PATH = "data.json";
const IMAGES_DIR = "images";

let auth = null;        // { owner, repo, branch, token }
let dataSha = null;     // data.json の最新 SHA (更新時に必要)
let entries = [];       // 全エントリー
let tabs = [];          // 商品タブ定義 [{id, name, icon}]
let tagDefs = [];       // タグ定義 [{id, name}]
let titleHeaders = [];  // データ種別定義 [{id, name, color}]
let activeTabId = "_all"; // 選択中の商品タブID ("_all" は全て表示)
let activeTag = null;   // タグフィルタ
let currentDetailId = null;
let editingTabId = null; // 商品編集モーダル用
let inputTags = [];    // 追加モーダル用タグリスト
let editTags = [];     // 編集モーダル用タグリスト
let pendingImage = null; // { base64, mimeType, fileName }
let pendingSubImages = []; // 追加モーダル用サブ画像(保存前)
let pendingMaterialImages = []; // 追加モーダル用素材画像(保存前)
let editingSubImagesNew = []; // 編集モーダル:新規追加されたサブ画像
let editingSubImagesExisting = []; // 編集モーダル:既存のサブ画像path
let editingSubImagesRemoved = []; // 編集モーダル:削除予定の既存pathリスト
let editingMaterialImagesNew = []; // 編集モーダル:新規追加された素材画像
let editingMaterialImagesExisting = []; // 編集モーダル:既存の素材画像path
let editingMaterialImagesRemoved = []; // 編集モーダル:削除予定の素材画像path

// ---------- util ----------
const $ = (id) => document.getElementById(id);
const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
const b64decode = (str) => decodeURIComponent(escape(atob(str)));
const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- GitHub API ----------
async function ghFetch(path, options = {}) {
  const url = `https://api.github.com/repos/${auth.owner}/${auth.repo}/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `token ${auth.token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok && res.status !== 404 && res.status !== 409 && res.status !== 422) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API error: ${res.status}`);
  }
  return res;
}

async function loadData() {
  const res = await ghFetch(`contents/${DATA_PATH}?ref=${auth.branch}`);
  if (res.status === 404) {
    entries = [];
    tabs = [];
    tagDefs = [];
    titleHeaders = [];
    dataSha = null;
    return;
  }
  const data = await res.json();
  dataSha = data.sha;
  try {
    const json = JSON.parse(b64decode(data.content.replace(/\n/g, "")));
    entries = Array.isArray(json.entries) ? json.entries : [];
    tabs = Array.isArray(json.tabs) ? json.tabs : [];
    tagDefs = Array.isArray(json.tagDefs) ? json.tagDefs : [];
    titleHeaders = Array.isArray(json.titleHeaders) ? json.titleHeaders : [];

    // 既存entriesに使われているタグ名で、tagDefsに存在しないものを自動追加
    const definedNames = new Set(tagDefs.map((t) => t.name));
    const usedNames = new Set();
    entries.forEach((e) => (e.tags || []).forEach((n) => usedNames.add(n)));
    let added = false;
    for (const name of usedNames) {
      if (!definedNames.has(name)) {
        tagDefs.push({ id: "tag-" + genId(), name });
        added = true;
      }
    }
    if (added) {
      console.log(`既存の素材データから自動で定義に追加しました`);
    }
  } catch (e) {
    console.error("data.json 解析失敗", e);
    entries = [];
    tabs = [];
    tagDefs = [];
    titleHeaders = [];
  }
}

async function saveData(commitMessage, mergeFn) {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const body = {
      message: commitMessage,
      content: b64encode(JSON.stringify({ entries, tabs, tagDefs, titleHeaders }, null, 2)),
      branch: auth.branch
    };
    if (dataSha) body.sha = dataSha;

    const res = await ghFetch(`contents/${DATA_PATH}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });

    if (res.ok) {
      const result = await res.json();
      dataSha = result.content.sha;
      return;
    }

    const errBody = await res.json().catch(() => ({}));
    const isConflict = res.status === 409 || res.status === 422 ||
                       (errBody.message && /does not match|sha/i.test(errBody.message));

    if (isConflict) {
      console.warn(`競合検出 (attempt ${attempt + 1}/${MAX_RETRIES}) - 最新のdata.jsonを取得してリトライ`);
      const myEntries = entries.slice();
      const myTabs = tabs.slice();
      const myTagDefs = tagDefs.slice();
      const myTitleHeaders = titleHeaders.slice();
      await loadData();
      if (mergeFn) {
        entries = mergeFn(entries);
      } else {
        const myMap = new Map(myEntries.map((e) => [e.id, e]));
        const merged = entries.filter((e) => !myMap.has(e.id));
        merged.push(...myEntries);
        merged.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        entries = merged;
      }
      const myTabMap = new Map(myTabs.map((t) => [t.id, t]));
      const mergedTabs = tabs.filter((t) => !myTabMap.has(t.id));
      mergedTabs.push(...myTabs);
      tabs = mergedTabs;
      tagDefs = myTagDefs;
      titleHeaders = myTitleHeaders;
      continue;
    }

    throw new Error(errBody.message || "data.json の保存に失敗");
  }

  throw new Error("data.json の保存が複数回競合しました。ページをリロードして再度お試しください。");
}

async function uploadImage(path, base64Content, commitMessage) {
  const res = await ghFetch(`contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: commitMessage,
      content: base64Content,
      branch: auth.branch
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "画像アップロードに失敗");
  }
}

async function deleteFile(path, sha, commitMessage) {
  if (!sha) {
    const info = await ghFetch(`contents/${path}?ref=${auth.branch}`);
    if (info.status === 404) return;
    const j = await info.json();
    sha = j.sha;
  }
  await ghFetch(`contents/${path}`, {
    method: "DELETE",
    body: JSON.stringify({ message: commitMessage, sha, branch: auth.branch })
  });
}

const imageCache = new Map();

async function fetchImageAsBlobUrl(path) {
  if (imageCache.has(path)) return imageCache.get(path);
  try {
    const res = await ghFetch(`contents/${path}?ref=${auth.branch}`);
    if (!res.ok) throw new Error(`画像取得失敗: ${path}`);
    const data = await res.json();

    let cleanBase64;
    if (data.content && data.encoding === "base64") {
      cleanBase64 = data.content.replace(/\s/g, "");
    } else if (data.sha) {
      console.log(`大きいファイル(${data.size}bytes) - Git Blob APIで取得: ${path}`);
      const blobRes = await ghFetch(`git/blobs/${data.sha}`);
      if (!blobRes.ok) throw new Error(`Git Blob API失敗: ${path}`);
      const blobData = await blobRes.json();
      if (!blobData.content) throw new Error(`Git Blob APIでもcontentが空: ${path}`);
      cleanBase64 = blobData.content.replace(/\s/g, "");
    } else {
      throw new Error(`画像のcontentもshaも取得できず: ${path}`);
    }

    const binary = atob(cleanBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ext = (path.split(".").pop() || "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
               : ext === "gif" ? "image/gif"
               : ext === "webp" ? "image/webp"
               : "image/png";
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    imageCache.set(path, url);
    return url;
  } catch (e) {
    console.error("画像読み込み失敗", path, e);
    return "";
  }
}

function loadImageInto(imgEl, path) {
  imgEl.dataset.loading = "1";
  fetchImageAsBlobUrl(path).then((url) => {
    if (url) imgEl.src = url;
    imgEl.removeAttribute("data-loading");
  });
}

// ---------- 認証 ----------
function loadAuth() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function saveAuth(a) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
}
function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

async function verifyAuth(a) {
  const res = await fetch(`https://api.github.com/repos/${a.owner}/${a.repo}`, {
    headers: { "Authorization": `token ${a.token}`, "Accept": "application/vnd.github+json" }
  });
  if (!res.ok) throw new Error("リポジトリにアクセスできません。ユーザー名・リポジトリ名・トークン権限をご確認ください。");
  return true;
}

// ---------- レンダリング ----------
function render() {
  const q = $("search-input").value.trim().toLowerCase();
  let filtered = entries.filter((e) => {
    if (activeTabId !== "_all" && e.tabId !== activeTabId) return false;
    if (activeTag && !(e.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    const hay = [e.title, e.mainText, e.prompt, e.negative, e.note, e.model, e.category, ...(e.tags || [])].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  // 「全て」タブのときは、商品(タブ)の並び順でソート
  if (activeTabId === "_all") {
    const tabOrder = new Map();
    tabs.forEach((t, i) => tabOrder.set(t.id, i));
    filtered = filtered.slice().sort((a, b) => {
      const aOrder = a.tabId && tabOrder.has(a.tabId) ? tabOrder.get(a.tabId) : Number.MAX_SAFE_INTEGER;
      const bOrder = b.tabId && tabOrder.has(b.tabId) ? tabOrder.get(b.tabId) : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });
  }

  $("stat-count").textContent = entries.length;

  renderTabBar();

  const gallery = $("gallery");
  $("loading").style.display = "none";
  if (entries.length === 0) {
    $("empty-state").style.display = "block";
    gallery.innerHTML = "";
    return;
  }
  if (filtered.length === 0) {
    $("empty-state").style.display = "block";
    gallery.innerHTML = "";
    return;
  }
  $("empty-state").style.display = "none";

  gallery.innerHTML = filtered.map((e) => {
    const imgArea = e.image
      ? `<div class="card-img"><img data-path="${escapeHtml(e.image)}" alt="" loading="lazy" /></div>`
      : `<div class="card-text-main"><div class="card-text-main-inner">${escapeHtml(e.mainText || "(本文なし)")}</div></div>`;
    const headerName = getTitleHeaderNameById(e.titleHeaderId);
    const headerColor = getTitleHeaderColorById(e.titleHeaderId);
    const hasContent = headerName || e.title;
    const titleHtml = hasContent
      ? `<h3 class="card-title">${headerName ? `<span class="title-header" style="color:${escapeHtml(headerColor)}">${escapeHtml(headerName)}</span>` : ''}${headerName && e.title ? ' ' : ''}${e.title ? escapeHtml(e.title) : ''}</h3>`
      : '<h3 class="card-title card-title-placeholder">無題</h3>';
    return `
    <div class="card" data-id="${e.id}">
      ${imgArea}
      <div class="card-body">
        ${titleHtml}
        <div class="card-category">${escapeHtml(getTabNameById(e.tabId) || "—")}</div>
        ${e.tags && e.tags.length ? `<div class="card-tags">${e.tags.map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join("")}</div>` : ''}
        <div class="card-meta">
          <span></span>
          <span>${fmtDate(e.createdAt)}</span>
        </div>
      </div>
    </div>`;
  }).join("");

  document.querySelectorAll(".card-img img[data-path]").forEach((img) => {
    loadImageInto(img, img.dataset.path);
  });

  document.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.id));
  });
}

// ---------- タブバーの描画(商品) ----------
function renderTabBar() {
  const tabList = $("tab-list");
  const counts = { _all: entries.length };
  for (const e of entries) {
    if (e.tabId) counts[e.tabId] = (counts[e.tabId] || 0) + 1;
  }
  const allBtn = `
    <div class="tab-item tab-item-all ${activeTabId === '_all' ? 'active' : ''}" data-tab-id="_all">
      <span class="tab-item-icon">📚</span>
      <span class="tab-item-name">全体</span>
      <span class="tab-item-count">${counts._all || 0}</span>
    </div>
  `;
  const tabsHtml = tabs.map((t, i) => {
    const isActive = activeTabId === t.id;
    return `
    <div class="tab-item ${isActive ? 'active' : ''}" data-tab-id="${escapeHtml(t.id)}">
      <span class="tab-item-icon">${escapeHtml(t.icon || '🏷️')}</span>
      <span class="tab-item-name">${escapeHtml(t.name)}</span>
      <span class="tab-item-count">${counts[t.id] || 0}</span>
      <span class="tab-item-actions">
        ${i > 0 ? `<button class="tab-mini-btn" data-action="left" data-tab-id="${escapeHtml(t.id)}" title="左へ移動">◀</button>` : ''}
        ${i < tabs.length - 1 ? `<button class="tab-mini-btn" data-action="right" data-tab-id="${escapeHtml(t.id)}" title="右へ移動">▶</button>` : ''}
        <button class="tab-mini-btn" data-action="edit" data-tab-id="${escapeHtml(t.id)}" title="編集">✎</button>
      </span>
    </div>
  `;
  }).join("");
  tabList.innerHTML = allBtn + tabsHtml;

  tabList.querySelectorAll(".tab-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".tab-mini-btn")) return;
      activeTabId = el.dataset.tabId;
      render();
    });
  });
  tabList.querySelectorAll(".tab-mini-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const tabId = btn.dataset.tabId;
      if (action === "left") moveTab(tabId, -1);
      else if (action === "right") moveTab(tabId, 1);
      else if (action === "edit") openTabEdit(tabId);
    });
  });
}

// ---------- 商品タブ操作 ----------
function moveTab(tabId, delta) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= tabs.length) return;
  const [item] = tabs.splice(idx, 1);
  tabs.splice(newIdx, 0, item);
  saveData(`Reorder product: ${item.name}`).then(render).catch((err) => alert("並び替え失敗: " + err.message));
}

function openNewTab() {
  editingTabId = null;
  $("tab-edit-title").textContent = "新しい商品を追加";
  $("tab-edit-icon").value = "📦";
  $("tab-edit-name").value = "";
  $("btn-tab-delete").style.display = "none";
  closeAllModals();
  $("tab-edit-modal").style.display = "flex";
  setTimeout(() => $("tab-edit-name").focus(), 50);
}

function openTabEdit(tabId) {
  const t = tabs.find((x) => x.id === tabId);
  if (!t) return;
  editingTabId = tabId;
  $("tab-edit-title").textContent = "商品を編集";
  $("tab-edit-icon").value = t.icon || "🏷️";
  $("tab-edit-name").value = t.name || "";
  $("btn-tab-delete").style.display = "inline-block";
  closeAllModals();
  $("tab-edit-modal").style.display = "flex";
  setTimeout(() => $("tab-edit-name").focus(), 50);
}

async function saveTab() {
  const name = $("tab-edit-name").value.trim();
  const icon = $("tab-edit-icon").value.trim() || "🏷️";
  if (!name) {
    alert("商品名を入力してください");
    return;
  }

  const btn = $("btn-tab-save");
  btn.disabled = true;

  try {
    if (editingTabId) {
      const t = tabs.find((x) => x.id === editingTabId);
      if (!t) throw new Error("対象商品が見つかりません");
      t.name = name;
      t.icon = icon;
      await saveData(`Update product: ${name}`);
    } else {
      const newTab = { id: "tab-" + genId(), name, icon };
      tabs.push(newTab);
      await saveData(`Add product: ${name}`);
      activeTabId = newTab.id;
    }
    $("tab-edit-modal").style.display = "none";
    render();
  } catch (err) {
    alert("保存失敗: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteTab() {
  if (!editingTabId) return;
  const t = tabs.find((x) => x.id === editingTabId);
  if (!t) return;
  if (!confirm(`商品「${t.name}」を削除しますか?\n(中のデータは削除されません。「全て」で見られます)`)) return;

  try {
    tabs = tabs.filter((x) => x.id !== editingTabId);
    entries.forEach((e) => {
      if (e.tabId === editingTabId) delete e.tabId;
    });
    await saveData(`Delete product: ${t.name}`);
    if (activeTabId === editingTabId) activeTabId = "_all";
    $("tab-edit-modal").style.display = "none";
    render();
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

function refreshTabSelectOptions() {
  const optionsHtml = '<option value="">— 商品なし(全てに表示)—</option>' +
    tabs.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.icon || '🏷️')} ${escapeHtml(t.name)}</option>`).join("");
  $("input-tab-id").innerHTML = optionsHtml;
  $("edit-tab-id").innerHTML = optionsHtml;
}

function getTabNameById(tabId) {
  if (!tabId) return null;
  const t = tabs.find((x) => x.id === tabId);
  return t ? t.name : null;
}

// ---------- タグピッカー ----------
function renderTagPickerSelected(selectedId, tagsArray, popupId, optionsId) {
  const sel = $(selectedId);
  sel.innerHTML = tagsArray.map((tag, i) => `
    <span class="tag-chip-input">
      ${escapeHtml(tag)}
      <span class="tag-chip-input-remove" data-index="${i}" title="削除">×</span>
    </span>
  `).join("");
  sel.querySelectorAll(".tag-chip-input-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      tagsArray.splice(idx, 1);
      renderTagPickerSelected(selectedId, tagsArray, popupId, optionsId);
      if ($(popupId).style.display !== "none") {
        renderTagPickerOptions(optionsId, tagsArray, popupId, selectedId);
      }
    });
  });
}

function renderTagPickerOptions(optionsId, tagsArray, popupId, selectedId) {
  const opts = $(optionsId);
  if (tagDefs.length === 0) {
    opts.innerHTML = '<p class="tag-picker-empty">登録された素材データがありません。右上の「🏷️ 素材タグ管理」から追加してください。</p>';
    return;
  }
  const sorted = tagDefs.slice().sort((a, b) => a.name.localeCompare(b.name, "ja"));
  opts.innerHTML = sorted.map((td) => {
    const selected = tagsArray.includes(td.name);
    return `<span class="tag-picker-option ${selected ? 'selected' : ''}" data-name="${escapeHtml(td.name)}">${escapeHtml(td.name)}</span>`;
  }).join("");
  opts.querySelectorAll(".tag-picker-option").forEach((el) => {
    el.addEventListener("click", () => {
      const name = el.dataset.name;
      const idx = tagsArray.indexOf(name);
      if (idx === -1) {
        tagsArray.push(name);
      } else {
        tagsArray.splice(idx, 1);
      }
      renderTagPickerOptions(optionsId, tagsArray, popupId, selectedId);
      renderTagPickerSelected(selectedId, tagsArray, popupId, optionsId);
    });
  });
}

function setupTagPicker(prefix, tagsArray) {
  const toggleBtn = $(`${prefix}-tags-toggle`);
  const popup = $(`${prefix}-tags-popup`);
  const selectedId = `${prefix}-tags-selected`;
  const optionsId = `${prefix}-tags-options`;

  const newToggle = toggleBtn.cloneNode(true);
  toggleBtn.parentNode.replaceChild(newToggle, toggleBtn);
  newToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = popup.style.display !== "none";
    if (isOpen) {
      popup.style.display = "none";
    } else {
      renderTagPickerOptions(optionsId, tagsArray, `${prefix}-tags-popup`, selectedId);
      popup.style.display = "block";
    }
  });
  document.addEventListener("click", (e) => {
    if (popup.style.display !== "none") {
      const wrap = $(`${prefix}-tags-wrap`);
      if (!wrap.contains(e.target)) popup.style.display = "none";
    }
  });
}

// ---------- 素材タグ管理 ----------
function openTagManager() {
  closeAllModals();
  $("tag-mgr-new-name").value = "";
  renderTagManager();
  $("tag-mgr-modal").style.display = "flex";
  setTimeout(() => $("tag-mgr-new-name").focus(), 50);
}

function renderTagManager() {
  const list = $("tag-mgr-list");
  if (tagDefs.length === 0) {
    list.innerHTML = '<div class="tag-mgr-empty">素材データがまだありません。上から追加してください。</div>';
    return;
  }
  const usageCount = {};
  entries.forEach((e) => {
    (e.tags || []).forEach((n) => {
      usageCount[n] = (usageCount[n] || 0) + 1;
    });
  });

  const sorted = tagDefs.slice().sort((a, b) => a.name.localeCompare(b.name, "ja"));
  list.innerHTML = sorted.map((td) => `
    <div class="tag-mgr-item" data-id="${escapeHtml(td.id)}">
      <span class="tag-mgr-item-name">${escapeHtml(td.name)}</span>
      <span class="tag-mgr-item-count">${usageCount[td.name] || 0} 件</span>
      <button class="tag-mgr-btn" data-action="rename" data-id="${escapeHtml(td.id)}">名前変更</button>
      <button class="tag-mgr-btn danger" data-action="delete" data-id="${escapeHtml(td.id)}">削除</button>
    </div>
  `).join("");

  list.querySelectorAll(".tag-mgr-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "rename") startRenameTag(id);
      else if (action === "delete") deleteTagDef(id);
    });
  });
}

function startRenameTag(tagId) {
  const td = tagDefs.find((x) => x.id === tagId);
  if (!td) return;
  const item = document.querySelector(`.tag-mgr-item[data-id="${CSS.escape(tagId)}"]`);
  if (!item) return;
  const oldName = td.name;
  item.innerHTML = `
    <input class="tag-mgr-edit-input" type="text" value="${escapeHtml(oldName)}" />
    <button class="tag-mgr-btn" data-action="confirm">OK</button>
    <button class="tag-mgr-btn" data-action="cancel">キャンセル</button>
  `;
  const input = item.querySelector(".tag-mgr-edit-input");
  input.focus();
  input.select();
  const confirm = async () => {
    const newName = input.value.trim();
    if (!newName) {
      alert("名前を入力してください");
      return;
    }
    if (newName === oldName) {
      renderTagManager();
      return;
    }
    if (tagDefs.some((x) => x.id !== tagId && x.name === newName)) {
      alert("同じ名前の素材データが既にあります");
      return;
    }
    try {
      td.name = newName;
      entries.forEach((e) => {
        if (e.tags) {
          e.tags = e.tags.map((n) => n === oldName ? newName : n);
        }
      });
      await saveData(`Rename tag: ${oldName} -> ${newName}`);
      renderTagManager();
      render();
    } catch (err) {
      alert("変更失敗: " + err.message);
      td.name = oldName;
      renderTagManager();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    else if (e.key === "Escape") { e.preventDefault(); renderTagManager(); }
  });
  item.querySelector('[data-action="confirm"]').addEventListener("click", confirm);
  item.querySelector('[data-action="cancel"]').addEventListener("click", renderTagManager);
}

async function deleteTagDef(tagId) {
  const td = tagDefs.find((x) => x.id === tagId);
  if (!td) return;
  let count = 0;
  entries.forEach((e) => { if ((e.tags || []).includes(td.name)) count++; });
  const msg = count > 0
    ? `素材データ「${td.name}」を削除しますか?\n${count}件のデータから自動的に外されます。`
    : `素材データ「${td.name}」を削除しますか?`;
  if (!confirm(msg)) return;

  try {
    tagDefs = tagDefs.filter((x) => x.id !== tagId);
    entries.forEach((e) => {
      if (e.tags) {
        e.tags = e.tags.filter((n) => n !== td.name);
        if (e.tags.length === 0) delete e.tags;
      }
    });
    await saveData(`Delete tag: ${td.name}`);
    renderTagManager();
    render();
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

async function addTagDef() {
  const name = $("tag-mgr-new-name").value.trim();
  if (!name) {
    alert("素材データ名を入力してください");
    return;
  }
  if (tagDefs.some((x) => x.name === name)) {
    alert("同じ名前の素材データが既にあります");
    return;
  }
  try {
    tagDefs.push({ id: "tag-" + genId(), name });
    await saveData(`Add tag: ${name}`);
    $("tag-mgr-new-name").value = "";
    renderTagManager();
  } catch (err) {
    alert("追加失敗: " + err.message);
  }
}

// ---------- 商品管理 ----------
function openCategoryManager() {
  closeAllModals();
  $("cat-mgr-new-name").value = "";
  $("cat-mgr-new-icon").value = "📦";
  renderCategoryManager();
  $("cat-mgr-modal").style.display = "flex";
  setTimeout(() => $("cat-mgr-new-name").focus(), 50);
}

function renderCategoryManager() {
  const list = $("cat-mgr-list");
  if (tabs.length === 0) {
    list.innerHTML = '<div class="tag-mgr-empty">商品がまだありません。上から追加してください。</div>';
    return;
  }
  const usageCount = {};
  entries.forEach((e) => {
    if (e.tabId) usageCount[e.tabId] = (usageCount[e.tabId] || 0) + 1;
  });

  list.innerHTML = tabs.map((t, i) => `
    <div class="tag-mgr-item" data-id="${escapeHtml(t.id)}">
      <span style="font-size:18px;flex-shrink:0">${escapeHtml(t.icon || '🏷️')}</span>
      <span class="tag-mgr-item-name">${escapeHtml(t.name)}</span>
      <span class="tag-mgr-item-count">${usageCount[t.id] || 0} 件</span>
      ${i > 0 ? `<button class="tag-mgr-btn" data-action="up" data-id="${escapeHtml(t.id)}" title="上へ">◀</button>` : '<span style="width:30px"></span>'}
      ${i < tabs.length - 1 ? `<button class="tag-mgr-btn" data-action="down" data-id="${escapeHtml(t.id)}" title="下へ">▶</button>` : '<span style="width:30px"></span>'}
      <button class="tag-mgr-btn" data-action="rename" data-id="${escapeHtml(t.id)}">名前変更</button>
      <button class="tag-mgr-btn danger" data-action="delete" data-id="${escapeHtml(t.id)}">削除</button>
    </div>
  `).join("");

  list.querySelectorAll(".tag-mgr-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "up") moveCatInManager(id, -1);
      else if (action === "down") moveCatInManager(id, 1);
      else if (action === "rename") startRenameCat(id);
      else if (action === "delete") deleteCatDef(id);
    });
  });
}

async function moveCatInManager(tabId, delta) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= tabs.length) return;
  const [item] = tabs.splice(idx, 1);
  tabs.splice(newIdx, 0, item);
  try {
    await saveData(`Reorder product: ${item.name}`);
    renderCategoryManager();
    render();
  } catch (err) {
    alert("並び替え失敗: " + err.message);
  }
}

function startRenameCat(tabId) {
  const t = tabs.find((x) => x.id === tabId);
  if (!t) return;
  const item = document.querySelector(`#cat-mgr-list .tag-mgr-item[data-id="${CSS.escape(tabId)}"]`);
  if (!item) return;
  const oldName = t.name;
  const oldIcon = t.icon || "🏷️";
  item.innerHTML = `
    <input class="tag-mgr-edit-input" type="text" value="${escapeHtml(oldIcon)}" maxlength="4" style="flex:0 0 50px;text-align:center" data-field="icon" />
    <input class="tag-mgr-edit-input" type="text" value="${escapeHtml(oldName)}" data-field="name" />
    <button class="tag-mgr-btn" data-action="confirm">OK</button>
    <button class="tag-mgr-btn" data-action="cancel">キャンセル</button>
  `;
  const nameInput = item.querySelector('[data-field="name"]');
  const iconInput = item.querySelector('[data-field="icon"]');
  nameInput.focus();
  nameInput.select();
  const confirm = async () => {
    const newName = nameInput.value.trim();
    const newIcon = iconInput.value.trim() || "🏷️";
    if (!newName) {
      alert("商品名を入力してください");
      return;
    }
    if (newName === oldName && newIcon === oldIcon) {
      renderCategoryManager();
      return;
    }
    try {
      t.name = newName;
      t.icon = newIcon;
      await saveData(`Rename product: ${oldName} -> ${newName}`);
      renderCategoryManager();
      render();
    } catch (err) {
      alert("変更失敗: " + err.message);
      t.name = oldName;
      t.icon = oldIcon;
      renderCategoryManager();
    }
  };
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    else if (e.key === "Escape") { e.preventDefault(); renderCategoryManager(); }
  });
  iconInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    else if (e.key === "Escape") { e.preventDefault(); renderCategoryManager(); }
  });
  item.querySelector('[data-action="confirm"]').addEventListener("click", confirm);
  item.querySelector('[data-action="cancel"]').addEventListener("click", renderCategoryManager);
}

async function deleteCatDef(tabId) {
  const t = tabs.find((x) => x.id === tabId);
  if (!t) return;
  let count = 0;
  entries.forEach((e) => { if (e.tabId === tabId) count++; });
  const msg = count > 0
    ? `商品「${t.name}」を削除しますか?\n${count}件のデータは商品なし(「全て」で見られる)になります。`
    : `商品「${t.name}」を削除しますか?`;
  if (!confirm(msg)) return;

  try {
    tabs = tabs.filter((x) => x.id !== tabId);
    entries.forEach((e) => {
      if (e.tabId === tabId) delete e.tabId;
    });
    await saveData(`Delete product: ${t.name}`);
    if (activeTabId === tabId) activeTabId = "_all";
    renderCategoryManager();
    render();
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

async function addCatDef() {
  const name = $("cat-mgr-new-name").value.trim();
  const icon = $("cat-mgr-new-icon").value.trim() || "🏷️";
  if (!name) {
    alert("商品名を入力してください");
    return;
  }
  if (tabs.some((x) => x.name === name)) {
    alert("同じ名前の商品が既にあります");
    return;
  }
  try {
    tabs.push({ id: "tab-" + genId(), name, icon });
    await saveData(`Add product: ${name}`);
    $("cat-mgr-new-name").value = "";
    $("cat-mgr-new-icon").value = "📦";
    renderCategoryManager();
    render();
  } catch (err) {
    alert("追加失敗: " + err.message);
  }
}

// ---------- データ種別管理 ----------
const HEADER_COLORS = [
  { name: "煉瓦", value: "#c8451c" },
  { name: "紺", value: "#1f4e8f" },
  { name: "森", value: "#2f6d4f" },
  { name: "金茶", value: "#a87432" },
  { name: "葡萄", value: "#7b3a6c" },
  { name: "藍", value: "#3a6b8c" },
  { name: "深緋", value: "#9c2a2a" },
  { name: "墨", value: "#1b1a17" },
];

function getDefaultHeaderColor() {
  return HEADER_COLORS[0].value;
}

function getTitleHeaderColorById(id) {
  if (!id) return null;
  const h = titleHeaders.find((x) => x.id === id);
  return h ? (h.color || getDefaultHeaderColor()) : null;
}

function refreshTitleHeaderSelectOptions() {
  const optionsHtml = '<option value="">— 種別なし —</option>' +
    titleHeaders.map((h) => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}</option>`).join("");
  $("input-title-header-id").innerHTML = optionsHtml;
  $("edit-title-header-id").innerHTML = optionsHtml;
}

function getTitleHeaderNameById(id) {
  if (!id) return null;
  const h = titleHeaders.find((x) => x.id === id);
  return h ? h.name : null;
}

function openHeaderManager() {
  closeAllModals();
  $("head-mgr-new-name").value = "";
  renderHeaderManager();
  $("head-mgr-modal").style.display = "flex";
  setTimeout(() => $("head-mgr-new-name").focus(), 50);
}

function renderHeaderManager() {
  const list = $("head-mgr-list");
  if (titleHeaders.length === 0) {
    list.innerHTML = '<div class="tag-mgr-empty">データ種別がまだありません。上から追加してください。</div>';
    return;
  }
  const usageCount = {};
  entries.forEach((e) => {
    if (e.titleHeaderId) usageCount[e.titleHeaderId] = (usageCount[e.titleHeaderId] || 0) + 1;
  });

  list.innerHTML = titleHeaders.map((h) => {
    const color = h.color || getDefaultHeaderColor();
    return `
    <div class="tag-mgr-item" data-id="${escapeHtml(h.id)}">
      <span class="head-color-dot" style="background:${escapeHtml(color)}"></span>
      <span class="tag-mgr-item-name" style="color:${escapeHtml(color)};font-weight:700">${escapeHtml(h.name)}</span>
      <span class="tag-mgr-item-count">${usageCount[h.id] || 0} 件</span>
      <button class="tag-mgr-btn" data-action="color" data-id="${escapeHtml(h.id)}">色変更</button>
      <button class="tag-mgr-btn" data-action="rename" data-id="${escapeHtml(h.id)}">名前変更</button>
      <button class="tag-mgr-btn danger" data-action="delete" data-id="${escapeHtml(h.id)}">削除</button>
    </div>
  `;
  }).join("");

  list.querySelectorAll(".tag-mgr-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "rename") startRenameHeader(id);
      else if (action === "delete") deleteHeaderDef(id);
      else if (action === "color") openColorPicker(id, btn);
    });
  });
}

function openColorPicker(headerId, anchorBtn) {
  const h = titleHeaders.find((x) => x.id === headerId);
  if (!h) return;
  const item = anchorBtn.closest(".tag-mgr-item");
  document.querySelectorAll(".color-picker-popup").forEach((p) => p.remove());

  const popup = document.createElement("div");
  popup.className = "color-picker-popup";
  const currentColor = h.color || getDefaultHeaderColor();
  popup.innerHTML = HEADER_COLORS.map((c) => `
    <div class="color-swatch ${c.value === currentColor ? 'selected' : ''}"
         style="background:${c.value}"
         data-color="${c.value}"
         title="${escapeHtml(c.name)}"></div>
  `).join("");
  item.insertAdjacentElement("afterend", popup);

  popup.querySelectorAll(".color-swatch").forEach((sw) => {
    sw.addEventListener("click", async () => {
      const newColor = sw.dataset.color;
      const oldColor = h.color;
      try {
        h.color = newColor;
        popup.remove();
        await saveData(`Set header color: ${h.name}`);
        renderHeaderManager();
        render();
      } catch (err) {
        alert("色変更失敗: " + err.message);
        h.color = oldColor;
        renderHeaderManager();
      }
    });
  });
}

function startRenameHeader(headerId) {
  const h = titleHeaders.find((x) => x.id === headerId);
  if (!h) return;
  const item = document.querySelector(`#head-mgr-list .tag-mgr-item[data-id="${CSS.escape(headerId)}"]`);
  if (!item) return;
  const oldName = h.name;
  item.innerHTML = `
    <input class="tag-mgr-edit-input" type="text" value="${escapeHtml(oldName)}" />
    <button class="tag-mgr-btn" data-action="confirm">OK</button>
    <button class="tag-mgr-btn" data-action="cancel">キャンセル</button>
  `;
  const input = item.querySelector(".tag-mgr-edit-input");
  input.focus();
  input.select();
  const confirm = async () => {
    const newName = input.value.trim();
    if (!newName) { alert("名前を入力してください"); return; }
    if (newName === oldName) { renderHeaderManager(); return; }
    if (titleHeaders.some((x) => x.id !== headerId && x.name === newName)) {
      alert("同じ名前の種別が既にあります");
      return;
    }
    try {
      h.name = newName;
      await saveData(`Rename header: ${oldName} -> ${newName}`);
      renderHeaderManager();
      render();
    } catch (err) {
      alert("変更失敗: " + err.message);
      h.name = oldName;
      renderHeaderManager();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    else if (e.key === "Escape") { e.preventDefault(); renderHeaderManager(); }
  });
  item.querySelector('[data-action="confirm"]').addEventListener("click", confirm);
  item.querySelector('[data-action="cancel"]').addEventListener("click", renderHeaderManager);
}

async function deleteHeaderDef(headerId) {
  const h = titleHeaders.find((x) => x.id === headerId);
  if (!h) return;
  let count = 0;
  entries.forEach((e) => { if (e.titleHeaderId === headerId) count++; });
  const msg = count > 0
    ? `データ種別「${h.name}」を削除しますか?\n${count}件のデータから自動的に外されます。`
    : `データ種別「${h.name}」を削除しますか?`;
  if (!confirm(msg)) return;

  try {
    titleHeaders = titleHeaders.filter((x) => x.id !== headerId);
    entries.forEach((e) => {
      if (e.titleHeaderId === headerId) delete e.titleHeaderId;
    });
    await saveData(`Delete header: ${h.name}`);
    renderHeaderManager();
    render();
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

async function addHeaderDef() {
  const name = $("head-mgr-new-name").value.trim();
  if (!name) {
    alert("種別名を入力してください");
    return;
  }
  if (titleHeaders.some((x) => x.name === name)) {
    alert("同じ名前の種別が既にあります");
    return;
  }
  const usedColors = new Set(titleHeaders.map((h) => h.color).filter(Boolean));
  const availableColor = HEADER_COLORS.find((c) => !usedColors.has(c.value));
  const color = availableColor ? availableColor.value : HEADER_COLORS[titleHeaders.length % HEADER_COLORS.length].value;
  try {
    titleHeaders.push({ id: "head-" + genId(), name, color });
    await saveData(`Add header: ${name}`);
    $("head-mgr-new-name").value = "";
    renderHeaderManager();
  } catch (err) {
    alert("追加失敗: " + err.message);
  }
}

// 編集モーダル用:新規サブ画像を読み込み
function handleEditSubFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > 50 * 1024 * 1024) {
      alert(`${file.name} は大きすぎます(50MB超)。スキップします。`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(",")[1];
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      editingSubImagesNew.push({ base64, mimeType: file.type, ext, dataUrl });
      refreshEditSubPreview();
    };
    reader.readAsDataURL(file);
  }
}

function handleEditMaterialFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > 50 * 1024 * 1024) {
      alert(`${file.name} は大きすぎます(50MB超)。スキップします。`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(",")[1];
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      editingMaterialImagesNew.push({ base64, mimeType: file.type, ext, dataUrl });
      refreshEditMaterialPreview();
    };
    reader.readAsDataURL(file);
  }
}

// ---------- 詳細モーダル ----------
function closeAllModals() {
  ["add-modal", "edit-modal", "detail-modal", "tab-edit-modal", "tag-mgr-modal", "cat-mgr-modal", "head-mgr-modal"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}

function openDetail(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  closeAllModals();
  currentDetailId = id;
  if (e.image) {
    $("detail-img").style.display = "";
    $("detail-text-main").style.display = "none";
    $("detail-img").src = "";
    loadImageInto($("detail-img"), e.image);
  } else {
    $("detail-img").style.display = "none";
    $("detail-text-main").style.display = "block";
    $("detail-text-main").textContent = e.mainText || "(本文なし)";
  }
  $("detail-date").textContent = fmtDate(e.createdAt);

  const detailHeaderName = getTitleHeaderNameById(e.titleHeaderId);
  const detailHeaderColor = getTitleHeaderColorById(e.titleHeaderId);
  if (detailHeaderName || e.title) {
    $("detail-title").style.display = "block";
    let html = "";
    if (detailHeaderName) html += `<span class="title-header" style="color:${escapeHtml(detailHeaderColor)}">${escapeHtml(detailHeaderName)}</span>`;
    if (detailHeaderName && e.title) html += " ";
    if (e.title) html += escapeHtml(e.title);
    $("detail-title").innerHTML = html;
  } else $("detail-title").style.display = "none";

  if (e.subImages && e.subImages.length) {
    $("sub-images-section").style.display = "block";
    $("detail-sub-images").innerHTML = e.subImages.map((path) =>
      `<img data-load-path="${escapeHtml(path)}" data-full-path="${escapeHtml(path)}" alt="" />`
    ).join("");
    $("detail-sub-images").querySelectorAll("img[data-load-path]").forEach((img) => {
      loadImageInto(img, img.dataset.loadPath);
      img.addEventListener("click", () => {
        if (img.src) window.open(img.src);
      });
    });
  } else $("sub-images-section").style.display = "none";

  if (e.materialImages && e.materialImages.length) {
    $("material-images-section").style.display = "block";
    $("detail-material-images").innerHTML = e.materialImages.map((path) =>
      `<img data-load-path="${escapeHtml(path)}" alt="" />`
    ).join("");
    $("detail-material-images").querySelectorAll("img[data-load-path]").forEach((img) => {
      loadImageInto(img, img.dataset.loadPath);
      img.addEventListener("click", () => {
        if (img.src) window.open(img.src);
      });
    });
  } else $("material-images-section").style.display = "none";

  const categoryName = getTabNameById(e.tabId);
  if (categoryName) {
    $("category-section").style.display = "block";
    $("detail-category-name").textContent = categoryName;
  } else $("category-section").style.display = "none";

  if (e.prompt) {
    $("prompt-section").style.display = "block";
    $("detail-prompt").textContent = e.prompt;
  } else {
    $("prompt-section").style.display = "none";
    $("detail-prompt").textContent = "";
  }

  if (e.negative) {
    $("negative-section").style.display = "block";
    $("detail-negative").textContent = e.negative;
  } else $("negative-section").style.display = "none";

  if (e.tags && e.tags.length) {
    $("tags-section").style.display = "block";
    $("detail-tags").innerHTML = e.tags.map((t) => `<span class="detail-tag">${escapeHtml(t)}</span>`).join("");
  } else $("tags-section").style.display = "none";

  if (e.note) {
    $("note-section").style.display = "block";
    $("detail-note").textContent = e.note;
  } else $("note-section").style.display = "none";

  $("detail-modal").style.display = "flex";
}

async function deleteEntry() {
  const e = entries.find((x) => x.id === currentDetailId);
  if (!e) return;
  if (!confirm("このエントリーを削除しますか? (画像ファイルも削除されます)")) return;
  try {
    if (e.image) {
      await deleteFile(e.image, null, `Delete image: ${e.id}`);
    }
    for (const subPath of (e.subImages || [])) {
      try {
        await deleteFile(subPath, null, `Delete sub-image: ${e.id}`);
      } catch (err) {
        console.warn("サブ画像削除失敗(続行):", subPath, err);
      }
    }
    for (const matPath of (e.materialImages || [])) {
      try {
        await deleteFile(matPath, null, `Delete material-image: ${e.id}`);
      } catch (err) {
        console.warn("素材画像削除失敗(続行):", matPath, err);
      }
    }
    entries = entries.filter((x) => x.id !== e.id);
    await saveData(`Delete entry: ${e.id}`, (latestEntries) => {
      return latestEntries.filter((x) => x.id !== e.id);
    });
    $("detail-modal").style.display = "none";
    render();
  } catch (err) {
    alert("削除に失敗しました: " + err.message);
  }
}

// ---------- 編集 ----------
function openEdit() {
  const e = entries.find((x) => x.id === currentDetailId);
  if (!e) return;
  refreshTabSelectOptions();
  refreshTitleHeaderSelectOptions();
  $("edit-preview-img").src = "";
  loadImageInto($("edit-preview-img"), e.image);
  $("edit-prompt").value = e.prompt || "";
  $("edit-main-text").value = e.mainText || "";
  $("edit-title").value = e.title || "";
  $("edit-title-header-id").value = e.titleHeaderId || "";
  $("edit-tab-id").value = e.tabId || "";
  editTags.length = 0;
  (e.tags || []).forEach((t) => editTags.push(t));
  renderTagPickerSelected("edit-tags-selected", editTags, "edit-tags-popup", "edit-tags-options");
  $("edit-tags-popup").style.display = "none";
  $("edit-status").textContent = "";
  $("edit-status").className = "save-status";

  editingSubImagesNew = [];
  editingSubImagesExisting = (e.subImages || []).slice();
  editingSubImagesRemoved = [];
  refreshEditSubPreview();

  editingMaterialImagesNew = [];
  editingMaterialImagesExisting = (e.materialImages || []).slice();
  editingMaterialImagesRemoved = [];
  refreshEditMaterialPreview();

  $("edit-sub-file-input").value = "";
  $("edit-material-file-input").value = "";
  $("detail-modal").style.display = "none";
  $("edit-modal").style.display = "flex";
}

function refreshEditSubPreview() {
  const list = $("edit-sub-preview-list");
  const existingHtml = editingSubImagesExisting.map((path, i) => `
    <div class="sub-preview-item" data-kind="existing" data-index="${i}">
      <img data-load-path="${escapeHtml(path)}" alt="" />
      <button class="sub-preview-remove" data-kind="existing" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  const newHtml = editingSubImagesNew.map((item, i) => `
    <div class="sub-preview-item" data-kind="new" data-index="${i}">
      <img src="${item.dataUrl}" alt="" />
      <button class="sub-preview-remove" data-kind="new" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  list.innerHTML = existingHtml + newHtml;

  list.querySelectorAll("img[data-load-path]").forEach((img) => {
    loadImageInto(img, img.dataset.loadPath);
  });
  list.querySelectorAll(".sub-preview-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      if (btn.dataset.kind === "existing") {
        editingSubImagesRemoved.push(editingSubImagesExisting[idx]);
        editingSubImagesExisting.splice(idx, 1);
      } else {
        editingSubImagesNew.splice(idx, 1);
      }
      refreshEditSubPreview();
    });
  });
}

function refreshEditMaterialPreview() {
  const list = $("edit-material-preview-list");
  const existingHtml = editingMaterialImagesExisting.map((path, i) => `
    <div class="sub-preview-item" data-kind="existing" data-index="${i}">
      <img data-load-path="${escapeHtml(path)}" alt="" />
      <button class="sub-preview-remove" data-kind="existing" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  const newHtml = editingMaterialImagesNew.map((item, i) => `
    <div class="sub-preview-item" data-kind="new" data-index="${i}">
      <img src="${item.dataUrl}" alt="" />
      <button class="sub-preview-remove" data-kind="new" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  list.innerHTML = existingHtml + newHtml;

  list.querySelectorAll("img[data-load-path]").forEach((img) => {
    loadImageInto(img, img.dataset.loadPath);
  });
  list.querySelectorAll(".sub-preview-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      if (btn.dataset.kind === "existing") {
        editingMaterialImagesRemoved.push(editingMaterialImagesExisting[idx]);
        editingMaterialImagesExisting.splice(idx, 1);
      } else {
        editingMaterialImagesNew.splice(idx, 1);
      }
      refreshEditMaterialPreview();
    });
  });
}

async function updateEntry() {
  const prompt = $("edit-prompt").value.trim();
  const mainText = $("edit-main-text").value.trim();
  const e0 = entries.find((x) => x.id === currentDetailId);
  // 画像なしエントリーは本文必須、画像ありはプロンプト/メモ任意
  if (e0 && !e0.image && !mainText) {
    alert("画像なしエントリーは本文を入力してください");
    return;
  }

  const btn = $("btn-update");
  btn.disabled = true;
  $("edit-status").textContent = "保存中…";
  $("edit-status").className = "save-status";

  try {
    const idx = entries.findIndex((x) => x.id === currentDetailId);
    if (idx === -1) throw new Error("対象のエントリーが見つかりません");
    const entryId = entries[idx].id;

    const newSubPaths = [];
    const existingCount = editingSubImagesExisting.length;
    for (let i = 0; i < editingSubImagesNew.length; i++) {
      $("edit-status").textContent = `サブ画像をアップロード中… (${i + 1}/${editingSubImagesNew.length})`;
      const sub = editingSubImagesNew[i];
      const subPath = `${IMAGES_DIR}/${entryId}-sub-${Date.now()}-${existingCount + i + 1}.${sub.ext}`;
      await uploadImage(subPath, sub.base64, `Add sub-image: ${entryId}`);
      newSubPaths.push(subPath);
    }

    for (const path of editingSubImagesRemoved) {
      try {
        await deleteFile(path, null, `Delete sub-image: ${entryId}`);
      } catch (e) {
        console.warn("サブ画像削除失敗(続行):", path, e);
      }
    }

    const newMaterialPaths = [];
    const existingMatCount = editingMaterialImagesExisting.length;
    for (let i = 0; i < editingMaterialImagesNew.length; i++) {
      $("edit-status").textContent = `素材画像をアップロード中… (${i + 1}/${editingMaterialImagesNew.length})`;
      const mat = editingMaterialImagesNew[i];
      const matPath = `${IMAGES_DIR}/${entryId}-material-${Date.now()}-${existingMatCount + i + 1}.${mat.ext}`;
      await uploadImage(matPath, mat.base64, `Add material-image: ${entryId}`);
      newMaterialPaths.push(matPath);
    }

    for (const path of editingMaterialImagesRemoved) {
      try {
        await deleteFile(path, null, `Delete material-image: ${entryId}`);
      } catch (e) {
        console.warn("素材画像削除失敗(続行):", path, e);
      }
    }

    $("edit-status").textContent = "保存中…";

    const finalSubImages = [...editingSubImagesExisting, ...newSubPaths];
    const finalMaterialImages = [...editingMaterialImagesExisting, ...newMaterialPaths];

    const updated = {
      ...entries[idx],
      prompt: prompt || undefined,
      mainText: mainText || undefined,
      title: $("edit-title").value.trim() || undefined,
      titleHeaderId: $("edit-title-header-id").value || undefined,
      tabId: $("edit-tab-id").value || undefined,
      tags: editTags.length ? editTags.slice() : undefined,
      subImages: finalSubImages.length ? finalSubImages : undefined,
      materialImages: finalMaterialImages.length ? finalMaterialImages : undefined,
      updatedAt: new Date().toISOString()
    };
    entries[idx] = updated;

    await saveData(`Update entry: ${currentDetailId}`, (latestEntries) => {
      return latestEntries.map((e) => e.id === updated.id ? updated : e);
    });

    $("edit-status").textContent = "✓ 更新しました";
    $("edit-status").className = "save-status ok";
    setTimeout(() => {
      $("edit-modal").style.display = "none";
      editingSubImagesNew = [];
      editingSubImagesExisting = [];
      editingSubImagesRemoved = [];
      editingMaterialImagesNew = [];
      editingMaterialImagesExisting = [];
      editingMaterialImagesRemoved = [];
      render();
    }, 700);
  } catch (err) {
    $("edit-status").textContent = "✗ " + err.message;
    $("edit-status").className = "save-status err";
  } finally {
    btn.disabled = false;
  }
}

// ---------- 追加 ----------
function resetAddForm() {
  pendingImage = null;
  pendingSubImages = [];
  pendingMaterialImages = [];
  $("preview-wrap").style.display = "none";
  $("dropzone").style.display = "block";
  $("file-input").value = "";
  $("sub-file-input").value = "";
  $("sub-preview-list").innerHTML = "";
  $("material-file-input").value = "";
  $("material-preview-list").innerHTML = "";
  $("input-prompt").value = "";
  $("input-main-text").value = "";
  $("input-title").value = "";
  $("input-title-header-id").value = "";
  inputTags.length = 0;
  renderTagPickerSelected("input-tags-selected", inputTags, "input-tags-popup", "input-tags-options");
  $("input-tags-popup").style.display = "none";
  $("input-tab-id").value = activeTabId === "_all" ? "" : activeTabId;
  $("save-status").textContent = "";
  $("save-status").className = "save-status";
}

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    alert("画像ファイルを選んでください");
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    alert("画像が大きすぎます(50MB超)。サイズを小さくしてください。");
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    const base64 = dataUrl.split(",")[1];
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    pendingImage = { base64, mimeType: file.type, ext };
    $("preview-img").src = dataUrl;
    $("preview-wrap").style.display = "block";
    $("dropzone").style.display = "none";
  };
  reader.readAsDataURL(file);
}

function handleSubFiles(files, targetListId, pendingArray) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > 50 * 1024 * 1024) {
      alert(`${file.name} は大きすぎます(50MB超)。スキップします。`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(",")[1];
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const item = { base64, mimeType: file.type, ext, dataUrl, tempId: genId() };
      pendingArray.push(item);
      renderSubPreview(targetListId, pendingArray);
    };
    reader.readAsDataURL(file);
  }
}

function renderSubPreview(listId, pendingArray) {
  const list = $(listId);
  list.innerHTML = pendingArray.map((item, i) => `
    <div class="sub-preview-item" data-temp-id="${item.tempId}">
      <img src="${item.dataUrl || ''}" alt="" />
      ${item.uploading ? '<div class="sub-preview-uploading">up…</div>' : ''}
      <button class="sub-preview-remove" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  list.querySelectorAll(".sub-preview-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      pendingArray.splice(idx, 1);
      renderSubPreview(listId, pendingArray);
    });
  });
}

async function saveEntry() {
  const prompt = $("input-prompt").value.trim();
  const mainText = $("input-main-text").value.trim();
  if (!pendingImage && !mainText) {
    alert("メイン画像か、画像不使用時の文章を入力してください");
    return;
  }

  const btn = $("btn-save");
  btn.disabled = true;
  $("save-status").textContent = pendingImage ? "画像をアップロード中…" : "保存中…";
  $("save-status").className = "save-status";

  try {
    const id = genId();
    let imgPath = undefined;
    if (pendingImage) {
      const ext = pendingImage.ext;
      imgPath = `${IMAGES_DIR}/${id}.${ext}`;
      await uploadImage(imgPath, pendingImage.base64, `Add image: ${id}`);
    }

    const subImagePaths = [];
    for (let i = 0; i < pendingSubImages.length; i++) {
      $("save-status").textContent = `サブ画像をアップロード中… (${i + 1}/${pendingSubImages.length})`;
      const sub = pendingSubImages[i];
      const subPath = `${IMAGES_DIR}/${id}-sub-${i + 1}.${sub.ext}`;
      await uploadImage(subPath, sub.base64, `Add sub-image: ${id} #${i + 1}`);
      subImagePaths.push(subPath);
    }

    const materialImagePaths = [];
    for (let i = 0; i < pendingMaterialImages.length; i++) {
      $("save-status").textContent = `素材画像をアップロード中… (${i + 1}/${pendingMaterialImages.length})`;
      const mat = pendingMaterialImages[i];
      const matPath = `${IMAGES_DIR}/${id}-material-${i + 1}.${mat.ext}`;
      await uploadImage(matPath, mat.base64, `Add material-image: ${id} #${i + 1}`);
      materialImagePaths.push(matPath);
    }

    $("save-status").textContent = "メタデータを保存中…";

    const entry = {
      id,
      image: imgPath,
      mainText: mainText || undefined,
      subImages: subImagePaths.length ? subImagePaths : undefined,
      materialImages: materialImagePaths.length ? materialImagePaths : undefined,
      tabId: $("input-tab-id").value || undefined,
      titleHeaderId: $("input-title-header-id").value || undefined,
      title: $("input-title").value.trim() || undefined,
      tags: inputTags.length ? inputTags.slice() : undefined,
      prompt: prompt || undefined,
      createdAt: new Date().toISOString()
    };

    entries.unshift(entry);
    await saveData(`Add entry: ${id}`, (latestEntries) => {
      return [entry, ...latestEntries.filter((e) => e.id !== entry.id)];
    });

    $("save-status").textContent = "✓ 保存しました";
    $("save-status").className = "save-status ok";
    setTimeout(() => {
      $("add-modal").style.display = "none";
      resetAddForm();
      render();
    }, 700);
  } catch (err) {
    $("save-status").textContent = "✗ " + err.message;
    $("save-status").className = "save-status err";
  } finally {
    btn.disabled = false;
  }
}

// ---------- コピー ----------
function copyText(text, btnEl) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btnEl.textContent;
    btnEl.textContent = "コピー済み";
    btnEl.classList.add("copied");
    setTimeout(() => {
      btnEl.textContent = orig;
      btnEl.classList.remove("copied");
    }, 1200);
  });
}

// ---------- イベント ----------
function bindEvents() {
  $("auth-save").addEventListener("click", async () => {
    const a = {
      owner: $("input-owner").value.trim(),
      repo: $("input-repo").value.trim(),
      branch: $("input-branch").value.trim() || "main",
      token: $("input-token").value.trim()
    };
    if (!a.owner || !a.repo || !a.token) {
      $("auth-error").textContent = "全ての項目を入力してください";
      return;
    }
    $("auth-error").textContent = "";
    $("auth-save").disabled = true;
    $("auth-save").textContent = "接続中…";
    try {
      await verifyAuth(a);
      saveAuth(a);
      auth = a;
      $("auth-modal").style.display = "none";
      await init();
    } catch (err) {
      $("auth-error").textContent = err.message;
    } finally {
      $("auth-save").disabled = false;
      $("auth-save").textContent = "接続する";
    }
  });

  $("btn-settings").addEventListener("click", () => {
    if (confirm("接続設定をリセットしますか? (トークン等をブラウザから削除)")) {
      clearAuth();
      location.reload();
    }
  });

  $("logo-link").addEventListener("click", () => {
    activeTabId = "_all";
    activeTag = null;
    $("search-input").value = "";
    closeAllModals();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("btn-add").addEventListener("click", () => {
    refreshTabSelectOptions();
    refreshTitleHeaderSelectOptions();
    resetAddForm();
    $("add-modal").style.display = "flex";
  });

  $("btn-add-tab").addEventListener("click", openNewTab);

  document.querySelectorAll(".icon-chip[data-icon]").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("tab-edit-icon").value = chip.dataset.icon;
    });
  });
  $("btn-tab-save").addEventListener("click", saveTab);
  $("btn-tab-delete").addEventListener("click", deleteTab);
  $("tab-edit-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveTab(); }
  });

  $("btn-tag-mgr").addEventListener("click", openTagManager);
  $("tag-mgr-add").addEventListener("click", addTagDef);
  $("tag-mgr-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTagDef(); }
  });

  $("btn-cat-mgr").addEventListener("click", openCategoryManager);
  $("cat-mgr-add").addEventListener("click", addCatDef);
  $("cat-mgr-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCatDef(); }
  });
  $("cat-mgr-new-icon").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCatDef(); }
  });
  document.querySelectorAll(".icon-chip[data-cat-icon]").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("cat-mgr-new-icon").value = chip.dataset.catIcon;
    });
  });

  $("btn-head-mgr").addEventListener("click", openHeaderManager);
  $("head-mgr-add").addEventListener("click", addHeaderDef);
  $("head-mgr-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addHeaderDef(); }
  });

  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => {
      $(el.dataset.close).style.display = "none";
    });
  });

  const dz = $("dropzone");
  dz.addEventListener("click", () => $("file-input").click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    handleFile(e.dataTransfer.files[0]);
  });
  $("file-input").addEventListener("change", (e) => handleFile(e.target.files[0]));
  $("preview-clear").addEventListener("click", () => {
    pendingImage = null;
    $("preview-wrap").style.display = "none";
    $("dropzone").style.display = "block";
    $("file-input").value = "";
  });

  const subDz = $("sub-dropzone");
  subDz.addEventListener("click", () => $("sub-file-input").click());
  subDz.addEventListener("dragover", (e) => { e.preventDefault(); subDz.classList.add("drag"); });
  subDz.addEventListener("dragleave", () => subDz.classList.remove("drag"));
  subDz.addEventListener("drop", (e) => {
    e.preventDefault();
    subDz.classList.remove("drag");
    handleSubFiles(e.dataTransfer.files, "sub-preview-list", pendingSubImages);
  });
  $("sub-file-input").addEventListener("change", (e) => {
    handleSubFiles(e.target.files, "sub-preview-list", pendingSubImages);
    e.target.value = "";
  });

  const editSubDz = $("edit-sub-dropzone");
  editSubDz.addEventListener("click", () => $("edit-sub-file-input").click());
  editSubDz.addEventListener("dragover", (e) => { e.preventDefault(); editSubDz.classList.add("drag"); });
  editSubDz.addEventListener("dragleave", () => editSubDz.classList.remove("drag"));
  editSubDz.addEventListener("drop", (e) => {
    e.preventDefault();
    editSubDz.classList.remove("drag");
    handleEditSubFiles(e.dataTransfer.files);
  });
  $("edit-sub-file-input").addEventListener("change", (e) => {
    handleEditSubFiles(e.target.files);
    e.target.value = "";
  });

  const matDz = $("material-dropzone");
  matDz.addEventListener("click", () => $("material-file-input").click());
  matDz.addEventListener("dragover", (e) => { e.preventDefault(); matDz.classList.add("drag"); });
  matDz.addEventListener("dragleave", () => matDz.classList.remove("drag"));
  matDz.addEventListener("drop", (e) => {
    e.preventDefault();
    matDz.classList.remove("drag");
    handleSubFiles(e.dataTransfer.files, "material-preview-list", pendingMaterialImages);
  });
  $("material-file-input").addEventListener("change", (e) => {
    handleSubFiles(e.target.files, "material-preview-list", pendingMaterialImages);
    e.target.value = "";
  });

  const editMatDz = $("edit-material-dropzone");
  editMatDz.addEventListener("click", () => $("edit-material-file-input").click());
  editMatDz.addEventListener("dragover", (e) => { e.preventDefault(); editMatDz.classList.add("drag"); });
  editMatDz.addEventListener("dragleave", () => editMatDz.classList.remove("drag"));
  editMatDz.addEventListener("drop", (e) => {
    e.preventDefault();
    editMatDz.classList.remove("drag");
    handleEditMaterialFiles(e.dataTransfer.files);
  });
  $("edit-material-file-input").addEventListener("change", (e) => {
    handleEditMaterialFiles(e.target.files);
    e.target.value = "";
  });

  $("btn-save").addEventListener("click", saveEntry);

  $("search-input").addEventListener("input", render);

  $("copy-prompt").addEventListener("click", (e) => copyText($("detail-prompt").textContent, e.target));
  $("copy-negative").addEventListener("click", (e) => copyText($("detail-negative").textContent, e.target));

  $("btn-delete").addEventListener("click", deleteEntry);

  $("btn-edit").addEventListener("click", openEdit);
  $("btn-update").addEventListener("click", updateEntry);

  setupTagPicker("input", inputTags);
  setupTagPicker("edit", editTags);

  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

// ---------- 初期化 ----------
async function init() {
  $("loading").style.display = "block";
  $("gallery").innerHTML = "";
  try {
    await loadData();
    render();
  } catch (err) {
    $("loading").textContent = "読み込み失敗: " + err.message;
  }
}

(function start() {
  bindEvents();
  closeAllModals();
  auth = loadAuth();
  if (auth) {
    $("auth-modal").style.display = "none";
    init();
  } else {
    $("auth-modal").style.display = "flex";
  }
})();
