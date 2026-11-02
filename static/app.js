'use strict';

const FLAGS = new URLSearchParams(location.search);
const state = {
  backend: FLAGS.get('backend') === 'demo2' ? 'demo2' : 'demo1',
  threads: [], current: null, thread: null, poll: null, busy: false,
  drafts: {},
};

/* ------------------------------------------------------------------ helpers */
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (ms) => (ms == null ? '' : (ms / 1000).toFixed(2) + 's');
const num = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : '—');
const pct = (v) => Math.max(0, Math.min(100, Math.round((v || 0) * 100))) + '%';

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({ error: '返回不是 JSON' }));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function setQuery(key, value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  history.replaceState(null, '', url);
}

function nearBottom() {
  const box = $('stream');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}
function toBottom(force) {
  const box = $('stream');
  if (force || nearBottom()) box.scrollTop = box.scrollHeight;
}

const BACKEND_NAMES = { demo1: '情绪记忆', demo2: '记忆动力学' };
const MODE_NAMES = { 'two-state': '双状态', 'weight-only': '单权重' };

/* ------------------------------------------------------------------ sidebar */
async function loadThreads() {
  const data = await api('/api/threads?backend=' + state.backend);
  state.threads = data.threads;
  const profile = (data.profile || '').replace(/^api:/, '');
  $('mode').textContent = `${data.label} · ${data.mode} · ${profile}`;
  renderThreads();
  return data.threads;
}

function renderThreads() {
  const box = $('threads');
  box.replaceChildren();
  state.threads.forEach((t) => {
    const b = el('button', 'thread' + (t.id === state.current ? ' on' : ''));
    b.append(el('span', '', t.title));
    const bits = [`${t.turns} 轮`, t.id.slice(-4)];
    if (t.mode) bits.unshift(MODE_NAMES[t.mode] || t.mode);
    if (t.ratings) bits.push(`评 ${t.ratings}`);
    b.append(el('small', '', bits.join(' · ')));
    b.onclick = () => selectThread(t.id);
    box.append(b);
  });
}

async function newThread(mode) {
  const created = await api('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend: state.backend, mode }),
  });
  await loadThreads();
  await selectThread(created.id);
}

/* ------------------------------------------------------------------ backend */
async function setBackend(name) {
  if (state.busy || name === state.backend) return;
  state.backend = name;
  setQuery('backend', name);
  document.querySelectorAll('#switch .tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.backend === name);
  });
  $('new').hidden = name === 'demo2';
  $('modes').hidden = name !== 'demo2';
  const threads = await loadThreads();
  if (threads.length) await selectThread(threads[0].id);
  else await newThread(name === 'demo2' ? 'two-state' : null);
}

/* ------------------------------------------------------------------ thread */
async function selectThread(id) {
  state.current = id;
  if (state.poll) { clearTimeout(state.poll); state.poll = null; }
  loadDrafts(id);
  renderThreads();
  const thread = await api('/api/threads/' + id);
  state.thread = thread;
  paintHeader(thread);
  paintMessages(thread.messages);
  syncDraftBar();
  if (thread.active) {
    // The step kept running while the page was away; pick its log back up.
    const placeholder = assistantNode({ events: [], phase: '处理', now: 0 }, true);
    $('stream').append(placeholder);
    toBottom(true);
    pollRun(thread.active, placeholder, thread.id).catch(() => {
      placeholder.querySelector('.answer').textContent = '这一轮的执行记录不在内存里了（服务重启过），刷新看看结果。';
    });
  }
}

function paintHeader(thread) {
  $('title').textContent = thread.title;
  const s = thread.state;
  const bits = [`step ${s.step}`, `库 ${s.library} 条`];
  if (thread.mode) bits.push(MODE_NAMES[thread.mode] || thread.mode);
  $('meta').textContent = bits.join(' · ');
}

function paintMessages(messages) {
  const box = $('stream');
  box.replaceChildren();
  if (!messages.length) {
    box.append(emptyState());
    return;
  }
  messages.forEach((m) => {
    if (m.role === 'user') {
      const wrap = el('div', 'msg user');
      wrap.append(el('div', 'bubble', m.text));
      box.append(wrap);
    } else {
      box.append(assistantNode(m, false));
    }
  });
  toBottom(true);
}

