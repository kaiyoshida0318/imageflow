/* ==============================================================
   ImageFlow — Frontend app (v1.1.0)
   商品レコード中心の構成。GitHub REST API で data.json と
   images/ , csv/ を直接 commit する。
   ============================================================== */

const STORAGE_KEY = "imageFlow.auth.v1";
const DATA_PATH = "data.json";
const IMAGES_DIR = "images";
const CSV_DIR = "csv";

// デフォルトの項目(セクション)。楽天レビューはCSVインポートが担うため別扱い。
const DEFAULT_SECTIONS = [
  { key: "analysis", label: "分析" }
];

// 商品にsectionsが無ければデフォルトで補完して返す
function ensureSections(p) {
  if (!Array.isArray(p.sections) || p.sections.length === 0) {
    p.sections = DEFAULT_SECTIONS.map((s) => ({ key: s.key, label: s.label, texts: [], images: [] }));
  } else {
    // 既存セクションに texts / images が無ければ補完
    p.sections.forEach((s) => {
      if (!Array.isArray(s.texts)) s.texts = [];
      if (!Array.isArray(s.images)) s.images = [];
    });
    // デフォルト外かつ中身が空のセクションは削除(TOP画像・構成案を廃止した名残を掃除)
    const defaultKeys = new Set(DEFAULT_SECTIONS.map((d) => d.key));
    p.sections = p.sections.filter((s) => {
      if (defaultKeys.has(s.key)) return true;
      // デフォルト外でも、中身があれば残す
      return (s.texts && s.texts.length) || (s.images && s.images.length);
    });
    // デフォルトにあってまだ無いセクションを足す
    const have = new Set(p.sections.map((s) => s.key));
    DEFAULT_SECTIONS.forEach((d) => {
      if (!have.has(d.key)) p.sections.push({ key: d.key, label: d.label, texts: [], images: [] });
    });
  }
  return p.sections;
}

let auth = null;
let dataSha = null;
let products = [];
let currentDetailId = null;

let pendingImage = null;
let pendingCsv = null;

// ---------- util ----------
const $ = (id) => document.getElementById(id);
const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
const b64decode = (str) => decodeURIComponent(escape(atob(str)));
const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function todayShort() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}${dd}`;
}

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
    products = [];
    dataSha = null;
    return;
  }
  const data = await res.json();
  dataSha = data.sha;
  try {
    const json = JSON.parse(b64decode(data.content.replace(/\n/g, "")));
    products = Array.isArray(json.products) ? json.products : [];
  } catch (e) {
    console.error("data.json 解析失敗", e);
    products = [];
  }
}

async function saveData(commitMessage, mergeFn) {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const body = {
      message: commitMessage,
      content: b64encode(JSON.stringify({ products }, null, 2)),
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
      console.warn(`競合検出 (attempt ${attempt + 1}/${MAX_RETRIES}) - 最新を取得してリトライ`);
      const mine = products.slice();
      await loadData();
      if (mergeFn) {
        products = mergeFn(products);
      } else {
        const myMap = new Map(mine.map((p) => [p.id, p]));
        const merged = products.filter((p) => !myMap.has(p.id));
        merged.push(...mine);
        merged.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        products = merged;
      }
      continue;
    }

    throw new Error(errBody.message || "data.json の保存に失敗");
  }
  throw new Error("data.json の保存が複数回競合しました。ページをリロードして再度お試しください。");
}

async function uploadFile(path, base64Content, commitMessage) {
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
    throw new Error(err.message || "ファイルアップロードに失敗");
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

const blobCache = new Map();

async function fetchAsBlobUrl(path, isImage = true) {
  if (blobCache.has(path)) return blobCache.get(path);
  try {
    const res = await ghFetch(`contents/${path}?ref=${auth.branch}`);
    if (!res.ok) throw new Error(`取得失敗: ${path}`);
    const data = await res.json();

    let cleanBase64;
    if (data.content && data.encoding === "base64") {
      cleanBase64 = data.content.replace(/\s/g, "");
    } else if (data.sha) {
      const blobRes = await ghFetch(`git/blobs/${data.sha}`);
      if (!blobRes.ok) throw new Error(`Git Blob API失敗: ${path}`);
      const blobData = await blobRes.json();
      if (!blobData.content) throw new Error(`contentが空: ${path}`);
      cleanBase64 = blobData.content.replace(/\s/g, "");
    } else {
      throw new Error(`contentもshaも取得できず: ${path}`);
    }

    const binary = atob(cleanBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    let mime;
    if (isImage) {
      const ext = (path.split(".").pop() || "png").toLowerCase();
      mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
           : ext === "gif" ? "image/gif"
           : ext === "webp" ? "image/webp"
           : "image/png";
    } else {
      mime = "text/csv";
    }
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    blobCache.set(path, url);
    return url;
  } catch (e) {
    console.error("読み込み失敗", path, e);
    return "";
  }
}

function loadImageInto(imgEl, path) {
  imgEl.dataset.loading = "1";
  fetchAsBlobUrl(path, true).then((url) => {
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
function saveAuth(a) { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); }
function clearAuth() { localStorage.removeItem(STORAGE_KEY); }

async function verifyAuth(a) {
  const res = await fetch(`https://api.github.com/repos/${a.owner}/${a.repo}`, {
    headers: { "Authorization": `token ${a.token}`, "Accept": "application/vnd.github+json" }
  });
  if (!res.ok) throw new Error("リポジトリにアクセスできません。ユーザー名・リポジトリ名・トークン権限をご確認ください。");
  return true;
}

