'use strict';
// 사용자가 쓴 글자는 반드시 textContent(=h() 의 문자열 자식)로만 넣는다. HTML 문자열 삽입은 쓰지 않는다.
const PRIO = { 1: '높음', 2: '보통', 3: '낮음' };
const PERIOD = { day: '하루', week: '한 주', month: '한 달' };
const view = document.getElementById('view');
const dlg = document.getElementById('dlg');

// ---------- 도우미 ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') continue;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  if (attrs && attrs.value != null && attrs.value !== false) el.value = attrs.value; // 옵션이 붙은 뒤에 값을 지정
  return el;
}
const ICONS = {
  check: 'M5 12l5 5L20 7',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14',
  clock: 'M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',
  plus: 'M12 5v14M5 12h14',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8m0-4v4h4M12 8v4l3 2',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  arrow: 'M5 12h14m-6-6l6 6-6 6',
  ban: 'M5.6 5.6l12.8 12.8M12 21a9 9 0 100-18 9 9 0 000 18z',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[name]); s.append(p);
  return s;
}
const fmtDT = (iso) => (iso ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '');
const fmtMin = (m) => { m = Math.round(m); const a = Math.abs(m); return a >= 60 ? `${m < 0 ? '-' : ''}${Math.floor(a / 60)}시간${a % 60 ? ' ' + (a % 60) + '분' : ''}` : `${m}분`; };
const nowKstInput = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16);
const toKstIso = (v) => (v ? `${v}:00+09:00` : '');
const isoToKstInput = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 16);

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) { showAuth('login', '로그인이 끝났어요. 다시 로그인해 주세요.'); const e = new Error(data.error || '로그인이 필요합니다.'); e.fields = {}; e.handled = true; throw e; }
  if (!res.ok) { const e = new Error(data.error || '요청에 실패했습니다.'); e.fields = data.fields || {}; throw e; }
  return data;
}
function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}
// 비동기 동작 중에는 버튼을 잠근다(중복 클릭 방지). 서버 쪽 제약이 최종 방어선이다.
async function busy(btn, fn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  try { return await fn(); } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
}
const empty = (title, text, action) => h('div', { class: 'empty' }, h('h3', {}, title), h('p', {}, text), action);
// 화면 제목: 눈썹글자(단계) + h2 + 회색 안내문 + 오른쪽 동작
const pageHead = (step, title, lead, action) => h('div', { class: 'section-head' },
  h('div', {}, h('div', { class: 'eyebrow' }, step), h('h2', {}, title), lead ? h('p', { class: 'lead' }, lead) : null), action);
const fmtDay = (d) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${Number(m[1])}/${Number(m[2])}` : d; };

// ---------- 폼 다이얼로그 ----------
// fields: [{name,label,type,options,help,full,required,placeholder}]
function openForm({ title, fields, initial = {}, submitLabel = '저장', onSubmit }) {
  const errBox = h('div', { class: 'error-summary', role: 'alert', tabindex: '-1', hidden: true });
  const form = h('form', { id: 'dlg-form', novalidate: true, class: 'form-grid' });
  const inputs = {};
  for (const f of fields) {
    const id = `f-${f.name}`;
    let input;
    if (f.type === 'textarea') input = h('textarea', { id, name: f.name, maxlength: f.max });
    else if (f.type === 'select') input = h('select', { id, name: f.name }, f.options.map(([v, l]) => h('option', { value: v }, l)));
    else input = h('input', { id, name: f.name, type: f.type || 'text', maxlength: f.max, min: f.type === 'number' ? '0' : false, inputmode: f.type === 'number' ? 'numeric' : false, placeholder: f.placeholder });
    input.value = initial[f.name] ?? f.default ?? '';
    if (f.help) input.setAttribute('aria-describedby', `${id}-help`);
    inputs[f.name] = input;
    form.append(h('div', { class: 'field' + (f.full ? ' full' : '') },
      h('label', { for: id }, f.label, f.required ? ' (필수)' : ''),
      input, f.help ? h('span', { class: 'help', id: `${id}-help` }, f.help) : null,
      h('span', { class: 'error-text', id: `${id}-err`, hidden: true })));
  }
  const submit = h('button', { class: 'btn primary', type: 'submit', form: 'dlg-form' }, submitLabel);
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, '취소');
  const wrap = h('div', { class: 'dlg-body' }, errBox, form, h('div', { class: 'dlg-foot' }, cancel, submit));
  function showErrors(fieldsErr, general) {
    for (const f of fields) { const e = document.getElementById(`f-${f.name}-err`); e.hidden = true; e.textContent = ''; inputs[f.name].removeAttribute('aria-invalid'); }
    const entries = Object.entries(fieldsErr || {});
    errBox.replaceChildren();
    if (!entries.length && !general) { errBox.hidden = true; return; }
    errBox.append(h('strong', {}, entries.length ? '입력한 내용에 문제가 있습니다' : general));
    if (entries.length) errBox.append(h('ul', {}, entries.map(([k, m]) => h('li', {}, h('a', { href: `#f-${k}`, onclick: (ev) => { ev.preventDefault(); inputs[k]?.focus(); } }, m)))));
    for (const [k, m] of entries) {
      const e = document.getElementById(`f-${k}-err`); if (!e) continue;
      e.hidden = false; e.textContent = m; inputs[k].setAttribute('aria-invalid', 'true');
      const d = (inputs[k].getAttribute('aria-describedby') || '').split(' ').filter(Boolean); if (!d.includes(e.id)) d.push(e.id); inputs[k].setAttribute('aria-describedby', d.join(' '));
    }
    errBox.hidden = false; errBox.focus();
  }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const values = {}; for (const f of fields) values[f.name] = inputs[f.name].value;
    showErrors({});
    await busy(submit, async () => {
      try { await onSubmit(values); dlg.close(); }
      catch (e) { showErrors(e.fields, e.message); }
    });
  });
  dlg.replaceChildren(
    h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-title' }, title), h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': '닫기', title: '닫기', onclick: () => dlg.close() }, icon('x'))),
    wrap);
  dlg.showModal();
  const first = form.querySelector('input,select,textarea'); if (first) first.focus();
}
function openInfo(title, ...body) {
  dlg.replaceChildren(
    h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-title' }, title), h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': '닫기', title: '닫기', onclick: () => dlg.close() }, icon('x'))),
    h('div', { class: 'dlg-body' }, ...body));
  dlg.showModal();
}
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

