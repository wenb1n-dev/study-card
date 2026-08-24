/**
 * 学习卡片 StudyCard - 前端应用逻辑
 *
 * 模块划分：
 *  1. 通用：API 封装、Toast、视图切换
 *  2. 学习模式：牌组加载 / 翻转 / 对错标记 / 键盘快捷键
 *  3. 题库管理：列表搜索分页 / 新增编辑删除弹窗
 *  4. 导入笔记：文件上传 / 规则解析与 AI 提取 / 预览确认入库
 *  5. 错题本：列表 / 移除 / 重练
 *  6. AI 设置：配置读写 / 连接测试
 */

'use strict';

/* ==================== 1. 通用工具 ==================== */

/** API 请求封装：统一 JSON 处理与错误抛出 */
async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const resp = await fetch(path, opts);
  if (resp.status === 204) return null;
  let data = null;
  try { data = await resp.json(); } catch (_) { /* 非 JSON 响应忽略 */ }
  if (!resp.ok) {
    throw new Error(apiErrorText(data) || `请求失败 (${resp.status})`);
  }
  return data;
}

/** 将后端错误响应转换为可读文案（兼容 FastAPI 的 detail 为字符串/对象/校验错误数组） */
function apiErrorText(data) {
  if (!data) return '';
  const d = data.detail;
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d.map(e => {
      const where = Array.isArray(e.loc) ? e.loc.slice(1).join('.') : '';
      return where ? `${where}: ${e.msg}` : e.msg;
    }).join('；');
  }
  if (typeof d === 'object') return Object.values(d).join('；');
  return String(d);
}

/** Toast 轻提示：type = success | error | info */
function toast(message, type = 'info') {
  const colors = {
    success: 'bg-green-600',
    error: 'bg-red-500',
    info: 'bg-indigo-900',
  };
  const el = document.createElement('div');
  el.className = `toast-item pointer-events-auto ${colors[type]} text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg max-w-md`;
  el.textContent = message;
  document.getElementById('toastBox').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, type === 'error' ? 4200 : 2600);
}

