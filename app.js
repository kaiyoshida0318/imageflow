/* ==============================================================
   ImageFlow — Frontend app (v3.5.0)
   商品レコード中心の構成。GitHub REST API で data.json と
   images/ , csv/ を直接 commit する。
   v3.5.0: 編集ページ右上に3ボタン(保存 / 保存して閉じる / 保存せず閉じる)を固定。
   ============================================================== */

const STORAGE_KEY = "imageFlow.auth.v1";
const DATA_PATH = "data.json";
const IMAGES_DIR = "images";
const CSV_DIR = "csv";
const FILES_DIR = "files";

// 初期デフォルト項目(初めて使うとき / 定義が空のとき)
const DEFAULT_SECTIONS = [
  { key: "top", label: "TOP画像" },
  { key: "analysis", label: "分析" }
];

// iid から sectionItem を取得
function getItem(p, iid) {
  if (!Array.isArray(p.sectionItems)) p.sectionItems = [];
  const it = p.sectionItems.find((x) => x.iid === iid);
  if (it) ensureItemArrays(it);
  return it;
}

// item の各配列を保証し、旧 texts[] を textsTop[] へ移行する
function ensureItemArrays(it) {
  if (!Array.isArray(it.images)) it.images = [];
  if (!Array.isArray(it.files)) it.files = [];
  if (!Array.isArray(it.imagesFinal)) it.imagesFinal = [];
  if (!Array.isArray(it.filesFinal)) it.filesFinal = [];
  // 旧形式の移行(1度だけ): textsTop が未定義のときに、
  //   question(指示文) → texts(回答) の順で textsTop に統合する。
  // v3.12で廃止した question欄の中身もここで救済して表示に復活させる。
  if (!Array.isArray(it.textsTop)) {
    const merged = [];
    if (it.question !== undefined && it.question !== null && String(it.question).trim() !== "") {
      merged.push(String(it.question));
    }
    if (Array.isArray(it.texts)) {
      it.texts.forEach((t) => { if (t !== undefined && t !== null && String(t).trim() !== "") merged.push(String(t)); });
    }
    it.textsTop = merged;
  } else {
    // textsTop が既にある場合でも、未移行の question が残っていれば先頭に取り込む
    if (it.question !== undefined && it.question !== null && String(it.question).trim() !== "") {
      it.textsTop.unshift(String(it.question));
    }
  }
  delete it.question;
  delete it.texts;
  if (!Array.isArray(it.textsTop)) it.textsTop = [];
  if (!Array.isArray(it.textsBottom)) it.textsBottom = [];
  // 完成品チェック状態(v3.26): imagesFinalに存在するpathだけ保持
  if (!Array.isArray(it.imagesFinalChecked)) it.imagesFinalChecked = [];
  it.imagesFinalChecked = it.imagesFinalChecked.filter((p) => it.imagesFinal.includes(p));
}

// pos("top"/"bottom") に応じたテキスト配列名
function textArrName(pos) {
  return pos === "bottom" ? "textsBottom" : "textsTop";
}

let auth = null;
let dataSha = null;
let products = [];
let sectionDefs = [];   // 全商品共通の項目定義 [{key, label}]
let currentDetailId = null;
// v3.8.0: 表示は「画像一覧 + 縦長サムネ」固定。viewMode/galleryThumb は廃止。
// 画像一覧の表示モード(3択): "show"=素材を表示 / "hide"=素材を除外 / "checked"=チェック済み完成品のみ
let galleryViewMode = (() => {
  try {
    const v = localStorage.getItem("imageFlow.galleryViewMode");
    if (v === "show" || v === "hide" || v === "checked") return v;
    // 旧キーからの移行
    const old = localStorage.getItem("imageFlow.galleryExcludeMaterial");
    return old === "1" ? "hide" : "show";
  } catch { return "show"; }
})();

// 画像一覧の行表示: false=1行(横スクロール) / true=複数行(折り返して全体表示)
let galleryWrap = (() => {
  try { return localStorage.getItem("imageFlow.galleryWrap") === "1"; }
  catch { return false; }
})();

// 1行表示時のページング: 0始まり。15枚刻みで表示範囲を切り替える。
const GALLERY_PAGE_SIZE = 15;
let galleryPage = 0;

// 保存の直列化用(同時に複数のsaveDataが走るとGitHubが409を返し続けるため)
let saveChain = Promise.resolve();
let manualSaving = false; // 手動保存ボタン処理中はblur自動保存をスキップ

let pendingImage = null;

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

