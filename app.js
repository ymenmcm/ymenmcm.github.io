const config = window.MODEL_HUB_CONFIG;

const categoryLabels = {
  problem: "题目",
  article: "文章",
  code: "代码"
};

const state = {
  activeCategory: "problem",
  categories: {
    problem: [],
    article: [],
    code: []
  },
  submitting: false
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  linkForm: $("#linkForm"),
  resourceTitle: $("#resourceTitle"),
  resourceUrl: $("#resourceUrl"),
  uploaderName: $("#uploaderName"),
  submissionNote: $("#submissionNote"),
  submitButton: $("#submitButton"),
  linkError: $("#linkError"),
  libraryGrid: $("#libraryGrid"),
  librarySummary: $("#librarySummary"),
  refreshRecords: $("#refreshRecords"),
  toast: $("#toast"),
  toastTitle: $("#toastTitle"),
  toastText: $("#toastText")
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function encodeMetadata(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeMetadata(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function showToast(title, text, type = "success") {
  elements.toastTitle.textContent = title;
  elements.toastText.textContent = text;
  elements.toast.classList.toggle("error", type === "error");
  elements.toast.classList.add("show");
  elements.toast.setAttribute("aria-hidden", "false");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove("show");
    elements.toast.setAttribute("aria-hidden", "true");
  }, 4200);
}

function selectedCategory() {
  return $('input[name="category"]:checked')?.value || "problem";
}

function selectCategory(category, shouldScroll = false) {
  if (!categoryLabels[category]) return;
  state.activeCategory = category;
  $$(".library-tabs [data-category]").forEach((button) => {
    const active = button.dataset.category === category;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderLibrary();
  if (shouldScroll) {
    $("#library").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function normalizeUrl(rawValue) {
  const value = String(rawValue || "").trim();
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("链接必须以 http:// 或 https:// 开头。");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new Error("请输入公网访问地址，不能使用本机或局域网地址。");
  }
  return url.href;
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function shuffled(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

async function writeLink(category, metadata) {
  const namespaces = shuffled(config.metadata.namespaces[category]);
  const path = `links/${Date.now()}-${metadata.id}.${encodeMetadata(metadata)}`;
  let lastError = null;

  for (const namespace of namespaces) {
    const response = await fetch(`${config.metadata.endpoint}/${namespace}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    if (response.ok) return;
    lastError = response.status;
    if (response.status !== 413) break;
  }

  throw new Error(`链接索引写入失败（${lastError || "网络错误"}），请稍后重试。`);
}

async function fetchCategory(category) {
  const namespaces = config.metadata.namespaces[category];
  const responses = await Promise.all(
    namespaces.map(async (namespace) => {
      const response = await fetch(
        `${config.metadata.endpoint}/list/${namespace}?${Date.now()}`,
        { cache: "no-store" }
      );
      if (response.status === 404) return [];
      if (!response.ok) {
        throw new Error(`读取${categoryLabels[category]}失败（${response.status}）`);
      }
      return (await response.json()).entries || [];
    })
  );

  return responses
    .flat()
    .flatMap((entry) => {
      if (!entry.path?.startsWith("links/")) return [];
      const encoded = entry.path.split(".").at(-1);
      try {
        const metadata = decodeMetadata(encoded);
        if (
          metadata.category !== category ||
          !metadata.url ||
          !["http:", "https:"].includes(new URL(metadata.url).protocol)
        ) {
          return [];
        }
        return [{ ...metadata, host: new URL(metadata.url).hostname.replace(/^www\./, "") }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function loadAllCategories(showFeedback = false) {
  elements.refreshRecords.disabled = true;
  elements.refreshRecords.classList.add("is-loading");
  try {
    const [problem, article, code] = await Promise.all([
      fetchCategory("problem"),
      fetchCategory("article"),
      fetchCategory("code")
    ]);
    state.categories = { problem, article, code };
    renderCounts();
    renderLibrary();
    if (showFeedback) showToast("资料库已更新", "三个分区的链接均已重新读取。");
  } catch (error) {
    elements.librarySummary.textContent = "资料库暂时无法读取";
    elements.libraryGrid.innerHTML = `
      <div class="library-empty">
        <span>!</span>
        <p>${escapeHtml(error.message)}</p>
        <small>请稍后点击刷新重试</small>
      </div>
    `;
    if (showFeedback) showToast("读取失败", error.message, "error");
  } finally {
    elements.refreshRecords.disabled = false;
    elements.refreshRecords.classList.remove("is-loading");
  }
}

function renderCounts() {
  for (const category of Object.keys(categoryLabels)) {
    const count = state.categories[category].length;
    $(`#${category}Count`).textContent = count;
    $(`#${category}SideCount`).textContent = count;
  }
}

function renderLibrary() {
  const category = state.activeCategory;
  const links = state.categories[category];
  elements.librarySummary.textContent =
    `${categoryLabels[category]}分区 · ${links.length} 个资源 · 所有人可见`;

  if (!links.length) {
    elements.libraryGrid.innerHTML = `
      <div class="library-empty">
        <span>∅</span>
        <p>${categoryLabels[category]}分区还没有资源</p>
        <small>发布链接后，所有访问者都能在这里看到</small>
      </div>
    `;
    return;
  }

  elements.libraryGrid.innerHTML = links
    .map((link) => `
      <article class="library-file resource-card" data-category="${category}">
        <div class="library-file-top">
          <span class="resource-domain">${escapeHtml(link.host.slice(0, 20))}</span>
          <span class="library-date">${formatDate(link.createdAt)}</span>
        </div>
        <h3 title="${escapeHtml(link.title)}">${escapeHtml(link.title)}</h3>
        <p>${escapeHtml(link.note || "未填写资源说明")}</p>
        <div class="library-file-meta">
          <span>${escapeHtml(link.uploader || "匿名用户")}</span>
          <span>${escapeHtml(link.host)}</span>
        </div>
        <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">
          打开外部资源
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 5h5v5M19 5l-8 8"/>
            <path d="M18 14v5H5V6h5"/>
          </svg>
        </a>
      </article>
    `)
    .join("");
}

elements.linkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.submitting) return;

  elements.linkError.textContent = "";
  const category = selectedCategory();
  const title = cleanText(elements.resourceTitle.value, 100);
  const note = cleanText(elements.submissionNote.value, 120);
  const uploader = cleanText(elements.uploaderName.value || "匿名用户", 30);
  let url;

  try {
    url = normalizeUrl(elements.resourceUrl.value);
  } catch (error) {
    elements.linkError.textContent = error.message;
    elements.resourceUrl.focus();
    return;
  }

  if (title.length < 2) {
    elements.linkError.textContent = "资源标题至少需要 2 个字符。";
    elements.resourceTitle.focus();
    return;
  }

  const duplicate = state.categories[category].some((link) => link.url === url);
  if (duplicate) {
    elements.linkError.textContent = `这个链接已经存在于${categoryLabels[category]}分区。`;
    return;
  }

  state.submitting = true;
  elements.submitButton.disabled = true;
  elements.submitButton.querySelector("span").textContent = "正在发布";

  try {
    const metadata = {
      id: crypto.randomUUID(),
      title,
      url,
      note,
      uploader,
      category,
      createdAt: new Date().toISOString()
    };
    await writeLink(category, metadata);
    if (uploader !== "匿名用户") {
      localStorage.setItem("ymenmcm:uploader", uploader);
    }
    elements.resourceTitle.value = "";
    elements.resourceUrl.value = "";
    elements.submissionNote.value = "";
    await loadAllCategories();
    selectCategory(category, true);
    showToast("发布成功", `链接已加入${categoryLabels[category]}分区。`);
  } catch (error) {
    elements.linkError.textContent = error.message;
    showToast("发布失败", error.message, "error");
  } finally {
    state.submitting = false;
    elements.submitButton.disabled = false;
    elements.submitButton.querySelector("span").textContent = "发布到资料库";
  }
});

$$(".library-tabs [data-category]").forEach((button) => {
  button.addEventListener("click", () => selectCategory(button.dataset.category));
});

$$('[data-nav-category]').forEach((link) => {
  link.addEventListener("click", () => selectCategory(link.dataset.navCategory));
});

elements.refreshRecords.addEventListener("click", () => loadAllCategories(true));

function initialize() {
  elements.uploaderName.value =
    localStorage.getItem("ymenmcm:uploader") ||
    localStorage.getItem("model-commons:uploader") ||
    "";
  loadAllCategories();
}

initialize();
