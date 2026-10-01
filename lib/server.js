'use strict';
// 플랜두씨 다이어리: 계획(Plan) -> 실제로 한 일(Do) -> 돌아보기(See)
// DB는 @libsql/client. TURSO_DATABASE_URL(+TURSO_AUTH_TOKEN)이 있으면 Turso 원격, 없으면 로컬 파일(로컬 개발·테스트용).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { createClient } = require('@libsql/client');
const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pds.db');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CONTRACT_DIR = path.join(__dirname, '..', 'contracts');
const NOTICE = '내 기록은 로그인한 나만 볼 수 있습니다. 계정을 지우면 내 자료도 함께 지워집니다.';
const SESSION_DAYS = 7;
const COOKIE = 'pds_session';
const MAX_BODY = 64 * 1024;

const REMOTE = !!process.env.TURSO_DATABASE_URL;
let client;
if (REMOTE) {
  client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
} else {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  client = createClient({ url: pathToFileURL(path.resolve(DB_PATH)).href });
}
const db = client;

// 스키마는 콜드 스타트 때 한 번만 만든다(모듈 수준 memoized Promise).
// 같은 할 일에 "현재 유효한" 완료 기록은 한 건만 허용하는 부분 유니크 인덱스(ux_completion_active)가 최종 방어선.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  period_type TEXT NOT NULL CHECK (period_type IN ('day','week','month')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority IN (1,2,3)),
  success_criteria TEXT NOT NULL CHECK (length(success_criteria) BETWEEN 1 AND 300),
  est_minutes INTEGER NOT NULL CHECK (est_minutes >= 0),
  original_json TEXT NOT NULL,
  carried_from_review_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS plan_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  memo TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  due_date TEXT,
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority IN (1,2,3)),
  est_minutes INTEGER NOT NULL DEFAULT 0 CHECK (est_minutes >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS todo_tags (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (todo_id, tag)
)`,
  `CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  actual_minutes INTEGER NOT NULL CHECK (actual_minutes >= 0),
  blocker_reason TEXT NOT NULL DEFAULT '' CHECK (length(blocker_reason) <= 300),
  created_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL,
  reopened_at TEXT
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_completion_active ON completions(todo_id) WHERE reopened_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  carry_over TEXT NOT NULL CHECK (length(carry_over) BETWEEN 1 AND 200),
  next_plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  exported_at TEXT,
  counts_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS ix_todos_plan ON todos(plan_id)`,
  `CREATE INDEX IF NOT EXISTS ix_runs_todo ON runs(todo_id)`
];
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      if (!REMOTE) await client.execute('PRAGMA foreign_keys = ON'); // 로컬 파일 전용(원격 Turso는 기본 ON)
      try { await client.batch(SCHEMA, 'write'); }
      catch (e) {
        // 어느 문장이 거절됐는지 로그에 남긴다(비밀값은 포함하지 않음).
        for (const stmt of SCHEMA) { try { await client.execute(stmt); } catch (e2) { console.error('schema statement failed:', stmt.replace(/\s+/g, ' ').slice(0, 80), '->', e2.message); } }
        throw e;
      }
      // 6번 과제에서 만든 옛 DB에는 user_id 열이 없다. 열이 없을 때만 붙인다(주인 없는 옛 자료는 user_id가 비어 있다).
      for (const tbl of ['plans', 'reviews']) {
        try { await client.execute(`SELECT user_id FROM ${tbl} LIMIT 0`); }
        catch { await client.execute(`ALTER TABLE ${tbl} ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`); }
      }
      await client.batch(['CREATE INDEX IF NOT EXISTS ix_plans_user ON plans(user_id)', 'CREATE INDEX IF NOT EXISTS ix_reviews_user ON reviews(user_id)'], 'write');
    })().catch((e) => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

// 결과 행을 일반 객체로 통일하고 BigInt는 Number로 바꾼다.
const norm = (v) => (typeof v === 'bigint' ? Number(v) : v);
const toObj = (rs, r) => { const o = {}; rs.columns.forEach((c, i) => { o[c] = norm(r[i]); }); return o; };
async function all(ex, sql, args = []) { const rs = await ex.execute({ sql, args }); return rs.rows.map((r) => toObj(rs, r)); }
async function get(ex, sql, args = []) { return (await all(ex, sql, args))[0]; }
async function run(ex, sql, args = []) { const rs = await ex.execute({ sql, args }); return { changes: Number(rs.rowsAffected), lastInsertRowid: Number(rs.lastInsertRowid ?? 0) }; }

// ---------- 시간 규칙: 저장은 UTC ISO, 날짜(YYYY-MM-DD)와 "오늘"은 서울(Asia/Seoul) 기준 ----------
const KST_MS = 9 * 3600 * 1000;
const nowIso = () => new Date().toISOString();
const todayKst = () => new Date(Date.now() + KST_MS).toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function periodRange(period, anchor) {
  if (period === 'day') return [anchor, anchor];
  if (period === 'week') {
    const dow = new Date(anchor + 'T00:00:00Z').getUTCDay(); // 0=일
    const start = addDays(anchor, -((dow + 6) % 7)); // 월요일 시작
    return [start, addDays(start, 6)];
  }
  const [y, m] = anchor.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [start, end];
}

// ---------- 검증 ----------
class HttpError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields || {}; }
}
const str = (v) => (typeof v === 'string' ? v.trim() : '');
function requireInt(v, min, max) {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}
function parseTags(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s#]+/) : [];
  const out = [];
  for (const t of list) {
    const tag = String(t).trim().replace(/^#/, '').toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function validatePlan(b, partial) {
  const f = {}; const v = {};
  if (!partial || 'title' in b) { const t = str(b.title); if (!t || t.length > 100) f.title = '제목은 1~100자로 적어 주세요.'; else v.title = t; }
  if (!partial || 'period_type' in b) { if (!['day', 'week', 'month'].includes(b.period_type)) f.period_type = '기간 종류를 골라 주세요.'; else v.period_type = b.period_type; }
  if (!partial || 'start_date' in b) { if (!isDate(b.start_date)) f.start_date = '시작일을 날짜로 적어 주세요.'; else v.start_date = b.start_date; }
  if (!partial || 'end_date' in b) { if (!isDate(b.end_date)) f.end_date = '종료일을 날짜로 적어 주세요.'; else v.end_date = b.end_date; }
  if (!partial || 'priority' in b) { const p = requireInt(b.priority, 1, 3); if (p === null) f.priority = '우선순위를 골라 주세요.'; else v.priority = p; }
  if (!partial || 'success_criteria' in b) { const s = str(b.success_criteria); if (!s || s.length > 300) f.success_criteria = '성공 기준을 1~300자로 적어 주세요.'; else v.success_criteria = s; }
  if (!partial || 'est_minutes' in b) { const m = requireInt(b.est_minutes, 0, 100000); if (m === null) f.est_minutes = '예상 시간은 0 이상의 정수(분)로 적어 주세요.'; else v.est_minutes = m; }
  return { f, v };
}

async function validateTodo(b, partial, uid) {
  const f = {}; const v = {};
  if (!partial || 'plan_id' in b) { const p = requireInt(b.plan_id, 1, Number.MAX_SAFE_INTEGER); if (p === null || !(await get(db, 'SELECT 1 FROM plans WHERE id=? AND user_id=?', [p, uid]))) f.plan_id = '계획을 골라 주세요.'; else v.plan_id = p; }
  if (!partial || 'title' in b) { const t = str(b.title); if (!t || t.length > 100) f.title = '할 일 제목은 1~100자로 적어 주세요.'; else v.title = t; }
  if ('memo' in b) { const m = str(b.memo); if (m.length > 500) f.memo = '메모는 500자까지 적을 수 있습니다.'; else v.memo = m; }
  if ('due_date' in b) { if (b.due_date === null || b.due_date === '') v.due_date = null; else if (!isDate(b.due_date)) f.due_date = '마감일을 날짜로 적어 주세요.'; else v.due_date = b.due_date; }
  if (!partial || 'priority' in b) { const p = requireInt(b.priority ?? 2, 1, 3); if (p === null) f.priority = '우선순위를 골라 주세요.'; else v.priority = p; }
  if ('est_minutes' in b) { const m = requireInt(b.est_minutes === '' ? 0 : b.est_minutes, 0, 100000); if (m === null) f.est_minutes = '예상 시간은 0 이상의 정수(분)로 적어 주세요.'; else v.est_minutes = m; }
  if ('tags' in b) { const tags = parseTags(b.tags); if (tags.length > 10 || tags.some((t) => t.length > 20)) f.tags = '태그는 10개까지, 각 20자 이내로 적어 주세요.'; else v.tags = tags; }
  return { f, v };
}

function fail(f) { if (Object.keys(f).length) throw new HttpError(422, '입력값을 확인해 주세요.', f); }

// ---------- 조회 ----------
async function tagsOf(ids, ex = db) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await all(ex, `SELECT todo_id, tag FROM todo_tags WHERE todo_id IN (${ids.map(() => '?').join(',')}) ORDER BY tag`, ids);
  for (const r of rows) { if (!map.has(r.todo_id)) map.set(r.todo_id, []); map.get(r.todo_id).push(r.tag); }
  return map;
}
async function decorateTodos(rows, ex = db) {
  const tags = await tagsOf(rows.map((r) => r.id), ex);
  const today = todayKst();
  return rows.map((r) => ({ ...r, tags: tags.get(r.id) || [], is_delayed: r.status === 'open' && !!r.due_date && r.due_date < today }));
}
const TODO_SELECT = `SELECT t.*, p.title AS plan_title,
  (SELECT COALESCE(SUM(actual_minutes),0) FROM runs r WHERE r.todo_id=t.id) AS actual_minutes,
  (SELECT COUNT(*) FROM runs r WHERE r.todo_id=t.id) AS run_count,
  (SELECT COUNT(*) FROM runs r WHERE r.todo_id=t.id AND r.blocker_reason <> '') AS blocked_runs
  FROM todos t JOIN plans p ON p.id=t.plan_id`;

const SORTS = {
  due: { label: '마감일 빠른 순', sql: `(t.due_date IS NULL) ASC, t.due_date ASC` },
  priority: { label: '우선순위 높은 순', sql: `t.priority ASC` },
  created: { label: '최근에 만든 순', sql: `t.created_at DESC` },
  est: { label: '예상 시간 긴 순', sql: `t.est_minutes DESC` },
};
const TIE = '같은 값이면 번호(ID)가 작은 순으로 정합니다.';

async function listTodos(q, uid) {
  const where = ['p.user_id = ?']; const args = [uid];
  if (q.plan_id) { where.push('t.plan_id = ?'); args.push(Number(q.plan_id)); }
  if (q.status === 'open' || q.status === 'done') { where.push('t.status = ?'); args.push(q.status); }
  if (q.status === 'delayed') { where.push("t.status='open' AND t.due_date IS NOT NULL AND t.due_date < ?"); args.push(todayKst()); }
  if (q.priority) { where.push('t.priority = ?'); args.push(Number(q.priority)); }
  if (q.tag) { where.push('EXISTS (SELECT 1 FROM todo_tags g WHERE g.todo_id=t.id AND g.tag=?)'); args.push(String(q.tag).toLowerCase()); }
  if (q.q) {
    const like = '%' + String(q.q).trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.memo LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM todo_tags g WHERE g.todo_id=t.id AND g.tag LIKE ? ESCAPE '\\'))`);
    args.push(like, like, like);
  }
  const sort = SORTS[q.sort] ? q.sort : 'due';
  const sql = `${TODO_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${SORTS[sort].sql}, t.priority ASC, t.id ASC`;
  const rows = await decorateTodos(await all(db, sql, args));
  return { sort, sort_label: SORTS[sort].label, tie_rule: TIE, filter_place: '서버(SQL)', items: rows };
}
const getTodo = async (id, uid, ex = db) => (await decorateTodos(await all(ex, `${TODO_SELECT} WHERE t.id=? AND p.user_id=?`, [id, uid]), ex))[0];

