// 실행: node tests/api.test.js   (임시 DB 사용, 실제 데이터에 영향 없음)
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `pds-test-${Date.now()}.db`);
process.env.DB_PATH = tmp; // TURSO_DATABASE_URL이 없으므로 로컬 file: DB(임시 파일)로 동작
delete process.env.TURSO_DATABASE_URL;
const { server, db } = require('../lib/server.js');
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('FAIL', m); } };
server.listen(0, async () => {
  const B = `http://localhost:${server.address().port}`;
  // jar: 계정별 쿠키 보관함. j는 계정 A, jb는 계정 B.
  const A = { cookie: '' }, Bk = { cookie: '' };
  const jf = async (jar, m, p, body, extra) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(jar.cookie ? { Cookie: jar.cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) jar.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0]; return { s: r.status, d: await r.json().catch(() => null), r, sc }; };
  const j = (m, p, body) => jf(A, m, p, body);
  const jb = (m, p, body) => jf(Bk, m, p, body);
  try {
    // ---- 로그인 없이는 아무 자료도 못 본다 ----
    for (const [m, p0] of [['GET', '/api/plans'], ['GET', '/api/todos'], ['GET', '/api/runs'], ['GET', '/api/review'], ['GET', '/api/export'], ['POST', '/api/plans']]) ok((await j(m, p0, m === 'POST' ? {} : undefined)).s === 401, `비로그인 ${p0} 401`);
    ok((await j('GET', '/api/auth/me')).d.user === null, '비로그인 me');
    // ---- 가입 ----
    ok((await j('POST', '/api/auth/register', { username: 'a', password: 'pw-12345678' })).s === 422, '짧은 아이디 거부');
    ok((await j('POST', '/api/auth/register', { username: 'alice', password: 'short' })).s === 422, '짧은 비밀번호 거부');
    const reg = await j('POST', '/api/auth/register', { username: 'Alice', password: 'pw-alice-12345' });
    ok(reg.s === 201 && /pds_session=/.test(reg.sc) && /HttpOnly/i.test(reg.sc) && /SameSite=Strict/i.test(reg.sc), 'C94 가입 + HttpOnly 쿠키');
    ok(!JSON.stringify(reg.d).includes('pw-alice-12345') && !('token' in reg.d), '가입 응답에 비밀번호·토큰 없음');
    ok((await jb('POST', '/api/auth/register', { username: 'ALICE', password: 'other-password-1' })).s === 409, 'C98 같은 아이디(대소문자 무시) 두 번 가입 안 됨');
    ok((await j('GET', '/api/auth/me')).d.user.username === 'alice', 'C95 로그인 상태');
    const today = (await j('GET', '/api/meta')).d.today;
    const add = (n, d) => new Date(Date.parse(n + 'T00:00:00Z') + d * 864e5).toISOString().slice(0, 10);
    // 계획 C04~C08
    const p = (await j('POST', '/api/plans', { title: '아침 운동', period_type: 'week', start_date: add(today, -3), end_date: add(today, 3), priority: 1, success_criteria: '주 4회', est_minutes: 240 })).d;
    ok(p.id && p.period_type === 'week' && p.priority === 1 && p.success_criteria === '주 4회' && p.est_minutes === 240, 'C04-07 저장');
    const e1 = await j('PATCH', `/api/plans/${p.id}`, { title: '아침 운동 (수정)', est_minutes: 300 });
    ok(e1.d.id === p.id && e1.d.title === '아침 운동 (수정)', 'C08 id 유지');
    ok(e1.d.original.title === '아침 운동' && e1.d.original.est_minutes === 240, 'C08 처음 계획 보존');
    const rev = (await j('GET', `/api/plans/${p.id}/revisions`)).d.items;
    ok(rev.length === 2 && rev.some(r => r.field === 'est_minutes' && r.old_value === '240' && r.new_value === '300'), 'C08 이력 old/new');
    ok((await j('POST', '/api/plans', { title: '', period_type: 'x' })).s === 422, '검증 422');
    ok((await j('POST', '/api/plans', { title: 'a', period_type: 'day', start_date: '2026-02-30', end_date: '2026-03-01', priority: 2, success_criteria: 'a', est_minutes: 1 })).s === 422, '없는 날짜 거부');
    // 할 일 C09~C20
    const mk = async (o) => (await j('POST', '/api/todos', { plan_id: p.id, ...o })).d;
    const t1 = await mk({ title: '스트레칭', due_date: add(today, -1), priority: 2, tags: '운동, 아침', est_minutes: 10 });
    const t2 = await mk({ title: '달리기', due_date: add(today, 1), priority: 1, tags: ['운동'], est_minutes: 30 });
    const t3 = await mk({ title: '식단 기록', due_date: add(today, 1), priority: 1, est_minutes: 5, memo: '<b>x</b>' });
    const t4 = await mk({ title: '물 마시기', priority: 3, est_minutes: 0 });
    const t5 = await mk({ title: '수면 체크', due_date: add(today, 2), priority: 2, est_minutes: 5 });
    ok(t1.tags.join() === '아침,운동' && t1.due_date && t1.priority === 2 && t1.est_minutes === 10, 'C14-17 저장');
    ok((await j('PATCH', `/api/todos/${t4.id}`, { title: '물 2L 마시기' })).d.title === '물 2L 마시기', 'C10 수정');
    ok((await j('GET', '/api/todos?q=%EC%8B%9D%EB%8B%A8')).d.items.length === 1, 'C18 검색');
    ok((await j('GET', '/api/todos?tag=' + encodeURIComponent('운동'))).d.items.length === 2, 'C19 태그 거르기');
    ok((await j('GET', '/api/todos?q=%25')).d.items.length === 0, '검색 와일드카드 이스케이프');
    const s = (await j('GET', '/api/todos?sort=due')).d;
    ok(s.items.map(t => t.id).join() === [t1.id, t2.id, t3.id, t5.id, t4.id].join(), 'C20 정렬 due(동률 우선순위→id, null 마지막)');
    ok(s.sort_label && s.tie_rule, 'C20 기준 문구');
    // 완료 C11,C12,C21,C22
    const c1 = (await j('POST', `/api/todos/${t2.id}/complete`)).d;
    const c2 = (await j('POST', `/api/todos/${t2.id}/complete`)).d;
    await Promise.all([j('POST', `/api/todos/${t3.id}/complete`), j('POST', `/api/todos/${t3.id}/complete`)]);
    ok(c1.newly_completed && !c2.newly_completed, 'C21 두 번째는 새 완료 아님');
    ok(Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM completions WHERE todo_id IN (?,?)', args: [t2.id, t3.id] })).rows[0].c) === 2, 'C21 완료 기록 1건씩');
    let r = (await j('GET', `/api/review?period=week&date=${today}`)).d;
    ok(r.counts.done === 2, 'C22 완료 수 정확히');
    let threw = false; try { await db.execute({ sql: "INSERT INTO completions(todo_id,completed_at) VALUES (?, 'x')", args: [t2.id] }); } catch { threw = true; }
    ok(threw, 'C21 DB 유니크 제약');
    await j('POST', `/api/todos/${t3.id}/reopen`);
    ok((await j('GET', `/api/review?period=week&date=${today}`)).d.counts.done === 1, 'C12 되돌리기 반영');
    await j('POST', `/api/todos/${t3.id}/complete`);
    ok(Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM completions WHERE todo_id=? AND reopened_at IS NULL', args: [t3.id] })).rows[0].c) === 1, '재완료 후 유효 완료 1건');
    ok((await j('DELETE', `/api/todos/${t5.id}`)).s === 200 && (await j('GET', '/api/todos')).d.items.length === 4, 'C13 삭제');
    // 실행 기록 C23~C27
    const s0 = new Date(Date.now() - 3600e3).toISOString(), e0 = new Date().toISOString();
    const before = (await j('GET', '/api/plans')).d.items[0].est_minutes;
    const run = (await j('POST', `/api/todos/${t1.id}/runs`, { started_at: s0, ended_at: e0, actual_minutes: '', blocker_reason: '비가 와서' })).d;
    ok(run.actual_minutes === 60 && run.blocker_reason === '비가 와서' && run.started_at && run.ended_at, 'C23-26 실행 기록');
    ok((await j('GET', '/api/plans')).d.items[0].est_minutes === before && (await j('GET', '/api/todos')).d.items.find(t => t.id === t1.id).est_minutes === 10, 'C27 계획 값 안 덮임');
    ok((await j('POST', `/api/todos/${t2.id}/runs`, { started_at: e0, ended_at: s0 })).s === 422, '끝<시작 거부');
    await j('POST', `/api/todos/${t2.id}/runs`, { started_at: s0, ended_at: e0, actual_minutes: 20 });
    // 돌아보기 C28~C33
    r = (await j('GET', `/api/review?period=week&date=${today}`)).d;
    const rec = async (m) => (await j('GET', `/api/review/records?period=week&date=${today}&metric=${m}`)).d.items;
    ok(r.counts.plans === 1 && (await rec('plans')).length === 1, 'C28 계획 수');
    ok(r.counts.todos === 4 && (await rec('todos')).length === 4, 'C28 할일 수');
    ok(r.counts.done === (await rec('done')).length && r.counts.done === 2, 'C29 완료 수');
    ok(r.counts.delayed === 1 && (await rec('delayed'))[0].id === t1.id, 'C30 지연(완료 아님+마감<오늘)');
    ok(r.counts.blocked === 1 && (await rec('blocked'))[0].id === t1.id, 'C31 막힘');
    ok(r.minutes.estimated === 45 && r.minutes.actual === 80 && r.minutes.diff === 35, `C32 예상/실제/차이 ${JSON.stringify(r.minutes)}`);
    ok((await rec('actual')).length === 2, 'C83 실제 근거');
    await j('POST', `/api/todos/${t1.id}/complete`);
    ok((await j('GET', `/api/review?period=week&date=${today}`)).d.counts.delayed === 0, 'C30 완료하면 지연 아님');
    const empty = (await j('GET', '/api/review?period=day&date=1999-01-01')).d;
    ok(empty.minutes.diff === 0 && empty.counts.plans === 0, 'C32 없으면 0');
    const carry = await j('POST', '/api/reviews/carry', { carry_over: '운동은 20분으로', period: 'week', date: today });
    ok(carry.s === 201 && carry.d.next_plan.carried_from_review_id === carry.d.review_id && carry.d.next_plan.start_date > r.range_end, 'C33 다음 계획으로 넘김');
    ok((await j('POST', '/api/reviews/carry', { carry_over: '' })).s === 422, '빈 한 줄 거부');
    // 내보내기 C36
    const ex = await fetch(B + '/api/export', { headers: { Cookie: A.cookie } }); const exj = await ex.json();
    ok(/attachment/.test(ex.headers.get('content-disposition')) && exj.plans.length === 2 && exj.todos.length === 4 && exj.runs.length === 2, 'C36 내보내기');
    ok(exj.todos.find(t => t.id === t1.id).created_at.endsWith('Z'), 'C35 UTC ISO 저장');
    // 보안
    const x = (await mk({ title: '<script>alert(1)</script>' })).title;
    ok(x === '<script>alert(1)</script>', 'C57 글자 그대로 저장');
    const idx = await fetch(B + '/'); ok(idx.headers.get('content-security-policy').includes("script-src 'self'"), 'CSP');
    ok((await fetch(B + '/%2e%2e/server.js')).status === 404, '경로 탈출 차단');
    ok((await fetch(B + '/contracts/pds-schema-v2.json')).status === 200, '계약 파일 제공');
    ok(/로그인한 나만/.test((await j('GET', '/api/meta')).d.notice), '공개 범위 안내');
    // ---- 저장된 비밀번호 ----
    const hrow = (await db.execute({ sql: "SELECT password_hash FROM users WHERE username='alice'" })).rows[0][0];
    ok(hrow.startsWith('scrypt$') && !hrow.includes('pw-alice-12345'), 'C101-103 비밀번호는 scrypt 해시로만 저장');
    await jb('POST', '/api/auth/register', { username: 'bob', password: 'pw-alice-12345' }); // B: 같은 비밀번호
    const hrowB = (await db.execute({ sql: "SELECT password_hash FROM users WHERE username='bob'" })).rows[0][0];
    ok(hrowB !== hrow, 'C104 같은 비밀번호라도 저장값이 다르다(salt)');
    // ---- 로그인 실패 문구 ----
    const bad1 = await jf({ cookie: '' }, 'POST', '/api/auth/login', { username: 'alice', password: 'wrong-password-1' });
    const bad2 = await jf({ cookie: '' }, 'POST', '/api/auth/login', { username: 'nobody', password: 'wrong-password-1' });
    ok(bad1.s === 401 && bad2.s === 401 && bad1.d.error === bad2.d.error, 'C99 아이디 틀림·비밀번호 틀림 안내 문구 같음');
    ok(!bad1.sc, '실패 시 쿠키 안 줌');
    // ---- 계정 간 격리 ----
    const aPlan = p.id, aTodo = t1.id, aRun = run.id;
    const aTodoCount = (await j('GET', '/api/todos')).d.items.length;
    ok((await jb('GET', '/api/plans')).d.items.length === 0 && (await jb('GET', '/api/todos')).d.items.length === 0 && (await jb('GET', '/api/runs')).d.items.length === 0, 'C125 B 목록에 A 자료 없음');
    const bReview = (await jb('GET', `/api/review?period=week&date=${today}`)).d;
    ok(bReview.counts.plans === 0 && bReview.counts.todos === 0 && bReview.minutes.actual === 0, 'C125 B 돌아보기에 A 자료 없음');
    const deny = [
      ['PATCH', `/api/plans/${aPlan}`, { title: '해킹' }], ['DELETE', `/api/plans/${aPlan}`], ['GET', `/api/plans/${aPlan}/revisions`],
      ['PATCH', `/api/todos/${aTodo}`, { title: '해킹' }], ['DELETE', `/api/todos/${aTodo}`], ['POST', `/api/todos/${aTodo}/complete`], ['POST', `/api/todos/${aTodo}/reopen`],
      ['POST', `/api/todos/${aTodo}/runs`, { started_at: s0, ended_at: e0, actual_minutes: 5 }], ['DELETE', `/api/runs/${aRun}`],
    ];
    for (const [m, p0, b] of deny) { const r0 = await jb(m, p0, b); ok(r0.s === 404 || r0.s === 403, `C117-119 B가 A 자료 ${m} ${p0} → ${r0.s}`); }
    ok((await jb('POST', '/api/todos', { plan_id: aPlan, title: 'A 계획에 끼워넣기' })).s === 422, 'B가 A 계획에 할 일 못 붙임');
    const aAfter = (await j('GET', '/api/plans')).d.items.find((x) => x.id === aPlan);
    ok(aAfter && aAfter.title === '아침 운동 (수정)' && (await j('GET', '/api/todos')).d.items.length === aTodoCount && (await j('GET', '/api/runs')).d.items.length === 2, 'C120 거절된 뒤에도 A 자료 그대로');
    // 반대 방향: B 자료를 A가 건드리면 막힘
    const bp = (await jb('POST', '/api/plans', { title: 'B 계획', period_type: 'day', start_date: today, end_date: today, priority: 2, success_criteria: 'b', est_minutes: 10 })).d;
    const bt = (await jb('POST', '/api/todos', { plan_id: bp.id, title: 'B 할 일', est_minutes: 5 })).d;
    ok([(await j('PATCH', `/api/plans/${bp.id}`, { title: 'x' })).s, (await j('DELETE', `/api/todos/${bt.id}`)).s, (await j('POST', `/api/todos/${bt.id}/complete`)).s].every((c) => c === 404 || c === 403), 'C120 반대 방향도 거절');
    ok((await j('GET', '/api/todos')).d.items.every((x) => x.id !== bt.id) && (await j('GET', '/api/plans')).d.items.every((x) => x.id !== bp.id), 'C125 A 목록에 B 자료 없음');
    const exA = await (await fetch(B + '/api/export', { headers: { Cookie: A.cookie } })).json();
    ok(!JSON.stringify(exA).includes('B 계획') && !JSON.stringify(exA).includes('password') && !JSON.stringify(exA).includes('scrypt'), 'C133 내보내기에 남의 자료·비밀번호 없음');
    // ---- 6번 자료 가져오기 ----
    const Ck = { cookie: '' }; const jc = (m, p0, b) => jf(Ck, m, p0, b);
    ok((await jc('POST', '/api/import', exA)).s === 401, '가져오기: 비로그인 거절');
    await jc('POST', '/api/auth/register', { username: 'carol', password: 'pw-carol-12345' });
    ok((await jc('POST', '/api/import', { schema: 'other', plans: [] })).s === 422, '가져오기: 다른 형식 거부');
    const tampered = JSON.parse(JSON.stringify(exA)); tampered.todos[0].plan_id = 99999;
    ok((await jc('POST', '/api/import', tampered)).s === 422, '가져오기: 없는 계획을 가리키는 할 일 거부');
    ok((await jc('GET', '/api/plans')).d.items.length === 0, '거부된 가져오기는 아무것도 남기지 않음');
    const impR = await jc('POST', '/api/import', exA);
    ok(impR.s === 201 && impR.d.imported.plans === exA.plans.length && impR.d.imported.todos === exA.todos.length && impR.d.imported.runs === exA.runs.length, '가져오기 성공, 개수 일치');
    const cTodos = (await jc('GET', '/api/todos')).d.items, cRuns = (await jc('GET', '/api/runs')).d.items;
    ok(cTodos.length === exA.todos.length && cRuns.length === exA.runs.length, '가져온 할 일·실행 기록 수 일치');
    const srcT = exA.todos.find((x) => x.id === t1.id), dstT = cTodos.find((x) => x.title === srcT.title);
    ok(dstT && dstT.created_at === srcT.created_at && dstT.due_date === srcT.due_date && dstT.status === srcT.status && dstT.tags.join() === srcT.tags.join(), '날짜·시각·상태·태그가 원본 그대로');
    ok(cRuns.some((r) => r.started_at === run.started_at && r.blocker_reason === '비가 와서'), '실행 기록 시각·막힘 이유 원본 그대로');
    ok((await jc('POST', '/api/import', exA)).s === 409, '두 번 가져오기 거절');
    const imps = (await jc('GET', '/api/imports')).d.items;
    ok(imps.length === 1 && imps[0].counts.todos === exA.todos.length && imps[0].imported_at, '가져온 이력이 남음');
    ok((await j('GET', '/api/plans')).d.items.find((x) => x.id === aPlan), '가져온 뒤에도 원래 계정 자료 그대로');
    const cr = (await jc('GET', `/api/review?period=week&date=${today}`)).d;
    const ar = (await j('GET', `/api/review?period=week&date=${today}`)).d;
    ok(cr.counts.todos === ar.counts.todos && cr.minutes.actual === ar.minutes.actual, '가져온 자료의 돌아보기 집계가 원본과 같음');
    ok((await jc('POST', '/api/auth/delete-account', { password: 'pw-carol-12345' })).s === 200, '가져온 계정도 삭제 가능');
    // ---- 세션 만료·로그아웃·비밀번호 변경 ----
    const oldCookie = A.cookie;
    await db.execute({ sql: "UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=(SELECT id FROM users WHERE username='bob')" });
    ok((await jb('GET', '/api/plans')).s === 401, 'C110-111 만료된 세션 거절');
    const lg = await jf(Bk, 'POST', '/api/auth/login', { username: 'bob', password: 'pw-alice-12345' });
    ok(lg.s === 200 && /pds_session=/.test(lg.sc), 'C95 로그인');
    const bOld = Bk.cookie;
    await jb('POST', '/api/auth/logout');
    ok((await jf({ cookie: bOld }, 'GET', '/api/plans')).s === 401, 'C96·C114 로그아웃 뒤 옛 세션 거절');
    ok((await jf({ cookie: '' }, 'GET', '/api/todos')).s === 401, 'C97 로그아웃 상태에서 자료 요청 거절');
    const pw = await j('POST', '/api/auth/password', { current_password: 'wrong', new_password: 'new-password-123' });
    ok(pw.s === 422, '현재 비밀번호 틀리면 변경 거부');
    const pw2 = await j('POST', '/api/auth/password', { current_password: 'pw-alice-12345', new_password: 'new-password-123' });
    ok(pw2.s === 200, '비밀번호 변경');
    ok((await jf({ cookie: oldCookie }, 'GET', '/api/plans')).s === 401, 'C114 비밀번호 바꾼 뒤 옛 세션 거절');
    ok((await j('GET', '/api/plans')).s === 200, '변경 뒤 새 세션으로는 계속 사용');
    ok((await jf({ cookie: '' }, 'POST', '/api/auth/login', { username: 'alice', password: 'pw-alice-12345' })).s === 401, '옛 비밀번호로 로그인 안 됨');
    // CSRF: 다른 사이트 Origin
    ok((await jf(A, 'POST', '/api/plans', {}, { Origin: 'https://evil.example' })).s === 403, '다른 Origin 요청 차단');
    // ---- 계정 삭제 ----
    ok((await j('POST', '/api/auth/delete-account', { password: 'wrong' })).s === 422, '삭제: 비밀번호 틀리면 거부');
    ok((await j('POST', '/api/auth/delete-account', { password: 'new-password-123' })).s === 200, 'C134 계정 삭제');
    const left = async (sql) => Number((await db.execute(sql)).rows[0][0]);
    ok(await left("SELECT COUNT(*) FROM users WHERE username='alice'") === 0 && await left(`SELECT COUNT(*) FROM plans WHERE id=${aPlan}`) === 0 && await left(`SELECT COUNT(*) FROM todos WHERE id=${aTodo}`) === 0 && await left('SELECT COUNT(*) FROM runs WHERE todo_id=' + aTodo) === 0, 'C134 계정과 자료 함께 삭제');
    ok(await left(`SELECT COUNT(*) FROM plans WHERE id=${bp.id}`) === 1, '다른 계정 자료는 남음');
    ok((await j('GET', '/api/plans')).s === 401, '삭제 뒤 세션 거절');
  } catch (e) { failN++; console.log('ERR', e); }
  console.log(`\n${pass} passed, ${failN} failed`);
  server.close(); db.close();
  // Windows에서는 네이티브 핸들이 프로세스 종료 때까지 파일을 잡고 있어, 바로 지우지 못하면 종료 뒤 지우는 정리 프로세스를 띄운다.
  const files = [tmp, tmp + '-wal', tmp + '-shm', tmp + '-journal'];
  const left = files.filter((f) => { try { fs.unlinkSync(f); return false; } catch (e) { return e.code !== 'ENOENT'; } });
  if (left.length) require('child_process').spawn(process.execPath, ['-e', `const fs=require('fs');let n=0;const t=setInterval(()=>{const L=${JSON.stringify(left)}.filter(f=>{try{fs.unlinkSync(f);return false}catch(e){return e.code!=='ENOENT'}});if(!L.length||++n>50)clearInterval(t)},200)`], { detached: true, stdio: 'ignore' }).unref();
  process.exit(failN ? 1 : 0);
});
