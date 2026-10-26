// 导出（HTML / PDF）代码块换行 + 全量展开回归测试
//
// 历史根因（两条都还在守）：
//   - 导出 HTML 的代码块不换行，出现横向滚动条（用户："导出 html 时，代码框里没有换行了"）；
//   - 导出 PDF 的代码块带横竖滚动条，看不全代码（用户："导出PDF，代码带有横向竖向滚动条"）。
//
// 2026-10-25 架构变更：三个导出链路（HTML / PDF / 长图）不再各自手写一套 CSS，
// 统一改为「CSSOM 直读完整 styles.css」+ 导出侧 `_exportExpandRules()` 全量展开。
// 因此断言口径也随之改变：
//   · 「样式来自 styles.css」 —— 断言导出文档里确实带着 styles.css 的 pre / .code-line 规则；
//   · 「导出不丢内容」 —— 断言导出侧展开规则带 !important，能压住 styles.css 的
//     `.code-scroll{max-height:300px}` 和 `.preview-content:not(.code-wrap) .code-line-text{white-space:pre}`。
//
// 测试环境注意：jsdom 不加载外链样式表（`link.sheet` 恒为 null），CSSOM 采集在测试里恒为空串。
// 故这里把**真实** styles.css 文本灌进采集器 —— 既验证 appCSS 真的拼进导出文档，
// 也避免断言退化成「导出侧自己写了什么」的自说自话。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const pathMod = require('node:path');
const { withEditor } = require('./helpers/app-env.cjs');

const REAL_STYLES_CSS = fs.readFileSync(pathMod.join(__dirname, '../src/styles.css'), 'utf8');
const REAL_STYLES_BASE = 'http://localhost/src/styles.css';

function stubStyleCollect(ed) {
  ed._exportStyleFromLink = () => ({ css: REAL_STYLES_CSS, base: REAL_STYLES_BASE });
}

test('exportHTML: 代码块来自 styles.css + 导出侧全量展开（静态文档没有 JS 去开滚动条）', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    stubStyleCollect(ed);
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML =
      '<pre><code>function longLineDemo() {\n  const x = "这是一行非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的代码，需要换行才能看全";\n}</code></pre>';

    await ed.exportHTML();

    assert.ok(captured.content, '应写出 HTML');
    const c = captured.content;

    // ① 阅读样式确实来自 styles.css（唯一的样式真源）
    assert.ok(
      /\.preview-content pre\s*\{[^}]*background-color:\s*var\(--code-bg\)/.test(c),
      '导出文档未带上 styles.css 的 .preview-content pre 规则（样式没进导出 → 与阅读模式必然不一致）',
    );
    assert.ok(/\.code-line\s*\{[^}]*display:\s*flex/.test(c),
      '导出文档缺 .code-line display:flex（code-block.js 输出的 .code-line 会全挤成一行）');
    assert.ok(/\.code-line-text\s*\{[^}]*white-space:\s*pre-wrap/.test(c),
      '导出文档缺 .code-line-text 规则');

    // ② 导出侧展开规则：必须 !important 才压得住 styles.css 的裁切/不换行
    assert.match(c, /pre \{ white-space: pre-wrap !important/, '导出 HTML 的 pre 未强制换行');
    assert.match(c, /pre \{ white-space: pre-wrap !important[^}]*overflow: visible !important/,
      '导出 HTML 的 pre 溢出未可见（仍会出滚动条）');
    assert.match(c, /\.code-line-text \{ white-space: pre-wrap !important/,
      '.code-line-text 未强制换行 —— 关掉「代码块换行」设置时 styles.css 给的是 white-space:pre');
    assert.match(c, /\.code-scroll \{ max-height: none !important; overflow: visible !important; \}/,
      '.code-scroll 未展开 —— 静态文档里超过 300px 的代码会被直接裁掉（没有任何滚动条可救）');
    // 注意排除 .preview-content .md2-error pre —— 解析错误回显块**故意**保留横向滚动，
    // 且已由 _exportExpandRules 的 `.md2-error pre { overflow: visible !important }` 展开。
    assert.ok(!/(?<!md2-error )pre\s*\{[^}]*overflow-x:\s*auto/.test(c),
      '导出 HTML 的 pre 不应含 overflow-x: auto');
  });
});

test('exportHTML: code.hljs 背景透明（styles.css 同源，修复"内白外灰"）', async () => {
  // hljs 主题里 .hljs 元素带 background:#ffffff，pre 内会叠一层白底盖住 pre 的灰底。
  // 现在「预览 / PDF / 导出 HTML」三处共用 styles.css 里那两条 !important 规则，
  // 只要 appCSS 真的进了导出文档，导出侧就自动一致。
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    stubStyleCollect(ed);
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<pre><code class="hljs language-js">const x = 1;</code></pre>';
    await ed.exportHTML();
    assert.ok(captured.content, '应写出 HTML');
    const c = captured.content;

    assert.ok(
      /\.preview-content pre code\.hljs[^{]*\{[^}]*background:\s*transparent\s*!important/.test(c),
      '导出文档未带 .preview-content pre code.hljs 透明背景规则（!important 才能压住 hljs 主题 #fff）',
    );
    assert.ok(
      /\.preview-content pre \.hljs[^{]*\{[^}]*background:\s*transparent\s*!important/.test(c),
      '导出文档未带 .preview-content pre .hljs 透明背景规则（漏掉 token span 仍会白底）',
    );
    // 防退化：不能退回 background:none —— 同特异性会被 .hljs 反压
    assert.ok(
      !/pre\s+code\s*\{[^}]*background:\s*none\b/.test(c),
      'pre code 不能再用 background:none（specificity 不如 .hljs）',
    );
  });
});