async function planRow(p, ex = db) {
  const s = await get(ex, `SELECT COUNT(*) AS todo_count, COALESCE(SUM(status='done'),0) AS done_count FROM todos WHERE plan_id=?`, [p.id]);
  const rev = Number((await get(ex, 'SELECT COUNT(*) AS c FROM plan_revisions WHERE plan_id=?', [p.id])).c);
  const { original_json, ...rest } = p;
  return { ...rest, original: JSON.parse(original_json), todo_count: Number(s.todo_count), done_count: Number(s.done_count), revision_count: rev };
}

// ---------- 돌아보기 ----------
// 집계 숫자는 "근거 기록 목록의 길이"로 계산한다. 그래서 숫자와 눌러서 나오는 목록이 항상 같다.
async function reviewData(period, anchor, uid) {
  const [from, to] = periodRange(period, anchor);
  const today = todayKst();
  const plans = await all(db, 'SELECT * FROM plans WHERE user_id = ? AND start_date <= ? AND end_date >= ? ORDER BY id', [uid, to, from]);
  const planIds = plans.map((p) => p.id);
  const todos = planIds.length
    ? await decorateTodos(await all(db, `${TODO_SELECT} WHERE t.plan_id IN (${planIds.map(() => '?').join(',')}) ORDER BY t.id`, planIds))
    : [];
  const done = todos.filter((t) => t.status === 'done');
  const delayed = todos.filter((t) => t.status === 'open' && t.due_date && t.due_date < today);
  const blocked = todos.filter((t) => t.blocked_runs > 0);
  const est = todos.reduce((a, t) => a + t.est_minutes, 0);
  const actual = todos.reduce((a, t) => a + t.actual_minutes, 0);
  return { period, anchor, from, to, today, plans, todos, done, delayed, blocked, est, actual };
}
function reviewSummary(r) {
  return {
    period: r.period, anchor: r.anchor, range_start: r.from, range_end: r.to, today: r.today,
    counts: { plans: r.plans.length, todos: r.todos.length, done: r.done.length, delayed: r.delayed.length, blocked: r.blocked.length },
    minutes: { estimated: r.est, actual: r.actual, diff: r.actual - r.est },
    rules: {
      delayed: '완료되지 않았고 마감일이 서울 시간 기준 오늘보다 앞선 할 일 (완료한 일은 지연으로 세지 않음)',
      blocked: '막힌 이유가 한 번이라도 적힌 실행 기록이 있는 할 일',
      diff: '실제 시간 - 예상 시간 (양수면 초과, 음수면 절약, 기록이 없으면 0)',
    },
  };
}
async function reviewRecords(r, metric) {
  switch (metric) {
    case 'plans': return { kind: 'plans', items: await Promise.all(r.plans.map((p) => planRow(p))) };
    case 'todos': return { kind: 'todos', items: r.todos };
    case 'done': return { kind: 'todos', items: r.done };
    case 'delayed': return { kind: 'todos', items: r.delayed };
    case 'blocked': return { kind: 'todos', items: r.blocked };
    case 'estimated': return { kind: 'todos', items: r.todos.filter((t) => t.est_minutes > 0) };
    case 'actual': return { kind: 'todos', items: r.todos.filter((t) => t.run_count > 0) };
    default: throw new HttpError(400, '알 수 없는 집계 항목입니다.');
  }
}