// データ移行: 旧 sections[] / sectionData{} → 新 sectionItems[]
// sectionItems: [{iid, key, texts:[], images:[], question?}] (順序保持・同じkey複数可)
function migrateProducts() {
  products.forEach((p) => {
    // さらに古い形式: p.sections[] → p.sectionData{}
    if (Array.isArray(p.sections)) {
      if (!p.sectionData) p.sectionData = {};
      p.sections.forEach((s) => {
        if (!p.sectionData[s.key]) {
          p.sectionData[s.key] = { texts: s.texts || [], images: s.images || [] };
        }
        if (((s.texts && s.texts.length) || (s.images && s.images.length)) &&
            !sectionDefs.some((d) => d.key === s.key)) {
          sectionDefs.push({ key: s.key, label: s.label || s.key });
        }
      });
      delete p.sections;
    }
    // 新形式 sectionItems が無ければ作る
    if (!Array.isArray(p.sectionItems)) {
      p.sectionItems = [];
      // sectionData{} があれば、定義順に並べて移行
      if (p.sectionData && typeof p.sectionData === "object") {
        // まず定義順
        sectionDefs.forEach((def) => {
          const sd = p.sectionData[def.key];
          if (sd) {
            p.sectionItems.push({
              iid: genId(), key: def.key,
              texts: sd.texts || [], images: sd.images || [],
              ...(sd.question !== undefined ? { question: sd.question } : {})
            });
          }
        });
        // 定義に無いキーも拾う
        const defKeys = new Set(sectionDefs.map((d) => d.key));
        Object.keys(p.sectionData).forEach((key) => {
          if (!defKeys.has(key)) {
            const sd = p.sectionData[key];
            p.sectionItems.push({
              iid: genId(), key,
              texts: sd.texts || [], images: sd.images || [],
              ...(sd.question !== undefined ? { question: sd.question } : {})
            });
          }
        });
      }
      // v3.7.0: 雛形廃止のため、空でも自動で項目を並べない(項目ゼロのまま)
      delete p.sectionData; // 旧形式は破棄
    }
    // 各itemの配列を保証(textsTop/textsBottomへの移行含む)
    p.sectionItems.forEach((it) => {
      if (!it.iid) it.iid = genId();
      ensureItemArrays(it);
    });
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

async function fetchAsBlobUrl(path, isImage = true, genericFile = false) {
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
           : ext === "svg" ? "image/svg+xml"
           : "image/png";
    } else if (genericFile) {
      mime = "application/octet-stream";
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
function collectAllImages(p, mode) {
  // mode: "show" 素材も含めて全部 / "hide" 素材除外(メイン+完成品) / "checked" チェック済み完成品のみ
  const imgs = [];
  if (Array.isArray(p.sectionItems)) {
    for (const item of p.sectionItems) {
      if (mode === "checked") {
        // チェック済みの完成品画像だけ。item.imagesFinalChecked: 配列(=チェック済みパス)を想定
        const checked = Array.isArray(item.imagesFinalChecked) ? item.imagesFinalChecked : [];
        if (Array.isArray(item.imagesFinal)) {
          for (const p2 of item.imagesFinal) {
            if (checked.includes(p2)) imgs.push(p2);
          }
        }
      } else {
        if (mode !== "hide" && item.images) imgs.push(...item.images);
        if (item.imagesFinal) imgs.push(...item.imagesFinal);
      }
    }
  }
  // メイン商品画像は show/hide のとき先頭に。checked は完成品のみなので含めない。
  if (mode !== "checked" && p.image) imgs.unshift(p.image);
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

  // v3.8.0: 表示は画像一覧(縦長サムネ)のみ
  renderGalleryView();
}

// 1行表示時のページ送りボタン(1-15 / 16-30 …)。全商品で最大の画像枚数からページ数を決める。
function renderGalleryPager(sortedProducts) {
  const pager = $("gallery-pager");
  if (!pager) return;
  // 全体表示モードではページング不要
  if (galleryWrap) {
    pager.style.display = "none";
    pager.innerHTML = "";
    return;
  }
  // 全商品の中で最大の画像枚数
  let maxImgs = 0;
  sortedProducts.forEach((p) => {
    const n = collectAllImages(p, galleryViewMode).length;
    if (n > maxImgs) maxImgs = n;
  });
  // 15枚以下ならページ送り不要(全部1ページに収まる)
  if (maxImgs <= GALLERY_PAGE_SIZE) {
    pager.style.display = "none";
    pager.innerHTML = "";
    galleryPage = 0;
    return;
  }
  const pageCount = Math.ceil(maxImgs / GALLERY_PAGE_SIZE);
  // 現在ページが範囲外なら補正
  if (galleryPage >= pageCount) galleryPage = pageCount - 1;
  let html = '<span class="pager-label">表示:</span>';
  for (let i = 0; i < pageCount; i++) {
    const from = i * GALLERY_PAGE_SIZE + 1;
    const to = Math.min((i + 1) * GALLERY_PAGE_SIZE, maxImgs);
    const active = i === galleryPage ? " active" : "";
    html += `<button class="pager-btn${active}" data-page="${i}">${from}-${to}</button>`;
  }
  pager.innerHTML = html;
  pager.style.display = "flex";
  pager.querySelectorAll(".pager-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      galleryPage = parseInt(btn.dataset.page);
      render();
    });
  });
}

// 画像一覧表示(1商品=横一列で全画像、縦長サムネ固定)
function renderGalleryView() {
  const gallery = $("gallery");
  gallery.className = "gallery-rows thumb-tall" + (galleryWrap ? " gallery-wrap" : "");
  const sorted = products.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  // ページャ更新(1行モードのみ)。全商品で最大の画像枚数を基準にページ数を決める。
  renderGalleryPager(sorted);
  // 1行モードでページングする場合の表示範囲
  const usePaging = !galleryWrap;
  const start = galleryPage * GALLERY_PAGE_SIZE;
  const end = start + GALLERY_PAGE_SIZE;

  gallery.innerHTML = sorted.map((p) => {
    const allImgs = collectAllImages(p, galleryViewMode);
    // 1行モード: 該当ページの15枚だけ。全体表示モード: 全部。
    const imgs = usePaging ? allImgs.slice(start, end) : allImgs;
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

  // サムネ読み込み + クリックで拡大(前後送りは「その行のまとまり」内だけ)
  gallery.querySelectorAll(".gallery-row").forEach((row) => {
    const thumbs = Array.from(row.querySelectorAll(".row-thumb[data-load-path]"));
    // この行のsrcを共有配列にして、各サムネが読み込まれたら同じ配列が更新される
    const srcs = new Array(thumbs.length).fill("");
    thumbs.forEach((img, i) => {
      fetchAsBlobUrl(img.dataset.loadPath, true).then((url) => {
        if (url) img.src = url;
        srcs[i] = url || "";
        img.removeAttribute("data-loading");
      });
      img.dataset.loading = "1";
      img.addEventListener("click", (e) => {
        e.stopPropagation(); // 画像クリックは拡大のみ(行クリックの編集遷移を抑止)
        // クリック時点で読み込み済みのsrcを使ってまとまりを構成
        const list = thumbs.map((t, j) => t.src || srcs[j]).filter(Boolean);
        // クリックしたサムネが list 内で何番目かを求める
        const clickedSrc = img.src || srcs[i];
        let idx = list.indexOf(clickedSrc);
        if (idx === -1) idx = 0;
        showLightbox(list, idx);
      });
    });
    // 行の何もないところをクリックしても編集画面へ(画像・編集ボタンは個別処理が優先)
    row.style.cursor = "pointer";
    row.addEventListener("click", () => openDetail(row.dataset.id));
  });
  // 「編集」ボタンで編集ページへ
  gallery.querySelectorAll(".row-open-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail(btn.dataset.id);
    });
  });
}

// 表示モードボタン(3択ラジオ): 素材を表示中 / 素材を除外中 / 完成品を表示中
function updateViewModeBtns() {
  const map = { "show": "view-mode-show", "hide": "view-mode-hide", "checked": "view-mode-checked" };
  const labels = { "show": "素材を表示中", "hide": "素材を除外中", "checked": "完成品を表示中" };
  for (const mode of Object.keys(map)) {
    const btn = $(map[mode]);
    if (!btn) continue;
    btn.innerHTML = `<span class="btn-2line-main">${labels[mode]}</span>`;
    btn.classList.toggle("active", galleryViewMode === mode);
  }
}

// モード切替(必ずどれか1つが選ばれる)
function setViewMode(mode) {
  if (mode !== "show" && mode !== "hide" && mode !== "checked") return;
  if (galleryViewMode === mode) return;
  galleryViewMode = mode;
  try { localStorage.setItem("imageFlow.galleryViewMode", mode); } catch {}
  updateViewModeBtns();
  render();
}

// 行表示ボタンの表示更新
function updateWrapBtn() {
  const wb = $("btn-wrap-toggle");
  if (wb) {
    // 上段=現在の状態、下段=小さい字で「→切り替え」案内
    const state = galleryWrap ? "全体表示中" : "1行表示中";
    wb.innerHTML = `<span class="btn-2line-main">${state}</span><span class="btn-2line-sub">→切り替え</span>`;
    wb.classList.toggle("active", galleryWrap);
  }
}

// 1行(横スクロール) ⇔ 複数行(折り返し全体表示) の切り替え
function toggleGalleryWrap() {
  galleryWrap = !galleryWrap;
  try { localStorage.setItem("imageFlow.galleryWrap", galleryWrap ? "1" : "0"); } catch {}
  updateWrapBtn();
  render();
}

