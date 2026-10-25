// 导出与阅读模式一致性（2026-10-25 用户反馈的回归守卫）
//
// 用户当轮反馈的现象分三类，根因都在「导出帧拿到的样式/内容与阅读模式不是同一份」：
//   ① 导出 PDF / HTML 里公式出现第二份纯文本（a²+b²=c² 后面跟 a2 + b2 = c2）
//      → KaTeX 的 .katex-mathml 副本平时靠 CSS clip-path 隐藏，导出帧一旦缺样式就裸露；
//   ② 导出后代码高亮全丢
//      → hljs 主题 CSS 走裸 fetch，失败即静默为空；
//   ③ 导出 HTML / 长图与阅读模式差异大
//      → HTML 用另写的 _documentExportCSS（与 styles.css 两套平行实现），长图用 html2canvas
//        自带绘制器（不支持 MathML/clip-path/color-mix）。
//
// 本文件守住四条口径：MathML 必摘、样式必从 CSSOM 直读、HTML 必带 .preview-content 根、
// PDF 必走 PrintToPdf 且打印态必须干净。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withEditor } = require('./helpers/app-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'export.js'), 'utf8');

const sliceFn = (startMarker, endMarker) => {
  const a = SRC.indexOf(startMarker);
  const b = endMarker ? SRC.indexOf(endMarker) : SRC.length;
  assert.ok(a > 0 && b > a, `无法定位方法体：${startMarker} … ${endMarker}`);
  return SRC.slice(a, b);
};

// ---------------------------------------------------------------- MathML 副本