// ---------- 트랜잭션 도우미 ----------
// 쓰기 트랜잭션: client.transaction('write')로 감싸고 commit/rollback. 같은 프로세스 안에서는 순서대로 실행한다.
let txQueue = Promise.resolve();
function tx(fn) {
  const run_ = async () => {
    const t = await client.transaction('write');
    try { const out = await fn(t); await t.commit(); return out; } catch (e) { try { await t.rollback(); } catch {} throw e; } finally { t.close(); }
  };
  const p = txQueue.then(run_, run_);
  txQueue = p.catch(() => {});
  return p;
}

async function setTags(ex, todoId, tags) {
  await run(ex, 'DELETE FROM todo_tags WHERE todo_id=?', [todoId]);
  for (const t of tags) await run(ex, 'INSERT INTO todo_tags(todo_id, tag) VALUES (?,?)', [todoId, t]);
}

// 남의 할 일은 "없는 것"과 똑같이 404로 답한다(존재 여부도 알려 주지 않음).
const ownTodo = (ex, id, uid) => get(ex, 'SELECT t.* FROM todos t JOIN plans p ON p.id=t.plan_id WHERE t.id=? AND p.user_id=?', [id, uid]);

// ---------- 라우터 ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, public: !!opts.public, bodyLimit: opts.bodyLimit });
const idOf = (p) => { const n = Number(p.id); if (!Number.isInteger(n) || n < 1) throw new HttpError(404, '찾을 수 없습니다.'); return n; };

route('GET', '/api/meta', () => ({ notice: NOTICE, today: todayKst(), timezone: 'Asia/Seoul', sorts: Object.fromEntries(Object.entries(SORTS).map(([k, v]) => [k, v.label])), tie_rule: TIE }), { public: true });

// ---------- 인증 ----------
// 비밀번호는 scrypt(메모리 많이 쓰는 해시)로 계정마다 다른 무작위 salt와 함께 저장한다. 원문은 저장도 기록도 하지 않는다.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}
async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const dk = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(dk, want);
}
// 없는 아이디로 로그인할 때도 같은 시간만큼 해시를 계산해, 응답 시간으로 아이디 유무를 알아내지 못하게 한다.
let dummyHash = null;
const getDummyHash = () => (dummyHash ||= hashPassword('dummy-password-for-timing'));

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const normUser = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
function checkPassword(v, field) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 128) return { [field]: '비밀번호는 8~128자로 적어 주세요.' };
  return null;
}
const LOGIN_FAIL = '아이디 또는 비밀번호가 올바르지 않습니다.';

// 세션 값은 무작위 32바이트. 브라우저 쿠키에만 있고, DB에는 SHA-256 해시만 저장한다(DB가 새도 그대로는 못 쓴다).
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
async function createSession(ex, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await run(ex, 'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',
    [sha256(token), userId, new Date(now).toISOString(), new Date(now + SESSION_DAYS * 86400e3).toISOString()]);
  return token;
}
const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
};
const isSecure = (req) => !!req.socket.encrypted || /https/i.test(String(req.headers['x-forwarded-proto'] || ''));
const sessionCookie = (req, token, maxAge) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
async function authenticate(req) {
  const token = cookieOf(req, COOKIE);
  if (!token) return null;
  const row = await get(db, 'SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', [sha256(token)]);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) { await run(db, 'DELETE FROM sessions WHERE token_hash=?', [sha256(token)]); return null; }
  return { id: row.id, username: row.username, expires_at: row.expires_at };
}