function emptyState() {
  const empty = el('div', 'empty');
  const library = (state.thread && state.thread.state.memories) || [];
  if (state.backend === 'demo2') {
    empty.append(el('p', '', '记忆动力学：只有权重和稳定性，没有情绪。'));
    empty.append(el('p', 'dim',
      '每轮先整体衰减，再按 relevance × weight 检索。被引用的记忆恢复权重；' +
      '反复使用还会变稳，于是衰减得更慢。'));
    if (!library.length) {
      const seed = el('button', 'seed', '预置 4 条示例记忆');
      seed.onclick = async () => {
        seed.disabled = true;
        try {
          await api(`/api/threads/${state.current}/seed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: SAMPLE_MEMORIES }),
          });
          await selectThread(state.current);
        } catch (error) {
          seed.textContent = '预置失败：' + error.message;
          seed.disabled = false;
        }
      };
      empty.append(seed);
      empty.append(el('p', 'tiny', '也可以直接说话，空库照样能跑，只是没有东西可衰减。'));
    } else {
      empty.append(el('p', 'dim', `库里已有 ${library.length} 条，说一句话开始。`));
      empty.append(libraryBody(library));
    }
    return empty;
  }
  empty.append(el('p', '', '这个 runtime 有情绪和记忆。'));
  empty.append(el('p', 'dim', '说一句话，它会检索、评估、写入，然后回答。运行链默认折叠在回答上方。'));
  return empty;
}

const SAMPLE_MEMORIES = [
  '周三下午要和米拉过一遍进度，她喜欢会前收到书面材料。',
  '备用钥匙在厨房橱柜上方的蓝色铁盒里。',
  '项目代号是白鹭，对外不要提这个名字。',
  '连续开会超过一小时会明显疲劳，中间需要休息。',
];

/* ------------------------------------------------------------------ message */
function assistantNode(message, running) {
  const wrap = el('article', 'msg assistant');
  const runId = message.run || message.id;
  if (runId) wrap.dataset.run = runId;
  wrap.append(chainNode(message, running));
  const answer = el('div', 'answer');
  if (message.error) {
    answer.classList.add('error');
    answer.textContent = '这一轮没有通过校验，状态没有改变。\n' + message.error;
  } else if (message.answer) {
    answer.textContent = message.answer;
  }
  wrap.append(answer);
  if (!running && runId && !message.error) wrap.append(ratingNode(message, runId));
  return wrap;
}

/* ---------------------------------------------------------- rating draft
   Scores are drafted in the browser first. Nothing reaches the server until
   the user presses 发送, and a batch can rewrite judgements from earlier turns.
   They are logged, never fed back into the runtime. */
function draftsKey(threadId) { return 'harness.draft.' + threadId; }

function loadDrafts(threadId) {
  state.drafts = {};
  if (!threadId) return;
  try {
    const raw = JSON.parse(localStorage.getItem(draftsKey(threadId)) || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) state.drafts = raw;
  } catch (error) { state.drafts = {}; }
}

function persistDrafts() {
  if (state.current) {
    const keys = Object.keys(state.drafts);
    if (keys.length) localStorage.setItem(draftsKey(state.current), JSON.stringify(state.drafts));
    else localStorage.removeItem(draftsKey(state.current));
  }
  syncDraftBar();
}

function pendingDrafts() {
  return Object.entries(state.drafts)
    .filter(([, d]) => d && d.score)
    .map(([run, d]) => ({ run, score: d.score, note: (d.note || '').trim() }));
}

function messageByRun(runId) {
  const list = (state.thread && state.thread.messages) || [];
  return list.find((m) => m.role === 'assistant' && m.run === runId) || null;
}

function setDraft(runId, patch, keepEditor) {
  // A draft starts from whatever is already on the server, so editing only the
  // score does not wipe the note that came with it.
  let base = state.drafts[runId];
  if (!base) {
    const saved = (messageByRun(runId) || {}).rating;
    base = saved ? { score: saved.score, note: saved.note || '' } : {};
  }
  state.drafts[runId] = { ...base, ...patch, at: Date.now() };
  persistDrafts();
  repaintRating(runId, keepEditor);
}

function repaintRating(runId, keepEditor) {
  const host = document.querySelector(`.msg.assistant[data-run="${runId}"]`);
  const old = host && host.querySelector('.rating');
  if (!old) return;
  const message = messageByRun(runId) || {};
  old.replaceWith(ratingNode(message, runId, keepEditor));
}

function syncDraftBar() {
  const items = pendingDrafts();
  const bar = $('draftbar');
  const info = $('draftinfo');
  bar.hidden = !items.length;
  if (!items.length) return;
  const rewrites = items.filter(({ run }) => {
    const saved = (messageByRun(run) || {}).rating;
    const draft = state.drafts[run];
    return saved && (saved.score !== draft.score || (saved.note || '') !== (draft.note || ''));
  }).length;
  const bits = [`${items.length} 条评分待发送`];
  if (rewrites) bits.push(`其中 ${rewrites} 条是改的`);
  if (Object.keys(state.drafts).length > items.length) bits.push('有未打分的草稿');
  info.textContent = bits.join(' · ');
}

function ratingNode(message, runId, keepEditor) {
  const wrap = el('div', 'rating');
  const saved = message.rating || null;
  const draft = state.drafts[runId] || null;
  const shown = draft || saved || {};
  const changed = !!draft && (!saved
    || saved.score !== draft.score
    || (saved.note || '') !== (draft.note || ''));

  wrap.append(el('span', 'rate-label', '评分'));
  const stars = el('span', 'stars');
  for (let i = 1; i <= 5; i += 1) {
    const b = el('button', 'star' + (shown.score >= i ? ' on' : ''), String(i));
    b.title = ['很差', '较差', '一般', '不错', '很好'][i - 1] + '（改完要点发送）';
    b.onclick = () => setDraft(runId, { score: i }, keepEditor);
    stars.append(b);
  }
  wrap.append(stars);

  const noteBtn = el('button', 'note-btn', (shown.note ? '评价 · 已写' : '＋ 评价'));
  const editor = el('div', 'rate-editor');
  editor.hidden = !keepEditor;
  const ta = document.createElement('textarea');
  ta.rows = 2;
  ta.placeholder = '这条回答好在哪、差在哪（先点分数）';
  ta.value = shown.note || '';
  const save = el('button', 'save', '记下');
  save.onclick = () => {
    const score = (state.drafts[runId] || {}).score || shown.score;
    if (!score) {
      ta.placeholder = '先点上面的分数，再写评价';
      return;
    }
    setDraft(runId, { score, note: ta.value }, true);
  };
  editor.append(ta, save);
  const noteText = shown.note ? el('span', 'rate-note', shown.note) : null;
  if (noteText) noteText.hidden = !editor.hidden;
  noteBtn.onclick = () => {
    editor.hidden = !editor.hidden;
    if (noteText) noteText.hidden = !editor.hidden;
    if (!editor.hidden) ta.focus();
  };
  wrap.append(noteBtn);
  if (changed) {
    const tag = el('span', 'rate-status hot', saved ? '已改 · 待发送' : '待发送');
    wrap.append(tag);
  } else if (saved) {
    wrap.append(el('span', 'rate-status', '已提交 ' + fmtTime(saved.at)));
  }
  if (noteText) wrap.append(noteText);
  wrap.append(editor);
  wrap.append(el('span', 'tiny', saved && !changed ? '再点一次可改，改了要重新发送' : '暂存在浏览器，发送后进日志'));
  return wrap;
}

async function flushDrafts() {
  const items = pendingDrafts();
  if (!items.length) return;
  const btn = $('draftSend');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const res = await api(`/api/threads/${state.current}/ratings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratings: items }),
    });
    Object.entries(res.ratings).forEach(([run, rating]) => {
      const message = messageByRun(run);
      if (message) message.rating = rating;
      delete state.drafts[run];
    });
    persistDrafts();
    Object.keys(res.ratings).forEach((run) => repaintRating(run));
    await refreshThumb(state.current);
  } catch (error) {
    alert('没有发送成功：' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '发送';
    syncDraftBar();
  }
}

function discardDrafts() {
  const runs = Object.keys(state.drafts);
  if (!runs.length) return;
  if (!confirm(`撤销 ${runs.length} 条还没发送的评分？`)) return;
  state.drafts = {};
  persistDrafts();
  runs.forEach((run) => repaintRating(run));
}

/* ------------------------------------------------------------------ run chain */
function chainNode(message, running) {
  const trace = message.trace;
  const events = message.events || [];
  const chain = document.createElement('details');
  chain.className = 'chain';
  chain.open = running || FLAGS.has('expand') || FLAGS.has('all');

  const summary = document.createElement('summary');
  summary.append(el('span', 'chev'));
  const label = el('span', 'label');
  const stats = el('span', 'stats');
  const dur = el('span', 'dur');
  summary.append(label, stats, dur);
  chain.append(summary);

  const stages = el('div', 'stages');
  chain.append(stages);

  if (running) {
    label.className = 'label shimmer';
    label.textContent = '正在运行 · ' + (message.phase || '准备');
    dur.textContent = (message.now || 0).toFixed(1) + 's';
    stages.append(...runningStages(events));
  } else if (trace && trace.decayed) {
    label.textContent = '运行链 · 记忆动力学';
    const stat = (text, hot) => stats.append(el('span', 'chip' + (hot ? ' hot' : ''), text));
    const rows = trace.retrieval || [];
    const picked = rows.filter((r) => r.selected).length;
    if (rows.length) stat(`检索 ${picked}/${rows.length}`);
    else stat('检索 · 库是空的');
    if (trace.activated.length) stat(`激活 ${trace.activated.length}`);
    if (trace.written_ids.length) stat(`写入 ${trace.written_ids.length}`);
    dur.textContent = message.elapsed != null ? `已处理 ${message.elapsed.toFixed(1)}s` : '';
    stages.append(...doneStagesDynamics(trace, events));
  } else if (trace) {
    label.textContent = '运行链';
    const stat = (text, hot) => stats.append(el('span', 'chip' + (hot ? ' hot' : ''), text));
    const rows = trace.retrieval || [];
    const picked = rows.filter((r) => r.selected).length;
    if (rows.length) stat(`检索 ${picked}/${rows.length}`);
    else stat('检索 · 库是空的');
    if (trace.recalls && trace.recalls.length) stat(`再检索 ${trace.recalls.length}`);
    if (trace.written_ids.length) stat(`写入 ${trace.written_ids.length}`);
    if (trace.replaced_ids && trace.replaced_ids.length) stat(`替代 ${trace.replaced_ids.length}`);
    dur.textContent = message.elapsed != null ? `已处理 ${message.elapsed.toFixed(1)}s` : '';
    stages.append(...doneStages(trace, events, message));
  } else {
    label.textContent = '运行链 · 中断';
    dur.textContent = message.elapsed != null ? `已处理 ${message.elapsed.toFixed(1)}s` : '';
    stages.append(...runningStages(events));
  }
  chain.addEventListener('toggle', () => { chain.dataset.user = chain.open ? '1' : '0'; });
  return chain;
}

/* stages while the step is still running: the events as they arrive */
function runningStages(events) {
  const out = [];
  events.forEach((e) => {
    if (e.kind === 'embed') {
      const kind = { query: '输入', document: '记忆', plain: '评估' }[e.task] || e.task;
      out.push(stage({ name: '嵌入', metric: `${e.dim} 维 · ${kind}`, ms: e.ms, dot: 'ok' }));
    } else if (e.kind === 'cognize_start') {
      const context = e.library_size == null
        ? `上下文 ${e.context_ids.length} 条`
        : `上下文 ${e.context_ids.length} 条 · 库 ${e.library_size}`;
      out.push(stage({ name: '调用模型', metric: context, dot: 'hot' }));
    } else if (e.kind === 'cognition') {
      out.push(stage({ name: '回答', metric: `引用 ${(e.payload.used_memory_ids || []).length} 条`,
        ms: e.ms, dot: 'ok' }));
    } else if (e.kind === 'recall_request') {
      out.push(stage({ name: '请求再检索', metric: e.payload.recall, ms: e.ms, dot: 'warn' }));
    }
  });
  return out;
}

/* --------------------------------------------- demo2: decay / weight / stability */
function doneStagesDynamics(trace, events) {
  const out = [];
  const embeds = events.filter((e) => e.kind === 'embed');
  const query = embeds.find((e) => e.task === 'query');
  const documents = embeds.filter((e) => e.task !== 'query');
  const cognition = events.filter((e) => e.kind === 'cognition').pop();
  const byId = new Map((trace.retrieval || []).map((r) => [r.id, r]));

  out.push(stage({
    name: '输入嵌入', dot: 'ok', ms: query ? query.ms : null,
    metric: query ? `${query.dim} 维` : '这一轮没有输入',
    body: '输入先变成向量，再和每条记忆的向量比相似度。没有情绪参与。',
  }));

  out.push(stage({
    name: '衰减', dot: '', metric: trace.decayed.length
      ? `${trace.decayed.length} 条 · 每轮一次`
      : '库是空的',
    body: trace.decayed.length
      ? decayBody(trace.decayed, byId, trace.config)
      : '没有记忆需要衰减。',
  }));

  if (trace.retrieval.length) {
    out.push(stage({
      name: '检索', dot: 'ok',
      metric: `${trace.retrieval.filter((r) => r.selected).length} / ${trace.retrieval.length} 入选`,
      body: dynamicsRowsBody(trace.retrieval, trace.config),
    }));
  } else {
    out.push(stage({ name: '检索', dot: '', metric: '库是空的', body: '没有可比对的记忆。' }));
  }

  out.push(stage({
    name: '认知', dot: 'ok', ms: cognition ? cognition.ms : null,
    metric: `引用 ${trace.cognition.used_memory_ids.length} 条`,
    body: cognitionBody(trace.cognition, false),
  }));

  if (trace.activated.length) {
    out.push(stage({
      name: '激活', dot: 'hot', metric: `${trace.activated.length} 条`,
      body: activationBody(trace.activated, byId),
    }));
  }

  if (trace.written.length) {
    out.push(stage({
      name: '写入', dot: 'hot', metric: `${trace.written.length} 条`,
      body: writtenBody(trace.written),
    }));
  } else if (documents.length) {
    out.push(stage({
      name: '写入', dot: '', metric: '0 条',
      body: '模型这一轮没有提出新记忆。',
    }));
  }

  out.push(stage({
    name: '提交', dot: 'ok', metric: `step ${trace.step}`,
    body: dynamicsCommitBody(trace),
  }));
  return out;
}

function decayBody(rows, byId, config) {
  const wrap = el('div');
  rows.forEach((r) => {
    const content = (byId.get(r.id) || {}).content || '';
    const row = el('div', 'drow');
    row.append(el('span', 'id', '#' + r.id));
    row.append(el('span', 'txt', content));
    row.append(el('span', 'num', `${num(r.weight_before)} → ${num(r.weight_after)}`));
    row.append(el('span', 'rate', '率 ' + num(r.effective_decay_rate, 4)));
    wrap.append(row);
  });
  const base = config ? config.decay_rate : 0.12;
  const protection = config ? config.stability_protection : 0.85;
  wrap.append(el('div', 'note',
    `权重 × exp(−率)，基准率 ${base}；率 = 基准 × (1 − ${protection} × 稳定性)。` +
    '双状态下稳定性会把率压小，单权重模式稳定性恒为 0。'));
  return wrap;
}

function dynamicsRowsBody(rows, config) {
  const wrap = el('div');
  const table = document.createElement('table');
  const head = document.createElement('tr');
  ['#', '记忆', 'rel', 'w', 'score'].forEach((h) => head.append(el('th', '', h)));
  table.append(head);
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.className = r.selected ? 'sel' : 'out';
    tr.append(el('td', '', '#' + r.id));
    const cell = el('td', '', r.content);
    cell.title = r.content;
    tr.append(cell);
    tr.append(el('td', '', num(r.relevance)));
    tr.append(el('td', '', num(r.weight)));
    tr.append(el('td', '', num(r.score)));
    table.append(tr);
  });
  wrap.append(table);
  wrap.append(el('div', 'note',
    `score = relevance × weight，▸ 为进入上下文的前 ${config ? config.top_k : 3} 条。` +
    '稳定性不直接加分，它只让以后的衰减变慢。'));
  return wrap;
}

