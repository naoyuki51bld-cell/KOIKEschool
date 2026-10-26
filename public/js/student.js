(function () {
  const { h, fill, $, toast, rich, img, modal, compressImage, debounce, statusBadge } = MB;
  const view = $('#view');
  let store = null;
  let who = null; // ログイン中の生徒
  let classes = []; // 入っているクラス
  let current = null; // 開いている課題の画面の状態

  const SYMBOLS = ['√', '²', '³', '^', 'π', '±', '×', '÷', '≦', '≧', '≠', '∠', '△', '°', '⊥', '∥', '∞', 'θ', '∴', '∵', '⇒', '⇔', '∈', '∩', '∪', 'log', 'sin', 'cos', 'tan'];
  const CONFIDENCE = [
    [1, 'わからない'],
    [2, '少し不安'],
    [3, 'だいたい'],
    [4, '自信あり'],
  ];

  // ---------- ルーティング ----------

  function route() {
    const m = /^#\/task\/([\w-]+)/.exec(location.hash);
    if (m) openTask(m[1]);
    else if (location.hash === '#/quizzes') showQuizzes();
    else showList();
  }

  window.addEventListener('hashchange', () => {
    if (current && current.dirty && !window.confirm('書きかけの内容は消えます。移動しますか？')) {
      history.replaceState(null, '', `#/task/${current.taskId}`);
      return;
    }
    route();
  });

  window.addEventListener('beforeunload', (e) => {
    if (current && current.dirty) e.preventDefault();
  });

  // ---------- 課題一覧 ----------

  function showList() {
    closeTask();
    const { state } = store;
    const tasks = store.sortedTasks();
    const statusOf = (t) => {
      const s = store.submissionView(t, store.mySub(t));
      return s ? s.status : 'none';
    };
    const groupLine = state.group
      ? h('p', { class: 'muted small' }, `グループ：${state.group.name}${state.group.members && state.group.members.length ? `（${state.group.members.join('、')}）` : ''}`)
      : null;
    const items = tasks.map((t) => {
      const s = store.mySub(t);
      return h('button', { class: 'card task-item', onclick: () => { location.hash = `#/task/${t.id}`; } },
        h('div', { class: 't' },
          h('strong', {}, t.title),
          h('div', { class: 'row', style: { marginTop: '4px' } },
            t.mode === 'group' ? h('span', { class: 'badge group' }, 'グループ') : h('span', { class: 'badge' }, '個人'),
            t.status === 'closed' ? h('span', { class: 'badge closed' }, '締切') : null,
            s && s.feedback ? h('span', { class: 'badge submitted' }, 'コメントあり') : null)),
        statusBadge(statusOf(t)));
    });
    const cleared = tasks.filter((t) => statusOf(t) === 'cleared').length;
    fill(view,
      installBanner(),
      sectionTabs('tasks'),
      h('div', { class: 'row between', style: { marginBottom: '8px' } },
        h('h1', { style: { margin: 0 } }, '課題'),
        tasks.length ? h('span', { class: 'muted small' }, `クリア ${cleared} / ${tasks.length}`) : null),
      groupLine,
      tasks.length ? h('div', {}, items) : h('div', { class: 'card muted' }, 'まだ課題はありません。先生が課題を出すと、ここに表示されます。'));
  }

  // 「課題」と「小テスト」の切り替え
  function sectionTabs(active) {
    return h('div', { class: 'seg', style: { width: '100%', marginBottom: '12px' } },
      h('button', { class: active === 'tasks' ? 'on' : '', style: { flex: 1 }, onclick: () => { location.hash = ''; } }, '課題'),
      h('button', { class: active === 'quizzes' ? 'on' : '', style: { flex: 1 }, onclick: () => { location.hash = '#/quizzes'; } }, '小テスト'));
  }

  // ---------- 小テストの履歴（自分の得点だけ） ----------

  function showQuizzes() {
    closeTask();
    const list = store.myQuizzes();
    const taken = list.filter((q) => q.score !== null);
    const rate = (q) => (q.score / q.maxScore) * 100;
    const avgRate = taken.length ? taken.reduce((a, q) => a + rate(q), 0) / taken.length : null;
    const round1 = (x) => Math.round(x * 10) / 10;
    fill(view,
      sectionTabs('quizzes'),
      h('h1', {}, '小テストの記録'),
      taken.length ? h('div', { class: 'card row', style: { gap: '24px', marginBottom: '12px' } },
        h('div', {}, h('div', { class: 'muted small' }, '受けた回数'), h('div', { style: { fontSize: '1.4rem', fontWeight: 700 } }, `${taken.length}回`)),
        h('div', {}, h('div', { class: 'muted small' }, '平均の得点率'), h('div', { style: { fontSize: '1.4rem', fontWeight: 700 } }, `${round1(avgRate)}%`))) : null,
      list.length
        ? h('div', {}, list.map((q) => h('div', { class: 'card' },
          h('div', { class: 'row between' },
            h('div', {}, h('strong', {}, q.title), h('div', { class: 'muted small' }, q.date)),
            q.score === null
              ? h('span', { class: 'badge' }, '記録なし')
              : h('div', { style: { textAlign: 'right' } },
                h('span', { style: { fontSize: '1.4rem', fontWeight: 800 } }, q.score),
                h('span', { class: 'muted' }, ` / ${q.maxScore}点`))),
          q.score === null ? null : h('div', { class: 'meter', style: { height: '8px', marginTop: '8px' } },
            h('i', { style: { width: `${Math.min(100, rate(q))}%`, background: rate(q) >= 80 ? 'var(--good)' : rate(q) >= 50 ? 'var(--accent)' : 'var(--warn)' } })))))
        : h('div', { class: 'card muted' }, 'まだ小テストの記録はありません。先生が得点を公開すると、ここに表示されます。'));
  }

  // ホーム画面にまだ追加していない人への案内（「あとで」を押したら7日間は出さない）
  function installBanner() {
    if (MB.install.standalone()) return null;
    try {
      if (Date.now() - Number(localStorage.getItem('mb-install-later') || 0) < 7 * 864e5) return null;
    } catch { /* 無視 */ }
    const box = h('div', { class: 'card row', style: { marginBottom: '12px', background: 'var(--accent-soft)', borderColor: 'var(--accent)' } },
      h('span', { class: 'grow', style: { minWidth: '180px' } }, '📲 ホーム画面に追加すると、アプリのようにすぐ開けます'),
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        h('button', { class: 'small primary', onclick: () => MB.install.prompt() }, '追加する'),
        h('button', { class: 'small', onclick: () => {
          try { localStorage.setItem('mb-install-later', String(Date.now())); } catch { /* 無視 */ }
          box.remove();
        } }, 'あとで')));
    return box;
  }

  // ---------- 課題の画面 ----------

  // 画面に必要なものを、store の最新の状態から組み立てる
  function taskData(taskId) {
    const t = store.state.tasks.get(taskId);
    if (!t) return null;
    const s = store.mySub(t);
    return {
      task: t,
      submission: store.submissionView(t, s),
      needsGroup: t.mode === 'group' && !store.ownerKey(t),
      help: store.state.help.get(taskId) || null,
      canSeePeers: store.canSeePeers(t),
    };
  }

  function closeTask() {
    if (current && current.offPeers) current.offPeers();
    current = null;
  }

  function openTask(taskId) {
    closeTask();
    const data = taskData(taskId);
    if (!data) {
      toast('課題が見つかりません');
      location.hash = '';
      return;
    }
    const s = data.submission;
    current = {
      taskId,
      data,
      dirty: false,
      baseVersion: s ? s.version : undefined,
      form: {
        shortAnswer: s ? s.shortAnswer : loadDraft(taskId, 'short'),
        text: s ? s.text : loadDraft(taskId, 'text'),
        drawing: 'keep',
        photo: 'keep',
        confidence: s ? s.confidence : null,
      },
      els: {},
      peers: null,
    };
    // 下書きがあり、提出内容と違えば下書きを優先する
    const dText = loadDraft(taskId, 'text');
    if (s && dText && dText !== s.text) { current.form.text = dText; current.dirty = true; }
    renderTask();
    watchPeers();
  }

  function draftKey(taskId, field) {
    return `mb-draft:${store.state.sid}:${taskId}:${field}`;
  }
  function loadDraft(taskId, field) {
    try { return localStorage.getItem(draftKey(taskId, field)) || ''; } catch { return ''; }
  }
  function saveDraft(field, value) {
    try { localStorage.setItem(draftKey(current.taskId, field), value); } catch { /* 保存できなくても続ける */ }
  }
  function clearDrafts(taskId) {
    try {
      localStorage.removeItem(draftKey(taskId, 'text'));
      localStorage.removeItem(draftKey(taskId, 'short'));
    } catch { /* 無視 */ }
  }

  function renderTask() {
    const { data } = current;
    const t = data.task;
    const header = h('div', { class: 'card' },
      h('div', { class: 'row', style: { marginBottom: '6px' } },
        t.mode === 'group' ? h('span', { class: 'badge group' }, 'グループで1つ提出') : h('span', { class: 'badge' }, '個人'),
        t.status === 'closed' ? h('span', { class: 'badge closed' }, '締め切り') : null),
      h('h1', {}, t.title),
      rich(t.body),
      t.imageV ? img(store.taskImage(t), { class: 'task-image', alt: '問題の図' }) : null,
      t.hint ? h('div', { class: 'hint' }, h('strong', {}, 'ヒント'), rich(t.hint)) : null);

    current.els.status = h('div');
    current.els.form = h('div');
    current.els.peers = h('div');
    current.els.help = h('div');

    fill(view,
      h('button', { class: 'small', style: { marginBottom: '12px' }, onclick: () => { location.hash = ''; } }, '← 課題一覧'),
      header,
      current.els.status,
      current.els.form,
      current.els.help,
      current.els.peers);
    renderStatus();
    renderForm();
    renderHelp();
    renderPeers();
  }

  function renderStatus() {
    const { data } = current;
    const s = data.submission;
    const el = current.els.status;
    fill(el);
    if (data.needsGroup) {
      el.append(h('div', { class: 'card' }, h('div', { class: 'result-box retry' }, 'グループが決まっていません。先生に伝えてください。')));
      return;
    }
    if (!s) return;
    const box = {
      cleared: () => h('div', { class: 'result-box cleared' }, '✓ クリア！'),
      retry: () => h('div', { class: 'result-box retry' }, 'もう一度考えて、再提出してください'),
      wrong: () => h('div', { class: 'result-box wrong' }, '不正解… もう一度考えてみよう'),
      pending: () => h('div', { class: 'result-box pending' }, '提出しました。判定を待っています…'),
      submitted: () => h('div', { class: 'result-box submitted' }, '提出しました'),
    }[s.status]();
    el.append(h('div', { class: 'card stack' },
      box,
      s.feedback ? h('div', { class: 'feedback' }, h('strong', {}, '先生から'), rich(s.feedback)) : null,
      h('div', { class: 'muted small' },
        `提出 ${s.attempts} 回目・${MB.timeAgo(s.updatedAt)}`,
        data.task.mode === 'group' && s.lastEditorName ? `（最後に提出：${s.lastEditorName}）` : '')));
  }

  // 記号ボタン。open=false のときは「記号」ボタンを押すと開く
  function symbolBar(target, onInput, open = true) {
    const bar = h('div', { class: `symbols${open ? '' : ' hidden'}` }, SYMBOLS.map((sym) => h('button', {
      type: 'button',
      onclick: () => {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        target.value = target.value.slice(0, start) + sym + target.value.slice(end);
        target.focus();
        target.setSelectionRange(start + sym.length, start + sym.length);
        onInput();
      },
    }, sym)));
    if (open) return bar;
    const toggle = h('button', {
      type: 'button',
      class: 'small',
      style: { marginTop: '6px' },
      onclick: () => {
        bar.classList.toggle('hidden');
        toggle.textContent = bar.classList.contains('hidden') ? '√ 記号を入力 ▾' : '記号を閉じる ▴';
      },
    }, '√ 記号を入力 ▾');
    return h('div', {}, toggle, bar);
  }

  function renderForm() {
    const { data, form } = current;
    const t = data.task;
    const s = data.submission;
    const el = current.els.form;
    fill(el);
    if (data.needsGroup) return;

    if (t.status !== 'open') {
      if (s) el.append(h('div', { class: 'card stack' }, h('h2', {}, t.mode === 'group' ? 'グループの回答' : '自分の回答'), answerView(s)));
      else el.append(h('div', { class: 'card muted' }, 'この課題は締め切られました。'));
      return;
    }

    const markDirty = () => { current.dirty = true; };
    const parts = [];

    if (t.answerKind === 'short') {
      const input = h('input', {
        type: 'text',
        value: form.shortAnswer,
        placeholder: '例：2√3',
        autocomplete: 'off',
        oninput: () => { form.shortAnswer = input.value; saveDraft('short', input.value); markDirty(); },
      });
      parts.push(h('div', { class: 'field' },
        h('label', {}, '答え'),
        input,
        symbolBar(input, () => { form.shortAnswer = input.value; saveDraft('short', input.value); markDirty(); })));
    }

    if (t.allowText) {
      const preview = h('div', { class: 'preview hidden' });
      const updatePreview = debounce(() => {
        const has = /\$|\\\(|\\\[/.test(form.text);
        preview.classList.toggle('hidden', !has);
        if (has) fill(preview, rich(form.text));
      }, 300);
      const ta = h('textarea', {
        placeholder: t.answerKind === 'short' ? '考え方（任意）' : '考えや理由を書こう',
        oninput: () => { form.text = ta.value; saveDraft('text', ta.value); markDirty(); updatePreview(); },
      });
      ta.value = form.text;
      updatePreview();
      parts.push(h('div', { class: 'field' },
        h('label', {}, t.answerKind === 'short' ? '考え方' : '自分の考え',
          h('div', { class: 'help' }, '$x^2$ のように $ で囲むと数式になります')),
        ta,
        symbolBar(ta, () => { form.text = ta.value; saveDraft('text', ta.value); markDirty(); updatePreview(); }, t.answerKind !== 'short'),
        preview));
    }

    if (t.allowDraw) {
      const thumbBox = h('div');
      const currentDrawing = () => (form.drawing === 'keep' ? s && s.drawing : form.drawing || null);
      const paint = () => {
        const src = currentDrawing();
        fill(thumbBox, src
          ? img(src, { class: 'draw-thumb', alt: '手書きの回答', onclick: openPad })
          : h('button', { type: 'button', class: 'draw-empty', onclick: openPad }, 'タップして手書きで書く'));
      };
      async function openPad() {
        const src = currentDrawing();
        const initial = src && typeof src === 'object' ? await window.Store.loadImage(src) : src;
        const result = await MB.openDrawPad({ initial });
        if (result === null) return;
        form.drawing = result;
        markDirty();
        paint();
      }
      paint();
      parts.push(h('div', { class: 'field' },
        h('label', {}, '手書き（図・式）'),
        thumbBox,
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', { type: 'button', class: 'small', onclick: openPad }, '✎ 手書きを開く'),
          h('button', { type: 'button', class: 'small danger', onclick: () => { form.drawing = ''; markDirty(); paint(); } }, '消す'))));
    }

    if (t.allowPhoto) {
      const box = h('div');
      const fileInput = h('input', {
        type: 'file',
        accept: 'image/*',
        class: 'hidden',
        onchange: async () => {
          const file = fileInput.files[0];
          if (!file) return;
          try {
            form.photo = await compressImage(file);
            markDirty();
            paint();
          } catch (err) {
            toast(err.message);
          }
          fileInput.value = '';
        },
      });
      const paint = () => {
        const src = form.photo === 'keep' ? s && s.photo : form.photo || null;
        fill(box, src ? img(src, { class: 'answer-image', alt: '提出する写真', style: { maxHeight: '240px' } }) : null);
      };
      paint();
      parts.push(h('div', { class: 'field' },
        h('label', {}, 'ノートの写真'),
        fileInput,
        box,
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', { type: 'button', class: 'small', onclick: () => fileInput.click() }, '📷 写真を選ぶ'),
          h('button', { type: 'button', class: 'small danger', onclick: () => { form.photo = ''; markDirty(); paint(); } }, '消す'))));
    }

    const conf = h('div', { class: 'confidence' }, CONFIDENCE.map(([n, label]) => h('button', {
      type: 'button',
      class: form.confidence === n ? 'on' : '',
      onclick: (e) => {
        form.confidence = form.confidence === n ? null : n;
        [...conf.children].forEach((b, i) => b.classList.toggle('on', form.confidence === CONFIDENCE[i][0]));
        markDirty();
        e.preventDefault();
      },
    }, h('span', { class: 'n' }, n), label)));
    parts.push(h('div', { class: 'field' }, h('label', {}, '自信はどのくらい？'), conf));

    const error = h('div', { class: 'error', role: 'alert' });
    const submitBtn = h('button', { class: 'primary block', type: 'button', onclick: submit }, s ? '書き直して再提出' : '提出する');
    async function submit() {
      error.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = '送信中…';
      try {
        const sub = await store.submit(current.taskId, form, current.baseVersion);
        clearDrafts(current.taskId);
        current.dirty = false;
        current.data.submission = sub;
        current.baseVersion = sub.version;
        form.drawing = 'keep';
        form.photo = 'keep';
        toast('提出しました');
        renderStatus();
        renderForm();
        renderHelp();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        error.textContent = err.message;
        if (err.status === 409) current.els.notice = showReloadNotice();
        submitBtn.disabled = false;
        submitBtn.textContent = s ? '書き直して再提出' : '提出する';
      }
    }

    el.append(h('div', { class: 'card' },
      h('h2', {}, t.mode === 'group' ? 'グループの回答' : '回答'),
      t.mode === 'group' ? h('p', { class: 'muted small' }, 'グループの誰が提出しても、グループ全員の回答になります。') : null,
      ...parts,
      error,
      submitBtn));
  }

  function showReloadNotice() {
    const box = h('div', { class: 'card', style: { borderColor: 'var(--warn)' } },
      h('p', { style: { marginTop: 0 } }, 'グループの人が回答を更新しました。'),
      h('button', {
        class: 'small primary',
        onclick: () => { current.dirty = false; clearDrafts(current.taskId); openTask(current.taskId); },
      }, '最新の回答を読み込む'));
    current.els.form.prepend(box);
    return box;
  }

  function answerView(s) {
    return h('div', { class: 'stack' },
      s.shortAnswer ? h('div', { style: { fontSize: '1.2rem', fontWeight: 700 } }, s.shortAnswer) : null,
      s.text ? rich(s.text) : null,
      s.drawing ? img(s.drawing, { class: 'answer-image', alt: '手書き' }) : null,
      s.photo ? img(s.photo, { class: 'answer-image', alt: '写真' }) : null);
  }

  function renderHelp() {
    const { data } = current;
    const el = current.els.help;
    fill(el);
    if (data.task.status !== 'open' || (data.submission && data.submission.status === 'cleared')) return;
    if (data.help) {
      el.append(h('div', { class: 'card row between' },
        h('span', {}, '🙋 先生に助けを求めています', data.help.message ? `：「${data.help.message}」` : ''),
        h('button', { class: 'small', onclick: () => store.clearHelp(current.taskId).catch((e) => toast(e.message)) }, '取り消す')));
    } else {
      el.append(h('div', { style: { margin: '12px 0' } }, h('button', {
        class: 'block',
        onclick: async () => {
          const msg = window.prompt('どこがわからない？（空のままでもOK）', '');
          if (msg === null) return;
          try {
            await store.setHelp(current.taskId, msg);
            toast('先生に伝えました');
          } catch (e) {
            toast(e.message);
          }
        },
      }, '🙋 わからない・先生を呼ぶ')));
    }
  }

  // みんなの考え：見てよい間だけ受け取る
  function watchPeers() {
    const allowed = current.data.canSeePeers;
    if (allowed && !current.offPeers) {
      current.offPeers = store.watchPeers(current.taskId, (list) => {
        if (!current) return;
        current.peers = list;
        renderPeers();
      });
    } else if (!allowed && current.offPeers) {
      current.offPeers();
      current.offPeers = null;
      current.peers = null;
    }
    renderPeers();
  }

  function renderPeers() {
    const el = current.els.peers;
    const t = current.data.task;
    if (!current.data.canSeePeers || !current.peers) {
      fill(el, t.peerView === 'after_submit' && !current.data.submission
        ? h('p', { class: 'muted small', style: { textAlign: 'center' } }, '提出すると、みんなの考え（匿名）を見られます')
        : null);
      return;
    }
    const peers = current.peers;
    fill(el, h('div', { class: 'card' },
      h('h2', {}, `みんなの考え（${peers.length}件・匿名）`),
      peers.length ? null : h('p', { class: 'muted' }, 'まだありません'),
      peers.map((p) => h('div', { class: 'card', style: { boxShadow: 'none', background: p.mine ? 'var(--accent-soft)' : '' } },
        h('div', { class: 'row between' },
          h('strong', {}, p.mine ? `${p.label}（あなた${t.mode === 'group' ? 'のグループ' : ''}）` : p.label),
          p.mine
            ? h('span', { class: 'muted small' }, `♥ ${p.likes}`)
            : h('button', {
              class: `small${p.liked ? ' primary' : ''}`,
              'aria-pressed': p.liked ? 'true' : 'false',
              onclick: () => store.toggleLike(current.taskId, p.id, p.liked).catch((e) => toast(e.message)),
            }, `♥ 参考になった ${p.likes}`)),
        answerView(p)))));
  }

  // ---------- タイマー ----------

  // 先生がタイマー・ストップウォッチを動かしている間、画面の上に出す
  function startTimerBar() {
    const text = h('span', { class: 't' });
    const label = h('span', { class: 'small' });
    const bar = h('div', { class: 'timer-bar hidden', role: 'timer', 'aria-live': 'off' }, '⏱', label, text);
    $('.topbar').after(bar);
    let wasDone = false;
    MB.onTick(() => {
      const info = MB.timerInfo(store.state.timer);
      bar.classList.toggle('hidden', !info);
      if (!info) { wasDone = false; return; }
      text.textContent = info.done ? '時間です' : info.text;
      label.textContent = info.paused ? `${info.label || ''}（一時停止）` : info.label || (info.kind === 'timer' ? '残り' : '経過');
      bar.classList.toggle('paused', info.paused);
      bar.classList.toggle('done', info.done);
      if (info.done && !wasDone && navigator.vibrate) navigator.vibrate([200, 100, 200]);
      wasDone = info.done;
    });
  }

  // ---------- メニュー ----------

  // ---------- クラス ----------

  const classKey = () => `mb-class-s:${who.sid}`;

  function chooseClass(id) {
    try { localStorage.setItem(classKey(), id); } catch { /* 無視 */ }
    location.hash = '';
    location.reload();
  }

  // 参加コードで別のクラスに入る
  function joinForm(onDone) {
    const code = h('input', { type: 'text', placeholder: '先生が見せている6文字', autocapitalize: 'characters', autocomplete: 'off' });
    const number = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 4000, placeholder: '出席番号（任意）' });
    const error = h('div', { class: 'error' });
    return h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', {}, '参加コード'), code),
      h('div', { class: 'field' }, h('label', {}, '出席番号', h('div', { class: 'help' }, 'このクラスの先生だけが見ます')), number),
      error,
      h('button', { class: 'primary block', onclick: async (e) => {
        error.textContent = '';
        e.currentTarget.disabled = true;
        try {
          const id = await window.Store.joinClass(who, { joinCode: code.value, number: number.value });
          if (onDone) onDone();
          chooseClass(id);
        } catch (err) {
          error.textContent = err.message;
          e.target.disabled = false;
        }
      } }, 'クラスに参加する'));
  }

  $('#menu-btn').addEventListener('click', () => {
    if (!store) {
      const m0 = modal(h('div', { class: 'stack' },
        h('h2', {}, 'メニュー'),
        h('button', { class: 'danger', onclick: MB.logout }, 'ログアウト'),
        h('button', { onclick: () => m0.close() }, '閉じる')));
      return;
    }
    const me = store.state.me;
    const nameInput = h('input', { type: 'text', value: me.name, maxlength: 20 });
    const cur = h('input', { type: 'password', autocomplete: 'current-password', placeholder: '今のパスワード' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', placeholder: '新しいパスワード（6文字以上）' });
    const error = h('div', { class: 'error' });
    const m = modal(h('div', { class: 'stack' },
      h('h2', {}, 'メニュー'),
      h('p', { class: 'muted small', style: { margin: 0 } }, `ログイン中：${me.name}${store.state.group ? `（${store.state.group.name}）` : ''}`),
      h('div', { class: 'field' }, h('label', {}, '表示名を変える', h('div', { class: 'help' }, '次からはこの名前でログインします')),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, nameInput),
          h('button', { onclick: async () => {
            error.textContent = '';
            try {
              await store.changeName(nameInput.value);
              toast('名前を変えました');
            } catch (e) { error.textContent = e.message; }
          } }, '変更'))),
      h('div', { class: 'field' }, h('label', {}, 'パスワードを変える'),
        h('div', { class: 'stack' }, cur, next),
        h('button', { style: { marginTop: '8px' }, onclick: async () => {
          error.textContent = '';
          try {
            await window.Store.changePassword(cur.value, next.value);
            toast('パスワードを変えました');
            cur.value = '';
            next.value = '';
          } catch (e) { error.textContent = e.message; }
        } }, '変更')),
      h('div', { class: 'field' }, h('label', {}, 'クラス'),
        h('div', { class: 'stack' },
          classes.map((c) => h('button', {
            class: `block${c.id === store.state.classId ? ' primary' : ''}`,
            onclick: () => (c.id === store.state.classId ? m.close() : chooseClass(c.id)),
          }, c.id === store.state.classId ? `${c.name}（いまのクラス）` : `${c.name} に切り替える`)),
          h('details', {}, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '＋ 別のクラスに参加する'), joinForm(() => m.close())))),
      MB.install.standalone() ? null : h('button', { onclick: () => { m.close(); MB.install.prompt(); } }, '📲 ホーム画面に追加'),
      error,
      h('div', { class: 'row between' },
        h('button', { class: 'danger', onclick: MB.logout }, 'ログアウト'),
        h('button', { onclick: () => m.close() }, '閉じる'))));
  });

  // ---------- リアルタイム更新 ----------

  function onChange(types) {
    if (types.has('denied') && !store.state.me) {
      MB.logout();
      return;
    }
    $('#class-name').textContent = store.state.className;
    if (!current) {
      if (location.hash === '#/quizzes') showQuizzes();
      else if (!/^#\/task\//.test(location.hash)) showList();
      return;
    }
    const data = taskData(current.taskId);
    if (!data) {
      current.dirty = false;
      location.hash = '';
      return;
    }
    const prev = current.data;
    current.data = data;
    const taskChanged = JSON.stringify(prev.task) !== JSON.stringify(data.task) || prev.needsGroup !== data.needsGroup;
    const prevV = prev.submission ? prev.submission.version : 0;
    const newVersion = data.submission && data.submission.version !== prevV && data.submission.version !== current.baseVersion;
    // 入力中の内容は current.form に残っているので、描き直しても消えない
    let formChanged = false;
    if (newVersion && !current.dirty) {
      current.baseVersion = data.submission.version;
      current.form.shortAnswer = data.submission.shortAnswer;
      current.form.text = data.submission.text;
      current.form.drawing = 'keep';
      current.form.photo = 'keep';
      formChanged = true;
    }
    if (taskChanged) {
      renderTask();
    } else {
      renderStatus();
      renderHelp();
      if (formChanged) renderForm();
    }
    if (newVersion && current.dirty && (!current.els.notice || !current.els.notice.isConnected)) {
      current.els.notice = showReloadNotice();
    }
    watchPeers();
  }

  (async () => {
    who = await window.Store.whoami();
    if (who.role !== 'student') {
      location.href = who.role === 'teacher' ? '/teacher' : '/';
      return;
    }
    try {
      classes = await window.Store.studentClasses(who.classIds);
    } catch (e) {
      fill(view, h('div', { class: 'card error' }, `クラスを読み込めませんでした：${e.message}`));
      return;
    }
    if (!classes.length) {
      fill(view, h('div', { class: 'card' }, h('h2', {}, 'クラスに参加する'),
        h('p', { class: 'muted small' }, '今は、どのクラスにも入っていません。先生から参加コードを聞いて入力してください。'), joinForm()));
      return;
    }
    let saved = null;
    try { saved = localStorage.getItem(classKey()); } catch { /* 無視 */ }
    const current = classes.find((c) => c.id === saved) || classes[0];
    store = window.Store.studentStore(who, current.id);
    // 2つ以上のクラスに入っているときは、上にクラス名と切り替えボタンを出す
    if (classes.length > 1) $('#class-name').after(h('button', { class: 'small', onclick: () => $('#menu-btn').click() }, '切替'));
    startTimerBar();
    fill(view, h('p', { class: 'muted' }, '読み込み中…'));
    let started = false;
    store.on((types) => {
      MB.showErrors(store.state.errors);
      if (!store.state.ready) return;
      if (types.size === 1 && types.has('timer')) return;
      document.title = `${store.state.className} - 数学ボード`;
      $('#live').classList.add('on');
      if (!started) {
        started = true;
        $('#class-name').textContent = store.state.className;
        route();
        return;
      }
      onChange(types);
    });
    window.addEventListener('offline', () => $('#live').classList.remove('on'));
    window.addEventListener('online', () => $('#live').classList.add('on'));
  })();
})();