// 로그인 연타 방지(서버 한 대 안에서만 유효한 간단한 제한. 서버리스 여러 대에 걸친 완전한 제한은 아님).
const fails = new Map();
const FAIL_LIMIT = 8, FAIL_WINDOW = 15 * 60e3;
const failKey = (req, name) => `${String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()}|${name}`;
function checkLimit(key) {
  const e = fails.get(key);
  if (e && Date.now() - e.first > FAIL_WINDOW) fails.delete(key);
  const cur = fails.get(key);
  if (cur && cur.n >= FAIL_LIMIT) throw new HttpError(429, '로그인에 여러 번 실패했습니다. 15분 뒤에 다시 시도해 주세요.');
}
function noteFail(key) {
  const e = fails.get(key);
  if (!e) { if (fails.size > 5000) fails.clear(); fails.set(key, { n: 1, first: Date.now() }); } else e.n++;
}

route('GET', '/api/auth/me', async ({ req }) => { const u = await authenticate(req); return { user: u ? { id: u.id, username: u.username, expires_at: u.expires_at } : null }; }, { public: true });

route('POST', '/api/auth/register', async ({ req, body, headers }) => {
  const username = normUser(body.username);
  const f = {};
  if (!USERNAME_RE.test(username)) f.username = '아이디는 영문 소문자·숫자·. _ - 로 3~30자, 글자나 숫자로 시작해야 합니다.';
  Object.assign(f, checkPassword(body.password, 'password'));
  fail(f);
  const hash = await hashPassword(body.password);
  const now = nowIso();
  let token;
  try {
    token = await tx(async (t) => {
      const r = await run(t, 'INSERT INTO users(username,password_hash,created_at) VALUES (?,?,?)', [username, hash, now]);
      // 6번 과제에서 로그인 없이 쌓은 옛 자료(주인 없음)는 가장 먼저 가입한 계정의 것이 된다.
      if (Number((await get(t, 'SELECT COUNT(*) AS c FROM users')).c) === 1) {
        await run(t, 'UPDATE plans SET user_id=? WHERE user_id IS NULL', [r.lastInsertRowid]);
        await run(t, 'UPDATE reviews SET user_id=? WHERE user_id IS NULL', [r.lastInsertRowid]);
      }
      return createSession(t, r.lastInsertRowid);
    });
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, '이미 사용 중인 아이디입니다.', { username: '이미 사용 중인 아이디입니다.' });
    throw e;
  }
  headers['Set-Cookie'] = sessionCookie(req, token, SESSION_DAYS * 86400);
  return [201, { user: { username } }];
}, { public: true });