// ---------- 공용 조각 ----------
let META = null;
const prioOptions = [[1, '높음'], [2, '보통'], [3, '낮음']];
async function plansForSelect() { return (await api('/api/plans')).items; }

// 칩은 '상태'에만: 지연, 막힘
function todoStatus(t) {
  const out = [];
  if (t.is_delayed) out.push(h('span', { class: 'chip bad' }, icon('alert'), '지연 · 마감 ' + fmtDay(t.due_date)));
  if (t.blocked_runs) out.push(h('span', { class: 'chip bad' }, icon('ban'), '막힘 ' + t.blocked_runs + '건'));
  return out;
}
// 나머지 정보는 회색 한 줄
function todoLine(t) {
  const parts = [h('span', { class: 'plan-name' }, t.plan_title)];
  if (t.due_date && !t.is_delayed) parts.push(h('span', {}, '마감 ' + fmtDay(t.due_date)));
  if (t.priority !== 2) parts.push(h('span', {}, '우선순위 ' + PRIO[t.priority]));
  if (t.est_minutes && t.run_count) parts.push(h('span', {}, `예상 ${fmtMin(t.est_minutes)} → 실제 ${fmtMin(t.actual_minutes)}`));
  else if (t.est_minutes) parts.push(h('span', {}, '예상 ' + fmtMin(t.est_minutes)));
  else if (t.run_count) parts.push(h('span', {}, '실제 ' + fmtMin(t.actual_minutes)));
  if (t.tags.length) parts.push(h('span', {}, t.tags.map((g) => '#' + g).join(' ')));
  return h('div', { class: 'meta-line' }, parts);
}

function todoForm(todo, plans, defaultPlan, done) {
  openForm({
    title: todo ? '할 일 고치기' : '할 일 만들기',
    initial: todo ? { ...todo, tags: todo.tags.join(', '), due_date: todo.due_date || '' } : { plan_id: defaultPlan || plans[0]?.id },
    fields: [
      { name: 'plan_id', label: '어느 계획에 딸린 일인가요', type: 'select', options: plans.map((p) => [p.id, p.title]), full: true, required: true },
      { name: 'title', label: '할 일', required: true, max: 100, full: true },
      { name: 'due_date', label: '마감일', type: 'date' },
      { name: 'priority', label: '우선순위', type: 'select', options: prioOptions, default: 2 },
      { name: 'est_minutes', label: '예상 시간(분)', type: 'number', default: 30 },
      { name: 'tags', label: '태그', help: '쉼표나 띄어쓰기로 나눠 적어요. 예: 운동, 아침', placeholder: '운동, 아침' },
      { name: 'memo', label: '메모', type: 'textarea', max: 500, full: true },
    ],
    onSubmit: async (v) => {
      const body = { ...v, plan_id: Number(v.plan_id), due_date: v.due_date || null };
      if (todo) await api(`/api/todos/${todo.id}`, { method: 'PATCH', body }); else await api('/api/todos', { method: 'POST', body });
      toast(todo ? '할 일을 고쳤습니다.' : '할 일을 만들었습니다.'); done();
    },
  });
}
function runForm(todo, done) {
  const now = nowKstInput();
  openForm({
    title: `실제로 한 일 적기 — ${todo.title}`,
    initial: { started_at: now, ended_at: now },
    submitLabel: '기록 저장',
    fields: [
      { name: 'started_at', label: '시작 시각', type: 'datetime-local', required: true },
      { name: 'ended_at', label: '끝 시각', type: 'datetime-local', required: true },
      { name: 'actual_minutes', label: '실제로 걸린 시간(분)', type: 'number', help: '비워 두면 끝 시각 - 시작 시각으로 계산해요.' },
      { name: 'blocker_reason', label: '막혔던 이유', type: 'textarea', max: 300, full: true, help: '막힌 게 없으면 비워 두세요.' },
    ],
    onSubmit: async (v) => {
      await api(`/api/todos/${todo.id}/runs`, { method: 'POST', body: { started_at: toKstIso(v.started_at), ended_at: toKstIso(v.ended_at), actual_minutes: v.actual_minutes, blocker_reason: v.blocker_reason } });
      toast('실행 기록을 저장했습니다. 계획 값은 그대로예요.'); done();
    },
  });
}
async function deleteWithConfirm(label, path, done) {
  openInfo('정말 지울까요?', h('p', {}, `"${label}"을(를) 지웁니다. 되돌릴 수 없어요.`),
    h('div', { class: 'dlg-foot' }, h('button', { class: 'btn', onclick: () => dlg.close() }, '취소'),
      h('button', { class: 'btn danger solid', onclick: async (e) => { await busy(e.currentTarget, async () => { try { await api(path, { method: 'DELETE' }); dlg.close(); toast('지웠습니다.'); done(); } catch (er) { toast(er.message, true); } }); } }, '지우기')));
}

