// 通用对话框单元测试：锁定 showSaveDialog / showConfirmDialog 行为。
// 这两个函数是纯 DOM + 回调，可在 jsdom 下构造对应元素后点击验证。
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { showSaveDialog, showConfirmDialog } = require('../src/modules/dialogs.js');

function buildDom() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const d = dom.window.document;
  function mk(id, tag) {
    const el = d.createElement(tag || 'div');
    el.id = id;
    d.body.appendChild(el);
    return el;
  }
  const sd = mk('save-dialog'); sd.classList.add('hidden');
  mk('save-dialog-title', 'span'); mk('save-dialog-message', 'span');
  mk('save-dialog-save', 'button'); mk('save-dialog-discard', 'button'); mk('save-dialog-cancel', 'button');
  const cd = mk('confirm-dialog'); cd.classList.add('hidden');
  mk('confirm-dialog-title', 'span'); mk('confirm-dialog-message', 'span');
  mk('confirm-dialog-confirm', 'button'); mk('confirm-dialog-cancel', 'button');
  // 警示块：默认 hidden；传 warning 时移除 hidden。
  const warn = mk('confirm-dialog-warning'); warn.classList.add('hidden');
  mk('confirm-dialog-warning-text', 'span');
  return { dom, d };
}

const t = (k) => k; // 测试用占位 i18n

test('showSaveDialog 点击保存返回 save 并恢复文案', async () => {
  const { d } = buildDom();
  const p = showSaveDialog({ doc: d, t });
  d.getElementById('save-dialog-save').click();
  const r = await p;
  assert.strictEqual(r, 'save');
  assert.ok(d.getElementById('save-dialog').classList.contains('hidden'), '关闭后应隐藏');
});

test('showSaveDialog 三种按钮分别返回', async () => {
  const { d } = buildDom();
  const r1 = await (() => { const p = showSaveDialog({ doc: d, t }); d.getElementById('save-dialog-discard').click(); return p; })();
  assert.strictEqual(r1, 'discard');
  const r2 = await (() => { const p = showSaveDialog({ doc: d, t }); d.getElementById('save-dialog-cancel').click(); return p; })();
  assert.strictEqual(r2, 'cancel');
});

test('showSaveDialog 设置文案后 cleanup 还原原始文案', async () => {
  const { d } = buildDom();
  const titleEl = d.getElementById('save-dialog-title');
  const orig = titleEl.textContent;
  const p = showSaveDialog({ title: '自定义标题', doc: d, t });
  assert.strictEqual(titleEl.textContent, '自定义标题');
  d.getElementById('save-dialog-save').click();
  await p;
  assert.strictEqual(titleEl.textContent, orig, '应还原原始文案');
});

test('showConfirmDialog 取消返回 false', async () => {
  const { d } = buildDom();
  const p = showConfirmDialog({ title: '确认?', message: '<b>内容</b>', doc: d, t });
  assert.strictEqual(d.getElementById('confirm-dialog-message').textContent, '<b>内容</b>',
    'message 按纯文本渲染');
  assert.strictEqual(d.getElementById('confirm-dialog-message').innerHTML, '&lt;b&gt;内容&lt;/b&gt;',
    '不得把 message 当 HTML 解析');
  d.getElementById('confirm-dialog-cancel').click();
  const r = await p;
  assert.strictEqual(r, false);
  assert.ok(d.getElementById('confirm-dialog').classList.contains('hidden'));
});

test('showConfirmDialog message 含恶意 HTML 不执行（XSS）', async () => {
  const { d } = buildDom();
  const events = [];
  const win = d.defaultView;
  const p = showConfirmDialog({
    title: '切换?',
    message: '路径 <img src=x onerror="window.__xss=1"> 内容',
    doc: d, t,
  });
  const msgEl = d.getElementById('confirm-dialog-message');
  assert.strictEqual(msgEl.children.length, 0, '不得产生子元素');
  assert.ok(msgEl.textContent.includes('<img src=x onerror="window.__xss=1">'),
    '恶意文本按字面量显示');
  assert.strictEqual(win.__xss, undefined, 'onerror 不得执行');
  d.getElementById('confirm-dialog-cancel').click();
  await p;
});

test('showConfirmDialog 确认无 action 返回 true', async () => {
  const { d } = buildDom();
  const p = showConfirmDialog({ title: '确认?', doc: d, t });
  d.getElementById('confirm-dialog-confirm').click();
  const r = await p;
  assert.strictEqual(r, true);
});

test('showConfirmDialog 带 action 时调用并在完成后 resolve', async () => {
  const { d } = buildDom();
  let called = false;
  const p = showConfirmDialog({
    title: '删除?', doc: d, t,
    action: async () => { called = true; },
  });
  d.getElementById('confirm-dialog-confirm').click();
  const r = await p;
  assert.strictEqual(called, true);
  assert.strictEqual(r, true);
});

test('showConfirmDialog action 抛错时调用 showToast 且不崩溃', async () => {
  const { d } = buildDom();
  const toasts = [];
  const p = showConfirmDialog({
    title: '删除?', doc: d, t,
    action: async () => { throw new Error('boom'); },
    showToast: (msg, type) => toasts.push({ msg, type }),
  });
  d.getElementById('confirm-dialog-confirm').click();
  const r = await p;
  assert.strictEqual(r, true, '异常仍应 resolve true');
  assert.strictEqual(toasts.length, 1, '应调用 showToast');
  assert.ok(toasts[0].msg.includes('boom'));
});