// ---------- レンダリング(商品一覧) ----------
function render() {
  $("stat-count").textContent = products.length;
  const gallery = $("gallery");
  $("loading").style.display = "none";

  if (products.length === 0) {
    $("empty-state").style.display = "block";
    gallery.innerHTML = "";
    return;
  }
  $("empty-state").style.display = "none";

  const sorted = products.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  gallery.innerHTML = sorted.map((p) => {
    const imgArea = p.image
      ? `<div class="card-img"><img data-path="${escapeHtml(p.image)}" alt="" loading="lazy" /></div>`
      : `<div class="card-img card-noimg"><span>画像なし</span></div>`;
    const csvBadge = p.csvPath ? `<span class="card-csv-badge">📄 CSV</span>` : "";
    return `
    <div class="card" data-id="${escapeHtml(p.id)}">
      ${imgArea}
      <div class="card-body">
        <div class="card-start-date">${escapeHtml(p.startDate || "—")}</div>
        <h3 class="card-title">${escapeHtml(p.name || "無題")}</h3>
        <div class="card-meta">
          <span>${csvBadge}</span>
          <span>${p.createdAt ? fmtDate(p.createdAt) : ""}</span>
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

// ---------- 商品詳細 ----------
function closeAllModals() {
  ["add-modal", "detail-modal", "lightbox"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}

function openDetail(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  closeAllModals();
  currentDetailId = id;
  ensureSections(p);

  // 商品画像
  if (p.image) {
    $("detail-img").style.display = "";
    $("detail-noimg").style.display = "none";
    $("detail-img").src = "";
    loadImageInto($("detail-img"), p.image);
  } else {
    $("detail-img").style.display = "none";
    $("detail-noimg").style.display = "flex";
  }

  // 商品情報(インライン編集の初期値)
  $("edit-start-date").value = p.startDate || "";
  $("edit-product-name").value = p.name || "";
  $("editor-head-status").textContent = "";
  $("editor-head-status").className = "save-status";

  // CSV
  refreshCsvRow(p);

  // セクション描画
  renderSections(p);

  $("detail-modal").style.display = "flex";
}

// CSV行の表示更新
function refreshCsvRow(p) {
  const link = $("detail-csv-link");
  const none = $("editor-csv-none");
  if (p.csvPath) {
    none.style.display = "none";
    link.style.display = "inline-flex";
    $("detail-csv-name").textContent = "読み込み中…";
    fetchAsBlobUrl(p.csvPath, false).then((url) => {
      if (url) {
        link.href = url;
        link.download = p.csvName || "review.csv";
        link.innerHTML = `📄 <span>${escapeHtml(p.csvName || "review.csv")}</span>`;
      } else {
        link.innerHTML = `📄 取得失敗`;
      }
    });
  } else {
    link.style.display = "none";
    none.style.display = "inline";
  }
}

// ---------- セクション描画 ----------
function renderSections(p) {
  const wrap = $("editor-sections");
  wrap.innerHTML = p.sections.map((sec) => {
    const imagesHtml = (sec.images || []).map((path, i) => `
      <div class="sec-img-item">
        <img data-load-path="${escapeHtml(path)}" alt="" />
        <button class="sec-img-remove" data-sec="${escapeHtml(sec.key)}" data-idx="${i}" title="削除">×</button>
      </div>
    `).join("");
    const textsHtml = (sec.texts || []).map((t, i) => `
      <div class="sec-text-item">
        <textarea class="sec-text-area" data-sec="${escapeHtml(sec.key)}" data-idx="${i}" rows="3" placeholder="テキストを入力…">${escapeHtml(t)}</textarea>
        <button class="sec-text-remove" data-sec="${escapeHtml(sec.key)}" data-idx="${i}" title="このテキストを削除">×</button>
      </div>
    `).join("");
    return `
    <div class="editor-section" data-sec="${escapeHtml(sec.key)}">
      <div class="editor-section-head">
        <h3 class="editor-section-title">${escapeHtml(sec.label)}</h3>
        <div class="editor-section-actions">
          <button class="sec-add-text" data-sec="${escapeHtml(sec.key)}">+ テキスト</button>
          <button class="sec-add-img" data-sec="${escapeHtml(sec.key)}">+ 画像</button>
          <input type="file" class="sec-img-input" data-sec="${escapeHtml(sec.key)}" accept="image/*" multiple hidden />
        </div>
      </div>
      <div class="sec-images">${imagesHtml || '<span class="sec-empty">画像なし</span>'}</div>
      <div class="sec-texts">${textsHtml || '<span class="sec-empty">テキストなし</span>'}</div>
    </div>`;
  }).join("");

  // 画像読み込み
  wrap.querySelectorAll("img[data-load-path]").forEach((img) => {
    loadImageInto(img, img.dataset.loadPath);
    img.addEventListener("click", () => openLightbox(img.src));
  });

  // テキスト追加
  wrap.querySelectorAll(".sec-add-text").forEach((btn) => {
    btn.addEventListener("click", () => addSectionText(btn.dataset.sec));
  });
  // 画像追加(ファイル選択を開く)
  wrap.querySelectorAll(".sec-add-img").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = wrap.querySelector(`.sec-img-input[data-sec="${CSS.escape(btn.dataset.sec)}"]`);
      if (input) input.click();
    });
  });
  wrap.querySelectorAll(".sec-img-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      addSectionImages(input.dataset.sec, e.target.files);
      e.target.value = "";
    });
  });
  // 画像削除
  wrap.querySelectorAll(".sec-img-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeSectionImage(btn.dataset.sec, parseInt(btn.dataset.idx)));
  });
  // テキスト削除
  wrap.querySelectorAll(".sec-text-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeSectionText(btn.dataset.sec, parseInt(btn.dataset.idx)));
  });
  // テキスト編集(フォーカスを外したら保存)
  wrap.querySelectorAll(".sec-text-area").forEach((ta) => {
    ta.addEventListener("blur", () => commitSectionText(ta.dataset.sec, parseInt(ta.dataset.idx), ta.value));
  });
}

function getSection(p, key) {
  return (p.sections || []).find((s) => s.key === key);
}

// テキスト追加(空のテキストを足してすぐ編集できるように)
async function addSectionText(key) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return;
  const sec = getSection(p, key);
  if (!sec) return;
  sec.texts.push("");
  renderSections(p);
  // 追加したテキストエリアにフォーカス
  setTimeout(() => {
    const areas = document.querySelectorAll(`.sec-text-area[data-sec="${CSS.escape(key)}"]`);
    if (areas.length) areas[areas.length - 1].focus();
  }, 30);
}

// テキスト確定(blur時) - 内容が変わっていたら保存
async function commitSectionText(key, idx, value) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return;
  const sec = getSection(p, key);
  if (!sec || sec.texts[idx] === undefined) return;
  const newVal = value.trim();
  if (sec.texts[idx] === newVal) return; // 変化なし
  sec.texts[idx] = newVal;
  try {
    await saveData(`Update text in ${sec.label}: ${p.name}`, mergeCurrentProduct(p));
  } catch (err) {
    alert("保存失敗: " + err.message);
  }
}

async function removeSectionText(key, idx) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return;
  const sec = getSection(p, key);
  if (!sec) return;
  if (!confirm("このテキストを削除しますか?")) return;
  sec.texts.splice(idx, 1);
  try {
    await saveData(`Remove text in ${sec.label}: ${p.name}`, mergeCurrentProduct(p));
    renderSections(p);
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

// 画像追加(複数可)
async function addSectionImages(key, files) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return;
  const sec = getSection(p, key);
  if (!sec) return;

  const imgs = [...files].filter((f) => f.type.startsWith("image/"));
  if (imgs.length === 0) return;

  setHeadStatus(`画像をアップロード中… (0/${imgs.length})`);
  try {
    for (let i = 0; i < imgs.length; i++) {
      const file = imgs[i];
      if (file.size > 50 * 1024 * 1024) {
        alert(`${file.name} は大きすぎます(50MB超)。スキップします。`);
        continue;
      }
      setHeadStatus(`画像をアップロード中… (${i + 1}/${imgs.length})`);
      const base64 = await fileToBase64(file);
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${IMAGES_DIR}/${p.id}-${key}-${Date.now()}-${i + 1}.${ext}`;
      await uploadFile(path, base64, `Add image to ${sec.label}: ${p.id}`);
      sec.images.push(path);
    }
    await saveData(`Add images to ${sec.label}: ${p.name}`, mergeCurrentProduct(p));
    setHeadStatus("✓ 追加しました", "ok");
    renderSections(p);
    setTimeout(() => setHeadStatus(""), 1200);
  } catch (err) {
    setHeadStatus("✗ " + err.message, "err");
  }
}