function todoItem(t, reload) {
  const isDone = t.status === 'done';
  const check = h('button', {
    class: 'check', type: 'button', 'aria-pressed': String(isDone),
    'aria-label': isDone ? `"${t.title}" 진행 중으로 되돌리기` : `"${t.title}" 완료로 바꾸기`,
    onclick: (e) => busy(e.currentTarget, async () => {
      try { await api(`/api/todos/${t.id}/${isDone ? 'reopen' : 'complete'}`, { method: 'POST' }); reload(); } catch (er) { toast(er.message, true); }
    }),
  }, icon('check'));
  return h('li', { class: 'item' + (isDone ? ' done' : '') }, check,
    h('div', {}, h('div', { class: 'status-row' }, h('span', { class: 'item-title' }, t.title), todoStatus(t)), t.memo ? h('p', { class: 'item-memo' }, t.memo) : null, todoLine(t)),
    h('div', { class: 'item-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => runForm(t, reload) }, icon('clock'), '기록'),
      h('button', { class: 'btn icon ghost', type: 'button', title: '고치기', 'aria-label': `"${t.title}" 고치기`, onclick: async () => todoForm(t, await plansForSelect(), null, reload) }, icon('edit')),
      h('button', { class: 'btn icon ghost danger', type: 'button', title: '지우기', 'aria-label': `"${t.title}" 지우기`, onclick: () => deleteWithConfirm(t.title, `/api/todos/${t.id}`, reload) }, icon('trash'))));
}

// ---------- 화면: 계획 ----------
async function viewPlans() {
  const { items } = await api('/api/plans');
  const reload = () => route();
  const root = h('div', { class: 'stack' });
  root.append(pageHead('STEP 1 · PLAN', '내 계획', '기간·우선순위·성공 기준·예상 시간을 함께 정해요. 고쳐도 처음 세운 계획은 남습니다.',
    h('button', { class: 'btn primary', onclick: () => planForm(null, reload) }, icon('plus'), '계획 세우기')));
  if (!items.length) root.append(empty('아직 세운 계획이 없어요', '지금 실제로 하고 있는 일 하나를 계획으로 옮겨 보세요.', h('button', { class: 'btn primary', onclick: () => planForm(null, reload) }, icon('plus'), '첫 계획 세우기')));
  const ul = h('ul', { class: 'list' });
  for (const p of items) {
    const pct = p.todo_count ? Math.round((p.done_count / p.todo_count) * 100) : 0;
    const changed = p.revision_count > 0;
    const summary = [`할 일 ${p.done_count}/${p.todo_count} 완료`, '예상 ' + fmtMin(p.est_minutes), '우선순위 ' + PRIO[p.priority]].join(' · ');
    ul.append(h('li', { class: 'plan-card' },
      h('header', {}, h('div', {},
        h('div', { class: 'period' }, `${PERIOD[p.period_type]} · ${p.start_date} ~ ${p.end_date}`),
        h('div', { class: 'status-row' }, h('h3', {}, p.title), p.carried_from_review_id ? h('span', { class: 'chip see' }, '돌아보기에서 넘어옴') : null)),
        h('div', { class: 'item-actions' },
          h('button', { class: 'btn sm', onclick: () => planForm(p, reload) }, icon('edit'), '고치기'),
          h('button', { class: 'btn sm', onclick: () => showRevisions(p) }, icon('history'), `수정 이력 ${p.revision_count}`),
          h('button', { class: 'btn icon ghost danger', title: '지우기', 'aria-label': `"${p.title}" 계획 지우기`, onclick: () => deleteWithConfirm(p.title, `/api/plans/${p.id}`, reload) }, icon('trash')))),
      h('div', { class: 'criteria' }, h('span', { class: 'label' }, '성공 기준'), p.success_criteria),
      changed ? h('div', { class: 'orig' }, h('strong', {}, '처음 세운 계획: '), `${p.original.title} · ${PERIOD[p.original.period_type]} · ${p.original.start_date}~${p.original.end_date} · 우선순위 ${PRIO[p.original.priority]} · 예상 ${fmtMin(p.original.est_minutes)} · 성공 기준 "${p.original.success_criteria}"`) : null,
      h('div', { class: 'row between small muted mt3' }, h('span', {}, summary), h('b', {}, pct + '%')),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${p.title} 진행률` }, h('i', {}))));
    ul.lastChild.querySelector('.progress > i').style.width = pct + '%';
  }
  root.append(ul); view.replaceChildren(root);
}
function planForm(p, done) {
  const today = META.today;
  openForm({
    title: p ? '계획 고치기' : '계획 세우기',
    initial: p ? p : { start_date: today, end_date: today, period_type: 'week' },
    fields: [
      { name: 'title', label: '계획 이름', required: true, max: 100, full: true },
      { name: 'period_type', label: '기간 종류', type: 'select', options: Object.entries(PERIOD), required: true },
      { name: 'priority', label: '우선순위', type: 'select', options: prioOptions, default: 2 },
      { name: 'start_date', label: '시작일', type: 'date', required: true },
      { name: 'end_date', label: '종료일', type: 'date', required: true },
      { name: 'est_minutes', label: '예상 시간(분)', type: 'number', required: true, default: 120 },
      { name: 'success_criteria', label: '성공 기준', type: 'textarea', max: 300, required: true, full: true, help: '무엇이 되면 이 계획이 통과인지 적어요.' },
    ],
    onSubmit: async (v) => {
      const body = { ...v, priority: Number(v.priority) };
      if (p) await api(`/api/plans/${p.id}`, { method: 'PATCH', body }); else await api('/api/plans', { method: 'POST', body });
      toast(p ? '계획을 고쳤습니다. 수정 이력에 남았어요.' : '계획을 세웠습니다.'); done();
    },
  });
}
const FIELD_LABEL = { title: '이름', period_type: '기간 종류', start_date: '시작일', end_date: '종료일', priority: '우선순위', success_criteria: '성공 기준', est_minutes: '예상 시간(분)' };
function fmtRev(field, val) { if (val == null) return ''; if (field === 'priority') return PRIO[val] || val; if (field === 'period_type') return PERIOD[val] || val; return val; }
async function showRevisions(p) {
  const { items } = await api(`/api/plans/${p.id}/revisions`);
  openInfo(`수정 이력 — ${p.title}`, items.length
    ? h('table', { class: 'rev-table' }, h('thead', {}, h('tr', {}, ['언제', '항목', '예전 값', '지금 값'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', {}, items.map((r) => h('tr', {}, h('td', {}, fmtDT(r.changed_at)), h('td', {}, FIELD_LABEL[r.field] || r.field), h('td', {}, fmtRev(r.field, r.old_value)), h('td', {}, fmtRev(r.field, r.new_value))))))
    : h('p', { class: 'muted' }, '아직 고친 적이 없어요. 계획을 고치면 예전 값과 지금 값이 여기에 남습니다.'));
}

// ---------- 화면: 할 일 ----------
const todoFilter = { q: '', status: '', priority: '', tag: '', plan_id: '', sort: 'due' };
async function viewTodos() {
  const plans = await plansForSelect();
  const reload = () => route();
  const root = h('div', { class: 'stack' });
  root.append(pageHead('STEP 2 · DO', '할 일', '만들고, 고치고, 완료로 바꾸고, 되돌리고, 지울 수 있어요.',
    h('button', { class: 'btn primary', disabled: !plans.length, onclick: () => todoForm(null, plans, todoFilter.plan_id, reload) }, icon('plus'), '할 일 만들기')));
  if (!plans.length) { root.append(empty('먼저 계획이 필요해요', '할 일은 계획에 딸려 있어요. 계획을 하나 세우고 돌아오세요.', h('a', { class: 'btn primary', href: '#/plans' }, '계획 세우러 가기'))); view.replaceChildren(root); return; }

  const listBox = h('div', { class: 'stack', 'aria-live': 'polite' });
  const sel = (name, label, opts) => h('div', { class: 'field' }, h('label', { for: 'tf-' + name }, label), h('select', { id: 'tf-' + name, value: todoFilter[name], onchange: (e) => { todoFilter[name] = e.target.value; load(); } }, opts.map(([v, l]) => h('option', { value: v }, l))));
  const q = h('input', { id: 'tf-q', type: 'search', placeholder: '제목·메모·태그 검색', value: todoFilter.q });
  let timer; q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { todoFilter.q = q.value; load(); }, 250); });
  const tagIn = h('input', { id: 'tf-tag', placeholder: '예: 운동', value: todoFilter.tag });
  let timer2; tagIn.addEventListener('input', () => { clearTimeout(timer2); timer2 = setTimeout(() => { todoFilter.tag = tagIn.value.trim().replace(/^#/, ''); load(); }, 250); });
  root.append(h('div', { class: 'card' }, h('div', { class: 'toolbar' },
    h('div', { class: 'field' }, h('label', { for: 'tf-q' }, '검색'), q),
    sel('plan_id', '계획', [['', '전체'], ...plans.map((p) => [p.id, p.title])]),
    sel('status', '상태', [['', '전체'], ['open', '진행 중'], ['done', '완료'], ['delayed', '지연']]),
    sel('priority', '우선순위', [['', '전체'], ...prioOptions]),
    h('div', { class: 'field' }, h('label', { for: 'tf-tag' }, '태그'), tagIn)),
    h('div', { class: 'toolbar mt3' }, h('div', { class: 'field' }, h('label', { for: 'tf-sort' }, '정렬 기준'),
      h('select', { id: 'tf-sort', value: todoFilter.sort, onchange: (e) => { todoFilter.sort = e.target.value; load(); } }, Object.entries(META.sorts).map(([v, l]) => h('option', { value: v }, l)))))));
  root.append(listBox); view.replaceChildren(root);
  // 같은 화면에서 검색 입력창이 다시 그려지지 않도록 목록만 갱신
  async function load() {
    const qs = new URLSearchParams(Object.entries(todoFilter).filter(([, v]) => v !== '')).toString();
    const r = await api('/api/todos?' + qs);
    listBox.replaceChildren(
      h('p', { class: 'sort-note' }, icon('arrow'), h('span', {}, `현재 정렬: ${r.sort_label}. ${r.tie_rule} 검색·거르기·정렬은 ${r.filter_place}에서 처리해요. (${r.items.length}건)`)),
      r.items.length ? h('ul', { class: 'list' }, r.items.map((t) => todoItem(t, load)))
        : (Object.values(todoFilter).some((v) => v && v !== 'due')
          ? empty('조건에 맞는 할 일이 없어요', '검색어나 거르기 조건을 바꿔 보세요.', h('button', { class: 'btn', onclick: () => { Object.assign(todoFilter, { q: '', status: '', priority: '', tag: '', plan_id: '', sort: 'due' }); route(); } }, '조건 모두 지우기'))
          : empty('아직 할 일이 없어요', '계획에 딸린 할 일을 5개 정도 넣어 보세요.', h('button', { class: 'btn primary', onclick: () => todoForm(null, plans, null, load) }, icon('plus'), '할 일 만들기'))));
  }
  await load();
}

// ---------- 화면: 실행 기록 ----------
async function viewRuns() {
  const { items } = await api('/api/runs');
  const root = h('div', { class: 'stack' });
  root.append(pageHead('STEP 2 · DO', '실행 기록', '계획과 별개로, 실제로 언제 시작해서 얼마나 걸렸고 어디서 막혔는지 남겨요. 기록은 할 일 화면의 "기록" 버튼으로 추가해요.'));
  if (!items.length) root.append(empty('아직 실행 기록이 없어요', '할 일 화면에서 "기록" 버튼을 눌러 실제로 한 일을 적어 보세요.', h('a', { class: 'btn primary', href: '#/todos' }, '할 일로 가기')));
  else root.append(h('ul', { class: 'list' }, items.map((r) => {
    return h('li', { class: 'item two' },
      h('div', {}, h('div', { class: 'item-title' }, r.todo_title),
        h('div', { class: 'meta-line' }, h('span', {}, `${fmtDT(r.started_at)} → ${fmtDT(r.ended_at)}`), h('b', {}, '실제 ' + fmtMin(r.actual_minutes)),
          r.todo_est_minutes ? h('span', {}, '이 할 일 예상 ' + fmtMin(r.todo_est_minutes)) : null),
        r.blocker_reason ? h('p', { class: 'blocker' }, h('strong', {}, '막힌 이유: '), r.blocker_reason) : null),
      h('button', { class: 'btn icon ghost danger', title: '지우기', 'aria-label': '이 실행 기록 지우기', onclick: () => deleteWithConfirm(`${r.todo_title} 실행 기록`, `/api/runs/${r.id}`, () => route()) }, icon('trash')));
  })));
  view.replaceChildren(root);
}

// ---------- 화면: 돌아보기 ----------
const reviewState = { period: 'week', date: '', metric: '' };
const METRICS = [
  ['plans', '계획 수', (c) => c.plans], ['done', '완료 수', (c) => c.done], ['delayed', '지연 수', (c) => c.delayed], ['blocked', '막힘 수', (c) => c.blocked],
];
async function viewReview() {
  if (!reviewState.date) reviewState.date = META.today;
  const qs = `period=${reviewState.period}&date=${reviewState.date}`;
  const s = await api('/api/review?' + qs);
  const root = h('div', { class: 'stack' });
  root.append(pageHead('STEP 3 · SEE', '돌아보기', '예상과 실제의 차이를 근거 기록과 함께 보고, 고칠 점 한 가지를 다음 계획으로 넘겨요.'));
  root.append(h('div', { class: 'card' }, h('div', { class: 'form-grid' },
    h('div', { class: 'field' }, h('label', { for: 'rv-period' }, '기간 단위'), h('select', { id: 'rv-period', value: reviewState.period, onchange: (e) => { reviewState.period = e.target.value; reviewState.metric = ''; route(); } }, Object.entries(PERIOD).map(([v, l]) => h('option', { value: v }, l)))),
    h('div', { class: 'field' }, h('label', { for: 'rv-date' }, '기준 날짜'), h('input', { id: 'rv-date', type: 'date', value: reviewState.date, onchange: (e) => { if (e.target.value) { reviewState.date = e.target.value; reviewState.metric = ''; route(); } } }))),
    h('p', { class: 'small muted mt3' }, `대상 기간: ${s.range_start} ~ ${s.range_end} (서울 기준, 오늘은 ${s.today}). 이 기간과 겹치는 계획에 딸린 할 일 ${s.counts.todos}개를 셉니다.`)));

  const stats = h('div', { class: 'stats' });
  const statCard = (key, label, value, bad) => {
    const on = reviewState.metric === key;
    return h('button', { class: 'stat', type: 'button', 'aria-pressed': String(on), 'aria-label': `${label} ${value}. 눌러서 근거 기록 보기`, onclick: () => { reviewState.metric = key; route(); } },
      h('span', { class: 'lbl' }, label), h('span', { class: 'num' + (bad ? ' bad' : '') }, String(value)), h('span', { class: 'go' }, on ? '근거 보는 중' : '근거 보기 →'));
  };
  for (const [key, label, get] of METRICS) stats.append(statCard(key, label, get(s.counts), (key === 'delayed' || key === 'blocked') && get(s.counts) > 0));
  stats.append(statCard('actual', '실제 시간', fmtMin(s.minutes.actual), false));
  root.append(stats);

  // 근거 기록: 통계 카드 바로 아래
  if (reviewState.metric) {
    const r = await api(`/api/review/records?${qs}&metric=${reviewState.metric}`);
    const names = { plans: '계획', done: '완료한 할 일', delayed: '지연된 할 일', blocked: '막힌 할 일', estimated: '예상 시간이 있는 할 일', actual: '실행 기록이 있는 할 일' };
    root.append(h('div', { class: 'card detail-card', 'aria-live': 'polite' }, h('div', { class: 'row between' }, h('h3', { id: 'evidence-h', tabindex: '-1' }, `근거 기록 — ${names[r.metric]} ${r.items.length}건`), h('button', { class: 'btn sm', onclick: () => { reviewState.metric = ''; route(); } }, '닫기')),
      r.items.length ? h('ul', { class: 'list mt3' }, r.items.map((it) => r.kind === 'plans'
        ? h('li', { class: 'item one' }, h('div', {}, h('div', { class: 'item-title' }, it.title), h('div', { class: 'meta-line' }, h('span', {}, `${it.start_date} ~ ${it.end_date}`), h('span', {}, '예상 ' + fmtMin(it.est_minutes)))))
        : h('li', { class: 'item one' }, h('div', {}, h('div', { class: 'status-row' }, h('span', { class: 'item-title' }, it.title), todoStatus(it)), todoLine(it)))))
        : h('p', { class: 'muted mt2' }, '이 숫자를 만든 기록이 없어요.')));
  }

  // 예상 vs 실제
  const max = Math.max(s.minutes.estimated, s.minutes.actual, 1);
  const diff = s.minutes.diff;
  const bar = (cls, v) => { const f = h('div', { class: 'bar-fill ' + cls }); f.style.width = (v / max) * 100 + '%'; return h('div', { class: 'bar-track', 'aria-hidden': 'true' }, f); };
  root.append(h('section', { class: 'card', 'aria-labelledby': 'cmp-h' }, h('h3', { id: 'cmp-h' }, '예상 시간과 실제 시간'),
    h('div', { class: 'bars mt3' },
      h('div', { class: 'bar-row' }, h('span', {}, '예상'), bar('est', s.minutes.estimated), h('span', { class: 'val' }, fmtMin(s.minutes.estimated))),
      h('div', { class: 'bar-row' }, h('span', {}, '실제'), bar(diff > 0 ? 'over' : 'act', s.minutes.actual), h('span', { class: 'val' }, fmtMin(s.minutes.actual)))),
    h('p', { class: 'diff mt3' + (diff > 0 ? ' over' : diff < 0 ? ' under' : '') },
      diff > 0 ? `차이 +${fmtMin(diff)} (예상보다 오래 걸렸어요)` : diff < 0 ? `차이 ${fmtMin(diff)} (예상보다 빨랐어요)` : '차이 0분 (기록이 없거나 딱 맞았어요)'),
    h('p', { class: 'small muted' }, '차이 = 실제 시간 − 예상 시간'),
    h('div', { class: 'row mt2' }, h('button', { class: 'btn sm', onclick: () => { reviewState.metric = 'estimated'; route(); } }, '예상 시간 근거 보기'), h('button', { class: 'btn sm', onclick: () => { reviewState.metric = 'actual'; route(); } }, '실제 시간 근거 보기'))));

  // 다음 계획으로 넘기기
  const list = await api('/api/reviews');
  const input = h('input', { id: 'carry', maxlength: 200, placeholder: '예: 아침 운동은 20분으로 줄이고 매일 하기' });
  const btn = h('button', { class: 'btn primary', type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
    try { const r = await api('/api/reviews/carry', { method: 'POST', body: { carry_over: input.value, period: reviewState.period, date: reviewState.date } }); toast(`다음 계획 "${r.next_plan.title}"으로 넘겼어요.`); route(); }
    catch (er) { const m = er.fields.carry_over || er.message; const box = document.getElementById('carry-err'); box.hidden = false; box.textContent = m; input.setAttribute('aria-invalid', 'true'); input.focus(); }
  }) }, '다음 계획으로 넘기기');
  root.append(h('section', { class: 'card next-card', 'aria-labelledby': 'carry-h' }, h('div', { class: 'eyebrow' }, 'SEE → 다음 PLAN'), h('h3', { id: 'carry-h' }, '고칠 점 한 가지를 다음 계획으로'),
    h('p', { class: 'small muted' }, `적은 한 줄이 ${PERIOD[reviewState.period]} 뒤 기간의 새 계획으로 만들어져요.`),
    h('div', { class: 'field mt2' }, h('label', { for: 'carry' }, '고칠 점(한 줄)'), input, h('span', { class: 'error-text', id: 'carry-err', role: 'alert', hidden: true })),
    h('div', { class: 'row mt3' }, btn),
    list.items.length ? h('ul', { class: 'carry-list' }, list.items.map((v) => h('li', {}, `${v.range_start}~${v.range_end} → `, h('strong', {}, v.carry_over), v.next_plan_title ? ` (다음 계획: ${v.next_plan_title})` : ''))) : null));
  view.replaceChildren(root);
  if (reviewState.metric) document.getElementById('evidence-h')?.focus();
}

// ---------- 라우터 ----------
const VIEWS = { plans: viewPlans, todos: viewTodos, runs: viewRuns, review: viewReview };
async function route() {
  if (!ME) return;
  const key = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const name = VIEWS[key] ? key : 'plans';
  document.body.dataset.stage = { plans: 'plan', todos: 'do', runs: 'do', review: 'see' }[name];
  document.querySelectorAll('.tab').forEach((a) => (a.dataset.tab === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  try { await VIEWS[name](); }
  catch (e) { view.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, '불러오지 못했어요'), h('p', {}, e.message), h('button', { class: 'btn', onclick: () => route() }, '다시 시도'))); }
}
window.addEventListener('hashchange', () => { document.getElementById('main').focus({ preventScroll: true }); route(); });
// ---------- 로그인 · 가입 · 내 계정 ----------
let ME = null;
const accountBtn = document.getElementById('account');
function setAuthState(user) {
  ME = user;
  document.body.dataset.auth = user ? 'in' : 'out';
  accountBtn.querySelector('.who').textContent = user ? user.username : '';
}
// 로그인/가입 화면. 로그인 상태가 아닐 때 첫 화면은 항상 이것이다.
function showAuth(mode = 'login', message) {
  setAuthState(null);
  if (dlg.open) dlg.close();
  const isLogin = mode === 'login';
  const err = h('div', { class: 'error-summary', role: 'alert', tabindex: '-1', hidden: !message }, message || '');
  const mk = (id, label, type, help, auto) => ({
    id, input: h('input', { id, name: id, type, autocomplete: auto, required: true, maxlength: 128, 'aria-describedby': help ? `${id}-help` : false }),
    label, help,
  });
  const fUser = mk('au-username', '아이디', 'text', isLogin ? '' : '영문 소문자·숫자·. _ - 로 3~30자', 'username');
  const fPass = mk('au-password', '비밀번호', 'password', isLogin ? '' : '8자 이상 (영문·숫자·기호 자유)', isLogin ? 'current-password' : 'new-password');
  const field = (f) => h('div', { class: 'field' }, h('label', { for: f.id }, f.label), f.input, f.help ? h('span', { class: 'help', id: `${f.id}-help` }, f.help) : null, h('span', { class: 'error-text', id: `${f.id}-err`, hidden: true }));
  const submit = h('button', { class: 'btn primary', type: 'submit' }, isLogin ? '로그인' : '가입하고 시작하기');
  const form = h('form', { class: 'auth-form', novalidate: true }, field(fUser), field(fPass), h('div', { class: 'row mt3' }, submit));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    for (const f of [fUser, fPass]) { document.getElementById(`${f.id}-err`).hidden = true; f.input.removeAttribute('aria-invalid'); }
    await busy(submit, async () => {
      try {
        const r = await api(isLogin ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body: { username: fUser.input.value, password: fPass.input.value } });
        fPass.input.value = '';
        setAuthState({ username: r.user.username });
        location.hash = '#/plans';
        await route();
      } catch (e) {
        const fe = { 'au-username': e.fields.username, 'au-password': e.fields.password };
        const list = Object.entries(fe).filter(([, m]) => m);
        for (const [id, m] of list) { const box = document.getElementById(`${id}-err`); box.hidden = false; box.textContent = m; document.getElementById(id).setAttribute('aria-invalid', 'true'); }
        err.textContent = list.length ? '입력한 내용에 문제가 있습니다' : e.message; err.hidden = false; err.focus();
      }
    });
  });
  view.replaceChildren(h('section', { class: 'card auth-card', 'aria-labelledby': 'auth-h' },
    h('div', { class: 'eyebrow' }, isLogin ? '로그인' : '새 계정'),
    h('h2', { id: 'auth-h' }, isLogin ? '내 다이어리 열기' : '내 다이어리 만들기'),
    h('p', { class: 'lead' }, isLogin ? '내 계획과 기록은 로그인한 나만 볼 수 있어요.' : '아이디와 비밀번호만 있으면 돼요. 이메일은 받지 않아요.'),
    err, form,
    h('p', { class: 'small muted mt3' }, '계정을 지우면 내 자료도 함께 지워집니다.'),
    h('p', { class: 'mt2' }, isLogin ? '처음이신가요? ' : '이미 계정이 있나요? ',
      h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); showAuth(isLogin ? 'register' : 'login'); } }, isLogin ? '계정 만들기' : '로그인'))));
  document.getElementById('main').focus({ preventScroll: true });
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  showAuth('login', '로그아웃했어요.');
}
function openAccount() {
  const note = h('p', { class: 'small muted' }, '계정을 지우면 내 자료(계획·할 일·실행 기록·돌아보기)도 함께 지워지고 되돌릴 수 없어요. 지우기 전에 위의 "내 자료 파일로 내보내기"로 파일을 받아 두세요.');
  openInfo('내 계정',
    h('p', {}, '로그인한 아이디: ', h('strong', {}, ME.username)),
    h('div', { class: 'row mt3' },
      h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); logout(); } }, '로그아웃'),
      h('button', { class: 'btn', type: 'button', onclick: () => openForm({
        title: '비밀번호 바꾸기', submitLabel: '바꾸기',
        fields: [
          { name: 'current_password', label: '지금 비밀번호', type: 'password', full: true, required: true, max: 128 },
          { name: 'new_password', label: '새 비밀번호', type: 'password', full: true, required: true, max: 128, help: '8자 이상. 바꾸면 다른 기기의 로그인은 모두 풀려요.' },
        ],
        onSubmit: async (v) => { await api('/api/auth/password', { method: 'POST', body: v }); toast('비밀번호를 바꿨어요.'); },
      }) }, '비밀번호 바꾸기')),
    h('hr', { class: 'sep' }),
    h('h3', {}, '계정 삭제'), note,
    h('div', { class: 'row mt3' }, h('button', { class: 'btn danger', type: 'button', onclick: () => openForm({
      title: '계정을 지울까요?', submitLabel: '계정과 자료 지우기',
      fields: [{ name: 'password', label: '비밀번호 확인', type: 'password', full: true, required: true, max: 128, help: '지우면 내 자료도 함께 지워지고 되돌릴 수 없어요.' }],
      onSubmit: async (v) => { await api('/api/auth/delete-account', { method: 'POST', body: v }); showAuth('register', '계정과 자료를 지웠어요.'); },
    }) }, '계정 삭제…')));
}
accountBtn.addEventListener('click', openAccount);

(async () => {
  try {
    META = await api('/api/meta'); document.getElementById('notice-text').textContent = META.notice;
    const me = await api('/api/auth/me');
    if (!me.user) { showAuth('login'); return; }
    setAuthState(me.user);
  }
  catch (e) { if (e.handled) return; view.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, '서버에 연결할 수 없어요'), h('p', {}, '잠시 뒤 새로고침해 주세요.'))); return; }
  route();
})();
