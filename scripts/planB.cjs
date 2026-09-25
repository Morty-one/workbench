#!/usr/bin/env node
// Plan B (browser) for doc-output: paste local xlsx regions into a kdocs online table
// via Playwright-driven Chromium with a persistent user-data-dir so the user's
// kdocs login (cookie) survives across runs.
//
// Usage:
//   node planB.js --login --wpsUrl <url> [--profile <dir>] [--autoClose <ms>]
//     First-time login. Launches headful persistent chromium, goes to the kdocs
//     link, waits for the spreadsheet to appear (i.e. login completed), then
//     auto-closes (default 3s) so cookies are flushed to the profile dir.
//
//   node planB.js --probe --wpsUrl <url> [--profile <dir>] [--out <png>]
//     Launches headful, waits for the spreadsheet, dumps DOM signature
//     (name-box candidates, sheet-tab candidates, canvas count) + a screenshot,
//     then auto-closes. Use to tune selectors when paste misbehaves.
//
//   node planB.js --paste --wpsUrl <url> --mapping <json> [--profile <dir>] [--out <png>] [--headful 1]
//     Headless (or headful for debug) paste run. The mapping JSON is an array of:
//       { online, local, src, dst, tsv }
//     where `tsv` is an absolute path to a TSV file on disk. For each entry:
//       1. Click the sheet tab named `online`
//       2. Select the top-left cell of `dst` (name box -> keyboard fallback)
//       3. Set clipboard to the TSV, press Ctrl+V
//       4. Dismiss any paste confirmation modal
//     Then save a screenshot to `out`.
//
// The script is intentionally self-contained and does NOT install new npm deps.
// It reuses the Playwright + Chromium already present in wps-auto/node_modules.

const path = require('path');
const fs = require('fs');

const PW_PATH = 'F:/AI/workbuddyspace/2026-08-09-11-32-53/wps-auto/node_modules/playwright';
const { chromium } = require(PW_PATH);

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { args[k] = true; }
      else { args[k] = v; i++; }
    }
  }
  return args;
}
const args = parseArgs(process.argv);
const MODE = args.login ? 'login' : (args.probe ? 'probe' : (args.paste ? 'paste' : (args.mode || 'paste')));
const PROFILE = path.resolve(args.profile || path.join(__dirname, '..', '_pw_kdocs_profile'));
const WPSURL = args.wpsUrl || '';
// Default to headful for ALL modes, including paste. Rationale: the 2026-09-04
// headless paste run died mid-wait with "Target page, context or browser has been
// closed" (Chromium crashed on the heavy kdocs canvas page ~19s in). A visible
// window is more stable, matches the already-proven login/probe flow, and lets the
// user watch the paste happen. Pass --headless 1 to force the old headless behavior.
const HEADFUL = args.headless === '1' || args.headless === 'true' ? false : true;
const OUT = path.resolve(args.out || path.join(__dirname, '..', '_tmp_trash', 'planB_done.png'));

// --- logging ----------------------------------------------------------------
const LOG_PATH = process.env.PLANB_LOG || path.join(__dirname, '..', '_tmp_trash', 'planB_node.log');
try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch (e) {}
function log(level, msg) {
  const line = '[' + new Date().toISOString() + '][' + level + '] ' + msg;
  try { fs.appendFileSync(LOG_PATH, line + '\n', 'utf8'); } catch (e) {}
  if (level === 'ERR') console.error(line); else console.log(line);
}
try { fs.writeFileSync(LOG_PATH, '', 'utf8'); } catch (e) {}

// --- helpers ----------------------------------------------------------------
function colLetterToIndex(s) {
  s = String(s).toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}
function parseCellRef(ref) {
  const m = String(ref).match(/^\$?([A-Z]+)\$?(\d+)$/i);
  if (!m) throw new Error('bad cell ref: ' + ref);
  return { col: colLetterToIndex(m[1]), row: parseInt(m[2], 10) };
}
function topLeftOf(range) { return String(range).split(':')[0]; }

// Read back the name box (address bar) text so the log proves which cell is active.
async function readNameBox(page) {
  try {
    return await page.evaluate(() => {
      const sels = ['input[placeholder*="A1"]', 'input.kdocs-name-box', '[class*="name-box"] input',
        '[class*="namebox"] input', '[data-test-id="name-box"]', 'input[title*="名称"]', 'input[aria-label*="名称"]'];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) { const v = (el.value || el.innerText || '').trim(); if (v) return v; }
      }
      return '';
    });
  } catch (e) { return ''; }
}

