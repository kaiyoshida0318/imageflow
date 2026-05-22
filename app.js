/* ==============================================================
   ImageFlow — Frontend app (v1.1.0)
   商品レコード中心の構成。GitHub REST API で data.json と
   images/ , csv/ を直接 commit する。
   ============================================================== */

const STORAGE_KEY = "imageFlow.auth.v1";
const DATA_PATH = "data.json";
const IMAGES_DIR = "images";
const CSV_DIR = "csv";

// 初期デフォルト項目(初めて使うとき / 定義が空のとき)
const DEFAULT_SECTIONS = [
  { key: "top", label: "TOP画像" },
  { key: "analysis", label: "分析" }
];

// 商品の特定項目のデータ {texts, images} を取得(無ければ作る)
function getSectionData(p, key) {
  if (!p.sectionData) p.sectionData = {};
  if (!p.sectionData[key]) p.sectionData[key] = { texts: [], images: [] };
  const sd = p.sectionData[key];
  if (!Array.isArray(sd.texts)) sd.texts = [];
  if (!Array.isArray(sd.images)) sd.images = [];
  return sd;
}

let auth = null;
let dataSha = null;
let products = [];
let sectionDefs = [];   // 全商品共通の項目定義 [{key, label}]
let currentDetailId = null;
let viewMode = "card";  // "card" or "gallery"(画像一覧)

// 保存の直列化用(同時に複数のsaveDataが走るとGitHubが409を返し続けるため)
let saveChain = Promise.resolve();
let manualSaving = false; // 手動保存ボタン処理中はblur自動保存をスキップ

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
    sectionDefs = Array.isArray(json.sectionDefs) ? json.sectionDefs : [];
    // 項目定義が無ければデフォルトで初期化
    if (sectionDefs.length === 0) {
      sectionDefs = DEFAULT_SECTIONS.map((s) => ({ key: s.key, label: s.label }));
    }
    // 旧形式(商品ごとのsections配列)から新形式(sectionData)へ移行
    migrateProducts();
  } catch (e) {
    console.error("data.json 解析失敗", e);
    products = [];
    sectionDefs = DEFAULT_SECTIONS.map((s) => ({ key: s.key, label: s.label }));
  }
}

// 旧 product.sections [{key,label,texts,images}] を
// 新 product.sectionData {key: {texts, images}} に移行
function migrateProducts() {
  products.forEach((p) => {
    if (!p.sectionData) p.sectionData = {};
    // 旧形式があれば取り込む
    if (Array.isArray(p.sections)) {
      p.sections.forEach((s) => {
        if (!p.sectionData[s.key]) {
          p.sectionData[s.key] = { texts: s.texts || [], images: s.images || [] };
        }
        // 定義に無いキーで中身があれば、定義にも追加(失わないため)
        if (((s.texts && s.texts.length) || (s.images && s.images.length)) &&
            !sectionDefs.some((d) => d.key === s.key)) {
          sectionDefs.push({ key: s.key, label: s.label || s.key });
        }
      });
      delete p.sections; // 旧形式は破棄
    }
  });
}

// 外向きのsaveData: 直前の保存の完了を待ってから実行(直列化)
function saveData(commitMessage, mergeFn) {
  const run = () => _saveDataImpl(commitMessage, mergeFn);
  // 前の保存が成功/失敗どちらでも、次の保存は必ず走らせる
  saveChain = saveChain.then(run, run);
  return saveChain;
}

