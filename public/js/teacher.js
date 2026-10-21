(function () {
  const { h, fill, $, toast, rich, img, modal, compressImage, debounce, statusBadge, STATUS_LABEL } = MB;
  const view = $('#view');
  const tabsEl = $('#tabs');
  let store = null;

  const ui = {
    tab: 'progress',
    answersTaskId: null,
    answersFilter: 'all',
    answersSort: 'time',
    boardSort: 'number',
    showClosed: true,
  };

  const TABS = [
    ['progress', '進捗'],
    ['answers', '回答'],
    ['tasks', '課題'],
    ['students', '生徒・グループ'],
    ['settings', '設定'],
  ];

  const CONF_LABEL = { 1: 'わからない', 2: '少し不安', 3: 'だいたい', 4: '自信あり' };
  const PEER_LABEL = { off: '見せない', after_submit: '提出後に見せる', on: 'いつでも見せる' };

  // ボタンの処理で失敗したら画面下に出す
  const run = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message);
      return undefined;
    }
  };

  function renderTabs() {
    const helpCount = store.state.help.size;
    fill(tabsEl, ...TABS.map(([key, label]) => h('button', {
      class: ui.tab === key ? 'on' : '',
      onclick: () => {
        ui.tab = key;
        try { sessionStorage.setItem('mb-tab', key); } catch { /* 無視 */ }
        render();
      },
    }, label, key === 'progress' && helpCount ? h('span', { class: 'badge help' }, `🙋${helpCount}`) : null)));
  }

  function render() {
    renderTabs();
    ({ progress: renderProgress, answers: renderAnswers, tasks: renderTasks, students: renderStudents, settings: renderSettings })[ui.tab]();
  }

  const groupName = (id) => (store.state.groups.get(id) || {}).name || '';

  function submissionFor(task, student) {
    const key = task.mode === 'group' ? (student.groupId ? `g_${student.groupId}` : null) : `u_${student.id}`;
    return key ? store.state.subs.get(`tasks/${task.id}/subs/${key}`) || null : null;
  }

  // ---------- 進捗 ----------

  function renderProgress() {
    const { state } = store;
    const tasks = store.tasks().filter((t) => t.status !== 'draft' && (ui.showClosed || t.status === 'open'));
    const students = store.students();
    const groups = store.groups();
    if (ui.boardSort === 'group') {
      const order = new Map(groups.map((g, i) => [g.id, i]));
      students.sort((a, b) => (order.get(a.groupId) ?? 999) - (order.get(b.groupId) ?? 999) || (a.number ?? 999) - (b.number ?? 999));
    }
    const help = [...state.help.values()];
    const nameOf = (sid) => (state.students.get(sid) || {}).name || '?';

    const helpBox = help.length
      ? h('div', { class: 'card', style: { marginBottom: '12px' } },
        h('h3', {}, `🙋 ヘルプ（${help.length}人）`),
        h('div', { class: 'help-list' }, help.sort((a, b) => a.createdAt - b.createdAt).map((x) => h('span', { class: 'help-chip' },
          `${nameOf(x.studentId)}：${(state.tasks.get(x.taskId) || {}).title || ''}${x.message ? `「${x.message}」` : ''}`,
          h('button', { class: 'small', onclick: run(() => store.dismissHelp(x.taskId, x.studentId)) }, '対応済')))))
      : null;

    const head = h('tr', {}, h('th', {}, '名前'), tasks.map((t) => {
      const owners = t.mode === 'group' ? groups.length : students.length;
      const subs = [...state.subs.values()].filter((s) => s.taskId === t.id);
      const cleared = subs.filter((s) => s.status === 'cleared').length;
      const pct = (n) => (owners ? `${(n / owners) * 100}%` : '0');
      return h('th', { title: t.title },
        h('div', { class: 'tt' }, t.title),
        h('div', { class: 'row small muted', style: { gap: '4px', fontWeight: 400 } },
          t.mode === 'group' ? '班' : '個', t.status === 'closed' ? '・締切' : '', `・✓${cleared}/${owners}`),
        h('div', { class: 'meter' },
          h('i', { style: { width: pct(cleared), background: 'var(--good)' } }),
          h('i', { style: { width: pct(subs.length - cleared), background: 'var(--info)' } })));
    }));

    const body = students.map((st) => h('tr', {},
      h('th', {}, st.number ? h('span', { class: 'muted small' }, `${st.number} `) : null, st.name,
        st.groupId ? h('span', { class: 'muted small' }, ` ${groupName(st.groupId)}`) : null),
      tasks.map((t) => {
        const s = submissionFor(t, st);
        const key = s ? s.status : 'none';
        const hp = state.help.get(`${t.id}:${st.id}`);
        const label = { none: '—', pending: '…', submitted: '提出', cleared: '✓', retry: '再', wrong: '✗' }[key];
        const tip = [STATUS_LABEL[key], s && s.confidence ? `自信:${CONF_LABEL[s.confidence]}` : '', s ? `${s.attempts}回` : '', hp ? `ヘルプ${hp.message ? `「${hp.message}」` : ''}` : '']
          .filter(Boolean).join(' / ');
        return h('td', {}, h('button', {
          class: `cell-${key}${hp ? ' cell-help' : ''}`,
          title: tip,
          onclick: () => (s ? openSubmission(s.path) : toast(`${st.name}：まだ提出していません`)),
        }, label, s && s.confidence ? h('sup', { class: 'muted', style: { fontWeight: 400 } }, s.confidence) : null));
      })));

    const legend = h('div', { class: 'legend small' },
      h('span', { class: 'badge none' }, '— 未提出'),
      h('span', { class: 'badge submitted' }, '提出 提出済'),
      h('span', { class: 'badge wrong' }, '✗ 自動判定で不正解'),
      h('span', { class: 'badge retry' }, '再 再提出待ち'),
      h('span', { class: 'badge cleared' }, '✓ クリア'),
      h('span', { class: 'muted' }, '右上の数字＝自信（1 わからない〜4 自信あり）'));

    fill(view,
      helpBox,
      h('div', { class: 'row between', style: { marginBottom: '8px' } },
        h('div', { class: 'row' },
          h('div', { class: 'seg' },
            h('button', { class: ui.boardSort === 'number' ? 'on' : '', onclick: () => { ui.boardSort = 'number'; render(); } }, '出席番号順'),
            h('button', { class: ui.boardSort === 'group' ? 'on' : '', onclick: () => { ui.boardSort = 'group'; render(); } }, 'グループ順')),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.showClosed, onchange: (e) => { ui.showClosed = e.target.checked; render(); } }), '締切済みの課題も表示')),
        h('button', { class: 'small', onclick: downloadCsv }, 'CSVで保存')),
      tasks.length && students.length
        ? h('div', { class: 'board-wrap' }, h('table', { class: 'board' }, h('thead', {}, head), h('tbody', {}, body)))
        : h('div', { class: 'card muted' }, !students.length ? '生徒がまだ登録していません。「生徒・グループ」タブの参加コードを生徒に伝えてください。' : '公開中の課題がありません。「課題」タブで課題を作って公開してください。'),
      legend,
      h('p', { class: 'muted small' }, '短答の自動判定は、この先生の画面が開いている間に行われます。'));
  }

  function downloadCsv() {
    const tasks = store.tasks().filter((t) => t.status !== 'draft');
    const label = { pending: '判定待ち', submitted: '提出済', cleared: 'クリア', retry: '再提出', wrong: '不正解' };
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['出席番号', '名前', ...tasks.map((t) => t.title)].map(esc).join(',')];
    for (const st of store.students()) {
      const cells = tasks.map((t) => {
        const s = submissionFor(t, st);
        return s ? label[s.status] : '未提出';
      });
      lines.push([st.number ?? '', st.name, ...cells].map(esc).join(','));
    }
    const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `進捗_${new Date().toLocaleDateString('ja-JP').replace(/\//g, '-')}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------- 提出の詳細 ----------

  function openSubmission(path) {
    const raw = store.state.subs.get(path);
    if (!raw) return toast('提出が見つかりません');
    const s = store.submissionsOf(raw.taskId).find((x) => x.path === path);
    const t = store.state.tasks.get(s.taskId);
    const fb = h('textarea', { placeholder: '生徒へのコメント（生徒の画面に表示されます）' });
    fb.value = s.feedback || '';
    const save = run(async (status) => {
      await store.setSubmission(path, { status, feedback: fb.value });
      toast('保存しました');
      m.close();
    });
    const m = modal(h('div', { class: 'stack' },
      h('div', { class: 'row between' },
        h('h2', { style: { margin: 0 } }, s.ownerName),
        statusBadge(s.status)),
      h('div', { class: 'muted small' }, `${t ? t.title : ''}・提出 ${s.attempts} 回・${MB.timeAgo(s.updatedAt)}`,
        s.confidence ? `・自信：${CONF_LABEL[s.confidence]}` : '',
        s.ownerType === 'group' && s.lastEditorName ? `・最後に提出：${s.lastEditorName}` : '',
        s.likes ? `・♥${s.likes}` : ''),
      answerContent(s, true),
      h('div', { class: 'field' }, h('label', {}, 'コメント'), fb),
      h('div', { class: 'row' },
        h('button', { class: 'good', onclick: () => save('cleared') }, '✓ クリアにする'),
        h('button', { onclick: () => save('retry') }, '再提出を依頼'),
        h('button', { onclick: () => save('submitted') }, '提出済に戻す'),
        h('span', { class: 'grow' }),
        h('button', { onclick: () => m.close() }, '閉じる'))), { wide: true });
  }

  function answerContent(s, large) {
    const style = large ? {} : { maxHeight: '260px', objectFit: 'contain' };
    return h('div', { class: 'stack' },
      s.shortAnswer ? h('div', { class: 'short' }, '答え：', s.shortAnswer, s.autoCorrect === true ? ' ○' : s.autoCorrect === false ? ' ×' : '') : null,
      s.text ? rich(s.text) : null,
      s.drawing ? img(s.drawing, { class: 'answer-image', alt: '手書き', style }) : null,
      s.photo ? img(s.photo, { class: 'answer-image', alt: '写真', style }) : null);
  }

  // ---------- 回答 ----------

  function renderAnswers() {
    const usable = store.tasks().filter((t) => t.status !== 'draft');
    if (!usable.length) {
      fill(view, h('div', { class: 'card muted' }, '公開した課題がまだありません。'));
      return;
    }
    if (!usable.find((t) => t.id === ui.answersTaskId)) {
      const open = usable.filter((t) => t.status === 'open');
      ui.answersTaskId = (open[open.length - 1] || usable[usable.length - 1]).id;
    }
    const t = store.taskView(store.state.tasks.get(ui.answersTaskId));
    const subs = store.submissionsOf(t.id);
    const present = store.state.present;
    const selected = new Set(present.taskId === t.id ? present.submissionKeys : []);
    const toggleSelect = run(async (path) => {
      const keys = present.taskId === t.id ? [...present.submissionKeys] : [];
      const i = keys.indexOf(path);
      if (i >= 0) keys.splice(i, 1);
      else {
        if (keys.length >= 8) return toast('提示できるのは8件までです');
        keys.push(path);
      }
      await store.setPresent({ taskId: t.id, submissionKeys: keys });
      render();
    });

    const filters = {
      all: ['すべて', () => true],
      notCleared: ['未クリア', (s) => s.status !== 'cleared'],
      cleared: ['クリア', (s) => s.status === 'cleared'],
      retry: ['再提出待ち', (s) => s.status === 'retry'],
      lowConf: ['自信なし(1-2)', (s) => s.confidence && s.confidence <= 2],
    };
    let list = subs.filter(filters[ui.answersFilter][1]);
    if (ui.answersSort === 'likes') list = [...list].sort((a, b) => b.likes - a.likes);
    if (ui.answersSort === 'new') list = [...list].sort((a, b) => b.updatedAt - a.updatedAt);

    const submittedKeys = new Set(subs.map((s) => s.key));
    const missing = t.mode === 'group'
      ? store.groups().filter((g) => !submittedKeys.has(`g_${g.id}`)).map((g) => g.name)
      : store.students().filter((s) => !submittedKeys.has(`u_${s.id}`)).map((s) => s.name);

    const quick = (s, status) => run(() => store.setSubmission(s.path, { status }));

    const cards = list.map((s) => h('div', { class: `card answer-card${selected.has(s.path) ? ' selected' : ''}` },
      h('div', { class: 'row between' },
        h('strong', {}, s.ownerName),
        h('div', { class: 'row', style: { gap: '4px' } },
          s.likes ? h('span', { class: 'badge' }, `♥${s.likes}`) : null,
          s.confidence ? h('span', { class: 'badge', title: '自信' }, CONF_LABEL[s.confidence]) : null,
          statusBadge(s.status))),
      answerContent(s, false),
      s.feedback ? h('div', { class: 'feedback small' }, 'コメント：', s.feedback) : null,
      h('div', { class: 'row', style: { marginTop: 'auto' } },
        s.status !== 'cleared' ? h('button', { class: 'small good', onclick: quick(s, 'cleared') }, '✓ クリア') : null,
        s.status !== 'retry' ? h('button', { class: 'small', onclick: quick(s, 'retry') }, '再提出') : null,
        h('button', { class: 'small', onclick: () => openSubmission(s.path) }, 'コメント'),
        h('span', { class: 'grow' }),
        h('button', { class: `small${selected.has(s.path) ? ' primary' : ''}`, onclick: () => toggleSelect(s.path) }, selected.has(s.path) ? '提示中' : '提示に選ぶ'))));

    fill(view,
      h('div', { class: 'card', style: { marginBottom: '12px' } },
        h('div', { class: 'row' },
          h('select', { style: { maxWidth: '360px' }, onchange: (e) => { ui.answersTaskId = e.target.value; render(); } },
            usable.map((x) => h('option', { value: x.id, selected: x.id === t.id }, `${x.status === 'closed' ? '［締切］' : ''}${x.title}`))),
          h('span', { class: `badge ${t.status}` }, t.status === 'open' ? '受付中' : '締切'),
          h('span', { class: 'badge' }, t.mode === 'group' ? 'グループ' : '個人'),
          h('span', { class: 'grow' }),
          h('button', { class: 'small', onclick: run(() => store.updateTask(t.id, { status: t.status === 'open' ? 'closed' : 'open' })) }, t.status === 'open' ? '締め切る' : '受付を再開'),
          t.hintText ? h('button', { class: 'small', onclick: run(() => store.updateTask(t.id, { hintOpen: !t.hintOpen })) }, t.hintOpen ? 'ヒントを隠す' : 'ヒントを出す') : null,
          h('select', { style: { width: 'auto' }, onchange: run((e) => store.updateTask(t.id, { peerView: e.target.value })) },
            Object.entries(PEER_LABEL).map(([k, v]) => h('option', { value: k, selected: t.peerView === k }, `生徒同士：${v}`)))),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('div', { class: 'seg' }, Object.entries(filters).map(([k, [label]]) => h('button', {
            class: ui.answersFilter === k ? 'on' : '',
            onclick: () => { ui.answersFilter = k; render(); },
          }, label))),
          h('select', { style: { width: 'auto' }, onchange: (e) => { ui.answersSort = e.target.value; render(); } },
            h('option', { value: 'time', selected: ui.answersSort === 'time' }, '最初の提出順'),
            h('option', { value: 'new', selected: ui.answersSort === 'new' }, '新しい順'),
            h('option', { value: 'likes', selected: ui.answersSort === 'likes' }, '♥が多い順')),
          h('span', { class: 'grow' }),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: present.showNames, onchange: run((e) => store.setPresent({ showNames: e.target.checked })) }), '提示画面に名前を出す'),
          selected.size ? h('button', { class: 'small', onclick: run(() => store.setPresent({ submissionKeys: [] })) }, `提示をやめる（${selected.size}件）`) : null,
          h('a', { class: 'btn small primary', href: '/present', target: 'mb-present' }, '提示画面 ↗')),
        h('p', { class: 'muted small', style: { margin: '8px 0 0' } },
          `提出 ${subs.length} / ${t.mode === 'group' ? store.state.groups.size : store.state.students.size}・クリア ${subs.filter((s) => s.status === 'cleared').length}`,
          missing.length ? `・未提出：${missing.join('、')}` : '')),
      list.length ? h('div', { class: 'answers' }, cards) : h('div', { class: 'card muted' }, '該当する回答はありません。'));
  }

  // ---------- 課題 ----------

  function renderTasks() {
    const all = store.tasks();
    const counts = (id) => {
      const subs = [...store.state.subs.values()].filter((s) => s.taskId === id);
      return { submitted: subs.length, cleared: subs.filter((s) => s.status === 'cleared').length };
    };
    const move = run(async (i, d) => {
      const ids = all.map((t) => t.id);
      [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
      await store.reorderTasks(ids);
    });
    const rows = all.map((raw, i) => {
      const t = store.taskView(raw);
      const c = counts(t.id);
      return h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', { class: 'grow', style: { minWidth: '200px' } },
            h('strong', {}, t.title),
            h('div', { class: 'row', style: { gap: '4px', marginTop: '4px' } },
              h('span', { class: `badge ${t.status}` }, { draft: '下書き', open: '受付中', closed: '締切' }[t.status]),
              h('span', { class: 'badge' }, t.mode === 'group' ? 'グループ' : '個人'),
              h('span', { class: 'badge' }, t.answerKind === 'short' ? `短答（正解：${t.accepted.answers.join(' / ') || '未設定'}）` : '記述'),
              h('span', { class: 'badge' }, `生徒同士：${PEER_LABEL[t.peerView]}`),
              t.hintText ? h('span', { class: `badge ${t.hintOpen ? 'open' : ''}` }, t.hintOpen ? 'ヒント公開中' : 'ヒントあり') : null,
              t.status !== 'draft' ? h('span', { class: 'muted small' }, `提出 ${c.submitted}・クリア ${c.cleared}`) : null)),
          h('div', { class: 'row' },
            h('div', { class: 'seg' }, [['draft', '下書き'], ['open', '公開'], ['closed', '締切']].map(([k, v]) => h('button', {
              class: t.status === k ? 'on' : '',
              onclick: run(() => store.updateTask(t.id, { status: k })),
            }, v))),
            h('button', { class: 'small', onclick: () => editTask(t) }, '編集'),
            h('button', { class: 'small', onclick: () => { ui.tab = 'answers'; ui.answersTaskId = t.id; render(); } }, '回答'),
            h('button', { class: 'small icon', title: '上へ', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
            h('button', { class: 'small icon', title: '下へ', disabled: i === all.length - 1, onclick: () => move(i, 1) }, '↓'),
            h('button', { class: 'small', onclick: run(async () => { await store.duplicateTask(t.id); toast('複製しました（下書き）'); }) }, '複製'),
            h('button', { class: 'small danger', onclick: run(async () => {
              if (!window.confirm(`「${t.title}」を削除しますか？ 生徒の提出もすべて消えます。`)) return;
              await store.deleteTask(t.id);
              toast('削除しました');
            }) }, '削除'))));
    });

    fill(view,
      h('div', { class: 'row between', style: { marginBottom: '12px' } },
        h('h1', { style: { margin: 0 } }, '課題'),
        h('button', { class: 'primary', onclick: () => editTask(null) }, '＋ 新しい課題')),
      rows.length ? h('div', {}, rows) : h('div', { class: 'card muted' }, 'まだ課題がありません。「＋ 新しい課題」から作りましょう。'));
  }

  function editTask(t) {
    const v = t ? JSON.parse(JSON.stringify(t)) : {
      title: '', body: '', mode: 'individual', answerKind: 'free', accepted: { answers: [], mode: 'value' }, showResult: true,
      allowText: true, allowDraw: true, allowPhoto: true, peerView: 'off', hintText: '', hintOpen: false, status: 'draft', image: null,
    };
    let image; // undefined = 変更なし
    const title = h('input', { type: 'text', value: v.title, placeholder: '例：三角形の内角の和' });
    const body = h('textarea', { placeholder: '問題文。$\\frac{1}{2}$ のように $ で囲むと数式になります', style: { minHeight: '140px' } });
    body.value = v.body;
    const preview = h('div', { class: 'preview' });
    const upd = debounce(() => fill(preview, rich(body.value || '（問題文のプレビュー）')), 250);
    body.addEventListener('input', upd);
    upd();

    const imgBox = h('div');
    const paintImg = () => {
      const src = image === undefined ? (t && t.image) : image || null;
      fill(imgBox, src ? img(src, { class: 'task-image', style: { maxHeight: '200px' } }) : null);
    };
    paintImg();
    const imgInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async () => {
      if (imgInput.files[0]) image = await compressImage(imgInput.files[0], 1600, 0.8);
      paintImg();
    } });

    const radio = (name, options, value) => h('div', { class: 'seg' }, options.map(([k, label]) => h('button', {
      type: 'button',
      class: value === k ? 'on' : '',
      onclick: (e) => {
        [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget));
        v[name] = k;
        refreshKind();
      },
    }, label)));

    const accepted = h('textarea', { placeholder: '1行に1つ。例：\n2√3\n√12', style: { minHeight: '70px' } });
    accepted.value = (v.accepted.answers || []).join('\n');
    const exact = h('input', { type: 'checkbox', checked: v.accepted.mode === 'exact' });
    const showResult = h('input', { type: 'checkbox', checked: v.showResult });
    const shortBox = h('div', { class: 'card', style: { boxShadow: 'none', background: 'var(--surface-2)' } },
      h('div', { class: 'field' }, h('label', {}, '正解', h('div', { class: 'help' }, '「2√3」と「√12」「3.464…」、「(x+1)^2」と「x^2+2x+1」のように値が等しい答えも正解にします。正解は生徒には見えません')), accepted),
      h('label', { class: 'check' }, exact, '書いた形と完全に同じときだけ正解（因数分解の形を問うときなど）'),
      h('label', { class: 'check' }, showResult, '正解・不正解を生徒にすぐ見せる'));
    const refreshKind = () => shortBox.classList.toggle('hidden', v.answerKind !== 'short');

    const allowText = h('input', { type: 'checkbox', checked: v.allowText });
    const allowDraw = h('input', { type: 'checkbox', checked: v.allowDraw });
    const allowPhoto = h('input', { type: 'checkbox', checked: v.allowPhoto });
    const peer = h('select', {}, Object.entries(PEER_LABEL).map(([k, label]) => h('option', { value: k, selected: v.peerView === k }, label)));
    const hint = h('textarea', { placeholder: '（任意）授業中に「ヒントを出す」を押すと生徒に表示されます', style: { minHeight: '60px' } });
    hint.value = v.hintText || '';
    const error = h('div', { class: 'error' });

    const save = async (status, btn) => {
      error.textContent = '';
      const payload = {
        title: title.value,
        body: body.value,
        mode: v.mode,
        answerKind: v.answerKind,
        accepted: { answers: accepted.value.split('\n').map((x) => x.trim()).filter(Boolean), mode: exact.checked ? 'exact' : 'value' },
        showResult: showResult.checked,
        allowText: allowText.checked,
        allowDraw: allowDraw.checked,
        allowPhoto: allowPhoto.checked,
        peerView: peer.value,
        hint: hint.value,
        status: status || v.status,
      };
      if (image !== undefined) payload.image = image;
      if (!payload.title.trim()) { error.textContent = 'タイトルを入力してください'; return; }
      if (payload.answerKind === 'short' && !payload.accepted.answers.length) { error.textContent = '短答の正解を入力してください'; return; }
      btn.disabled = true;
      try {
        if (t) {
          await store.updateTask(t.id, payload);
          const changed = t.answerKind === 'short' && JSON.stringify(t.accepted) !== JSON.stringify(payload.accepted);
          const hasSubs = [...store.state.subs.values()].some((s) => s.taskId === t.id);
          if (changed && hasSubs && window.confirm('正解が変わりました。提出済みの答えを判定し直しますか？')) {
            const r = await store.rejudge(t.id);
            toast(`判定し直しました（${r.changed}件変更）`);
          }
        } else {
          await store.createTask(payload);
        }
        m.close();
        toast('保存しました');
      } catch (e) {
        error.textContent = e.message;
        btn.disabled = false;
      }
    };

    const m = modal(h('div', {},
      h('h2', {}, t ? '課題を編集' : '新しい課題'),
      h('div', { class: 'field' }, h('label', {}, 'タイトル'), title),
      h('div', { class: 'field' }, h('label', {}, '問題文'), body, preview),
      h('div', { class: 'field' }, h('label', {}, '問題の図・画像（任意）'), imgInput, imgBox,
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', { type: 'button', class: 'small', onclick: () => imgInput.click() }, '画像を選ぶ'),
          h('button', { type: 'button', class: 'small danger', onclick: () => { image = ''; paintImg(); } }, '画像を外す'))),
      h('div', { class: 'field' }, h('label', {}, '提出のしかた'), radio('mode', [['individual', '個人で提出'], ['group', 'グループで1つ提出']], v.mode)),
      h('div', { class: 'field' }, h('label', {}, '答えの種類'), radio('answerKind', [['free', '記述（先生が確認してクリア）'], ['short', '短答（自動で正誤判定）']], v.answerKind)),
      h('div', { class: 'field' }, shortBox),
      h('div', { class: 'field' }, h('label', {}, '生徒が使える入力'),
        h('label', { class: 'check' }, allowText, '文章'),
        h('label', { class: 'check' }, allowDraw, '手書き（図・式）'),
        h('label', { class: 'check' }, allowPhoto, 'ノートの写真')),
      h('div', { class: 'field' }, h('label', {}, '生徒同士で回答を見せる（匿名）'), peer),
      h('div', { class: 'field' }, h('label', {}, 'ヒント'), hint),
      error,
      h('div', { class: 'row' },
        h('button', { onclick: () => m.close() }, 'キャンセル'),
        h('span', { class: 'grow' }),
        h('button', { onclick: (e) => save(undefined, e.currentTarget) }, '保存'),
        v.status !== 'open' ? h('button', { class: 'primary', onclick: (e) => save('open', e.currentTarget) }, '保存して公開') : null)), { wide: true });
    refreshKind();
    title.focus();
  }

  // ---------- 生徒・グループ ----------

  function qrSvg(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  const joinUrl = () => `${location.origin}/?join=${encodeURIComponent(store.state.settings.joinCode)}`;

  function renderStudents() {
    const s = store.state.settings;
    const qr = h('div', { class: 'qr' });
    qr.innerHTML = qrSvg(joinUrl());

    const join = h('div', { class: 'card' },
      h('h2', {}, '生徒の登録'),
      h('div', { class: 'row', style: { gap: '24px', alignItems: 'flex-start' } },
        qr,
        h('div', { class: 'stack grow' },
          h('div', {}, h('div', { class: 'muted small' }, '参加コード'), h('div', { class: 'code-big' }, s.joinCode)),
          h('div', { class: 'small' }, 'URL：', h('a', { href: joinUrl() }, joinUrl())),
          h('p', { class: 'small muted', style: { margin: 0 } }, '生徒はQRコードを読み取るか、URLを開いて参加コードを入力し、自分で決めた表示名とパスワードで登録します。2回目からは表示名とパスワードでログインします。'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.registrationOpen, onchange: run(async (e) => {
            await store.updateSettings({ registrationOpen: e.target.checked });
            toast(e.target.checked ? '新規登録を受け付けます' : '新規登録を締め切りました');
          }) }), '新規登録を受け付ける（全員そろったら外すと安心です）'),
          h('div', { class: 'row' },
            h('button', { class: 'small', onclick: run(async () => {
              if (!window.confirm('参加コードを作り直しますか？ 古いコードでは登録できなくなります（登録済みの生徒には影響しません）。')) return;
              await store.updateSettings({ regenerateJoinCode: true });
            }) }, '参加コードを作り直す'),
            h('button', { class: 'small', onclick: addStudent }, '＋ 先生が生徒を追加')))));

    const students = store.students();
    const groups = store.groups();
    const groupSelect = (st) => h('select', {
      style: { width: 'auto' },
      onchange: run((e) => store.updateStudent(st.id, { groupId: e.target.value || null })),
    }, h('option', { value: '' }, '（なし）'), groups.map((g) => h('option', { value: g.id, selected: st.groupId === g.id }, g.name)));

    const groupCard = h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('h2', { style: { margin: 0 } }, `グループ（${groups.length}）`),
        h('div', { class: 'row' },
          h('button', { class: 'small', onclick: run(() => store.addGroup()) }, '＋ グループを追加'),
          h('button', { class: 'small', onclick: run(async () => {
            const size = window.prompt('1グループ何人にしますか？（今のグループと、グループ課題の提出はリセットされます）', '4');
            if (!size) return;
            await store.autoGroups(Number(size));
            toast('ランダムにグループ分けしました');
          }) }, 'ランダムに分ける'))),
      h('div', { class: 'row', style: { marginTop: '12px', alignItems: 'flex-start' } }, groups.map((g) => {
        const members = students.filter((st) => st.groupId === g.id);
        return h('div', { class: 'card', style: { boxShadow: 'none', minWidth: '180px', margin: 0 } },
          h('div', { class: 'row between' },
            h('strong', {}, g.name),
            h('div', { class: 'row', style: { gap: '2px' } },
              h('button', { class: 'small icon', title: '名前を変える', onclick: run(async () => {
                const name = window.prompt('グループ名', g.name);
                if (name) await store.renameGroup(g.id, name);
              }) }, '✎'),
              h('button', { class: 'small icon danger', title: '削除', onclick: run(async () => {
                if (window.confirm(`${g.name}を削除しますか？ このグループの提出も消えます。`)) await store.deleteGroup(g.id);
              }) }, '×'))),
          h('div', { class: 'small' }, members.length ? members.map((x) => x.name).join('、') : h('span', { class: 'muted' }, 'メンバーなし')));
      })),
      students.some((st) => !st.groupId) && groups.length
        ? h('p', { class: 'small muted' }, `グループなし：${students.filter((st) => !st.groupId).map((x) => x.name).join('、')}`)
        : null);

    const showPassword = (name, password, title) => modal(h('div', { class: 'stack' },
      h('h2', {}, title), h('p', {}, `${name} さんのパスワード：`), h('div', { class: 'code-big' }, password),
      h('p', { class: 'muted small' }, 'ログイン後、生徒が自分でメニューから変更できます。')));

    const table = h('div', { class: 'card', style: { overflowX: 'auto' } },
      h('h2', {}, `生徒（${students.length}人）`),
      students.length ? h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, '番号'), h('th', {}, '表示名'), h('th', {}, 'グループ'), h('th', {}, ''))),
        h('tbody', {}, students.map((st) => h('tr', {},
          h('td', {}, st.number ?? '—'),
          h('td', {}, st.name),
          h('td', {}, groupSelect(st)),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            h('button', { class: 'small', onclick: run(async () => {
              const name = window.prompt('表示名', st.name);
              if (name === null) return;
              const number = window.prompt('出席番号（空欄可）', st.number ?? '');
              if (number === null) return;
              await store.updateStudent(st.id, { name, number: number || null });
            }) }, '編集'),
            h('button', { class: 'small', onclick: run(async (e) => {
              if (!window.confirm(`${st.name} のパスワードを再設定しますか？`)) return;
              e.target.disabled = true;
              const r = await store.resetStudentPassword(st.id);
              e.target.disabled = false;
              showPassword(st.name, r.password, '新しいパスワード');
            }) }, 'パスワード再設定'),
            h('button', { class: 'small danger', onclick: run(async () => {
              if (window.confirm(`${st.name} を削除しますか？ この生徒の個人提出も消えます。`)) await store.deleteStudent(st.id);
            }) }, '削除')))))) : h('p', { class: 'muted' }, 'まだ誰も登録していません。'));

    fill(view, join, h('div', { style: { height: '12px' } }), groupCard, h('div', { style: { height: '12px' } }), table);

    function addStudent() {
      const name = h('input', { type: 'text', placeholder: '表示名' });
      const number = h('input', { type: 'number', placeholder: '出席番号（任意）' });
      const error = h('div', { class: 'error' });
      const m = modal(h('div', { class: 'stack' },
        h('h2', {}, '生徒を追加'),
        name, number, error,
        h('p', { class: 'muted small' }, 'パスワードは自動で作ります。'),
        h('div', { class: 'row' },
          h('button', { onclick: () => m.close() }, 'キャンセル'),
          h('button', { class: 'primary', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              const r = await store.addStudent({ name: name.value, number: number.value || null });
              m.close();
              showPassword(name.value, r.password, '追加しました');
            } catch (err) {
              error.textContent = err.message;
              e.target.disabled = false;
            }
          } }, '追加'))));
      name.focus();
    }
  }

  // ---------- 設定 ----------

  function renderSettings() {
    const cls = h('input', { type: 'text', value: store.state.settings.className });
    const cur = h('input', { type: 'password', placeholder: '今のパスワード', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', placeholder: '新しいパスワード', autocomplete: 'new-password' });
    fill(view, h('div', { class: 'card', style: { maxWidth: '560px' } },
      h('h2', {}, '設定'),
      h('div', { class: 'field' }, h('label', {}, 'クラス名'), h('div', { class: 'row' }, h('div', { class: 'grow' }, cls),
        h('button', { onclick: run(async () => { await store.updateSettings({ className: cls.value }); toast('保存しました'); }) }, '保存'))),
      h('div', { class: 'field' }, h('label', {}, '先生のパスワードを変える', h('div', { class: 'help' }, `ログイン用メールアドレス：${store.state.email}`)),
        h('div', { class: 'stack' }, cur, next),
        h('button', { style: { marginTop: '8px' }, onclick: run(async () => {
          await window.Store.changePassword(cur.value, next.value);
          toast('変更しました');
          cur.value = '';
          next.value = '';
        }) }, '変更')),
      h('button', { class: 'danger', onclick: MB.logout }, 'ログアウト')));
  }

  // ---------- 起動 ----------

  (async () => {
    const who = await window.Store.whoami();
    if (who.role !== 'teacher') {
      location.href = who.role === 'student' ? '/student' : '/';
      return;
    }
    try { ui.tab = sessionStorage.getItem('mb-tab') || 'progress'; } catch { /* 無視 */ }
    store = window.Store.teacherStore(who);
    fill(view, h('p', { class: 'muted' }, '読み込み中…'));
    store.on(() => {
      MB.showErrors(store.state.errors);
      if (!store.state.ready) return;
      $('#class-name').textContent = `${store.state.settings.className}（先生）`;
      $('#live').classList.add('on');
      // 入力欄やダイアログを使っている間は描き直さない（入力が消えないように）
      const active = document.activeElement;
      const typing = active && view.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
      if ($('.modal-back') || typing) renderTabs();
      else render();
    });
    window.addEventListener('offline', () => $('#live').classList.remove('on'));
    window.addEventListener('online', () => $('#live').classList.add('on'));
  })();
})();
