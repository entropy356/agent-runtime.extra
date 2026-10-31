'use strict';

const state = { threads: [], current: null, thread: null, poll: null, busy: false };
const FLAGS = new URLSearchParams(location.search);

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

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({ error: '返回不是 JSON' }));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function nearBottom() {
  const box = $('stream');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}
function toBottom(force) {
  const box = $('stream');
  if (force || nearBottom()) box.scrollTop = box.scrollHeight;
}

/* ------------------------------------------------------------------ sidebar */
async function loadThreads() {
  const data = await api('/api/threads');
  state.threads = data.threads;
  $('mode').textContent = data.mode + ' · ' + data.profile.replace(/^api:/, '');
  renderThreads();
  return data.threads;
}

function renderThreads() {
  const box = $('threads');
  box.replaceChildren();
  state.threads.forEach((t) => {
    const b = el('button', 'thread' + (t.id === state.current ? ' on' : ''));
    b.append(el('span', '', t.title));
    b.append(el('small', '', `${t.turns} 轮 · ${t.id.slice(-4)}`));
    b.onclick = () => selectThread(t.id);
    box.append(b);
  });
}

async function newThread() {
  const created = await api('/api/threads', { method: 'POST' });
  await loadThreads();
  await selectThread(created.id);
}

/* ------------------------------------------------------------------ thread */
async function selectThread(id) {
  state.current = id;
  if (state.poll) { clearTimeout(state.poll); state.poll = null; }
  renderThreads();
  const thread = await api('/api/threads/' + id);
  state.thread = thread;
  paintHeader(thread);
  paintMessages(thread.messages);
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
  $('meta').textContent = `step ${s.step} · 库 ${s.library} 条`;
}

function paintMessages(messages) {
  const box = $('stream');
  box.replaceChildren();
  if (!messages.length) {
    const empty = el('div', 'empty');
    empty.append(el('p', '', '这个 runtime 有情绪和记忆。'));
    empty.append(el('p', 'dim', '说一句话，它会检索、评估、写入，然后回答。运行链默认折叠在回答上方。'));
    box.append(empty);
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

/* ------------------------------------------------------------------ message */
function assistantNode(message, running) {
  const wrap = el('article', 'msg assistant');
  const chain = chainNode(message, running);
  wrap.append(chain);
  const answer = el('div', 'answer');
  if (message.error) {
    answer.classList.add('error');
    answer.textContent = '这一轮没有通过校验，状态没有改变。\n' + message.error;
  } else if (message.answer) {
    answer.textContent = message.answer;
  }
  wrap.append(answer);
  return wrap;
}

function chainNode(message, running) {
  const trace = message.trace;
  const events = message.events || [];
  const chain = document.createElement('details');
  chain.className = 'chain';
  // ?expand=1 keeps every chain open, which is how the layout gets reviewed.
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
  } else {
    label.textContent = '运行链';
    const rows = trace ? trace.retrieval || [] : [];
    const picked = rows.filter((r) => r.selected).length;
    const stat = (text, hot) => stats.append(el('span', 'chip' + (hot ? ' hot' : ''), text));
    if (rows.length) stat(`检索 ${picked}/${rows.length}`);
    else if (trace) stat('检索 · 库是空的');
    if (trace && trace.recalls.length) stat(`再检索 ${trace.recalls.length}`);
    if (trace && trace.written_ids.length) stat(`写入 ${trace.written_ids.length}`);
    if (trace && trace.replaced_ids.length) stat(`替代 ${trace.replaced_ids.length}`);
    dur.textContent = message.elapsed != null ? `已处理 ${message.elapsed.toFixed(1)}s` : '';
    if (trace) {
      stages.append(...doneStages(trace, events, message));
    } else {
      label.textContent = '运行链 · 中断';
      stages.append(...runningStages(events));
    }
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
      out.push(stage({ name: '调用模型', metric: `上下文 ${e.context_ids.length} 条 · 库 ${e.library_size}`,
        dot: 'hot' }));
    } else if (e.kind === 'cognition') {
      out.push(stage({ name: '回答', metric: `引用 ${(e.payload.used_memory_ids || []).length} 条`,
        ms: e.ms, dot: 'ok' }));
    } else if (e.kind === 'recall_request') {
      out.push(stage({ name: '请求再检索', metric: e.payload.recall, ms: e.ms, dot: 'warn' }));
    }
  });
  return out;
}

/* stages after the commit: the trace holds the real order and every number */
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
      body: cognitionBody(finalEvt ? finalEvt.payload : trace.cognition),
    }));
  } else {
    requests.forEach((request, index) => {
      out.push(stage({
        name: '请求再检索', dot: 'warn', ms: request.ms,
        metric: `"${shorten(request.payload.recall, 46)}"`,
        body: cognitionBody(request.payload),
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
        body: cognitionBody(finalEvt.payload),
      }));
    }
  }

  const written = (trace && trace.written) || [];
  if (written.length) {
    const body = el('div');
    written.forEach((m) => {
      const row = el('div', 'row');
      row.append(el('span', 'id', '#' + m.id));
      row.append(el('span', 'txt', m.content));
      row.append(el('span', 'num', 'ws ' + num(m.write_strength)));
      body.append(row);
      const bar = el('div', 'bar tight');
      const fill = el('i');
      fill.style.width = Math.round((m.write_strength || 0) * 100) + '%';
      bar.append(fill);
      body.append(bar);
      const note = [];
      if (m.replaces && m.replaces.length) note.push('替代 ' + m.replaces.map((i) => '#' + i).join('、'));
      if (m.source_memory_ids && m.source_memory_ids.length) note.push('来源 ' + m.source_memory_ids.map((i) => '#' + i).join('、'));
      if (note.length) body.append(el('div', 'note', note.join(' · ')));
    });
    out.push(stage({ name: '写入', dot: 'hot', metric: `${written.length} 条`, body }));
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

function cognitionBody(payload) {
  const clean = {
    appraisal: payload.appraisal,
    used_memory_ids: payload.used_memory_ids,
    memories: payload.memories,
  };
  if (payload.recall) clean.recall = payload.recall;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(clean, null, 2);
  const wrap = el('div');
  wrap.append(el('div', 'note', payload.recall
    ? '这一次它没有直接回答，而是要求再检索'
    : '同一次调用返回的结构化结果：情绪评估、引用了哪些记忆、想写入什么。回答本身在下方正文。'));
  wrap.append(pre);
  return wrap;
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
  if (!state.current) { await newThread(); }
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
    await newThread();
    $('input').focus();
  } finally {
    $('new').disabled = false;
  }
});

(async function boot() {
  const threads = await loadThreads();
  const wanted = FLAGS.get('thread');
  if (wanted && threads.some((t) => t.id === wanted)) await selectThread(wanted);
  else if (threads.length) await selectThread(threads[0].id);
  else await selectThread((await api('/api/threads', { method: 'POST' })).id);
})();