async function removeSectionImage(key, idx) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return;
  const sec = getSection(p, key);
  if (!sec || !sec.images[idx]) return;
  if (!confirm("この画像を削除しますか?")) return;
  const path = sec.images[idx];
  try {
    try { await deleteFile(path, null, `Remove image from ${sec.label}: ${p.id}`); }
    catch (e) { console.warn("画像削除失敗(続行):", e); }
    sec.images.splice(idx, 1);
    await saveData(`Remove image from ${sec.label}: ${p.name}`, mergeCurrentProduct(p));
    renderSections(p);
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

// ---------- 商品情報インライン編集 ----------
function setHeadStatus(msg, kind) {
  const el = $("editor-head-status");
  el.textContent = msg;
  el.className = "save-status" + (kind ? " " + kind : "");
}

// 商品名・日付の確定(blur時)
async function commitProductField(field, value) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return;
  const v = value.trim();
  if (field === "name") {
    if (!v) { alert("商品名は空にできません"); $("edit-product-name").value = p.name; return; }
    if (p.name === v) return;
    p.name = v;
  } else if (field === "startDate") {
    if (p.startDate === v) return;
    p.startDate = v;
  }
  try {
    setHeadStatus("保存中…");
    await saveData(`Update product field: ${p.name}`, mergeCurrentProduct(p));
    setHeadStatus("✓ 保存しました", "ok");
    setTimeout(() => setHeadStatus(""), 1000);
    render(); // 一覧のカードにも反映
  } catch (err) {
    setHeadStatus("✗ " + err.message, "err");
  }
}

