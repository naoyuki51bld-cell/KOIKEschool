(function () {
  const { h, fill, $, toast, rich, img, modal, compressImage, debounce, statusBadge, STATUS_LABEL } = MB;
  const view = $('#view');
  const tabsEl = $('#tabs');
  let store = null;
  let who = null; // ログイン中の先生

  const ui = {
    tab: 'progress',
    answersTaskId: null,
    answersFilter: 'all',
    taskOrder: (() => { try { return localStorage.getItem('mb-task-order') || 'new'; } catch { return 'new'; } })(),
    numberDraft: null, // 出席番号をまとめて編集しているとき：生徒ID → 入力中の文字
    quizId: null, // 得点入力中の小テスト
    scoreDraft: {}, // 保存前の得点（生徒ID → 入力中の文字）
    answersSort: 'time',
    boardSort: 'number',
    showClosed: true,
  };

  const TABS = [
    ['progress', '進捗'],
    ['answers', '回答'],
    ['tasks', '課題'],
    ['quizzes', '小テスト'],
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
    ({ progress: renderProgress, answers: renderAnswers, tasks: renderTasks, quizzes: renderQuizzes, students: renderStudents, settings: renderSettings })[ui.tab]();
  }

  const groupName = (id) => (store.state.groups.get(id) || {}).name || '';

  function submissionFor(task, student) {
    const key = task.mode === 'group' ? (student.groupId ? `g_${student.groupId}` : null) : `u_${student.id}`;
    return key ? store.state.subs.get(`classes/${store.state.classId}/subs/${task.id}__${key}`) || null : null;
  }

  // ---------- 進捗 ----------

  function renderProgress() {
    const { state } = store;
    const tasks = store.tasks().filter((t) => t.status !== 'draft' && (ui.showClosed || t.status === 'open'));
    const students = store.students();
    const groups = store.groups();
    if (ui.boardSort === 'group') {
      const order = new Map(groups.map((g, i) => [g.id, i]));
      students.sort((a, b) => (order.get(a.groupId) ?? 999) - (order.get(b.groupId) ?? 999) || (a.number ?? 99999) - (b.number ?? 99999));
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
    // 新しい課題ほど上
    const usable = store.tasks().filter((t) => t.status !== 'draft').reverse();
    if (!usable.length) {
      fill(view, h('div', { class: 'card muted' }, '公開した課題がまだありません。'));
      return;
    }
    if (!usable.find((t) => t.id === ui.answersTaskId)) {
      const open = usable.filter((t) => t.status === 'open');
      ui.answersTaskId = (open[0] || usable[0]).id;
    }
    const t = store.taskView(store.state.tasks.get(ui.answersTaskId));
    store.watchLikes(t.id);
    const subs = store.submissionsOf(t.id);
    const present = store.state.present;
    const allMode = present.taskId === t.id && present.mode === 'all';
    const selected = new Set(present.taskId === t.id && !allMode ? present.submissionKeys : []);
    const toggleSelect = run(async (path) => {
      // 全員の回答を出しているときに選んだら、その1件から選び直す
      const keys = present.taskId === t.id && !allMode ? [...present.submissionKeys] : [];
      const i = keys.indexOf(path);
      if (i >= 0) keys.splice(i, 1);
      else {
        if (keys.length >= 24) return toast('選んで提示できるのは24件までです。全員分は「全員の回答」で提示できます');
        keys.push(path);
      }
      await store.setPresent({ taskId: t.id, submissionKeys: keys, mode: 'selected' });
      render();
    });
    const presenting = present.taskId === t.id && (allMode || selected.size > 0);

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
          h('a', { class: 'btn small primary', href: `/present?class=${encodeURIComponent(store.state.classId)}`, target: 'mb-present' }, '提示画面 ↗')),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('strong', { class: 'small' }, '提示画面：'),
          h('div', { class: 'seg' },
            h('button', { class: present.taskId === t.id && !allMode && selected.size ? 'on' : '', onclick: run(async () => {
              await store.setPresent({ taskId: t.id, mode: 'selected', submissionKeys: present.taskId === t.id ? present.submissionKeys : [] });
              toast('下のカードの「提示に選ぶ」で回答を選んでください');
            }) }, `選んだ回答${selected.size ? `（${selected.size}件）` : ''}`),
            h('button', { class: allMode ? 'on' : '', onclick: run(() => store.setPresent({ taskId: t.id, mode: 'all' })) }, `全員の回答（${subs.length}件）`)),
          presenting ? h('button', { class: 'small', onclick: run(() => store.setPresent({ taskId: null, submissionKeys: [], mode: 'selected' })) }, '提示をやめる') : null,
          h('span', { class: 'grow' }),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: present.showNames, onchange: run((e) => store.setPresent({ showNames: e.target.checked })) }), '提示画面に名前を出す')),
        h('p', { class: 'muted small', style: { margin: '8px 0 0' } },
          `提出 ${subs.length} / ${t.mode === 'group' ? store.state.groups.size : store.state.students.size}・クリア ${subs.filter((s) => s.status === 'cleared').length}`,
          missing.length ? `・未提出：${missing.join('、')}` : '')),
      list.length ? h('div', { class: 'answers' }, cards) : h('div', { class: 'card muted' }, '該当する回答はありません。'));
  }

  // ---------- 課題 ----------

  function renderTasks() {
    const asc = store.tasks();
    const all = ui.taskOrder === 'old' ? asc : [...asc].reverse();
    const counts = (id) => {
      const subs = [...store.state.subs.values()].filter((s) => s.taskId === id);
      return { submitted: subs.length, cleared: subs.filter((s) => s.status === 'cleared').length };
    };
    const move = run(async (i, d) => {
      const ids = all.map((t) => t.id);
      [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
      // 並び順の番号は「古い順」で振る
      await store.reorderTasks(ui.taskOrder === 'old' ? ids : ids.reverse());
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
        h('div', { class: 'row' },
          h('h1', { style: { margin: 0 } }, '課題'),
          h('div', { class: 'seg' }, [['new', '新しい順'], ['old', '古い順']].map(([k, label]) => h('button', {
            class: (ui.taskOrder || 'new') === k ? 'on' : '',
            onclick: () => {
              ui.taskOrder = k;
              try { localStorage.setItem('mb-task-order', k); } catch { /* 無視 */ }
              render();
            },
          }, label)))),
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

  // ---------- 小テスト ----------

  const round1 = (x) => Math.round(x * 10) / 10;
  const pct = (score, max) => (max ? (score / max) * 100 : 0);
  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 10);

  function stats(list) {
    if (!list.length) return null;
    const xs = list.map((x) => x.score);
    return { n: xs.length, avg: xs.reduce((a, b) => a + b, 0) / xs.length, max: Math.max(...xs), min: Math.min(...xs) };
  }

  // 1回のテストのグループ平均（得点を入れたときの班で集計する）
  function groupStats(q) {
    const by = new Map();
    for (const x of store.scoresOf(q.id)) {
      if (!x.groupId) continue;
      if (!by.has(x.groupId)) by.set(x.groupId, { groupId: x.groupId, name: store.state.groups.get(x.groupId)?.name || x.groupName || '(削除されたグループ)', list: [] });
      by.get(x.groupId).list.push(x);
    }
    const rows = [...by.values()].map((g) => {
      const s = stats(g.list);
      return { ...g, n: s.n, avg: s.avg, rate: pct(s.avg, q.maxScore) };
    }).sort((a, b) => b.avg - a.avg);
    rows.forEach((r, i) => { r.rank = i > 0 && r.avg === rows[i - 1].avg ? rows[i - 1].rank : i + 1; });
    return rows;
  }

  // これまでのテスト全体でのグループ順位（各回の班平均の得点率を平均する）
  function groupTotals() {
    const by = new Map();
    for (const q of store.quizzes()) {
      for (const g of groupStats(q)) {
        if (!by.has(g.groupId)) by.set(g.groupId, { name: g.name, rates: [] });
        by.get(g.groupId).rates.push(g.rate);
      }
    }
    const rows = [...by.values()].map((g) => ({ ...g, rate: g.rates.reduce((a, b) => a + b, 0) / g.rates.length }))
      .sort((a, b) => b.rate - a.rate);
    rows.forEach((r, i) => { r.rank = i > 0 && round1(r.rate) === round1(rows[i - 1].rate) ? rows[i - 1].rank : i + 1; });
    return rows;
  }

  const rankTable = (rows, cols) => h('table', { class: 'list' },
    h('thead', {}, h('tr', {}, cols.map(([label]) => h('th', {}, label)))),
    h('tbody', {}, rows.map((r) => h('tr', { style: r.rank === 1 ? { fontWeight: 700 } : {} }, cols.map(([, fn]) => h('td', {}, fn(r)))))));

  function renderQuizzes() {
    if (ui.quizId && store.state.quizzes.has(ui.quizId)) return renderQuiz(store.state.quizzes.get(ui.quizId));
    ui.quizId = null;
    const list = store.quizzes();
    const total = store.state.students.size;
    const cards = list.map((q) => {
      const s = stats(store.scoresOf(q.id));
      return h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', { class: 'grow', style: { minWidth: '200px' } },
            h('strong', {}, q.title),
            h('div', { class: 'row small muted', style: { gap: '8px', marginTop: '4px' } },
              h('span', {}, q.date), h('span', {}, `満点 ${q.maxScore}点`),
              h('span', {}, `入力 ${s ? s.n : 0} / ${total}人`),
              s ? h('span', {}, `平均 ${round1(s.avg)}点（${round1(pct(s.avg, q.maxScore))}%）`) : null,
              h('span', { class: `badge ${q.published ? 'open' : 'draft'}` }, q.published ? '生徒に公開中' : '非公開'))),
          h('div', { class: 'row' },
            h('button', { class: 'small primary', onclick: () => { ui.quizId = q.id; ui.scoreDraft = {}; render(); } }, '得点入力・結果'),
            h('button', { class: 'small', onclick: run(() => store.updateQuiz(q.id, { published: !q.published })) }, q.published ? '非公開にする' : '生徒に公開'),
            h('button', { class: 'small', onclick: () => editQuiz(q) }, '編集'),
            h('button', { class: 'small danger', onclick: run(async () => {
              if (!window.confirm(`「${q.title}」を削除しますか？ 入力した得点もすべて消えます。`)) return;
              await store.deleteQuiz(q.id);
              toast('削除しました');
            }) }, '削除'))));
    });

    const totals = groupTotals();
    fill(view,
      h('div', { class: 'row between', style: { marginBottom: '12px' } },
        h('h1', { style: { margin: 0 } }, '小テスト'),
        h('div', { class: 'row' },
          list.length ? h('button', { class: 'small', onclick: downloadScoresCsv }, 'CSVで保存') : null,
          h('button', { class: 'primary', onclick: () => editQuiz(null) }, '＋ 新しいテスト'))),
      list.length ? h('div', {}, cards) : h('div', { class: 'card muted' }, 'まだ小テストがありません。「＋ 新しいテスト」から作り、得点を入力しましょう。'),
      totals.length ? h('div', { class: 'card', style: { marginTop: '12px' } },
        h('h2', {}, 'グループ対抗（これまでの合計）'),
        h('p', { class: 'muted small', style: { marginTop: 0 } }, '各回のグループ平均の得点率を平均した順位です。先生だけが見られます。班は得点を入力したときの班で数えます。'),
        rankTable(totals, [
          ['順位', (r) => `${r.rank}位`],
          ['グループ', (r) => r.name],
          ['平均得点率', (r) => `${round1(r.rate)}%`],
          ['回数', (r) => `${r.rates.length}回`],
        ])) : null);
  }

  function renderQuiz(q) {
    const students = store.students();
    const saved = new Map(store.scoresOf(q.id).map((x) => [x.studentId, x]));
    const draft = ui.scoreDraft || (ui.scoreDraft = {});
    const valueOf = (sid) => (sid in draft ? draft[sid] : saved.has(sid) ? String(saved.get(sid).score) : '');
    const dirty = () => Object.keys(draft).some((sid) => draft[sid] !== (saved.has(sid) ? String(saved.get(sid).score) : ''));
    const inputs = [];
    const error = h('div', { class: 'error' });

    const rows = students.map((st, i) => {
      const input = h('input', {
        type: 'text',
        inputmode: 'decimal',
        value: valueOf(st.id),
        placeholder: '—',
        style: { width: '90px', padding: '6px 8px' },
        oninput: (e) => { draft[st.id] = e.target.value; },
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); inputs[i + 1]?.focus(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); inputs[i - 1]?.focus(); }
        },
      });
      inputs.push(input);
      const sv = saved.get(st.id);
      return h('tr', {},
        h('td', {}, st.number ?? '—'),
        h('td', {}, st.name),
        h('td', { class: 'muted small' }, sv ? sv.groupName || '' : groupName(st.groupId)),
        h('td', {}, input, h('span', { class: 'muted small' }, ` / ${q.maxScore}`)));
    });

    const save = run(async (e) => {
      error.textContent = '';
      const entries = [];
      for (const st of students) {
        const raw = String(valueOf(st.id)).normalize('NFKC').trim();
        if (raw === '') { entries.push({ studentId: st.id, score: null }); continue; }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > q.maxScore) {
          error.textContent = `${st.name}：得点は0〜${q.maxScore}の数で入力してください`;
          return;
        }
        entries.push({ studentId: st.id, score: n });
      }
      e.target.disabled = true;
      const changed = await store.saveScores(q.id, entries);
      ui.scoreDraft = {};
      toast(changed ? `保存しました（${changed}件）` : '変更はありません');
      render();
    });

    // Excel などから「出席番号 点数」をまとめて貼り付ける
    const paste = () => {
      const ta = h('textarea', { placeholder: '1行に「出席番号 点数」。Excel の2列をそのまま貼り付けられます\n例：\n3101\t8\n3102\t10', style: { minHeight: '180px' } });
      const msg = h('div', { class: 'small' });
      const m = modal(h('div', { class: 'stack' },
        h('h2', {}, 'まとめて貼り付け'), ta, msg,
        h('div', { class: 'row' }, h('span', { class: 'grow' }),
          h('button', { onclick: () => m.close() }, 'キャンセル'),
          h('button', { class: 'primary', onclick: () => {
            const byNumber = new Map(students.filter((s) => s.number != null).map((s) => [s.number, s]));
            const missing = [];
            let count = 0;
            for (const line of ta.value.normalize('NFKC').split(/\r?\n/)) {
              const cols = line.trim().split(/[\s,]+/).filter(Boolean);
              if (cols.length < 2) continue;
              const st = byNumber.get(Number(cols[0]));
              if (!st) { missing.push(cols[0]); continue; }
              draft[st.id] = cols[cols.length - 1];
              count++;
            }
            m.close();
            render();
            toast(`${count}人分を入れました。確かめてから「保存」を押してください${missing.length ? `（見つからない番号：${missing.join('、')}）` : ''}`);
          } }, '入れる'))));
      ta.focus();
    };

    const s = stats(store.scoresOf(q.id));
    const gs = groupStats(q);
    const results = h('div', { class: 'card' },
      h('h2', {}, '結果'),
      s ? h('div', { class: 'row', style: { gap: '20px', marginBottom: '12px' } },
        ...[['受験', `${s.n}人`], ['平均', `${round1(s.avg)}点`], ['得点率', `${round1(pct(s.avg, q.maxScore))}%`], ['最高', `${s.max}点`], ['最低', `${s.min}点`]]
          .map(([k, v]) => h('div', {}, h('div', { class: 'muted small' }, k), h('div', { style: { fontSize: '1.3rem', fontWeight: 700 } }, v))))
        : h('p', { class: 'muted' }, 'まだ得点が入力されていません。'),
      gs.length ? h('div', {},
        h('h3', {}, 'グループ対抗（このテスト）'),
        rankTable(gs, [
          ['順位', (r) => `${r.rank}位`],
          ['グループ', (r) => r.name],
          ['平均点', (r) => `${round1(r.avg)}点`],
          ['得点率', (r) => h('div', {}, `${round1(r.rate)}%`, h('div', { class: 'meter', style: { width: '120px' } }, h('i', { style: { width: `${Math.min(100, r.rate)}%`, background: 'var(--accent)' } })))],
          ['受験', (r) => `${r.n}人`],
        ]),
        h('p', { class: 'muted small' }, 'グループの平均は、そのテストを受けたメンバーだけで計算します。先生だけが見られます。')) : null);

    fill(view,
      h('div', { class: 'row', style: { marginBottom: '12px' } },
        h('button', { class: 'small', onclick: () => {
          if (dirty() && !window.confirm('保存していない得点があります。戻りますか？')) return;
          ui.quizId = null; ui.scoreDraft = {}; render();
        } }, '← 小テスト一覧'),
        h('h1', { style: { margin: 0 } }, q.title),
        h('span', { class: 'muted' }, `${q.date}・満点 ${q.maxScore}点`),
        h('span', { class: `badge ${q.published ? 'open' : 'draft'}` }, q.published ? '生徒に公開中' : '非公開'),
        h('span', { class: 'grow' }),
        h('button', { class: 'small', onclick: run(() => store.updateQuiz(q.id, { published: !q.published })) }, q.published ? '非公開にする' : '生徒に公開')),
      h('div', { class: 'quiz-layout' },
        h('div', { class: 'card' },
          h('div', { class: 'row between' },
            h('h2', { style: { margin: 0 } }, '得点の入力'),
            h('button', { class: 'small', onclick: paste }, 'まとめて貼り付け')),
          h('p', { class: 'muted small' }, '空欄は未受験（欠席）として集計しません。Enter で次の人に進みます。'),
          students.length ? h('table', { class: 'list' },
            h('thead', {}, h('tr', {}, h('th', {}, '番号'), h('th', {}, '名前'), h('th', {}, '班'), h('th', {}, '得点'))),
            h('tbody', {}, rows)) : h('p', { class: 'muted' }, '生徒がまだ登録していません。'),
          error,
          h('div', { class: 'row', style: { position: 'sticky', bottom: 0, background: 'var(--surface)', padding: '10px 0' } },
            h('button', { class: 'primary', onclick: save }, '保存'))),
        results));
  }

  function editQuiz(q) {
    const title = h('input', { type: 'text', value: q ? q.title : '', placeholder: '例：第3回 小テスト（二次関数）' });
    const date = h('input', { type: 'date', value: q ? q.date : today() });
    const max = h('input', { type: 'number', inputmode: 'decimal', min: 1, value: q ? q.maxScore : 10 });
    const pub = h('input', { type: 'checkbox', checked: q ? q.published : false });
    const error = h('div', { class: 'error' });
    const m = modal(h('div', { class: 'stack' },
      h('h2', {}, q ? 'テストを編集' : '新しいテスト'),
      h('div', { class: 'field' }, h('label', {}, 'テスト名'), title),
      h('div', { class: 'row' },
        h('div', { class: 'field grow' }, h('label', {}, '実施日'), date),
        h('div', { class: 'field grow' }, h('label', {}, '満点'), max)),
      h('label', { class: 'check' }, pub, '生徒に公開する（生徒は自分の得点だけを見られます）'),
      error,
      h('div', { class: 'row' }, h('span', { class: 'grow' }),
        h('button', { onclick: () => m.close() }, 'キャンセル'),
        h('button', { class: 'primary', onclick: async (e) => {
          const v = { title: title.value, date: date.value, maxScore: max.value, published: pub.checked };
          e.currentTarget.disabled = true;
          try {
            if (q) {
              await store.updateQuiz(q.id, v);
            } else {
              ui.quizId = await store.createQuiz(v);
              ui.scoreDraft = {};
            }
            m.close();
            render();
          } catch (err) {
            error.textContent = err.message;
            e.target.disabled = false;
          }
        } }, q ? '保存' : '作って得点を入力'))));
    title.focus();
  }

  function downloadScoresCsv() {
    const list = [...store.quizzes()].reverse();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['出席番号', '名前', ...list.map((q) => `${q.title}（${q.date}・${q.maxScore}点）`)].map(esc).join(',')];
    for (const st of store.students()) {
      const cells = list.map((q) => store.state.scores.get(`${q.id}:${st.id}`)?.score ?? '');
      lines.push([st.number ?? '', st.name, ...cells].map(esc).join(','));
    }
    const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `小テスト_${today()}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
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

    // 出席番号をまとめて書き換えるときは、番号の欄が入力欄になる
    const numberEdit = !!ui.numberDraft;
    const numberInputs = [];
    const numberCell = (st, i) => {
      if (!numberEdit) return st.number ?? '—';
      const input = h('input', {
        type: 'text', inputmode: 'numeric', value: st.id in ui.numberDraft ? ui.numberDraft[st.id] : (st.number ?? ''),
        placeholder: '—', style: { width: '90px', padding: '6px 8px' },
        oninput: (e) => { ui.numberDraft[st.id] = e.target.value; },
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); numberInputs[i + 1]?.focus(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); numberInputs[i - 1]?.focus(); }
        },
      });
      numberInputs.push(input);
      return input;
    };
    const saveNumbers = run(async (e) => {
      const entries = students.map((st) => ({ studentId: st.id, number: st.id in ui.numberDraft ? ui.numberDraft[st.id] : st.number }));
      // 同じ番号が2人いたら知らせる（保存はしない）
      const seen = new Map();
      for (const x of entries) {
        const n = String(x.number ?? '').normalize('NFKC').trim();
        if (!n) continue;
        if (seen.has(n)) return toast(`出席番号 ${n} が2人います（${seen.get(n)}・${studentName(x.studentId)}）`);
        seen.set(n, studentName(x.studentId));
      }
      e.target.disabled = true;
      const changed = await store.updateNumbers(entries);
      ui.numberDraft = null;
      toast(changed ? `出席番号を保存しました（${changed}人）` : '変更はありません');
      render();
    });
    const studentName = (sid) => store.state.students.get(sid)?.name || '';

    const table = h('div', { class: 'card', style: { overflowX: 'auto' } },
      h('div', { class: 'row between' },
        h('h2', { style: { margin: 0 } }, `生徒（${students.length}人）`),
        students.length ? h('div', { class: 'row' }, numberEdit
          ? [h('button', { class: 'small primary', onclick: saveNumbers }, '出席番号を保存'),
            h('button', { class: 'small', onclick: () => { ui.numberDraft = null; render(); } }, 'やめる')]
          : h('button', { class: 'small', onclick: () => { ui.numberDraft = {}; render(); } }, '出席番号をまとめて編集')) : null),
      numberEdit ? h('p', { class: 'muted small' }, '番号を書き換えて「出席番号を保存」を押してください。Enter で次の人に進みます。空欄にすると番号なしになります。') : null,
      students.length ? h('table', { class: 'list', style: { marginTop: '8px' } },
        h('thead', {}, h('tr', {}, h('th', {}, '番号'), h('th', {}, '表示名'), h('th', {}, 'グループ'), h('th', {}, ''))),
        h('tbody', {}, students.map((st, i) => h('tr', {},
          h('td', {}, numberCell(st, i)),
          h('td', {}, st.name),
          h('td', {}, groupSelect(st)),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            h('button', { class: 'small', onclick: () => editStudent(st) }, '編集'),
            h('button', { class: 'small', onclick: run(async (e) => {
              if (!window.confirm(`${st.name} のパスワードを再設定しますか？`)) return;
              e.target.disabled = true;
              const r = await store.resetStudentPassword(st.id);
              e.target.disabled = false;
              showPassword(st.name, r.password, '新しいパスワード');
            }) }, 'パスワード再設定'),
            h('button', { class: 'small danger', onclick: run(async () => {
              if (window.confirm(`${st.name} をこのクラスから外しますか？ このクラスでの提出と小テストの得点も消えます（生徒のアカウントは残り、ほかのクラスはそのまま使えます）。`)) await store.deleteStudent(st.id);
            }) }, 'クラスから外す')))))) : h('p', { class: 'muted' }, 'まだ誰も登録していません。'));

    fill(view, join, h('div', { style: { height: '12px' } }), groupCard, h('div', { style: { height: '12px' } }), table);

    // 1人の名前と出席番号を変える
    function editStudent(st) {
      const name = h('input', { type: 'text', value: st.name, maxlength: 20 });
      const number = h('input', { type: 'text', inputmode: 'numeric', value: st.number ?? '', placeholder: '空欄なら番号なし' });
      const error = h('div', { class: 'error' });
      const m = modal(h('div', { class: 'stack' },
        h('h2', {}, '生徒の情報を変える'),
        h('div', { class: 'field' }, h('label', {}, '表示名',
          h('div', { class: 'help' }, '生徒がログインに使う名前も変わります。ほかのクラスにも入っている生徒は、そちらの名前も変わります。')), name),
        h('div', { class: 'field' }, h('label', {}, '出席番号', h('div', { class: 'help' }, '1〜4000。このクラスだけの番号です')), number),
        error,
        h('div', { class: 'row' },
          h('span', { class: 'grow' }),
          h('button', { onclick: () => m.close() }, 'キャンセル'),
          h('button', { class: 'primary', onclick: async (e) => {
            error.textContent = '';
            const n = String(number.value).normalize('NFKC').trim();
            const dup = n && store.students().find((x) => x.id !== st.id && String(x.number ?? '') === n);
            if (dup && !window.confirm(`出席番号 ${n} は ${dup.name} さんも使っています。このまま保存しますか？`)) return;
            e.currentTarget.disabled = true;
            try {
              await store.updateStudent(st.id, { name: name.value, number: n || null });
              m.close();
              toast('保存しました');
            } catch (err) {
              error.textContent = err.message;
              e.target.disabled = false;
            }
          } }, '保存'))));
      name.focus();
    }

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
    const st = store.state.settings;
    const isOwner = st.ownerUid === who.uid;
    const cls = h('input', { type: 'text', value: st.className });
    const cur = h('input', { type: 'password', placeholder: '今のパスワード', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', placeholder: '新しいパスワード', autocomplete: 'new-password' });

    // 担当の先生（共同担当）
    const coBox = h('div', { class: 'muted small' }, '読み込み中…');
    window.Store.listTeachers().then((teachers) => {
      const byUid = new Map(teachers.map((t) => [t.uid, t]));
      const label = (uid) => (byUid.get(uid) ? `${byUid.get(uid).name}（${byUid.get(uid).email}）` : '（登録が消えた先生）');
      const others = teachers.filter((t) => !st.teacherUids.includes(t.uid));
      const pick = h('select', { style: { width: 'auto' } }, h('option', { value: '' }, '先生を選ぶ'), others.map((t) => h('option', { value: t.uid }, `${t.name}（${t.email}）`)));
      fill(coBox,
        h('ul', { style: { margin: '0 0 8px', paddingLeft: '20px' } }, st.teacherUids.map((uid) => h('li', {},
          label(uid), uid === st.ownerUid ? '・クラスを作った先生' : '',
          isOwner && uid !== st.ownerUid ? h('button', { class: 'small danger', style: { marginLeft: '8px' }, onclick: run(async () => {
            if (!window.confirm(`${label(uid)} を担当から外しますか？`)) return;
            await store.setCoTeacher(uid, false);
            toast('担当から外しました');
          }) }, '外す') : null))),
        isOwner
          ? (others.length ? h('div', { class: 'row' }, pick, h('button', { class: 'small', onclick: run(async () => {
            if (!pick.value) return toast('先生を選んでください');
            await store.setCoTeacher(pick.value, true);
            toast('共同担当に加えました');
          }) }, '＋ 共同担当に加える')) : h('p', { class: 'muted small' }, 'ほかに登録している先生はいません。'))
          : h('p', { class: 'muted small' }, '担当の先生を変えられるのは、クラスを作った先生だけです。'));
    }).catch((e) => fill(coBox, e.message));

    const adminCard = who.admin ? h('div', { class: 'card', style: { maxWidth: '640px' } },
      h('h2', {}, '管理者：先生の招待'),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, 'この招待コードを渡した先生だけが、ログイン画面の「先生の登録」から登録できます。コードを作り直すと、古いコードは使えなくなります。'),
      (() => {
        const code = h('div', { class: 'code-big' }, '…');
        const list = h('div', { class: 'small' });
        window.Store.teacherInvite(false).then((c) => { code.textContent = c; });
        window.Store.listTeachers().then((ts) => fill(list, h('strong', {}, `登録している先生（${ts.length}人）`), h('ul', { style: { margin: '4px 0 0', paddingLeft: '20px' } }, ts.map((t) => h('li', {}, `${t.name}（${t.email}）`)))));
        return h('div', { class: 'stack' }, code,
          h('div', { class: 'small' }, '登録ページ：', h('a', { href: `${location.origin}/?teacher=1` }, `${location.origin}/?teacher=1`)),
          h('button', { class: 'small', onclick: run(async () => {
            if (!window.confirm('招待コードを作り直しますか？')) return;
            code.textContent = await window.Store.teacherInvite(true);
          }) }, '招待コードを作り直す'),
          list);
      })()) : null;

    fill(view,
      h('div', { class: 'card', style: { maxWidth: '640px' } },
        h('h2', {}, 'このクラスの設定'),
        h('div', { class: 'field' }, h('label', {}, 'クラス名'), h('div', { class: 'row' }, h('div', { class: 'grow' }, cls),
          h('button', { onclick: run(async () => { await store.updateSettings({ className: cls.value }); toast('保存しました'); }) }, '保存'))),
        h('div', { class: 'field' }, h('label', {}, '担当の先生'), coBox)),
      adminCard,
      h('div', { class: 'card', style: { maxWidth: '640px' } },
        h('h2', {}, 'アカウント'),
        h('div', { class: 'field' }, h('label', {}, '先生のパスワードを変える', h('div', { class: 'help' }, `ログイン用メールアドレス：${store.state.email}`)),
          h('div', { class: 'stack' }, cur, next),
          h('button', { style: { marginTop: '8px' }, onclick: run(async () => {
            await window.Store.changePassword(cur.value, next.value);
            toast('変更しました');
            cur.value = '';
            next.value = '';
          }) }, '変更')),
        h('div', { class: 'field' }, h('label', {}, 'ホーム画面・デスクトップに追加',
          h('div', { class: 'help' }, '先生の画面もアプリのように開けます。生徒のスマホには、課題一覧に追加の案内が出ます')),
        MB.install.standalone()
          ? h('p', { class: 'muted small' }, '追加済みのアプリで開いています')
          : h('button', { onclick: () => MB.install.prompt() }, '📲 追加する')),
        h('button', { class: 'danger', onclick: MB.logout }, 'ログアウト')));
  }

  // ---------- クラスの切り替え・作成 ----------

  const classKey = () => `mb-class:${who.uid}`;

  function chooseClass(id) {
    try { localStorage.setItem(classKey(), id); } catch { /* 無視 */ }
    location.reload();
  }

  async function createClassFlow() {
    const name = window.prompt('新しいクラスの名前（例：2年3組 数学Ⅱ）');
    if (!name) return;
    try {
      const id = await window.Store.createClass(who.uid, name);
      chooseClass(id);
    } catch (e) {
      toast(e.message);
    }
  }

  function classPicker(classes, closable) {
    const body = h('div', { class: 'stack' },
      h('h2', {}, 'クラスを選ぶ'),
      classes.length
        ? h('div', { class: 'stack' }, classes.map((c) => h('button', {
          class: `block${store && c.id === store.state.classId ? ' primary' : ''}`,
          style: { justifyContent: 'space-between' },
          onclick: () => chooseClass(c.id),
        }, h('span', {}, c.name), h('span', { class: 'small' }, c.ownerUid === who.uid ? '' : '共同担当'))))
        : h('p', { class: 'muted' }, 'まだクラスがありません。最初のクラスを作りましょう。'),
      h('button', { class: classes.length ? '' : 'primary', onclick: createClassFlow }, '＋ 新しいクラスを作る'));
    if (closable) {
      const m = modal(h('div', {}, body, h('div', { class: 'row', style: { marginTop: '12px' } }, h('span', { class: 'grow' }), h('button', { onclick: () => m.close() }, '閉じる'))));
    } else {
      fill(view, h('div', { class: 'card', style: { maxWidth: '520px', margin: '24px auto' } }, body));
    }
  }

  // ---------- タイマー ----------

  // 上の「⏱」ボタン。動いている間は残り時間（経過時間）を出す
  function startTimerButton() {
    const btn = $('#timer-btn');
    btn.addEventListener('click', openTimerPanel);
    MB.onTick(() => {
      const info = MB.timerInfo(store.state.timer);
      btn.textContent = info ? `⏱ ${info.done ? '時間です' : info.text}${info.paused ? '（停止中）' : ''}` : '⏱ タイマー';
      btn.classList.toggle('running', !!info && !info.paused && !info.done);
      btn.classList.toggle('done', !!info && info.done);
    });
  }

  function openTimerPanel() {
    const big = h('div', { style: { fontSize: '3rem', fontWeight: 800, textAlign: 'center', fontVariantNumeric: 'tabular-nums' } });
    const sub = h('div', { class: 'muted small', style: { textAlign: 'center' } });
    const controls = h('div', { class: 'row', style: { justifyContent: 'center' } });
    const label = h('input', { type: 'text', value: store.state.timer.label || '', placeholder: '表示する言葉（例：個人思考）', maxlength: 40 });
    const minutes = h('input', { type: 'number', min: 1, max: 180, value: 5, style: { width: '80px' } });
    const act = (action, value) => run(() => store.setTimer(action, value));
    const startTimer = (min) => run(async () => {
      await store.setTimer('label', label.value);
      await store.setTimer('timer', min * 60e3);
    });

    let lastKey = '';
    const paint = () => {
      const t = store.state.timer;
      const info = MB.timerInfo(t);
      big.textContent = info ? (info.done ? '時間です' : info.text) : '—:—';
      sub.textContent = !info ? '止まっています' : `${info.kind === 'timer' ? 'タイマー（残り）' : 'ストップウォッチ（経過）'}${info.paused ? '・一時停止中' : ''}`;
      const key = `${t.state}:${t.kind}`;
      if (key === lastKey) return;
      lastKey = key;
      fill(controls,
        t.state === 'running' ? h('button', { onclick: act('pause') }, '⏸ 一時停止') : null,
        t.state === 'paused' ? h('button', { class: 'primary', onclick: act('resume') }, '▶ 再開') : null,
        t.state !== 'stopped' && t.kind === 'timer' ? h('button', { onclick: act('add', 60e3) }, '＋1分') : null,
        t.state !== 'stopped' && t.kind === 'timer' ? h('button', { onclick: act('add', -60e3) }, '−1分') : null,
        t.state !== 'stopped' ? h('button', { class: 'danger', onclick: act('stop') }, '■ 終わる（消す）') : null);
    };
    const offTick = MB.onTick(paint);
    paint();

    const m = modal(h('div', { class: 'stack' },
      h('h2', {}, '⏱ タイマー・ストップウォッチ'),
      h('p', { class: 'muted small', style: { margin: 0 } }, '動かすと、提示画面と生徒全員の画面の上に表示されます。'),
      big, sub, controls,
      h('div', { class: 'field' }, h('label', {}, '表示する言葉'), h('div', { class: 'row' }, h('div', { class: 'grow' }, label),
        h('button', { class: 'small', onclick: () => act('label', label.value)() }, '変える'))),
      h('div', { class: 'field' }, h('label', {}, 'タイマーを始める'),
        h('div', { class: 'row' },
          [1, 3, 5, 10, 15].map((n) => h('button', { onclick: startTimer(n) }, `${n}分`)),
          h('span', { class: 'muted' }, 'または'), minutes, h('span', {}, '分'),
          h('button', { class: 'primary', onclick: () => {
            const n = Number(minutes.value);
            if (!(n > 0 && n <= 180)) return toast('1〜180分で入力してください');
            return startTimer(n)();
          } }, '開始'))),
      h('div', { class: 'field' }, h('label', {}, 'ストップウォッチ'),
        h('button', { onclick: run(async () => {
          await store.setTimer('label', label.value);
          await store.setTimer('stopwatch');
        }) }, '▶ 0から計る')),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { onclick: () => m.close() }, '閉じる'))), { onClose: offTick });
  }

  // ---------- 起動 ----------

  (async () => {
    who = await window.Store.whoami();
    if (who.role !== 'teacher') {
      location.href = who.role === 'student' ? '/student' : '/';
      return;
    }
    try { ui.tab = sessionStorage.getItem('mb-tab') || 'progress'; } catch { /* 無視 */ }
    let classes = [];
    try {
      classes = await window.Store.teacherClasses(who.uid);
    } catch (e) {
      fill(view, h('div', { class: 'card error' }, `クラスを読み込めませんでした：${e.message}`));
      return;
    }
    // 開くたびに読み直す（共同担当に加えられたクラスもすぐ出るように）
    $('#class-btn').addEventListener('click', async () => {
      try { classes = await window.Store.teacherClasses(who.uid); } catch { /* 前の一覧を使う */ }
      classPicker(classes, true);
    });
    let saved = null;
    try { saved = localStorage.getItem(classKey()); } catch { /* 無視 */ }
    const current = classes.find((c) => c.id === saved) || (classes.length === 1 ? classes[0] : null);
    if (!current) {
      $('#timer-btn').classList.add('hidden');
      classPicker(classes, false);
      return;
    }
    $('#present-link').href = `/present?class=${encodeURIComponent(current.id)}`;
    store = window.Store.teacherStore(who, current.id);
    startTimerButton();
    fill(view, h('p', { class: 'muted' }, '読み込み中…'));
    store.on((types) => {
      MB.showErrors(store.state.errors);
      if (!store.state.ready) return;
      // タイマーの数字は startTimerButton が進めるので、画面全体は描き直さない
      if (types.size === 1 && types.has('timer')) return;
      $('#class-name').textContent = store.state.settings.className;
      $('#class-btn').textContent = 'クラス ▾';
      $('#live').classList.add('on');
      // 入力欄やダイアログを使っている間は描き直さない（入力が消えないように）
      const active = document.activeElement;
      const typing = active && view.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
      if ($('.modal-back') || typing) {
        renderTabs();
        pendingRender = true;
      } else {
        render();
      }
    });
    let pendingRender = false;
    document.addEventListener('mb-modal-closed', () => {
      if (!pendingRender || $('.modal-back')) return;
      pendingRender = false;
      render();
    });
    window.addEventListener('offline', () => $('#live').classList.remove('on'));
    window.addEventListener('online', () => $('#live').classList.add('on'));
  })();
})();
