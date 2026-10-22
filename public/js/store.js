// Firebase（Authentication + Firestore）とのやりとりをまとめたもの。
// 画面はここが持っている最新のデータ（state）を読み、変わったら 'change' で描き直す。
// Firestore は読んだ件数で無料枠を使うので、取り直しはせず onSnapshot の差分だけで更新する。
(function () {
  const F = window.FB;
  const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
  const CONFIG = LOCAL
    ? { apiKey: 'demo-key', authDomain: 'demo-math-board.firebaseapp.com', projectId: 'demo-math-board', appId: 'demo' }
    : window.FIREBASE_CONFIG;
  const STUDENT_DOMAIN = 'student.example.com';
  const MAX_IMAGE = 900 * 1024;

  if (!CONFIG) {
    document.body.textContent = 'Firebase の設定がまだです。public/firebase-config.js に設定を入れてください。';
    throw new Error('FIREBASE_CONFIG がありません');
  }
  const app = F.initializeApp(CONFIG);
  // メールとパスワードだけで使うので、Google ログイン用の部品（apis.google.com）は読み込まない
  const auth = F.initializeAuth(app, { persistence: [F.indexedDBLocalPersistence, F.browserLocalPersistence] });
  const db = F.initializeFirestore(app, {});
  if (LOCAL) {
    F.connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
    F.connectFirestoreEmulator(db, location.hostname, 8080);
  }

  const ref = (path) => F.doc(db, path);
  const col = (path) => F.collection(db, path);
  const now = () => Date.now();

  // ---------- 共通 ----------

  function randomId(length = 20) {
    const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  function randomCode(length = 6, chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  const tempPassword = () => randomCode(6, '23456789abcdefghijkmnpqrstuvwxyz');

  function cleanName(name) {
    const s = String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!s) throw new Error('名前を入力してください');
    if ([...s].length > 20) throw new Error('名前は20文字以内にしてください');
    if (s.includes('@')) throw new Error('名前に @ は使えません');
    return s;
  }

  // 名前 → 文書ID（大文字小文字・全角半角の違いは同じ名前とみなす）
  function nameKey(name) {
    const s = String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 出席番号は空欄か 1〜4000
  function parseNumber(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const n = Number(String(value).normalize('NFKC').trim());
    if (!Number.isInteger(n) || n < 1 || n > 4000) throw new Error('出席番号は1〜4000の数字で入力してください');
    return n;
  }

  function checkPassword(password) {
    const p = String(password || '');
    if (p.length < 6) throw new Error('パスワードは6文字以上にしてください');
    return p;
  }

  // Firebase のエラーを分かりやすい日本語にする
  function message(err) {
    const code = err && err.code;
    const map = {
      'auth/invalid-credential': '名前かパスワードが違います',
      'auth/wrong-password': '名前かパスワードが違います',
      'auth/user-not-found': '名前かパスワードが違います',
      'auth/invalid-email': 'メールアドレスの形が正しくありません',
      'auth/email-already-in-use': 'このメールアドレスはすでに使われています',
      'auth/weak-password': 'パスワードは6文字以上にしてください',
      'auth/too-many-requests': 'ログインの試行が多すぎます。しばらく待ってからやり直してください',
      'auth/network-request-failed': '通信できません。ネットワークを確認してください',
      'auth/requires-recent-login': 'もう一度ログインしてからやり直してください',
      'permission-denied': 'この操作はできません（権限がありません）',
      'failed-precondition': 'データベースの準備中です（公開直後は数分かかります）。自動でやり直します',
      'resource-exhausted': '今日の無料枠を使い切りました。明日になると戻ります',
      unavailable: '通信できません。ネットワークを確認してください',
    };
    return map[code] || (err && err.message) || 'エラーが起きました';
  }

  function wrap(fn) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        const e = new Error(message(err));
        e.code = err && err.code;
        e.status = err && err.status;
        throw e;
      }
    };
  }

  function waitForAuth() {
    return new Promise((resolve) => {
      const off = F.onAuthStateChanged(auth, (user) => {
        off();
        resolve(user);
      });
    });
  }

  // 生徒・先生用のアカウントを、先生のログインを切らずに作る（別のアプリとして作ってすぐ消す）
  async function createAccountAside(email, password) {
    const name = `aside-${randomId(8)}`;
    const second = F.initializeApp(CONFIG, name);
    const a = F.initializeAuth(second, { persistence: F.inMemoryPersistence });
    if (LOCAL) F.connectAuthEmulator(a, `http://${location.hostname}:9099`, { disableWarnings: true });
    try {
      const cred = await F.createUserWithEmailAndPassword(a, email, password);
      await F.signOut(a);
      return cred.user.uid;
    } finally {
      await F.deleteApp(second);
    }
  }

  const studentEmail = () => `u${randomId(16)}@${STUDENT_DOMAIN}`;

  // ---------- 画像（Firestore の文書に data URL で入れる） ----------

  const imageCache = new Map();

  function loadImage(img) {
    if (!img) return Promise.resolve(null);
    const key = `${img.path}@${img.v}`;
    if (!imageCache.has(key)) {
      imageCache.set(key, F.getDoc(ref(img.path)).then((s) => (s.exists() ? s.data().data : null)).catch(() => {
        imageCache.delete(key);
        return null;
      }));
    }
    return imageCache.get(key);
  }

  function checkImage(dataUrl) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) throw new Error('画像の形式が正しくありません');
    if (dataUrl.length > MAX_IMAGE) throw new Error('画像が大きすぎます。写真なら撮り直すか、手書きを少し減らしてください');
  }

  // ---------- ログイン前 ----------

  const publicConfig = wrap(async () => {
    const s = await F.getDoc(ref('config/main'));
    if (!s.exists()) return { needsSetup: true, className: '数学ボード', registrationOpen: false };
    const d = s.data();
    return { needsSetup: false, className: d.className, registrationOpen: !!d.registrationOpen };
  });

  const setup = wrap(async ({ className, email, password }) => {
    const exists = await F.getDoc(ref('config/main'));
    if (exists.exists()) throw new Error('初期設定は完了しています');
    if (String(password || '').length < 8) throw new Error('先生のパスワードは8文字以上にしてください');
    const cred = await F.createUserWithEmailAndPassword(auth, String(email).trim(), password);
    await F.setDoc(ref('config/main'), {
      teacherUid: cred.user.uid,
      className: String(className || '数学').slice(0, 40),
      registrationOpen: true,
    });
    await F.setDoc(ref('config/secret'), { joinCode: randomCode() });
    await F.setDoc(ref('config/answers'), {});
    await F.setDoc(ref('config/present'), { taskId: null, submissionKeys: [], showNames: false, showQr: false });
  });

  const login = wrap(async (id, password) => {
    const raw = String(id || '').trim();
    let email = raw;
    if (!raw.includes('@')) {
      const s = await F.getDoc(ref(`names/${nameKey(raw)}`));
      if (!s.exists()) throw new Error('名前かパスワードが違います');
      email = s.data().email;
    }
    await F.signInWithEmailAndPassword(auth, email, password);
  });

  const register = wrap(async ({ joinCode, name, number, password }) => {
    const clean = cleanName(name);
    checkPassword(password);
    const num = parseNumber(number);
    const key = nameKey(clean);
    if ((await F.getDoc(ref(`names/${key}`))).exists()) throw new Error('その名前はすでに使われています。別の名前にしてください');
    const email = studentEmail();
    const cred = await F.createUserWithEmailAndPassword(auth, email, password);
    const sid = randomId();
    const batch = F.writeBatch(db);
    batch.set(ref(`students/${sid}`), {
      name: clean, number: num, uid: cred.user.uid, joinCode: String(joinCode || '').normalize('NFKC').trim().toUpperCase(),
      groupId: null, createdAt: now(),
    });
    batch.set(ref(`accounts/${cred.user.uid}`), { studentId: sid });
    batch.set(ref(`names/${key}`), { email, studentId: sid });
    try {
      await batch.commit();
    } catch (err) {
      await F.deleteUser(cred.user).catch(() => {});
      if (err.code === 'permission-denied') {
        const cfg = await publicConfig();
        throw new Error(cfg.registrationOpen ? '参加コードが違うか、その名前はすでに使われています' : '現在、新規登録は締め切られています');
      }
      throw err;
    }
  });

  const logout = wrap(() => F.signOut(auth));

  const changePassword = wrap(async (current, next) => {
    const user = auth.currentUser;
    checkPassword(next);
    try {
      await F.reauthenticateWithCredential(user, F.EmailAuthProvider.credential(user.email, current));
    } catch {
      throw new Error('今のパスワードが違います');
    }
    await F.updatePassword(user, next);
  });

  const resetTeacherPassword = wrap((email) => F.sendPasswordResetEmail(auth, String(email).trim()));

  // ログイン中の人を調べる → { role: 'teacher' | 'student' | null, ... }
  async function whoami() {
    const user = await waitForAuth();
    if (!user) return { role: null };
    const cfg = await F.getDoc(ref('config/main'));
    if (cfg.exists() && cfg.data().teacherUid === user.uid) return { role: 'teacher', uid: user.uid, email: user.email };
    try {
      const acc = await F.getDoc(ref(`accounts/${user.uid}`));
      if (!acc.exists()) {
        // パスワードが再設定された古いログインなど
        await F.signOut(auth);
        return { role: null };
      }
      return { role: 'student', uid: user.uid, sid: acc.data().studentId };
    } catch {
      return { role: null };
    }
  }

  // onSnapshot を張る。失敗したら知らせ、インデックスの準備中などのときは少し待って張り直す
  function live(target, onNext, onFail) {
    let off = null;
    let timer = null;
    let stopped = false;
    const start = () => {
      off = F.onSnapshot(target, onNext, (err) => {
        console.error(err);
        onFail(err);
        if (!stopped && err.code !== 'permission-denied') timer = setTimeout(start, 20000);
      });
    };
    start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (off) off();
    };
  }

  // ---------- 変更通知 ----------

  function emitter() {
    const fns = new Set();
    let timer = null;
    const types = new Set();
    return {
      on(fn) { fns.add(fn); return () => fns.delete(fn); },
      // 短い間に何度も来るので、まとめて1回知らせる
      emit(type) {
        types.add(type);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const t = new Set(types);
          types.clear();
          fns.forEach((fn) => fn(t));
        }, 60);
      },
    };
  }

  function subData(s) {
    return { path: s.ref.path, taskId: s.ref.parent.parent.id, key: s.id, ...s.data() };
  }

  // ================= 生徒 =================

  function studentStore(who) {
    const ev = emitter();
    const state = {
      ready: false,
      uid: who.uid,
      sid: who.sid,
      me: null,
      group: null,
      className: '',
      tasks: new Map(),
      subs: new Map(), // taskId → 提出
      help: new Map(), // taskId → ヘルプ
      quizzes: new Map(), // 公開された小テスト
      scores: new Map(), // quizId → 自分の得点
      errors: new Map(), // 読み込めなかったもの → 理由
    };
    const offs = [];
    let groupOffs = [];
    const loaded = new Set();
    const markLoaded = (name) => {
      loaded.add(name);
      if (!state.ready && ['me', 'tasks', 'subsU', 'help'].every((n) => loaded.has(n))) state.ready = true;
    };
    // 読み込みに失敗しても「読み込み中」のまま止まらないよう、理由を残して先へ進む
    const failed = (name) => (err) => {
      state.errors.set(name, message(err));
      markLoaded(name);
      ev.emit(err.code === 'permission-denied' ? 'denied' : 'error');
    };
    const ok = (name) => {
      if (state.errors.delete(name)) ev.emit('error');
    };

    offs.push(live(ref('config/main'), (s) => {
      state.className = s.exists() ? s.data().className : '';
      ev.emit('config');
    }, failed('config')));

    function watchGroup(groupId) {
      groupOffs.forEach((f) => f());
      groupOffs = [];
      state.group = null;
      for (const [taskId, s] of state.subs) if (s.ownerType === 'group') state.subs.delete(taskId);
      if (!groupId) return;
      groupOffs.push(live(ref(`groups/${groupId}`), (s) => {
        state.group = s.exists() ? { id: s.id, ...s.data() } : null;
        ev.emit('group');
      }, failed('group')));
      groupOffs.push(live(F.query(F.collectionGroup(db, 'subs'), F.where('ownerKey', '==', `g_${groupId}`)), (snap) => {
        ok('subsG');
        applySubs(snap, 'group');
      }, failed('subsG')));
    }

    function applySubs(snap, type) {
      snap.docChanges().forEach((c) => {
        const d = subData(c.doc);
        if (c.type === 'removed') {
          if (state.subs.get(d.taskId)?.path === d.path) state.subs.delete(d.taskId);
        } else {
          state.subs.set(d.taskId, d);
        }
      });
      ev.emit('subs');
      return type;
    }

    offs.push(live(ref(`students/${who.sid}`), (s) => {
      if (!s.exists()) return ev.emit('denied');
      ok('me');
      const prevGroup = state.me && state.me.groupId;
      state.me = { id: s.id, ...s.data() };
      if (!loaded.has('me') || prevGroup !== state.me.groupId) watchGroup(state.me.groupId);
      markLoaded('me');
      ev.emit('me');
    }, failed('me')));

    offs.push(live(F.query(col('tasks'), F.where('status', 'in', ['open', 'closed'])), (snap) => {
      ok('tasks');
      snap.docChanges().forEach((c) => {
        if (c.type === 'removed') state.tasks.delete(c.doc.id);
        else state.tasks.set(c.doc.id, { id: c.doc.id, ...c.doc.data() });
      });
      markLoaded('tasks');
      ev.emit('tasks');
    }, failed('tasks')));

    offs.push(live(F.query(F.collectionGroup(db, 'subs'), F.where('ownerKey', '==', `u_${who.sid}`)), (snap) => {
      ok('subsU');
      applySubs(snap, 'user');
      markLoaded('subsU');
      ev.emit('subs');
    }, failed('subsU')));

    offs.push(live(F.query(F.collectionGroup(db, 'help'), F.where('studentId', '==', who.sid)), (snap) => {
      ok('help');
      snap.docChanges().forEach((c) => {
        const taskId = c.doc.ref.parent.parent.id;
        if (c.type === 'removed') state.help.delete(taskId);
        else state.help.set(taskId, c.doc.data());
      });
      markLoaded('help');
      ev.emit('help');
    }, failed('help')));

    offs.push(live(F.query(col('quizzes'), F.where('published', '==', true)), (snap) => {
      ok('quizzes');
      snap.docChanges().forEach((c) => {
        if (c.type === 'removed') state.quizzes.delete(c.doc.id);
        else state.quizzes.set(c.doc.id, { id: c.doc.id, ...c.doc.data() });
      });
      ev.emit('quizzes');
    }, failed('quizzes')));

    offs.push(live(F.query(F.collectionGroup(db, 'scores'), F.where('studentId', '==', who.sid), F.where('published', '==', true)), (snap) => {
      ok('scores');
      snap.docChanges().forEach((c) => {
        const quizId = c.doc.ref.parent.parent.id;
        if (c.type === 'removed') state.scores.delete(quizId);
        else state.scores.set(quizId, c.doc.data());
      });
      ev.emit('scores');
    }, failed('scores')));

    // 自分の小テストの履歴（新しい順）
    const myQuizzes = () => [...state.quizzes.values()]
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt)
      .map((q) => ({ ...q, score: state.scores.has(q.id) ? state.scores.get(q.id).score : null }));

    const sortedTasks = () => [...state.tasks.values()].sort((a, b) => (a.sort - b.sort) || (a.createdAt - b.createdAt));

    function ownerKey(task) {
      if (task.mode === 'group') return state.me && state.me.groupId ? `g_${state.me.groupId}` : null;
      return `u_${state.sid}`;
    }

    // 自分（グループ）の提出。違う課題の提出が混ざらないよう、キーも確かめる
    function mySub(task) {
      const s = state.subs.get(task.id);
      return s && s.key === ownerKey(task) ? s : null;
    }

    function canSeePeers(task) {
      if (task.peerView === 'on') return true;
      if (task.peerView === 'after_submit') return !!mySub(task);
      return false;
    }

    function imageRef(base, name, v) {
      return v ? { path: `${base}/files/${name}`, v } : null;
    }

    // 画面用の提出データ
    function submissionView(task, s) {
      if (!s) return null;
      const hide = task.answerKind === 'short' && !task.showResult;
      let status = s.status;
      if (hide && status === 'wrong') status = 'submitted';
      return {
        ...s,
        status,
        drawing: imageRef(s.path, 'drawing', s.drawingV),
        photo: imageRef(s.path, 'photo', s.photoV),
      };
    }

    const submit = wrap(async (taskId, form, baseVersion) => {
      const task = state.tasks.get(taskId);
      if (!task || task.status !== 'open') throw new Error('この課題は締め切られています');
      const key = ownerKey(task);
      if (!key) throw new Error('グループが決まっていないため提出できません。先生に伝えてください');
      if (form.drawing && form.drawing !== 'keep') checkImage(form.drawing);
      if (form.photo && form.photo !== 'keep') checkImage(form.photo);
      const subPath = `tasks/${taskId}/subs/${key}`;
      const shortAnswer = task.answerKind === 'short' ? String(form.shortAnswer || '').trim().slice(0, 200) : '';
      const text = task.allowText ? String(form.text || '').slice(0, 5000) : '';
      if (task.answerKind === 'short' && !shortAnswer) throw new Error('答えを入力してください');

      return F.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref(subPath));
        const old = snap.exists() ? snap.data() : null;
        if (old && baseVersion !== undefined && baseVersion !== old.version) {
          const e = new Error('同じグループの人が先に提出しました。最新の内容を読み込んでから、もう一度提出してください');
          e.status = 409;
          throw e;
        }
        const peerId = old ? old.peerId : randomId();
        const peerPath = `tasks/${taskId}/peers/${peerId}`;
        const next = (field, value, allowed) => {
          const oldV = old ? old[`${field}V`] : null;
          if (!allowed || value === undefined || value === 'keep') return { v: oldV || null };
          if (!value) return { v: null, remove: !!oldV };
          return { v: (oldV || 0) + 1, data: value };
        };
        const drawing = next('drawing', form.drawing, task.allowDraw);
        const photo = next('photo', form.photo, task.allowPhoto);
        if (!shortAnswer && !text.trim() && !drawing.v && !photo.v) throw new Error('何か書いてから提出してください');
        const status = task.answerKind === 'short' ? 'pending' : (old && old.status === 'cleared' ? 'cleared' : 'submitted');
        const data = {
          ownerKey: key,
          ownerType: task.mode === 'group' ? 'group' : 'user',
          ownerId: key.slice(2),
          shortAnswer,
          text,
          confidence: [1, 2, 3, 4].includes(form.confidence) ? form.confidence : null,
          drawingV: drawing.v,
          photoV: photo.v,
          status,
          autoCorrect: null,
          feedback: old ? old.feedback : '',
          attempts: old ? old.attempts + 1 : 1,
          version: old ? old.version + 1 : 1,
          lastEditorId: state.sid,
          lastEditorName: state.me.name,
          updatedAt: now(),
          peerId,
        };
        tx.set(ref(subPath), data);
        tx.set(ref(peerPath), { shortAnswer, text, drawingV: drawing.v, photoV: photo.v });
        for (const [name, f] of [['drawing', drawing], ['photo', photo]]) {
          if (f.data) {
            tx.set(ref(`${subPath}/files/${name}`), { data: f.data, v: f.v });
            tx.set(ref(`${peerPath}/files/${name}`), { data: f.data, v: f.v });
            imageCache.set(`${subPath}/files/${name}@${f.v}`, Promise.resolve(f.data));
          }
        }
        return submissionView(task, { path: subPath, taskId, key, ...data });
      });
    });

    const setHelp = wrap((taskId, msg) => F.setDoc(ref(`tasks/${taskId}/help/${state.sid}`), {
      studentId: state.sid, message: String(msg || '').slice(0, 200), createdAt: now(),
    }));
    const clearHelp = wrap((taskId) => F.deleteDoc(ref(`tasks/${taskId}/help/${state.sid}`)));

    // みんなの考え。見ている間だけ受け取る
    function watchPeers(taskId, cb) {
      const peers = new Map();
      const likes = new Map();
      const send = () => {
        const task = state.tasks.get(taskId);
        const own = task ? mySub(task) : null;
        const list = [...peers.entries()]
          .filter(([, p]) => p.shortAnswer || p.text || p.drawingV || p.photoV)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, p], i) => {
            const l = [...likes.values()].filter((x) => x.pid === id);
            return {
              id,
              label: `回答 ${i + 1}`,
              mine: !!own && own.peerId === id,
              shortAnswer: p.shortAnswer,
              text: p.text,
              drawing: imageRef(`tasks/${taskId}/peers/${id}`, 'drawing', p.drawingV),
              photo: imageRef(`tasks/${taskId}/peers/${id}`, 'photo', p.photoV),
              likes: l.length,
              liked: l.some((x) => x.uid === state.uid),
            };
          });
        cb(list);
      };
      const fail = (err) => {
        if (err.code !== 'permission-denied') console.error(err);
        cb(null);
      };
      const off1 = F.onSnapshot(col(`tasks/${taskId}/peers`), (snap) => {
        snap.docChanges().forEach((c) => (c.type === 'removed' ? peers.delete(c.doc.id) : peers.set(c.doc.id, c.doc.data())));
        send();
      }, fail);
      const off2 = F.onSnapshot(col(`tasks/${taskId}/likes`), (snap) => {
        snap.docChanges().forEach((c) => (c.type === 'removed' ? likes.delete(c.doc.id) : likes.set(c.doc.id, c.doc.data())));
        send();
      }, fail);
      return () => { off1(); off2(); };
    }

    const toggleLike = wrap(async (taskId, pid, liked) => {
      const path = `tasks/${taskId}/likes/${pid}_${state.uid}`;
      if (liked) await F.deleteDoc(ref(path));
      else await F.setDoc(ref(path), { pid, uid: state.uid });
    });

    const changeName = wrap(async (name) => {
      const clean = cleanName(name);
      const oldKey = nameKey(state.me.name);
      const newKey = nameKey(clean);
      const batch = F.writeBatch(db);
      if (newKey !== oldKey) {
        if ((await F.getDoc(ref(`names/${newKey}`))).exists()) throw new Error('その名前はすでに使われています');
        batch.set(ref(`names/${newKey}`), { email: auth.currentUser.email, studentId: state.sid });
        batch.delete(ref(`names/${oldKey}`));
      }
      batch.update(ref(`students/${state.sid}`), { name: clean });
      await batch.commit();
    });

    return {
      state, on: ev.on, sortedTasks, ownerKey, mySub, canSeePeers, submissionView, submit, setHelp, clearHelp,
      watchPeers, toggleLike, changeName, myQuizzes, stop: () => { offs.forEach((f) => f()); groupOffs.forEach((f) => f()); },
    };
  }

  // ================= 先生 =================

  function teacherStore(who) {
    const ev = emitter();
    const state = {
      ready: false,
      uid: who.uid,
      email: who.email,
      settings: { className: '', registrationOpen: true, joinCode: '' },
      answers: {},
      present: { taskId: null, submissionKeys: [], showNames: false, showQr: false },
      students: new Map(),
      groups: new Map(),
      tasks: new Map(),
      subs: new Map(), // path → 提出
      help: new Map(), // `${taskId}:${studentId}` → ヘルプ
      likes: new Map(), // path → {pid, uid}
      quizzes: new Map(),
      scores: new Map(), // `${quizId}:${studentId}` → 得点
      errors: new Map(), // 読み込めなかったもの → 理由
    };
    const offs = [];
    const loaded = new Set();
    const need = ['main', 'secret', 'answers', 'students', 'groups', 'tasks', 'subs', 'help', 'quizzes', 'scores'];
    const markLoaded = (n) => {
      loaded.add(n);
      if (!state.ready && need.every((x) => loaded.has(x))) {
        state.ready = true;
        autoJudge();
        syncGroupMembers();
      }
    };
    // 読み込みに失敗しても「読み込み中」のまま止まらないよう、理由を残して先へ進む
    const failed = (name) => (err) => {
      state.errors.set(name, message(err));
      markLoaded(name);
      ev.emit(err.code === 'permission-denied' ? 'denied' : 'error');
    };
    const watchDoc = (path, name, fn) => offs.push(live(ref(path), (s) => {
      state.errors.delete(name);
      fn(s.exists() ? s.data() : null);
      markLoaded(name);
      ev.emit(name);
    }, failed(name)));
    const watchCol = (q, name, map, keyOf, valueOf) => offs.push(live(q, (snap) => {
      state.errors.delete(name);
      snap.docChanges().forEach((c) => {
        const k = keyOf(c.doc);
        if (c.type === 'removed') map.delete(k);
        else map.set(k, valueOf(c.doc));
      });
      markLoaded(name);
      ev.emit(name);
      if (name === 'subs') autoJudge();
      if (name === 'students' || name === 'groups') syncGroupMembers();
    }, failed(name)));

    watchDoc('config/main', 'main', (d) => Object.assign(state.settings, { className: d?.className || '', registrationOpen: !!d?.registrationOpen }));
    watchDoc('config/secret', 'secret', (d) => { state.settings.joinCode = d?.joinCode || ''; });
    watchDoc('config/answers', 'answers', (d) => { state.answers = d || {}; autoJudge(); });
    watchDoc('config/present', 'present', (d) => { state.present = { taskId: null, submissionKeys: [], showNames: false, showQr: false, ...(d || {}) }; });
    watchCol(col('students'), 'students', state.students, (d) => d.id, (d) => ({ id: d.id, ...d.data() }));
    watchCol(col('groups'), 'groups', state.groups, (d) => d.id, (d) => ({ id: d.id, ...d.data() }));
    watchCol(col('tasks'), 'tasks', state.tasks, (d) => d.id, (d) => ({ id: d.id, ...d.data() }));
    watchCol(F.query(F.collectionGroup(db, 'subs'), F.where('ownerKey', '>=', '')), 'subs', state.subs, (d) => d.ref.path, subData);
    watchCol(F.query(F.collectionGroup(db, 'help'), F.where('studentId', '>=', '')), 'help', state.help,
      (d) => `${d.ref.parent.parent.id}:${d.id}`, (d) => ({ taskId: d.ref.parent.parent.id, ...d.data() }));
    watchCol(F.query(F.collectionGroup(db, 'likes'), F.where('pid', '>=', '')), 'likes', state.likes, (d) => d.ref.path,
      (d) => ({ taskId: d.ref.parent.parent.id, ...d.data() }));
    watchCol(col('quizzes'), 'quizzes', state.quizzes, (d) => d.id, (d) => ({ id: d.id, ...d.data() }));
    watchCol(F.query(F.collectionGroup(db, 'scores'), F.where('studentId', '>=', '')), 'scores', state.scores,
      (d) => `${d.ref.parent.parent.id}:${d.id}`, (d) => ({ quizId: d.ref.parent.parent.id, ...d.data() }));

    // --- 自動判定：先生の画面が開いている間、届いた短答をすぐ判定する ---
    const judging = new Set();
    function autoJudge() {
      if (!state.ready || !window.MBJudge) return;
      for (const s of state.subs.values()) {
        if (s.status !== 'pending') continue;
        const t = state.tasks.get(s.taskId);
        const accepted = state.answers[s.taskId];
        const id = `${s.path}@${s.version}`;
        if (!t || judging.has(id)) continue;
        judging.add(id);
        const ok = t.answerKind === 'short' ? window.MBJudge.judge(s.shortAnswer, accepted || {}) : null;
        const status = ok === null ? 'submitted' : ok ? 'cleared' : 'wrong';
        F.runTransaction(db, async (tx) => {
          const cur = await tx.get(ref(s.path));
          // 判定している間に書き直されていたら、新しい方を待つ
          if (!cur.exists() || cur.data().version !== s.version || cur.data().status !== 'pending') return;
          tx.update(ref(s.path), { status, autoCorrect: ok });
        }).then(() => {
          if (status === 'cleared') removeHelpFor(s);
        }).catch((err) => {
          console.error(err);
          judging.delete(id);
        });
      }
    }

    function removeHelpFor(s) {
      const sids = s.ownerType === 'group'
        ? [...state.students.values()].filter((st) => st.groupId === s.ownerId).map((st) => st.id)
        : [s.ownerId];
      return Promise.all(sids.filter((sid) => state.help.has(`${s.taskId}:${sid}`))
        .map((sid) => F.deleteDoc(ref(`tasks/${s.taskId}/help/${sid}`))));
    }

    // グループのメンバー名を、生徒が見られる groups の文書に写す
    let syncTimer = null;
    function syncGroupMembers() {
      if (!state.ready) return;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        for (const g of state.groups.values()) {
          const names = [...state.students.values()].filter((s) => s.groupId === g.id).map((s) => s.name).sort();
          if (JSON.stringify(names) !== JSON.stringify(g.members || [])) {
            F.updateDoc(ref(`groups/${g.id}`), { members: names }).catch(console.error);
          }
        }
      }, 500);
    }

    // --- 読み出し ---

    const sortStudents = (list) => list.sort((a, b) => ((a.number ?? 99999) - (b.number ?? 99999)) || a.name.localeCompare(b.name, 'ja'));
    const students = () => sortStudents([...state.students.values()]);
    const groups = () => [...state.groups.values()].sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name, 'ja'));
    const tasks = () => [...state.tasks.values()].sort((a, b) => (a.sort - b.sort) || (a.createdAt - b.createdAt));

    function ownerName(s) {
      if (s.ownerType === 'group') return state.groups.get(s.ownerId)?.name || '(削除されたグループ)';
      return state.students.get(s.ownerId)?.name || '(削除された生徒)';
    }

    function submissionsOf(taskId) {
      const likes = [...state.likes.values()].filter((l) => l.taskId === taskId);
      return [...state.subs.values()].filter((s) => s.taskId === taskId).map((s) => ({
        ...s,
        id: s.path,
        ownerName: ownerName(s),
        likes: likes.filter((l) => l.pid === s.peerId).length,
        drawing: s.drawingV ? { path: `${s.path}/files/drawing`, v: s.drawingV } : null,
        photo: s.photoV ? { path: `${s.path}/files/photo`, v: s.photoV } : null,
      })).sort((a, b) => a.updatedAt - b.updatedAt);
    }

    function taskView(t) {
      const a = state.answers[t.id] || {};
      return {
        ...t,
        accepted: { answers: a.answers || [], mode: a.mode || 'value' },
        hintText: a.hint || '',
        image: t.imageV ? { path: `tasks/${t.id}/files/image`, v: t.imageV } : null,
      };
    }

    // --- 設定 ---

    const updateSettings = wrap(async ({ className, registrationOpen, regenerateJoinCode }) => {
      const patch = {};
      if (className !== undefined) patch.className = String(className).slice(0, 40);
      if (registrationOpen !== undefined) patch.registrationOpen = !!registrationOpen;
      if (Object.keys(patch).length) await F.updateDoc(ref('config/main'), patch);
      if (regenerateJoinCode) await F.setDoc(ref('config/secret'), { joinCode: randomCode() });
    });

    // --- 生徒 ---

    const addStudent = wrap(async ({ name, number }) => {
      const clean = cleanName(name);
      const key = nameKey(clean);
      if ((await F.getDoc(ref(`names/${key}`))).exists()) throw new Error('その名前はすでに使われています');
      const password = tempPassword();
      const email = studentEmail();
      const uid = await createAccountAside(email, password);
      const sid = randomId();
      const batch = F.writeBatch(db);
      batch.set(ref(`students/${sid}`), {
        name: clean, number: parseNumber(number), uid, joinCode: '', groupId: null, createdAt: now(),
      });
      batch.set(ref(`accounts/${uid}`), { studentId: sid });
      batch.set(ref(`names/${key}`), { email, studentId: sid });
      await batch.commit();
      return { password };
    });

    // 新しいログイン用アカウントを作って付け替える（古いパスワードのログインは使えなくなる）
    const resetStudentPassword = wrap(async (sid) => {
      const st = state.students.get(sid);
      if (!st) throw new Error('生徒が見つかりません');
      const password = tempPassword();
      const email = studentEmail();
      const uid = await createAccountAside(email, password);
      const batch = F.writeBatch(db);
      batch.set(ref(`accounts/${uid}`), { studentId: sid });
      if (st.uid) batch.delete(ref(`accounts/${st.uid}`));
      batch.set(ref(`names/${nameKey(st.name)}`), { email, studentId: sid });
      batch.update(ref(`students/${sid}`), { uid });
      await batch.commit();
      return { password };
    });

    const updateStudent = wrap(async (sid, { name, number, groupId }) => {
      const st = state.students.get(sid);
      if (!st) throw new Error('生徒が見つかりません');
      const batch = F.writeBatch(db);
      const patch = {};
      if (name !== undefined) {
        const clean = cleanName(name);
        const oldKey = nameKey(st.name);
        const newKey = nameKey(clean);
        if (newKey !== oldKey) {
          if ((await F.getDoc(ref(`names/${newKey}`))).exists()) throw new Error('その名前はすでに使われています');
          const old = await F.getDoc(ref(`names/${oldKey}`));
          batch.set(ref(`names/${newKey}`), { email: old.exists() ? old.data().email : '', studentId: sid });
          batch.delete(ref(`names/${oldKey}`));
        }
        patch.name = clean;
      }
      if (number !== undefined) patch.number = parseNumber(number);
      if (groupId !== undefined) patch.groupId = groupId || null;
      batch.update(ref(`students/${sid}`), patch);
      await batch.commit();
    });

    // 提出と、そのファイル・匿名コピーを消す
    async function deleteSubmission(s) {
      const paths = [`${s.path}/files/drawing`, `${s.path}/files/photo`];
      if (s.peerId) {
        const base = `tasks/${s.taskId}/peers/${s.peerId}`;
        paths.push(`${base}/files/drawing`, `${base}/files/photo`, base);
        for (const [p, l] of state.likes) if (l.taskId === s.taskId && l.pid === s.peerId) paths.push(p);
      }
      paths.push(s.path);
      await commitDeletes(paths);
    }

    async function commitDeletes(paths) {
      for (let i = 0; i < paths.length; i += 400) {
        const batch = F.writeBatch(db);
        paths.slice(i, i + 400).forEach((p) => batch.delete(ref(p)));
        await batch.commit();
      }
    }

    const deleteStudent = wrap(async (sid) => {
      const st = state.students.get(sid);
      if (!st) return;
      await commitDeletes([...state.scores.values()].filter((x) => x.studentId === sid).map((x) => `quizzes/${x.quizId}/scores/${sid}`));
      for (const s of [...state.subs.values()]) if (s.ownerType === 'user' && s.ownerId === sid) await deleteSubmission(s);
      const paths = [...state.help.values()].filter((h) => h.studentId === sid).map((h) => `tasks/${h.taskId}/help/${sid}`);
      paths.push(`names/${nameKey(st.name)}`, `students/${sid}`);
      if (st.uid) paths.push(`accounts/${st.uid}`);
      await commitDeletes(paths);
    });

    // --- グループ ---

    const addGroup = wrap(async (name) => {
      const count = state.groups.size;
      await F.setDoc(ref(`groups/${randomId(10)}`), { name: String(name || '').trim().slice(0, 30) || `${count + 1}班`, sort: count + 1, members: [] });
    });
    const renameGroup = wrap((gid, name) => F.updateDoc(ref(`groups/${gid}`), { name: String(name).trim().slice(0, 30) }));

    const deleteGroup = wrap(async (gid) => {
      for (const s of [...state.subs.values()]) if (s.ownerType === 'group' && s.ownerId === gid) await deleteSubmission(s);
      const batch = F.writeBatch(db);
      for (const st of state.students.values()) if (st.groupId === gid) batch.update(ref(`students/${st.id}`), { groupId: null });
      batch.delete(ref(`groups/${gid}`));
      await batch.commit();
    });

    // 指定人数でランダムに分ける（今のグループとグループ課題の提出は作り直す）
    const autoGroups = wrap(async (size) => {
      const n = Math.max(2, Math.min(10, Number(size) || 4));
      const ids = [...state.students.keys()];
      for (let i = ids.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      for (const s of [...state.subs.values()]) if (s.ownerType === 'group') await deleteSubmission(s);
      const count = Math.max(1, Math.round(ids.length / n));
      const batch = F.writeBatch(db);
      for (const g of state.groups.values()) batch.delete(ref(`groups/${g.id}`));
      const newIds = Array.from({ length: count }, () => randomId(10));
      newIds.forEach((gid, i) => batch.set(ref(`groups/${gid}`), { name: `${i + 1}班`, sort: i + 1, members: [] }));
      ids.forEach((sid, i) => batch.update(ref(`students/${sid}`), { groupId: newIds[i % count] }));
      await batch.commit();
    });

    // --- 課題 ---

    async function writeAnswers(taskId, v) {
      await F.setDoc(ref('config/answers'), {
        [taskId]: {
          answers: (v.accepted?.answers || []).map((a) => String(a).trim()).filter(Boolean).slice(0, 20),
          mode: v.accepted?.mode === 'exact' ? 'exact' : 'value',
          hint: String(v.hint || '').slice(0, 5000),
        },
      }, { merge: true });
    }

    function taskFields(v, old) {
      const hint = v.hint !== undefined ? v.hint : (state.answers[old?.id]?.hint || '');
      const hintOpen = v.hintOpen !== undefined ? !!v.hintOpen : !!old?.hintOpen;
      const pick = (k, def) => (v[k] !== undefined ? v[k] : (old ? old[k] : def));
      return {
        title: String(pick('title', '')).trim().slice(0, 100) || '無題の課題',
        body: String(pick('body', '')).slice(0, 10000),
        mode: pick('mode', 'individual') === 'group' ? 'group' : 'individual',
        answerKind: pick('answerKind', 'free') === 'short' ? 'short' : 'free',
        showResult: !!pick('showResult', true),
        allowText: !!pick('allowText', true),
        allowDraw: !!pick('allowDraw', true),
        allowPhoto: !!pick('allowPhoto', true),
        peerView: ['off', 'after_submit', 'on'].includes(pick('peerView', 'off')) ? pick('peerView', 'off') : 'off',
        status: ['draft', 'open', 'closed'].includes(pick('status', 'draft')) ? pick('status', 'draft') : 'draft',
        hintOpen,
        // 生徒が読む課題の文書には、公開したときだけヒントを入れる
        hint: hintOpen ? String(hint).slice(0, 5000) : '',
      };
    }

    async function writeTaskImage(taskId, image, oldV) {
      if (image === undefined) return oldV || null;
      if (!image) {
        if (oldV) await F.deleteDoc(ref(`tasks/${taskId}/files/image`));
        return null;
      }
      checkImage(image);
      const v = (oldV || 0) + 1;
      await F.setDoc(ref(`tasks/${taskId}/files/image`), { data: image, v });
      return v;
    }

    const createTask = wrap(async (v) => {
      const id = randomId(12);
      const sort = Math.max(0, ...tasks().map((t) => t.sort || 0)) + 1;
      await writeAnswers(id, v);
      const fields = taskFields(v, null);
      await F.setDoc(ref(`tasks/${id}`), { ...fields, imageV: null, sort, createdAt: now() });
      const imageV = await writeTaskImage(id, v.image, null);
      if (imageV) await F.updateDoc(ref(`tasks/${id}`), { imageV });
      return id;
    });

    const updateTask = wrap(async (id, v) => {
      const old = state.tasks.get(id);
      if (!old) throw new Error('課題が見つかりません');
      if (v.accepted !== undefined || v.hint !== undefined) {
        const cur = state.answers[id] || {};
        await writeAnswers(id, {
          accepted: v.accepted !== undefined ? v.accepted : { answers: cur.answers, mode: cur.mode },
          hint: v.hint !== undefined ? v.hint : cur.hint,
        });
        if (v.hint !== undefined) state.answers[id] = { ...cur, hint: v.hint };
      }
      const imageV = await writeTaskImage(id, v.image, old.imageV);
      await F.updateDoc(ref(`tasks/${id}`), { ...taskFields(v, old), imageV });
    });

    const rejudge = wrap(async (id) => {
      const t = state.tasks.get(id);
      const accepted = state.answers[id] || {};
      let changed = 0;
      const batch = F.writeBatch(db);
      for (const s of state.subs.values()) {
        if (s.taskId !== id || t.answerKind !== 'short') continue;
        const ok = window.MBJudge.judge(s.shortAnswer, accepted);
        if (ok === null) continue;
        const status = ok ? 'cleared' : (s.status === 'cleared' || s.status === 'pending' ? 'wrong' : s.status);
        if (status !== s.status || ok !== s.autoCorrect) changed++;
        batch.update(ref(s.path), { status, autoCorrect: ok });
      }
      await batch.commit();
      return { changed };
    });

    const duplicateTask = wrap(async (id) => {
      const t = state.tasks.get(id);
      const a = state.answers[id] || {};
      let image;
      if (t.imageV) image = await loadImage({ path: `tasks/${id}/files/image`, v: t.imageV });
      await createTask({ ...t, title: `${t.title}（コピー）`, status: 'draft', hintOpen: false, hint: a.hint || '', accepted: { answers: a.answers, mode: a.mode }, image });
    });

    const reorderTasks = wrap(async (ids) => {
      const batch = F.writeBatch(db);
      ids.forEach((id, i) => batch.update(ref(`tasks/${id}`), { sort: i + 1 }));
      await batch.commit();
    });

    const deleteTask = wrap(async (id) => {
      for (const s of [...state.subs.values()]) if (s.taskId === id) await deleteSubmission(s);
      const paths = [];
      for (const sub of ['peers', 'likes', 'help']) {
        const snap = await F.getDocs(col(`tasks/${id}/${sub}`));
        snap.forEach((d) => paths.push(d.ref.path));
      }
      paths.push(`tasks/${id}/files/image`, `tasks/${id}`);
      await commitDeletes(paths);
      await F.updateDoc(ref('config/answers'), { [id]: F.deleteField() });
      if (state.present.taskId === id) await setPresent({ taskId: null, submissionKeys: [] });
    });

    // --- 提出の確認 ---

    const setSubmission = wrap(async (path, { status, feedback }) => {
      const patch = {};
      if (status) patch.status = status;
      if (feedback !== undefined) patch.feedback = String(feedback).slice(0, 2000);
      await F.updateDoc(ref(path), patch);
      const s = state.subs.get(path);
      if (s && status === 'cleared') await removeHelpFor(s);
    });

    const dismissHelp = wrap((taskId, sid) => F.deleteDoc(ref(`tasks/${taskId}/help/${sid}`)));

    // --- 提示 ---

    const setPresent = wrap(async (patch) => {
      const next = { ...state.present, ...patch };
      next.submissionKeys = (next.submissionKeys || []).slice(0, 8);
      state.present = next;
      await F.setDoc(ref('config/present'), next);
      return next;
    });

    // --- 小テスト ---

    const quizzes = () => [...state.quizzes.values()]
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
    const scoresOf = (quizId) => [...state.scores.values()].filter((x) => x.quizId === quizId);

    function quizFields(v) {
      const title = String(v.title || '').trim().slice(0, 60);
      if (!title) throw new Error('テスト名を入力してください');
      const maxScore = Number(v.maxScore);
      if (!(maxScore > 0) || maxScore > 1000) throw new Error('満点は1〜1000の数で入力してください');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) throw new Error('日付を入力してください');
      return { title, date: v.date, maxScore, published: !!v.published };
    }

    const createQuiz = wrap(async (v) => {
      const id = randomId(12);
      await F.setDoc(ref(`quizzes/${id}`), { ...quizFields(v), createdAt: now() });
      return id;
    });

    // 公開・非公開を変えたときは、生徒が自分の得点を読めるかどうかも合わせて変える
    const updateQuiz = wrap(async (id, v) => {
      const old = state.quizzes.get(id);
      if (!old) throw new Error('テストが見つかりません');
      const fields = quizFields({ ...old, ...v });
      const batch = F.writeBatch(db);
      batch.update(ref(`quizzes/${id}`), fields);
      if (fields.published !== !!old.published) {
        for (const x of scoresOf(id)) batch.update(ref(`quizzes/${id}/scores/${x.studentId}`), { published: fields.published });
      }
      await batch.commit();
    });

    const deleteQuiz = wrap(async (id) => {
      await commitDeletes([...scoresOf(id).map((x) => `quizzes/${id}/scores/${x.studentId}`), `quizzes/${id}`]);
    });

    // entries: [{ studentId, score }]（score が null なら未入力・欠席として消す）
    const saveScores = wrap(async (quizId, entries) => {
      const q = state.quizzes.get(quizId);
      if (!q) throw new Error('テストが見つかりません');
      const writes = [];
      for (const { studentId, score } of entries) {
        const path = `quizzes/${quizId}/scores/${studentId}`;
        const old = state.scores.get(`${quizId}:${studentId}`);
        if (score === null) {
          if (old) writes.push((b) => b.delete(ref(path)));
          continue;
        }
        if (!(score >= 0 && score <= q.maxScore)) throw new Error(`得点は0〜${q.maxScore}点で入力してください`);
        if (old && old.score === score) continue;
        // 班は最初に入力したときのものを残す（あとで班替えしても過去の記録が変わらないように）
        const st = state.students.get(studentId);
        const groupId = old ? old.groupId : (st && st.groupId) || null;
        const groupName = old ? old.groupName : (groupId && state.groups.get(groupId)?.name) || '';
        writes.push((b) => b.set(ref(path), { studentId, score, groupId, groupName, published: !!q.published, updatedAt: now() }));
      }
      for (let i = 0; i < writes.length; i += 400) {
        const batch = F.writeBatch(db);
        writes.slice(i, i + 400).forEach((w) => w(batch));
        await batch.commit();
      }
      return writes.length;
    });

    return {
      state, on: ev.on, students, groups, tasks, ownerName, submissionsOf, taskView,
      quizzes, scoresOf, createQuiz, updateQuiz, deleteQuiz, saveScores,
      updateSettings, addStudent, resetStudentPassword, updateStudent, deleteStudent,
      addGroup, renameGroup, deleteGroup, autoGroups,
      createTask, updateTask, rejudge, duplicateTask, reorderTasks, deleteTask,
      setSubmission, dismissHelp, setPresent,
      stop: () => offs.forEach((f) => f()),
    };
  }

  window.Store = {
    LOCAL, publicConfig, setup, login, register, logout, changePassword, resetTeacherPassword, whoami,
    studentStore, teacherStore, loadImage, nameKey,
  };
})();
