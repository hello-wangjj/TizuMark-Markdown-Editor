// 提示块（callout）「编辑态 ≡ 渲染态」结构对齐回归（2026-10-25 用户三张截图）。
//
// 用户反馈：同一段 `> [!NOTE]` 提示块，编辑态和渲染态不一致 ——
//   截图 1：光标停在正文长行 → 标题在，但源码行一路顶到盒子右缘（没有右内距）
//   截图 2：光标停在紧跟标记行的空引用行 → **Note 标题整行消失**，盒子直接以正文开头
//   截图 3：光标停在 `> [!NOTE]` 标记行 → 盒子顶部是一行裸源码，标题同样消失
//
// 根因两条（都是「标题行凭空空掉」，不是样式微差）：
//   ① 渲染器：convertAlerts 只在 contentLines 非空时才给 alert 块补 END 标记；
//      restoreAlerts 要求 start/end 同时命中，缺 END → 整块丢弃。于是
//      `> [!NOTE]`（无内容行，或编辑态上段只切出标记行）渲染结果为**空字符串** ——
//      预览里单个 `> [!NOTE]` 会凭空消失，编辑态上段遮罩因此没有标题行。
//   ② 编辑态分段：光标在标记行时上段为空、下段（合成标记行 + 正文）按设计隐藏
//      `.alert-title`（防重复）→ 标题没人渲染。标记行本身又按普通正文排版（16px 常规
//      字重正文色），盒子顶部就成了一行裸源码。
//
// 修复口径：
//   · convertAlerts 空内容也成对输出两端标记 → 空提示块渲染出「只有标题」的盒子；
//   · 光标停在标记行时给 pre 挂 wysiwyg-callout-marker-line：该行源码按**标题行**排版
//     （0.95em / 700 / 类型主题色 / `> ` 槽透明但保留 22px 占位 / 非末缘行补 6px 底距
//     = .alert-title 的 margin-bottom）→ 标题行在原位，只有标题文字换成了源码；
//   · 光标行是满宽 pre，补与渲染盒同口径的右内距（inset 32 + blockquote 20 / alert 18）
//     → 折行点与渲染段一致，源码行不再把盒子右侧撑破。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { withEditor, delay } = require('./helpers/app-env.cjs');
const { renderMarkdown } = require('../src/unified-renderer.js');

const ROOT = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
const WS = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');

// 行类挂在 'text' 域 = pre 元素（CM5 存 Line.textClass）
const textClassOf = (ed, n) => {
  const h = ed.cm.getLineHandle(n);
  return h && h.textClass ? String(h.textClass) : '';
};