function activationBody(rows, byId) {
  const wrap = el('div');
  rows.forEach((r) => {
    const content = (byId.get(r.id) || {}).content || '';
    const row = el('div', 'drow');
    row.append(el('span', 'id', '#' + r.id));
    row.append(el('span', 'txt', content));
    row.append(el('span', 'num', `w ${num(r.weight_before)} → ${num(r.weight_after)}`));
    row.append(el('span', 'rate', `s ${num(r.stability_before)} → ${num(r.stability_after)}`));
    wrap.append(row);
  });
  wrap.append(el('div', 'note',
    '被引用的记忆按恢复率把权重拉回 1，并长一点稳定性。越难想起的记忆（衰减前权重越低），稳定性涨得越多。'));
  return wrap;
}

function dynamicsCommitBody(trace) {
  const wrap = el('div');
  const line = (k, v) => {
    const row = el('div', 'kv');
    row.append(el('b', '', k + '：'));
    row.append(document.createTextNode(v));
    wrap.append(row);
  };
  const c = trace.config || {};
  line('步', `${trace.step - 1} → ${trace.step}`);
  line('模式', MODE_NAMES[c.mode] || c.mode || '—');
  line('配置', `衰减 ${c.decay_rate} · 保护 ${c.stability_protection} · 恢复 ${c.recovery_rate} · 稳定增益 ${c.stability_gain} · top_k ${c.top_k}`);
  line('库', `${trace.retrieval.length} 条 → ${trace.retrieval.length + trace.written_ids.length} 条`);
  line('写入', trace.written_ids.length ? trace.written_ids.map((i) => '#' + i).join('、') : '没有');
  line('被引用', trace.activated.length ? trace.activated.map((i) => '#' + i.id).join('、') : '没有');
  wrap.append(el('div', 'note', '这一轮之后所有记忆的权重都按上面的数衰减过一次，再对引用到的做恢复。'));
  return wrap;
}

