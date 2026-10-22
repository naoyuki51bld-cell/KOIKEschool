// Firestore のアクセス規則のテスト。エミュレーターの中で動かす：npm run test:rules
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, collection, collectionGroup, query, where, getDocs,
} = require('firebase/firestore');

let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-math-board',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
  });
  await env.clearFirestore();
  // 初期データ（規則を通さずに入れる）
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'config/main'), { teacherUid: 'teacher', className: 'テスト', registrationOpen: true });
    await setDoc(doc(db, 'config/secret'), { joinCode: 'ABC123' });
    await setDoc(doc(db, 'groups/g1'), { name: '1班', sort: 1, members: [] });
    await setDoc(doc(db, 'groups/g2'), { name: '2班', sort: 2, members: [] });
    for (const [sid, uid, groupId] of [['s1', 'uid1', 'g1'], ['s2', 'uid2', 'g1'], ['s3', 'uid3', 'g2']]) {
      await setDoc(doc(db, `students/${sid}`), { name: sid, number: null, uid, joinCode: 'ABC123', groupId, createdAt: 1 });
      await setDoc(doc(db, `accounts/${uid}`), { studentId: sid });
    }
    const base = { body: '', image: null, showResult: true, allowText: true, allowDraw: true, allowPhoto: true, hint: '', hintOpen: false, sort: 1, createdAt: 1 };
    await setDoc(doc(db, 'tasks/short'), { ...base, title: '短答', mode: 'individual', answerKind: 'short', peerView: 'off', status: 'open' });
    await setDoc(doc(db, 'tasks/group'), { ...base, title: '班', mode: 'group', answerKind: 'free', peerView: 'after_submit', status: 'open' });
    await setDoc(doc(db, 'tasks/draft'), { ...base, title: '下書き', mode: 'individual', answerKind: 'free', peerView: 'on', status: 'draft' });
    await setDoc(doc(db, 'tasks/closed'), { ...base, title: '締切', mode: 'individual', answerKind: 'free', peerView: 'on', status: 'closed' });
  });
});

test.after(async () => {
  await env.cleanup();
});

const as = (uid, email) => env.authenticatedContext(uid, email ? { email } : {}).firestore();
const sub = (over = {}) => ({
  ownerKey: 'u_s1', ownerType: 'user', ownerId: 's1', shortAnswer: '', text: '考え', confidence: 3, drawingV: null,
  photoV: null, status: 'submitted', autoCorrect: null, feedback: '', attempts: 1, version: 1, lastEditorId: 's1',
  lastEditorName: 's1', updatedAt: 1, peerId: 'p_s1', ...over,
});

test('設定・参加コード', async () => {
  await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'config/main')));
  await assertFails(getDoc(doc(as('uid1'), 'config/secret')));
  await assertSucceeds(getDoc(doc(as('teacher'), 'config/secret')));
  await assertFails(updateDoc(doc(as('uid1'), 'config/main'), { className: 'x' }));
  await assertFails(setDoc(doc(as('uid1'), 'config/main'), { teacherUid: 'uid1', className: 'x', registrationOpen: true }));
});

test('生徒の登録：参加コードが合うときだけ', async () => {
  const db = as('new1', 'new1@x.invalid');
  const reg = (code) => {
    const b = writeBatch(db);
    b.set(doc(db, 'students/sNew'), { name: 'しんにゅう', number: 5, uid: 'new1', joinCode: code, groupId: null, createdAt: 1 });
    b.set(doc(db, 'accounts/new1'), { studentId: 'sNew' });
    b.set(doc(db, 'names/key-new'), { email: 'new1@x.invalid', studentId: 'sNew' });
    return b.commit();
  };
  await assertFails(reg('WRONG1'));
  await assertSucceeds(reg('ABC123'));
  // 既にある名前は取れない
  const other = as('new2', 'new2@x.invalid');
  const b = writeBatch(other);
  b.set(doc(other, 'students/sNew2'), { name: 'x', number: null, uid: 'new2', joinCode: 'ABC123', groupId: null, createdAt: 1 });
  b.set(doc(other, 'accounts/new2'), { studentId: 'sNew2' });
  b.set(doc(other, 'names/key-new'), { email: 'new2@x.invalid', studentId: 'sNew2' });
  await assertFails(b.commit());
  // 自分でグループを変えたり、他人になりすましたりはできない
  await assertFails(updateDoc(doc(db, 'students/sNew'), { groupId: 'g1' }));
  await assertSucceeds(updateDoc(doc(db, 'students/sNew'), { name: '新しい名前' }));
  await assertFails(getDoc(doc(db, 'students/s1')));
  await assertFails(setDoc(doc(db, 'accounts/new1'), { studentId: 's1' }));
  await assertFails(getDocs(collection(db, 'names')));
});

