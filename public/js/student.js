(function () {
  const { api, h, $, toast, rich, fileUrl, modal, compressImage, listen, debounce, statusBadge } = MB;
  const view = $('#view');
  let me = null;
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
    const m = /^#\/task\/(\d+)/.exec(location.hash);
    if (m) openTask(Number(m[1]));
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

  async function showList() {
    current = null;
    const tasks = await api('GET', '/api/student/tasks');
    const groupLine = me.group
      ? h('p', { class: 'muted small' }, `グループ：${me.group.name}（${me.group.members.join('、')}）`)
      : null;
    const items = tasks.map((t) => h('button', {
      class: 'card task-item',
      onclick: () => { location.hash = `#/task/${t.id}`; },
    },
    h('div', { class: 't' },
      h('strong', {}, t.title),
      h('div', { class: 'row', style: { marginTop: '4px' } },
        t.mode === 'group' ? h('span', { class: 'badge group' }, 'グループ') : h('span', { class: 'badge' }, '個人'),
        t.status === 'closed' ? h('span', { class: 'badge closed' }, '締切') : null,
        t.hasFeedback ? h('span', { class: 'badge submitted' }, 'コメントあり') : null)),
    statusBadge(t.myStatus || 'none')));
    const cleared = tasks.filter((t) => t.myStatus === 'cleared').length;
    MB.fill(view, 
      h('div', { class: 'row between', style: { marginBottom: '8px' } },
        h('h1', { style: { margin: 0 } }, '課題'),
        tasks.length ? h('span', { class: 'muted small' }, `クリア ${cleared} / ${tasks.length}`) : null),
      groupLine,
      tasks.length ? h('div', {}, items) : h('div', { class: 'card muted' }, 'まだ課題はありません。先生が課題を出すと、ここに表示されます。'),
    );
  }

  // ---------- 課題の画面 ----------

  async function openTask(taskId) {
    const data = await api('GET', `/api/student/tasks/${taskId}`).catch((err) => {
      toast(err.message);
      location.hash = '';
      return null;
    });
    if (!data) return;
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
    };
    // 下書きがあり、提出内容と違えば下書きを優先する
    const dText = loadDraft(taskId, 'text');
    if (s && dText && dText !== s.text) { current.form.text = dText; current.dirty = true; }
    renderTask();
    loadPeers();
  }

  function draftKey(taskId, field) {
    return `mb-draft:${me.id}:${taskId}:${field}`;
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
      t.image ? h('img', { class: 'task-image', src: fileUrl(t.image), alt: '問題の図' }) : null,
      t.hint ? h('div', { class: 'hint' }, h('strong', {}, 'ヒント'), rich(t.hint)) : null);

    current.els.status = h('div');
    current.els.form = h('div');
    current.els.peers = h('div');
    current.els.help = h('div');

    MB.fill(view, 
      h('button', { class: 'small', style: { marginBottom: '12px' }, onclick: () => { location.hash = ''; } }, '← 課題一覧'),
      header,
      current.els.status,
      current.els.form,
      current.els.help,
      current.els.peers,
    );
    renderStatus();
    renderForm();
    renderHelp();
  }

  function renderStatus() {
    const { data } = current;
    const s = data.submission;
    const el = current.els.status;
    MB.fill(el);
    if (data.needsGroup) {
      el.append(h('div', { class: 'card' }, h('div', { class: 'result-box retry' }, 'グループが決まっていません。先生に伝えてください。')));
      return;
    }
    if (!s) return;
    let box;
    if (s.status === 'cleared') box = h('div', { class: 'result-box cleared' }, '✓ クリア！');
    else if (s.status === 'retry') box = h('div', { class: 'result-box retry' }, 'もう一度考えて、再提出してください');
    else if (s.autoCorrect === 0) box = h('div', { class: 'result-box wrong' }, '不正解… もう一度考えてみよう');
    else box = h('div', { class: 'result-box submitted' }, '提出しました');
    el.append(h('div', { class: 'card stack' },
      box,
      s.feedback ? h('div', { class: 'feedback' }, h('strong', {}, '先生から'), rich(s.feedback)) : null,
      h('div', { class: 'muted small' },
        `提出 ${s.attempts} 回目・${MB.timeAgo(s.updatedAt)}`,
        data.task.mode === 'group' && s.lastEditor ? `（最後に提出：${s.lastEditor}）` : '')));
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
    MB.fill(el);
    if (data.needsGroup) return;
    const closed = t.status !== 'open';

    if (closed) {
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
        symbolBar(input, () => { form.shortAnswer = input.value; markDirty(); })));
    }

    if (t.allowText) {
      const preview = h('div', { class: 'preview hidden' });
      const updatePreview = debounce(() => {
        const has = /\$|\\\(|\\\[/.test(form.text);
        preview.classList.toggle('hidden', !has);
        if (has) MB.fill(preview, rich(form.text));
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
      const currentDrawing = () => (form.drawing === 'keep' ? fileUrl(s && s.drawing) : form.drawing || null);
      const paint = () => {
        const src = currentDrawing();
        MB.fill(thumbBox, src
          ? h('img', { class: 'draw-thumb', src, alt: '手書きの回答', onclick: openPad })
          : h('button', { type: 'button', class: 'draw-empty', onclick: openPad }, 'タップして手書きで書く'));
      };
      async function openPad() {
        const result = await MB.openDrawPad({ initial: currentDrawing() });
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
        const src = form.photo === 'keep' ? fileUrl(s && s.photo) : form.photo || null;
        MB.fill(box, ...(src ? [h('img', { class: 'answer-image', src, alt: '提出する写真', style: { maxHeight: '240px' } })] : []));
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
      try {
        const r = await api('POST', `/api/student/tasks/${current.taskId}/submit`, {
          shortAnswer: form.shortAnswer,
          text: form.text,
          drawing: form.drawing,
          photo: form.photo,
          confidence: form.confidence,
          baseVersion: current.baseVersion,
        });
        clearDrafts(current.taskId);
        current.dirty = false;
        current.data.submission = r.submission;
        current.baseVersion = r.submission.version;
        form.drawing = 'keep';
        form.photo = 'keep';
        const sub = r.submission;
        toast(sub.status === 'cleared' ? 'クリア！' : sub.autoCorrect === 0 ? '不正解… もう一度！' : '提出しました');
        renderStatus();
        renderForm();
        renderHelp();
        loadPeers();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        error.textContent = err.message;
        if (err.status === 409) current.els.notice = showReloadNotice();
      } finally {
        submitBtn.disabled = false;
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
        onclick: () => { current.dirty = false; openTask(current.taskId); },
      }, '最新の回答を読み込む'));
    current.els.form.prepend(box);
    return box;
  }

  function answerView(s) {
    return h('div', { class: 'stack' },
      s.shortAnswer ? h('div', { class: 'short', style: { fontSize: '1.2rem', fontWeight: 700 } }, s.shortAnswer) : null,
      s.text ? rich(s.text) : null,
      s.drawing ? h('img', { class: 'answer-image', src: fileUrl(s.drawing), alt: '手書き' }) : null,
      s.photo ? h('img', { class: 'answer-image', src: fileUrl(s.photo), alt: '写真' }) : null);
  }

  function renderHelp() {
    const { data } = current;
    const el = current.els.help;
    MB.fill(el);
    if (data.task.status !== 'open' || (data.submission && data.submission.status === 'cleared')) return;
    if (data.help) {
      el.append(h('div', { class: 'card row between' },
        h('span', {}, '🙋 先生に助けを求めています', data.help.message ? `：「${data.help.message}」` : ''),
        h('button', { class: 'small', onclick: async () => {
          await api('DELETE', `/api/student/tasks/${current.taskId}/help`);
          data.help = null;
          renderHelp();
        } }, '取り消す')));
    } else {
      el.append(h('div', { style: { margin: '12px 0' } }, h('button', {
        class: 'block',
        onclick: async () => {
          const message = window.prompt('どこがわからない？（空のままでもOK）', '');
          if (message === null) return;
          await api('POST', `/api/student/tasks/${current.taskId}/help`, { message });
          data.help = { message };
          toast('先生に伝えました');
          renderHelp();
        },
      }, '🙋 わからない・先生を呼ぶ')));
    }
  }

  async function loadPeers() {
    if (!current) return;
    const el = current.els.peers;
    const t = current.data.task;
    if (!current.data.canSeePeers) {
      MB.fill(el, t.peerView === 'after_submit'
        ? h('p', { class: 'muted small', style: { textAlign: 'center' } }, '提出すると、みんなの考え（匿名）を見られます')
        : '');
      return;
    }
    let peers;
    try {
      peers = await api('GET', `/api/student/tasks/${current.taskId}/peers`);
    } catch {
      MB.fill(el);
      return;
    }
    MB.fill(el, h('div', { class: 'card' },
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
              onclick: async () => {
                await api('POST', `/api/student/submissions/${p.id}/like`);
                loadPeers();
              },
            }, `♥ 参考になった ${p.likes}`)),
        answerView(p)))));
  }

  // ---------- メニュー ----------

  $('#menu-btn').addEventListener('click', () => {
    const nameInput = h('input', { type: 'text', value: me.name, maxlength: 20 });
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', autocomplete: 'new-password' });
    const error = h('div', { class: 'error' });
    const m = modal(h('div', { class: 'stack' },
      h('h2', {}, 'メニュー'),
      h('p', { class: 'muted small', style: { margin: 0 } }, `ログイン中：${me.name}${me.group ? `（${me.group.name}）` : ''}`),
      h('div', { class: 'field' }, h('label', {}, '表示名を変える'), h('div', { class: 'row' }, h('div', { class: 'grow' }, nameInput),
        h('button', { onclick: async () => {
          try {
            await api('POST', '/api/me/name', { name: nameInput.value });
            me.name = nameInput.value.trim();
            toast('名前を変えました（次からこの名前でログイン）');
          } catch (e) { error.textContent = e.message; }
        } }, '変更'))),
      h('div', { class: 'field' }, h('label', {}, 'パスワードを変える'),
        h('div', { class: 'stack' }, cur, next),
        h('button', { style: { marginTop: '8px' }, onclick: async () => {
          try {
            await api('POST', '/api/me/password', { current: cur.value, next: next.value });
            toast('パスワードを変えました');
            cur.value = '';
            next.value = '';
          } catch (e) { error.textContent = e.message; }
        } }, '変更')),
      error,
      h('div', { class: 'row between' },
        h('button', { class: 'danger', onclick: MB.logout }, 'ログアウト'),
        h('button', { onclick: () => m.close() }, '閉じる'))));
    cur.placeholder = '今のパスワード';
    next.placeholder = '新しいパスワード（4文字以上）';
  });

  // ---------- リアルタイム更新 ----------

  // 通知は短い間にまとめて届くので、溜めてから1回だけ取り直す
  const pending = { taskIds: new Set(), any: false };

  const refresh = debounce(async () => {
    const touched = new Set(pending.taskIds);
    const any = pending.any;
    pending.taskIds.clear();
    pending.any = false;
    if (!current) return showList();
    const id = current.taskId;
    if (!any && !touched.has(id)) return;
    let data;
    try {
      data = await api('GET', `/api/student/tasks/${id}`);
    } catch {
      location.hash = '';
      return;
    }
    if (!current || current.taskId !== id) return;
    const prev = current.data;
    current.data = data;
    const taskChanged = JSON.stringify(prev.task) !== JSON.stringify(data.task) || prev.needsGroup !== data.needsGroup;
    const newVersion = data.submission && (!prev.submission || data.submission.version !== prev.submission.version);
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
    loadPeers();
  }, 400);

  function onChange(e) {
    if (e.taskId) pending.taskIds.add(e.taskId);
    else pending.any = true;
    refresh();
  }

  (async () => {
    try {
      me = await api('GET', '/api/me');
    } catch {
      location.href = '/';
      return;
    }
    if (me.role !== 'student') {
      location.href = '/teacher';
      return;
    }
    $('#class-name').textContent = me.className;
    document.title = `${me.className} - 数学ボード`;
    listen(async (e) => {
      if (e.type === 'students' || e.type === 'resume') me = await api('GET', '/api/me');
      onChange(e);
    }, (on) => $('#live').classList.toggle('on', on));
    route();
  })();
})();