function libraryBody(memories) {
  const wrap = el('div');
  memories.slice(0, 12).forEach((m) => {
    const row = el('div', 'drow');
    row.append(el('span', 'id', '#' + m.id));
    row.append(el('span', 'txt', m.content));
    row.append(el('span', 'num', 'w ' + num(m.weight)));
    row.append(el('span', 'rate', 's ' + num(m.stability)));
    wrap.append(row);
    const bar = el('div', 'bar tight libbar');
    const fill = el('i');
    fill.style.width = pct(m.weight);
    bar.append(fill);
    wrap.append(bar);
  });
  return wrap;
}

/* --------------------------------------------- demo1: emotion / memory */
function doneStages(trace, events, message) {
  const out = [];
  const embeds = events.filter((e) => e.kind === 'embed' && e.task === 'query');
  const cognitions = events.filter((e) => e.kind === 'cognition' || e.kind === 'recall_request');

  out.push(stage({
    name: '输入嵌入', dot: 'ok', ms: embeds[0] ? embeds[0].ms : null,
    metric: embeds[0] ? `${embeds[0].dim} 维` : '',
    body: '输入先变成一个向量，再和库里的记忆比较。情绪不进入这一步。',
  }));

  if (trace.retrieval.length) {
    out.push(stage({
      name: '检索', dot: 'ok',
      metric: `${trace.retrieval.filter((r) => r.selected).length} / ${trace.retrieval.length} 入选`,
      body: rowsBody(trace.retrieval),
    }));
  } else {
    out.push(stage({ name: '检索', dot: '', metric: '库是空的', body: '没有可比对的记忆。' }));
  }

  const requests = cognitions.filter((e) => e.kind === 'recall_request');
  const finalEvt = cognitions[cognitions.length - 1];
  if (!requests.length) {
    out.push(stage({
      name: '认知', dot: 'ok', ms: finalEvt ? finalEvt.ms : null,
      metric: `引用 ${trace.cognition.used_memory_ids.length} 条`,
      body: cognitionBody(finalEvt ? finalEvt.payload : trace.cognition, true),
    }));
  } else {
    requests.forEach((request, index) => {
      out.push(stage({
        name: '请求再检索', dot: 'warn', ms: request.ms,
        metric: `"${shorten(request.payload.recall, 46)}"`,
        body: cognitionBody(request.payload, true),
      }));
      const recall = trace.recalls[index];
      if (recall) {
        out.push(stage({
          name: '按需检索', dot: 'warn', metric: `拉回 ${recall.rows.length} 条`,
          body: recall.rows.length ? rowsBody(recall.rows) : '没有找到库外的新记忆。',
        }));
      }
    });
    if (finalEvt && finalEvt.kind === 'cognition') {
      out.push(stage({
        name: '再认知', dot: 'ok', ms: finalEvt.ms,
        metric: `引用 ${(finalEvt.payload.used_memory_ids || []).length} 条`,
        body: cognitionBody(finalEvt.payload, true),
      }));
    }
  }

  if (trace.written.length) {
    out.push(stage({ name: '写入', dot: 'hot', metric: `${trace.written.length} 条`,
      body: writtenBody(trace.written) }));
  }

  out.push(stage({
    name: '提交', dot: 'ok', metric: `step ${trace.step}`,
    body: commitBody(trace),
  }));
  return out;
}