test('課題：下書きは生徒に見えない', async () => {
  const db = as('uid1');
  await assertSucceeds(getDocs(query(collection(db, 'tasks'), where('status', 'in', ['open', 'closed']))));
  await assertFails(getDocs(collection(db, 'tasks')));
  await assertFails(getDoc(doc(db, 'tasks/draft')));
  await assertFails(setDoc(doc(db, 'tasks/x'), { title: 'x' }));
});

test('提出：生徒は自分でクリアにできない', async () => {
  const db = as('uid1');
  await assertFails(setDoc(doc(db, 'tasks/short/subs/u_s1'), sub({ status: 'cleared', peerId: 'p1' })));
  await assertSucceeds(setDoc(doc(db, 'tasks/short/subs/u_s1'), sub({ status: 'pending', shortAnswer: '3' })));
  await assertFails(setDoc(doc(db, 'tasks/short/subs/u_s1'), sub({ status: 'pending', attempts: 2, version: 2, feedback: 'よい' })));
  await assertSucceeds(setDoc(doc(db, 'tasks/short/subs/u_s1'), sub({ status: 'pending', attempts: 2, version: 2 })));
  // 他人の名前では出せない・他人の提出は読めない
  await assertFails(setDoc(doc(db, 'tasks/short/subs/u_s2'), sub({ ownerKey: 'u_s2', status: 'pending' })));
  await assertFails(getDoc(doc(as('uid2'), 'tasks/short/subs/u_s1')));
  // 先生はクリアにできる
  await assertSucceeds(updateDoc(doc(as('teacher'), 'tasks/short/subs/u_s1'), { status: 'cleared', autoCorrect: true }));
  // 締切・下書きの課題には出せない
  await assertFails(setDoc(doc(db, 'tasks/closed/subs/u_s1'), sub()));
  await assertFails(setDoc(doc(db, 'tasks/draft/subs/u_s1'), sub()));
  // 自分の提出は一覧で取れる。他人の分は取れない
  await assertSucceeds(getDocs(query(collectionGroup(db, 'subs'), where('ownerKey', '==', 'u_s1'))));
  await assertFails(getDocs(query(collectionGroup(db, 'subs'), where('ownerKey', '==', 'u_s2'))));
  await assertFails(getDocs(collectionGroup(db, 'subs')));
  await assertSucceeds(getDocs(collectionGroup(as('teacher'), 'subs')));
});

test('グループ提出と、匿名のみんなの考え', async () => {
  const s1 = as('uid1');
  const s2 = as('uid2');
  const s3 = as('uid3');
  const write = (db, key, sid, peerId, over = {}) => {
    const b = writeBatch(db);
    b.set(doc(db, `tasks/group/subs/${key}`), sub({ ownerKey: key, ownerType: 'group', ownerId: key.slice(2), lastEditorId: sid, peerId, ...over }));
    b.set(doc(db, `tasks/group/peers/${peerId}`), { shortAnswer: '', text: '考え', drawingV: null, photoV: null });
    return b.commit();
  };
  // 2班のじろうは1班の名前で出せない
  await assertFails(write(s3, 'g_g1', 's3', 'p_x'));
  // 提出前は見られない
  await assertFails(getDocs(collection(s3, 'tasks/group/peers')));
  await assertSucceeds(write(s1, 'g_g1', 's1', 'p_g1'));
  // 同じ班の s2 は班の提出を読めて、続きを出せる
  await assertSucceeds(getDoc(doc(s2, 'tasks/group/subs/g_g1')));
  await assertSucceeds(updateDoc(doc(s2, 'tasks/group/subs/g_g1'), { text: '追記', attempts: 2, version: 2, lastEditorId: 's2', lastEditorName: 's2' }));
  // 版番号を飛ばしたり戻したりはできない
  await assertFails(updateDoc(doc(s1, 'tasks/group/subs/g_g1'), { text: '古い', attempts: 3, version: 2, lastEditorId: 's1' }));
  // 他の班のコピーは書き換えられない
  await assertSucceeds(write(s3, 'g_g2', 's3', 'p_g2'));
  await assertFails(setDoc(doc(s3, 'tasks/group/peers/p_g1'), { shortAnswer: '', text: 'いたずら', drawingV: null, photoV: null }));
  // 提出後は見られる
  await assertSucceeds(getDocs(collection(s3, 'tasks/group/peers')));
  // コピーに名前などを入れることはできない
  await assertFails(setDoc(doc(s3, 'tasks/group/peers/p_g2'), { shortAnswer: '', text: 'x', drawingV: null, photoV: null, name: 's3' }));
  // 参考になった：他の班には付けられる、自分の班には付けられない
  await assertSucceeds(setDoc(doc(s3, 'tasks/group/likes/p_g1_uid3'), { pid: 'p_g1', uid: 'uid3' }));
  await assertFails(setDoc(doc(s3, 'tasks/group/likes/p_g2_uid3'), { pid: 'p_g2', uid: 'uid3' }));
  await assertFails(setDoc(doc(s3, 'tasks/group/likes/p_g1_uid1'), { pid: 'p_g1', uid: 'uid1' }));
  // 見せない設定の課題は見られない
  await assertFails(getDocs(collection(s1, 'tasks/short/peers')));
});

