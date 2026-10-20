const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'math-board-test-'));
const { createApp } = require('../server/app');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server;
let base;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// cookie を覚えておく簡易クライアント
function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}

test('授業の一連の流れ', async () => {
  const teacher = client();
  const a = client();
  const b = client();
  const c = client();

  assert.equal((await teacher('GET', '/api/status')).data.needsSetup, true);
  assert.equal((await teacher('POST', '/api/setup', { name: '先生', password: 'short' })).status, 400);
  assert.equal((await teacher('POST', '/api/setup', { name: '先生', password: 'teacherpass', className: '2年3組 数学' })).status, 200);
  assert.equal((await teacher('POST', '/api/setup', { name: '先生2', password: 'teacherpass' })).status, 400);

  const { joinCode } = (await teacher('GET', '/api/teacher/settings')).data;
  assert.equal((await a('POST', '/api/register', { joinCode: 'WRONG1', name: 'たろう', password: 'pass1' })).status, 400);
  assert.equal((await a('POST', '/api/register', { joinCode, name: 'たろう', password: 'pass1', number: 1 })).status, 200);
  assert.equal((await b('POST', '/api/register', { joinCode, name: 'たろう', password: 'pass2' })).status, 400, '名前の重複は不可');
  assert.equal((await b('POST', '/api/register', { joinCode: joinCode.toLowerCase(), name: 'はなこ', password: 'pass2', number: 2 })).status, 200);
  assert.equal((await c('POST', '/api/register', { joinCode, name: 'じろう', password: 'pass3', number: 3 })).status, 200);

  // 生徒は教師APIを使えない
  assert.equal((await a('GET', '/api/teacher/students')).status, 403);

  // ログアウト→名前＋パスワードでログイン
  await a('POST', '/api/logout');
  assert.equal((await a('GET', '/api/me')).status, 401);
  assert.equal((await a('POST', '/api/login', { name: 'たろう', password: 'wrong' })).status, 401);
  assert.equal((await a('POST', '/api/login', { name: 'たろう', password: 'pass1' })).data.role, 'student');

  // 個人モードの短答課題
  const short = (await teacher('POST', '/api/teacher/tasks', {
    title: '平方根', body: '$\\sqrt{12}$ を簡単にせよ', answerKind: 'short',
    accepted: { answers: ['2√3'], mode: 'value' }, status: 'open', peerView: 'off',
  })).data.id;
  const draft = (await teacher('POST', '/api/teacher/tasks', { title: '下書き' })).data.id;

  const list = (await a('GET', '/api/student/tasks')).data;
  assert.deepEqual(list.map((t) => t.id), [short], '下書きは生徒に見えない');
  assert.equal((await a('GET', `/api/student/tasks/${draft}`)).status, 404);

  let r = await a('POST', `/api/student/tasks/${short}/submit`, { shortAnswer: '3', confidence: 2 });
  assert.equal(r.data.submission.status, 'submitted');
  assert.equal(r.data.submission.autoCorrect, 0);
  r = await a('POST', `/api/student/tasks/${short}/submit`, { shortAnswer: '２√３' });
  assert.equal(r.data.submission.status, 'cleared');
  assert.equal(r.data.submission.attempts, 2);

  // 他人の回答は見られない設定
  assert.equal((await b('GET', `/api/student/tasks/${short}/peers`)).status, 403);

  // 記述式・グループモード・提出後に匿名で見られる
  await teacher('POST', '/api/teacher/groups/auto', { size: 2 });
  const students = (await teacher('GET', '/api/teacher/students')).data;
  const groups = (await teacher('GET', '/api/teacher/groups')).data;
  assert.equal(groups.length, 2);
  // たろう・はなこを1班、じろうを2班にする
  const id = (name) => students.find((s) => s.name === name).id;
  await teacher('PATCH', `/api/teacher/students/${id('たろう')}`, { groupId: groups[0].id });
  await teacher('PATCH', `/api/teacher/students/${id('はなこ')}`, { groupId: groups[0].id });
  await teacher('PATCH', `/api/teacher/students/${id('じろう')}`, { groupId: groups[1].id });

  const group = (await teacher('POST', '/api/teacher/tasks', {
    title: '内角の和', body: '説明しよう', mode: 'group', status: 'open', peerView: 'after_submit',
  })).data.id;

  r = await a('POST', `/api/student/tasks/${group}/submit`, { text: '平行線を引く', drawing: PNG });
  assert.equal(r.status, 200);
  const v1 = r.data.submission.version;
  // 同じ班のはなこにも見える
  const seen = (await b('GET', `/api/student/tasks/${group}`)).data.submission;
  assert.equal(seen.text, '平行線を引く');
  assert.equal(seen.lastEditor, 'たろう');
  r = await b('POST', `/api/student/tasks/${group}/submit`, { text: '錯角を使う', drawing: 'keep', baseVersion: v1 });
  assert.equal(r.status, 200);
  // 古い版を元にした提出は弾く
  r = await a('POST', `/api/student/tasks/${group}/submit`, { text: '上書き', baseVersion: v1 });
  assert.equal(r.status, 409);

  // じろうは提出前なので見られない → 提出後は匿名で見られる
  assert.equal((await c('GET', `/api/student/tasks/${group}/peers`)).status, 403);
  await c('POST', `/api/student/tasks/${group}/submit`, { text: '切って並べる' });
  const peers = (await c('GET', `/api/student/tasks/${group}/peers`)).data;
  assert.equal(peers.length, 2);
  const json = JSON.stringify(peers);
  for (const word of ['たろう', 'はなこ', '1班', 'ownerId', 'updatedAt']) assert.ok(!json.includes(word), `${word} が漏れていない`);
  const other = peers.find((p) => !p.mine);
  assert.equal((await c('POST', `/api/student/submissions/${other.id}/like`)).data.liked, true);
  assert.equal((await c('POST', `/api/student/submissions/${peers.find((p) => p.mine).id}/like`)).status, 400);

  // ヘルプ → 教師の進捗ボードに出る → クリアで消える
  await c('POST', `/api/student/tasks/${short}/help`, { message: 'わからない' });
  let progress = (await teacher('GET', '/api/teacher/progress')).data;
  assert.equal(progress.help.length, 1);
  assert.equal(progress.submissions.length, 3);
  const subs = (await teacher('GET', `/api/teacher/tasks/${group}/submissions`)).data;
  const g2 = subs.find((s) => s.ownerName === groups[1].name);
  await teacher('PATCH', `/api/teacher/submissions/${g2.id}`, { status: 'retry', feedback: '理由も書こう' });
  const cView = (await c('GET', `/api/student/tasks/${group}`)).data.submission;
  assert.equal(cView.status, 'retry');
  assert.equal(cView.feedback, '理由も書こう');

  // 締切後は提出できない
  await teacher('PATCH', `/api/teacher/tasks/${group}`, { status: 'closed' });
  assert.equal((await c('POST', `/api/student/tasks/${group}/submit`, { text: 'x' })).status, 400);

  // 提示画面
  await teacher('PUT', '/api/teacher/present', { taskId: group, submissionIds: subs.map((s) => s.id) });
  const view = (await teacher('GET', '/api/teacher/present/view')).data;
  assert.equal(view.submissions[0].label, '回答 A');
  assert.equal((await a('GET', '/api/teacher/present/view')).status, 403);

  // CSV
  const csv = (await teacher('GET', '/api/teacher/export.csv')).data;
  assert.ok(csv.includes('たろう') && csv.includes('クリア'));

  // 画像はログインしないと見られない
  const file = seen.drawing;
  assert.equal((await client()('GET', `/files/${file}`)).status, 401);
  assert.equal((await a('GET', `/files/${file}`)).status, 200);

  // パスワード再設定
  const { password } = (await teacher('POST', `/api/teacher/students/${id('じろう')}/reset-password`)).data;
  assert.equal((await c('GET', '/api/me')).status, 401, '再設定で古いログインは切れる');
  assert.equal((await c('POST', '/api/login', { name: 'じろう', password })).status, 200);

  // 登録の締切
  await teacher('PUT', '/api/teacher/settings', { registrationOpen: false });
  assert.equal((await client()('POST', '/api/register', { joinCode, name: 'さぶろう', password: 'pass4' })).status, 403);
});