async function _saveDataImpl(commitMessage, mergeFn) {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const body = {
      message: commitMessage,
      content: b64encode(JSON.stringify({ products, sectionDefs }, null, 2)),
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
      // GitHub側の反映ラグを吸収するため少し待つ(回数に応じて伸ばす)
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
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
// 商品の全画像パスを集める(商品画像 + 各項目の画像)
function collectAllImages(p) {
  const imgs = [];
  if (p.image) imgs.push(p.image);
  if (p.sectionData) {
    for (const def of sectionDefs) {
      const sd = p.sectionData[def.key];
      if (sd && sd.images) imgs.push(...sd.images);
    }
    // 定義に無い項目の画像も拾う(念のため)
    const defKeys = new Set(sectionDefs.map((d) => d.key));
    for (const key of Object.keys(p.sectionData)) {
      if (!defKeys.has(key) && p.sectionData[key].images) {
        imgs.push(...p.sectionData[key].images);
      }
    }
  }
  return imgs;
}

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

  if (viewMode === "gallery") {
    renderGalleryView();
  } else {
    renderCardView();
  }
}

// カード表示(従来)
function renderCardView() {
  const gallery = $("gallery");
  gallery.className = "gallery";
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

// 画像一覧表示(1商品=横一列で全画像)
function renderGalleryView() {
  const gallery = $("gallery");
  gallery.className = "gallery-rows";
  const sorted = products.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  gallery.innerHTML = sorted.map((p) => {
    const imgs = collectAllImages(p);
    const thumbsHtml = imgs.length
      ? imgs.map((path) => `<img class="row-thumb" data-load-path="${escapeHtml(path)}" alt="" loading="lazy" />`).join("")
      : '<span class="row-noimg">画像なし</span>';
    return `
    <div class="gallery-row" data-id="${escapeHtml(p.id)}">
      <div class="row-info">
        <div class="row-start-date">${escapeHtml(p.startDate || "—")}</div>
        <div class="row-name">${escapeHtml(p.name || "無題")}</div>
        <button class="row-open-btn" data-id="${escapeHtml(p.id)}">編集 ›</button>
      </div>
      <div class="row-thumbs">${thumbsHtml}</div>
    </div>`;
  }).join("");

  // サムネ読み込み + クリックで拡大
  gallery.querySelectorAll(".row-thumb[data-load-path]").forEach((img) => {
    loadImageInto(img, img.dataset.loadPath);
    img.addEventListener("click", () => openLightbox(img.src));
  });
  // 「編集」ボタンで編集ページへ
  gallery.querySelectorAll(".row-open-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail(btn.dataset.id);
    });
  });
}

// 表示モード切り替え
function toggleViewMode() {
  viewMode = viewMode === "card" ? "gallery" : "card";
  const btn = $("btn-view-toggle");
  btn.textContent = viewMode === "gallery" ? "🔲 カード表示" : "🖼️ 画像一覧";
  render();
}