// ---------- 商品詳細 ----------
function closeAllModals() {
  ["add-modal", "detail-modal", "text-fullscreen"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  // ライトボックスは状態リセットも伴うので専用関数で閉じる
  if (typeof closeLightbox === "function") closeLightbox();
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
      $("editor-img-remove").style.display = "";
      $("detail-img").src = "";
      loadImageInto($("detail-img"), p.image);
    } else {
      $("detail-img").style.display = "none";
      $("detail-noimg").style.display = "flex";
      $("editor-img-remove").style.display = "none";
    }

    // 商品情報(インライン編集の初期値)
    $("edit-start-date").value = p.startDate || "";
    $("edit-product-name").value = p.name || "";
    const hs = $("editor-head-status");
    if (hs) { hs.textContent = ""; hs.className = "save-status"; }

    // セクション描画
    renderSections(p);
  } catch (err) {
    console.error("openDetailでエラー(モーダルは開いたまま継続):", err);
  }
}

// ---------- セクション描画 ----------
function renderSections(p) {
  const wrap = $("editor-sections");
  if (!Array.isArray(p.sectionItems)) p.sectionItems = [];

  const sectionsHtml = p.sectionItems.map((item, secIdx) => {
    const def = sectionDefs.find((d) => d.key === item.key);
    // 表示名: item.label優先 → 雛形def.label → どちらも無ければ空(プレースホルダ表示)
    const rawLabel = (item.label !== undefined && item.label !== null && item.label !== "")
      ? item.label
      : (def ? def.label : "");
    const label = rawLabel;
    const labelIsEmpty = (rawLabel === "");

    // 画像・ファイルのアイテムHTMLを生成(side: material / final)
    const imgItemHtml = (path, i, side) => {
      // 完成品のみチェックボックスを表示(チェックすると「完成品を表示中」モードで表示対象)
      const checked = side === "final" && Array.isArray(item.imagesFinalChecked) && item.imagesFinalChecked.includes(path);
      const checkHtml = side === "final"
        ? `<label class="sec-img-check" title="チェックすると「完成品を表示中」モードで表示されます"><input type="checkbox" class="sec-img-check-input" data-iid="${escapeHtml(item.iid)}" data-path="${escapeHtml(path)}" ${checked ? "checked" : ""} /></label>`
        : "";
      return `
      <div class="sec-img-item${side === "final" && checked ? " checked" : ""}">
        <img data-load-path="${escapeHtml(path)}" alt="" />
        ${checkHtml}
        <button class="sec-swap" data-iid="${escapeHtml(item.iid)}" data-kind="img" data-side="${side}" data-idx="${i}" title="反対側へ移動">⇔</button>
        <button class="sec-img-remove" data-iid="${escapeHtml(item.iid)}" data-side="${side}" data-idx="${i}" title="削除">×</button>
      </div>`;
    };
    const fileItemHtml = (f, i, side) => `
      <div class="sec-file-item">
        <a class="sec-file-link" data-load-file="${escapeHtml(f.path)}" data-name="${escapeHtml(f.name)}" href="#" download="${escapeHtml(f.name)}">📄 <span>${escapeHtml(f.name)}</span></a>
        <button class="sec-swap" data-iid="${escapeHtml(item.iid)}" data-kind="file" data-side="${side}" data-idx="${i}" title="反対側へ移動">⇔</button>
        <button class="sec-file-remove" data-iid="${escapeHtml(item.iid)}" data-side="${side}" data-idx="${i}" title="削除">×</button>
      </div>`;

    const materialContent = (item.images || []).map((p2, i) => imgItemHtml(p2, i, "material")).join("")
      + (item.files || []).map((f, i) => fileItemHtml(f, i, "material")).join("");
    const finalContent = (item.imagesFinal || []).map((p2, i) => imgItemHtml(p2, i, "final")).join("")
      + (item.filesFinal || []).map((f, i) => fileItemHtml(f, i, "final")).join("");
    // 各サイドに「画像」が入っているかで判定(ファイルチップは無視)。
    // 画像が無ければ横長の薄いバー、1枚でもあれば正方形の追加口。
    const materialEmpty = (item.images || []).length === 0;
    const finalEmpty = (item.imagesFinal || []).length === 0;

    // テキスト1件分のHTML(pos: top/bottom)
    // 1行のinputでその場編集。長文は横にはみ出さず途中まで表示。
    // 「編集」ボタンで全画面エディタ(大きい画面)を開ける。
    const textItemHtml = (t, i, pos) => {
      const val = (t !== undefined && t !== null) ? escapeHtml(String(t)) : "";
      const txtLabel = pos === "bottom" ? "回答文.txt" : "入力文.txt";
      const txtTitle = pos === "bottom" ? "この回答文を.txtでダウンロード" : "この入力文を.txtでダウンロード";
      return `
      <div class="sec-text-item">
        <input class="sec-text-input" type="text" value="${val}" placeholder="テキストを入力…" data-iid="${escapeHtml(item.iid)}" data-pos="${pos}" data-idx="${i}" />
        <div class="sec-text-btns">
          <button class="sec-text-edit" data-iid="${escapeHtml(item.iid)}" data-pos="${pos}" data-idx="${i}" title="大きい画面で編集">編集</button>
          <button class="sec-text-copy" data-iid="${escapeHtml(item.iid)}" data-pos="${pos}" data-idx="${i}" title="この文章をコピー">コピー</button>
          <button class="sec-text-txt" data-iid="${escapeHtml(item.iid)}" data-pos="${pos}" data-idx="${i}" title="${txtTitle}">${txtLabel}</button>
          <button class="sec-text-remove" data-iid="${escapeHtml(item.iid)}" data-pos="${pos}" data-idx="${i}" title="このテキストを削除">×</button>
        </div>
      </div>`;
    };
    // テキストブロック(pos: top/bottom)。既存テキストのみ表示(追加ボタンなし)
    const textsBlockHtml = (pos) => {
      const arr = item[textArrName(pos)] || [];
      const items = arr.map((t, i) => textItemHtml(t, i, pos)).join("");
      return `
      <div class="sec-texts" data-pos="${pos}">
        ${items}
      </div>`;
    };

    return `
    <div class="editor-section" data-iid="${escapeHtml(item.iid)}">
      <div class="editor-section-head editor-section-head-notitle">
        <div class="editor-section-actions">
          <button class="sec-move" data-iid="${escapeHtml(item.iid)}" data-dir="up" title="上へ移動" ${secIdx === 0 ? "disabled" : ""}>↑</button>
          <button class="sec-move" data-iid="${escapeHtml(item.iid)}" data-dir="down" title="下へ移動" ${secIdx === p.sectionItems.length - 1 ? "disabled" : ""}>↓</button>
          <button class="sec-remove-item" data-iid="${escapeHtml(item.iid)}" title="この項目を削除">×</button>
        </div>
      </div>
      ${textsBlockHtml("top")}
      <div class="sec-dual">
        <div class="sec-side">
          <div class="sec-side-label sec-side-label-row">
            <span>素材</span>
            <span class="sec-side-label-btns">
              <button class="sec-use-topall" data-iid="${escapeHtml(item.iid)}" title="「all 上部の全情報を使用」のプレースホルダを素材に追加">上部の全情報を使用</button>
              <button class="sec-use-top" data-iid="${escapeHtml(item.iid)}" title="「↑上部の情報を使用」のプレースホルダを素材に追加">上部の情報を使用</button>
              <button class="sec-use-final" data-iid="${escapeHtml(item.iid)}" title="「右上の完成品を使用」のプレースホルダを素材に追加">右上の完成品を使用</button>
            </span>
          </div>
          <div class="sec-images">
            ${materialContent}
            <div class="sec-dropzone${materialEmpty ? " sec-dropzone-bar" : ""}" data-iid="${escapeHtml(item.iid)}" data-side="material" title="クリックまたはドラッグ&ドロップでアップロード">
              <span class="sec-dropzone-icon">⇪</span>
              <span class="sec-dropzone-text">画像を<br>アップロード</span>
            </div>
            <input class="sec-file-input" type="file" accept="image/*,*/*" multiple hidden data-iid="${escapeHtml(item.iid)}" data-side="material" />
          </div>
        </div>
        <div class="sec-side">
          <div class="sec-side-label">完成品</div>
          <div class="sec-images">
            ${finalContent}
            <div class="sec-dropzone${finalEmpty ? " sec-dropzone-bar" : ""}" data-iid="${escapeHtml(item.iid)}" data-side="final" title="クリックまたはドラッグ&ドロップでアップロード">
              <span class="sec-dropzone-icon">⇪</span>
              <span class="sec-dropzone-text">画像を<br>アップロード</span>
            </div>
            <input class="sec-file-input" type="file" accept="image/*,*/*" multiple hidden data-iid="${escapeHtml(item.iid)}" data-side="final" />
          </div>
        </div>
      </div>
      ${textsBlockHtml("bottom")}
    </div>`;
  }).join("");

  // 末尾に「+ 項目を追加」ボタン(押すと空白項目を1つ追加)
  const addAreaHtml = `
    <div class="sec-add-item-area">
      <button id="sec-add-item-btn" class="sec-add-item-btn">＋ 項目を追加</button>
    </div>`;

  wrap.innerHTML = sectionsHtml + addAreaHtml;

  // 画像読み込み + クリックで拡大(前後送りは「その項目の素材+完成品のまとまり」内だけ)
  wrap.querySelectorAll(".editor-section").forEach((section) => {
    const imgs = Array.from(section.querySelectorAll("img[data-load-path]"));
    const srcs = new Array(imgs.length).fill("");
    imgs.forEach((img, i) => {
      img.dataset.loading = "1";
      fetchAsBlobUrl(img.dataset.loadPath, true).then((url) => {
        if (url) img.src = url;
        srcs[i] = url || "";
        img.removeAttribute("data-loading");
      });
      img.addEventListener("click", () => {
        const list = imgs.map((t, j) => t.src || srcs[j]).filter(Boolean);
        const clickedSrc = img.src || srcs[i];
        let idx = list.indexOf(clickedSrc);
        if (idx === -1) idx = 0;
        showLightbox(list, idx);
      });
    });
  });
  // ファイルのダウンロードリンク読み込み
  wrap.querySelectorAll(".sec-file-link[data-load-file]").forEach((a) => {
    fetchAsBlobUrl(a.dataset.loadFile, false, true).then((url) => {
      if (url) { a.href = url; a.download = a.dataset.name || "file"; }
    });
  });
  // ファイル削除
  wrap.querySelectorAll(".sec-file-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeSectionFile(btn.dataset.iid, btn.dataset.side, parseInt(btn.dataset.idx)));
  });
  // 「右上の完成品を使用」プレースホルダを素材に追加
  wrap.querySelectorAll(".sec-use-final").forEach((btn) => {
    btn.addEventListener("click", () => addFinalPlaceholder(btn.dataset.iid));
  });
  // 「上部の情報を使用」プレースホルダを素材に追加
  wrap.querySelectorAll(".sec-use-top").forEach((btn) => {
    btn.addEventListener("click", () => addTopPlaceholder(btn.dataset.iid));
  });
  // 「上部の全情報を使用」プレースホルダを素材に追加
  wrap.querySelectorAll(".sec-use-topall").forEach((btn) => {
    btn.addEventListener("click", () => addTopAllPlaceholder(btn.dataset.iid));
  });
  // ドロップゾーン(side別): クリックでファイル選択 / ドラッグ&ドロップ
  wrap.querySelectorAll(".sec-dropzone").forEach((dz) => {
    const iid = dz.dataset.iid;
    const side = dz.dataset.side;
    // クリックで同じside の hidden file input を開く
    dz.addEventListener("click", () => {
      const input = wrap.querySelector(`.sec-file-input[data-iid="${CSS.escape(iid)}"][data-side="${side}"]`);
      if (input) input.click();
    });
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        addSectionImages(iid, side, e.dataTransfer.files);
      }
    });
  });
  // ファイル選択(input change)でアップロード
  wrap.querySelectorAll(".sec-file-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length) {
        addSectionImages(input.dataset.iid, input.dataset.side, e.target.files);
      }
      e.target.value = ""; // 同じファイルを連続選択できるようリセット
    });
  });
  // 画像削除
  wrap.querySelectorAll(".sec-img-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeSectionImage(btn.dataset.iid, btn.dataset.side, parseInt(btn.dataset.idx)));
  });
  // 画像/ファイルを反対側へ移動(⇔)
  wrap.querySelectorAll(".sec-swap").forEach((btn) => {
    btn.addEventListener("click", () => swapSide(btn.dataset.iid, btn.dataset.kind, btn.dataset.side, parseInt(btn.dataset.idx)));
  });
  // 完成品チェックボックス: チェック/外す → imagesFinalChecked に反映 + 保存
  wrap.querySelectorAll(".sec-img-check-input").forEach((cb) => {
    cb.addEventListener("change", () => toggleFinalChecked(cb.dataset.iid, cb.dataset.path, cb.checked));
    // チェックボックスクリックがライトボックス起動に伝播しないように
    cb.addEventListener("click", (e) => e.stopPropagation());
  });
  // テキスト削除
  wrap.querySelectorAll(".sec-text-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeSectionText(btn.dataset.iid, btn.dataset.pos, parseInt(btn.dataset.idx)));
  });
  // 1行inputでその場編集 → フォーカスを外したら(blur)保存。Enterでも確定。
  wrap.querySelectorAll(".sec-text-input").forEach((inp) => {
    inp.addEventListener("blur", () => {
      // paste直後はblur保存をスキップ(改行込みの保存内容を1行値で上書きしないため)
      if (inp.dataset.pasteSkipBlur === "1") {
        inp.dataset.pasteSkipBlur = "";
        return;
      }
      commitSectionText(inp.dataset.iid, inp.dataset.pos, parseInt(inp.dataset.idx), inp.value);
    });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
    // 貼り付け(paste)時: 改行を含むテキストはinputに入れず直接データへ保存。
    // ChatGPT等からコピペ時に改行が消えるのを防ぐ。
    inp.addEventListener("paste", (e) => {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      const pasted = cd.getData("text/plain");
      if (pasted === undefined || pasted === null) return;
      // 改行を含む場合だけ特別扱い(改行なしなら通常のpaste挙動でOK)
      if (!/\r|\n/.test(pasted)) return;
      e.preventDefault();
      // inputには表示用に1行化(改行→空白)した先頭を入れ、データには改行込みで保存
      const oneLine = pasted.replace(/\s*\r?\n\s*/g, " ").trim();
      inp.value = oneLine;
      inp.dataset.pasteSkipBlur = "1";  // 直後のblurで1行値に上書きされるのを防ぐ
      pasteCommitSectionText(inp.dataset.iid, inp.dataset.pos, parseInt(inp.dataset.idx), pasted);
    });
  });
  // 「編集」ボタンで大きい画面(全画面エディタ)を開く
  wrap.querySelectorAll(".sec-text-edit").forEach((btn) => {
    btn.addEventListener("click", () => openTextFullscreen(btn.dataset.iid, btn.dataset.pos, parseInt(btn.dataset.idx)));
  });
  // 「コピー」ボタンで中身をクリップボードへ
  wrap.querySelectorAll(".sec-text-copy").forEach((btn) => {
    btn.addEventListener("click", () => copySectionText(btn));
  });
  // 「.txt」ボタンで文章をテキストファイルとしてダウンロード
  wrap.querySelectorAll(".sec-text-txt").forEach((btn) => {
    btn.addEventListener("click", () => downloadSectionText(btn));
  });
  // 項目ごと削除
  wrap.querySelectorAll(".sec-remove-item").forEach((btn) => {
    btn.addEventListener("click", () => removeSectionItem(btn.dataset.iid));
  });
  // 項目の上下移動
  wrap.querySelectorAll(".sec-move").forEach((btn) => {
    btn.addEventListener("click", () => moveSectionItem(btn.dataset.iid, btn.dataset.dir === "up" ? -1 : 1));
  });
  // +項目を追加(空白の新規項目を1つ追加)
  $("sec-add-item-btn").addEventListener("click", addBlankSectionItem);
}