/** 视图切换（学习/题库管理/错题本/AI设置） */
function switchView(name) {
  // 隐藏全部视图，显示目标视图
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${name}`).classList.remove('hidden');

  // 同步导航高亮态
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const active = btn.dataset.nav === name;
    btn.classList.toggle('bg-indigo-100', active);
    btn.classList.toggle('text-primary', active);
  });

  // 进入视图时按需刷新数据
  if (name === 'study') {
    // 学习题库由管理界面「学习题库设置」配置；文件夹「去学习」可临时覆盖（不持久化）
    studyState.deckIds = deckState.studyOverride
      ? deckState.studyOverride
      : getStudyDeckConfig();
    deckState.studyOverride = null;
    refreshDeck();
  }
  if (name === 'manage') { loadDecks(); updateManageMode(); loadTypes(); }
  if (name === 'wrongbook') loadWrongBook();
  if (name === 'settings') loadAISettings();
}

/** 搜索防抖 */
let searchTimer = null;
function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(updateManageMode, 300);
}

/* ==================== 2. 学习模式 ==================== */

// 牌组状态：当前题目序列、索引、本轮对错统计
const studyState = {
  deck: [],          // 当前牌组（题目数组）
  index: 0,          // 当前卡片下标
  mode: 'all',       // all=全部 / wrong=错题重练
  shuffle: false,    // 打乱开关
  deckIds: [],       // 选中的题库主题 ID 列表（空数组 = 全部题库）
  stats: { correct: 0, wrong: 0 }, // 本轮统计
};

async function refreshDeck() {
  try {
    // 多选题库：以逗号拼接选中的题库 ID 传入后端过滤（空=全部）
    const deckParam = (studyState.deckIds && studyState.deckIds.length) ? `&deck_ids=${studyState.deckIds.join(',')}` : '';
    const cards = await api(`/api/study/deck?mode=${studyState.mode}&shuffle=${studyState.shuffle}${deckParam}`);
    studyState.deck = cards;
    studyState.index = 0;
    studyState.stats = { correct: 0, wrong: 0 };
    renderCurrentCard();
  } catch (e) {
    toast(`加载牌组失败：${e.message}`, 'error');
  }
}

function renderCurrentCard() {
  const { deck, index } = studyState;

  // 空牌组 / 全部学完 的空状态展示
  const emptyBox = document.getElementById('deckEmpty');
  const doneBox = document.getElementById('deckDone');
  const cardArea = document.getElementById('cardArea');

  if (deck.length === 0) {
    cardArea.classList.add('hidden');
    doneBox.classList.add('hidden');
    emptyBox.classList.remove('hidden');
    document.getElementById('deckEmptyText').textContent =
      studyState.mode === 'wrong' ? '错题本是空的，先去学习中标记几道错题吧' : '题库为空，去「题库管理」添加题目吧';
    updateProgress();
    return;
  }

  if (index >= deck.length) {
    // 一轮完成：展示统计并引导复习错题
    cardArea.classList.add('hidden');
    emptyBox.classList.add('hidden');
    doneBox.classList.remove('hidden');
    const goWrongBtn = document.getElementById('goWrongBookBtn');
    goWrongBtn.classList.toggle('hidden', studyState.stats.wrong === 0);
    document.getElementById('doneStats').textContent =
      `本轮 ${deck.length} 题 · 会了 ${studyState.stats.correct} · 不会 ${studyState.stats.wrong}`;
    return;
  }

  cardArea.classList.remove('hidden');
  doneBox.classList.add('hidden');
  emptyBox.classList.add('hidden');

  const card = deck[index];
  // 填充正反面内容；类型徽章两面同步
  document.getElementById('cardQuestion').textContent = card.question;
  document.getElementById('cardAnswer').innerHTML = renderAnswer(card.answer);
  // AI 补充讲解按 Markdown 渲染（与答案一致的 marked + DOMPurify 管线）
  const hasSummary = Boolean(card.ai_summary);
  document.getElementById('cardAiSummary').innerHTML = renderAnswer(card.ai_summary || '');
  // 有讲解才分两栏并显示右栏；无讲解则单栏满宽展示答案
  document.getElementById('aiSummaryBox').classList.toggle('hidden', !hasSummary);
  document.getElementById('aiExplainCol').classList.toggle('hidden', !hasSummary);
  document.getElementById('cardBackGrid').classList.toggle('lg:grid-cols-2', hasSummary);
  // 标题栏按钮文案随状态变化：有讲解显示「重新讲解」
  const labelEl = document.getElementById('aiExplainLabelCard');
  if (labelEl && !labelEl.dataset.loading) labelEl.textContent = hasSummary ? '重新讲解' : 'AI 讲解';
  // 类型徽章：分类/主题 + 所属题库名，便于区分多题库
  let frontLabel = card.question_type || '未分类';
  if (card.deck_name) frontLabel += ` · ${card.deck_name}`;
  document.getElementById('cardTypeFront').textContent = frontLabel;
  document.getElementById('cardTypeBack').textContent = frontLabel;

  // 切换题目时复位到正面
  unflip();

  // 错题模式下额外提示错误次数
  if (studyState.mode === 'wrong' && card.wrong_count > 1) {
    document.getElementById('cardTypeFront').textContent += ` · 错过 ${card.wrong_count} 次`;
  }

  updateProgress();
}

/**
 * 答案渲染：Markdown → 安全 HTML
 * 主路径：marked 解析（GFM 表格/代码块/删除线）+ DOMPurify 消毒防 XSS 注入
 * 降级：CDN 库不可用时转义 HTML 并保留换行，保证内容始终可读
 */
function renderAnswer(text) {
  if (window.marked && window.DOMPurify) {
    try {
      marked.setOptions({ gfm: true, breaks: true });
      return DOMPurify.sanitize(marked.parse(text));
    } catch (_) { /* 解析异常走降级 */ }
  }
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function updateProgress() {
  const { deck, index } = studyState;
  document.getElementById('progressText').textContent = `${Math.min(index, deck.length)} / ${deck.length}`;
  const pct = deck.length ? Math.min(100, (index / deck.length) * 100) : 0;
  document.getElementById('progressBar').style.width = `${pct}%`;
}

/** 翻转卡片 */
function flipCard() {
  document.getElementById('flipCard').classList.toggle('flipped');
}
function unflip() {
  document.getElementById('flipCard').classList.remove('flipped');
}

/** 标记答题结果：wrong 进错题本 / correct 移出错题本 */
async function markResult(result) {
  const { deck, index } = studyState;
  if (index >= deck.length) return;
  const card = deck[index];

  try {
    await api(`/api/study/${card.card_id}/result`, { method: 'POST', body: { result } });
    studyState.stats[result]++;
    toast(result === 'correct' ? '已掌握，继续保持！' : '已加入错题本', result === 'correct' ? 'success' : 'info');
    // 自动翻页到下一题
    nextCard(true);
    // 同步导航栏错题角标
    refreshWrongBadge();
  } catch (e) {
    toast(`记录失败：${e.message}`, 'error');
  }
}

function nextCard(auto = false) {
  if (!auto) unflip();
  if (studyState.index < studyState.deck.length) {
    studyState.index++;
    renderCurrentCard();
  }
}

function prevCard() {
  if (studyState.index > 0) {
    studyState.index--;
    renderCurrentCard();
  }
}

/** 再来一轮：重新加载当前模式的牌组 */
function restartDeck() {
  refreshDeck();
}

/** 牌组模式切换：全部 / 错题 */
function setDeckMode(mode) {
  studyState.mode = mode;
  document.getElementById('modeAllBtn').className =
    `deck-mode-btn cursor-pointer px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-200 ${mode === 'all' ? 'bg-primary text-white' : 'text-slate-500 hover:bg-indigo-50'}`;
  document.getElementById('modeWrongBtn').className =
    `deck-mode-btn cursor-pointer px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-200 ${mode === 'wrong' ? 'bg-danger text-white' : 'text-slate-500 hover:bg-indigo-50'}`;
  refreshDeck();
}

/** 打乱开关切换 */
function toggleShuffle() {
  studyState.shuffle = !studyState.shuffle;
  const btn = document.getElementById('shuffleToggle');
  btn.setAttribute('aria-checked', String(studyState.shuffle));
  btn.classList.toggle('bg-primary', studyState.shuffle);
  btn.classList.toggle('bg-gray-300', !studyState.shuffle);
  const knob = btn.querySelector('span');
  knob.classList.toggle('translate-x-5', studyState.shuffle);
  knob.classList.toggle('translate-x-0', !studyState.shuffle);
  refreshDeck();
}

/** 从错题本发起重练：切到学习视图的 wrong 模式 */
function startWrongPractice() {
  switchView('study');
  setDeckMode('wrong');
}

/** 键盘快捷键：空格翻转、←→切题、1/2 标记 */
document.addEventListener('keydown', (e) => {
  // 弹窗打开或输入框聚焦时不响应
  if (document.querySelector('.modal-overlay:not(.hidden)')) return;
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!document.getElementById('view-study') || document.getElementById('view-study').classList.contains('hidden')) return;

  if (e.code === 'Space') { e.preventDefault(); flipCard(); }
  else if (e.key === 'ArrowRight') nextCard();
  else if (e.key === 'ArrowLeft') prevCard();
  else if (e.key === '1') markResult('wrong');
  else if (e.key === '2') markResult('correct');
});

/* ==================== 2.5 题库主题（文件夹式管理 + 学习配置） ==================== */

// 题库主题状态
const deckState = {
  list: [],                  // [{id, name, card_count}]
  expanded: new Set(),       // 管理视图中已展开的文件夹（按 deck id）
  studyOverride: null,       // 临时学习指定题库（来自文件夹「去学习」按钮），不持久化
};

// 学习题库选择配置（localStorage 持久化，空数组表示学习全部）
const STUDY_DECK_KEY = 'studyDeckIds';
function getStudyDeckConfig() {
  try { return JSON.parse(localStorage.getItem(STUDY_DECK_KEY) || '[]'); }
  catch { return []; }
}
function setStudyDeckConfig(ids) {
  localStorage.setItem(STUDY_DECK_KEY, JSON.stringify(ids));
}

/** 拉取题库主题列表并刷新管理视图的文件夹 */
async function loadDecks() {
  try {
    deckState.list = await api('/api/decks');
  } catch (e) {
    toast(`加载题库列表失败：${e.message}`, 'error');
    deckState.list = [];
  }
  renderDeckFolders();
}

/** 渲染管理视图的文件夹列表（每个题库一个文件夹，点击展开题目） */
function renderDeckFolders() {
  const box = document.getElementById('deckFolders');
  if (!box) return;
  box.innerHTML = '';
  if (deckState.list.length === 0) {
    box.innerHTML = '<div class="text-center py-16 text-slate-400 text-sm">还没有题库，点击右上角「新建题库」开始吧</div>';
    return;
  }
  for (const d of deckState.list) {
    box.appendChild(buildFolderEl(d));
  }
}

/** 构建单个题库文件夹元素 */
function buildFolderEl(d) {
  const open = deckState.expanded.has(d.id);
  const folder = document.createElement('div');
  folder.className = 'bg-white rounded-card border border-indigo-100 shadow-sm overflow-hidden';

  // 文件夹头部：点击展开/收起；右侧常驻操作按钮（去学习/重命名/删除），比悬浮图标更友好
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'w-full flex items-center gap-2 px-4 py-3 text-left cursor-pointer transition-colors duration-200 hover:bg-indigo-50/60 focus:outline-none focus-visible:ring-2 ring-primary';
  header.innerHTML = `
    <svg class="w-4 h-4 text-primary transition-transform duration-200 ${open ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
    <svg class="w-5 h-5 text-primary/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    <span class="font-bold text-sm flex-1 truncate">${escapeHtml(d.name)}</span>
    <span class="text-xs text-slate-400">${d.card_count} 题</span>
  `;
  header.onclick = () => toggleFolder(d.id);

  // 操作按钮组（常驻显示，避免悬浮才出现导致不易操作）
  const ops = document.createElement('div');
  ops.className = 'flex items-center gap-1 shrink-0';
  ops.onclick = (e) => e.stopPropagation();
  ops.appendChild(folderActionBtn('去学习', 'M5 3l14 9-14 9V3z', () => startStudyDeck(d.id)));
  ops.appendChild(folderActionBtn('AI 分类', 'M12 3l1.9 5.7L19.6 10l-5.7 1.9L12 17.6l-1.9-5.7L4.4 10l5.7-1.3z', () => autoCategorizeAll(d.id)));
  ops.appendChild(folderActionBtn('重命名', 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z', () => renameDeck(d.id, d.name)));
  ops.appendChild(folderActionBtn('删除', 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', () => deleteDeck(d.id, d.name), true));
  header.appendChild(ops);

  // 文件夹内容区（展开时加载该题库题目）
  const body = document.createElement('div');
  body.id = `folder-body-${d.id}`;
  body.className = `border-t border-indigo-100 ${open ? '' : 'hidden'}`;
  if (open) loadFolderCards(d.id, body);

  folder.appendChild(header);
  folder.appendChild(body);
  return folder;
}

/** 文件夹头部操作按钮（小号文字+图标） */
function folderActionBtn(label, path, onClick, danger = false) {
  const b = document.createElement('button');
  b.type = 'button';
  const color = danger
    ? 'text-danger hover:bg-danger/10'
    : 'text-slate-500 hover:bg-indigo-50 hover:text-primary';
  b.className = `inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium cursor-pointer transition-colors duration-200 ${color}`;
  b.innerHTML = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>${label}`;
  b.onclick = onClick;
  return b;
}