function shorten(text, n) {
  if (!text) return '';
  return text.length > n ? text.slice(0, n) + '…' : text;
}

function rowsBody(rows) {
  const wrap = el('div');
  const table = document.createElement('table');
  const head = document.createElement('tr');
  ['#', '记忆', 'rel', 'read', 'ws', 'score'].forEach((h) => head.append(el('th', '', h)));
  table.append(head);
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.className = r.selected ? 'sel' : 'out';
    tr.append(el('td', '', '#' + r.id));
    const cell = el('td', '', r.content);
    cell.title = r.content;
    tr.append(cell);
    tr.append(el('td', '', num(r.relevance)));
    tr.append(el('td', '', num(r.read_strength)));
    tr.append(el('td', '', num(r.write_strength)));
    tr.append(el('td', '', num(r.score)));
    table.append(tr);
  });
  wrap.append(table);
  wrap.append(el('div', 'note', 'score = relevance × read × write_strength，▸ 为进入上下文的那几条'));
  return wrap;
}

function cognitionBody(payload, withAppraisal) {
  const clean = {
    used_memory_ids: payload.used_memory_ids,
    memories: payload.memories,
  };
  if (withAppraisal) clean.appraisal = payload.appraisal;
  if (payload.recall) clean.recall = payload.recall;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(clean, null, 2);
  const wrap = el('div');
  wrap.append(el('div', 'note', payload.recall
    ? '这一次它没有直接回答，而是要求再检索'
    : '同一次调用返回的结构化结果：引用了哪些记忆、想写入什么。回答本身在下方正文。'));
  wrap.append(pre);
  return wrap;
}