// 項目を上下に移動
async function moveSectionItem(iid, delta) {
  const p = getCurrentProduct();
  if (!p || !Array.isArray(p.sectionItems)) return;
  const idx = p.sectionItems.findIndex((it) => it.iid === iid);
  if (idx === -1) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= p.sectionItems.length) return;
  const [item] = p.sectionItems.splice(idx, 1);
  p.sectionItems.splice(newIdx, 0, item);
  renderSections(p); // 先に画面反映(待たせない)
  try {
    await saveData(`Reorder section: ${p.name}`, mergeCurrentProduct(p));
  } catch (err) {
    alert("並べ替えの保存に失敗: " + err.message);
  }
}

// 空白の項目を1つ追加(雛形に依存しない)
// key/label を持たせず、texts に空1つを入れてテキスト欄を最初から表示。
async function addBlankSectionItem() {
  const p = getCurrentProduct();
  if (!p) return;
  if (!Array.isArray(p.sectionItems)) p.sectionItems = [];
  const iid = genId();
  p.sectionItems.push({
    iid,
    key: "free-" + iid,   // 雛形に紐づかない一意キー
    textsTop: [""],       // 画像の上のテキスト欄(空1個)
    textsBottom: [""],    // 画像の下のテキスト欄(空1個)
    images: [], files: [], imagesFinal: [], filesFinal: []
  });
  try {
    await saveData(`Add blank section item: ${p.name}`, mergeCurrentProduct(p));
    renderSections(p);
    // 追加した項目の位置までスクロール(アップロード口は常時表示)
    setTimeout(() => {
      const section = document.querySelector(`.editor-section[data-iid="${CSS.escape(iid)}"]`);
      if (section) section.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  } catch (err) {
    alert("追加失敗: " + err.message);
  }
}

// 項目ごと削除(その商品からこのインスタンスを消す)
async function removeSectionItem(iid) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  if (!item) return;
  const def = sectionDefs.find((d) => d.key === item.key);
  const label = def ? def.label : "この項目";
  const hasContent = (item.textsTop && item.textsTop.length) || (item.textsBottom && item.textsBottom.length) || allItemPaths(item).length;
  if (!confirm(`「${label}」を削除しますか?${hasContent ? "\n中のテキスト・画像・ファイルも削除されます。" : ""}`)) return;
  try {
    for (const path of allItemPaths(item)) {
      try { await deleteFile(path, null, `Remove section item file: ${p.id}`); }
      catch (e) { console.warn("削除失敗(続行):", e); }
    }
    p.sectionItems = p.sectionItems.filter((x) => x.iid !== iid);
    await saveData(`Remove section item: ${p.name}`, mergeCurrentProduct(p));
    renderSections(p);
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

function getCurrentProduct() {
  return products.find((x) => x.id === currentDetailId);
}

// ---------- 全画面テキストエディタ ----------
let fsEditing = null; // { iid, pos, idx }

function openTextFullscreen(iid, pos, idx) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  if (!item) return;
  const arr = item[textArrName(pos)];
  if (!arr || arr[idx] === undefined) return;
  fsEditing = { iid, pos, idx };
  $("text-fullscreen-title").textContent = "テキスト";
  const area = $("text-fullscreen-area");
  area.value = arr[idx];
  $("text-fullscreen").style.display = "flex";
  setTimeout(() => {
    area.focus();
    area.setSelectionRange(0, 0);
    area.scrollTop = 0;
  }, 30);
}

// テキストの中身をクリップボードにコピー(押すと一瞬「✓」表示)
async function copySectionText(btn) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, btn.dataset.iid);
  if (!item) return;
  const arr = item[textArrName(btn.dataset.pos)];
  const idx = parseInt(btn.dataset.idx);
  const text = (arr && arr[idx] !== undefined) ? String(arr[idx]) : "";
  const showOk = () => {
    const orig = btn.textContent;
    btn.textContent = "✓";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1000);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // フォールバック(古い環境)
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    showOk();
  } catch (e) {
    alert("コピーに失敗しました: " + e.message);
  }
}

