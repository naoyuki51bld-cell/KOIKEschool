// Firestore のアクセス規則のテスト。エミュレーターの中で動かす：npm run test:rules
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, collection, query, where, getDocs, arrayUnion,
} = require('firebase/firestore');

let env;

// 管理者 admin（クラスA の担当）、先生 tB（クラスB の担当）、生徒 s1・s2（A の1班）、s3（A の2班・B にも在籍）
test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-math-board',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const set = (p, d) => setDoc(doc(db, p), d);
    await set('config/main', { teacherUid: 'admin', className: '旧クラス', registrationOpen: true });
    await set('config/teacherInvite', { code: 'INVITE12' });
    await set('config/secret', { joinCode: 'OLD123' });
    await set('teachers/admin', { name: '管理者', email: 'admin@x.jp', inviteCode: '', createdAt: 1 });
    await set('teachers/tB', { name: 'B先生', email: 'b@x.jp', inviteCode: 'INVITE12', createdAt: 1 });
    // 複数クラスにする前のデータ
    await set('tasks/old1', { title: '旧課題', status: 'open' });
    await set('quizzes/oldq', { title: '旧テスト', published: true });

    await set('classes/A', { name: 'A組', ownerUid: 'admin', teacherUids: ['admin'], registrationOpen: true, createdAt: 1 });
    await set('classes/A/private/join', { code: 'AAA111' });
    await set('joinCodes/AAA111', { classId: 'A' });
    await set('classes/B', { name: 'B組', ownerUid: 'tB', teacherUids: ['tB'], registrationOpen: true, createdAt: 2 });
    await set('classes/B/private/join', { code: 'BBB222' });
    await set('joinCodes/BBB222', { classId: 'B' });
    await set('classes/A/groups/g1', { name: '1班', sort: 1, members: [] });
    await set('classes/A/groups/g2', { name: '2班', sort: 2, members: [] });
    for (const [sid, uid, classes, group] of [['s1', 'uid1', ['A'], 'g1'], ['s2', 'uid2', ['A'], 'g1'], ['s3', 'uid3', ['A', 'B'], 'g2']]) {
      await set(`students/${sid}`, { name: sid, uid, classIds: classes, createdAt: 1 });
      await set(`accounts/${uid}`, { studentId: sid });
      for (const c of classes) await set(`classes/${c}/members/${sid}`, { name: sid, number: 1, groupId: c === 'A' ? group : null, joinCode: '', joinedAt: 1 });
    }
    const base = { body: '', imageV: null, showResult: true, allowText: true, allowDraw: true, allowPhoto: true, hint: '', hintOpen: false, sort: 1, createdAt: 1 };
    await set('classes/A/tasks/short', { ...base, title: '短答', mode: 'individual', answerKind: 'short', peerView: 'off', status: 'open' });
    await set('classes/A/tasks/group', { ...base, title: '班', mode: 'group', answerKind: 'free', peerView: 'after_submit', status: 'open' });
    await set('classes/A/tasks/draft', { ...base, title: '下書き', mode: 'individual', answerKind: 'free', peerView: 'on', status: 'draft' });
    await set('classes/A/tasks/closed', { ...base, title: '締切', mode: 'individual', answerKind: 'free', peerView: 'on', status: 'closed' });
    await set('classes/B/tasks/bt', { ...base, title: 'B組の課題', mode: 'individual', answerKind: 'free', peerView: 'on', status: 'open' });
  });
});

test.after(async () => {
  await env.cleanup();
});

const as = (uid, email) => env.authenticatedContext(uid, email ? { email } : {}).firestore();
const sub = (over = {}) => ({
  taskId: 'short', ownerKey: 'u_s1', ownerType: 'user', ownerId: 's1', shortAnswer: '', text: '考え', confidence: 3, drawingV: null,
  photoV: null, status: 'submitted', autoCorrect: null, feedback: '', attempts: 1, version: 1, lastEditorId: 's1',
  lastEditorName: 's1', updatedAt: 1, peerId: 'p_s1', ...over,
});

test('複数クラスにする前のデータは、管理者が読めるだけで誰も書き換えられない', async () => {
  await assertSucceeds(getDoc(doc(as('admin'), 'tasks/old1')));
  await assertSucceeds(getDoc(doc(as('admin'), 'config/secret')));
  await assertFails(setDoc(doc(as('admin'), 'tasks/old1'), { title: 'x' }));
  await assertFails(deleteDoc(doc(as('admin'), 'tasks/old1')));
  await assertFails(deleteDoc(doc(as('admin'), 'quizzes/oldq')));
  await assertFails(getDoc(doc(as('tB'), 'tasks/old1')));
  await assertFails(getDoc(doc(as('uid1'), 'tasks/old1')));
  await assertFails(getDoc(doc(as('uid1'), 'config/secret')));
});