test('MathML 副本：导出前一律从 clone 摘掉，不依赖 CSS clip-path 隐藏', () => {
  const calls = SRC.match(/this\._stripKatexMathml\(/g) || [];
  // exportImage / exportHTML / _preparePdfClone（PDF 主路径与回退共用）
  assert.ok(calls.length >= 3,
    `_stripKatexMathml 应至少被长图、HTML、PDF 三处调用，实得 ${calls.length} 处`);
  for (const fn of ['async exportImage()', 'async exportHTML()', 'async _preparePdfClone()']) {
    const body = sliceFn(fn, fn === 'async _preparePdfClone()' ? 'getCachedImageURL(dataUri)' : undefined);
    assert.ok(body.includes('this._stripKatexMathml('), `${fn} 未摘除 .katex-mathml 副本`);
  }
});

test('MathML 副本：只动导出副本，live preview 必须原样保留（DOCX 靠它取 OMML 源）', async () => {
  await withEditor({}, async (w, ed) => {
    ed.preview.innerHTML = '<p>前</p><span class="katex"><span class="katex-mathml"><math><mi>a</mi></math></span>'
      + '<span class="katex-html">a</span></span><p>后</p>';
    const clone = ed.preview.cloneNode(true);
    ed._stripKatexMathml(clone);
    assert.strictEqual(clone.querySelectorAll('.katex-mathml').length, 0, '副本里 MathML 未被移除');
    assert.strictEqual(clone.querySelectorAll('.katex-html').length, 1, '副本里可视化层被误删');
    assert.strictEqual(ed.preview.querySelectorAll('.katex-mathml').length, 1,
      'live preview 被改动 —— export-docx.js 正是从 .katex-mathml 取 <math> 转 OMML 的，会直接毁掉 DOCX 公式');
  });
});

// ---------------------------------------------------------------- 样式采集

test('样式采集：CSSOM 直读优先于 fetch（fetch 失败会静默变空串，是高亮/MathML 事故源头）', () => {
  const fnBody = sliceFn('_exportStyleFromLink(matchFn) {', '_absolutizeCssUrls');
  assert.ok(fnBody.includes('link.sheet'), '样式采集未经 <link>.sheet 读 CSSOM');
  assert.ok(fnBody.includes('cssRules'), '样式采集未读 cssRules');
  assert.ok(!/fetch\(/.test(fnBody), '样式采集仍依赖 fetch（失败即静默为空）');

  // exportHTML / exportImage 的 katex / hljs 一律走采集器，不得再裸 fetch
  for (const fn of ['async exportHTML()', 'async exportImage()']) {
    const body = sliceFn(fn, fn === 'async exportHTML()' ? 'async exportWord' : 'async exportPDF()');
    assert.ok(body.includes('this._exportStyleFromLink('), `${fn} 未使用样式采集器`);
    assert.ok(!/fetch\('lib\/katex/.test(body), `${fn} 仍在裸 fetch katex.min.css`);
  }
});

test('样式采集：KaTeX 字体 url 绝对化 / 内联（否则导出帧字体 404，公式字形退化）', () => {
  const absBody = sliceFn('_absolutizeCssUrls(css, baseHref) {', '导出帧不需要 KaTeX');
  assert.ok(absBody.includes('new URL(u, baseHref)'), '未按样式表位置解析相对 url');
  assert.match(absBody, /data:\|blob:\|https\?:\|file:/, '未跳过已是绝对的 url（会重复改写）');

  const inlineBody = sliceFn('async _inlineCssFonts(css, baseHref) {', '_waitImagesReady');
  assert.ok(inlineBody.includes('readAsDataURL'), '字体未内联为 data URI（SVG-as-image 不能加载外部资源）');
  assert.match(inlineBody, /woff2/, '未限定字体格式（会把整个字体目录塞进导出物）');
});

// ---------------------------------------------------------------- 导出 HTML

test('导出 HTML：复用阅读模式样式（不再用平行维护的 _documentExportCSS）+ 保留作用域根', () => {
  const body = sliceFn('async exportHTML() {', 'async exportWord');
  assert.ok(!body.includes('_documentExportCSS()'),
    'exportHTML 仍用 _documentExportCSS —— 与 styles.css 是两套平行实现，必然与阅读模式漂移');
  assert.ok(body.includes('this._inlineCssFonts('), '导出 HTML 未内联 KaTeX 字体（换机器打开公式字形退化）');
  assert.match(body, /<div class="\$\{containerClass\}">/,
    '导出 HTML 丢了 .preview-content 作用域根 —— styles.css 的阅读样式几乎全是它的后代选择器');
  assert.match(body, /data-theme="\$\{theme\}"/, '导出 HTML 未带 data-theme（主题变量取不到）');
  assert.ok(body.includes("this.t('exportingHTML')"), '导出 HTML 没有 loading 文案');
  assert.ok(/finally \{[\s\S]{0,160}?this\._hideExportOverlay\(\)/.test(body),
    '导出 HTML 的遮罩未在 finally 收尾（失败/取消会留全屏遮罩）');
});

// ---------------------------------------------------------------- 导出 PDF

test('导出 PDF：主路径走 PrintToPdf（无打印对话框 / 无下载气泡），且无系统打印回退', () => {
  const body = sliceFn('async exportPDF() {', 'async _preparePdfClone');
  assert.ok(body.includes('TauriApi.printToPdf('), 'exportPDF 未走 WebView2 PrintToPdf');
  assert.ok(body.includes('await dialogSave('), 'exportPDF 未先让用户选保存路径（PrintToPdf 直接落盘）');
  // 确认框文案与 DOCX 同风格（pdfTip1/pdfTip2），不再提「更多设置」——PrintToPdf 不经过
  // 系统打印对话框，页眉/背景图形那些选项无从谈起
  assert.ok(body.includes("this.t('pdfTip1')") && body.includes("this.t('pdfTip2')"),
    'exportPDF 确认框未使用 pdfTip1/pdfTip2 新文案');
  assert.ok(!body.includes('printTip'), 'exportPDF 仍引用旧 printTip 文案（描述的是已不存在的打印对话框选项）');
  // 2026-10-26 用户要求：彻底移除系统打印回退——PDF 被占用等落盘失败时弹系统打印对话框
  // 体验割裂，失败就明确报错。全源码不得再出现 iframe 打印路径。
  assert.ok(!SRC.includes('_exportViaSystemPrint'), '仍残留 _exportViaSystemPrint（系统打印回退未删净）');
  assert.ok(!SRC.includes('_buildPdfPrintFrameHtml'), '仍残留 _buildPdfPrintFrameHtml（回退帧未删净）');
  assert.ok(!/iframe\.contentWindow\.print\(/.test(SRC), '仍残留 iframe.contentWindow.print()（系统打印路径未删净）');
});

test('导出 PDF：打印态规则必须覆盖 styles.css 自带的 @media print（否则 UI 与遮罩被印进 PDF）', () => {
  const body = sliceFn('async exportPDF() {', 'async _preparePdfClone');
  // styles.css:8121 起的老 @media print 会用 #app{display:block!important} 把应用重新显示出来
  assert.match(body, /@media print \{[\s\S]{0,400}?html\.pdf-printing #app \{ display: none !important; \}/,
    '打印媒体里没有强制隐藏 #app —— PDF 第一页会印出标签栏和整块预览（实测过）');
  // 遮罩：屏幕规则与打印规则必须同一选择器，否则特异性低的那条压不住
  assert.match(body, /html\.pdf-printing #tm-export-overlay \{ display: flex !important; \}/,
    '屏幕态未保留遮罩');
  assert.match(body, /@media print \{[\s\S]{0,500}?html\.pdf-printing #tm-export-overlay \{ display: none !important; \}/,
    '打印态遮罩未用同一选择器隐藏（只写 #id 特异性不足，遮罩会被印进 PDF）');
  assert.ok(body.includes("document.body.classList.add('pdf-printing')"), '未进入打印态');
  assert.ok(body.includes("document.body.classList.remove('pdf-printing')"), '导出后未退出打印态');
});

test('导出 PDF 行为：PrintToPdf 成功后打印态 DOM 全部清理', async () => {
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.pdf';
    return null;
  } }, async (w, ed) => {
    let printed = null;
    ed.showConfirmDialog = async () => true;
    w.TauriApi.printToPdf = async (args) => { printed = args; };
    ed.activeTab.filePath = '/docs/note.md';
    ed.preview.innerHTML = '<p>段落</p>';

    await ed.exportPDF();

    assert.ok(printed, 'PrintToPdf 未被调用');
    assert.ok(printed.options && printed.options.path === '/tmp/out.pdf', '保存路径未透传给 PrintToPdf');
    assert.strictEqual(printed.options.pageWidth, 8.27, 'A4 页面宽度（英寸）不对');
    assert.strictEqual(printed.options.marginTop, 0.59, '页边距（1.5cm ≈ 0.59in）不对');

    assert.strictEqual(w.document.getElementById('pdf-print-root'), null, '打印态副本未移除');
    assert.strictEqual(w.document.getElementById('tm-pdf-print-style'), null, '打印态样式未移除');
    assert.strictEqual(w.document.getElementById('tm-export-expand-style'), null, '展开样式未移除');
    assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '遮罩未移除');
    assert.strictEqual(w.document.body.classList.contains('pdf-printing'), false, 'body 仍带 pdf-printing');
    assert.strictEqual(w.document.documentElement.classList.contains('pdf-printing'), false,
      'html 仍带 pdf-printing（会导致整页 UI 持续隐藏）');
  });
});

test('导出 PDF 行为：PrintToPdf 失败（如 PDF 被占用）→ 不弹系统打印、报错收尾、打印态清理', async () => {
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.pdf';
    return null;
  } }, async (w, ed) => {
    ed.showConfirmDialog = async () => true;
    w.TauriApi.printToPdf = async () => { throw new Error('文件被占用'); };
    ed.activeTab.filePath = '/docs/note.md';
    ed.preview.innerHTML = '<p>段落</p>';
    const iframes = [];
    const origCreate = w.document.createElement.bind(w.document);
    w.document.createElement = function (tag) {
      const el = origCreate(tag);
      if (String(tag).toLowerCase() === 'iframe') iframes.push(el);
      return el;
    };
    const toasts = [];
    const origToast = ed.showToast.bind(ed);
    ed.showToast = (msg, type) => toasts.push({ msg, type });
    try {
      await ed.exportPDF();
      assert.strictEqual(iframes.length, 0, '失败时不得创建打印 iframe（系统打印回退已按用户要求移除）');
      assert.ok(!toasts.some((t) => t.type === 'success'), '失败时不得弹成功 toast');
      assert.match(String(ed.statusText && ed.statusText.textContent || ''), /失败|failed/i, '失败后状态栏应提示导出失败');
      assert.strictEqual(w.document.getElementById('pdf-print-root'), null, '失败后打印态副本未移除');
      assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '失败后遮罩未移除');
      assert.strictEqual(w.document.body.classList.contains('pdf-printing'), false, '失败后 body 仍带 pdf-printing');
    } finally {
      w.document.createElement = origCreate;
      ed.showToast = origToast;
    }
  });
});

