// exportPDF 清理路径回归测试
// 根因：用户报告"导出 PDF（选另存为 PDF/更改保存目录）"完成后，约 30 秒后弹
// `Uncaught TypeError: Cannot read properties of null (reading 'removeEventListener')`（app.js:6067）。
//
// 触发链：
//   1. iframe.onload 注册 afterprint 监听 + setTimeout(cleanup, 30000)；
//   2. 用户在系统打印对话框选"另存为 PDF"并保存成功，触发 afterprint，after 回调
//      调 iframe.contentWindow.removeEventListener + iframe.remove() + setStatus；
//   3. 30 秒后 setTimeout 触发，再次尝试 iframe.contentWindow.removeEventListener，
//      但此时 contentWindow 已是 null → NPE。
//
// 修复：抽 cleanup 闭包 + cleaned 互斥标志，两条路径共用；对 contentWindow 做 null 防护。
// 本测试通过拦截 createElement 捕获 iframe，模拟 afterprint 后再触发 30s 路径，
// 验证：① 不再 NPE；② cleanup 互斥（iframe 只被 remove 一次）；③ 无 afterprint 时
// 30s 路径能正常清理。
//
// 关键细节：jsdom 会在 iframe.appendChild 之后用内部 Window 覆盖 contentWindow，
// 故不能用「替换 contentWindow 为 mock 对象」的方式。改为：
//   - 用真实 jsdom contentWindow（支持 addEventListener / dispatchEvent）；
//   - 通过 dispatchEvent(new win.Event('afterprint')) 模拟打印完成；
//   - 劫持 setTimeout 把硬编码的 30000ms 暂存到 longTimers，按需触发，免真实等 30s。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor, delay } = require('./helpers/app-env.cjs');

// 2026-10-26 重写：本文件原守护「系统打印 iframe 回退路径」的 afterprint / 30s watchdog
// 收尾（旧 NPE bug 的来源）。当日用户要求彻底移除系统打印回退（PrintToPdf 落盘失败——
// 如目标 PDF 被占用——时回退会突然弹出系统打印对话框，体验割裂），回退路径连同
// iframe / afterprint / 30s watchdog / 主窗口 title 临时覆盖一并删除。
// 本文件转而守护「无回退」新契约：
//   ① 全流程不再创建打印 iframe（主路径 PrintToPdf 直接落盘）；
//   ② 主窗口 document.title 永不被导出流程改写（旧路径为预填打印文件名曾临时覆盖）；
//   ③ 导出结束后无 30s 级长定时器残留（旧 NPE 定时器的来源，不能借尸还魂）。
const pdfSaveInvoke = (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.pdf' : null);

function installHarness(w) {
  const iframes = [];
  const longTimers = [];
  const origCreate = w.document.createElement.bind(w.document);
  w.document.createElement = function (tag) {
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === 'iframe') iframes.push(el);
    return el;
  };
  const realSetTimeout = w.setTimeout;
  w.setTimeout = function (fn, ms, ...args) {
    if (ms >= 30000) { longTimers.push(fn); return -1; }
    return realSetTimeout.call(this, fn, ms, ...args);
  };
  return {
    iframes, longTimers,
    restore() {
      w.document.createElement = origCreate;
      w.setTimeout = realSetTimeout;
    },
  };
}

test('exportPDF: 成功路径不创建 iframe、不改写主窗口 title、无 30s 长定时器残留', async () => {
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    w.TauriApi.printToPdf = async () => {};
    ed.showConfirmDialog = async () => true;
    ed.activeTab.name = 'NOTE.md';
    ed.preview.innerHTML = '<p>正文</p>';
    w.document.title = 'TizuMark';
    const h = installHarness(w);
    try {
      await ed.exportPDF();
      assert.strictEqual(h.iframes.length, 0, '成功路径不得创建打印 iframe（系统打印回退已移除）');
      assert.strictEqual(w.document.title, 'TizuMark', '导出流程不得改写主窗口 title（旧回退路径为预填文件名曾覆盖）');
      assert.strictEqual(h.longTimers.length, 0, '成功路径不得残留 30s 级兜底定时器（旧 NPE 来源）');
    } finally { h.restore(); }
  });
});