async function isLoginWall(page) {
  return await page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    return t.indexOf('立即登录') >= 0 || t.indexOf('需要登录') >= 0;
  });
}

async function waitForSpreadsheet(page) {
  // Wait until login wall is gone AND the spreadsheet grid (canvas) is present,
  // OR sheet tab UI is present.
  await page.waitForFunction(() => {
    const t = document.body ? document.body.innerText : '';
    if (t.indexOf('立即登录') >= 0) return false;
    if (document.querySelectorAll('canvas').length > 0) return true;
    // Some kdocs views render the sheet tab bar even before all canvases appear
    if (document.querySelectorAll('[class*="sheet-tab"]').length > 0) return true;
    return false;
  }, null, { timeout: 180000 });
}

async function selectCell(page, ref) {
  // Strategy A: find the name box and type the ref + Enter.
  const candidates = [
    'input[placeholder="A1"]',
    'input[placeholder^="A1"]',
    'input[placeholder*="A1"]',
    'input.kdocs-name-box',
    '[class*="name-box"] input',
    '[class*="namebox"] input',
    '[data-test-id="name-box"]',
    'input[title*="名称"]',
    'input[aria-label*="名称"]',
    'input[aria-label*="name"]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) {
      try {
        await loc.click({ timeout: 1500 });
        await loc.fill('');
        await page.keyboard.type(ref, { delay: 5 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(120);
        return 'namebox:' + sel;
      } catch (e) { /* try next */ }
    }
  }
  // Strategy B: click a canvas, Ctrl+Home, then arrow keys to reach ref.
  const canvas = page.locator('canvas').first();
  if (await canvas.count() > 0) {
    try { await canvas.click({ timeout: 1500 }); } catch (e) {}
  } else {
    try { await page.locator('body').click({ position: { x: 400, y: 400 } }); } catch (e) {}
  }
  await page.keyboard.press('Control+Home');
  await page.waitForTimeout(120);
  const tl = parseCellRef(ref);
  if (tl.col > 1) {
    const presses = Math.min(tl.col - 1, 60);
    for (let i = 0; i < presses; i++) await page.keyboard.press('ArrowRight');
  }
  if (tl.row > 1) {
    const presses = Math.min(tl.row - 1, 200);
    for (let i = 0; i < presses; i++) await page.keyboard.press('ArrowDown');
  }
  return 'keyboard';
}

function sheetTabStrategies(page, name) {
  const esc = String(name).replace(/"/g, '\\"');
  const rx = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    () => page.getByRole('tab', { name: name, exact: true }),
    () => page.getByText(name, { exact: true }),
    () => page.locator('[role="tab"]:has-text("' + esc + '")'),
    () => page.locator('[class*="sheet-tab"]:has-text("' + esc + '")'),
    () => page.locator('[class*="sheetTab"]:has-text("' + esc + '")'),
    () => page.locator('[class*="tab-item"]:has-text("' + esc + '")'),
    () => page.locator('[class*="tab"]:has-text("' + esc + '")'),
    () => page.locator('[title="' + esc + '"]'),
    () => page.locator('[aria-label="' + esc + '"]'),
    () => page.locator('div').filter({ hasText: new RegExp('^' + rx + '$') }),
  ];
}

// Dump every DOM element that looks like a sheet tab (class/text) so a failed click
// leaves behind the REAL tab names + class names for the next diagnosis round.
async function dumpSheetTabs(page, level) {
  try {
    const info = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[class*="tab"],[class*="sheet"],[role="tab"]'));
      const out = [];
      for (const e of els) {
        const t = (e.innerText || '').trim();
        if (!t || t.length > 30) continue;
        const cls = (e.className || '').toString();
        // Only a real sheet-tab element can be "the active sheet". Without this guard
        // the ribbon's own active classes (开始/插入/...) and the sheet-tab container
        // were all reported as active, which made the ON TARGET verdict meaningless.
        const isSheetTab = /sheet[-_]?tab|sheet[-_]?item/i.test(cls);
        out.push({
          tag: e.tagName, cls: cls.slice(0, 90), text: t,
          on: isSheetTab && (e.getAttribute('aria-selected') === 'true' || /(^|[\s_-])(active|selected|current|checked)([\s_-]|$)/i.test(cls)),
        });
        if (out.length >= 60) break;
      }
      return { total: els.length, items: out };
    });
    const names = info.items.map(i => i.text).filter((v, i, a) => a.indexOf(v) === i);
    const active = info.items.filter(i => i.on).map(i => i.text);
    const tag = level || 'ERR';
    log(tag, '  tab-dump total=' + info.total + ' names=' + JSON.stringify(names) + ' active=' + JSON.stringify(active));
    log(tag, '  tab-dump detail=' + JSON.stringify(info.items));
    return { names, active };
  } catch (e) {
    log(level || 'ERR', '  tab-dump failed: ' + (e && e.message));
    return { names: [], active: [] };
  }
}