test('先生の登録は招待コードが合うときだけ', async () => {
  const t = as('newT', 'new@x.jp');
  await assertFails(setDoc(doc(t, 'teachers/newT'), { name: '新', email: 'new@x.jp', inviteCode: 'WRONG', createdAt: 1 }));
  await assertSucceeds(setDoc(doc(t, 'teachers/newT'), { name: '新', email: 'new@x.jp', inviteCode: 'INVITE12', createdAt: 1 }));
  await assertFails(getDoc(doc(t, 'config/teacherInvite')));
  await assertSucceeds(getDoc(doc(as('admin'), 'config/teacherInvite')));
  // 先生はクラスを作れる。生徒は作れない
  await assertSucceeds(setDoc(doc(t, 'classes/N'), { name: '新クラス', ownerUid: 'newT', teacherUids: ['newT'], registrationOpen: true, createdAt: 1 }));
  await assertFails(setDoc(doc(as('uid1'), 'classes/X'), { name: 'x', ownerUid: 'uid1', teacherUids: ['uid1'], registrationOpen: true, createdAt: 1 }));
  // 自分を他人のクラスの担当に入れることはできない
  await assertFails(updateDoc(doc(t, 'classes/A'), { teacherUids: arrayUnion('newT') }));
});

test('先生は自分のクラスだけ見られる。共同担当にすると見られる', async () => {
  const b = as('tB');
  await assertSucceeds(getDoc(doc(b, 'classes/B')));
  await assertFails(getDoc(doc(b, 'classes/A')));
  await assertFails(getDocs(collection(b, 'classes/A/members')));
  await assertFails(getDocs(collection(b, 'classes/A/subs')));
  await assertSucceeds(getDocs(query(collection(b, 'classes'), where('teacherUids', 'array-contains', 'tB'))));
  await assertFails(getDocs(collection(b, 'classes')));
  // A の持ち主（admin）が tB を共同担当にする
  await assertSucceeds(updateDoc(doc(as('admin'), 'classes/A'), { teacherUids: ['admin', 'tB'] }));
  await assertSucceeds(getDocs(collection(b, 'classes/A/members')));
  // 共同担当は、担当の先生を入れ替えられない
  await assertFails(updateDoc(doc(b, 'classes/A'), { teacherUids: ['tB'] }));
  await assertSucceeds(updateDoc(doc(b, 'classes/A'), { name: 'A組（改）' }));
  await assertSucceeds(updateDoc(doc(as('admin'), 'classes/A'), { teacherUids: ['admin'], name: 'A組' }));
  await assertFails(getDocs(collection(b, 'classes/A/members')));
});

test('生徒の登録：参加コードのクラスにだけ入れる', async () => {
  const db = as('new1', 'new1@x.invalid');
  const reg = (code, cls = 'A') => {
    const b = writeBatch(db);
    b.set(doc(db, 'students/sNew'), { name: 'しんにゅう', uid: 'new1', classIds: [cls], createdAt: 1 });
    b.set(doc(db, 'accounts/new1'), { studentId: 'sNew' });
    b.set(doc(db, 'names/key-new'), { email: 'new1@x.invalid', studentId: 'sNew' });
    b.set(doc(db, `classes/${cls}/members/sNew`), { name: 'しんにゅう', number: 3101, groupId: null, joinCode: code, joinedAt: 1 });
    return b.commit();
  };
  await assertFails(reg('WRONG1'));
  await assertFails(reg('BBB222')); // B のコードで A には入れない
  await assertSucceeds(reg('AAA111'));
  // クラスの名簿に入らずにアカウントだけ作ることはできない
  const lone = as('lone', 'lone@x.invalid');
  const b2 = writeBatch(lone);
  b2.set(doc(lone, 'students/sLone'), { name: 'ひとり', uid: 'lone', classIds: ['A'], createdAt: 1 });
  b2.set(doc(lone, 'accounts/lone'), { studentId: 'sLone' });
  await assertFails(b2.commit());
  // 別のクラスに参加コードで入る
  const join = (code) => {
    const b = writeBatch(db);
    b.set(doc(db, 'classes/B/members/sNew'), { name: 'しんにゅう', number: 5, groupId: null, joinCode: code, joinedAt: 1 });
    b.update(doc(db, 'students/sNew'), { classIds: arrayUnion('B') });
    return b.commit();
  };
  await assertFails(join('AAA111'));
  await assertSucceeds(join('BBB222'));
  // 自分で班や番号を変えたり、他人になりすましたりはできない
  await assertFails(updateDoc(doc(db, 'classes/A/members/sNew'), { groupId: 'g1' }));
  await assertSucceeds(updateDoc(doc(db, 'classes/A/members/sNew'), { name: '新しい名前' }));
  await assertFails(getDoc(doc(db, 'students/s1')));
  await assertFails(setDoc(doc(db, 'accounts/new1'), { studentId: 's1' }));
  await assertFails(getDocs(collection(db, 'names')));
  // 登録を締め切ったクラスには入れない
  await updateDoc(doc(as('tB'), 'classes/B'), { registrationOpen: false });
  const late = as('late', 'late@x.invalid');
  const b3 = writeBatch(late);
  b3.set(doc(late, 'students/sLate'), { name: 'おそい', uid: 'late', classIds: ['B'], createdAt: 1 });
  b3.set(doc(late, 'accounts/late'), { studentId: 'sLate' });
  b3.set(doc(late, 'classes/B/members/sLate'), { name: 'おそい', number: null, groupId: null, joinCode: 'BBB222', joinedAt: 1 });
  await assertFails(b3.commit());
  await updateDoc(doc(as('tB'), 'classes/B'), { registrationOpen: true });
});