test('showConfirmDialog 传 warning 时打开警示块并按 textContent 渲染', async () => {
  const { d } = buildDom();
  const p = showConfirmDialog({
    title: '导出 PDF', message: '…', warning: '文件较大时请耐心等待', doc: d, t,
  });
  const warn = d.getElementById('confirm-dialog-warning');
  const warnText = d.getElementById('confirm-dialog-warning-text');
  assert.ok(warn, '应存在警示块');
  assert.ok(!warn.classList.contains('hidden'), '传 warning 时警示块必须打开');
  assert.strictEqual(warnText.textContent, '文件较大时请耐心等待', 'warning 必须按 textContent 渲染');
  d.getElementById('confirm-dialog-confirm').click();
  await p;
});

test('showConfirmDialog 不传 warning 时警示块保持 hidden', async () => {
  const { d } = buildDom();
  const warn = d.getElementById('confirm-dialog-warning');
  assert.ok(warn.classList.contains('hidden'), '初始应 hidden');
  const p = showConfirmDialog({ title: '删除?', doc: d, t });
  assert.ok(warn.classList.contains('hidden'), '不传 warning 时必须保持 hidden');
  d.getElementById('confirm-dialog-cancel').click();
  await p;
});

test('showConfirmDialog 关闭后复位警示块（避免单例残留）', async () => {
  const { d } = buildDom();
  const warn = d.getElementById('confirm-dialog-warning');
  const warnText = d.getElementById('confirm-dialog-warning-text');
  // 第一次：打开时传 warning
  const p1 = showConfirmDialog({ title: '导出 PDF', warning: 'PDF 警示', doc: d, t });
  assert.ok(!warn.classList.contains('hidden'));
  d.getElementById('confirm-dialog-cancel').click();
  await p1;
  // cleanup 后警示块必须复位
  assert.ok(warn.classList.contains('hidden'), '关闭后警示块应重新 hidden');
  assert.strictEqual(warnText.textContent, '', '关闭后警示文本应清空，避免下次给"删除字体/重置设置"用时残留 PDF 警示');
  // 第二次：不传 warning（模拟删除字体等其他确认）
  const p2 = showConfirmDialog({ title: '删除?', doc: d, t });
  assert.ok(warn.classList.contains('hidden'), '第二次打开时警示块不应残留为打开');
  d.getElementById('confirm-dialog-cancel').click();
  await p2;
});

test('showConfirmDialog warning 含恶意 HTML 不执行（XSS）', async () => {
  const { d } = buildDom();
  const win = d.defaultView;
  const p = showConfirmDialog({
    title: '导出 PDF',
    warning: '警示 <img src=x onerror="window.__xss=1"> 内容',
    doc: d, t,
  });
  const warnText = d.getElementById('confirm-dialog-warning-text');
  assert.strictEqual(warnText.children.length, 0, 'warning 不得产生子元素');
  assert.ok(warnText.textContent.includes('<img src=x onerror="window.__xss=1">'),
    '恶意文本按字面量显示');
  assert.strictEqual(win.__xss, undefined, 'onerror 不得执行');
  d.getElementById('confirm-dialog-cancel').click();
  await p;
});

test('showConfirmDialog warningTone soft 挂柔和类、默认 danger 不挂', async () => {
  const { d } = buildDom();
  const warn = d.getElementById('confirm-dialog-warning');
  // soft：琥珀柔和变体（导出 PDF 能力检测通过时用）
  const p1 = showConfirmDialog({ title: '导出 PDF', warning: '大文件警示', warningTone: 'soft', doc: d, t });
  assert.ok(warn.classList.contains('dialog-warning-soft'), 'soft 应挂 dialog-warning-soft 类');
  d.getElementById('confirm-dialog-cancel').click();
  await p1;
  // 默认 danger：不挂 soft 类
  const p2 = showConfirmDialog({ title: '导出 PDF', warning: '红色警示', doc: d, t });
  assert.ok(!warn.classList.contains('dialog-warning-soft'), '默认 danger 不得挂 soft 类');
  d.getElementById('confirm-dialog-cancel').click();
  await p2;
});

test('showConfirmDialog 关闭后复位 warningTone（防单例串色）', async () => {
  const { d } = buildDom();
  const warn = d.getElementById('confirm-dialog-warning');
  const p1 = showConfirmDialog({ title: '导出 PDF', warning: '大文件警示', warningTone: 'soft', doc: d, t });
  assert.ok(warn.classList.contains('dialog-warning-soft'));
  d.getElementById('confirm-dialog-cancel').click();
  await p1;
  assert.ok(!warn.classList.contains('dialog-warning-soft'),
    'cleanup 必须撤掉 soft 类，防止琥珀样式残留到下次红色警示场景');
  // 再次打开（不传 tone）应回到默认红色样式
  const p2 = showConfirmDialog({ title: '删除?', warning: '不可恢复', doc: d, t });
  assert.ok(!warn.classList.contains('dialog-warning-soft'));
  d.getElementById('confirm-dialog-cancel').click();
  await p2;
});