// 商品内のテキスト通し番号(1始まり)。pos別に独立カウント:
//   pos="top"   → 全項目のtextsTopだけを順に1,2,3…
//   pos="bottom"→ 全項目のtextsBottomだけを順に1,2,3…
function textSerialNumber(p, iid, pos, idx) {
  if (!p || !Array.isArray(p.sectionItems)) return 1;
  let n = 0;
  for (const it of p.sectionItems) {
    const arr = it[textArrName(pos)] || [];
    for (let i = 0; i < arr.length; i++) {
      n++;
      if (it.iid === iid && i === idx) return n;
    }
  }
  return n || 1;
}

// ファイル名に使えない文字を除去(Windows禁止文字 + 制御文字 + パス区切り)
function safeFileName(name) {
  return String(name || "untitled")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "untitled";
}

// 「.txt」ボタン: 文章をテキストファイルとしてダウンロード。
// ファイル名は「商品名-入力文/回答文-通し番号.txt」
function downloadSectionText(btn) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, btn.dataset.iid);
  if (!item) return;
  const pos = btn.dataset.pos;
  const idx = parseInt(btn.dataset.idx);
  const arr = item[textArrName(pos)];
  const text = (arr && arr[idx] !== undefined) ? String(arr[idx]) : "";
  const serial = textSerialNumber(p, item.iid, pos, idx);
  const label = pos === "bottom" ? "回答文" : "入力文";
  const filename = `${safeFileName(p.name)}-${label}-${serial}.txt`;
  // BOM付きUTF-8でダウンロード(Windowsのメモ帳で文字化けを防ぐ)
  const blob = new Blob(["\uFEFF" + text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // 押したフィードバック(一瞬「✓」)
  const orig = btn.textContent;
  btn.textContent = "✓";
  btn.classList.add("copied");
  setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1000);
}