// 商品画像の差し替え
async function changeProductImage(file) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p || !file || !file.type.startsWith("image/")) return;
  if (file.size > 50 * 1024 * 1024) { alert("画像が大きすぎます(50MB超)。"); return; }
  try {
    setHeadStatus("画像をアップロード中…");
    const base64 = await fileToBase64(file);
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const newPath = `${IMAGES_DIR}/${p.id}-main-${Date.now()}.${ext}`;
    await uploadFile(newPath, base64, `Change product image: ${p.id}`);
    // 古い画像を削除(あれば)
    if (p.image) {
      try { await deleteFile(p.image, null, `Delete old image: ${p.id}`); }
      catch (e) { console.warn("旧画像削除失敗(続行):", e); }
    }
    blobCache.delete(p.image);
    p.image = newPath;
    await saveData(`Change product image: ${p.name}`, mergeCurrentProduct(p));
    // 表示更新
    $("detail-img").style.display = "";
    $("detail-noimg").style.display = "none";
    $("detail-img").src = "";
    loadImageInto($("detail-img"), p.image);
    setHeadStatus("✓ 画像を更新しました", "ok");
    setTimeout(() => setHeadStatus(""), 1200);
    render();
  } catch (err) {
    setHeadStatus("✗ " + err.message, "err");
  }
}