test('生徒は入っているクラスだけ見られる', async () => {
  const s1 = as('uid1');
  await assertSucceeds(getDoc(doc(s1, 'classes/A')));
  await assertFails(getDoc(doc(s1, 'classes/B')));
  await assertFails(getDocs(query(collection(s1, 'classes/B/tasks'), where('status', 'in', ['open', 'closed']))));
  await assertSucceeds(getDocs(query(collection(s1, 'classes/A/tasks'), where('status', 'in', ['open', 'closed']))));
  await assertFails(getDocs(collection(s1, 'classes/A/tasks')));
  await assertFails(getDoc(doc(s1, 'classes/A/tasks/draft')));
  await assertFails(getDoc(doc(s1, 'classes/A/private/join')));
  // 2つのクラスに入っている s3 は両方見られる
  await assertSucceeds(getDoc(doc(as('uid3'), 'classes/B')));
  await assertSucceeds(getDocs(query(collection(as('uid3'), 'classes/B/tasks'), where('status', 'in', ['open', 'closed']))));
});

test('提出：生徒は自分でクリアにできない', async () => {
  const db = as('uid1');
  const p = 'classes/A/subs/short__u_s1';
  await assertFails(setDoc(doc(db, p), sub({ status: 'cleared' })));
  await assertSucceeds(setDoc(doc(db, p), sub({ status: 'pending', shortAnswer: '3' })));
  await assertFails(setDoc(doc(db, p), sub({ status: 'pending', attempts: 2, version: 2, feedback: 'よい' })));
  await assertSucceeds(setDoc(doc(db, p), sub({ status: 'pending', attempts: 2, version: 2 })));
  // ID と中身が食い違う・他人の名前では出せない
  await assertFails(setDoc(doc(db, 'classes/A/subs/short__u_s2'), sub({ ownerKey: 'u_s2', status: 'pending' })));
  await assertFails(setDoc(doc(db, 'classes/A/subs/group__u_s1'), sub({ status: 'pending' })));
  await assertFails(getDoc(doc(as('uid2'), p)));
  // 先生はクリアにできる。他のクラスの先生はできない
  await assertSucceeds(updateDoc(doc(as('admin'), p), { status: 'cleared', autoCorrect: true }));
  await assertFails(updateDoc(doc(as('tB'), p), { status: 'retry' }));
  // 締切・下書きの課題には出せない
  await assertFails(setDoc(doc(db, 'classes/A/subs/closed__u_s1'), sub({ taskId: 'closed' })));
  await assertFails(setDoc(doc(db, 'classes/A/subs/draft__u_s1'), sub({ taskId: 'draft' })));
  // 自分の提出は一覧で取れる。他人の分は取れない
  await assertSucceeds(getDocs(query(collection(db, 'classes/A/subs'), where('ownerKey', '==', 'u_s1'))));
  await assertFails(getDocs(query(collection(db, 'classes/A/subs'), where('ownerKey', '==', 'u_s2'))));
  await assertFails(getDocs(collection(db, 'classes/A/subs')));
  await assertSucceeds(getDocs(collection(as('admin'), 'classes/A/subs')));
  // 提出していないときの「自分の提出を読む」（トランザクションの最初）もできる
  await assertSucceeds(getDoc(doc(as('uid2'), 'classes/A/subs/short__u_s2')));
});