async function clickSheetTab(page, name) {
  // Poll for the tab bar to render (it can appear well after the grid canvas), then
  // click. Previously this ran once, immediately, and always saw count=0.
  const strategies = sheetTabStrategies(page, name);
  const deadline = Date.now() + 12000;
  let lastErr = null;
  while (Date.now() < deadline) {
    for (let si = 0; si < strategies.length; si++) {
      let loc = null, n = 0;
      try { loc = strategies[si]().first(); } catch (e) { continue; }
      try { n = await loc.count(); } catch (e) { continue; }
      if (n <= 0) continue;
      try {
        await loc.click({ timeout: 2500 });
        log('INF', '  clickSheetTab hit strategy#' + si + ' for "' + name + '"');
        return 'tab:s' + si;
      } catch (e) { lastErr = e; }
    }
    await page.waitForTimeout(400);
  }
  await dumpSheetTabs(page, 'ERR');
  throw new Error('sheet tab not found: ' + name + ' (tried 12s)' + (lastErr ? ' lastErr=' + lastErr.message : ''));
}

async function pasteTSV(page, tsvPath) {
  const tsv = fs.readFileSync(tsvPath, 'utf8');
  // Prefer navigator.clipboard.writeText (requires clipboard-write permission, granted below).
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, tsv);
  await page.waitForTimeout(80);
  // Some web spreadsheets need the cell range selected first; the cell should
  // already be selected from selectCell(). Press Ctrl+V.
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(1200);
  await dismissPasteModal(page);
}

async function dismissPasteModal(page) {
  // kdocs sometimes pops a "确认粘贴 N 行 × M 列?" dialog. Auto-click the primary button.
  const btnRe = /(确定|继续|粘贴|允许|确认|是|好的|Paste|OK|Continue|Allow|Yes)/;
  for (let i = 0; i < 3; i++) {
    // Dump the TEXT of whatever modal/tip is on screen first. Sheet 1 (数据汇总表) is the
    // only one that raised a dialog in the 19:38 run, and it ended up with nothing pasted -
    // so we must be able to read what that dialog actually said (login wall? size warning?
    // overwrite prompt?) instead of guessing from the button label alone.
    const modalTexts = await page.evaluate(() => {
      const sels = ['[role="dialog"]', '[class*="modal"]', '[class*="dialog"]', '[class*="popup"]', '[class*="tip"]', '[class*="toast"]'];
      const out = [];
      for (const s of sels) {
        let els = [];
        try { els = Array.from(document.querySelectorAll(s)); } catch (e) { continue; }
        for (const e of els.slice(0, 8)) {
          if (!e.offsetParent && e.offsetParent !== false) continue;
          const t = (e.innerText || '').trim().replace(/\s+/g, ' ');
          if (t) out.push(t.slice(0, 200));
        }
      }
      return Array.from(new Set(out)).slice(0, 8);
    }).catch(() => []);
    if (modalTexts.length) log('INF', '  modal text: ' + JSON.stringify(modalTexts));
    // Log the whole visible button set: if the paste silently does not land we
    // need to know what dialog actually appeared and which button was chosen.
    const allBtns = await page.evaluate(() => {
      const out = [];
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of buttons) {
        if (!b.offsetParent && b.offsetParent !== false) { continue; }
        const t = (b.innerText || b.textContent || '').trim();
        if (t) out.push(t.slice(0, 24));
      }
      return out;
    }).catch(() => []);
    if (allBtns.length) log('INF', '  visible buttons: ' + JSON.stringify(allBtns));
    const clicked = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc);
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of buttons) {
        if (!b.offsetParent && b.offsetParent !== false) { continue; } // hidden check (offsetParent null when display:none)
        const t = (b.innerText || b.textContent || '').trim();
        if (t && re.test(t)) { try { b.click(); return t; } catch (e) {} }
      }
      return null;
    }, btnRe.source);
    if (!clicked) return;
    log('INF', 'dismissed paste modal: ' + clicked);
    await page.waitForTimeout(500);
  }
}

