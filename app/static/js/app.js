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
    throw new Error((data && data.detail) || `请求失败 (${resp.status})`);
  }
  return data;
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
  if (name === 'study') refreshDeck();
  if (name === 'manage') { loadCards(); loadTypes(); }
  if (name === 'wrongbook') loadWrongBook();
  if (name === 'settings') loadAISettings();
}

/** 搜索防抖 */
let searchTimer = null;
function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadCards, 300);
}

/* ==================== 2. 学习模式 ==================== */

// 牌组状态：当前题目序列、索引、本轮对错统计
const studyState = {
  deck: [],          // 当前牌组（题目数组）
  index: 0,          // 当前卡片下标
  mode: 'all',       // all=全部 / wrong=错题重练
  shuffle: false,    // 打乱开关
  stats: { correct: 0, wrong: 0 }, // 本轮统计
};

async function refreshDeck() {
  try {
    const cards = await api(`/api/study/deck?mode=${studyState.mode}&shuffle=${studyState.shuffle}`);
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
  document.getElementById('cardTypeFront').textContent = card.question_type;
  document.getElementById('cardTypeBack').textContent = card.question_type;

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

/* ==================== 3. 题库管理 ==================== */

const cardListState = { page: 1, pageSize: 10 };

/** 加载题目列表（含搜索/筛选/分页） */
async function loadCards() {
  const search = document.getElementById('searchInput').value.trim();
  const type = document.getElementById('typeFilter').value;
  try {
    const params = new URLSearchParams({
      page: cardListState.page,
      page_size: cardListState.pageSize,
      search,
      question_type: type,
    });
    const data = await api(`/api/cards?${params}`);
    const listEl = document.getElementById('cardsList');
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
          <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-primary border border-indigo-100">${escapeHtml(card.question_type)}</span>
          <span class="text-[11px] text-slate-400">${sourceLabel(card.source)}</span>
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
  document.getElementById('tInput').value = card ? card.question_type : '问答';
  document.getElementById('summaryInput').value = card ? card.ai_summary : '';
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
    question_type: document.getElementById('tInput').value.trim() || '问答',
    ai_summary: document.getElementById('summaryInput').value.trim(),
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
    loadCards();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'error');
  }
}

/** 删除题目（二次确认） */
async function deleteCard(id) {
  if (!confirm('确定删除这道题目吗？相关错题记录也会一并删除。')) return;
  try {
    await api(`/api/cards/${id}`, { method: 'DELETE' });
    toast('已删除', 'success');
    loadCards();
  } catch (e) {
    toast(`删除失败：${e.message}`, 'error');
  }
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
      loadCards();
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
  checkAIConfigured();
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

/** 导入方式切换：AI 模式显示数量输入 */
function onModeChange() {
  const isAI = document.querySelector('input[name="importMode"]:checked').value === 'ai';
  document.getElementById('aiCountWrap').classList.toggle('hidden', !isAI);
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

  try {
    if (mode === 'rule') {
      await importByRule(pasteText);
    } else {
      await importByAI(pasteText);
    }
  } catch (e) {
    toast(`导入失败：${e.message}`, 'error');
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

/** AI 提取导入：先拿文本 → 调 AI → 渲染预览列表 */
async function importByAI(pasteText) {
  toast('正在提取文本…', 'info');
  const data = await api('/api/import/file', { method: 'POST', body: buildFormData(pasteText, true) });

  toast(`AI 正在分析 ${data.text_length} 字符的笔记，可能需要一两分钟…`, 'info');
  const gen = await api('/api/ai/generate', {
    method: 'POST',
    body: { text: data.text, count: parseInt(document.getElementById('aiCount').value) || 15 },
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
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-white text-primary border border-indigo-100">${escapeHtml(item.question_type)}</span>
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
    const data = await api('/api/ai/confirm', { method: 'POST', body: { items } });
    toast(`入库成功：新增 ${data.inserted} 题${data.skipped ? `，跳过重复 ${data.skipped} 题` : ''}`, 'success');
    closeImportModal();
    switchView('manage');
  } catch (e) {
    toast(`入库失败：${e.message}`, 'error');
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
              <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-primary border border-indigo-100">${escapeHtml(card.question_type)}</span>
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