async function closeTextFullscreen() {
  if (!fsEditing) { $("text-fullscreen").style.display = "none"; return; }
  const p = getCurrentProduct();
  const { iid, pos, idx } = fsEditing;
  const newVal = $("text-fullscreen-area").value.trim();
  $("text-fullscreen").style.display = "none";
  fsEditing = null;
  if (!p) return;
  const item = getItem(p, iid);
  const arr = item ? item[textArrName(pos)] : null;
  if (!item || !arr || arr[idx] === undefined) return;
  if (arr[idx] === newVal) { renderSections(p); return; }
  arr[idx] = newVal;
  try {
    await saveData(`Update text (fullscreen): ${p.name}`, mergeCurrentProduct(p));
  } catch (err) {
    alert("保存失敗: " + err.message);
  }
  renderSections(p);
}

function sectionLabelOf(item) {
  return "項目";
}

// テキスト追加(pos: top/bottom)
// テキスト確定(blur時)※現在は全画面エディタ経由のため通常未使用
async function commitSectionText(iid, pos, idx, value) {
  if (manualSaving) return;
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  const arr = item ? item[textArrName(pos)] : null;
  if (!item || !arr || arr[idx] === undefined) return;
  const newVal = value.trim();
  if (arr[idx] === newVal) return;
  arr[idx] = newVal;
  try {
    await saveData(`Update text: ${p.name}`, mergeCurrentProduct(p));
  } catch (err) {
    alert("保存失敗: " + err.message);
  }
}

// 貼り付け(paste)専用: 改行を含むrawTextをそのままデータに保存する。
// 1行input欄に改行を貼っても消えないようにするための専用パス。
async function pasteCommitSectionText(iid, pos, idx, rawText) {
  if (manualSaving) return;
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  const arr = item ? item[textArrName(pos)] : null;
  if (!item || !arr || arr[idx] === undefined) return;
  // trimは前後だけ。内部の改行は保持。
  const newVal = String(rawText).replace(/^\s+|\s+$/g, "");
  if (arr[idx] === newVal) return;
  arr[idx] = newVal;
  try {
    await saveData(`Paste text: ${p.name}`, mergeCurrentProduct(p));
  } catch (err) {
    alert("保存失敗: " + err.message);
  }
}

async function removeSectionText(iid, pos, idx) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  if (!item) return;
  if (!confirm("このテキストを削除しますか?")) return;
  const arr = item[textArrName(pos)];
  arr.splice(idx, 1);
  try {
    await saveData(`Remove text in ${sectionLabelOf(item)}: ${p.name}`, mergeCurrentProduct(p));
    renderSections(p);
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

// itemの全アップロードパス(画像・ファイル、素材・完成品すべて)
function allItemPaths(item) {
  const paths = [];
  (item.images || []).forEach((p) => paths.push(p));
  (item.imagesFinal || []).forEach((p) => paths.push(p));
  (item.files || []).forEach((f) => paths.push(f.path));
  (item.filesFinal || []).forEach((f) => paths.push(f.path));
  return paths;
}

// side に応じた配列名を返す
function arrNames(side) {
  return side === "final"
    ? { img: "imagesFinal", file: "filesFinal" }
    : { img: "images", file: "files" };
}

// 画像・ファイル追加(side: material / final)
async function addSectionImages(iid, side, files) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  if (!item) return;
  const names = arrNames(side);
  if (!Array.isArray(item[names.img])) item[names.img] = [];
  if (!Array.isArray(item[names.file])) item[names.file] = [];

  const all = [...files];
  if (all.length === 0) return;

  setHeadStatus(`アップロード中… (0/${all.length})`);
  try {
    for (let i = 0; i < all.length; i++) {
      const file = all[i];
      if (file.size > 50 * 1024 * 1024) {
        alert(`${file.name} は大きすぎます(50MB超)。スキップします。`);
        continue;
      }
      setHeadStatus(`アップロード中… (${i + 1}/${all.length})`);
      const base64 = await fileToBase64(file);
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();
      if (file.type.startsWith("image/")) {
        const path = `${IMAGES_DIR}/${p.id}-${item.iid}-${side}-${Date.now()}-${i + 1}.${ext}`;
        await uploadFile(path, base64, `Add image to ${sectionLabelOf(item)}: ${p.id}`);
        item[names.img].push(path);
      } else {
        const safeName = file.name.replace(/[^\w.\-]/g, "_");
        const path = `${FILES_DIR}/${p.id}-${item.iid}-${side}-${Date.now()}-${i + 1}-${safeName}`;
        await uploadFile(path, base64, `Add file to ${sectionLabelOf(item)}: ${p.id}`);
        item[names.file].push({ path, name: file.name });
      }
    }
    await saveData(`Add files to ${sectionLabelOf(item)}: ${p.name}`, mergeCurrentProduct(p));
    setHeadStatus("✓ 追加しました", "ok");
    renderSections(p);
    setTimeout(() => setHeadStatus(""), 1200);
  } catch (err) {
    setHeadStatus("✗ " + err.message, "err");
  }
}

// 「右上の完成品を使用」プレースホルダ画像(文字だけの□)を素材に追加
// SVGで生成 → 通常の画像と同じく images/ にアップロードし item.images に追加。
// これによりライトボックス・⇔移動・削除・並べ替えすべて既存処理で動く。
function finalPlaceholderSvgBase64() {
  // 正方形・落ち着いた配色。文言は「右上の完成品を使用」
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect x="8" y="8" width="584" height="584" rx="14" fill="#eeeae0" stroke="#8a867d" stroke-width="3" stroke-dasharray="14 10"/>
  <g fill="#4a4844" font-family="'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif" text-anchor="middle">
    <text x="300" y="250" font-size="58" fill="#c8451c">↗</text>
    <text x="300" y="330" font-size="42" font-weight="700">右上の</text>
    <text x="300" y="392" font-size="42" font-weight="700">完成品を使用</text>
  </g>
</svg>`;
  return b64encode(svg);
}

async function addFinalPlaceholder(iid) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  if (!item) return;
  if (!Array.isArray(item.images)) item.images = [];
  setHeadStatus("プレースホルダを追加中…");
  try {
    const base64 = finalPlaceholderSvgBase64();
    const path = `${IMAGES_DIR}/${p.id}-${item.iid}-material-${Date.now()}-usefinal.svg`;
    await uploadFile(path, base64, `Add 'use final' placeholder to ${sectionLabelOf(item)}: ${p.id}`);
    item.images.push(path);
    await saveData(`Add 'use final' placeholder: ${p.name}`, mergeCurrentProduct(p));
    setHeadStatus("✓ 追加しました", "ok");
    renderSections(p);
    setTimeout(() => setHeadStatus(""), 1200);
  } catch (err) {
    setHeadStatus("✗ " + err.message, "err");
  }
}

// 「↑上部の情報を使用」プレースホルダ画像。完成品用とほぼ同じ配色で、矢印だけ青。
function topPlaceholderSvgBase64() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect x="8" y="8" width="584" height="584" rx="14" fill="#eeeae0" stroke="#8a867d" stroke-width="3" stroke-dasharray="14 10"/>
  <g fill="#4a4844" font-family="'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif" text-anchor="middle">
    <text x="300" y="250" font-size="58" fill="#2f6db5">↑</text>
    <text x="300" y="330" font-size="42" font-weight="700">上部の</text>
    <text x="300" y="392" font-size="42" font-weight="700">情報を使用</text>
  </g>
</svg>`;
  return b64encode(svg);
}