// ---------- ① 渲染器：空提示块不再整块丢失 ----------
test('渲染器：`> [!NOTE]`（无内容行）渲染出只有标题的盒子，不再整块消失', () => {
  for (const [label, md] of [
    ['单行', '> [!NOTE]'],
    ['空引用行', '> [!NOTE]\n> '],
    ['带自定义标题', '> [!WARNING] 自定义'],
  ]) {
    const html = renderMarkdown(md, { softBreaks: false });
    assert.ok(/class="alert alert-/.test(html), `${label}：空提示块必须渲染成 alert 盒（原实现整块被丢弃）：${html}`);
    assert.ok(/class="alert-title"/.test(html), `${label}：空提示块必须带标题行（编辑态上段靠它渲染标题）：${html}`);
    assert.ok(!/ALERTBLOCK_/.test(html), `${label}：占位注释不得漏进产物：${html}`);
  }
  // 与渲染态同构：标题文字按类型映射
  assert.match(renderMarkdown('> [!NOTE]', { softBreaks: false }), /alert-title[\s\S]*?Note</);
  assert.match(renderMarkdown('> [!TIP]', { softBreaks: false }), /alert-title[\s\S]*?Tip</);
  assert.match(renderMarkdown('> [!WARNING] 自定义', { softBreaks: false }), /alert-title[\s\S]*?自定义/);
});

test('渲染器：有内容的提示块不受影响（标题 + 正文照旧）', () => {
  const html = renderMarkdown('> [!NOTE]\n> 正文一行。', { softBreaks: false });
  assert.ok(/class="alert alert-note"/.test(html));
  assert.ok(/alert-title[\s\S]*?Note/.test(html), '标题必须存在');
  assert.ok(/正文一行。/.test(html), '正文必须存在');
  assert.ok(!/ALERTBLOCK_/.test(html), '占位注释不得漏进产物');
});

// ---------- ② 编辑态：光标在标记行 → 按标题行排版 ----------
const MD = ['# T', '', '> [!NOTE]', '> 正文一行。', '> 正文二行。', '', '结束。'].join('\n');
const MD_QUOTE = ['# T', '', '> 普通引用一行。', '> 普通引用二行。', '', '结束。'].join('\n');

test('编辑态：光标停在 `> [!NOTE]` 标记行 → 挂 wysiwyg-callout-marker-line；移开即撤', async () => {
  await withEditor({}, async (w, ed) => {
    await ed.addTab('t.md', MD, 'C:/tmp/callout/t.md', 'markdown');
    const tab = ed.tabs.find((t) => t.name === 't.md');
    if (tab) tab._loaded = true;
    ed.setViewMode('wysiwyg');
    await delay(500);

    const go = async (ln) => {
      ed.cm.setCursor({ line: ln, ch: 0 });
      ed.syncWysiwygActiveBlock();
      await delay(80);
    };

    await go(2); // 标记行
    assert.match(textClassOf(ed, 2), /wysiwyg-callout-marker-line/, '光标在标记行：必须挂典型标记行类（该行按标题行排版）');
    assert.match(textClassOf(ed, 2), /wysiwyg-callout-note/, '标记行仍须保留类型类（配色取 --qc-bar）');

    await go(3); // 正文首行
    assert.doesNotMatch(textClassOf(ed, 2), /wysiwyg-callout-marker-line/, '光标移到正文行：标记行必须撤类（恢复正文排版）');

    await go(6); // 块外
    await go(2); // 回到标记行
    assert.match(textClassOf(ed, 2), /wysiwyg-callout-marker-line/, '光标回到标记行：必须重新挂类');
  });
});

test('编辑态：普通引用（无 [!TYPE]）的 `>` 行永远不挂标记行类', async () => {
  await withEditor({}, async (w, ed) => {
    await ed.addTab('q.md', MD_QUOTE, 'C:/tmp/callout/q.md', 'markdown');
    const tab = ed.tabs.find((t) => t.name === 'q.md');
    if (tab) tab._loaded = true;
    ed.setViewMode('wysiwyg');
    await delay(500);
    for (const ln of [2, 3]) {
      ed.cm.setCursor({ line: ln, ch: 0 });
      ed.syncWysiwygActiveBlock();
      await delay(80);
      assert.doesNotMatch(textClassOf(ed, ln), /wysiwyg-callout-marker-line/, `普通引用行 ${ln} 不得挂 callout 标记行类`);
    }
  });
});

test('编辑态：光标紧随标记行时，上段切出的源文 = 只有标记行，且它能渲染出标题', async () => {
  // ⚠️ jsdom harness 不加载 UnifiedRenderer（w.UnifiedRenderer === undefined），
  //    遮罩 HTML 在测试环境恒为空 → 这里锁两段：①分段口径（上段源文恰为标记行）
  //    ②同一渲染管线对该源文的产物（空提示块成对标记的修复点）。
  await withEditor({}, async (w, ed) => {
    await ed.addTab('t2.md', MD, 'C:/tmp/callout/t2.md', 'markdown');
    const tab = ed.tabs.find((t) => t.name === 't2.md');
    if (tab) tab._loaded = true;
    ed.setViewMode('wysiwyg');
    await delay(500);
    ed.cm.setCursor({ line: 3, ch: 0 }); // 正文首行 → 上段只切出标记行
    ed.syncWysiwygActiveBlock();
    ed._wysiwygApplyQuoteSegments();
    await delay(120);
    const st = ed._wysiwygSegState;
    assert.ok(st, '光标在正文首行时必须产生分段状态');
    assert.strictEqual(st.topSrc, '> [!NOTE]', '上段源文应为「只有标记行」（光标行是正文首行）');
    const topHtml = renderMarkdown(st.topSrc, { softBreaks: ed.settings.softBreaks });
    assert.ok(/class="alert-title"/.test(topHtml), `上段源文必须渲染出标题行，实得：${topHtml}`);
    assert.match(topHtml, /Note/, '上段标题文字应为 Note（否则编辑态盒子顶部没有标题，与渲染态结构不一致）');
  });
});

// ---------- ③ CSS 契约 ----------
test('CSS：标记行按标题行排版（0.95em / 700 / 类型主题色 / > 槽透明 / 非末缘 6px 底距）', () => {
  const block = CSS.slice(CSS.indexOf('.wysiwyg-callout-marker-line {'), CSS.indexOf('.wysiwyg-callout-marker-line {') + 1600);
  assert.match(block, /font-size: calc\(var\(--wysiwyg-text-size, 16px\) \* 0\.95\)/, '.alert-title 是 0.95em，标记行须同字号');
  assert.match(block, /font-weight: 700/, '.alert-title 是 700，标记行须同字重');
  assert.match(block, /\.wysiwyg-callout-marker-line span\.wysiwyg-quote-text \{\s*color: var\(--qc-bar, var\(--accent-color\)\);/, '标记行文字须取类型主题色 --qc-bar（与 .alert-title 同源）');
  assert.match(block, /\.wysiwyg-callout-marker-line span\[class\*="wysiwyg-quote-slot-inner"\] \{\s*color: transparent;/, '`> ` 槽须透明（保留 22px 占位，标题位不出现裸 >）');
  assert.match(block, /\.wysiwyg-callout-marker-line:not\(\.wysiwyg-block-edge-bottom\) \{\s*padding-bottom: 6px;/, '非末缘标记行须补 6px = .alert-title 的 margin-bottom（否则正文段整体上移 6px）');
});

test('CSS：光标行补与渲染盒同口径的右内距（源码行折行点 = 渲染段折行点）', () => {
  assert.match(CSS, /pre\.wysiwyg-quote-cursor-line \{\s*padding-right: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 20px\);/, '普通引用光标行右内距 = inset + blockquote padding-right 20');
  assert.match(CSS, /pre\.wysiwyg-quote-line\.wysiwyg-callout-cursor-line \{\s*padding-right: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 18px\);/, '提示块光标行右内距 = inset + .alert padding-right 18');
});

test('JS 接线：标记行类走差分挂/撤，且只在「活动块是 callout 且光标行 = 块首」时挂', () => {
  const i = WS.indexOf('const prevMarker = this._wysiwygCalloutMarkerLine;');
  assert.ok(i > 0, '缺标记行类同步逻辑（syncWysiwygActiveBlock）');
  const seg = WS.slice(i, i + 700);
  assert.match(seg, /nextQuote === ab\.start/, '判定条件须是「光标行 = 活动块首行」（callout 标记行）');
  assert.match(seg, /this\._setWysiwygCurLineClass\(prevMarker, 'wysiwyg-callout-marker-line', false\);/, '旧行必须撤类（否则换行后旧标记行停在标题排版）');
  assert.match(seg, /this\._setWysiwygCurLineClass\(nextMarker, 'wysiwyg-callout-marker-line', true\);/, '新行必须挂类');
});

// ---------- ④ 引用内嵌套任务列表（2026-10-25 用户截图「引用块嵌套任务列表还是显示源码」） ----------
// 用户反馈：`> - [x] 完成核心编辑器` 的光标行裸露「> - [x] 正文」全源码，而独立任务列表块
// 走列表分支、复选框恒渲染。修复 = 引用分支剥掉 `> ` 前缀后按 RE.task 挂同一组装饰
// （task-prefix 24px 槽 + ::before 复选框、task-box-zero 零宽槽），勾选回写
// _wysiwygToggleTaskLine 扩引用前缀口径。
const MD_QTASK = [
  '# 引用中的列表', '',
  '> 项目规划：',
  '> - [x] 完成核心编辑器',
  '> - [ ] 适配 macOS 和 Linux',
  '', '结束。',
].join('\n');

test('编辑态：引用内任务行的光标行挂 task 装饰（复选框渲染化，不再裸露 - [x] 源码）', async () => {
  await withEditor({}, async (w, ed) => {
    await ed.addTab('qt.md', MD_QTASK, 'C:/tmp/callout/qt.md', 'markdown');
    const tab = ed.tabs.find((t) => t.name === 'qt.md');
    if (tab) tab._loaded = true;
    ed.setViewMode('wysiwyg');
    await delay(500);
    ed.cm.setCursor({ line: 3, ch: 12 }); // 光标落在第一条任务行
    ed.syncWysiwygActiveBlock();
    await delay(120);
    const marks = ed.cm.getAllMarks().filter((m) => String(m.className || '').includes('wysiwyg-task-prefix'));
    assert.ok(marks.length >= 1, '引用内任务行必须挂 wysiwyg-task-prefix 槽（复选框由 ::before 渲染，与独立任务列表同口径）');
    assert.ok(marks.some((m) => String(m.className || '').includes('checked')), '[x] 行必须带 checked 勾选态');
    const pos = marks[0].find();
    assert.ok(pos && pos.from.line === 3 && pos.from.ch === 2 && pos.to.ch === 3,
      `task-prefix 槽必须钉在 bullet 单字符（line 3 ch 2..3），实得 ${JSON.stringify(pos && { from: pos.from, to: pos.to })}`);
    // 零宽槽：[x] 段不显源码
    const zero = ed.cm.getAllMarks().filter((m) => String(m.className || '').includes('wysiwyg-task-box-zero'));
    assert.ok(zero.length >= 1, '[x] 段必须进零宽槽（CM5 token 拆分下可拆成多个 span）');
    // 普通引用行（无任务标记）不得误挂
    ed.cm.setCursor({ line: 2, ch: 0 });
    ed.syncWysiwygActiveBlock();
    await delay(120);
    const marksL2 = ed.cm.getAllMarks().filter((m) => String(m.className || '').includes('wysiwyg-task-prefix')
      && m.find() && m.find().from.line === 2);
    assert.strictEqual(marksL2.length, 0, '普通引用行不得误挂任务槽');
  });
});

test('编辑态：引用内任务行点击勾选可回写（_wysiwygToggleTaskLine 认 > 前缀）', async () => {
  await withEditor({}, async (w, ed) => {
    await ed.addTab('qt2.md', MD_QTASK, 'C:/tmp/callout/qt2.md', 'markdown');
    const tab = ed.tabs.find((t) => t.name === 'qt2.md');
    if (tab) tab._loaded = true;
    ed.setViewMode('wysiwyg');
    await delay(500);
    // 勾选第 4 行（未勾选 → 勾选）
    const ch = ed._wysiwygToggleTaskLine(4);
    assert.strictEqual(ch, 8, `返回值应为正文起点 ch（> - [ ] = 7 字符 + 分隔空格 = 8），实得 ${ch}`);
    assert.strictEqual(ed.cm.getLine(4), '> - [x] 适配 macOS 和 Linux', '点击复选框必须把 [ ] 切成 [x]');
    // 反向：再点一次切回
    const ch2 = ed._wysiwygToggleTaskLine(4);
    assert.strictEqual(ed.cm.getLine(4), '> - [ ] 适配 macOS 和 Linux', '再次点击必须切回 [ ]');
    assert.strictEqual(ch2, 8);
    // 嵌套引用两层：> > - [x]（`> > - [x] ` 共 10 字符，正文起点 ch=10）
    ed.cm.setValue('> > - [x] 嵌套层');
    const ch3 = ed._wysiwygToggleTaskLine(0);
    assert.strictEqual(ch3, 10, `两层引用前缀下正文起点应为 10，实得 ${ch3}`);
    assert.strictEqual(ed.cm.getLine(0), '> > - [ ] 嵌套层', '嵌套引用内同样可勾选');
  });
});

test('JS 接线：引用分支剥 `> ` 前缀后按 RE.task 挂任务装饰（与列表分支同组类名）', () => {
  const anchor = WS.indexOf("add(lineNo, qm[1].length, line.length, 'wysiwyg-quote-text');");
  assert.ok(anchor > 0, '引用分支 quote-text 装饰点缺失');
  // 2026-10-30：任务装饰段新增图5行类注释（约 +430 字符），窗口 1400 → 2400
  const seg = WS.slice(anchor, anchor + 2400);
  assert.match(seg, /RE\.task\.exec\(restAfterQuote\)/, '剥前缀后必须按 RE.task 判定任务行');
  assert.match(seg, /'wysiwyg-task-prefix' \+ \(\/\[xX\]\/\.test\(line\.charAt\(qBoxAt \+ 1\)\) \? ' checked' : ''\)/,
    'bullet 单字符须挂 task-prefix 槽（含 checked 判定，与列表分支同口径）');
  assert.match(seg, /add\(lineNo, qBulletAt \+ 1, qBoxAt \+ 3, 'wysiwyg-task-box-zero'\)/,
    '[x] 段必须进零宽槽（与列表分支同口径）');
  assert.match(seg, /wysiwyg-quote-task-line/,
    '命中 RE.task 的引用行须挂 wysiwyg-quote-task-line 行类（图5：光标态隐藏 > 槽文字）');
  // 勾选回写认引用前缀
  assert.match(WS, /_wysiwygToggleTaskLine\(lineNo\) \{[\s\S]{0,600}\(\?:>\[ \\t\]\?\)\*/,
    '_wysiwygToggleTaskLine 必须容忍逐层 `> ` 前缀（否则引用内复选框点击无效）');
});