function writtenBody(written) {
  const body = el('div');
  written.forEach((m) => {
    const row = el('div', 'row');
    row.append(el('span', 'id', '#' + m.id));
    row.append(el('span', 'txt', m.content));
    body.append(row);
    const bar = el('div', 'bar tight');
    const fill = el('i');
    fill.style.width = pct(m.weight != null ? m.weight : m.write_strength);
    bar.append(fill);
    body.append(bar);
    const note = [];
    if (m.weight != null) note.push('w ' + num(m.weight) + ' · s ' + num(m.stability));
    if (m.write_strength != null) note.push('ws ' + num(m.write_strength));
    if (m.replaces && m.replaces.length) note.push('替代 ' + m.replaces.map((i) => '#' + i).join('、'));
    if (m.source_memory_ids && m.source_memory_ids.length) note.push('来源 ' + m.source_memory_ids.map((i) => '#' + i).join('、'));
    if (note.length) body.append(el('div', 'note', note.join(' · ')));
  });
  return body;
}

function commitBody(trace) {
  const wrap = el('div');
  const line = (k, v) => {
    const row = el('div', 'kv');
    row.append(el('b', '', k + '：'));
    row.append(document.createTextNode(v));
    wrap.append(row);
  };
  line('步', `${trace.step - 1} → ${trace.step}`);
  line('情绪漂移', trace.emotion.drift == null ? '首次形成' : num(trace.emotion.drift, 4) + '（ρ=' + trace.rho + '）');
  line('写入', trace.written_ids.length ? trace.written_ids.map((i) => '#' + i).join('、') : '没有');
  line('替代', trace.replaced_ids.length ? trace.replaced_ids.map((i) => '#' + i).join('、') : '没有');
  wrap.append(el('div', 'note', '替代是删除：被替代的原文不再留在库里，也不进上下文。'));
  return wrap;
}

