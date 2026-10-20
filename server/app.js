const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { db, getSetting, setSetting, tx, UPLOAD_DIR } = require('./db');
const { judge } = require('./judge');

const SESSION_DAYS = 180;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// ---------- 共通ヘルパー ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => Date.now();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function randomCode(length, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function cleanName(name) {
  const s = String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!s) throw new HttpError(400, '名前を入力してください');
  if ([...s].length > 20) throw new HttpError(400, '名前は20文字以内にしてください');
  return s;
}

function checkPassword(password) {
  if (String(password || '').length < 4) throw new HttpError(400, 'パスワードは4文字以上にしてください');
  if (String(password).length > 100) throw new HttpError(400, 'パスワードが長すぎます');
  return String(password);
}

function str(value, max = 5000) {
  return String(value ?? '').slice(0, max);
}

function bool(value) {
  return value ? 1 : 0;
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// data:image/...;base64,... を保存してファイル名を返す
function saveDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new HttpError(400, '画像の形式が正しくありません');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(400, '画像が大きすぎます');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}

function removeFile(name) {
  if (!name || !/^[0-9a-f]{32}\.(png|jpg|webp)$/.test(name)) return;
  fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
}

// 画像の更新: undefined = 変更なし、null/'' = 削除、data URL = 置き換え
function updateImage(current = null, incoming) {
  if (incoming === undefined || incoming === 'keep') return current;
  if (!incoming) {
    removeFile(current);
    return null;
  }
  const saved = saveDataUrl(incoming);
  removeFile(current);
  return saved;
}

// ---------- リアルタイム通知（Server-Sent Events） ----------

const clients = new Set();