// CSVの差し替え/設定
async function changeProductCsv(file) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p || !file) return;
  const name = file.name.toLowerCase();
  if (!name.endsWith(".csv") && file.type !== "text/csv") { alert("CSVファイルを選んでください"); return; }
  if (file.size > 25 * 1024 * 1024) { alert("CSVが大きすぎます(25MB超)。"); return; }
  try {
    setHeadStatus("CSVをアップロード中…");
    const base64 = await fileToBase64(file);
    const safeName = file.name.replace(/[^\w.\-]/g, "_");
    const newPath = `${CSV_DIR}/${p.id}-${safeName}`;
    await uploadFile(newPath, base64, `Change csv: ${p.id}`);
    if (p.csvPath && p.csvPath !== newPath) {
      try { await deleteFile(p.csvPath, null, `Delete old csv: ${p.id}`); }
      catch (e) { console.warn("旧CSV削除失敗(続行):", e); }
    }
    blobCache.delete(p.csvPath);
    p.csvPath = newPath;
    p.csvName = file.name;
    await saveData(`Change csv: ${p.name}`, mergeCurrentProduct(p));
    refreshCsvRow(p);
    setHeadStatus("✓ CSVを更新しました", "ok");
    setTimeout(() => setHeadStatus(""), 1200);
    render();
  } catch (err) {
    setHeadStatus("✗ " + err.message, "err");
  }
}

// 現在の商品を最新データにマージする関数を返す(競合対策)
function mergeCurrentProduct(p) {
  return (latest) => latest.map((x) => x.id === p.id ? p : x);
}

// File → base64(content部分のみ)
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- ライトボックス(画像拡大) ----------
function openLightbox(src) {
  if (!src) return;
  $("lightbox-img").src = src;
  $("lightbox").style.display = "flex";
}

async function deleteProduct() {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return;
  if (!confirm(`商品「${p.name}」を削除しますか?\n(画像・CSVファイルも削除されます)`)) return;
  try {
    if (p.image) {
      try { await deleteFile(p.image, null, `Delete image: ${p.id}`); }
      catch (e) { console.warn("画像削除失敗(続行):", e); }
    }
    if (p.csvPath) {
      try { await deleteFile(p.csvPath, null, `Delete csv: ${p.id}`); }
      catch (e) { console.warn("CSV削除失敗(続行):", e); }
    }
    // セクション内の全画像も削除
    for (const sec of (p.sections || [])) {
      for (const path of (sec.images || [])) {
        try { await deleteFile(path, null, `Delete section image: ${p.id}`); }
        catch (e) { console.warn("セクション画像削除失敗(続行):", e); }
      }
    }
    products = products.filter((x) => x.id !== p.id);
    await saveData(`Delete product: ${p.name}`, (latest) => latest.filter((x) => x.id !== p.id));
    $("detail-modal").style.display = "none";
    render();
  } catch (err) {
    alert("削除に失敗しました: " + err.message);
  }
}

// ---------- 追加(商品登録) ----------
function resetAddForm() {
  pendingImage = null;
  pendingCsv = null;
  $("preview-wrap").style.display = "none";
  $("dropzone").style.display = "block";
  $("file-input").value = "";
  $("input-start-date").value = todayShort();
  $("input-product-name").value = "";
  $("csv-file-input").value = "";
  $("csv-preview").style.display = "none";
  $("csv-filename").textContent = "";
  $("save-status").textContent = "";
  $("save-status").className = "save-status";
}