function stage(opts) {
  const d = document.createElement('details');
  d.className = 'stage';
  if (FLAGS.has('all')) d.open = true;
  const s = document.createElement('summary');
  s.append(el('span', 'chev'));
  s.append(el('span', 'dot ' + (opts.dot || '')));
  s.append(el('span', 'name', opts.name));
  s.append(el('span', 'metric', opts.metric || ''));
  if (opts.ms != null) s.append(el('span', 'ms', secs(opts.ms)));
  d.append(s);
  const body = el('div', 'body');
  if (typeof opts.body === 'string') body.textContent = opts.body;
  else if (opts.body) body.append(opts.body);
  d.append(body);
  return d;
}

/* ------------------------------------------------------------------ sending */
async function send(text) {
  if (state.busy) return;
  if (!state.current) { await newThread(null); }
  state.busy = true;
  $('send').disabled = true;
  const box = $('stream');
  if (box.querySelector('.empty')) box.replaceChildren();

  const user = el('div', 'msg user');
  user.append(el('div', 'bubble', text));
  box.append(user);
  toBottom(true);

  const placeholder = assistantNode({ events: [], phase: '准备', now: 0 }, true);
  box.append(placeholder);
  toBottom(true);

  try {
    const started = await api(`/api/threads/${state.current}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await pollRun(started.run, placeholder, state.current);
  } catch (error) {
    placeholder.querySelector('.answer').classList.add('error');
    placeholder.querySelector('.answer').textContent = '发送失败：' + error.message;
  } finally {
    state.busy = false;
    $('send').disabled = false;
    $('live').textContent = '';
    $('live').classList.remove('on');
  }
}

async function pollRun(runId, node, threadId) {
  const live = $('live');
  live.classList.add('on');
  for (;;) {
    const run = await api(`/api/threads/${threadId}/runs/${runId}`);
    live.textContent = run.status === 'running'
      ? `运行中 · ${run.phase || '处理'} · ${(run.now || 0).toFixed(1)}s`
      : '';
    if (run.status === 'running') {
      const fresh = assistantNode(run, true);
      node.replaceWith(fresh);
      node = fresh;
      toBottom(false);
      await sleep(450);
      if (state.current !== threadId) return;
      continue;
    }
    const done = assistantNode(run, false);
    node.replaceWith(done);
    toBottom(false);
    await refreshThumb(threadId);
    return;
  }
}

async function refreshThumb(threadId) {
  const thread = await api('/api/threads/' + threadId);
  if (state.current === threadId) {
    state.thread = thread;
    paintHeader(thread);
  }
  await loadThreads();
}

/* ------------------------------------------------------------------ log drawer */
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function openLogs() {
  const drawer = $('drawer');
  drawer.hidden = false;
  const body = $('logBody');
  body.replaceChildren(el('div', 'note', '读取中…'));
  try {
    const data = await api('/api/logs?limit=80');
    body.replaceChildren();
    if (!data.runs.length) {
      body.append(el('div', 'note', '还没有记录。'));
      return;
    }
    data.runs.slice().reverse().forEach((row) => {
      const item = el('div', 'log');
      const head = el('div', 'log-head');
      head.append(el('span', 'log-time', fmtTime(row.ts)));
      head.append(el('span', 'tag', BACKEND_NAMES[row.backend] || row.backend));
      if (row.step != null) head.append(el('span', 'log-step', 'step ' + row.step));
      if (row.elapsed != null) head.append(el('span', 'log-step', row.elapsed.toFixed(1) + 's'));
      if (row.rating) head.append(el('span', 'log-score', '评 ' + row.rating.score + '/5'));
      if (row.status !== 'done') head.append(el('span', 'log-bad', row.status));
      item.append(head);
      item.append(el('div', 'log-input', '问：' + (row.input || '—')));
      item.append(el('div', 'log-answer', '答：' + (row.answer || row.error || '—')));
      const bits = [];
      if (row.used) bits.push('引用 ' + (row.used.length ? row.used.map((i) => '#' + i).join('、') : '无'));
      if (row.rating && row.rating.note) bits.push('评价：' + row.rating.note);
      if (bits.length) item.append(el('div', 'log-note', bits.join(' · ')));
      body.append(item);
    });
  } catch (error) {
    body.replaceChildren(el('div', 'note', '日志读取失败：' + error.message));
  }
}

/* ------------------------------------------------------------------ wire up */
function autoGrow() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}

$('input').addEventListener('input', autoGrow);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  autoGrow();
  await send(text);
});

$('new').addEventListener('click', async () => {
  $('new').disabled = true;
  try {
    await newThread(null);
    $('input').focus();
  } finally {
    $('new').disabled = false;
  }
});

document.querySelectorAll('#switch .tab').forEach((b) => {
  b.addEventListener('click', () => setBackend(b.dataset.backend));
});
document.querySelectorAll('#modes button').forEach((b) => {
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await newThread(b.dataset.mode);
      $('input').focus();
    } finally {
      b.disabled = false;
    }
  });
});

$('openLogs').addEventListener('click', openLogs);
$('draftSend').addEventListener('click', flushDrafts);
$('draftClear').addEventListener('click', discardDrafts);
$('closeLogs').addEventListener('click', () => { $('drawer').hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('drawer').hidden = true;
});

(async function boot() {
  document.querySelectorAll('#switch .tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.backend === state.backend);
  });
  $('new').hidden = state.backend === 'demo2';
  $('modes').hidden = state.backend !== 'demo2';

  const threads = await loadThreads();
  const wanted = FLAGS.get('thread');
  if (wanted && threads.some((t) => t.id === wanted)) await selectThread(wanted);
  else if (threads.length) await selectThread(threads[0].id);
  else await selectThread((await api('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend: state.backend }),
  })).id);
  if (FLAGS.has('logs')) openLogs();
})();