// ---------------------------------------------------------------- 长图

test('长图：改由浏览器自己渲染（SVG foreignObject），不再用 html2canvas 的自带绘制器', () => {
  const body = sliceFn('async exportImage() {', 'async exportPDF');
  assert.ok(body.includes('XMLSerializer'), '长图未走 XMLSerializer（HTML 序列化不是 well-formed XML，SVG 会解析失败）');
  assert.ok(body.includes('foreignObject'), '长图未走 foreignObject');
  assert.ok(!body.includes('html2canvas('), '长图仍在调用 html2canvas（不支持 MathML/clip-path/color-mix，与阅读模式必然不一致）');
  assert.ok(body.includes('this._inlineCssFonts('), '长图未内联 KaTeX 字体（SVG-as-image 不能加载外部资源）');
});

test('长图：导出必须带 loading 遮罩并在 finally 收尾', () => {
  const body = sliceFn('async exportImage() {', 'async exportPDF');
  assert.ok(body.includes("this.t('generatingImg')"), '长图导出没有 loading 文案');
  assert.ok(/finally \{[\s\S]{0,240}?this\._hideExportOverlay\(\)/.test(body),
    '长图遮罩未在 finally 收尾');
});

// ---------------------------------------------------------------- 2026-10-26 三条反馈回归

test('长图：展开规则必须随 styleEl 进 SVG（SVG-as-image 是独立渲染环境，head 里的 expandStyle 序列化后不存在）', () => {
  const body = sliceFn('async exportImage() {', 'async exportPDF');
  // styleEl.textContent 组装点必须拼上 _exportExpandRules：appCSS 是完整 styles.css，
  // 自带 .code-scroll{max-height:300px;overflow-y} / pre 滚动裁切——不拼等于「度量时展开、
  // 成图时缩回」，长图里代码块重新只剩 300px + 滚动条（用户截图复现）。
  assert.match(body,
    /styleEl\.textContent = customFontCSS \+ appCSS \+ hljsCSS \+ katexCSS \+ expandCSSForSvg/,
    '长图 styleEl 未拼展开规则（成图时代码块会重新折叠 + 滚动条）');
  assert.match(body, /this\._exportExpandRules\(''\)/, '长图未生成 SVG 内展开 CSS');
});

test('导出 HTML：写盘成功后遮罩收尾弹「导出成功」toast（与 DOCX 同口径）', () => {
  // exportHTML 与 exportWord 之间夹着 docx 页面尺寸/回退等方法（各有自己的 finally），
  // 不能 lastIndexOf 整个切片——以 exportHTML 自己的 setStatus(exportedHTML) 为锚、
  // 取其后第一段 finally。
  const body = sliceFn('async exportHTML() {', 'async _fallbackWordHtmlExport');
  assert.ok(body.includes('htmlExported = true'), 'HTML 写盘成功未置成功标记');
  const anchor = body.indexOf("this.t('exportedHTML')");
  assert.ok(anchor > 0, 'HTML 导出成功态缺失');
  const fin = body.slice(anchor).match(/} finally \{[\s\S]*?\n        \}/);
  assert.ok(fin, 'exportHTML finally 块定位失败');
  const finTxt = fin[0];
  assert.match(finTxt, /this\._hideExportOverlay\(\)/, 'HTML 遮罩未在 finally 收尾');
  assert.match(finTxt, /if \(htmlExported\) this\.showToast\(this\.t\('exportSuccess'\), 'success'\)/,
    'HTML 导出成功未弹 toast（用户不知道导出完没完成）');
  // 顺序铁律（DOCX 注释）：先关遮罩再弹 toast，否则 toast 被遮罩盖住
  assert.ok(finTxt.indexOf('this._hideExportOverlay()') < finTxt.indexOf('showToast'),
    'toast 必须在遮罩关闭之后弹（否则被盖住）');
});