function broadcast(type, data = {}, filter = () => true) {
  const payload = `event: change\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const client of clients) {
    if (filter(client.user)) client.res.write(payload);
  }
}

const toTeachers = (u) => u.role === 'teacher';

// ---------- データ整形 ----------

function taskForTeacher(t) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    image: t.image,
    mode: t.mode,
    answerKind: t.answer_kind,
    accepted: parseJson(t.accepted, { answers: [], mode: 'value' }),
    showResult: !!t.show_result,
    allowText: !!t.allow_text,
    allowDraw: !!t.allow_draw,
    allowPhoto: !!t.allow_photo,
    peerView: t.peer_view,
    hint: t.hint,
    hintOpen: !!t.hint_open,
    status: t.status,
    sort: t.sort,
  };
}

function taskForStudent(t) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    image: t.image,
    mode: t.mode,
    answerKind: t.answer_kind,
    showResult: !!t.show_result,
    allowText: !!t.allow_text,
    allowDraw: !!t.allow_draw,
    allowPhoto: !!t.allow_photo,
    peerView: t.peer_view,
    hint: t.hint_open ? t.hint : '',
    status: t.status,
  };
}

function submissionForOwner(s, task) {
  if (!s) return null;
  const hideResult = task.answer_kind === 'short' && !task.show_result && s.status !== 'cleared';
  const editor = s.last_editor_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(s.last_editor_id) : null;
  return {
    id: s.id,
    shortAnswer: s.short_answer,
    text: s.text,
    drawing: s.drawing,
    photo: s.photo,
    confidence: s.confidence,
    // 正誤を見せない設定のときは「提出済」にそろえる
    status: hideResult && s.status === 'submitted' ? 'submitted' : s.status,
    autoCorrect: hideResult ? null : s.auto_correct,
    feedback: s.feedback,
    attempts: s.attempts,
    version: s.version,
    lastEditor: editor ? editor.name : null,
    updatedAt: s.updated_at,
  };
}

function ownerOf(user, task) {
  if (task.mode === 'group') {
    if (!user.group_id) return null;
    return { type: 'group', id: user.group_id };
  }
  return { type: 'user', id: user.id };
}

function findSubmission(taskId, owner) {
  if (!owner) return null;
  return db.prepare('SELECT * FROM submissions WHERE task_id = ? AND owner_type = ? AND owner_id = ?')
    .get(taskId, owner.type, owner.id);
}

function hasContent(s) {
  return !!(s.short_answer || s.text || s.drawing || s.photo);
}

// 匿名ラベル用の並び順（提出順や名前を推測されにくいようにハッシュで並べる）
function anonymousOrder(subs, taskId) {
  const key = (s) => crypto.createHash('sha1').update(`${taskId}:${s.id}:${getSetting('salt', '')}`).digest('hex');
  return [...subs].sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

function ownerName(s) {
  if (s.owner_type === 'group') {
    const g = db.prepare('SELECT name FROM groups WHERE id = ?').get(s.owner_id);
    return g ? g.name : '(削除されたグループ)';
  }
  const u = db.prepare('SELECT name, number FROM users WHERE id = ?').get(s.owner_id);
  return u ? u.name : '(削除された生徒)';
}

// ---------- アプリ本体 ----------

function createApp() {
  if (!getSetting('salt')) setSetting('salt', crypto.randomBytes(16).toString('hex'));
  if (!getSetting('joinCode')) setSetting('joinCode', randomCode(6));

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
  app.use(express.json({ limit: '20mb' }));

  // --- セッション ---
  app.use((req, _res, next) => {
    const cookie = req.headers.cookie || '';
    const m = /(?:^|;\s*)sid=([0-9a-f]{64})/.exec(cookie);
    req.user = null;
    if (m) {
      const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.created_at > ?`).get(m[1], now() - SESSION_DAYS * 864e5);
      if (row) {
        req.user = row;
        req.sessionToken = m[1];
      }
    }
    next();
  });

  function startSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now());
    const secure = req.secure || process.env.COOKIE_SECURE === 'true';
    res.setHeader('Set-Cookie',
      `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
  }

  const need = (role) => (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'ログインしてください'));
    if (role && req.user.role !== role) return next(new HttpError(403, 'この操作はできません'));
    next();
  };

  // ログイン試行の制限（名前ごと・IPごとに 10 分で 20 回まで）
  const attempts = new Map();
  function throttle(key) {
    const t = now();
    const list = (attempts.get(key) || []).filter((x) => t - x < 10 * 60e3);
    if (list.length >= 20) throw new HttpError(429, 'ログインの試行が多すぎます。しばらく待ってからやり直してください');
    list.push(t);
    attempts.set(key, list);
  }

  const api = express.Router();

  // --- 初期設定・ログイン ---

  api.get('/status', (req, res) => {
    const teacher = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher'").get();
    res.json({
      needsSetup: teacher.n === 0,
      className: getSetting('className', '数学'),
      registrationOpen: !!getSetting('registrationOpen', true),
    });
  });

  api.post('/setup', (req, res) => {
    const teacher = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher'").get();
    if (teacher.n > 0) throw new HttpError(400, '初期設定は完了しています');
    const name = cleanName(req.body.name);
    const password = checkPassword(req.body.password);
    if (password.length < 8) throw new HttpError(400, '教師のパスワードは8文字以上にしてください');
    if (req.body.className) setSetting('className', str(req.body.className, 40));
    const info = db.prepare("INSERT INTO users (role, name, pass_hash, created_at) VALUES ('teacher', ?, ?, ?)")
      .run(name, hashPassword(password), now());
    startSession(req, res, Number(info.lastInsertRowid));
    res.json({ ok: true });
  });

  api.post('/login', (req, res) => {
    const name = String(req.body.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    throttle(`ip:${req.ip}`);
    throttle(`name:${name.toLowerCase()}`);
    const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
    if (!user || !verifyPassword(req.body.password || '', user.pass_hash)) {
      throw new HttpError(401, '名前かパスワードが違います');
    }
    startSession(req, res, user.id);
    res.json({ role: user.role });
  });

  api.post('/register', (req, res) => {
    if (!getSetting('registrationOpen', true)) throw new HttpError(403, '現在、新規登録は締め切られています');
    throttle(`ip:${req.ip}`);
    const code = String(req.body.joinCode || '').normalize('NFKC').trim().toUpperCase();
    if (code !== getSetting('joinCode')) throw new HttpError(400, '参加コードが違います');
    const name = cleanName(req.body.name);
    const password = checkPassword(req.body.password);
    if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) {
      throw new HttpError(400, 'その名前はすでに使われています。別の名前にしてください');
    }
    const number = req.body.number ? Number(req.body.number) : null;
    if (number !== null && (!Number.isInteger(number) || number < 1 || number > 999)) {
      throw new HttpError(400, '出席番号は数字で入力してください');
    }
    const info = db.prepare("INSERT INTO users (role, name, pass_hash, number, created_at) VALUES ('student', ?, ?, ?, ?)")
      .run(name, hashPassword(password), number, now());
    startSession(req, res, Number(info.lastInsertRowid));
    broadcast('students', {}, toTeachers);
    res.json({ role: 'student' });
  });

  api.post('/logout', (req, res) => {
    if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ ok: true });
  });

  api.get('/me', need(), (req, res) => {
    const u = req.user;
    const group = u.group_id ? db.prepare('SELECT id, name FROM groups WHERE id = ?').get(u.group_id) : null;
    const members = group
      ? db.prepare('SELECT name FROM users WHERE group_id = ? ORDER BY name').all(group.id).map((r) => r.name)
      : [];
    res.json({
      id: u.id,
      role: u.role,
      name: u.name,
      number: u.number,
      group: group ? { ...group, members } : null,
      className: getSetting('className', '数学'),
    });
  });

  api.post('/me/name', need(), (req, res) => {
    const name = cleanName(req.body.name);
    const other = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
    if (other && other.id !== req.user.id) throw new HttpError(400, 'その名前はすでに使われています');
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    broadcast('students', {}, toTeachers);
    res.json({ ok: true });
  });

  api.post('/me/password', need(), (req, res) => {
    if (!verifyPassword(req.body.current || '', req.user.pass_hash)) throw new HttpError(400, '今のパスワードが違います');
    const next = checkPassword(req.body.next);
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
    res.json({ ok: true });
  });

  // --- リアルタイム通知 ---

  api.get('/events', need(), (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { res, user: req.user };
    clients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
    });
  });

  // ================= 教師 =================

  const teacher = express.Router();
  teacher.use(need('teacher'));

  teacher.get('/settings', (req, res) => {
    res.json({
      className: getSetting('className', '数学'),
      joinCode: getSetting('joinCode'),
      registrationOpen: !!getSetting('registrationOpen', true),
    });
  });

  teacher.put('/settings', (req, res) => {
    if (req.body.className !== undefined) setSetting('className', str(req.body.className, 40));
    if (req.body.registrationOpen !== undefined) setSetting('registrationOpen', !!req.body.registrationOpen);
    if (req.body.regenerateJoinCode) setSetting('joinCode', randomCode(6));
    broadcast('settings');
    res.json({ ok: true });
  });

  teacher.get('/join-qr.svg', async (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const url = `${base}/?join=${encodeURIComponent(getSetting('joinCode'))}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1 });
    res.type('image/svg+xml').send(svg);
  });

  // --- 生徒 ---

  teacher.get('/students', (req, res) => {
    const rows = db.prepare(`SELECT id, name, number, group_id, created_at FROM users
      WHERE role = 'student' ORDER BY number IS NULL, number, name`).all();
    res.json(rows.map((r) => ({ id: r.id, name: r.name, number: r.number, groupId: r.group_id, createdAt: r.created_at })));
  });

  teacher.post('/students', (req, res) => {
    const name = cleanName(req.body.name);
    if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) throw new HttpError(400, 'その名前はすでに使われています');
    const password = req.body.password ? checkPassword(req.body.password) : randomCode(6, '23456789abcdefghijkmnpqrstuvwxyz');
    const number = req.body.number ? Number(req.body.number) : null;
    db.prepare("INSERT INTO users (role, name, pass_hash, number, created_at) VALUES ('student', ?, ?, ?, ?)")
      .run(name, hashPassword(password), number, now());
    broadcast('students', {}, toTeachers);
    res.json({ password });
  });

  teacher.patch('/students/:id', (req, res) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
    if (!u) throw new HttpError(404, '生徒が見つかりません');
    if (req.body.name !== undefined) {
      const name = cleanName(req.body.name);
      const other = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
      if (other && other.id !== u.id) throw new HttpError(400, 'その名前はすでに使われています');
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, u.id);
    }
    if (req.body.number !== undefined) {
      db.prepare('UPDATE users SET number = ? WHERE id = ?').run(req.body.number ? Number(req.body.number) : null, u.id);
    }
    if (req.body.groupId !== undefined) {
      db.prepare('UPDATE users SET group_id = ? WHERE id = ?').run(req.body.groupId || null, u.id);
    }
    broadcast('students');
    res.json({ ok: true });
  });

  teacher.post('/students/:id/reset-password', (req, res) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
    if (!u) throw new HttpError(404, '生徒が見つかりません');
    const password = randomCode(6, '23456789abcdefghijkmnpqrstuvwxyz');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    res.json({ password });
  });

  teacher.delete('/students/:id', (req, res) => {
    tx(() => {
      const subs = db.prepare("SELECT drawing, photo FROM submissions WHERE owner_type = 'user' AND owner_id = ?").all(req.params.id);
      subs.forEach((s) => { removeFile(s.drawing); removeFile(s.photo); });
      db.prepare("DELETE FROM submissions WHERE owner_type = 'user' AND owner_id = ?").run(req.params.id);
      db.prepare("DELETE FROM users WHERE id = ? AND role = 'student'").run(req.params.id);
    });
    broadcast('students');
    res.json({ ok: true });
  });

  // --- グループ ---

  teacher.get('/groups', (req, res) => {
    res.json(db.prepare('SELECT id, name, sort FROM groups ORDER BY sort, id').all());
  });

  teacher.post('/groups', (req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
    const name = str(req.body.name, 30).trim() || `${count + 1}班`;
    const info = db.prepare('INSERT INTO groups (name, sort) VALUES (?, ?)').run(name, count + 1);
    broadcast('students');
    res.json({ id: Number(info.lastInsertRowid) });
  });

  teacher.patch('/groups/:id', (req, res) => {
    const name = str(req.body.name, 30).trim();
    if (!name) throw new HttpError(400, 'グループ名を入力してください');
    db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, req.params.id);
    broadcast('students');
    res.json({ ok: true });
  });

  teacher.delete('/groups/:id', (req, res) => {
    tx(() => {
      db.prepare("DELETE FROM submissions WHERE owner_type = 'group' AND owner_id = ?").run(req.params.id);
      db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
    });
    broadcast('students');
    res.json({ ok: true });
  });

  // 指定人数でランダムにグループ分けする（既存のグループは作り直す）
  teacher.post('/groups/auto', (req, res) => {
    const size = Math.max(2, Math.min(10, Number(req.body.size) || 4));
    tx(() => {
      const students = db.prepare("SELECT id FROM users WHERE role = 'student'").all().map((r) => r.id);
      for (let i = students.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [students[i], students[j]] = [students[j], students[i]];
      }
      const groupCount = Math.max(1, Math.round(students.length / size));
      db.prepare("DELETE FROM submissions WHERE owner_type = 'group'").run();
      db.prepare('UPDATE users SET group_id = NULL').run();
      db.prepare('DELETE FROM groups').run();
      const ids = [];
      for (let g = 0; g < groupCount; g++) {
        ids.push(Number(db.prepare('INSERT INTO groups (name, sort) VALUES (?, ?)').run(`${g + 1}班`, g + 1).lastInsertRowid));
      }
      students.forEach((id, i) => db.prepare('UPDATE users SET group_id = ? WHERE id = ?').run(ids[i % groupCount], id));
    });
    broadcast('students');
    res.json({ ok: true });
  });

  // --- 課題 ---

  teacher.get('/tasks', (req, res) => {
    const rows = db.prepare('SELECT * FROM tasks ORDER BY sort, id').all();
    const counts = db.prepare(`SELECT task_id, COUNT(*) AS submitted, SUM(status = 'cleared') AS cleared
      FROM submissions GROUP BY task_id`).all();
    const byTask = new Map(counts.map((c) => [c.task_id, c]));
    res.json(rows.map((t) => ({
      ...taskForTeacher(t),
      submitted: byTask.get(t.id)?.submitted || 0,
      cleared: byTask.get(t.id)?.cleared || 0,
    })));
  });

  function writeTask(body, existing) {
    const defaults = {
      title: '無題の課題', body: '', mode: 'individual', answer_kind: 'free', show_result: 1, allow_text: 1,
      allow_draw: 1, allow_photo: 1, peer_view: 'off', hint: '', hint_open: 0, status: 'draft', image: null,
      accepted: JSON.stringify({ answers: [], mode: 'value' }),
    };
    const t = existing || defaults;
    const pick = (key, col, fn) => (body[key] !== undefined ? fn(body[key]) : t[col]);
    let accepted = t.accepted;
    if (body.accepted !== undefined) {
      const answers = Array.isArray(body.accepted?.answers)
        ? body.accepted.answers.map((a) => str(a, 200).trim()).filter(Boolean).slice(0, 20)
        : [];
      accepted = JSON.stringify({ answers, mode: body.accepted?.mode === 'exact' ? 'exact' : 'value' });
    }
    return {
      title: pick('title', 'title', (v) => str(v, 100).trim() || '無題の課題'),
      body: pick('body', 'body', (v) => str(v, 10000)),
      mode: pick('mode', 'mode', (v) => (v === 'group' ? 'group' : 'individual')),
      answer_kind: pick('answerKind', 'answer_kind', (v) => (v === 'short' ? 'short' : 'free')),
      accepted,
      show_result: pick('showResult', 'show_result', bool),
      allow_text: pick('allowText', 'allow_text', bool),
      allow_draw: pick('allowDraw', 'allow_draw', bool),
      allow_photo: pick('allowPhoto', 'allow_photo', bool),
      peer_view: pick('peerView', 'peer_view', (v) => (['off', 'after_submit', 'on'].includes(v) ? v : 'off')),
      hint: pick('hint', 'hint', (v) => str(v, 5000)),
      hint_open: pick('hintOpen', 'hint_open', bool),
      status: pick('status', 'status', (v) => (['draft', 'open', 'closed'].includes(v) ? v : 'draft')),
      image: updateImage(t.image, body.image),
    };
  }

  teacher.post('/tasks', (req, res) => {
    const v = writeTask(req.body, null);
    const sort = (db.prepare('SELECT MAX(sort) AS m FROM tasks').get().m || 0) + 1;
    const info = db.prepare(`INSERT INTO tasks (title, body, image, mode, answer_kind, accepted, show_result, allow_text,
      allow_draw, allow_photo, peer_view, hint, hint_open, status, sort, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.title, v.body, v.image, v.mode, v.answer_kind,
      v.accepted, v.show_result, v.allow_text, v.allow_draw, v.allow_photo, v.peer_view, v.hint, v.hint_open, v.status,
      sort, now());
    broadcast('tasks');
    res.json({ id: Number(info.lastInsertRowid) });
  });

  teacher.patch('/tasks/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!t) throw new HttpError(404, '課題が見つかりません');
    const v = writeTask(req.body, t);
    db.prepare(`UPDATE tasks SET title = ?, body = ?, image = ?, mode = ?, answer_kind = ?, accepted = ?, show_result = ?,
      allow_text = ?, allow_draw = ?, allow_photo = ?, peer_view = ?, hint = ?, hint_open = ?, status = ? WHERE id = ?`)
      .run(v.title, v.body, v.image, v.mode, v.answer_kind, v.accepted, v.show_result, v.allow_text, v.allow_draw,
        v.allow_photo, v.peer_view, v.hint, v.hint_open, v.status, t.id);
    broadcast('tasks', { taskId: t.id });
    res.json({ ok: true });
  });

  // 正解を変えたあとに、短答の提出をまとめて判定し直す
  teacher.post('/tasks/:id/rejudge', (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!t || t.answer_kind !== 'short') throw new HttpError(400, '短答の課題ではありません');
    const accepted = parseJson(t.accepted, {});
    let changed = 0;
    tx(() => {
      for (const s of db.prepare('SELECT * FROM submissions WHERE task_id = ?').all(t.id)) {
        const ok = judge(s.short_answer, accepted);
        if (ok === null) continue;
        const status = ok ? 'cleared' : (s.status === 'cleared' ? 'submitted' : s.status);
        if (status !== s.status || Number(ok) !== s.auto_correct) changed++;
        db.prepare('UPDATE submissions SET auto_correct = ?, status = ? WHERE id = ?').run(Number(ok), status, s.id);
      }
    });
    broadcast('submission', { taskId: t.id });
    res.json({ changed });
  });

  teacher.post('/tasks/:id/duplicate', (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!t) throw new HttpError(404, '課題が見つかりません');
    let image = null;
    if (t.image) {
      image = `${crypto.randomBytes(16).toString('hex')}${path.extname(t.image)}`;
      fs.copyFileSync(path.join(UPLOAD_DIR, t.image), path.join(UPLOAD_DIR, image));
    }
    const sort = (db.prepare('SELECT MAX(sort) AS m FROM tasks').get().m || 0) + 1;
    const info = db.prepare(`INSERT INTO tasks (title, body, image, mode, answer_kind, accepted, show_result, allow_text,
      allow_draw, allow_photo, peer_view, hint, hint_open, status, sort, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'draft', ?, ?)`).run(`${t.title}（コピー）`, t.body, image, t.mode,
      t.answer_kind, t.accepted, t.show_result, t.allow_text, t.allow_draw, t.allow_photo, t.peer_view, t.hint, sort, now());
    broadcast('tasks');
    res.json({ id: Number(info.lastInsertRowid) });
  });

  teacher.post('/tasks/reorder', (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    tx(() => ids.forEach((id, i) => db.prepare('UPDATE tasks SET sort = ? WHERE id = ?').run(i + 1, id)));
    broadcast('tasks');
    res.json({ ok: true });
  });

  teacher.delete('/tasks/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!t) throw new HttpError(404, '課題が見つかりません');
    tx(() => {
      for (const s of db.prepare('SELECT drawing, photo FROM submissions WHERE task_id = ?').all(t.id)) {
        removeFile(s.drawing);
        removeFile(s.photo);
      }
      removeFile(t.image);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    });
    const present = getSetting('present');
    if (present && present.taskId === t.id) setSetting('present', null);
    broadcast('tasks');
    res.json({ ok: true });
  });

  // --- 提出 ---

  function submissionForTeacher(s) {
    const editor = s.last_editor_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(s.last_editor_id) : null;
    const likes = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE submission_id = ?').get(s.id).n;
    return {
      id: s.id,
      taskId: s.task_id,
      ownerType: s.owner_type,
      ownerId: s.owner_id,
      ownerName: ownerName(s),
      shortAnswer: s.short_answer,
      text: s.text,
      drawing: s.drawing,
      photo: s.photo,
      confidence: s.confidence,
      status: s.status,
      autoCorrect: s.auto_correct,
      feedback: s.feedback,
      attempts: s.attempts,
      lastEditor: editor ? editor.name : null,
      likes,
      updatedAt: s.updated_at,
    };
  }

  teacher.get('/tasks/:id/submissions', (req, res) => {
    const subs = db.prepare('SELECT * FROM submissions WHERE task_id = ? ORDER BY updated_at').all(req.params.id);
    res.json(subs.map(submissionForTeacher));
  });

  teacher.patch('/submissions/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
    if (!s) throw new HttpError(404, '提出が見つかりません');
    const status = ['submitted', 'cleared', 'retry'].includes(req.body.status) ? req.body.status : s.status;
    const feedback = req.body.feedback !== undefined ? str(req.body.feedback, 2000) : s.feedback;
    db.prepare('UPDATE submissions SET status = ?, feedback = ? WHERE id = ?').run(status, feedback, s.id);
    if (status === 'cleared') clearHelp(s);
    broadcast('submission', { taskId: s.task_id });
    res.json({ ok: true });
  });

  function clearHelp(s) {
    if (s.owner_type === 'user') {
      db.prepare('DELETE FROM help_requests WHERE user_id = ? AND task_id = ?').run(s.owner_id, s.task_id);
    } else {
      db.prepare('DELETE FROM help_requests WHERE task_id = ? AND user_id IN (SELECT id FROM users WHERE group_id = ?)')
        .run(s.task_id, s.owner_id);
    }
  }

  // --- 進捗ボード ---

  teacher.get('/progress', (req, res) => {
    const tasks = db.prepare("SELECT * FROM tasks WHERE status != 'draft' ORDER BY sort, id").all();
    const students = db.prepare(`SELECT id, name, number, group_id FROM users WHERE role = 'student'
      ORDER BY number IS NULL, number, name`).all();
    const groups = db.prepare('SELECT id, name FROM groups ORDER BY sort, id').all();
    const subs = db.prepare(`SELECT id, task_id, owner_type, owner_id, status, auto_correct, confidence, attempts, updated_at
      FROM submissions`).all();
    const help = db.prepare('SELECT user_id, task_id, message, created_at FROM help_requests').all();
    res.json({
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, mode: t.mode, status: t.status, answerKind: t.answer_kind })),
      students: students.map((s) => ({ id: s.id, name: s.name, number: s.number, groupId: s.group_id })),
      groups,
      submissions: subs.map((s) => ({
        id: s.id,
        taskId: s.task_id,
        ownerType: s.owner_type,
        ownerId: s.owner_id,
        status: s.status,
        autoCorrect: s.auto_correct,
        confidence: s.confidence,
        attempts: s.attempts,
        updatedAt: s.updated_at,
      })),
      help: help.map((h) => ({ userId: h.user_id, taskId: h.task_id, message: h.message, createdAt: h.created_at })),
    });
  });

  teacher.delete('/help/:userId/:taskId', (req, res) => {
    db.prepare('DELETE FROM help_requests WHERE user_id = ? AND task_id = ?').run(req.params.userId, req.params.taskId);
    broadcast('help');
    res.json({ ok: true });
  });

  teacher.get('/export.csv', (req, res) => {
    const tasks = db.prepare("SELECT * FROM tasks WHERE status != 'draft' ORDER BY sort, id").all();
    const students = db.prepare("SELECT * FROM users WHERE role = 'student' ORDER BY number IS NULL, number, name").all();
    const label = { submitted: '提出済', cleared: 'クリア', retry: '再提出' };
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['出席番号', '名前', ...tasks.map((t) => t.title)].map(esc).join(',')];
    for (const st of students) {
      const cells = tasks.map((t) => {
        const owner = t.mode === 'group' ? (st.group_id ? { type: 'group', id: st.group_id } : null) : { type: 'user', id: st.id };
        const s = findSubmission(t.id, owner);
        return s ? label[s.status] : '未提出';
      });
      lines.push([st.number ?? '', st.name, ...cells].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="progress.csv"');
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  // --- 提示（大画面） ---

  teacher.get('/present', (req, res) => {
    res.json(getSetting('present') || { taskId: null, submissionIds: [], showNames: false });
  });

  teacher.put('/present', (req, res) => {
    const ids = Array.isArray(req.body.submissionIds) ? req.body.submissionIds.map(Number).filter(Boolean).slice(0, 8) : [];
    const value = {
      taskId: req.body.taskId ? Number(req.body.taskId) : null,
      submissionIds: ids,
      showNames: !!req.body.showNames,
      showQr: !!req.body.showQr,
    };
    setSetting('present', value);
    broadcast('present', {}, toTeachers);
    res.json(value);
  });

  teacher.get('/present/view', (req, res) => {
    const p = getSetting('present') || { taskId: null, submissionIds: [] };
    const t = p.taskId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(p.taskId) : null;
    const subs = p.submissionIds
      .map((id) => db.prepare('SELECT * FROM submissions WHERE id = ?').get(id))
      .filter((s) => s && t && s.task_id === t.id);
    res.json({
      className: getSetting('className', '数学'),
      joinCode: getSetting('joinCode'),
      showQr: !!p.showQr,
      task: t ? { title: t.title, body: t.body, image: t.image, hint: t.hint_open ? t.hint : '' } : null,
      submissions: subs.map((s, i) => ({
        label: p.showNames ? ownerName(s) : `回答 ${String.fromCharCode(65 + i)}`,
        shortAnswer: s.short_answer,
        text: s.text,
        drawing: s.drawing,
        photo: s.photo,
      })),
    });
  });

  api.use('/teacher', teacher);

  // ================= 生徒 =================

  const student = express.Router();
  student.use(need('student'));

  function loadOpenTask(id) {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ? AND status != 'draft'").get(id);
    if (!t) throw new HttpError(404, '課題が見つかりません');
    return t;
  }

  student.get('/tasks', (req, res) => {
    const tasks = db.prepare("SELECT * FROM tasks WHERE status != 'draft' ORDER BY sort, id").all();
    res.json(tasks.map((t) => {
      const s = findSubmission(t.id, ownerOf(req.user, t));
      const mine = submissionForOwner(s, t);
      return {
        id: t.id,
        title: t.title,
        mode: t.mode,
        status: t.status,
        answerKind: t.answer_kind,
        myStatus: mine ? mine.status : null,
        hasFeedback: !!(mine && mine.feedback),
      };
    }));
  });

  student.get('/tasks/:id', (req, res) => {
    const t = loadOpenTask(req.params.id);
    const owner = ownerOf(req.user, t);
    const s = findSubmission(t.id, owner);
    const help = db.prepare('SELECT message FROM help_requests WHERE user_id = ? AND task_id = ?').get(req.user.id, t.id);
    res.json({
      task: taskForStudent(t),
      submission: submissionForOwner(s, t),
      needsGroup: t.mode === 'group' && !owner,
      help: help ? { message: help.message } : null,
      canSeePeers: canSeePeers(t, s),
    });
  });

  function canSeePeers(t, own) {
    if (t.peer_view === 'on') return true;
    if (t.peer_view === 'after_submit') return !!own;
    return false;
  }

  student.post('/tasks/:id/submit', (req, res) => {
    const t = loadOpenTask(req.params.id);
    if (t.status !== 'open') throw new HttpError(400, 'この課題は締め切られています');
    const owner = ownerOf(req.user, t);
    if (!owner) throw new HttpError(400, 'グループが決まっていないため提出できません。先生に伝えてください');
    const body = req.body;
    const result = tx(() => {
      const s = findSubmission(t.id, owner);
      // グループで同時に編集したときに上書きしないよう、版番号を確かめる
      if (s && body.baseVersion !== undefined && Number(body.baseVersion) !== s.version) {
        throw new HttpError(409, '同じグループの人が先に提出しました。最新の内容を読み込んでから、もう一度提出してください');
      }
      const shortAnswer = t.answer_kind === 'short' ? str(body.shortAnswer, 200).trim() : '';
      const text = t.allow_text ? str(body.text, 5000) : '';
      const drawing = t.allow_draw ? updateImage(s?.drawing, body.drawing) : s?.drawing ?? null;
      const photo = t.allow_photo ? updateImage(s?.photo, body.photo) : s?.photo ?? null;
      const confidence = [1, 2, 3, 4].includes(Number(body.confidence)) ? Number(body.confidence) : null;
      if (t.answer_kind === 'short' && !shortAnswer) throw new HttpError(400, '答えを入力してください');
      if (!shortAnswer && !text.trim() && !drawing && !photo) throw new HttpError(400, '何か書いてから提出してください');

      let autoCorrect = null;
      let status;
      if (t.answer_kind === 'short') {
        const ok = judge(shortAnswer, parseJson(t.accepted, {}));
        autoCorrect = ok === null ? null : Number(ok);
        if (ok === true) status = 'cleared';
        else status = s && s.status === 'cleared' && ok === null ? 'cleared' : 'submitted';
      } else {
        // 記述式は先生がクリアにした後の書き直しでもクリアのまま
        status = s && s.status === 'cleared' ? 'cleared' : 'submitted';
      }

      if (s) {
        db.prepare(`UPDATE submissions SET short_answer = ?, text = ?, drawing = ?, photo = ?, confidence = ?, status = ?,
          auto_correct = ?, attempts = attempts + 1, version = version + 1, last_editor_id = ?, updated_at = ? WHERE id = ?`)
          .run(shortAnswer, text, drawing, photo, confidence, status, autoCorrect, req.user.id, now(), s.id);
      } else {
        db.prepare(`INSERT INTO submissions (task_id, owner_type, owner_id, short_answer, text, drawing, photo, confidence,
          status, auto_correct, attempts, version, last_editor_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`)
          .run(t.id, owner.type, owner.id, shortAnswer, text, drawing, photo, confidence, status, autoCorrect, req.user.id, now());
      }
      const saved = findSubmission(t.id, owner);
      if (saved.status === 'cleared') clearHelp(saved);
      return saved;
    });
    broadcast('submission', { taskId: t.id });
    res.json({ submission: submissionForOwner(result, t) });
  });

  student.get('/tasks/:id/peers', (req, res) => {
    const t = loadOpenTask(req.params.id);
    const owner = ownerOf(req.user, t);
    const own = findSubmission(t.id, owner);
    if (!canSeePeers(t, own)) throw new HttpError(403, '今は他の人の回答を見られません');
    const subs = anonymousOrder(db.prepare('SELECT * FROM submissions WHERE task_id = ?').all(t.id).filter(hasContent), t.id);
    res.json(subs.map((s, i) => ({
      // 名前・提出時刻・正誤など、誰の回答か推測できる情報は返さない
      id: s.id,
      label: `回答 ${i + 1}`,
      mine: !!own && own.id === s.id,
      shortAnswer: t.answer_kind === 'short' ? s.short_answer : '',
      text: s.text,
      drawing: s.drawing,
      photo: s.photo,
      likes: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE submission_id = ?').get(s.id).n,
      liked: !!db.prepare('SELECT 1 FROM likes WHERE submission_id = ? AND user_id = ?').get(s.id, req.user.id),
    })));
  });

  student.post('/submissions/:id/like', (req, res) => {
    const s = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
    if (!s) throw new HttpError(404, '回答が見つかりません');
    const t = loadOpenTask(s.task_id);
    const own = findSubmission(t.id, ownerOf(req.user, t));
    if (!canSeePeers(t, own)) throw new HttpError(403, '今は他の人の回答を見られません');
    if (own && own.id === s.id) throw new HttpError(400, '自分の回答には付けられません');
    const exists = db.prepare('SELECT 1 FROM likes WHERE submission_id = ? AND user_id = ?').get(s.id, req.user.id);
    if (exists) db.prepare('DELETE FROM likes WHERE submission_id = ? AND user_id = ?').run(s.id, req.user.id);
    else db.prepare('INSERT INTO likes (submission_id, user_id) VALUES (?, ?)').run(s.id, req.user.id);
    broadcast('likes', { taskId: t.id });
    res.json({ liked: !exists });
  });

  student.post('/tasks/:id/help', (req, res) => {
    const t = loadOpenTask(req.params.id);
    db.prepare(`INSERT INTO help_requests (user_id, task_id, message, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, task_id) DO UPDATE SET message = excluded.message`)
      .run(req.user.id, t.id, str(req.body.message, 200), now());
    broadcast('help', {}, toTeachers);
    res.json({ ok: true });
  });

  student.delete('/tasks/:id/help', (req, res) => {
    db.prepare('DELETE FROM help_requests WHERE user_id = ? AND task_id = ?').run(req.user.id, req.params.id);
    broadcast('help', {}, toTeachers);
    res.json({ ok: true });
  });

  api.use('/student', student);

  api.use((req, _res, next) => next(new HttpError(404, '見つかりません')));
  app.use('/api', api);

  // --- アップロード画像（ログインした人だけ） ---
  app.get('/files/:name', need(), (req, res, next) => {
    const name = req.params.name;
    if (!/^[0-9a-f]{32}\.(png|jpg|webp)$/.test(name)) return next(new HttpError(404, '見つかりません'));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(path.join(UPLOAD_DIR, name), (err) => err && next(new HttpError(404, '見つかりません')));
  });

  app.use('/vendor/katex', express.static(path.join(path.dirname(require.resolve('katex/package.json')), 'dist')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status === 500) console.error(err);
    const message = status === 413 ? '送信データが大きすぎます' : status === 500 ? 'サーバーでエラーが起きました' : err.message;
    if (req.path.startsWith('/api/')) res.status(status).json({ error: message });
    else res.status(status).send(message);
  });

  return app;
}

module.exports = { createApp };
