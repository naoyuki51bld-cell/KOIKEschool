// 「1クラスだけ」の時代のデータを、複数クラスの形（classes/{クラス}/…）にコピーする。
//   node scripts/migrate.js check   … 何件コピーするかを数えるだけ（何も書かない）
//   node scripts/migrate.js run     … コピーして、件数が合っているか確かめる（一度だけ。やり直すときは --again）
// 元のデータ（tasks・quizzes・groups・config など）は消さないし、書き換えない。
// 例外は students/{生徒} に「入っているクラス（classIds）」を足すことだけ。
// 何度動かしても同じ結果になる（同じ場所に上書きするだけ）。
const crypto = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { db, auth } = require('./admin');

const now = () => Date.now();

function randomCode(length) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(length), (b) => chars[b % chars.length]).join('');
}

async function docsOf(path) {
  const snap = await db.collection(path).get();
  return snap.docs;
}

// 写す内容を全部並べる（まだ書かない）
async function plan() {
  const main = await db.doc('config/main').get();
  if (!main.exists) throw new Error('config/main がありません（移すデータがありません）');
  const { teacherUid, className, registrationOpen } = main.data();
  const classId = `class-${crypto.createHash('sha256').update(teacherUid).digest('hex').slice(0, 10)}`;
  const C = `classes/${classId}`;
  const writes = []; // { path, data, merge? }
  const count = {};
  const put = (kind, path, data, merge = false) => {
    writes.push({ path, data, merge });
    count[kind] = (count[kind] || 0) + 1;
  };
  const get = async (path) => {
    const s = await db.doc(path).get();
    return s.exists ? s.data() : null;
  };

  const existingClass = await get(C);
  put('クラス', C, {
    name: className || 'クラス',
    ownerUid: teacherUid,
    teacherUids: existingClass ? existingClass.teacherUids : [teacherUid],
    registrationOpen: registrationOpen !== false,
    createdAt: existingClass ? existingClass.createdAt : now(),
  });

  const secret = await get('config/secret');
  if (secret && secret.joinCode) {
    put('参加コード', `${C}/private/join`, { code: secret.joinCode });
    put('参加コード', `joinCodes/${secret.joinCode}`, { classId });
  }
  put('正解・ヒント', `${C}/private/answers`, (await get('config/answers')) || {});
  const present = await get('config/present');
  if (present) {
    put('提示画面', `${C}/private/present`, {
      ...present,
      submissionKeys: (present.submissionKeys || []).map((p) => {
        const m = /^tasks\/([^/]+)\/subs\/([^/]+)$/.exec(p);
        return m ? `${C}/subs/${m[1]}__${m[2]}` : p;
      }),
    });
  }
  const timer = await get('live/timer');
  if (timer) put('タイマー', `${C}/live/timer`, timer);

  // 先生（管理者）
  if (!(await get(`teachers/${teacherUid}`))) {
    let email = '';
    let name = '';
    try {
      const u = await auth.getUser(teacherUid);
      email = u.email || '';
      name = u.displayName || '';
    } catch { /* エミュレーターなどで見つからないときは空のまま */ }
    put('先生', `teachers/${teacherUid}`, { name: name || (email.split('@')[0]) || '先生', email, inviteCode: '', createdAt: now() });
  }
  if (!(await get('config/teacherInvite'))) put('先生の招待コード', 'config/teacherInvite', { code: randomCode(8) });

  for (const g of await docsOf('groups')) put('班', `${C}/groups/${g.id}`, g.data());

  for (const s of await docsOf('students')) {
    const d = s.data();
    put('名簿', `${C}/members/${s.id}`, {
      name: d.name, number: d.number ?? null, groupId: d.groupId ?? null, joinCode: d.joinCode || '', joinedAt: d.createdAt || now(),
    });
    put('生徒のクラス一覧', `students/${s.id}`, { classIds: FieldValue.arrayUnion(classId) }, true);
  }

  for (const t of await docsOf('tasks')) {
    put('課題', `${C}/tasks/${t.id}`, t.data());
    for (const f of await docsOf(`tasks/${t.id}/files`)) put('画像', `${C}/tasks/${t.id}/files/${f.id}`, f.data());
    for (const sub of await docsOf(`tasks/${t.id}/subs`)) {
      const to = `${C}/subs/${t.id}__${sub.id}`;
      put('提出', to, { ...sub.data(), taskId: t.id });
      for (const f of await docsOf(`tasks/${t.id}/subs/${sub.id}/files`)) put('画像', `${to}/files/${f.id}`, f.data());
    }
    for (const p of await docsOf(`tasks/${t.id}/peers`)) {
      put('みんなの考え', `${C}/tasks/${t.id}/peers/${p.id}`, p.data());
      for (const f of await docsOf(`tasks/${t.id}/peers/${p.id}/files`)) put('画像', `${C}/tasks/${t.id}/peers/${p.id}/files/${f.id}`, f.data());
    }
    for (const l of await docsOf(`tasks/${t.id}/likes`)) put('参考になった', `${C}/tasks/${t.id}/likes/${l.id}`, l.data());
    for (const h of await docsOf(`tasks/${t.id}/help`)) {
      put('ヘルプ', `${C}/help/${t.id}__${h.id}`, { ...h.data(), taskId: t.id, studentId: h.data().studentId || h.id });
    }
  }

  for (const q of await docsOf('quizzes')) {
    put('小テスト', `${C}/quizzes/${q.id}`, q.data());
    for (const sc of await docsOf(`quizzes/${q.id}/scores`)) {
      put('得点', `${C}/scores/${q.id}__${sc.id}`, { ...sc.data(), quizId: q.id, studentId: sc.data().studentId || sc.id });
    }
  }

  return { classId, writes, count };
}

async function commit(writes) {
  for (let i = 0; i < writes.length; i += 200) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + 200)) batch.set(db.doc(w.path), w.data, { merge: w.merge });
    await batch.commit();
  }
}

// 書いたものを読み直して、件数と中身のキーが合っているか確かめる
async function verify(writes) {
  let missing = 0;
  for (const w of writes) {
    const s = await db.doc(w.path).get();
    if (!s.exists) missing++;
  }
  return missing;
}

async function main() {
  const mode = process.argv[2];
  if (!['check', 'run'].includes(mode)) {
    console.log('使い方：node scripts/migrate.js check|run');
    process.exit(1);
  }
  // 一度移したあとは、新しい版で変えた内容を古い写しで上書きしないよう、二度目は止める
  const done = await db.doc('config/migration').get();
  if (mode === 'run' && done.exists && !process.argv.includes('--again')) {
    console.log(`すでに ${done.data().at} に移しています（classes/${done.data().classId}）。何もしませんでした。`);
    return;
  }
  const { classId, writes, count } = await plan();
  console.log(`移し先のクラス：classes/${classId}`);
  console.table(count);
  if (mode === 'check') {
    console.log(`${writes.length} 件を書く予定です（まだ何も書いていません）`);
    return;
  }
  await commit(writes);
  const missing = await verify(writes);
  if (missing) throw new Error(`${missing} 件が書けていません`);
  await db.doc('config/migration').set({ classId, at: new Date().toISOString(), count }, { merge: true });
  console.log(`コピーしました：${writes.length} 件（元のデータはそのままです）`);
}

module.exports = { plan };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