route('POST', '/api/auth/login', async ({ req, body, headers }) => {
  const username = normUser(body.username);
  const key = failKey(req, username);
  checkLimit(key);
  const row = typeof body.password === 'string' && username ? await get(db, 'SELECT * FROM users WHERE username=?', [username]) : null;
  const okPw = row ? await verifyPassword(body.password, row.password_hash) : (await verifyPassword(String(body.password ?? ''), await getDummyHash()), false);
  if (!row || !okPw) { noteFail(key); throw new HttpError(401, LOGIN_FAIL); }
  fails.delete(key);
  await run(db, 'DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
  const token = await createSession(db, row.id);
  headers['Set-Cookie'] = sessionCookie(req, token, SESSION_DAYS * 86400);
  return { user: { username: row.username } };
}, { public: true });

// 로그아웃: 서버에서 이 세션을 지운다. 이전에 받은 값은 이후 거절된다.
route('POST', '/api/auth/logout', async ({ req, headers }) => {
  const token = cookieOf(req, COOKIE);
  if (token) await run(db, 'DELETE FROM sessions WHERE token_hash=?', [sha256(token)]);
  headers['Set-Cookie'] = sessionCookie(req, '', 0);
  return { ok: true };
}, { public: true });

// 비밀번호 변경: 현재 비밀번호를 다시 확인하고, 이전에 발급한 세션을 전부 폐기한 뒤 새 세션을 준다.
route('POST', '/api/auth/password', async ({ req, body, user, headers }) => {
  const f = {};
  Object.assign(f, checkPassword(body.new_password, 'new_password'));
  const row = await get(db, 'SELECT * FROM users WHERE id=?', [user.id]);
  if (typeof body.current_password !== 'string' || !(await verifyPassword(body.current_password, row.password_hash))) f.current_password = '현재 비밀번호가 맞지 않습니다.';
  else if (body.new_password === body.current_password) f.new_password = '현재 비밀번호와 다른 비밀번호를 적어 주세요.';
  fail(f);
  const hash = await hashPassword(body.new_password);
  const token = await tx(async (t) => {
    await run(t, 'UPDATE users SET password_hash=? WHERE id=?', [hash, user.id]);
    await run(t, 'DELETE FROM sessions WHERE user_id=?', [user.id]);
    return createSession(t, user.id);
  });
  headers['Set-Cookie'] = sessionCookie(req, token, SESSION_DAYS * 86400);
  return { ok: true };
});

// 계정 삭제: 비밀번호를 다시 확인하고, 내 자료와 세션을 함께 지운다.
route('POST', '/api/auth/delete-account', async ({ req, body, user, headers }) => {
  const row = await get(db, 'SELECT * FROM users WHERE id=?', [user.id]);
  if (typeof body.password !== 'string' || !(await verifyPassword(body.password, row.password_hash))) fail({ password: '비밀번호가 맞지 않습니다.' });
  const mineTodos = 'SELECT t.id FROM todos t JOIN plans p ON p.id=t.plan_id WHERE p.user_id=?';
  const minePlans = 'SELECT id FROM plans WHERE user_id=?';
  await tx(async (t) => {
    for (const tbl of ['runs', 'completions', 'todo_tags']) await run(t, `DELETE FROM ${tbl} WHERE todo_id IN (${mineTodos})`, [user.id]);
    await run(t, `DELETE FROM todos WHERE plan_id IN (${minePlans})`, [user.id]);
    await run(t, `DELETE FROM plan_revisions WHERE plan_id IN (${minePlans})`, [user.id]);
    await run(t, 'DELETE FROM reviews WHERE user_id=?', [user.id]);
    await run(t, 'DELETE FROM plans WHERE user_id=?', [user.id]);
    await run(t, 'DELETE FROM imports WHERE user_id=?', [user.id]);
    await run(t, 'DELETE FROM sessions WHERE user_id=?', [user.id]);
    await run(t, 'DELETE FROM users WHERE id=?', [user.id]);
  });
  headers['Set-Cookie'] = sessionCookie(req, '', 0);
  return { deleted: true };
});

route('GET', '/api/plans', async ({ user }) => ({ items: await Promise.all((await all(db, 'SELECT * FROM plans WHERE user_id=? ORDER BY start_date DESC, id DESC', [user.id])).map((p) => planRow(p))) }));
route('POST', '/api/plans', async ({ body, user }) => {
  const { f, v } = validatePlan(body, false); fail(f);
  if (v.end_date < v.start_date) fail({ end_date: '종료일은 시작일보다 빠를 수 없습니다.' });
  const now = nowIso();
  const id = await tx(async (t) => {
    const r = await run(t, `INSERT INTO plans(user_id,title,period_type,start_date,end_date,priority,success_criteria,est_minutes,original_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [user.id, v.title, v.period_type, v.start_date, v.end_date, v.priority, v.success_criteria, v.est_minutes, JSON.stringify(v), now, now]);
    return r.lastInsertRowid;
  });
  return [201, await planRow(await get(db, 'SELECT * FROM plans WHERE id=? AND user_id=?', [id, user.id]))];
});
route('PATCH', '/api/plans/:id', async ({ params, body, user }) => {
  const id = idOf(params);
  const cur = await get(db, 'SELECT * FROM plans WHERE id=? AND user_id=?', [id, user.id]);
  if (!cur) throw new HttpError(404, '계획을 찾을 수 없습니다.');
  const { f, v } = validatePlan(body, true); fail(f);
  const merged = { ...cur, ...v };
  if (merged.end_date < merged.start_date) fail({ end_date: '종료일은 시작일보다 빠를 수 없습니다.' });
  const now = nowIso();
  await tx(async (t) => {
    for (const k of Object.keys(v)) if (String(cur[k]) !== String(v[k])) await run(t, 'INSERT INTO plan_revisions(plan_id,field,old_value,new_value,changed_at) VALUES (?,?,?,?,?)', [id, k, String(cur[k]), String(v[k]), now]);
    // 계획 ID는 그대로 두고 내용만 바꾼다. 처음 세운 값은 original_json에 그대로 남는다.
    await run(t, `UPDATE plans SET title=?,period_type=?,start_date=?,end_date=?,priority=?,success_criteria=?,est_minutes=?,updated_at=? WHERE id=?`,
      [merged.title, merged.period_type, merged.start_date, merged.end_date, merged.priority, merged.success_criteria, merged.est_minutes, now, id]);
  });
  return planRow(await get(db, 'SELECT * FROM plans WHERE id=? AND user_id=?', [id, user.id]));
});
route('GET', '/api/plans/:id/revisions', async ({ params, user }) => {
  const id = idOf(params);
  if (!(await get(db, 'SELECT 1 FROM plans WHERE id=? AND user_id=?', [id, user.id]))) throw new HttpError(404, '계획을 찾을 수 없습니다.');
  return { items: await all(db, 'SELECT * FROM plan_revisions WHERE plan_id=? ORDER BY id DESC', [id]) };
});
route('DELETE', '/api/plans/:id', async ({ params, user }) => {
  const id = idOf(params);
  const r = await run(db, 'DELETE FROM plans WHERE id=? AND user_id=?', [id, user.id]);
  if (!r.changes) throw new HttpError(404, '계획을 찾을 수 없습니다.');
  return { deleted: id };
});

route('GET', '/api/todos', ({ query, user }) => listTodos(query, user.id));
route('POST', '/api/todos', async ({ body, user }) => {
  const { f, v } = await validateTodo(body, false, user.id); fail(f);
  const now = nowIso();
  const id = await tx(async (t) => {
    const r = await run(t, `INSERT INTO todos(plan_id,title,memo,due_date,priority,est_minutes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      [v.plan_id, v.title, v.memo ?? '', v.due_date ?? null, v.priority, v.est_minutes ?? 0, now, now]);
    await setTags(t, r.lastInsertRowid, v.tags || []);
    return r.lastInsertRowid;
  });
  return [201, await getTodo(id, user.id)];
});
route('PATCH', '/api/todos/:id', async ({ params, body, user }) => {
  const id = idOf(params);
  const cur = await ownTodo(db, id, user.id);
  if (!cur) throw new HttpError(404, '할 일을 찾을 수 없습니다.');
  const { f, v } = await validateTodo(body, true, user.id); fail(f);
  const m = { ...cur, ...v };
  await tx(async (t) => {
    await run(t, 'UPDATE todos SET plan_id=?,title=?,memo=?,due_date=?,priority=?,est_minutes=?,updated_at=? WHERE id=?',
      [m.plan_id, m.title, m.memo, m.due_date, m.priority, m.est_minutes, nowIso(), id]);
    if (v.tags) await setTags(t, id, v.tags);
  });
  return getTodo(id, user.id);
});
// 완료: 이미 완료라면 아무것도 바꾸지 않고 기존 결과를 돌려준다(멱등). DB 부분 유니크 인덱스가 최종 방어선.
route('POST', '/api/todos/:id/complete', async ({ params, user }) => {
  const id = idOf(params);
  return tx(async (t) => {
    const cur = await ownTodo(t, id, user.id);
    if (!cur) throw new HttpError(404, '할 일을 찾을 수 없습니다.');
    let created = false;
    if (cur.status !== 'done') {
      const now = nowIso();
      await run(t, "UPDATE todos SET status='done', completed_at=?, updated_at=? WHERE id=?", [now, now, id]);
      await run(t, 'INSERT OR IGNORE INTO completions(todo_id, completed_at) VALUES (?,?)', [id, now]);
      created = true;
    }
    return { todo: await getTodo(id, user.id, t), newly_completed: created };
  });
});
route('POST', '/api/todos/:id/reopen', async ({ params, user }) => {
  const id = idOf(params);
  return tx(async (t) => {
    const cur = await ownTodo(t, id, user.id);
    if (!cur) throw new HttpError(404, '할 일을 찾을 수 없습니다.');
    if (cur.status === 'done') {
      const now = nowIso();
      await run(t, "UPDATE todos SET status='open', completed_at=NULL, updated_at=? WHERE id=?", [now, id]);
      await run(t, 'UPDATE completions SET reopened_at=? WHERE todo_id=? AND reopened_at IS NULL', [now, id]);
    }
    return { todo: await getTodo(id, user.id, t) };
  });
});
route('DELETE', '/api/todos/:id', async ({ params, user }) => {
  const id = idOf(params);
  if (!(await ownTodo(db, id, user.id))) throw new HttpError(404, '할 일을 찾을 수 없습니다.');
  const r = await run(db, 'DELETE FROM todos WHERE id=?', [id]);
  if (!r.changes) throw new HttpError(404, '할 일을 찾을 수 없습니다.');
  return { deleted: id };
});

// 실행 기록: 계획 값(예상 시간 등)은 건드리지 않고 runs 테이블에만 쌓는다.
route('GET', '/api/runs', async ({ query, user }) => {
  const args = [user.id]; let where = 'WHERE p.user_id=?';
  if (query.todo_id) { where += ' AND r.todo_id=?'; args.push(Number(query.todo_id)); }
  const items = await all(db, `SELECT r.*, t.title AS todo_title, t.plan_id, t.est_minutes AS todo_est_minutes FROM runs r JOIN todos t ON t.id=r.todo_id JOIN plans p ON p.id=t.plan_id ${where} ORDER BY r.started_at DESC, r.id DESC`, args);
  return { items };
});
route('POST', '/api/todos/:id/runs', async ({ params, body, user }) => {
  const id = idOf(params);
  if (!(await ownTodo(db, id, user.id))) throw new HttpError(404, '할 일을 찾을 수 없습니다.');
  const f = {};
  const s = Date.parse(body.started_at); const e = Date.parse(body.ended_at);
  if (Number.isNaN(s)) f.started_at = '시작 시각을 적어 주세요.';
  if (Number.isNaN(e)) f.ended_at = '끝 시각을 적어 주세요.';
  if (!f.started_at && !f.ended_at && e < s) f.ended_at = '끝 시각은 시작 시각보다 빠를 수 없습니다.';
  let minutes = null;
  if (body.actual_minutes === undefined || body.actual_minutes === null || body.actual_minutes === '') { if (!f.started_at && !f.ended_at && !f.ended_at) minutes = Math.round((e - s) / 60000); }
  else { minutes = requireInt(body.actual_minutes, 0, 100000); if (minutes === null) f.actual_minutes = '실제 걸린 시간은 0 이상의 정수(분)로 적어 주세요.'; }
  const blocker = str(body.blocker_reason);
  if (blocker.length > 300) f.blocker_reason = '막힌 이유는 300자까지 적을 수 있습니다.';
  fail(f);
  const r = await run(db, 'INSERT INTO runs(todo_id,started_at,ended_at,actual_minutes,blocker_reason,created_at) VALUES (?,?,?,?,?,?)',
    [id, new Date(s).toISOString(), new Date(e).toISOString(), minutes, blocker, nowIso()]);
  return [201, await get(db, 'SELECT * FROM runs WHERE id=?', [r.lastInsertRowid])];
});
route('DELETE', '/api/runs/:id', async ({ params, user }) => {
  const id = idOf(params);
  const r = await run(db, 'DELETE FROM runs WHERE id=? AND todo_id IN (SELECT t.id FROM todos t JOIN plans p ON p.id=t.plan_id WHERE p.user_id=?)', [id, user.id]);
  if (!r.changes) throw new HttpError(404, '실행 기록을 찾을 수 없습니다.');
  return { deleted: id };
});

function reviewArgs(q, uid) {
  const period = ['day', 'week', 'month'].includes(q.period) ? q.period : 'week';
  const anchor = isDate(q.date) ? q.date : todayKst();
  return reviewData(period, anchor, uid);
}
route('GET', '/api/review', async ({ query, user }) => reviewSummary(await reviewArgs(query, user.id)));
route('GET', '/api/review/records', async ({ query, user }) => {
  const r = await reviewArgs(query, user.id);
  return { metric: query.metric, range_start: r.from, range_end: r.to, ...(await reviewRecords(r, query.metric)) };
});
route('GET', '/api/reviews', async ({ user }) => ({ items: await all(db, 'SELECT v.*, p.title AS next_plan_title FROM reviews v LEFT JOIN plans p ON p.id=v.next_plan_id WHERE v.user_id=? ORDER BY v.id DESC', [user.id]) }));
// 다음 계획으로 넘기기: 고칠 점 한 줄을 저장하고, 그 줄을 제목으로 하는 다음 기간 계획을 만든다.
route('POST', '/api/reviews/carry', async ({ body, user }) => {
  const note = str(body.carry_over);
  if (!note || note.length > 200) fail({ carry_over: '고칠 점을 1~200자 한 줄로 적어 주세요.' });
  const period = ['day', 'week', 'month'].includes(body.period) ? body.period : 'week';
  const anchor = isDate(body.date) ? body.date : todayKst();
  const [from, to] = periodRange(period, anchor);
  const nextStart = addDays(to, 1);
  const [ns, ne] = periodRange(period, nextStart);
  const now = nowIso();
  return [201, await tx(async (t) => {
    const rv = await run(t, 'INSERT INTO reviews(user_id,period_type,range_start,range_end,carry_over,created_at) VALUES (?,?,?,?,?,?)', [user.id, period, from, to, note, now]);
    const reviewId = rv.lastInsertRowid;
    const v = { title: note.slice(0, 100), period_type: period, start_date: ns, end_date: ne, priority: 2, success_criteria: `돌아보기에서 넘어온 고칠 점: ${note}`.slice(0, 300), est_minutes: 0 };
    const pr = await run(t, `INSERT INTO plans(user_id,title,period_type,start_date,end_date,priority,success_criteria,est_minutes,original_json,carried_from_review_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [user.id, v.title, v.period_type, v.start_date, v.end_date, v.priority, v.success_criteria, v.est_minutes, JSON.stringify(v), reviewId, now, now]);
    const planId = pr.lastInsertRowid;
    await run(t, 'UPDATE reviews SET next_plan_id=? WHERE id=?', [planId, reviewId]);
    return { review_id: reviewId, next_plan: await planRow(await get(t, 'SELECT * FROM plans WHERE id=?', [planId]), t) };
  })];
});

// ---------- 6번 자료 가져오기 ----------
// 6번(로그인 없는 버전)에서 "내 자료 파일로 내보내기"로 받은 JSON을 내 계정으로 옮긴다.
// 날짜·시각은 원본 그대로 두고(고치지 않음), 가져왔다는 사실을 imports 표에 남겨 화면과 제출문에 드러낸다.
const IMPORT_LIMITS = { plans: 500, todos: 5000, runs: 10000 };
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const arr = (v, max, name) => { if (v === undefined) return []; if (!Array.isArray(v) || v.length > max) throw new HttpError(422, `${name} 항목이 올바르지 않거나 너무 많습니다.`); return v; };
const badFile = (m) => new HttpError(422, `가져올 수 없는 파일입니다: ${m}`);

function parseExport(b) {
  if (!b || b.schema !== 'pds-schema-v2') throw badFile('플랜두씨 다이어리에서 내보낸 파일(pds-schema-v2)이 아닙니다.');
  const plans = arr(b.plans, IMPORT_LIMITS.plans, '계획');
  const todos = arr(b.todos, IMPORT_LIMITS.todos, '할 일');
  const runs = arr(b.runs, IMPORT_LIMITS.runs, '실행 기록');
  const revs = arr(b.plan_revisions, IMPORT_LIMITS.runs, '수정 이력');
  const comps = arr(b.completions, IMPORT_LIMITS.todos * 2, '완료 기록');
  const reviews = arr(b.reviews, IMPORT_LIMITS.plans, '돌아보기');
  const planIds = new Set();
  for (const pl of plans) {
    const { f } = validatePlan(pl, false);
    if (Object.keys(f).length || !Number.isInteger(pl.id) || planIds.has(pl.id) || pl.end_date < pl.start_date || !isIso(pl.created_at) || !isIso(pl.updated_at) || !pl.original || typeof pl.original !== 'object') throw badFile('계획 항목에 문제가 있습니다.');
    planIds.add(pl.id);
  }
  const todoIds = new Set();
  for (const t of todos) {
    const okT = Number.isInteger(t.id) && !todoIds.has(t.id) && planIds.has(t.plan_id) && typeof t.title === 'string' && t.title.length >= 1 && t.title.length <= 100 &&
      (t.memo == null || (typeof t.memo === 'string' && t.memo.length <= 500)) && (t.due_date == null || isDate(t.due_date)) && [1, 2, 3].includes(t.priority) &&
      Number.isInteger(t.est_minutes) && t.est_minutes >= 0 && ['open', 'done'].includes(t.status) && (t.completed_at == null || isIso(t.completed_at)) && isIso(t.created_at) && isIso(t.updated_at) &&
      (t.tags == null || (Array.isArray(t.tags) && t.tags.length <= 10 && t.tags.every((g) => typeof g === 'string' && g.length >= 1 && g.length <= 20)));
    if (!okT) throw badFile('할 일 항목에 문제가 있습니다.');
    todoIds.add(t.id);
  }
  for (const r of runs) {
    if (!(Number.isInteger(r.id) && todoIds.has(r.todo_id) && isIso(r.started_at) && isIso(r.ended_at) && Date.parse(r.ended_at) >= Date.parse(r.started_at) && Number.isInteger(r.actual_minutes) && r.actual_minutes >= 0 &&
      (r.blocker_reason == null || (typeof r.blocker_reason === 'string' && r.blocker_reason.length <= 300)) && isIso(r.created_at))) throw badFile('실행 기록 항목에 문제가 있습니다.');
  }
  const revFields = new Set(['title', 'period_type', 'start_date', 'end_date', 'priority', 'success_criteria', 'est_minutes']);
  for (const v of revs) if (!(planIds.has(v.plan_id) && revFields.has(v.field) && isIso(v.changed_at))) throw badFile('수정 이력 항목에 문제가 있습니다.');
  for (const c of comps) if (!(todoIds.has(c.todo_id) && isIso(c.completed_at) && (c.reopened_at == null || isIso(c.reopened_at)))) throw badFile('완료 기록 항목에 문제가 있습니다.');
  for (const v of reviews) {
    if (!(['day', 'week', 'month'].includes(v.period_type) && isDate(v.range_start) && isDate(v.range_end) && typeof v.carry_over === 'string' && v.carry_over.length >= 1 && v.carry_over.length <= 200 && isIso(v.created_at) && (v.next_plan_id == null || planIds.has(v.next_plan_id)))) throw badFile('돌아보기 항목에 문제가 있습니다.');
  }
  // 한 할 일에 "현재 유효한" 완료 기록은 한 건만(DB 유니크 인덱스와 같은 규칙)
  const active = new Set();
  for (const c of comps) if (c.reopened_at == null) { if (active.has(c.todo_id)) throw badFile('같은 할 일에 유효한 완료 기록이 둘 이상입니다.'); active.add(c.todo_id); }
  return { plans, todos, runs, revs, comps, reviews };
}

route('POST', '/api/import', async ({ body, user }) => {
  if (await get(db, 'SELECT 1 FROM imports WHERE user_id=?', [user.id])) throw new HttpError(409, '이 계정에는 이미 6번 자료를 가져왔습니다. 두 번 가져올 수 없습니다.');
  const d = parseExport(body);
  const counts = { plans: d.plans.length, todos: d.todos.length, runs: d.runs.length, plan_revisions: d.revs.length, completions: d.comps.length, reviews: d.reviews.length };
  const now = nowIso();
  await tx(async (t) => {
    const pm = new Map(); const tm = new Map(); const rm = new Map();
    for (const pl of d.plans) {
      const r = await run(t, `INSERT INTO plans(user_id,title,period_type,start_date,end_date,priority,success_criteria,est_minutes,original_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [user.id, pl.title, pl.period_type, pl.start_date, pl.end_date, pl.priority, pl.success_criteria, pl.est_minutes, JSON.stringify(pl.original), pl.created_at, pl.updated_at]);
      pm.set(pl.id, r.lastInsertRowid);
    }
    for (const v of d.revs) await run(t, 'INSERT INTO plan_revisions(plan_id,field,old_value,new_value,changed_at) VALUES (?,?,?,?,?)', [pm.get(v.plan_id), v.field, v.old_value == null ? null : String(v.old_value), v.new_value == null ? null : String(v.new_value), v.changed_at]);
    for (const tdo of d.todos) {
      const r = await run(t, `INSERT INTO todos(plan_id,title,memo,due_date,priority,est_minutes,status,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [pm.get(tdo.plan_id), tdo.title, tdo.memo ?? '', tdo.due_date ?? null, tdo.priority, tdo.est_minutes, tdo.status, tdo.completed_at ?? null, tdo.created_at, tdo.updated_at]);
      tm.set(tdo.id, r.lastInsertRowid);
      await setTags(t, r.lastInsertRowid, [...new Set((tdo.tags || []).map((g) => g.toLowerCase()))]);
    }
    for (const r of d.runs) await run(t, 'INSERT INTO runs(todo_id,started_at,ended_at,actual_minutes,blocker_reason,created_at) VALUES (?,?,?,?,?,?)', [tm.get(r.todo_id), r.started_at, r.ended_at, r.actual_minutes, r.blocker_reason ?? '', r.created_at]);
    for (const c of d.comps) await run(t, 'INSERT INTO completions(todo_id,completed_at,reopened_at) VALUES (?,?,?)', [tm.get(c.todo_id), c.completed_at, c.reopened_at ?? null]);
    for (const v of d.reviews) {
      const r = await run(t, 'INSERT INTO reviews(user_id,period_type,range_start,range_end,carry_over,next_plan_id,created_at) VALUES (?,?,?,?,?,?,?)',
        [user.id, v.period_type, v.range_start, v.range_end, v.carry_over, v.next_plan_id == null ? null : pm.get(v.next_plan_id), v.created_at]);
      rm.set(v.id, r.lastInsertRowid);
    }
    for (const pl of d.plans) if (pl.carried_from_review_id != null && rm.has(pl.carried_from_review_id)) await run(t, 'UPDATE plans SET carried_from_review_id=? WHERE id=?', [rm.get(pl.carried_from_review_id), pm.get(pl.id)]);
    await run(t, 'INSERT INTO imports(user_id,source,exported_at,counts_json,imported_at) VALUES (?,?,?,?,?)', [user.id, '과제 6 내보내기 파일(pds-schema-v2)', isIso(body.exported_at) ? body.exported_at : null, JSON.stringify(counts), now]);
  });
  return [201, { imported: counts, imported_at: now }];
}, { bodyLimit: 2 * 1024 * 1024 });
route('GET', '/api/imports', async ({ user }) => ({ items: (await all(db, 'SELECT * FROM imports WHERE user_id=? ORDER BY id', [user.id])).map(({ counts_json, user_id, ...r }) => ({ ...r, counts: JSON.parse(counts_json) })) }));

// 내 자료 전체를 파일 하나로 내보내기
route('GET', '/api/export', async ({ user }) => {
  const u = [user.id];
  const mine = 'p.user_id = ?';
  const todos = await all(db, `SELECT t.* FROM todos t JOIN plans p ON p.id=t.plan_id WHERE ${mine} ORDER BY t.id`, u);
  const tags = await tagsOf(todos.map((t) => t.id));
  return {
    __download: `plan-do-see-export-${todayKst()}.json`,
    schema: 'pds-schema-v2',
    exported_at: nowIso(),
    timezone: 'Asia/Seoul',
    notice: NOTICE,
    plans: (await all(db, 'SELECT * FROM plans WHERE user_id=? ORDER BY id', u)).map(({ user_id, original_json, ...p }) => ({ ...p, original: JSON.parse(original_json) })),
    plan_revisions: await all(db, `SELECT r.* FROM plan_revisions r JOIN plans p ON p.id=r.plan_id WHERE ${mine} ORDER BY r.id`, u),
    todos: todos.map((t) => ({ ...t, tags: tags.get(t.id) || [] })),
    runs: await all(db, `SELECT r.* FROM runs r JOIN todos t ON t.id=r.todo_id JOIN plans p ON p.id=t.plan_id WHERE ${mine} ORDER BY r.id`, u),
    completions: await all(db, `SELECT c.* FROM completions c JOIN todos t ON t.id=c.todo_id JOIN plans p ON p.id=t.plan_id WHERE ${mine} ORDER BY c.id`, u),
    reviews: (await all(db, 'SELECT * FROM reviews WHERE user_id=? ORDER BY id', u)).map(({ user_id, ...r }) => r),
  };
});

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res, status, payload, extra) {
  const isBuf = Buffer.isBuffer(payload);
  const body = isBuf ? payload : JSON.stringify(payload);
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, '요청이 너무 큽니다.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); } catch { reject(new HttpError(400, 'JSON 형식이 올바르지 않습니다.')); }
    });
    req.on('error', reject);
  });
}
function serveStatic(res, dir, rel) {
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

// Vercel rewrite로 /api/index(.js)?__api=plans 처럼 들어오면 원래 경로(/api/plans, /contracts/...)로 복원한다.
function originalTarget(req) {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname;
  if (p === '/api/index' || p === '/api/index.js') {
    const a = url.searchParams.get('__api'); const c = url.searchParams.get('__contract');
    url.searchParams.delete('__api'); url.searchParams.delete('__contract');
    if (c !== null) p = '/contracts/' + c; else if (a !== null) p = '/api/' + a; else p = '/api/';
  }
  return { url, p: decodeURIComponent(p) };
}

async function handler(req, res) {
  try {
    const { url, p } = originalTarget(req);
    if (p.startsWith('/api/')) {
      await ensureSchema();
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(p);
        if (!m) continue;
        // 다른 사이트에서 몰래 보내는 요청(CSRF) 차단: Origin이 있으면 이 사이트와 같아야 한다.
        if (req.method !== 'GET' && req.headers.origin) {
          let same = false; try { same = new URL(req.headers.origin).host === req.headers.host; } catch {}
          if (!same) throw new HttpError(403, '허용되지 않는 요청입니다.');
        }
        const user = r.public ? null : await authenticate(req);
        if (!r.public && !user) throw new HttpError(401, '로그인이 필요합니다.');
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req, r.bodyLimit) : {};
        const headers = {};
        let out = await r.handler({ req, user, headers, params: m.groups || {}, query: Object.fromEntries(url.searchParams), body });
        let status = 200;
        if (Array.isArray(out)) [status, out] = out;
        if (out && out.__download) { const name = out.__download; delete out.__download; return send(res, 200, Buffer.from(JSON.stringify(out, null, 2)), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, ...headers }); }
        return send(res, status, out, headers);
      }
      throw new HttpError(404, '없는 주소입니다.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 요청입니다.');
    if (p.startsWith('/contracts/') && serveStatic(res, CONTRACT_DIR, p.slice('/contracts/'.length))) return;
    if (p === '/' || p === '/index.html') { if (serveStatic(res, PUBLIC_DIR, 'index.html')) return; }
    if (serveStatic(res, PUBLIC_DIR, p.slice(1))) return;
    throw new HttpError(404, '없는 주소입니다.');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, fields: e.fields });
    console.error(e);
    send(res, 500, { error: '서버 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
}

const server = http.createServer(handler);

if (require.main === module) server.listen(PORT, () => console.log(`플랜두씨 다이어리: http://localhost:${PORT}  (DB: ${REMOTE ? 'Turso 원격' : DB_PATH})`));
module.exports = { server, handler, db, client, ensureSchema };