test('手書き・写真のファイル', async () => {
  const s1 = as('uid1');
  await assertSucceeds(setDoc(doc(s1, 'tasks/short/subs/u_s1/files/drawing'), { data: 'data:image/png;base64,AAAA', v: 3 }));
  await assertFails(setDoc(doc(s1, 'tasks/short/subs/u_s1/files/other'), { data: 'x', v: 1 }));
  await assertFails(getDoc(doc(as('uid2'), 'tasks/short/subs/u_s1/files/drawing')));
  await assertSucceeds(getDoc(doc(as('teacher'), 'tasks/short/subs/u_s1/files/drawing')));
});

test('ヘルプ', async () => {
  const s1 = as('uid1');
  await assertSucceeds(setDoc(doc(s1, 'tasks/short/help/s1'), { studentId: 's1', message: 'わからない', createdAt: 1 }));
  await assertFails(setDoc(doc(s1, 'tasks/short/help/s2'), { studentId: 's2', message: '', createdAt: 1 }));
  await assertSucceeds(getDocs(query(collectionGroup(s1, 'help'), where('studentId', '==', 's1'))));
  await assertFails(getDocs(collectionGroup(s1, 'help')));
  await assertSucceeds(getDocs(collectionGroup(as('teacher'), 'help')));
  await assertSucceeds(deleteDoc(doc(as('teacher'), 'tasks/short/help/s1')));
});

test('パスワード再設定後は古いログインが使えない', async () => {
  await assertSucceeds(deleteDoc(doc(as('teacher'), 'accounts/uid2')));
  await assertFails(getDoc(doc(as('uid2'), 'tasks/group/subs/g_g1')));
});

test('小テスト：生徒は公開されたテストの自分の得点だけ見られる', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'quizzes/q1'), { title: '第1回', date: '2026-10-22', maxScore: 10, published: true, createdAt: 1 });
    await setDoc(doc(db, 'quizzes/q2'), { title: '第2回', date: '2026-10-23', maxScore: 10, published: false, createdAt: 2 });
    for (const [q, published] of [['q1', true], ['q2', false]]) {
      await setDoc(doc(db, `quizzes/${q}/scores/s1`), { studentId: 's1', score: 8, groupId: 'g1', groupName: '1班', published, updatedAt: 1 });
      await setDoc(doc(db, `quizzes/${q}/scores/s3`), { studentId: 's3', score: 5, groupId: 'g2', groupName: '2班', published, updatedAt: 1 });
    }
  });
  const s1 = as('uid1');
  await assertSucceeds(getDoc(doc(s1, 'quizzes/q1')));
  await assertFails(getDoc(doc(s1, 'quizzes/q2')));
  await assertSucceeds(getDocs(query(collection(s1, 'quizzes'), where('published', '==', true))));
  await assertFails(getDocs(collection(s1, 'quizzes')));
  await assertSucceeds(getDoc(doc(s1, 'quizzes/q1/scores/s1')));
  await assertFails(getDoc(doc(s1, 'quizzes/q2/scores/s1')));
  await assertFails(getDoc(doc(s1, 'quizzes/q1/scores/s3')));
  await assertFails(getDocs(collection(s1, 'quizzes/q1/scores')));
  await assertSucceeds(getDocs(query(collectionGroup(s1, 'scores'), where('studentId', '==', 's1'), where('published', '==', true))));
  await assertFails(getDocs(query(collectionGroup(s1, 'scores'), where('studentId', '==', 's1'))));
  await assertFails(getDocs(query(collectionGroup(s1, 'scores'), where('studentId', '==', 's3'), where('published', '==', true))));
  // 生徒は得点を書き換えられない
  await assertFails(updateDoc(doc(s1, 'quizzes/q1/scores/s1'), { score: 10 }));
  await assertFails(setDoc(doc(s1, 'quizzes/q3'), { title: 'x', date: '2026-10-22', maxScore: 10, published: true, createdAt: 1 }));
  // 先生は全員分を読める
  await assertSucceeds(getDocs(collectionGroup(as('teacher'), 'scores')));
  await assertSucceeds(updateDoc(doc(as('teacher'), 'quizzes/q1/scores/s1'), { score: 9 }));
});