/** 展开/收起文件夹，首次展开时加载题目 */
function toggleFolder(id) {
  if (deckState.expanded.has(id)) deckState.expanded.delete(id);
  else deckState.expanded.add(id);
  const body = document.getElementById(`folder-body-${id}`);
  if (!body) return;
  const open = deckState.expanded.has(id);
  body.classList.toggle('hidden', !open);
  // 同步箭头旋转
  const header = body.previousElementSibling;
  const chevron = header?.querySelector('svg');
  if (chevron) chevron.classList.toggle('rotate-90', open);
  if (open) loadFolderCards(id, body);
}

/** 加载某题库下的题目并渲染到文件夹内容区 */
async function loadFolderCards(deckId, bodyEl) {
  bodyEl.innerHTML = '<div class="px-4 py-6 text-center text-xs text-slate-400">加载中…</div>';
  try {
    const params = new URLSearchParams({ page: 1, page_size: 100, deck_id: deckId });
    const data = await api(`/api/cards?${params}`);
    bodyEl.innerHTML = '';
    if (data.total === 0) {
      bodyEl.innerHTML = '<div class="px-4 py-10 text-center text-sm text-slate-400">该题库还没有题目，点击上方「新增题目」或「导入笔记」添加</div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'p-3 grid gap-3 max-h-[42vh] overflow-y-auto';
    for (const card of data.items) grid.appendChild(buildCardItem(card));
    bodyEl.appendChild(grid);
  } catch (e) {
    bodyEl.innerHTML = `<div class="px-4 py-6 text-center text-xs text-danger">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

/* ---------- 通用确认 / 输入弹窗（替代原生 confirm / prompt，统一视觉风格） ---------- */

let promptModalState = null;

/**
 * 打开通用弹窗
 * @param {Object} opt {title, message, value, placeholder, confirmText, danger, onConfirm(value)}
 *   - danger: true 时呈现删除警示样式（红），否则为主题色（用于重命名/新建）
 *   - 传 value 或 placeholder 时显示输入框；否则为纯确认弹窗
 */
function openPromptModal(opt) {
  const titleEl = document.getElementById('promptModalTitle');
  const msgEl = document.getElementById('promptModalMsg');
  const inputEl = document.getElementById('promptModalInput');
  const iconEl = document.getElementById('promptModalIcon');
  const confirmBtn = document.getElementById('promptModalConfirm');

  titleEl.textContent = opt.title || '提示';
  msgEl.textContent = opt.message || '';

  // 输入框：仅在需要输入时显示
  if (opt.value !== undefined || opt.placeholder !== undefined) {
    inputEl.classList.remove('hidden');
    inputEl.value = opt.value || '';
    inputEl.placeholder = opt.placeholder || '';
  } else {
    inputEl.classList.add('hidden');
    inputEl.value = '';
  }

  // 图标与确认按钮样式：删除用危险色警示，其余用主题色
  if (opt.danger) {
    iconEl.className = 'shrink-0 w-10 h-10 rounded-full flex items-center justify-center bg-danger/10 text-danger';
    iconEl.innerHTML = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    confirmBtn.className = 'px-5 py-2.5 rounded-xl bg-danger text-white text-sm font-bold cursor-pointer transition-colors duration-200 hover:bg-red-600 focus:outline-none focus-visible:ring-2 ring-danger';
  } else {
    iconEl.className = 'shrink-0 w-10 h-10 rounded-full flex items-center justify-center bg-primary/10 text-primary';
    iconEl.innerHTML = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
    confirmBtn.className = 'px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-bold cursor-pointer transition-colors duration-200 hover:bg-primaryLight focus:outline-none focus-visible:ring-2 ring-primary';
  }
  confirmBtn.textContent = opt.confirmText || '确定';

  promptModalState = opt;
  showModal('promptModal');
  // 含输入框时自动聚焦并全选，方便直接覆盖输入
  if (!inputEl.classList.contains('hidden')) {
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
  }
}

/** 确认按钮：取值后回调并关闭 */
function confirmPromptModal() {
  if (!promptModalState) return;
  const inputEl = document.getElementById('promptModalInput');
  const value = inputEl.classList.contains('hidden') ? null : inputEl.value.trim();
  const cb = promptModalState.onConfirm;
  closePromptModal();
  if (cb) cb(value);
}

/** 关闭通用弹窗 */
function closePromptModal() {
  hideModal('promptModal');
  promptModalState = null;
}

/* ---------- 题库 CRUD ---------- */

/** 新建题库主题，建好后自动展开该文件夹 */
function createDeck() {
  openPromptModal({
    title: '新建题库主题',
    message: '为新的题库主题输入名称',
    placeholder: '例如：Kafka 核心概念',
    confirmText: '创建',
    onConfirm: async (name) => {
      if (!name) return;
      try {
        const d = await api('/api/decks', { method: 'POST', body: { name } });
        toast('题库已创建', 'success');
        deckState.expanded.add(d.id);  // 新建后自动展开
        await loadDecks();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
  });
}

/** 重命名题库主题 */
function renameDeck(id, oldName) {
  openPromptModal({
    title: '重命名题库主题',
    message: '为该题库主题输入新的名称',
    value: oldName,
    placeholder: '请输入新的题库名称',
    confirmText: '重命名',
    onConfirm: async (name) => {
      if (!name) return;
      try {
        await api(`/api/decks/${id}`, { method: 'PUT', body: { name } });
        toast('题库已重命名', 'success');
        await loadDecks();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
  });
}

/** 删除题库主题（级联删除其下题目） */
function deleteDeck(id, name) {
  openPromptModal({
    title: '删除题库主题',
    message: `确定删除题库「${name}」吗？其下全部题目将一并删除，且不可恢复。`,
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      try {
        await api(`/api/decks/${id}`, { method: 'DELETE' });
        toast('题库已删除', 'success');
        deckState.expanded.delete(id);
        await loadDecks();
        // 同步学习配置：移除被删题库
        setStudyDeckConfig(getStudyDeckConfig().filter(x => x !== id));
        refreshDeck();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
  });
}

/* ---------- 学习题库设置（管理界面配置学习界面的题库） ---------- */

/** 打开「学习题库设置」弹窗 */
function openStudyDeckSettings() {
  const list = document.getElementById('studyDeckCheckList');
  const cfg = getStudyDeckConfig();
  list.innerHTML = deckState.list.map(d => `
    <label class="flex items-center gap-3 p-3 rounded-xl border-2 border-indigo-100 cursor-pointer transition-colors duration-200 hover:bg-indigo-50/50 has-[:checked]:border-primary has-[:checked]:bg-indigo-50/70">
      <input type="checkbox" class="study-deck-check accent-[#4F46E5] w-4 h-4" value="${d.id}" ${cfg.includes(d.id) ? 'checked' : ''}>
      <span class="text-sm font-medium flex-1">${escapeHtml(d.name)}</span>
      <span class="text-xs text-slate-400">${d.card_count} 题</span>
    </label>
  `).join('');
  document.getElementById('studyDeckCheckAll').checked =
    deckState.list.length > 0 && deckState.list.every(d => cfg.includes(d.id));
  showModal('studyDeckModal');
}

/** 全选/取消全选 */
function toggleStudyDeckCheckAll(checked) {
  document.querySelectorAll('.study-deck-check').forEach(c => { c.checked = checked; });
}

/** 保存学习题库配置 */
function saveStudyDeckSettings() {
  const ids = [...document.querySelectorAll('.study-deck-check')]
    .filter(c => c.checked).map(c => parseInt(c.value, 10));
  setStudyDeckConfig(ids);
  closeStudyDeckSettings();
  toast('学习题库已更新', 'success');
}

/** 从文件夹「去学习」直接进入该题库学习（临时覆盖配置，不修改持久设置） */
function startStudyDeck(deckId) {
  deckState.studyOverride = [deckId];
  switchView('study');
}

/** 关闭学习题库设置弹窗 */
function closeStudyDeckSettings() {
  hideModal('studyDeckModal');
}

/* ---------- 下拉菜单（按功能分组的生产力操作） ---------- */

/** 切换指定下拉菜单的显示，并先关闭其它已展开菜单 */
function toggleDropdown(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const willOpen = el.classList.contains('hidden');
  closeDropdowns();
  if (willOpen) el.classList.remove('hidden');
}

/** 关闭所有下拉菜单 */
function closeDropdowns() {
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
}

// 点击菜单以外区域自动收起下拉
document.addEventListener('click', (e) => {
  if (!e.target.closest('.relative')) closeDropdowns();
});

/** 调用后端 AI 批量识别并写回所有未分类题目的「分类/主题」 */
/**
 * AI 自动分类：仅为「未分类」题目补充主题标签，已分类题目不受影响。
 * @param {number|null} deckId 指定题库则只处理该题库的未分类题目；缺省处理全部未分类题目
 */
async function autoCategorizeAll(deckId = null) {
  const btn = document.getElementById('autoCateBtn');
  if (btn) { btn.disabled = true; btn.classList.add('opacity-60', 'cursor-wait'); }
  toast('正在调用 AI 为未分类题目打标，已分类题目不会变动…', 'info');
  try {
    const url = deckId ? `/api/ai/auto-categorize?deck_id=${deckId}` : '/api/ai/auto-categorize';
    const data = await api(url, { method: 'POST' });
    if (data.total === 0) {
      toast('没有需要分类的题目（均已分类）', 'success');
    } else if (data.updated === 0) {
      toast(`共 ${data.total} 道未分类题目，AI 暂无法判断其主题`, 'info');
    } else {
      toast(`已为 ${data.total} 道未分类题目打标，成功 ${data.updated} 道`, 'success');
    }
    await refreshManageData();   // 刷新文件夹徽章
  } catch (e) {
    toast(`自动分类失败：${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('opacity-60', 'cursor-wait'); }
  }
}

/* ==================== 3. 题库管理 ==================== */

const cardListState = { page: 1, pageSize: 10 };

/** 当前是否处于搜索/筛选模式（有搜索词或类型筛选） */
function isSearchMode() {
  const s = document.getElementById('searchInput')?.value.trim();
  const t = document.getElementById('typeFilter')?.value;
  return Boolean(s || t);
}

/** 根据是否搜索切换「文件夹」与「搜索结果」两种视图 */
function updateManageMode() {
  const folders = document.getElementById('deckFolders');
  const results = document.getElementById('searchResults');
  const pag = document.getElementById('pagination');
  const meta = document.getElementById('cardsMeta');
  if (isSearchMode()) {
    folders.classList.add('hidden');
    results.classList.remove('hidden');
    pag.classList.remove('hidden');
    meta.classList.remove('hidden');
    loadCards();
  } else {
    results.classList.add('hidden');
    results.innerHTML = '';
    pag.classList.add('hidden');
    meta.classList.add('hidden');
    folders.classList.remove('hidden');
  }
}

/** 题目增删改/导入后刷新管理视图数据（保持文件夹展开态） */
async function refreshManageData() {
  await loadDecks();
  if (isSearchMode()) loadCards();
}

/** 加载题目列表（搜索/筛选/分页，跨全部题库） */
async function loadCards() {
  const search = document.getElementById('searchInput').value.trim();
  const type = document.getElementById('typeFilter').value;
  try {
    const params = new URLSearchParams({
      page: cardListState.page,
      page_size: cardListState.pageSize,
      search,
      question_type: type,
      deck_id: 0,  // 搜索模式跨全部题库
    });
    const data = await api(`/api/cards?${params}`);
    const listEl = document.getElementById('searchResults');
    document.getElementById('cardsMeta').textContent = `共 ${data.total} 题`;
    listEl.innerHTML = '';

    if (data.total === 0) {
      listEl.innerHTML = '<div class="text-center py-16 text-slate-400 text-sm">没有匹配的题目</div>';
      renderPagination(0);
      return;
    }

    for (const card of data.items) {
      listEl.appendChild(buildCardItem(card));
    }
    renderPagination(data.total);
  } catch (e) {
    toast(`加载题目失败：${e.message}`, 'error');
  }
}

/** 类型筛选变化：重置页码并切换视图 */
function onManageFilterChange() {
  cardListState.page = 1;
  updateManageMode();
}

/** 构建单条题目列表项 */
function buildCardItem(card) {
  const div = document.createElement('div');
  div.className = 'bg-white rounded-card border border-indigo-100 p-4 shadow-sm cursor-pointer transition-colors duration-200 hover:border-primaryLight/60 hover:shadow-md';
  div.onclick = () => openCardModal(card);

  // 摘要截断，完整内容点击查看
  const qShort = card.question.length > 60 ? card.question.slice(0, 60) + '…' : card.question;
  const aShort = card.answer.replace(/\n/g, ' ').length > 90
    ? card.answer.replace(/\n/g, ' ').slice(0, 90) + '…'
    : card.answer.replace(/\n/g, ' ');

  div.innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 mb-1 flex-wrap">
              <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-primary border border-indigo-100">${escapeHtml(card.question_type || '未分类')}</span>
          <span class="text-[11px] text-slate-400">${sourceLabel(card.source)}</span>
          ${card.deck_name ? `<span class="text-[11px] text-indigo-500 bg-indigo-50/60 px-1.5 py-0.5 rounded-full">${escapeHtml(card.deck_name)}</span>` : ''}
        </div>
        <h3 class="font-bold text-sm mb-1 truncate">${escapeHtml(qShort)}</h3>
        <p class="text-xs text-slate-500 line-clamp-2 leading-relaxed">${escapeHtml(aShort)}</p>
      </div>
      <div class="flex shrink-0 gap-1" onclick="event.stopPropagation()">
        <button title="AI 总结" onclick='aiSummarizeCard(${card.id})'
          class="p-2 rounded-lg text-slate-400 transition-colors duration-200 hover:bg-indigo-50 hover:text-primary cursor-pointer">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.7L19.6 10l-5.7 1.9L12 17.6l-1.9-5.7L4.4 10l5.7-1.3z"/></svg>
        </button>
        <button title="编辑" onclick="openCardModalById(${card.id})"
          class="p-2 rounded-lg text-slate-400 transition-colors duration-200 hover:bg-indigo-50 hover:text-primary cursor-pointer">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button title="删除" onclick="deleteCard(${card.id})"
          class="p-2 rounded-lg text-slate-400 transition-colors duration-200 hover:bg-red-50 hover:text-danger cursor-pointer">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>`;
  return div;
}

/** 来源标签文案 */
function sourceLabel(source) {
  return { manual: '手工录入', import: '笔记导入', ai: 'AI 生成' }[source] || source;
}

/** HTML 转义防注入 */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 分页控件渲染 */
function renderPagination(total) {
  const box = document.getElementById('pagination');
  box.innerHTML = '';
  const pages = Math.ceil(total / cardListState.pageSize);
  if (pages <= 1) return;

  for (let p = 1; p <= pages; p++) {
    const btn = document.createElement('button');
    btn.textContent = p;
    btn.className = `w-9 h-9 rounded-xl text-sm font-bold cursor-pointer transition-colors duration-200 ${
      p === cardListState.page ? 'bg-primary text-white' : 'bg-white border border-indigo-100 hover:bg-indigo-50'}`;
    btn.onclick = () => { cardListState.page = p; loadCards(); };
    box.appendChild(btn);
  }
}

/** 加载问题类型下拉选项 */
async function loadTypes() {
  try {
    const types = await api('/api/cards/types');
    const select = document.getElementById('typeFilter');
    const current = select.value;
    // 保留「全部类型」+ 动态类型
    select.innerHTML = '<option value="">全部类型</option>' +
      types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    select.value = current;
  } catch (_) { /* 非关键数据，失败静默 */ }
}

/* ---------- 题目新增/编辑弹窗 ---------- */

function openCardModal(card = null) {
  document.getElementById('cardModalTitle').textContent = card ? '编辑题目' : '新增题目';
  document.getElementById('editCardId').value = card ? card.id : '';
  document.getElementById('qInput').value = card ? card.question : '';
  document.getElementById('aInput').value = card ? card.answer : '';
  document.getElementById('tInput').value = card ? card.question_type : '';
  document.getElementById('summaryInput').value = card ? card.ai_summary : '';
  // 填充「所属题库」下拉：优先用题目原题库，其次用管理视图当前选中题库
  const sel = document.getElementById('deckInput');
  sel.innerHTML = deckState.list.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  const preferred = card ? card.deck_id : (deckState.list[0] && deckState.list[0].id);
  sel.value = preferred || '';
  // 导入来源的题目编辑时提醒勿篡改原文答案
  document.getElementById('editWarn').classList.toggle('hidden', !card || card.source === 'manual');
  showModal('cardModal');
  document.getElementById('qInput').focus();
}

async function openCardModalById(id) {
  try {
    const card = await api(`/api/cards/${id}`);
    openCardModal(card);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function closeCardModal() {
  hideModal('cardModal');
}

/** 提交题目表单：区分新增与编辑 */
async function submitCardForm(e) {
  e.preventDefault();
  const id = document.getElementById('editCardId').value;
  const body = {
    question: document.getElementById('qInput').value.trim(),
    answer: document.getElementById('aInput').value.trim(),
    question_type: document.getElementById('tInput').value.trim(),
    ai_summary: document.getElementById('summaryInput').value.trim(),
    deck_id: parseInt(document.getElementById('deckInput').value, 10) || 0,
  };
  try {
    if (id) {
      await api(`/api/cards/${id}`, { method: 'PUT', body });
      toast('题目已更新', 'success');
    } else {
      await api('/api/cards', { method: 'POST', body });
      toast('题目已添加', 'success');
    }
    closeCardModal();
    refreshManageData();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'error');
  }
}

/** 删除题目（二次确认，使用统一样式弹窗） */
function deleteCard(id) {
  openPromptModal({
    title: '删除题目',
    message: '确定删除这道题目吗？相关错题记录也会一并删除，且不可恢复。',
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      try {
        await api(`/api/cards/${id}`, { method: 'DELETE' });
        toast('已删除', 'success');
        refreshManageData();
      } catch (e) {
        toast(`删除失败：${e.message}`, 'error');
      }
    }
  });
}

/** 在表单中调用 AI 结合问题+答案生成补充讲解 */
async function aiSummarizeFromForm(btn) {
  const question = document.getElementById('qInput').value.trim();
  const answer = document.getElementById('aInput').value.trim();
  const cardId = document.getElementById('editCardId').value.trim();
  if (!question && !answer) { toast('请先填写问题或答案内容', 'error'); return; }

  // 按钮内联加载态：显示 spinner、隐藏图标、文字改为「生成中…」、禁用防重复点击
  const spinner = document.getElementById('aiExplainSpinner');
  const spark = document.getElementById('aiExplainSpark');
  const label = document.getElementById('aiExplainLabel');
  if (btn) { btn.disabled = true; }
  if (spinner) spinner.classList.remove('hidden');
  if (spark) spark.classList.add('hidden');
  if (label) label.textContent = '生成中…';

  try {
    await doSummarize(question, answer, async s => {
      const input = document.getElementById('summaryInput');
      input.value = s;
      // 已有卡片：生成后即时回写数据库，无需再点保存也能持久化
      if (cardId) {
        await api(`/api/cards/${cardId}`, { method: 'PUT', body: { ai_summary: s } });
        toast('AI 补充讲解已保存', 'success');
      } else {
        toast('已填入讲解，保存题目后即可持久化', 'success');
      }
    });
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (spinner) spinner.classList.add('hidden');
    if (spark) spark.classList.remove('hidden');
    if (label) label.textContent = 'AI 讲解';
  }
}

/** 在列表中为指定卡片生成补充讲解并回写 */
async function aiSummarizeCard(id) {
  try {
    const card = await api(`/api/cards/${id}`);
    await doSummarize(card.question, card.answer, async s => {
      await api(`/api/cards/${id}`, { method: 'PUT', body: { ai_summary: s } });
      toast('AI 补充讲解已保存', 'success');
      refreshManageData();
    });
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** 在学习卡片背面临时生成补充讲解：生成后回写并立即显示在背面 */
async function aiExplainCurrentCard() {
  const { deck, index } = studyState;
  if (index >= deck.length) return;
  const card = deck[index];

  // 按钮内联加载态：复用卡片内 spinner/spark/label 元素（与表单按钮一致）
  const btn = document.getElementById('aiExplainBtn');
  const grid = document.getElementById('cardBackGrid');
  const col = document.getElementById('aiExplainCol');
  const box = document.getElementById('aiSummaryBox');
  const text = document.getElementById('cardAiSummary');
  const spinner = document.getElementById('aiExplainSpinnerCard');
  const spark = document.getElementById('aiExplainSparkCard');
  const label = document.getElementById('aiExplainLabelCard');
  btn.disabled = true;
  if (label) label.dataset.loading = '1';
  if (spinner) spinner.classList.remove('hidden');
  if (spark) spark.classList.add('hidden');
  if (label) label.textContent = '生成中…';
  try {
    await doSummarize(card.question, card.answer, async s => {
      // 回写持久化
      await api(`/api/cards/${card.card_id}`, { method: 'PUT', body: { ai_summary: s } });
      // 同步内存牌组，并直接更新背面讲解区（不重渲染整卡，避免翻回正面）
      card.ai_summary = s;
      text.innerHTML = renderAnswer(s);
      // 显示右栏并切换为双栏布局，呈现 AI 讲解内容
      col.classList.remove('hidden');
      grid.classList.add('lg:grid-cols-2');
      box.classList.remove('hidden');
      toast('AI 补充讲解已生成', 'success');
    });
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    if (label) delete label.dataset.loading;
    if (spinner) spinner.classList.add('hidden');
    if (spark) spark.classList.remove('hidden');
    // 生成结束后文案随是否已有讲解变化
    if (label) label.textContent = card.ai_summary ? '重新讲解' : 'AI 讲解';
  }
}

/** 总结公共逻辑：调接口 + 按钮加载态；结合问题与答案 */
async function doSummarize(question, answer, onDone) {
  toast('AI 正在生成补充讲解…', 'info');
  try {
    const data = await api('/api/ai/summarize', { method: 'POST', body: { question, answer } });
    onDone(data.summary);
  } catch (e) {
    toast(`AI 补充讲解生成失败：${e.message}`, 'error');
  }
}

/* ==================== 4. 导入笔记 ==================== */

// 导入状态：暂存的文件对象与 AI 预览结果
const importState = { file: null, previewItems: [] };

function openImportModal() {
  showStep1();
  showModal('importModal');
  // 每次打开清空上次残留的导入信息（文件 / 粘贴文本 / 预览 / 错误提示）
  clearImportInputs();
  clearImportError();
  // 填充「导入到题库」下拉，默认选中第一个题库
  const sel = document.getElementById('importDeckInput');
  sel.innerHTML = deckState.list.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  if (deckState.list[0]) sel.value = deckState.list[0].id;
  checkAIConfigured();
}

/** 清空导入弹窗内的输入残留，保证每次打开都是干净状态 */
function clearImportInputs() {
  importState.file = null;
  importState.previewItems = [];
  const pa = document.getElementById('pasteArea');
  if (pa) pa.value = '';
  const fi = document.getElementById('fileInput');
  if (fi) fi.value = '';
}

/** 在弹窗内持久展示导入错误（避免一闪而过） */
function showImportError(msg) {
  const el = document.getElementById('importError');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  console.error('[导入失败]', msg);
}
function clearImportError() {
  const el = document.getElementById('importError');
  if (el) { el.classList.add('hidden'); el.textContent = ''; }
}
function closeImportModal() {
  hideModal('importModal');
  resetImportUI();
}
function showStep1() {
  document.getElementById('importStep1').classList.remove('hidden');
  document.getElementById('importStep2').classList.add('hidden');
}
function backToStep1() {
  importState.previewItems = [];
  showStep1();
}
function resetImportUI() {
  importState.file = null;
  importState.previewItems = [];
  document.getElementById('pasteArea').value = '';
  document.getElementById('fileInput').value = '';
  showStep1();
}

/** 弹窗显隐控制 */
function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id).classList.add('hidden'); }

/** 检查 AI 是否已配置，未配置时在 AI 选项上提示 */
async function checkAIConfigured() {
  try {
    const cfg = await api('/api/ai/settings');
    const ok = Boolean(cfg.api_url && cfg.model);
    document.getElementById('aiNotConfiguredTip').classList.toggle('hidden', ok);
    if (!ok) {
      // 未配置时自动选中规则模式
      document.querySelector('input[name="importMode"][value="rule"]').checked = true;
    }
    onModeChange();
  } catch (_) { /* 忽略 */ }
}

/** 导入方式切换：AI 模式显示归类选项；仅「自动生成」显示数量上限 */
function onModeChange() {
  const v = document.querySelector('input[name="importMode"]:checked').value;
  const isAI = v === 'ai-extract' || v === 'ai-generate';
  document.getElementById('aiCatWrap').classList.toggle('hidden', !isAI);
  // 题目数量上限仅「自动生成题库」需要；智能提取由 AI 按笔记自行决定数量
  document.getElementById('aiCountWrap').classList.toggle('hidden', v !== 'ai-generate');
}

/* ---------- 文件交互 ---------- */

function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('border-primary', 'bg-indigo-50');
}
function handleDragLeave(e) {
  e.currentTarget.classList.remove('border-primary', 'bg-indigo-50');
}
function handleDrop(e) {
  e.preventDefault();
  handleDragLeave(e);
  if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
}
function handleFileSelect(file) {
  if (!file) return;
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  if (!['.md', '.markdown', '.txt', '.pdf'].includes(ext)) {
    toast('仅支持 md / txt / pdf 文件', 'error');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    toast('文件超过 20MB 限制', 'error');
    return;
  }
  importState.file = file;
  // 上传区回显文件名
  document.getElementById('dropZone').querySelector('p').innerHTML =
    `<span class="text-primary font-bold">${escapeHtml(file.name)}</span>（${(file.size / 1024).toFixed(1)} KB）已选择`;
  // 点击可重新选择
  document.getElementById('dropZone').onclick = () => document.getElementById('fileInput').click();
}

/** 开始导入入口：根据方式分发到规则解析或 AI 流程 */
async function startImport() {
  const mode = document.querySelector('input[name="importMode"]:checked').value;
  const pasteText = document.getElementById('pasteArea').value.trim();

  if (!importState.file && !pasteText) {
    toast('请选择文件或粘贴笔记文本', 'error');
    return;
  }

  const btn = document.getElementById('importGoBtn');
  btn.disabled = true;
  btn.textContent = '处理中…';
  clearImportError();

  try {
    if (mode === 'rule') {
      await importByRule(pasteText);
    } else {
      await importByAI(pasteText);
    }
  } catch (e) {
    // 在弹窗内持久展示完整错误，避免一闪而过；同时给一个短提示
    showImportError(`导入失败：${e.message}`);
    toast('导入失败，详见弹窗内提示', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '开始导入';
  }
}

/** 组装上传 FormData（文件优先，无文件用粘贴文本） */
function buildFormData(pasteText, useAI) {
  const fd = new FormData();
  if (importState.file) {
    fd.append('file', importState.file);
  } else {
    // 无文件时把粘贴文本包装成 txt Blob 走同一通道
    fd.append('file', new Blob([pasteText], { type: 'text/plain' }), 'pasted-notes.txt');
  }
  fd.append('use_ai', useAI);
  // 导入到弹窗中选择的题库
  fd.append('deck_id', parseInt(document.getElementById('importDeckInput').value, 10) || 0);
  if (useAI) fd.append('count', document.getElementById('aiCount').value || 15);
  return fd;
}

/** 规则解析导入：解析后直接入库，报告结果 */
async function importByRule(pasteText) {
  const data = await api('/api/import/file', { method: 'POST', body: buildFormData(pasteText, false) });
  if (data.inserted > 0) {
    toast(`导入成功：新增 ${data.inserted} 题${data.skipped ? `，跳过重复 ${data.skipped} 题` : ''}`, 'success');
    closeImportModal();
    switchView('manage');
  } else {
    toast(`未新增任何题目（跳过重复 ${data.skipped} 题）`, 'info');
  }
}

/** AI 提取/生成导入：先拿文本 → 调 AI → 渲染预览列表 */
async function importByAI(pasteText) {
  const mode = document.querySelector('input[name="importMode"]:checked').value;
  const genMode = mode === 'ai-generate' ? 'generate' : 'extract';
  toast('正在提取文本…', 'info');
  const data = await api('/api/import/file', { method: 'POST', body: buildFormData(pasteText, true) });

  toast(`AI 正在分析 ${data.text_length} 字符的笔记，可能需要一两分钟…`, 'info');
  const gen = await api('/api/ai/generate', {
    method: 'POST',
    body: {
      text: data.text,
      count: parseInt(document.getElementById('aiCount').value) || 15,
      auto_category: document.getElementById('autoCategory').checked,
      mode: genMode,
    },
  });

  importState.previewItems = gen.items.map(it => ({ ...it, selected: true }));
  renderPreviewList();
  document.getElementById('importStep1').classList.add('hidden');
  document.getElementById('importStep2').classList.remove('hidden');
}

/** 渲染 AI 预览列表（每项带勾选框） */
function renderPreviewList() {
  const box = document.getElementById('previewList');
  box.innerHTML = '';
  document.getElementById('previewCount').textContent = `${importState.previewItems.length} 题`;

  importState.previewItems.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'border border-indigo-100 rounded-xl p-4 bg-bg/60';
    div.innerHTML = `
      <label class="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" data-preview="${i}" ${item.selected ? 'checked' : ''}
          onchange="togglePreview(${i}, this.checked)" class="mt-1 accent-[#4F46E5] shrink-0">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 mb-1.5">
            <label class="text-[11px] font-semibold text-slate-400 shrink-0">分类</label>
            <input type="text" data-typeedit="${i}" value="${escapeHtml(item.question_type || '')}"
              oninput="importState.previewItems[${i}].question_type = this.value.trim()"
              placeholder="如 kafka / redis / mysql"
              class="flex-1 min-w-0 px-2 py-1 rounded-lg bg-white border border-indigo-100 text-[11px] focus:outline-none focus:ring-2 focus:ring-primary">
          </div>
          <p class="font-bold text-sm mb-1.5 break-words">${escapeHtml(item.question)}</p>
          <p class="text-xs text-slate-500 whitespace-pre-wrap break-words line-clamp-4">${escapeHtml(item.answer)}</p>
           ${item.ai_summary ? `<p class="mt-2 text-[11px] text-slate-400 border-t border-dashed border-indigo-100 pt-1.5">AI 补充讲解：${escapeHtml(item.ai_summary)}</p>` : ''}
        </div>
      </label>`;
    box.appendChild(div);
  });

  syncConfirmButton();
}

function togglePreview(i, checked) {
  importState.previewItems[i].selected = checked;
  syncConfirmButton();
}
function toggleAllPreview(checked) {
  importState.previewItems.forEach(it => { it.selected = checked; });
  renderPreviewList();
}
function syncConfirmButton() {
  const anySelected = importState.previewItems.some(it => it.selected);
  document.getElementById('confirmImportBtn').disabled = !anySelected;
  document.getElementById('confirmImportBtn').textContent =
    anySelected ? `确认入库（${importState.previewItems.filter(it => it.selected).length} 题）` : '请至少选择一题';
}

/** 确认入库：将勾选的预览项提交后端批量写入 */
async function confirmImport() {
  const items = importState.previewItems.filter(it => it.selected)
    .map(({ selected, ...rest }) => rest); // 剥离前端勾选字段
  const btn = document.getElementById('confirmImportBtn');
  btn.disabled = true;
  try {
    const data = await api('/api/ai/confirm', { method: 'POST', body: { items, deck_id: parseInt(document.getElementById('importDeckInput').value, 10) || 0 } });
    toast(`入库成功：新增 ${data.inserted} 题${data.skipped ? `，跳过重复 ${data.skipped} 题` : ''}`, 'success');
    closeImportModal();
    switchView('manage');
  } catch (e) {
    showImportError(`入库失败：${e.message}`);
    toast('入库失败，详见弹窗内提示', 'error');
    btn.disabled = false;
  }
}

/* ==================== 5. 错题本 ==================== */

async function loadWrongBook() {
  try {
    const items = await api('/api/wrongbook');
    const listEl = document.getElementById('wrongList');
    document.getElementById('wrongMeta').textContent = `共 ${items.length} 题`;

    document.getElementById('wrongEmpty').classList.toggle('hidden', items.length > 0);
    document.getElementById('practiceWrongBtn').disabled = items.length === 0;
    // 空列表时隐藏列表容器，让空态提示占满固定高度区域
    listEl.classList.toggle('hidden', items.length === 0);
    listEl.innerHTML = '';

    items.forEach(card => {
      const div = document.createElement('div');
      div.className = 'bg-white rounded-card border border-red-100 p-4 shadow-sm';
      const qShort = card.question.length > 70 ? card.question.slice(0, 70) + '…' : card.question;
      const aShort = card.answer.replace(/\n/g, ' ').length > 110
        ? card.answer.replace(/\n/g, ' ').slice(0, 110) + '…' : card.answer.replace(/\n/g, ' ');
      div.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1 cursor-pointer" onclick='showWrongDetail(${JSON.stringify(card.card_id)})'>
            <div class="flex items-center gap-2 mb-1 flex-wrap">
              <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-50 text-danger border border-red-100">错过 ${card.wrong_count} 次</span>
          <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-primary border border-indigo-100">${escapeHtml(card.question_type || '未分类')}</span>
              <span class="text-[11px] text-slate-400">最近答错：${escapeHtml(card.last_wrong_at || '')}</span>
            </div>
            <h3 class="font-bold text-sm mb-1 break-words">${escapeHtml(qShort)}</h3>
            <p class="text-xs text-slate-500 leading-relaxed break-words">${escapeHtml(aShort)}</p>
          </div>
          <button title="移出错题本（已掌握）" onclick="removeFromWrong(${card.card_id})"
            class="shrink-0 p-2 rounded-lg text-slate-400 transition-colors duration-200 hover:bg-green-50 hover:text-green-600 cursor-pointer">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
        </div>`;
      listEl.appendChild(div);
    });
    refreshWrongBadge();
  } catch (e) {
    toast(`加载错题本失败：${e.message}`, 'error');
  }
}