async function addTopPlaceholder(iid) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  if (!item) return;
  if (!Array.isArray(item.images)) item.images = [];
  setHeadStatus("プレースホルダを追加中…");
  try {
    const base64 = topPlaceholderSvgBase64();
    const path = `${IMAGES_DIR}/${p.id}-${item.iid}-material-${Date.now()}-usetop.svg`;
    await uploadFile(path, base64, `Add 'use top' placeholder to ${sectionLabelOf(item)}: ${p.id}`);
    item.images.push(path);
    await saveData(`Add 'use top' placeholder: ${p.name}`, mergeCurrentProduct(p));
    setHeadStatus("✓ 追加しました", "ok");
    renderSections(p);
    setTimeout(() => setHeadStatus(""), 1200);
  } catch (err) {
    setHeadStatus("✗ " + err.message, "err");
  }
}

// 「all 上部の全情報を使用」プレースホルダ画像。完成品用と同じ配色で、矢印の代わりに緑の「all」。
function topAllPlaceholderSvgBase64() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect x="8" y="8" width="584" height="584" rx="14" fill="#eeeae0" stroke="#8a867d" stroke-width="3" stroke-dasharray="14 10"/>
  <g fill="#4a4844" font-family="'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif" text-anchor="middle">
    <text x="300" y="262" font-size="84" font-weight="800" fill="#2e9e5b">all</text>
    <text x="300" y="345" font-size="42" font-weight="700">上部の</text>
    <text x="300" y="407" font-size="42" font-weight="700">全情報を使用</text>
  </g>