test('グループ提出と、匿名のみんなの考え', async () => {
  const s1 = as('uid1');
  const s2 = as('uid2');
  const s3 = as('uid3');
  const write = (db, key, sid, peerId, over = {}) => {
    const b = writeBatch(db);
    b.set(doc(db, `classes/A/subs/group__${key}`), sub({ taskId: 'group', ownerKey: key, ownerType: 'group', ownerId: key.slice(2), lastEditorId: sid, peerId, ...over }));
    b.set(doc(db, `classes/A/tasks/group/peers/${peerId}`), { shortAnswer: '', text: '考え', drawingV: null, photoV: null });
    return b.commit();
  };
  await assertFails(write(s3, 'g_g1', 's3', 'p_x'));
  await assertFails(getDocs(collection(s3, 'classes/A/tasks/group/peers')));
  await assertSucceeds(write(s1, 'g_g1', 's1', 'p_g1'));
  await assertSucceeds(getDoc(doc(s2, 'classes/A/subs/group__g_g1')));
  await assertSucceeds(getDocs(query(collection(s2, 'classes/A/subs'), where('ownerKey', '==', 'g_g1'))));
  await assertSucceeds(updateDoc(doc(s2, 'classes/A/subs/group__g_g1'), { text: '追記', attempts: 2, version: 2, lastEditorId: 's2', lastEditorName: 's2' }));
  await assertFails(updateDoc(doc(s1, 'classes/A/subs/group__g_g1'), { text: '古い', attempts: 3, version: 2, lastEditorId: 's1' }));
  await assertSucceeds(write(s3, 'g_g2', 's3', 'p_g2'));
  await assertFails(setDoc(doc(s3, 'classes/A/tasks/group/peers/p_g1'), { shortAnswer: '', text: 'いたずら', drawingV: null, photoV: null }));
  await assertSucceeds(getDocs(collection(s3, 'classes/A/tasks/group/peers')));
  await assertFails(setDoc(doc(s3, 'classes/A/tasks/group/peers/p_g2'), { shortAnswer: '', text: 'x', drawingV: null, photoV: null, name: 's3' }));
  await assertSucceeds(setDoc(doc(s3, 'classes/A/tasks/group/likes/p_g1_uid3'), { pid: 'p_g1', uid: 'uid3' }));
  await assertFails(setDoc(doc(s3, 'classes/A/tasks/group/likes/p_g2_uid3'), { pid: 'p_g2', uid: 'uid3' }));
  await assertFails(setDoc(doc(s3, 'classes/A/tasks/group/likes/p_g1_uid1'), { pid: 'p_g1', uid: 'uid1' }));
  await assertFails(getDocs(collection(s1, 'classes/A/tasks/short/peers')));
});

test('手書き・写真のファイル', async () => {
  const s1 = as('uid1');
  await assertSucceeds(setDoc(doc(s1, 'classes/A/subs/short__u_s1/files/drawing'), { data: 'data:image/png;base64,AAAA', v: 3 }));
  await assertFails(setDoc(doc(s1, 'classes/A/subs/short__u_s1/files/other'), { data: 'x', v: 1 }));
  await assertFails(setDoc(doc(s1, 'classes/A/subs/short__u_s2/files/drawing'), { data: 'x', v: 1 }));
  await assertFails(getDoc(doc(as('uid2'), 'classes/A/subs/short__u_s1/files/drawing')));
  await assertSucceeds(getDoc(doc(as('admin'), 'classes/A/subs/short__u_s1/files/drawing')));
  await assertFails(getDoc(doc(as('tB'), 'classes/A/subs/short__u_s1/files/drawing')));
});

test('ヘルプ', async () => {
  const s1 = as('uid1');
  const h = { taskId: 'short', studentId: 's1', message: 'わからない', createdAt: 1 };
  await assertSucceeds(setDoc(doc(s1, 'classes/A/help/short__s1'), h));
  await assertFails(setDoc(doc(s1, 'classes/A/help/short__s2'), { ...h, studentId: 's2' }));
  await assertFails(setDoc(doc(s1, 'classes/A/help/closed__s1'), { ...h, taskId: 'closed' }));
  await assertSucceeds(getDocs(query(collection(s1, 'classes/A/help'), where('studentId', '==', 's1'))));
  await assertFails(getDocs(collection(s1, 'classes/A/help')));
  await assertSucceeds(getDocs(collection(as('admin'), 'classes/A/help')));
  await assertSucceeds(deleteDoc(doc(as('admin'), 'classes/A/help/short__s1')));
});

