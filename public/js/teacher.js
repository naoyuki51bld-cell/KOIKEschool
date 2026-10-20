(function () {
  const { api, h, $, toast, rich, fileUrl, modal, compressImage, listen, debounce, statusBadge, STATUS_LABEL } = MB;
  const view = $('#view');
  const tabsEl = $('#tabs');

  const state = {
    tab: 'progress',
    settings: null,
    students: [],
    groups: [],
    tasks: [],
    progress: null,
    present: { taskId: null, submissionIds: [], showNames: false },
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

  function renderTabs() {
    const helpCount = state.progress ? state.progress.help.length : 0;
    MB.fill(tabsEl, ...TABS.map(([key, label]) => h('button', {
      class: state.tab === key ? 'on' : '',
      onclick: () => {
        state.tab = key;
        try { sessionStorage.setItem('mb-tab', key); } catch { /* 無視 */ }
        render();
      },
    }, label, key === 'progress' && helpCount ? h('span', { class: 'badge help' }, `🙋${helpCount}`) : null)));
  }

  function render() {
    renderTabs();
    const fn = { progress: renderProgress, answers: renderAnswers, tasks: renderTasks, students: renderStudents, settings: renderSettings }[state.tab];
    fn();
  }

  // ---------- データの読み込み ----------

  async function loadAll() {
    const [settings, students, groups, tasks, progress, present] = await Promise.all([
      api('GET', '/api/teacher/settings'),
      api('GET', '/api/teacher/students'),
      api('GET', '/api/teacher/groups'),
      api('GET', '/api/teacher/tasks'),
      api('GET', '/api/teacher/progress'),
      api('GET', '/api/teacher/present'),
    ]);
    Object.assign(state, { settings, students, groups, tasks, progress, present });
  }

  const groupName = (id) => (state.groups.find((g) => g.id === id) || {}).name || '';
  const taskById = (id) => state.tasks.find((t) => t.id === id);

  function submissionFor(task, student) {
    const p = state.progress;
    if (task.mode === 'group') {
      if (!student.groupId) return null;
      return p.submissions.find((s) => s.taskId === task.id && s.ownerType === 'group' && s.ownerId === student.groupId) || null;
    }
    return p.submissions.find((s) => s.taskId === task.id && s.ownerType === 'user' && s.ownerId === student.id) || null;
  }

  function cellKey(s) {
    if (!s) return 'none';
    if (s.status === 'submitted' && s.autoCorrect === 0) return 'wrong';
    return s.status;
  }

  // ---------- 進捗 ----------

  function renderProgress() {
    const p = state.progress;
    const tasks = p.tasks.filter((t) => state.showClosed || t.status === 'open');
    const students = [...p.students];
    if (state.boardSort === 'group') {
      const order = new Map(p.groups.map((g, i) => [g.id, i]));
      students.sort((a, b) => (order.get(a.groupId) ?? 999) - (order.get(b.groupId) ?? 999) || (a.number ?? 999) - (b.number ?? 999));
    }
    const helpBy = new Map(p.help.map((x) => [`${x.userId}:${x.taskId}`, x]));
    const nameOf = (id) => (p.students.find((s) => s.id === id) || {}).name || '?';

    const helpBox = p.help.length
      ? h('div', { class: 'card', style: { marginBottom: '12px' } },
        h('h3', {}, `🙋 ヘルプ（${p.help.length}人）`),
        h('div', { class: 'help-list' }, [...p.help].sort((a, b) => a.createdAt - b.createdAt).map((x) => h('span', { class: 'help-chip' },
          `${nameOf(x.userId)}：${(p.tasks.find((t) => t.id === x.taskId) || {}).title || ''}${x.message ? `「${x.message}」` : ''}`,
          h('button', { class: 'small', onclick: async () => { await api('DELETE', `/api/teacher/help/${x.userId}/${x.taskId}`); } }, '対応済')))))
      : null;

    const head = h('tr', {}, h('th', {}, '名前'), tasks.map((t) => {
      const owners = t.mode === 'group' ? p.groups.length : p.students.length;
      const subs = p.submissions.filter((s) => s.taskId === t.id);
      const cleared = subs.filter((s) => s.status === 'cleared').length;
      const submitted = subs.length;
      const pct = (n) => (owners ? `${(n / owners) * 100}%` : '0');
      return h('th', { title: t.title },
        h('div', { class: 'tt' }, t.title),
        h('div', { class: 'row small muted', style: { gap: '4px', fontWeight: 400 } },
          t.mode === 'group' ? '班' : '個', t.status === 'closed' ? '・締切' : '', `・✓${cleared}/${owners}`),
        h('div', { class: 'meter' },
          h('i', { style: { width: pct(cleared), background: 'var(--good)' } }),
          h('i', { style: { width: pct(submitted - cleared), background: 'var(--info)' } })));
    }));

    const body = students.map((st) => h('tr', {},
      h('th', {}, st.number ? h('span', { class: 'muted small' }, `${st.number} `) : null, st.name,
        st.groupId ? h('span', { class: 'muted small' }, ` ${groupName(st.groupId)}`) : null),
      tasks.map((t) => {
        const s = submissionFor(t, st);
        const key = cellKey(s);
        const help = helpBy.get(`${st.id}:${t.id}`);
        const label = { none: '—', submitted: '提出', cleared: '✓', retry: '再', wrong: '✗' }[key];
        const tip = [STATUS_LABEL[key], s && s.confidence ? `自信:${CONF_LABEL[s.confidence]}` : '', s ? `${s.attempts}回` : '', help ? `ヘルプ${help.message ? `「${help.message}」` : ''}` : '']
          .filter(Boolean).join(' / ');
        return h('td', {}, h('button', {
          class: `cell-${key}${help ? ' cell-help' : ''}`,
          title: tip,
          onclick: () => (s ? openSubmission(s.id, t.id) : toast(`${st.name}：まだ提出していません`)),
        }, label, s && s.confidence ? h('sup', { class: 'muted', style: { fontWeight: 400 } }, s.confidence) : null));
      })));

    const legend = h('div', { class: 'legend small' },
      h('span', { class: 'badge none' }, '— 未提出'),
      h('span', { class: 'badge submitted' }, '提出 提出済'),
      h('span', { class: 'badge wrong' }, '✗ 自動判定で不正解'),
      h('span', { class: 'badge retry' }, '再 再提出待ち'),
      h('span', { class: 'badge cleared' }, '✓ クリア'),
      h('span', { class: 'muted' }, '右上の数字＝自信（1 わからない〜4 自信あり）'));

    MB.fill(view, 
      helpBox,
      h('div', { class: 'row between', style: { marginBottom: '8px' } },
        h('div', { class: 'row' },
          h('div', { class: 'seg' },
            h('button', { class: state.boardSort === 'number' ? 'on' : '', onclick: () => { state.boardSort = 'number'; render(); } }, '出席番号順'),
            h('button', { class: state.boardSort === 'group' ? 'on' : '', onclick: () => { state.boardSort = 'group'; render(); } }, 'グループ順')),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.showClosed, onchange: (e) => { state.showClosed = e.target.checked; render(); } }), '締切済みの課題も表示')),
        h('a', { class: 'btn small', href: '/api/teacher/export.csv' }, 'CSVで保存')),
      tasks.length && students.length
        ? h('div', { class: 'board-wrap' }, h('table', { class: 'board' }, h('thead', {}, head), h('tbody', {}, body)))
        : h('div', { class: 'card muted' }, !students.length ? '生徒がまだ登録していません。「生徒・グループ」タブの参加コードを生徒に伝えてください。' : '公開中の課題がありません。「課題」タブで課題を作って公開してください。'),
      legend);
  }

  // ---------- 提出の詳細 ----------

  async function openSubmission(submissionId, taskId) {
    const subs = await api('GET', `/api/teacher/tasks/${taskId}/submissions`);
    const s = subs.find((x) => x.id === submissionId);
    if (!s) return toast('提出が見つかりません');
    const t = taskById(taskId);
    const fb = h('textarea', { placeholder: '生徒へのコメント（生徒の画面に表示されます）' });
    fb.value = s.feedback;
    const save = async (status) => {
      await api('PATCH', `/api/teacher/submissions/${s.id}`, { status, feedback: fb.value });
      toast('保存しました');
      m.close();
    };
    const m = modal(h('div', { class: 'stack' },
      h('div', { class: 'row between' },
        h('h2', { style: { margin: 0 } }, s.ownerName),
        statusBadge(s.status, s.autoCorrect)),
      h('div', { class: 'muted small' }, `${t ? t.title : ''}・提出 ${s.attempts} 回・${MB.timeAgo(s.updatedAt)}`,
        s.confidence ? `・自信：${CONF_LABEL[s.confidence]}` : '',
        s.ownerType === 'group' && s.lastEditor ? `・最後に提出：${s.lastEditor}` : '',
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
    return h('div', { class: 'stack' },
      s.shortAnswer ? h('div', { class: 'short' }, '答え：', s.shortAnswer, s.autoCorrect === 1 ? ' ○' : s.autoCorrect === 0 ? ' ×' : '') : null,
      s.text ? rich(s.text) : null,
      s.drawing ? h('img', { class: 'answer-image', src: fileUrl(s.drawing), alt: '手書き', style: large ? {} : { maxHeight: '260px', objectFit: 'contain' } }) : null,
      s.photo ? h('img', { class: 'answer-image', src: fileUrl(s.photo), alt: '写真', style: large ? {} : { maxHeight: '260px', objectFit: 'contain' } }) : null);
  }

  // ---------- 回答 ----------

  async function renderAnswers() {
    const usable = state.tasks.filter((t) => t.status !== 'draft');
    if (!usable.length) {
      MB.fill(view, h('div', { class: 'card muted' }, '公開した課題がまだありません。'));
      return;
    }
    if (!usable.find((t) => t.id === state.answersTaskId)) {
      const open = usable.filter((t) => t.status === 'open');
      state.answersTaskId = (open[open.length - 1] || usable[usable.length - 1]).id;
    }
    const t = taskById(state.answersTaskId);
    const subs = await api('GET', `/api/teacher/tasks/${t.id}/submissions`);
    if (state.tab !== 'answers') return;

    const present = state.present;
    const selected = new Set(present.taskId === t.id ? present.submissionIds : []);
    const setPresent = async (patch) => {
      const next = { ...present, ...patch };
      state.present = await api('PUT', '/api/teacher/present', next);
      renderAnswers();
    };
    const toggleSelect = (id) => {
      const ids = present.taskId === t.id ? [...present.submissionIds] : [];
      const i = ids.indexOf(id);
      if (i >= 0) ids.splice(i, 1);
      else {
        if (ids.length >= 8) return toast('提示できるのは8件までです');
        ids.push(id);
      }
      setPresent({ taskId: t.id, submissionIds: ids });
    };

    const filters = {
      all: ['すべて', () => true],
      notCleared: ['未クリア', (s) => s.status !== 'cleared'],
      cleared: ['クリア', (s) => s.status === 'cleared'],
      retry: ['再提出待ち', (s) => s.status === 'retry'],
      lowConf: ['自信なし(1-2)', (s) => s.confidence && s.confidence <= 2],
    };
    let list = subs.filter(filters[state.answersFilter][1]);
    if (state.answersSort === 'likes') list = [...list].sort((a, b) => b.likes - a.likes);
    if (state.answersSort === 'new') list = [...list].sort((a, b) => b.updatedAt - a.updatedAt);

    // 未提出
    const submittedOwners = new Set(subs.map((s) => `${s.ownerType}:${s.ownerId}`));
    const missing = t.mode === 'group'
      ? state.groups.filter((g) => !submittedOwners.has(`group:${g.id}`)).map((g) => g.name)
      : state.students.filter((s) => !submittedOwners.has(`user:${s.id}`)).map((s) => s.name);

    const quick = (s, status) => async () => {
      await api('PATCH', `/api/teacher/submissions/${s.id}`, { status });
      renderAnswers();
    };

    const cards = list.map((s) => h('div', { class: `card answer-card${selected.has(s.id) ? ' selected' : ''}` },
      h('div', { class: 'row between' },
        h('strong', {}, s.ownerName),
        h('div', { class: 'row', style: { gap: '4px' } },
          s.likes ? h('span', { class: 'badge' }, `♥${s.likes}`) : null,
          s.confidence ? h('span', { class: 'badge', title: '自信' }, CONF_LABEL[s.confidence]) : null,
          statusBadge(s.status, s.autoCorrect))),
      answerContent(s, false),
      s.feedback ? h('div', { class: 'feedback small' }, 'コメント：', s.feedback) : null,
      h('div', { class: 'row', style: { marginTop: 'auto' } },
        s.status !== 'cleared' ? h('button', { class: 'small good', onclick: quick(s, 'cleared') }, '✓ クリア') : null,
        s.status !== 'retry' ? h('button', { class: 'small', onclick: quick(s, 'retry') }, '再提出') : null,
        h('button', { class: 'small', onclick: () => openSubmission(s.id, t.id) }, 'コメント'),
        h('span', { class: 'grow' }),
        h('button', { class: `small${selected.has(s.id) ? ' primary' : ''}`, onclick: () => toggleSelect(s.id) }, selected.has(s.id) ? '提示中' : '提示に選ぶ'))));

    MB.fill(view, 
      h('div', { class: 'card', style: { marginBottom: '12px' } },
        h('div', { class: 'row' },
          h('select', { style: { maxWidth: '360px' }, onchange: (e) => { state.answersTaskId = Number(e.target.value); renderAnswers(); } },
            usable.map((x) => h('option', { value: x.id, selected: x.id === t.id }, `${x.status === 'closed' ? '［締切］' : ''}${x.title}`))),
          h('span', { class: `badge ${t.status}` }, t.status === 'open' ? '受付中' : '締切'),
          h('span', { class: 'badge' }, t.mode === 'group' ? 'グループ' : '個人'),
          h('span', { class: 'badge' }, `生徒同士：${PEER_LABEL[t.peerView]}`),
          h('span', { class: 'grow' }),
          h('button', { class: 'small', onclick: () => updateTask(t, { status: t.status === 'open' ? 'closed' : 'open' }) }, t.status === 'open' ? '締め切る' : '受付を再開'),
          t.hint ? h('button', { class: 'small', onclick: () => updateTask(t, { hintOpen: !t.hintOpen }) }, t.hintOpen ? 'ヒントを隠す' : 'ヒントを出す') : null,
          h('select', { style: { width: 'auto' }, onchange: (e) => updateTask(t, { peerView: e.target.value }) },
            Object.entries(PEER_LABEL).map(([k, v]) => h('option', { value: k, selected: t.peerView === k }, `生徒同士：${v}`)))),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('div', { class: 'seg' }, Object.entries(filters).map(([k, [label]]) => h('button', {
            class: state.answersFilter === k ? 'on' : '',
            onclick: () => { state.answersFilter = k; renderAnswers(); },
          }, label))),
          h('select', { style: { width: 'auto' }, onchange: (e) => { state.answersSort = e.target.value; renderAnswers(); } },
            h('option', { value: 'time', selected: state.answersSort === 'time' }, '最初の提出順'),
            h('option', { value: 'new', selected: state.answersSort === 'new' }, '新しい順'),
            h('option', { value: 'likes', selected: state.answersSort === 'likes' }, '♥が多い順')),
          h('span', { class: 'grow' }),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: present.showNames, onchange: (e) => setPresent({ showNames: e.target.checked }) }), '提示画面に名前を出す'),
          selected.size ? h('button', { class: 'small', onclick: () => setPresent({ submissionIds: [] }) }, `提示をやめる（${selected.size}件）`) : null,
          h('a', { class: 'btn small primary', href: '/present', target: 'mb-present' }, '提示画面 ↗')),
        h('p', { class: 'muted small', style: { margin: '8px 0 0' } },
          `提出 ${subs.length} / ${t.mode === 'group' ? state.groups.length : state.students.length}・クリア ${subs.filter((s) => s.status === 'cleared').length}`,
          missing.length ? `・未提出：${missing.join('、')}` : '')),
      list.length ? h('div', { class: 'answers' }, cards) : h('div', { class: 'card muted' }, '該当する回答はありません。'));
  }

  async function updateTask(t, patch) {
    try {
      await api('PATCH', `/api/teacher/tasks/${t.id}`, patch);
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- 課題 ----------

  function renderTasks() {
    const rows = state.tasks.map((t, i) => h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', { class: 'grow', style: { minWidth: '200px' } },
          h('strong', {}, t.title),
          h('div', { class: 'row', style: { gap: '4px', marginTop: '4px' } },
            h('span', { class: `badge ${t.status}` }, { draft: '下書き', open: '受付中', closed: '締切' }[t.status]),
            h('span', { class: 'badge' }, t.mode === 'group' ? 'グループ' : '個人'),
            h('span', { class: 'badge' }, t.answerKind === 'short' ? `短答（自動判定：${t.accepted.answers.join(' / ') || '正解未設定'}）` : '記述'),
            h('span', { class: 'badge' }, `生徒同士：${PEER_LABEL[t.peerView]}`),
            t.hint ? h('span', { class: `badge ${t.hintOpen ? 'open' : ''}` }, t.hintOpen ? 'ヒント公開中' : 'ヒントあり') : null,
            t.status !== 'draft' ? h('span', { class: 'muted small' }, `提出 ${t.submitted}・クリア ${t.cleared}`) : null)),
        h('div', { class: 'row' },
          h('div', { class: 'seg' }, [['draft', '下書き'], ['open', '公開'], ['closed', '締切']].map(([k, v]) => h('button', {
            class: t.status === k ? 'on' : '',
            onclick: () => updateTask(t, { status: k }),
          }, v))),
          h('button', { class: 'small', onclick: () => editTask(t) }, '編集'),
          h('button', { class: 'small', onclick: () => { state.tab = 'answers'; state.answersTaskId = t.id; render(); } }, '回答'),
          h('button', { class: 'small icon', title: '上へ', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          h('button', { class: 'small icon', title: '下へ', disabled: i === state.tasks.length - 1, onclick: () => move(i, 1) }, '↓'),
          h('button', { class: 'small', onclick: async () => { await api('POST', `/api/teacher/tasks/${t.id}/duplicate`); toast('複製しました（下書き）'); } }, '複製'),
          h('button', { class: 'small danger', onclick: async () => {
            if (!window.confirm(`「${t.title}」を削除しますか？ 生徒の提出もすべて消えます。`)) return;
            await api('DELETE', `/api/teacher/tasks/${t.id}`);
          } }, '削除')))));

    async function move(i, d) {
      const ids = state.tasks.map((t) => t.id);
      [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
      await api('POST', '/api/teacher/tasks/reorder', { ids });
    }

    MB.fill(view, 
      h('div', { class: 'row between', style: { marginBottom: '12px' } },
        h('h1', { style: { margin: 0 } }, '課題'),
        h('button', { class: 'primary', onclick: () => editTask(null) }, '＋ 新しい課題')),
      rows.length ? h('div', {}, rows) : h('div', { class: 'card muted' }, 'まだ課題がありません。「＋ 新しい課題」から作りましょう。'));
  }

  function editTask(t) {
    const v = t ? JSON.parse(JSON.stringify(t)) : {
      title: '', body: '', mode: 'individual', answerKind: 'free', accepted: { answers: [], mode: 'value' }, showResult: true,
      allowText: true, allowDraw: true, allowPhoto: true, peerView: 'off', hint: '', hintOpen: false, status: 'draft', image: null,
    };
    let image; // undefined = 変更なし
    const title = h('input', { type: 'text', value: v.title, placeholder: '例：三角形の内角の和' });
    const body = h('textarea', { placeholder: '問題文。$\\frac{1}{2}$ のように $ で囲むと数式になります', style: { minHeight: '140px' } });
    body.value = v.body;
    const preview = h('div', { class: 'preview' });
    const upd = debounce(() => MB.fill(preview, rich(body.value || '（問題文のプレビュー）')), 250);
    body.addEventListener('input', upd);
    upd();

    const imgBox = h('div');
    const paintImg = () => {
      const src = image === undefined ? fileUrl(v.image) : image || null;
      MB.fill(imgBox, ...(src ? [h('img', { class: 'task-image', src, style: { maxHeight: '200px' } })] : []));
    };
    paintImg();
    const imgInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async () => {
      if (imgInput.files[0]) image = await compressImage(imgInput.files[0], 1800, 0.85);
      paintImg();
    } });

    const radio = (name, options, value) => h('div', { class: 'seg' }, options.map(([k, label]) => h('button', {
      type: 'button',
      class: value === k ? 'on' : '',
      'data-value': k,
      onclick: (e) => {
        [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget));
        v[name] = k;
        refreshKind();
      },
    }, label)));

    const accepted = h('textarea', { placeholder: '1行に1つ。例：\n2√3\n√12', style: { minHeight: '70px' } });
    accepted.value = v.accepted.answers.join('\n');
    const exact = h('input', { type: 'checkbox', checked: v.accepted.mode === 'exact' });
    const showResult = h('input', { type: 'checkbox', checked: v.showResult });
    const shortBox = h('div', { class: 'card', style: { boxShadow: 'none', background: 'var(--surface-2)' } },
      h('div', { class: 'field' }, h('label', {}, '正解', h('div', { class: 'help' }, '「2√3」と「√12」「3.464…」、「(x+1)^2」と「x^2+2x+1」のように値が等しい答えも正解にします')), accepted),
      h('label', { class: 'check' }, exact, '書いた形と完全に同じときだけ正解（因数分解の形を問うときなど）'),
      h('label', { class: 'check' }, showResult, '正解・不正解を生徒にすぐ見せる'));
    const refreshKind = () => shortBox.classList.toggle('hidden', v.answerKind !== 'short');

    const allowText = h('input', { type: 'checkbox', checked: v.allowText });
    const allowDraw = h('input', { type: 'checkbox', checked: v.allowDraw });
    const allowPhoto = h('input', { type: 'checkbox', checked: v.allowPhoto });
    const peer = h('select', {}, Object.entries(PEER_LABEL).map(([k, label]) => h('option', { value: k, selected: v.peerView === k }, label)));
    const hint = h('textarea', { placeholder: '（任意）授業中に「ヒントを出す」を押すと生徒に表示されます', style: { minHeight: '60px' } });
    hint.value = v.hint;
    const error = h('div', { class: 'error' });

    const save = async (status) => {
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
      try {
        if (t) {
          await api('PATCH', `/api/teacher/tasks/${t.id}`, payload);
          const answersChanged = t.answerKind === 'short' && JSON.stringify(t.accepted) !== JSON.stringify(payload.accepted);
          if (answersChanged && t.submitted && window.confirm('正解が変わりました。提出済みの答えを判定し直しますか？')) {
            const r = await api('POST', `/api/teacher/tasks/${t.id}/rejudge`);
            toast(`判定し直しました（${r.changed}件変更）`);
          }
        } else {
          await api('POST', '/api/teacher/tasks', payload);
        }
        m.close();
        toast('保存しました');
      } catch (e) {
        error.textContent = e.message;
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
        h('button', { onclick: () => save() }, '保存'),
        v.status !== 'open' ? h('button', { class: 'primary', onclick: () => save('open') }, '保存して公開') : null)), { wide: true });
    refreshKind();
    title.focus();
  }

  // ---------- 生徒・グループ ----------

  function renderStudents() {
    const s = state.settings;
    const joinUrl = `${location.origin}/?join=${encodeURIComponent(s.joinCode)}`;
    const qr = h('div', { class: 'qr' });
    fetch('/api/teacher/join-qr.svg').then((r) => r.text()).then((svg) => { qr.innerHTML = svg; });

    const join = h('div', { class: 'card' },
      h('h2', {}, '生徒の登録'),
      h('div', { class: 'row', style: { gap: '24px', alignItems: 'flex-start' } },
        qr,
        h('div', { class: 'stack grow' },
          h('div', {}, h('div', { class: 'muted small' }, '参加コード'), h('div', { class: 'code-big' }, s.joinCode)),
          h('div', { class: 'small' }, 'URL：', h('a', { href: joinUrl }, joinUrl)),
          h('p', { class: 'small muted', style: { margin: 0 } }, '生徒はQRコードを読み取るか、URLを開いて参加コードを入力し、自分で決めた表示名とパスワードで登録します。2回目からは表示名とパスワードでログインします。'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.registrationOpen, onchange: async (e) => {
            await api('PUT', '/api/teacher/settings', { registrationOpen: e.target.checked });
            toast(e.target.checked ? '新規登録を受け付けます' : '新規登録を締め切りました');
          } }), '新規登録を受け付ける（全員そろったら外すと安心です）'),
          h('div', { class: 'row' },
            h('button', { class: 'small', onclick: async () => {
              if (!window.confirm('参加コードを作り直しますか？ 古いコードでは登録できなくなります（登録済みの生徒には影響しません）。')) return;
              await api('PUT', '/api/teacher/settings', { regenerateJoinCode: true });
            } }, '参加コードを作り直す'),
            h('button', { class: 'small', onclick: addStudent }, '＋ 先生が生徒を追加')))));

    const groupSelect = (st) => h('select', {
      style: { width: 'auto' },
      onchange: async (e) => { await api('PATCH', `/api/teacher/students/${st.id}`, { groupId: Number(e.target.value) || null }); },
    }, h('option', { value: '' }, '（なし）'), state.groups.map((g) => h('option', { value: g.id, selected: st.groupId === g.id }, g.name)));

    const groups = h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('h2', { style: { margin: 0 } }, `グループ（${state.groups.length}）`),
        h('div', { class: 'row' },
          h('button', { class: 'small', onclick: async () => { await api('POST', '/api/teacher/groups', {}); } }, '＋ グループを追加'),
          h('button', { class: 'small', onclick: async () => {
            const size = window.prompt('1グループ何人にしますか？（今のグループと、グループ課題の提出はリセットされます）', '4');
            if (!size) return;
            await api('POST', '/api/teacher/groups/auto', { size: Number(size) });
            toast('ランダムにグループ分けしました');
          } }, 'ランダムに分ける'))),
      h('div', { class: 'row', style: { marginTop: '12px', alignItems: 'flex-start' } }, state.groups.map((g) => {
        const members = state.students.filter((st) => st.groupId === g.id);
        return h('div', { class: 'card', style: { boxShadow: 'none', minWidth: '180px', margin: 0 } },
          h('div', { class: 'row between' },
            h('strong', {}, g.name),
            h('div', { class: 'row', style: { gap: '2px' } },
              h('button', { class: 'small icon', title: '名前を変える', onclick: async () => {
                const name = window.prompt('グループ名', g.name);
                if (name) await api('PATCH', `/api/teacher/groups/${g.id}`, { name });
              } }, '✎'),
              h('button', { class: 'small icon danger', title: '削除', onclick: async () => {
                if (window.confirm(`${g.name}を削除しますか？ このグループの提出も消えます。`)) await api('DELETE', `/api/teacher/groups/${g.id}`);
              } }, '×'))),
          h('div', { class: 'small' }, members.length ? members.map((x) => x.name).join('、') : h('span', { class: 'muted' }, 'メンバーなし')));
      })),
      state.students.some((st) => !st.groupId) && state.groups.length
        ? h('p', { class: 'small muted' }, `グループなし：${state.students.filter((st) => !st.groupId).map((x) => x.name).join('、')}`)
        : null);

    const table = h('div', { class: 'card', style: { overflowX: 'auto' } },
      h('h2', {}, `生徒（${state.students.length}人）`),
      state.students.length ? h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, '番号'), h('th', {}, '表示名'), h('th', {}, 'グループ'), h('th', {}, ''))),
        h('tbody', {}, state.students.map((st) => h('tr', {},
          h('td', {}, st.number ?? '—'),
          h('td', {}, st.name),
          h('td', {}, groupSelect(st)),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            h('button', { class: 'small', onclick: async () => {
              const name = window.prompt('表示名', st.name);
              if (name === null) return;
              const number = window.prompt('出席番号（空欄可）', st.number ?? '');
              if (number === null) return;
              try { await api('PATCH', `/api/teacher/students/${st.id}`, { name, number: number || null }); } catch (e) { toast(e.message); }
            } }, '編集'),
            h('button', { class: 'small', onclick: async () => {
              if (!window.confirm(`${st.name} のパスワードを再設定しますか？`)) return;
              const r = await api('POST', `/api/teacher/students/${st.id}/reset-password`);
              modal(h('div', { class: 'stack' }, h('h2', {}, '新しいパスワード'), h('p', {}, `${st.name} さんの新しいパスワード：`), h('div', { class: 'code-big' }, r.password),
                h('p', { class: 'muted small' }, 'ログイン後、生徒が自分でメニューから変更できます。')));
            } }, 'パスワード再設定'),
            h('button', { class: 'small danger', onclick: async () => {
              if (window.confirm(`${st.name} を削除しますか？ この生徒の個人提出も消えます。`)) await api('DELETE', `/api/teacher/students/${st.id}`);
            } }, '削除')))))) : h('p', { class: 'muted' }, 'まだ誰も登録していません。'));

    MB.fill(view, join, h('div', { style: { height: '12px' } }), groups, h('div', { style: { height: '12px' } }), table);
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
        h('button', { class: 'primary', onclick: async () => {
          try {
            const r = await api('POST', '/api/teacher/students', { name: name.value, number: number.value || null });
            m.close();
            modal(h('div', { class: 'stack' }, h('h2', {}, '追加しました'), h('p', {}, `${name.value} さんのパスワード：`), h('div', { class: 'code-big' }, r.password)));
          } catch (e) { error.textContent = e.message; }
        } }, '追加'))));
    name.focus();
  }

  // ---------- 設定 ----------

  function renderSettings() {
    const cls = h('input', { type: 'text', value: state.settings.className });
    const cur = h('input', { type: 'password', placeholder: '今のパスワード', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', placeholder: '新しいパスワード', autocomplete: 'new-password' });
    MB.fill(view, h('div', { class: 'card', style: { maxWidth: '560px' } },
      h('h2', {}, '設定'),
      h('div', { class: 'field' }, h('label', {}, 'クラス名'), h('div', { class: 'row' }, h('div', { class: 'grow' }, cls),
        h('button', { onclick: async () => { await api('PUT', '/api/teacher/settings', { className: cls.value }); toast('保存しました'); } }, '保存'))),
      h('div', { class: 'field' }, h('label', {}, '先生のパスワードを変える'), h('div', { class: 'stack' }, cur, next),
        h('button', { style: { marginTop: '8px' }, onclick: async () => {
          try {
            await api('POST', '/api/me/password', { current: cur.value, next: next.value });
            toast('変更しました');
            cur.value = '';
            next.value = '';
          } catch (e) { toast(e.message); }
        } }, '変更')),
      h('button', { class: 'danger', onclick: MB.logout }, 'ログアウト')));
  }

  // ---------- リアルタイム更新 ----------

  const dirty = new Set();
  const reload = debounce(async () => {
    const types = new Set(dirty);
    dirty.clear();
    const all = types.has('resume');
    const jobs = [];
    if (all || types.has('settings')) jobs.push(api('GET', '/api/teacher/settings').then((x) => { state.settings = x; }));
    if (all || types.has('students')) {
      jobs.push(api('GET', '/api/teacher/students').then((x) => { state.students = x; }));
      jobs.push(api('GET', '/api/teacher/groups').then((x) => { state.groups = x; }));
    }
    if (all || types.has('tasks') || types.has('submission')) jobs.push(api('GET', '/api/teacher/tasks').then((x) => { state.tasks = x; }));
    jobs.push(api('GET', '/api/teacher/progress').then((x) => { state.progress = x; }));
    if (all || types.has('present')) jobs.push(api('GET', '/api/teacher/present').then((x) => { state.present = x; }));
    await Promise.all(jobs);
    // 入力欄にフォーカスがあるときは描き直さない（入力が消えないように）
    const active = document.activeElement;
    const typing = active && view.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
    if ($('.modal-back') || typing) renderTabs();
    else render();
  }, 300);

  (async () => {
    let me;
    try {
      me = await api('GET', '/api/me');
    } catch {
      location.href = '/';
      return;
    }
    if (me.role !== 'teacher') {
      location.href = '/student';
      return;
    }
    $('#class-name').textContent = `${me.className}（先生）`;
    try { state.tab = sessionStorage.getItem('mb-tab') || 'progress'; } catch { /* 無視 */ }
    await loadAll();
    render();
    listen((e) => {
      dirty.add(e.type);
      reload();
    }, (on) => $('#live').classList.toggle('on', on));
  })();
})();