test('exportHTML: 代码块背景取自主题 --code-bg（与阅读模式同源，不再硬编码 #f6f5f4）', async () => {
  // 历史：导出模板曾硬编码 pre 背景 #f0efee → #e8e8e8 → #f6f5f4，与阅读模式（--code-bg）
  // 永远差一档色，这正是「导出与阅读模式不一致」的一类成因。现在 pre 背景完全由
  // styles.css 的 var(--code-bg) 决定，导出文档带 data-theme 让变量能解析。
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    stubStyleCollect(ed);
    ed.activeTab.filePath = '/docs/note.md';
    await ed.exportHTML();
    assert.ok(captured.content, '应写出 HTML');
    const c = captured.content;

    assert.match(c, /\.preview-content pre\s*\{[^}]*background-color:\s*var\(--code-bg\)/,
      '导出文档的 pre 背景不是 var(--code-bg)（与阅读模式不同源）');
    // 主题变量必须能解析：导出文档根节点带 data-theme
    assert.match(c, /<html[^>]*data-theme="[^"]+"/, '导出文档未带 data-theme，--code-bg 取不到值');
    const m = /--code-bg:\s*(#[0-9a-fA-F]{3,8})/.exec(c);
    assert.ok(m, '导出文档里没有 --code-bg 定义（pre 背景会退化成透明/白）');
    assert.ok(!/^#fff{1,2}$/i.test(m[1]) && !/^#ffffff$/i.test(m[1]),
      `--code-bg 不该是纯白（实际 ${m[1]}）—— 代码块在白底页面上要能看出灰底`);
  });
});

test('exportPDF: 主路径打印态展开所有滚动容器（与长图/DOCX 同口径，代码不裁切）', async () => {
  // 2026-10-26：回退打印帧已删除，主路径在当前文档打印。pre 换行 / .code-line 行结构
  // 由 styles.css（本文件其他用例守护）天然生效；导出侧必须额外注入展开规则，
  // 否则「代码块滚动条」设置开着时代码块仍按 300px 裁切、只印一屏。
  const src = fs.readFileSync(pathMod.join(__dirname, '../src/modules/export.js'), 'utf8');
  const a = src.indexOf('async exportPDF() {');
  assert.ok(a > 0, 'exportPDF 缺失');
  const body = src.slice(a, src.indexOf('async _preparePdfClone', a));
  assert.ok(body.includes("this._exportExpandRules('#pdf-print-root')"),
    'exportPDF 未注入 #pdf-print-root 作用域的展开规则（超 300px 的代码会被裁掉）');
});
test('styles.css: .hljs 元素背景透明——统一用 pre 的 --code-bg（修复"内白外灰"）', async () => {
  // 根因：hljs 主题（github.css）里 .hljs 元素带 background:#ffffff；
  // pre 内是 display:block + padding:1em，会在 pre 的 var(--code-bg) 灰色之上叠一层白底，
  // 形成"灰色外框 + 白色内框"的双层背景。用户在 PDF 导出后尤其明显（"灰色中有白色"）。
  // 修复：styles.css 加 .preview-content pre code.hljs / .hljs { background: transparent }。
  // 现在这条规则是三条导出链路的共同真源，改动它必须跑本文件全部用例。
  const css = REAL_STYLES_CSS;
  assert.ok(
    /\.preview-content\s+pre\s+code\.hljs[\s\S]{0,200}background:\s*transparent\s*!important/.test(css),
    'styles.css 应让 .preview-content pre code.hljs 背景透明（!important 覆盖 hljs 主题白底）',
  );
  // 不能只覆盖 .hljs 而漏掉 pre code.hljs（hljs 主题里 pre code.hljs 才是 pre 内主块）
  assert.ok(
    /\.preview-content\s+pre\s+\.hljs[\s\S]{0,200}background:\s*transparent\s*!important/.test(css),
    'styles.css 应让 .preview-content pre .hljs 背景透明',
  );
});

test('exportPDF: 打印帧组帧只准出现在能力回退分支（主路径在当前文档打印）', async () => {
  // 主路径在当前文档打印（同一份 styles.css，.hljs 透明规则天然生效）；系统打印组帧
  // 只准给「UA 判定不支持 PrintToPdf」的极旧运行时——catch 里 _exportViaSystemPrint
  // 必须位于 else（不 capable）分支，capable 分支失败只能报错。
  const src = fs.readFileSync(pathMod.join(__dirname, '../src/modules/export.js'), 'utf8');
  const a = src.indexOf('async exportPDF() {');
  const body = src.slice(a, src.indexOf('async _preparePdfClone', a));
  const catchStart = body.indexOf('} catch (e) {');
  const elseStart = body.indexOf('} else {', catchStart);
  const finStart = body.indexOf('} finally {', catchStart);
  assert.ok(catchStart > 0 && elseStart > catchStart && finStart > elseStart, 'catch/else/finally 结构缺失');
  const capableBranch = body.slice(catchStart, elseStart);
  const fallbackBranch = body.slice(elseStart, finStart);
  assert.ok(!/_exportViaSystemPrint|_buildPdfPrintFrameHtml/.test(capableBranch),
    'capable 分支不得回退系统打印（PDF 被占用等失败只准报错）');
  assert.match(fallbackBranch, /_exportViaSystemPrint\(/, '不 capable 分支缺系统打印回退');
});