test('小テスト：生徒は公開されたテストの自分の得点だけ見られる', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'classes/A/quizzes/q1'), { title: '第1回', date: '2026-10-22', maxScore: 10, published: true, createdAt: 1 });
    await setDoc(doc(db, 'classes/A/quizzes/q2'), { title: '第2回', date: '2026-10-23', maxScore: 10, published: false, createdAt: 2 });
    for (const [q, published] of [['q1', true], ['q2', false]]) {
      await setDoc(doc(db, `classes/A/scores/${q}__s1`), { quizId: q, studentId: 's1', score: 8, groupId: 'g1', groupName: '1班', published, updatedAt: 1 });
      await setDoc(doc(db, `classes/A/scores/${q}__s3`), { quizId: q, studentId: 's3', score: 5, groupId: 'g2', groupName: '2班', published, updatedAt: 1 });
    }
  });
  const s1 = as('uid1');
  await assertSucceeds(getDoc(doc(s1, 'classes/A/quizzes/q1')));
  await assertFails(getDoc(doc(s1, 'classes/A/quizzes/q2')));
  await assertSucceeds(getDocs(query(collection(s1, 'classes/A/quizzes'), where('published', '==', true))));
  await assertFails(getDocs(collection(s1, 'classes/A/quizzes')));
  await assertSucceeds(getDoc(doc(s1, 'classes/A/scores/q1__s1')));
  await assertFails(getDoc(doc(s1, 'classes/A/scores/q2__s1')));
  await assertFails(getDoc(doc(s1, 'classes/A/scores/q1__s3')));
  await assertSucceeds(getDocs(query(collection(s1, 'classes/A/scores'), where('studentId', '==', 's1'), where('published', '==', true))));
  await assertFails(getDocs(query(collection(s1, 'classes/A/scores'), where('studentId', '==', 's1'))));
  await assertFails(getDocs(collection(s1, 'classes/A/scores')));
  await assertFails(updateDoc(doc(s1, 'classes/A/scores/q1__s1'), { score: 10 }));
  await assertSucceeds(getDocs(collection(as('admin'), 'classes/A/scores')));
  await assertFails(getDocs(collection(as('tB'), 'classes/A/scores')));
});

test('タイマー：クラスの人が見られて、動かせるのは担当の先生だけ', async () => {
  const timer = { kind: 'timer', state: 'running', durationMs: 60000, accumulatedMs: 0, startedAt: 1, label: '' };
  await assertSucceeds(setDoc(doc(as('admin'), 'classes/A/live/timer'), timer));
  await assertSucceeds(getDoc(doc(as('uid1'), 'classes/A/live/timer')));
  await assertFails(setDoc(doc(as('uid1'), 'classes/A/live/timer'), { ...timer, state: 'stopped' }));
  await assertFails(setDoc(doc(as('tB'), 'classes/A/live/timer'), { ...timer, state: 'stopped' }));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'classes/A/live/timer')));
});

test('参加コード：コードを知っていれば引けるが、一覧はできない。作れるのは担当の先生だけ', async () => {
  await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'joinCodes/AAA111')));
  await assertFails(getDocs(collection(as('uid1'), 'joinCodes')));
  await assertFails(setDoc(doc(as('tB'), 'joinCodes/HACK11'), { classId: 'A' }));
  await assertSucceeds(setDoc(doc(as('tB'), 'joinCodes/BNEW11'), { classId: 'B' }));
  await assertFails(deleteDoc(doc(as('tB'), 'joinCodes/AAA111')));
});

test('先生は提出のある生徒・グループを消せる（匿名コピーのファイルも含めて）', async () => {
  const t = as('admin');
  const b = writeBatch(t);
  for (const p of [
    'classes/A/subs/group__g_g1/files/drawing', 'classes/A/tasks/group/peers/p_g1/files/drawing',
    'classes/A/tasks/group/peers/p_g1', 'classes/A/tasks/group/likes/p_g1_uid3', 'classes/A/subs/group__g_g1',
    'classes/A/members/s1', 'classes/A/groups/g1',
  ]) b.delete(doc(t, p));
  b.update(doc(t, 'students/s1'), { classIds: [] });
  await assertSucceeds(b.commit());
  await assertFails(deleteDoc(doc(as('uid3'), 'classes/A/tasks/group/peers/p_g2/files/drawing')));
  await assertFails(deleteDoc(doc(as('tB'), 'classes/A/members/s2')));
});

test('パスワード再設定後は古いログインが使えない', async () => {
  await assertSucceeds(deleteDoc(doc(as('admin'), 'accounts/uid2')));
  await assertFails(getDoc(doc(as('uid2'), 'classes/A/subs/group__g_g1')));
});