function handleImageFile(file) {
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

function handleCsvFile(file) {
  if (!file) return;
  const name = file.name.toLowerCase();
  if (!name.endsWith(".csv") && file.type !== "text/csv") {
    alert("CSVファイルを選んでください");
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    alert("CSVが大きすぎます(25MB超)。");
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    const base64 = dataUrl.split(",")[1];
    pendingCsv = { base64, fileName: file.name };
    $("csv-filename").textContent = file.name;
    $("csv-preview").style.display = "flex";
  };
  reader.readAsDataURL(file);
}

async function saveProduct() {
  const startDate = $("input-start-date").value.trim();
  const name = $("input-product-name").value.trim();
  if (!startDate) { alert("スタート日付を入力してください"); return; }
  if (!name) { alert("商品名を入力してください"); return; }

  const btn = $("btn-save");
  btn.disabled = true;
  $("save-status").textContent = "保存中…";
  $("save-status").className = "save-status";

  try {
    const id = genId();
    let imgPath = undefined;
    if (pendingImage) {
      $("save-status").textContent = "画像をアップロード中…";
      imgPath = `${IMAGES_DIR}/${id}.${pendingImage.ext}`;
      await uploadFile(imgPath, pendingImage.base64, `Add product image: ${id}`);
    }

    let csvPath = undefined;
    let csvName = undefined;
    if (pendingCsv) {
      $("save-status").textContent = "CSVをアップロード中…";
      const safeName = pendingCsv.fileName.replace(/[^\w.\-]/g, "_");
      csvPath = `${CSV_DIR}/${id}-${safeName}`;
      csvName = pendingCsv.fileName;
      await uploadFile(csvPath, pendingCsv.base64, `Add product csv: ${id}`);
    }

    $("save-status").textContent = "メタデータを保存中…";
    const product = {
      id,
      name,
      startDate,
      image: imgPath,
      csvPath,
      csvName,
      createdAt: new Date().toISOString()
    };

    products.unshift(product);
    await saveData(`Add product: ${name}`, (latest) => [product, ...latest.filter((p) => p.id !== id)]);

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
    closeAllModals();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("btn-add").addEventListener("click", () => {
    resetAddForm();
    $("add-modal").style.display = "flex";
    setTimeout(() => $("input-product-name").focus(), 50);
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
    handleImageFile(e.dataTransfer.files[0]);
  });
  $("file-input").addEventListener("change", (e) => handleImageFile(e.target.files[0]));
  $("preview-clear").addEventListener("click", () => {
    pendingImage = null;
    $("preview-wrap").style.display = "none";
    $("dropzone").style.display = "block";
    $("file-input").value = "";
  });

  const csvDz = $("csv-dropzone");
  csvDz.addEventListener("click", () => $("csv-file-input").click());
  csvDz.addEventListener("dragover", (e) => { e.preventDefault(); csvDz.classList.add("drag"); });
  csvDz.addEventListener("dragleave", () => csvDz.classList.remove("drag"));
  csvDz.addEventListener("drop", (e) => {
    e.preventDefault();
    csvDz.classList.remove("drag");
    handleCsvFile(e.dataTransfer.files[0]);
  });
  $("csv-file-input").addEventListener("change", (e) => {
    handleCsvFile(e.target.files[0]);
    e.target.value = "";
  });
  $("csv-clear").addEventListener("click", () => {
    pendingCsv = null;
    $("csv-preview").style.display = "none";
    $("csv-filename").textContent = "";
    $("csv-file-input").value = "";
  });

  $("btn-save").addEventListener("click", saveProduct);
  $("btn-delete").addEventListener("click", deleteProduct);

  // 商品情報インライン編集(blurで保存)
  $("edit-product-name").addEventListener("blur", (e) => commitProductField("name", e.target.value));
  $("edit-start-date").addEventListener("blur", (e) => commitProductField("startDate", e.target.value));
  $("edit-product-name").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  $("edit-start-date").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });

  // 商品画像の差し替え
  $("editor-img-change").addEventListener("click", () => $("editor-img-input").click());
  $("editor-img-input").addEventListener("change", (e) => {
    if (e.target.files[0]) changeProductImage(e.target.files[0]);
    e.target.value = "";
  });

  // CSVの設定/差し替え
  $("editor-csv-change").addEventListener("click", () => $("editor-csv-input").click());
  $("editor-csv-input").addEventListener("change", (e) => {
    if (e.target.files[0]) changeProductCsv(e.target.files[0]);
    e.target.value = "";
  });

  // ライトボックス(背景クリックで閉じる)
  $("lightbox").addEventListener("click", () => { $("lightbox").style.display = "none"; });

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
