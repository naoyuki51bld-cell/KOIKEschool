// 手書きキャンバス。全画面で開き、書き終えたら PNG の data URL を返す。
// MB.openDrawPad({ initial }) → Promise<string | null>  (null = キャンセル, '' = 何も描かれていない)
(function () {
  const { h } = MB;
  const W = 900;
  const H = 1200;
  const GRID = 50;
  const COLORS = [
    ['#111827', '黒'],
    ['#dc2626', '赤'],
    ['#2563eb', '青'],
    ['#16a34a', '緑'],
  ];

  function openDrawPad({ initial = null } = {}) {
    return new Promise((resolve) => {
      const state = {
        tool: 'pen',
        color: COLORS[0][0],
        width: 4,
        grid: false,
        strokes: [],
        redo: [],
        background: null,
        backgroundCleared: false,
        current: null,
        penSeen: false,
      };

      const canvas = h('canvas', { 'aria-label': '手書きキャンバス' });
      const ctx = canvas.getContext('2d');
      const stage = h('div', { class: 'draw-stage' }, canvas);

      const toolButtons = {};
      const tool = (key, label, title) => {
        toolButtons[key] = h('button', { class: 'small', title, onclick: () => { state.tool = key; refreshTools(); } }, label);
        return toolButtons[key];
      };
      const colorButtons = COLORS.map(([c, name]) => h('button', {
        class: 'small icon',
        title: name,
        'aria-label': `${name}のペン`,
        onclick: () => { state.color = c; if (state.tool === 'eraser') state.tool = 'pen'; refreshTools(); },
      }, h('span', { class: 'swatch', style: { background: c } })));
      const widthBtn = h('button', { class: 'small', onclick: () => { state.width = state.width === 4 ? 9 : 4; refreshTools(); } });
      const gridBtn = h('button', { class: 'small', onclick: () => { state.grid = !state.grid; refreshTools(); redraw(); } }, '方眼');

      const finish = (value) => {
        overlay.remove();
        window.removeEventListener('resize', fit);
        document.body.style.overflow = '';
        resolve(value);
      };

      const tools = h('div', { class: 'draw-tools' },
        h('button', { class: 'small', onclick: () => finish(null) }, 'キャンセル'),
        h('span', { class: 'sep' }),
        tool('pen', '✎ ペン', 'ペン'),
        tool('line', '／ 直線', 'ドラッグで直線を引く'),
        tool('eraser', '消しゴム', '消しゴム'),
        h('span', { class: 'sep' }),
        ...colorButtons,
        widthBtn,
        h('span', { class: 'sep' }),
        h('button', { class: 'small', title: '元に戻す', onclick: undo }, '↶'),
        h('button', { class: 'small', title: 'やり直す', onclick: redo }, '↷'),
        h('button', { class: 'small danger', onclick: clearAll }, '全消去'),
        gridBtn,
        h('span', { class: 'grow' }),
        h('button', { class: 'small primary', onclick: done }, '完了'));

      const overlay = h('div', { class: 'draw-overlay' }, tools, stage);
      document.body.append(overlay);
      document.body.style.overflow = 'hidden';

      function refreshTools() {
        for (const [k, b] of Object.entries(toolButtons)) b.classList.toggle('on', state.tool === k);
        colorButtons.forEach((b, i) => b.classList.toggle('on', state.tool !== 'eraser' && state.color === COLORS[i][0]));
        widthBtn.textContent = state.width === 4 ? '細' : '太';
        gridBtn.classList.toggle('on', state.grid);
      }

      let scale = 1;
      function fit() {
        const rect = stage.getBoundingClientRect();
        scale = Math.max(0.1, Math.min((rect.width - 16) / W, (rect.height - 16) / H));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.style.width = `${W * scale}px`;
        canvas.style.height = `${H * scale}px`;
        canvas.width = Math.round(W * scale * dpr);
        canvas.height = Math.round(H * scale * dpr);
        ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
        redraw();
      }

      function paintAll(c) {
        c.fillStyle = '#fff';
        c.fillRect(0, 0, W, H);
        if (state.grid) {
          c.strokeStyle = '#dbe3ef';
          c.lineWidth = 1;
          c.beginPath();
          for (let x = GRID; x < W; x += GRID) { c.moveTo(x, 0); c.lineTo(x, H); }
          for (let y = GRID; y < H; y += GRID) { c.moveTo(0, y); c.lineTo(W, y); }
          c.stroke();
        }
        if (state.background && !state.backgroundCleared) c.drawImage(state.background, 0, 0, W, H);
        for (const s of state.strokes) paintStroke(c, s);
      }

      function paintStroke(c, s) {
        c.strokeStyle = s.color;
        c.lineWidth = s.width;
        c.lineCap = 'round';
        c.lineJoin = 'round';
        const p = s.points;
        c.beginPath();
        if (p.length === 1) {
          c.arc(p[0][0], p[0][1], s.width / 2, 0, Math.PI * 2);
          c.fillStyle = s.color;
          c.fill();
          return;
        }
        c.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length - 1; i++) {
          const mx = (p[i][0] + p[i + 1][0]) / 2;
          const my = (p[i][1] + p[i + 1][1]) / 2;
          c.quadraticCurveTo(p[i][0], p[i][1], mx, my);
        }
        const last = p[p.length - 1];
        c.lineTo(last[0], last[1]);
        c.stroke();
      }

      function redraw() {
        paintAll(ctx);
        if (state.current) paintStroke(ctx, state.current);
      }

      function point(e) {
        const r = canvas.getBoundingClientRect();
        return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
      }

      canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'pen') state.penSeen = true;
        // ペンを使っているときは手のひらのタッチを無視する
        if (state.penSeen && e.pointerType === 'touch') return;
        if (state.current) return;
        canvas.setPointerCapture(e.pointerId);
        const eraser = state.tool === 'eraser';
        state.current = {
          pointerId: e.pointerId,
          color: eraser ? '#ffffff' : state.color,
          width: eraser ? 36 : state.width,
          line: state.tool === 'line',
          points: [point(e)],
        };
        redraw();
        e.preventDefault();
      });

      canvas.addEventListener('pointermove', (e) => {
        const s = state.current;
        if (!s || s.pointerId !== e.pointerId) return;
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        if (s.line) s.points = [s.points[0], point(e)];
        else for (const ev of events) s.points.push(point(ev));
        redraw();
        e.preventDefault();
      });

      const end = (e) => {
        const s = state.current;
        if (!s || s.pointerId !== e.pointerId) return;
        state.current = null;
        delete s.pointerId;
        state.strokes.push(s);
        state.redo = [];
        redraw();
      };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);

      function undo() {
        if (state.strokes.length) state.redo.push(state.strokes.pop());
        else if (state.backgroundCleared) state.backgroundCleared = false;
        redraw();
      }
      function redo() {
        if (state.redo.length) state.strokes.push(state.redo.pop());
        redraw();
      }
      function clearAll() {
        if (!state.strokes.length && (!state.background || state.backgroundCleared)) return;
        if (!window.confirm('すべて消しますか？')) return;
        state.redo = [];
        state.strokes = [];
        state.backgroundCleared = true;
        redraw();
      }

      function done() {
        const empty = !state.strokes.length && (!state.background || state.backgroundCleared);
        if (empty) return finish('');
        const out = document.createElement('canvas');
        out.width = W;
        out.height = H;
        paintAll(out.getContext('2d'));
        // たくさん描いて PNG が大きくなったときは JPEG にする（1つの文書に入る大きさに）
        const png = out.toDataURL('image/png');
        finish(png.length < 600 * 1024 ? png : out.toDataURL('image/jpeg', 0.85));
      }

      refreshTools();
      if (initial) {
        const img = new Image();
        img.onload = () => { state.background = img; redraw(); };
        img.src = initial;
      }
      window.addEventListener('resize', fit);
      requestAnimationFrame(fit);
    });
  }

  MB.openDrawPad = openDrawPad;
})();