test('exportPDF: PrintToPdf 失败（PDF 被占用等）同样不建 iframe / 不改 title / 无长定时器', async () => {
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    w.TauriApi.printToPdf = async () => { throw new Error('模拟目标 PDF 被占用'); };
    ed.showConfirmDialog = async () => true;
    ed.activeTab.name = 'NOTE.md';
    ed.preview.innerHTML = '<p>正文</p>';
    w.document.title = 'TizuMark';
    const h = installHarness(w);
    try {
      await ed.exportPDF().catch(() => {});
      assert.strictEqual(h.iframes.length, 0, '失败路径不得回退建打印 iframe（2026-10-26 用户要求移除回退）');
      assert.strictEqual(w.document.title, 'TizuMark', '失败路径不得改写主窗口 title');
      assert.strictEqual(h.longTimers.length, 0, '失败路径不得残留 30s 级兜底定时器');
      assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '失败后遮罩应收尾');
    } finally { h.restore(); }
  });
});

test('exportPDF: 极旧运行时（无 PrintToPdf 能力）→ 系统打印 iframe 回退，afterprint 收尾', async () => {
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    // 2026-10-26 三轮：能力分流——stub 掉 UA 检测，模拟「UA Chrome 主版本 < 101」的
    // 极旧 WebView2：走系统打印回退（iframe + contentWindow.print），功能不丢。
    ed._supportsPrintToPdf = () => false;
    ed.showConfirmDialog = async () => true;
    ed.activeTab.name = 'NOTE.md';
    ed.preview.innerHTML = '<p>可选中的正文</p>';
    const h = installHarness(w);
    try {
      let printToPdfCalled = 0;
      w.TauriApi.printToPdf = async () => { printToPdfCalled += 1; };
      const exportPromise = ed.exportPDF().catch(() => {});
      // 回退路径要先跑 _preparePdfClone + 组帧（jsdom 下多为快速空转），放宽等待
      await delay(120);

      assert.strictEqual(printToPdfCalled, 0, '无能力的运行时不得尝试 PrintToPdf');
      const iframe = h.iframes[0];
      assert.ok(iframe, '极旧运行时应回退建系统打印 iframe');
      assert.match(iframe.srcdoc || '', /可选中的正文/, 'srcdoc 应含真实文字节点（PDF 文字可选中）');

      let printed = 0;
      iframe.contentWindow.print = () => { printed += 1; };
      iframe.onload();
      assert.strictEqual(printed, 1, 'onload 后应调用系统打印 print()');

      iframe.contentWindow.dispatchEvent(new w.Event('afterprint'));
      assert.strictEqual(iframe.parentNode, null, 'afterprint 后 iframe 应已清理');
      assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '回退收尾后遮罩应隐藏');
      await exportPromise;
    } finally { h.restore(); }
  });
});

test('_supportsPrintToPdf: UA Chrome 主版本 >= 101 判支持，< 101 判不支持，解析不到默认支持', async () => {
  await withEditor({}, async (w, ed) => {
    const withUa = async (ua, fn) => {
      const proto = Object.getPrototypeOf(w.navigator);
      const desc = Object.getOwnPropertyDescriptor(proto, 'userAgent');
      Object.defineProperty(w.navigator, 'userAgent', { value: ua, configurable: true });
      try { return await fn(); } finally {
        if (desc) Object.defineProperty(proto, 'userAgent', desc);
        else delete w.navigator.userAgent;
      }
    };
    assert.strictEqual(await withUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0', () => ed._supportsPrintToPdf()), true, 'Chrome/142（新运行时）应判支持');
    assert.strictEqual(await withUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.0 Safari/537.36 Edg/100.0.1181.0', () => ed._supportsPrintToPdf()), false, 'Chrome/100（无 PrintToPdf 的旧运行时）应判不支持');
    assert.strictEqual(await withUa('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 jsdom/24', () => ed._supportsPrintToPdf()), true, 'UA 解析不到 Chrome 版本应默认支持（宁可报错不冒进回退）');
  });
});