// --- main -------------------------------------------------------------------
(async () => {
  log('INF', 'mode=' + MODE + ' profile=' + PROFILE + ' wpsUrl=' + WPSURL);

  if (MODE === 'login') {
    if (!WPSURL) { log('ERR', '--login requires --wpsUrl'); process.exit(2); }
    try { fs.mkdirSync(PROFILE, { recursive: true }); } catch (e) {}
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      viewport: { width: 1366, height: 900 },
      locale: 'zh-CN',
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(WPSURL, { waitUntil: 'domcontentloaded' });
    log('INF', 'login: navigate done, waiting for spreadsheet (please complete the login in the browser window)...');
    if (await isLoginWall(page)) {
      log('INF', 'login wall detected; waiting up to 180s for you to log in');
    }
    await waitForSpreadsheet(page);
    log('INF', 'spreadsheet detected, login state saved');
    try { await page.screenshot({ path: OUT }); log('INF', 'screenshot: ' + OUT); } catch (e) {}
    const autoClose = args.autoClose === undefined ? 3000 : parseInt(args.autoClose, 10);
    if (autoClose > 0) {
      log('INF', 'auto-closing in ' + autoClose + 'ms');
      await page.waitForTimeout(autoClose);
    } else {
      log('INF', 'keep-open: close the browser window to continue');
      await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
    }
    await ctx.close();
    log('INF', 'login: done');
    return;
  }

  if (MODE === 'probe') {
    if (!WPSURL) { log('ERR', '--probe requires --wpsUrl'); process.exit(2); }
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false, viewport: { width: 1366, height: 900 }, locale: 'zh-CN',
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(WPSURL, { waitUntil: 'domcontentloaded' });
    if (await isLoginWall(page)) { log('ERR', 'login wall still present; run --login first'); await ctx.close(); process.exit(3); }
    await waitForSpreadsheet(page);
    const info = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).slice(0, 30).map(i => ({
        ph: i.placeholder || '', type: i.type || '', cls: (i.className || '').toString().slice(0, 80),
        aria: i.getAttribute('aria-label') || '', maxLen: i.maxLength || 0, value: (i.value || '').slice(0, 20),
      }));
      const tabish = Array.from(document.querySelectorAll('[class*="sheet"], [class*="tab"], [class*="Sheet"], [class*="Tab"]'))
        .slice(0, 40).map(e => ({
          cls: (e.className || '').toString().slice(0, 80),
          text: (e.innerText || '').trim().slice(0, 40),
        })).filter(t => t.text && t.text.length < 30);
      return {
        title: document.title, url: location.href,
        canvas: document.querySelectorAll('canvas').length,
        inputs: inputs.filter(i => i.ph || i.cls.includes('name') || i.cls.includes('cell') || i.cls.includes('box')),
        tabish: tabish.slice(0, 20),
      };
    });
    log('INF', 'probe: ' + JSON.stringify(info, null, 2));
    try { await page.screenshot({ path: OUT }); log('INF', 'probe screenshot: ' + OUT); } catch (e) {}
    const autoClose = args.autoClose === undefined ? 5000 : parseInt(args.autoClose, 10);
    if (autoClose > 0) { await page.waitForTimeout(autoClose); }
    else { await page.waitForEvent('close', { timeout: 0 }).catch(() => {}); }
    await ctx.close();
    return;
  }

  if (MODE === 'paste') {
    if (!WPSURL) { log('ERR', '--paste requires --wpsUrl'); process.exit(2); }
    if (!args.mapping) { log('ERR', '--paste requires --mapping <json>'); process.exit(2); }
    // Strip a leading UTF-8 BOM if the caller wrote one (PowerShell 5.1 emits BOM
    // with Set-Content -Encoding UTF8). JSON.parse throws on a BOM otherwise.
    const mappingRaw = fs.readFileSync(args.mapping, 'utf8').replace(/^\uFEFF/, '');
    const mapping = JSON.parse(mappingRaw);
    if (!Array.isArray(mapping) || mapping.length === 0) { log('ERR', 'mapping is empty'); process.exit(2); }

    // Clear stale Chromium singleton locks left by a previously crashed run. Without
    // this, launchPersistentContext may attach to a zombie or fail outright.
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.rmSync(path.join(PROFILE, f), { force: true }); } catch (e) {}
    }

    let ctx = null;
    try {
      ctx = await chromium.launchPersistentContext(PROFILE, {
        headless: !HEADFUL, viewport: { width: 1366, height: 900 }, locale: 'zh-CN',
        args: ['--no-first-run', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
      });
    } catch (e) {
      log('ERR', 'paste: browser launch failed: ' + (e.stack || e.message));
      process.exit(5);
    }
    try {
      try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.kdocs.cn' }); } catch (e) {}
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto(WPSURL, { waitUntil: 'domcontentloaded' });
      // Let the page render before judging login state: checking immediately after
      // domcontentloaded missed the login wall (its text hadn't rendered yet).
      await page.waitForTimeout(1500);
      if (await isLoginWall(page)) {
        log('INF', 'paste: 未检测到登录态 - 请在浏览器窗口中完成登录，脚本会继续等待（最多 180s）');
      }
      await waitForSpreadsheet(page);
      log('INF', 'paste: spreadsheet ready, regions=' + mapping.length);

      for (let i = 0; i < mapping.length; i++) {
        const m = mapping[i];
        log('INF', 'paste [' + (i + 1) + '/' + mapping.length + '] online=' + m.online + ' dst=' + m.dst + ' tsv=' + m.tsv);
        try {
          const tabHit = await clickSheetTab(page, m.online);
          await page.waitForTimeout(400);
          let tabInfo = { names: [], active: [] };
          try { tabInfo = await dumpSheetTabs(page, 'INF'); } catch (e) {}
          // kdocs tabs render their row count into the label ("4\n管道燃气"), so compare
          // on the normalised name instead of raw text.
          const norm = (s) => String(s).replace(/^[\s\d]+/, '').trim();
          const onTarget = tabInfo.active.some((n) => norm(n) === norm(m.online));
          log('INF', '  tab ' + tabHit + ' -> active=' + JSON.stringify(tabInfo.active) + (onTarget ? ' (ON TARGET)' : ' (!! NOT ON TARGET)'));
          const used = await selectCell(page, topLeftOf(m.dst));
          const box = await readNameBox(page);
          log('INF', '  cell selected via: ' + used + ' namebox=' + JSON.stringify(box) + ' (want ' + m.dst + ')');
          await pasteTSV(page, m.tsv);
          await page.waitForTimeout(600);
          const boxAfter = await readNameBox(page);
          log('INF', '  pasted -> namebox=' + JSON.stringify(boxAfter) + ' (a range like ' + m.dst + ' proves the paste landed)');
          // kdocs applies the paste asynchronously; give the grid time to settle before
          // switching sheets, otherwise the next sheet's click can race the write.
          await page.waitForTimeout(1200);
        } catch (e) {
          log('ERR', '  paste failed: ' + (e.stack || e.message));
          try { await dumpSheetTabs(page, 'ERR'); } catch (e3) {}
          try { await page.screenshot({ path: OUT }); } catch (e2) {}
          await ctx.close();
          process.exit(4);
        }
      }
      await page.waitForTimeout(800);
      try { await page.screenshot({ path: OUT, fullPage: false }); log('INF', 'final screenshot: ' + OUT); } catch (e) {}
      log('INF', 'paste: all done');
      await ctx.close();
      return;
    } catch (e) {
      // Whole-stage failure (goto / waitForSpreadsheet / browser crash). Capture the
      // page state so the next diagnosis round has hard evidence instead of guesses.
      log('ERR', 'paste: run failed: ' + (e.stack || e.message));
      try {
        const p = ctx.pages()[0];
        if (p) {
          log('ERR', '  page url=' + p.url() + ' title=' + (await p.title()));
          await p.screenshot({ path: OUT });
          log('ERR', '  failure screenshot: ' + OUT);
        }
      } catch (e2) {}
      try { await ctx.close(); } catch (e3) {}
      process.exit(5);
    }
  }

  log('ERR', 'unknown mode: ' + MODE);
  process.exit(2);
})().catch(e => {
  log('ERR', 'FATAL: ' + (e.stack || e.message));
  process.exit(1);
});
