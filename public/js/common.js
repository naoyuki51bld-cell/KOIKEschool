// 全画面で共通の小さなヘルパー
(function () {
  // h('div', {class: 'x', onclick: fn}, child1, 'text', ...)
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // 中身を入れ替える。null / false は飛ばす（replaceChildren だと「null」と表示されてしまう）
  function fill(el, ...children) {
    el.replaceChildren();
    return append(el, children);
  }

  const $ = (sel, root = document) => root.querySelector(sel);

  let toastTimer;
  function toast(message) {
    let el = $('.toast');
    if (!el) {
      el = h('div', { class: 'toast', role: 'status' });
      document.body.append(el);
    }
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // 文章を表示する。$...$ / $$...$$ / \( \) / \[ \] は数式として描く
  function rich(text, tag = 'div') {
    const el = h(tag, { class: 'rich' });
    const parts = String(text || '').split(/\n{2,}/);
    for (const part of parts) {
      const p = h('p');
      part.split('\n').forEach((line, i) => {
        if (i) p.append(h('br'));
        p.append(document.createTextNode(line));
      });
      el.append(p);
    }
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false,
        });
      } catch (e) { /* 数式が書きかけでも本文は出す */ }
    }
    return el;
  }

  // Firestore に入っている画像を読み込んで表示する。ref = { path, v }
  function img(ref, attrs = {}) {
    const el = h('img', { alt: '', ...attrs });
    if (!ref) return el;
    if (typeof ref === 'string') {
      el.src = ref;
      return el;
    }
    el.classList.add('loading');
    window.Store.loadImage(ref).then((data) => {
      el.classList.remove('loading');
      if (data) el.src = data;
    });
    return el;
  }

  function modal(content, { wide = false, onClose } = {}) {
    const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, content);
    const back = h('div', { class: 'modal-back' }, box);
    const close = () => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    return { close, box };
  }

  // 写真を縮小して JPEG の data URL にする（スマホの写真は大きいので）
  function compressImage(file, maxSide = 1400, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('画像を読み込めませんでした'));
      };
      img.src = url;
    });
  }

  // 読み込めなかったデータがあるときに、画面の上に理由を出す
  function showErrors(errors) {
    let bar = $('#error-bar');
    if (!bar) {
      bar = h('div', { id: 'error-bar', class: 'container wide', role: 'alert' });
      $('#view').before(bar);
    }
    const messages = [...new Set(errors.values())];
    fill(bar, messages.length
      ? h('div', { class: 'card', style: { borderColor: 'var(--bad)', color: 'var(--bad)' } },
        h('strong', {}, '一部のデータを読み込めませんでした'),
        messages.map((m) => h('div', { class: 'small' }, m)))
      : null);
  }

  // 同じ処理が短時間に何度も呼ばれたら1回にまとめる
  function debounce(fn, ms = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const STATUS_LABEL = { none: '未提出', pending: '判定待ち', submitted: '提出済', cleared: 'クリア', retry: '再提出', wrong: '不正解' };

  function statusBadge(status) {
    const key = status || 'none';
    return h('span', { class: `badge ${key}` }, key === 'cleared' ? '✓ クリア' : STATUS_LABEL[key]);
  }

  async function logout() {
    await window.Store.logout();
    location.href = '/';
  }

  function timeAgo(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    return new Date(ms).toLocaleDateString('ja-JP');
  }

  window.MB = { h, append, fill, $, toast, rich, img, modal, compressImage, debounce, showErrors, statusBadge, STATUS_LABEL, logout, timeAgo };
})();