</svg>`;
  return b64encode(svg);
}

async function addTopAllPlaceholder(iid) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  if (!item) return;
  if (!Array.isArray(item.images)) item.images = [];
  setHeadStatus("プレースホルダを追加中…");
  try {
    const base64 = topAllPlaceholderSvgBase64();
    const path = `${IMAGES_DIR}/${p.id}-${item.iid}-material-${Date.now()}-usetopall.svg`;
    await uploadFile(path, base64, `Add 'use top all' placeholder to ${sectionLabelOf(item)}: ${p.id}`);
    item.images.push(path);
    await saveData(`Add 'use top all' placeholder: ${p.name}`, mergeCurrentProduct(p));
    setHeadStatus("✓ 追加しました", "ok");
    renderSections(p);
    setTimeout(() => setHeadStatus(""), 1200);
  } catch (err) {
    setHeadStatus("✗ " + err.message, "err");
  }
}

// 完成品画像のチェック切替: imagesFinalChecked 配列に path を入れる/外す → 保存
async function toggleFinalChecked(iid, path, isChecked) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  if (!item) return;
  if (!Array.isArray(item.imagesFinalChecked)) item.imagesFinalChecked = [];
  const i = item.imagesFinalChecked.indexOf(path);
  if (isChecked && i === -1) item.imagesFinalChecked.push(path);
  if (!isChecked && i !== -1) item.imagesFinalChecked.splice(i, 1);
  // 即DOMにも反映(完成品アイテムの枠強調)
  const wrapEl = document.querySelector(`.editor-section[data-iid="${CSS.escape(iid)}"]`);
  if (wrapEl) {
    wrapEl.querySelectorAll(`.sec-img-check-input[data-path="${CSS.escape(path)}"]`).forEach((cb) => {
      const item = cb.closest(".sec-img-item");
      if (item) item.classList.toggle("checked", isChecked);
    });
  }
  try {
    await saveData(`Toggle final-checked: ${p.name}`, mergeCurrentProduct(p));
  } catch (err) {
    alert("保存失敗: " + err.message);
  }
}

async function removeSectionFile(iid, side, idx) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  const names = arrNames(side);
  if (!item || !Array.isArray(item[names.file]) || !item[names.file][idx]) return;
  if (!confirm("このファイルを削除しますか?")) return;
  const f = item[names.file][idx];
  try {
    try { await deleteFile(f.path, null, `Remove file from ${sectionLabelOf(item)}: ${p.id}`); }
    catch (e) { console.warn("ファイル削除失敗(続行):", e); }
    item[names.file].splice(idx, 1);
    await saveData(`Remove file from ${sectionLabelOf(item)}: ${p.name}`, mergeCurrentProduct(p));
    renderSections(p);
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

// 画像削除(side対応)
async function removeSectionImage(iid, side, idx) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  const names = arrNames(side);
  if (!item || !item[names.img][idx]) return;
  if (!confirm("この画像を削除しますか?")) return;
  const path = item[names.img][idx];
  try {
    try { await deleteFile(path, null, `Remove image from ${sectionLabelOf(item)}: ${p.id}`); }
    catch (e) { console.warn("画像削除失敗(続行):", e); }
    item[names.img].splice(idx, 1);
    await saveData(`Remove image from ${sectionLabelOf(item)}: ${p.name}`, mergeCurrentProduct(p));
    renderSections(p);
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

// 画像/ファイルを反対側へ移動(⇔)
async function swapSide(iid, kind, side, idx) {
  const p = getCurrentProduct();
  if (!p) return;
  const item = getItem(p, iid);
  if (!item) return;
  const from = arrNames(side);
  const to = arrNames(side === "final" ? "material" : "final");
  const fromArr = item[kind === "img" ? from.img : from.file];
  const toArr = item[kind === "img" ? to.img : to.file];
  if (!Array.isArray(fromArr) || fromArr[idx] === undefined) return;
  const [moved] = fromArr.splice(idx, 1);
  toArr.push(moved);
  renderSections(p);
  try {
    await saveData(`Move ${kind} to other side: ${p.name}`, mergeCurrentProduct(p));
  } catch (err) {
    alert("移動の保存に失敗: " + err.message);
  }
}

// ---------- 手動保存(右上の保存ボタン) ----------
// forClose: trueなら閉じる用途(保存失敗をalertでなくconsoleに)。
// 戻り値: 保存に成功したか(falseは「保存できなかった/中断」)。
async function saveAllCurrent(forClose) {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p) return false;
  manualSaving = true;
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  const name = $("edit-product-name").value.trim();
  const startDate = $("edit-start-date").value.trim();
  if (!name) { alert("商品名は空にできません"); manualSaving = false; return false; }
  p.name = name;
  p.startDate = startDate;
  // テキストは全画面エディタを閉じた時点で item.texts に保存済みなので、ここでの収集は不要
  try {
    await saveData(`Save product: ${p.name}`, mergeCurrentProduct(p));
    render();
    return true;
  } catch (err) {
    if (!forClose) alert("保存失敗: " + err.message);
    else console.error("保存失敗:", err);
    return false;
  } finally {
    manualSaving = false;
  }
}

// 保存だけして編集を継続(右上「保存」)
async function saveOnlyKeepOpen() {
  const ok = await saveAllCurrent(false);
  if (ok) {
    setHeadStatus("✓ 保存しました", "ok");
    setTimeout(() => setHeadStatus(""), 1200);
  }
}

// 保存して閉じる(右上「保存×」)
async function saveAndClose() {
  await saveAllCurrent(true);
  $("detail-modal").style.display = "none";
}

// 保存せず閉じる(右上「×」)
// B案: 今フォーカス中の欄の未確定分も保存せずに破棄する。
// manualSaving を立ててから blur することで、blur保存(commitSectionText等)をスキップさせる。
function closeWithoutSaving() {
  manualSaving = true;
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  $("detail-modal").style.display = "none";
  // blurによる非同期保存が走らないよう、少し後にフラグを戻す
  setTimeout(() => { manualSaving = false; }, 0);
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
    $("editor-img-remove").style.display = "";
    $("detail-img").src = "";
    loadImageInto($("detail-img"), p.image);
    setHeadStatus("✓ 画像を更新しました", "ok");
    setTimeout(() => setHeadStatus(""), 1200);
    render();
  } catch (err) {
    setHeadStatus("✗ " + err.message, "err");
  }
}

// メイン画像を削除(右上の×ボタン)
async function removeProductImage() {
  const p = products.find((x) => x.id === currentDetailId);
  if (!p || !p.image) return;
  if (!confirm("メイン画像を削除しますか?")) return;
  const oldPath = p.image;
  try {
    setHeadStatus("画像を削除中…");
    try { await deleteFile(oldPath, null, `Delete main image: ${p.id}`); }
    catch (e) { console.warn("画像削除失敗(続行):", e); }
    blobCache.delete(oldPath);
    p.image = "";
    await saveData(`Remove main image: ${p.name}`, mergeCurrentProduct(p));
    // 表示更新
    $("detail-img").style.display = "none";
    $("detail-noimg").style.display = "flex";
    $("editor-img-remove").style.display = "none";
    setHeadStatus("✓ 画像を削除しました", "ok");
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

// ---------- ライトボックス(画像拡大・前後送り対応 v3.4.0) ----------
// lightboxList: 表示中のまとまり(同じ行/同じ項目の画像src配列)
// lightboxIdx : その中で今表示している位置
let lightboxList = [];
let lightboxIdx = 0;

// list: 画像srcの配列(まとまり)、startIdx: 開始位置
function showLightbox(list, startIdx) {
  if (!Array.isArray(list) || list.length === 0) return;
  lightboxList = list.filter((s) => !!s);
  if (lightboxList.length === 0) return;
  lightboxIdx = Math.max(0, Math.min(startIdx || 0, lightboxList.length - 1));
  updateLightbox();
  $("lightbox").style.display = "flex";
}

// 表示内容の更新(メイン画像・前後プレビュー・カウンター・矢印の出し分け)
function updateLightbox() {
  const total = lightboxList.length;
  const cur = lightboxList[lightboxIdx];
  $("lightbox-img").src = cur || "";

  const counter = $("lightbox-counter");
  if (counter) counter.textContent = total > 1 ? `${lightboxIdx + 1} / ${total}` : "";

  const prevBtn = $("lightbox-prev");
  const nextBtn = $("lightbox-next");
  const prevImg = $("lightbox-prev-img");
  const nextImg = $("lightbox-next-img");

  // まとまりの中だけで前後送り(端ではボタンを隠す)
  const hasPrev = lightboxIdx > 0;
  const hasNext = lightboxIdx < total - 1;
  if (prevBtn) prevBtn.classList.toggle("disabled", !hasPrev);
  if (nextBtn) nextBtn.classList.toggle("disabled", !hasNext);
  if (prevImg) prevImg.src = hasPrev ? (lightboxList[lightboxIdx - 1] || "") : "";
  if (nextImg) nextImg.src = hasNext ? (lightboxList[lightboxIdx + 1] || "") : "";
}

// 前後送り(まとまりの範囲内のみ。端は何もしない)
function lightboxNav(delta) {
  const next = lightboxIdx + delta;
  if (next < 0 || next >= lightboxList.length) return;
  lightboxIdx = next;
  updateLightbox();
}

function closeLightbox() {
  $("lightbox").style.display = "none";
  lightboxList = [];
  lightboxIdx = 0;
  $("lightbox-img").src = "";
  const pi = $("lightbox-prev-img"); if (pi) pi.src = "";
  const ni = $("lightbox-next-img"); if (ni) ni.src = "";
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
    // 全項目の画像・ファイルも削除
    if (Array.isArray(p.sectionItems)) {
      for (const it of p.sectionItems) {
        for (const path of allItemPaths(it)) {
          try { await deleteFile(path, null, `Delete section file: ${p.id}`); }
          catch (e) { console.warn("セクション削除失敗(続行):", e); }
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
  $("preview-wrap").style.display = "none";
  $("dropzone").style.display = "block";
  $("file-input").value = "";
  $("input-start-date").value = todayShort();
  $("input-product-name").value = "";
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

    $("save-status").textContent = "メタデータを保存中…";
    const product = {
      id,
      name,
      startDate,
      image: imgPath,
      sectionItems: [{ iid: genId(), key: "free-" + genId(), textsTop: [""], textsBottom: [""], images: [], files: [], imagesFinal: [], filesFinal: [] }],  // 空項目を1個だけ用意(あとは「＋項目を追加」で増やす)
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

  $("btn-save").addEventListener("click", saveProduct);
  $("btn-delete").addEventListener("click", deleteProduct);

  // v3.5.0: 編集ページ右上の3ボタン
  // 保存 = 保存だけして開いたまま継続
  $("btn-save-only").addEventListener("click", saveOnlyKeepOpen);
  // 保存× = 保存して閉じる
  $("btn-save-close").addEventListener("click", saveAndClose);
  // × = 保存せず閉じる(B案: 今フォーカス中の欄も破棄)
  $("btn-close-nosave").addEventListener("click", closeWithoutSaving);

  // 素材除外の切り替え(画像一覧固定)
  $("view-mode-show").addEventListener("click", () => setViewMode("show"));
  $("view-mode-hide").addEventListener("click", () => setViewMode("hide"));
  $("view-mode-checked").addEventListener("click", () => setViewMode("checked"));
  $("btn-wrap-toggle").addEventListener("click", toggleGalleryWrap);

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
  $("editor-img-remove").addEventListener("click", removeProductImage);

  // ライトボックス: 背景クリックで閉じる(中の画像・ボタンクリックでは閉じない)
  $("lightbox").addEventListener("click", (e) => {
    if (e.target === $("lightbox")) closeLightbox();
  });
  // × 閉じる
  $("lightbox-close").addEventListener("click", (e) => { e.stopPropagation(); closeLightbox(); });
  // 前へ / 次へ
  $("lightbox-prev").addEventListener("click", (e) => { e.stopPropagation(); lightboxNav(-1); });
  $("lightbox-next").addEventListener("click", (e) => { e.stopPropagation(); lightboxNav(1); });
  // メイン画像クリックでは閉じない(誤操作防止)
  $("lightbox-img").addEventListener("click", (e) => e.stopPropagation());
  // ← → で前後送り、Esc で閉じる
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").style.display !== "flex") return;
    if (e.key === "ArrowLeft") { e.preventDefault(); lightboxNav(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); lightboxNav(1); }
    else if (e.key === "Escape") { e.preventDefault(); closeLightbox(); }
  });

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
  // 素材除外ボタンの文言・状態を初期化(画像一覧固定)
  updateViewModeBtns();
  updateWrapBtn();
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