// ---------- 商品詳細 ----------
function closeAllModals() {
  ["add-modal", "detail-modal", "section-mgr-modal", "text-fullscreen", "lightbox"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}

function openDetail(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  closeAllModals();
  currentDetailId = id;

  // モーダルは先に開く(途中でエラーが出ても開いた状態は保つ)
  $("detail-modal").style.display = "flex";

  try {
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
    const hs = $("editor-head-status");
    if (hs) { hs.textContent = ""; hs.className = "save-status"; }

    // CSV
    refreshCsvRow(p);

    // セクション描画
    renderSections(p);
  } catch (err) {
    console.error("openDetailでエラー(モーダルは開いたまま継続):", err);
  }
}

// CSV行の表示更新
function refreshCsvRow(p) {
  const link = $("detail-csv-link");
  const none = $("editor-csv-none");
  const nameEl = $("detail-csv-name");
  if (!link || !none) return; // 要素が無ければ何もしない(安全策)
  if (p.csvPath) {
    none.style.display = "none";
    link.style.display = "inline-flex";
    if (nameEl) nameEl.textContent = "読み込み中…";
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
  if (!p.sectionData) p.sectionData = {};
  wrap.innerHTML = sectionDefs.map((def) => {
    const sec = getSectionData(p, def.key);
    const imagesHtml = (sec.images || []).map((path, i) => `
      <div class="sec-img-item">
        <img data-load-path="${escapeHtml(path)}" alt="" />
        <button class="sec-img-remove" data-sec="${escapeHtml(def.key)}" data-idx="${i}" title="削除">×</button>
      </div>
    `).join("");
    const textsHtml = (sec.texts || []).map((t, i) => `
      <div class="sec-text-item">
        <textarea class="sec-text-area" data-sec="${escapeHtml(def.key)}" data-idx="${i}" rows="3" placeholder="テキストを入力…">${escapeHtml(t)}</textarea>
        <div class="sec-text-btns">
          <button class="sec-text-expand" data-sec="${escapeHtml(def.key)}" data-idx="${i}" title="拡大/縮小">⤢</button>
          <button class="sec-text-remove" data-sec="${escapeHtml(def.key)}" data-idx="${i}" title="このテキストを削除">×</button>
        </div>
      </div>
    `).join("");
    return `
    <div class="editor-section" data-sec="${escapeHtml(def.key)}">
      <div class="editor-section-head">
        <h3 class="editor-section-title">${escapeHtml(def.label)}</h3>
        <div class="editor-section-actions">
          <button class="sec-add-text" data-sec="${escapeHtml(def.key)}">+ テキスト</button>
          <button class="sec-add-img" data-sec="${escapeHtml(def.key)}">+ 画像</button>
          <input type="file" class="sec-img-input" data-sec="${escapeHtml(def.key)}" accept="image/*" multiple hidden />
        </div>
      </div>
      ${(() => {
        const effectiveQ = (sec.question !== undefined && sec.question !== null && sec.question !== "")
          ? sec.question
          : (def.question || "");
        return `
      <div class="sec-question-wrap" data-sec="${escapeHtml(def.key)}">
        ${effectiveQ
          ? `<div class="sec-question" data-sec="${escapeHtml(def.key)}" title="クリックでこの商品の質問文を編集">💬 ${escapeHtml(effectiveQ)} <span class="sec-question-edit">✎</span></div>`
          : `<div class="sec-question sec-question-empty" data-sec="${escapeHtml(def.key)}" title="クリックでこの商品の質問文を追加">＋ 質問文を追加</div>`}
      </div>`;
      })()}
      <div class="sec-images" data-sec="${escapeHtml(def.key)}">
        ${imagesHtml}
        <div class="sec-dropzone" data-sec="${escapeHtml(def.key)}">
          <span class="sec-dropzone-icon">⇪</span>
          <span class="sec-dropzone-text">ここに画像をドラッグ&ドロップ</span>
        </div>
      </div>
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
  // 画像ドロップゾーン(ドラッグ&ドロップで追加、クリックでもファイル選択)
  wrap.querySelectorAll(".sec-dropzone").forEach((dz) => {
    const key = dz.dataset.sec;
    dz.addEventListener("click", () => {
      const input = wrap.querySelector(`.sec-img-input[data-sec="${CSS.escape(key)}"]`);
      if (input) input.click();
    });
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("drag");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        addSectionImages(key, e.dataTransfer.files);
      }
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
  // テキスト全画面エディタを開く
  wrap.querySelectorAll(".sec-text-expand").forEach((btn) => {
    btn.addEventListener("click", () => {
      openTextFullscreen(btn.dataset.sec, parseInt(btn.dataset.idx));
    });
  });
  // 質問文クリックで編集(全商品に反映)
  wrap.querySelectorAll(".sec-question").forEach((el) => {
    el.addEventListener("click", () => editSectionQuestionInline(el.dataset.sec));
  });
}

// 商品ページ上で質問文をインライン編集(この商品だけに保存)
function editSectionQuestionInline(key) {
  const p = getCurrentProduct();
  if (!p) return;
  const def = sectionDefs.find((d) => d.key === key);
  const sec = getSectionData(p, key);
  const wrap = document.querySelector(`.sec-question-wrap[data-sec="${CSS.escape(key)}"]`);
  if (!wrap) return;
  // 現在この商品で効いている質問文(個別 > デフォルト)
  const currentQ = (sec.question !== undefined && sec.question !== null && sec.question !== "")
    ? sec.question
    : (def && def.question ? def.question : "");
  const placeholder = (def && def.question) ? `デフォルト: ${def.question}` : "例: この商品の強み・弱みは？";
  wrap.innerHTML = `
    <textarea class="sec-question-input" rows="2" placeholder="${escapeHtml(placeholder)}">${escapeHtml(currentQ)}</textarea>
    <div class="sec-question-btns">
      <button class="sec-q-save">💾 保存(この商品のみ)</button>
      <button class="sec-q-cancel">キャンセル</button>
      ${(sec.question !== undefined && sec.question !== null && sec.question !== "") ? '<button class="sec-q-reset">雛形に戻す</button>' : ''}
    </div>
  `;
  const input = wrap.querySelector(".sec-question-input");
  input.focus();
  const save = async (resetToDefault) => {
    const newQ = resetToDefault ? "" : input.value.trim();
    try {
      if (resetToDefault || newQ === "") {
        // 個別質問文を消す(デフォルト雛形に戻る)
        delete sec.question;
      } else {
        sec.question = newQ;
      }
      await saveData(`Edit product question: ${p.name}`, mergeCurrentProduct(p));
      renderSections(p);
    } catch (err) {
      alert("保存失敗: " + err.message);
      renderSections(p);
    }
  };
  wrap.querySelector(".sec-q-save").addEventListener("click", () => save(false));
  wrap.querySelector(".sec-q-cancel").addEventListener("click", () => renderSections(p));
  const resetBtn = wrap.querySelector(".sec-q-reset");
  if (resetBtn) resetBtn.addEventListener("click", () => save(true));
}

function getCurrentProduct() {
  return products.find((x) => x.id === currentDetailId);
}

// ---------- 全画面テキストエディタ ----------
let fsEditing = null; // { key, idx }

function openTextFullscreen(key, idx) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return;
  const sec = getSection(p, key);
  if (!sec || sec.texts[idx] === undefined) return;
  fsEditing = { key, idx };
  // 項目名をタイトルに
  const def = sectionDefs.find((d) => d.key === key);
  $("text-fullscreen-title").textContent = def ? def.label : "テキスト";
  const area = $("text-fullscreen-area");
  area.value = sec.texts[idx];
  $("text-fullscreen").style.display = "flex";
  setTimeout(() => {
    area.focus();
    // カーソルとスクロールを先頭に戻す(文末に飛ばないように)
    area.setSelectionRange(0, 0);
    area.scrollTop = 0;
  }, 30);
}

async function closeTextFullscreen() {
  if (!fsEditing) { $("text-fullscreen").style.display = "none"; return; }
  const p = products.find((x) => x.id === currentDetailId);
  const { key, idx } = fsEditing;
  const newVal = $("text-fullscreen-area").value.trim();
  $("text-fullscreen").style.display = "none";
  fsEditing = null;
  if (!p) return;
  const sec = getSection(p, key);
  if (!sec || sec.texts[idx] === undefined) return;
  if (sec.texts[idx] === newVal) { renderSections(p); return; }
  sec.texts[idx] = newVal;
  try {
    await saveData(`Update text (fullscreen): ${p.name}`, mergeCurrentProduct(p));
  } catch (err) {
    alert("保存失敗: " + err.message);
  }
  renderSections(p);
}

function getSection(p, key) {
  return getSectionData(p, key);
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
  if (manualSaving) return; // 手動保存ボタン処理中は二重保存を避ける
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

// ---------- 手動保存(右上の保存ボタン) ----------
async function saveAllCurrent(forClose) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return;
  manualSaving = true;
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  const name = $("edit-product-name").value.trim();
  const startDate = $("edit-start-date").value.trim();
  if (!name) { alert("商品名は空にできません"); manualSaving = false; return; }
  p.name = name;
  p.startDate = startDate;
  document.querySelectorAll(".sec-text-area").forEach((ta) => {
    const sec = getSection(p, ta.dataset.sec);
    const idx = parseInt(ta.dataset.idx);
    if (sec && sec.texts[idx] !== undefined) {
      sec.texts[idx] = ta.value.trim();
    }
  });
  try {
    await saveData(`Save product: ${p.name}`, mergeCurrentProduct(p));
    render();
  } catch (err) {
    if (!forClose) alert("保存失敗: " + err.message);
    else console.error("保存失敗:", err);
  } finally {
    manualSaving = false;
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
  if (manualSaving) return;
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

// ---------- 項目管理 ----------
function openSectionManager() {
  closeAllModals();
  $("section-mgr-new-name").value = "";
  renderSectionManager();
  $("section-mgr-modal").style.display = "flex";
  setTimeout(() => $("section-mgr-new-name").focus(), 50);
}

function renderSectionManager() {
  const list = $("section-mgr-list");
  if (sectionDefs.length === 0) {
    list.innerHTML = '<div class="tag-mgr-empty">項目がまだありません。上から追加してください。</div>';
    return;
  }
  // 各項目が何商品で中身を持っているか集計
  const usage = {};
  products.forEach((p) => {
    if (!p.sectionData) return;
    Object.keys(p.sectionData).forEach((k) => {
      const sd = p.sectionData[k];
      if ((sd.texts && sd.texts.length) || (sd.images && sd.images.length)) {
        usage[k] = (usage[k] || 0) + 1;
      }
    });
  });

  list.innerHTML = sectionDefs.map((def, i) => `
    <div class="tag-mgr-item section-mgr-item" data-key="${escapeHtml(def.key)}">
      <div class="section-mgr-main">
        <span class="tag-mgr-item-name">${escapeHtml(def.label)}</span>
        <span class="tag-mgr-item-count">${usage[def.key] || 0} 商品で使用</span>
        ${i > 0 ? `<button class="tag-mgr-btn" data-action="up" data-key="${escapeHtml(def.key)}" title="上へ">▲</button>` : '<span style="width:30px"></span>'}
        ${i < sectionDefs.length - 1 ? `<button class="tag-mgr-btn" data-action="down" data-key="${escapeHtml(def.key)}" title="下へ">▼</button>` : '<span style="width:30px"></span>'}
        <button class="tag-mgr-btn" data-action="question" data-key="${escapeHtml(def.key)}">雛形編集</button>
        <button class="tag-mgr-btn" data-action="rename" data-key="${escapeHtml(def.key)}">名前変更</button>
        <button class="tag-mgr-btn danger" data-action="delete" data-key="${escapeHtml(def.key)}">削除</button>
      </div>
      <div class="section-mgr-question">${def.question ? '💬 (雛形) ' + escapeHtml(def.question) : '<span class="section-mgr-noq">雛形なし</span>'}</div>
    </div>
  `).join("");

  list.querySelectorAll(".tag-mgr-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const action = btn.dataset.action;
      if (action === "up") moveSectionDef(key, -1);
      else if (action === "down") moveSectionDef(key, 1);
      else if (action === "rename") startRenameSectionDef(key);
      else if (action === "question") startEditQuestion(key);
      else if (action === "delete") deleteSectionDef(key);
    });
  });
}

// 質問文の編集
function startEditQuestion(key) {
  const def = sectionDefs.find((d) => d.key === key);
  if (!def) return;
  const item = document.querySelector(`#section-mgr-list .section-mgr-item[data-key="${CSS.escape(key)}"] .section-mgr-question`);
  if (!item) return;
  const oldQ = def.question || "";
  item.innerHTML = `
    <textarea class="section-mgr-q-input" rows="2" placeholder="例: この商品の強み・弱みは？競合との違いは？">${escapeHtml(oldQ)}</textarea>
    <div class="section-mgr-q-btns">
      <button class="tag-mgr-btn" data-action="q-confirm">💾 保存</button>
      <button class="tag-mgr-btn" data-action="q-cancel">キャンセル</button>
    </div>
  `;
  const input = item.querySelector(".section-mgr-q-input");
  input.focus();
  const confirm = async () => {
    const newQ = input.value.trim();
    if (newQ === oldQ) { renderSectionManager(); return; }
    try {
      def.question = newQ || undefined;
      await saveData(`Edit question: ${def.label}`);
      renderSectionManager();
    } catch (err) {
      alert("保存失敗: " + err.message);
      def.question = oldQ || undefined;
      renderSectionManager();
    }
  };
  item.querySelector('[data-action="q-confirm"]').addEventListener("click", confirm);
  item.querySelector('[data-action="q-cancel"]').addEventListener("click", renderSectionManager);
}

async function moveSectionDef(key, delta) {
  const idx = sectionDefs.findIndex((d) => d.key === key);
  if (idx === -1) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= sectionDefs.length) return;
  const [item] = sectionDefs.splice(idx, 1);
  sectionDefs.splice(newIdx, 0, item);
  try {
    await saveData(`Reorder section: ${item.label}`);
    renderSectionManager();
  } catch (err) {
    alert("並び替え失敗: " + err.message);
  }
}

function startRenameSectionDef(key) {
  const def = sectionDefs.find((d) => d.key === key);
  if (!def) return;
  const item = document.querySelector(`#section-mgr-list .tag-mgr-item[data-key="${CSS.escape(key)}"]`);
  if (!item) return;
  const oldLabel = def.label;
  item.innerHTML = `
    <input class="tag-mgr-edit-input" type="text" value="${escapeHtml(oldLabel)}" />
    <button class="tag-mgr-btn" data-action="confirm">OK</button>
    <button class="tag-mgr-btn" data-action="cancel">キャンセル</button>
  `;
  const input = item.querySelector(".tag-mgr-edit-input");
  input.focus();
  input.select();
  const confirm = async () => {
    const newLabel = input.value.trim();
    if (!newLabel) { alert("名前を入力してください"); return; }
    if (newLabel === oldLabel) { renderSectionManager(); return; }
    try {
      def.label = newLabel;
      await saveData(`Rename section: ${oldLabel} -> ${newLabel}`);
      renderSectionManager();
    } catch (err) {
      alert("変更失敗: " + err.message);
      def.label = oldLabel;
      renderSectionManager();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    else if (e.key === "Escape") { e.preventDefault(); renderSectionManager(); }
  });
  item.querySelector('[data-action="confirm"]').addEventListener("click", confirm);
  item.querySelector('[data-action="cancel"]').addEventListener("click", renderSectionManager);
}

async function deleteSectionDef(key) {
  const def = sectionDefs.find((d) => d.key === key);
  if (!def) return;
  // 中身を持つ商品数を数える
  let count = 0;
  products.forEach((p) => {
    const sd = p.sectionData && p.sectionData[key];
    if (sd && ((sd.texts && sd.texts.length) || (sd.images && sd.images.length))) count++;
  });
  const msg = count > 0
    ? `項目「${def.label}」を削除しますか?\n${count}商品にこの項目の中身があり、テキスト・画像も削除されます。`
    : `項目「${def.label}」を削除しますか?`;
  if (!confirm(msg)) return;

  try {
    // 各商品のこの項目の画像ファイルを削除
    for (const p of products) {
      const sd = p.sectionData && p.sectionData[key];
      if (sd && sd.images) {
        for (const path of sd.images) {
          try { await deleteFile(path, null, `Delete section image: ${p.id}`); }
          catch (e) { console.warn("画像削除失敗(続行):", e); }
        }
      }
      if (p.sectionData) delete p.sectionData[key];
    }
    sectionDefs = sectionDefs.filter((d) => d.key !== key);
    await saveData(`Delete section: ${def.label}`);
    renderSectionManager();
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

async function addSectionDef() {
  const label = $("section-mgr-new-name").value.trim();
  if (!label) { alert("項目名を入力してください"); return; }
  if (sectionDefs.some((d) => d.label === label)) {
    alert("同じ名前の項目が既にあります");
    return;
  }
  try {
    const key = "sec-" + genId();
    sectionDefs.push({ key, label });
    await saveData(`Add section: ${label}`);
    $("section-mgr-new-name").value = "";
    renderSectionManager();
  } catch (err) {
    alert("追加失敗: " + err.message);
  }
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
    // 全項目の画像も削除
    if (p.sectionData) {
      for (const key of Object.keys(p.sectionData)) {
        for (const path of (p.sectionData[key].images || [])) {
          try { await deleteFile(path, null, `Delete section image: ${p.id}`); }
          catch (e) { console.warn("セクション画像削除失敗(続行):", e); }
        }
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
      sectionData: {},
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
  // ×(保存): 保存してから閉じる
  $("btn-close-save").addEventListener("click", async () => {
    await saveAllCurrent(true);
    $("detail-modal").style.display = "none";
  });

  // 項目管理
  $("btn-section-mgr").addEventListener("click", openSectionManager);
  // 表示モード切り替え
  $("btn-view-toggle").addEventListener("click", toggleViewMode);
  $("section-mgr-add").addEventListener("click", addSectionDef);
  $("section-mgr-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addSectionDef(); }
  });
  // 項目管理: 保存して閉じる(質問文を編集中ならそれも保存)
  $("section-mgr-close").addEventListener("click", async () => {
    const input = document.querySelector("#section-mgr-list .section-mgr-q-input");
    if (input) {
      // 編集中の質問文を確定保存
      const item = input.closest(".section-mgr-item");
      const key = item ? item.dataset.key : null;
      const def = sectionDefs.find((d) => d.key === key);
      if (def) {
        const newQ = input.value.trim();
        if ((def.question || "") !== newQ) {
          def.question = newQ || undefined;
          try { await saveData(`Edit question: ${def.label}`); }
          catch (err) { alert("保存失敗: " + err.message); return; }
        }
      }
    }
    $("section-mgr-modal").style.display = "none";
    render();
  });

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

  // 全画面テキストエディタ: 完了ボタン
  $("text-fullscreen-close").addEventListener("click", closeTextFullscreen);
  // Escで全画面エディタを閉じる(保存して)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("text-fullscreen").style.display === "flex") {
      e.preventDefault();
      closeTextFullscreen();
    }
  });

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