/** 点击错题查看完整答案（弹窗复用编辑弹窗的只读形态） */
async function showWrongDetail(id) {
  await openCardModalById(id);
}

/** 移出错题本（标记为已掌握） */
async function removeFromWrong(cardId) {
  try {
    await api(`/api/study/${cardId}/result`, { method: 'POST', body: { result: 'correct' } });
    toast('已移出错题本', 'success');
    loadWrongBook();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** 刷新导航栏错题角标数量 */
async function refreshWrongBadge() {
  try {
    const data = await api('/api/wrongbook/count');
    const badge = document.getElementById('wrongBadge');
    badge.textContent = data.count;
    badge.classList.toggle('hidden', data.count === 0);
  } catch (_) { /* 静默 */ }
}

/* ==================== 6. AI 设置 ==================== */

async function loadAISettings() {
  try {
    const cfg = await api('/api/ai/settings');
    document.getElementById('apiUrlInput').value = cfg.api_url || '';
    // 密钥脱敏回显；已配置时提示留空不覆盖
    document.getElementById('apiKeyInput').value = cfg.api_key || '';
    document.getElementById('keyHint').classList.toggle('hidden', !cfg.api_key_masked);
    document.getElementById('modelInput').value = cfg.model || '';
  } catch (e) {
    toast(`读取配置失败：${e.message}`, 'error');
  }
}

async function saveAISettings(e) {
  e.preventDefault();
  try {
    await api('/api/ai/settings', {
      method: 'PUT',
      body: {
        api_url: document.getElementById('apiUrlInput').value.trim(),
        api_key: document.getElementById('apiKeyInput').value.trim(),
        model: document.getElementById('modelInput').value.trim(),
      },
    });
    toast('AI 配置已保存', 'success');
    loadAISettings();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'error');
  }
}

async function testAIConnection() {
  const statusEl = document.getElementById('testStatus');
  const btn = document.getElementById('testBtn');
  statusEl.textContent = '';
  statusEl.className = 'text-xs text-slate-400';
  statusEl.textContent = '测试中…';
  btn.disabled = true;
  try {
    const data = await api('/api/ai/test', {
      method: 'POST',
      body: {
        api_url: document.getElementById('apiUrlInput').value.trim(),
        api_key: document.getElementById('apiKeyInput').value.trim(),
        model: document.getElementById('modelInput').value.trim(),
      },
    });
    statusEl.className = 'text-xs text-green-600 font-semibold';
    statusEl.textContent = `连接成功 ✓ ${data.reply}`;
  } catch (e) {
    statusEl.className = 'text-xs text-red-500';
    statusEl.textContent = `连接失败：${e.message}`.slice(0, 120);
  } finally {
    btn.disabled = false;
  }
}

/* ==================== 页面初始化 ==================== */

window.addEventListener('DOMContentLoaded', () => {
  // 默认进入学习视图；后台同步错题角标
  switchView('study');
  refreshWrongBadge();
});