test('导出 PDF：白纸语义——打印态强制亮色外观 + 字面量 #fff 底色（修「页面背景是灰的」二轮反馈）', () => {
  const body = sliceFn('async exportPDF() {', '// PDF 用的 clone 准备');
  // 打印态强制 data-theme=light：暗色主题的浅色文字印在白纸上不可读
  assert.match(body, /rootEl\.setAttribute\('data-theme', 'light'\)/, '打印态未强制亮色主题');
  assert.match(body, /rootEl\.setAttribute\('data-theme', savedTheme\)/, 'finally 未恢复原主题');
  // hljs：暗色高亮主题须换成亮色 github（浅色 token 印白纸才可见）
  assert.match(body, /github\.min\.css/, '暗色 hljs 主题未在打印态换成亮色 github');
  // 底色一律字面量 #fff：不依赖 CSS 变量解析，nord 等方案的灰紫 --preview-bg 不得再漏进来
  assert.match(body,
    /html\.pdf-printing, html\.pdf-printing body \{ background: #fff !important; \}/,
    '打印态 html/body 底色未钉死纯白（应用灰底会被 PrintToPdf 印进页面画布）');
  assert.match(body,
    /#pdf-print-root \{ background: #fff !important; \}/,
    '#pdf-print-root 未钉死纯白（内容列外区域会露应用底色）');
  assert.ok(!/var\(--preview-bg/.test(body), '打印态底色仍依赖 --preview-bg 变量（主题漂移风险）');
  // 成功 toast：导出完成后先关遮罩再弹（与 HTML/DOCX 同口径）
  assert.match(body, /if \(pdfExported\) this\.showToast\(this\.t\('exportSuccess'\), 'success'\)/,
    'PDF 导出成功未弹「导出成功」toast');
});

test('长图：写盘成功后遮罩收尾弹「导出成功」toast（与 HTML/DOCX/PDF 同口径）', () => {
  const body = sliceFn('async exportImage() {', 'async exportPDF');
  assert.ok(body.includes('imgExported = true'), '长图写盘成功未置成功标记');
  const fin = body.slice(body.lastIndexOf('} finally {'));
  assert.match(fin, /this\._hideExportOverlay\(\)/, '长图遮罩未在 finally 收尾');
  assert.match(fin, /if \(imgExported\) this\.showToast\(this\.t\('exportSuccess'\), 'success'\)/,
    '长图导出成功未弹 toast（用户不知道导出完没完成）');
  assert.ok(fin.indexOf('this._hideExportOverlay()') < fin.indexOf('showToast'),
    'toast 必须在遮罩关闭之后弹（否则被盖住）');
});
