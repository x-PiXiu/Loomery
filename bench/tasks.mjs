// Loomery 行为基准集——18 个真实小任务（修复/重构/新功能各 6）。
// 每任务：prompt（给 agent 的唯一输入）+ seed（工作区种子文件）+ verify（地面真值验证，独立于 agent 自述）。
// 验证用 node 动态 import（兼容 agent 写 CJS 或 ESM 两种形态）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 在任务工作区内执行 JS 并取 stdout（-e 求值，动态 import 兼容 CJS/ESM） */
function runNode(ws, code, timeout = 15000) {
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ws, encoding: 'utf8', timeout });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

/** 直接运行工作区内的 CLI 脚本 */
function runCli(ws, args, timeout = 15000) {
  const r = spawnSync(process.execPath, args, { cwd: ws, encoding: 'utf8', timeout });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

const load = (p) => `import(${JSON.stringify(p)}).then(m => m.default ?? m)`;

function assert(cond, detail) {
  if (!cond) throw new Error(detail || 'assertion failed');
}

export const TASKS = [
  // ================= 修复类（6） =================
  {
    id: 'fix-sum-range',
    category: '修复',
    title: '闭区间求和少算末位',
    prompt: 'utils/math.js 里的 sumRange(a, b) 语义是返回闭区间 [a, b] 的整数和（两端都含），例如 sumRange(1, 5) 应为 15。现在结果不对，请修复它，保持函数签名不变。',
    seed: {
      'utils/math.js': `function sumRange(a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += i;
  return s;
}
module.exports = { sumRange };
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./utils/math.js')}.then(m => console.log(m.sumRange(1,5), m.sumRange(-2,2), m.sumRange(3,3)))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === '15 0 3', `期望 "15 0 3"，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'fix-empty-guard',
    category: '修复',
    title: '空字符串崩溃',
    prompt: 'utils/text.js 的 firstChar(s) 应返回字符串首字符的大写形式，空字符串返回空串。现在传空字符串会崩溃，请修复，保持函数签名不变。',
    seed: {
      'utils/text.js': `function firstChar(s) {
  return s[0].toUpperCase();
}
module.exports = { firstChar };
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./utils/text.js')}.then(m => console.log(JSON.stringify([m.firstChar(''), m.firstChar('abc')])))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === '["","A"]', `期望 ["","A"]，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'fix-replace-all',
    category: '修复',
    title: '连字符只替换第一处',
    prompt: 'utils/text.js 的 dashToUnderscore(s) 应把字符串里所有连字符都换成下划线，现在只替换第一处。请修复。',
    seed: {
      'utils/text.js': `function dashToUnderscore(s) {
  return s.replace('-', '_');
}
module.exports = { dashToUnderscore };
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./utils/text.js')}.then(m => console.log(m.dashToUnderscore('a-b-c')))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === 'a_b_c', `期望 a_b_c，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'fix-sort-numeric',
    category: '修复',
    title: '数值排序按字典序排错',
    prompt: 'utils/sort.js 的 sortNum(arr) 应按数值升序返回一个新数组（不修改原数组），现在 10 被排到了 2 前面。请修复。',
    seed: {
      'utils/sort.js': `function sortNum(arr) {
  return [...arr].sort();
}
module.exports = { sortNum };
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./utils/sort.js')}.then(m => { const src=[10,2,1,3]; const out=m.sortNum(src); console.log(JSON.stringify(out), JSON.stringify(src)); })`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === '[1,2,3,10] [10,2,1,3]', `期望 "[1,2,3,10] [10,2,1,3]"，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'fix-await-missing',
    category: '修复',
    title: 'async 函数漏 await',
    prompt: 'utils/load.js 里的 getUser 是个 async 函数，应返回用户对象的 name 字段（如 "Alice"）。现在拿不到正确结果。请修复它，保持函数签名不变。',
    seed: {
      'utils/load.js': `function getData() {
  return Promise.resolve({ name: 'Alice', age: 30 });
}
async function getUser() {
  const d = getData();
  return d.name;
}
module.exports = { getUser };
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./utils/load.js')}.then(m => m.getUser()).then(n => console.log(n))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === 'Alice', `期望 Alice，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'fix-default-param',
    category: '修复',
    title: '缺省参数输出 undefined',
    prompt: 'utils/greet.js 的 greet(name) 在 name 缺省时应返回 "Hi guest"，现在会输出 "Hi undefined"。请修复（用默认参数），对已有调用保持兼容。',
    seed: {
      'utils/greet.js': `function greet(name) {
  return 'Hi ' + name;
}
module.exports = { greet };
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./utils/greet.js')}.then(m => console.log(m.greet(), '|', m.greet('Bob')))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === 'Hi guest | Hi Bob', `期望 "Hi guest | Hi Bob"，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },

  // ================= 重构类（6） =================
  {
    id: 'ref-dedup-slugify',
    category: '重构',
    title: '重复代码抽取共享模块',
    prompt: 'lib/a.js 和 lib/b.js 里各有一份完全相同的 slugify 实现（重复代码）。请把它抽到共享模块 lib/slugify.js，两处改为引用共享实现，行为保持不变（slugify("Hello World") 应为 "hello-world"）。',
    seed: {
      'lib/a.js': `const slugify = (s) => s.toLowerCase().replace(/\\s+/g, '-');
function slugA(title) { return slugify(title); }
module.exports = { slugA };
`,
      'lib/b.js': `const slugify = (s) => s.toLowerCase().replace(/\\s+/g, '-');
function slugB(title) { return slugify(title); }
module.exports = { slugB };
`,
    },
    verify: (ws) => {
      assert(existsSync(join(ws, 'lib', 'slugify.js')), 'lib/slugify.js 未创建');
      const a = readFileSync(join(ws, 'lib', 'a.js'), 'utf8');
      const b = readFileSync(join(ws, 'lib', 'b.js'), 'utf8');
      assert(!a.includes('toLowerCase().replace'), 'a.js 仍内联 slugify 实现');
      assert(!b.includes('toLowerCase().replace'), 'b.js 仍内联 slugify 实现');
      const r = runNode(ws, `Promise.all([${load('./lib/a.js')}, ${load('./lib/b.js')}]).then(([a,b]) => console.log(a.slugA('Hello World'), b.slugB('Foo Bar')))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === 'hello-world foo-bar', `期望 "hello-world foo-bar"，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'ref-split-calc',
    category: '重构',
    title: '上帝函数拆分',
    prompt: 'lib/calc.js 的 calc(a, b, type) 是用字符串分发加减的上帝函数。请把它拆成 add(a, b) 和 sub(a, b) 两个独立函数，删除 calc；导出 add/sub，行为等价。',
    seed: {
      'lib/calc.js': `function calc(a, b, type) {
  if (type === 'add') return a + b;
  if (type === 'sub') return a - b;
  throw new Error('unknown type');
}
module.exports = { calc };
`,
    },
    verify: (ws) => {
      const src = readFileSync(join(ws, 'lib', 'calc.js'), 'utf8');
      assert(!/function calc\s*\(/.test(src), 'calc 仍存在');
      const r = runNode(ws, `${load('./lib/calc.js')}.then(m => console.log(m.add(3,4), m.sub(8,7), Object.keys(m).sort().join(',')))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === '7 1 add,sub', `期望 "7 1 add,sub"，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'ref-extract-constants',
    category: '重构',
    title: '魔法数字具名化',
    prompt: 'lib/report.js 里有裸魔法数字（3600、24、7）。请把它们抽取为文件顶部的具名常量（语义准确，如 SECONDS_PER_HOUR），数值不变，行为不变。',
    seed: {
      'lib/report.js': `function hoursFromSeconds(sec) { return sec / 3600; }
function daysFromHours(h) { return h / 24; }
function weeksFromDays(d) { return d / 7; }
module.exports = { hoursFromSeconds, daysFromHours, weeksFromDays };
`,
    },
    verify: (ws) => {
      const src = readFileSync(join(ws, 'lib', 'report.js'), 'utf8');
      assert(/SECONDS_PER_HOUR\s*=\s*3600/.test(src), '缺少 SECONDS_PER_HOUR = 3600');
      assert(!/\/\s*3600/.test(src), '仍存在裸 3600 除法');
      assert(!/\/\s*24\b/.test(src), '仍存在裸 24 除法');
      const r = runNode(ws, `${load('./lib/report.js')}.then(m => console.log(m.hoursFromSeconds(7200), m.daysFromHours(48), m.weeksFromDays(14)))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === '2 2 2', `期望 "2 2 2"，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'ref-var-strict',
    category: '重构',
    title: 'var 与 == 现代化（语义保持）',
    prompt: 'lib/legacy.js 使用了 var 和 ==。请现代化：var→const/let（按需）、==→===，同时输出行为必须完全一致——注意 classify([1, null, undefined]) 仍应输出 "ok,empty,empty"。',
    seed: {
      'lib/legacy.js': `function classify(x) {
  var out = [];
  for (var i = 0; i < x.length; i++) {
    if (x[i] == null) out.push('empty');
    else out.push('ok');
  }
  return out.join(',');
}
module.exports = { classify };
`,
    },
    verify: (ws) => {
      const src = readFileSync(join(ws, 'lib', 'legacy.js'), 'utf8');
      assert(!/\bvar\s/.test(src), '仍存在 var');
      assert(!/[^=!<>]==[^=]/.test(src), '仍存在 == 宽松相等');
      const r = runNode(ws, `${load('./lib/legacy.js')}.then(m => console.log(m.classify([1, null, undefined])))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === 'ok,empty,empty', `期望 ok,empty,empty，实际 "${r.out}"（=== null 会把 undefined 判错）`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'ref-callback-promise',
    category: '重构',
    title: '回调风格改 Promise',
    prompt: 'lib/io.js 的 readConfig(cb) 是回调风格。请改成返回 Promise 的函数（调用形式 readConfig()），解析行为不变：成功解析 config.json 返回对象，文件缺失或 JSON 非法时 Promise 以错误拒绝。导出它。',
    seed: {
      'lib/io.js': `const fs = require('fs');
function readConfig(cb) {
  fs.readFile('config.json', 'utf8', (err, data) => {
    if (err) return cb(err);
    try { cb(null, JSON.parse(data)); } catch (e) { cb(e); }
  });
}
module.exports = { readConfig };
`,
      'config.json': `{"name":"demo","port":8080}
`,
    },
    verify: (ws) => {
      const src = readFileSync(join(ws, 'lib', 'io.js'), 'utf8');
      assert(!/function readConfig\s*\(\s*cb\s*\)/.test(src), '仍是回调签名 readConfig(cb)');
      const r = runNode(ws, `${load('./lib/io.js')}.then(m => m.readConfig()).then(c => console.log(c.name, c.port)).catch(e => console.log('FAIL', e.message))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === 'demo 8080', `期望 "demo 8080"，实际 "${r.out}"`);
      // 拒绝路径：换目录找不存在的 config
      const r2 = runNode(ws, `process.chdir(${JSON.stringify(join(ws, 'lib'))}); ${load('../lib/io.js')}.then(m => m.readConfig()).then(() => console.log('NO_REJECT')).catch(() => console.log('REJECTED'))`);
      assert(r2.out === 'REJECTED', `缺失文件应拒绝，实际 "${r2.out}"`);
      return { ok: true, detail: r.out + ' / ' + r2.out };
    },
  },
  {
    id: 'ref-extract-validate',
    category: '重构',
    title: '校验逻辑从写入函数中抽出',
    prompt: 'lib/user.js 的 saveUser 把校验和写入揉在一起。请把校验逻辑抽成独立的 validateUser(user)（同样的规则，校验失败抛错），saveUser 改为调用它；两个函数都导出，saveUser 行为保持不变。',
    seed: {
      'lib/user.js': `const db = [];
function saveUser(u) {
  if (!u.name || u.name.length < 2) throw new Error('bad name');
  if (typeof u.age !== 'number' || u.age < 0) throw new Error('bad age');
  db.push(u);
  return db.length;
}
module.exports = { saveUser };
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./lib/user.js')}.then(m => {
        const out = [];
        out.push(m.saveUser({ name: 'Al', age: 1 }));
        try { m.saveUser({ name: 'A', age: 1 }); out.push('NO_THROW'); } catch (e) { out.push('THREW:' + e.message); }
        try { m.validateUser({ name: 'Al', age: -1 }); out.push('NO_THROW2'); } catch (e) { out.push('THREW2:' + e.message); }
        out.push(typeof m.validateUser);
        console.log(out.join(' | '));
      })`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === '1 | THREW:bad name | THREW2:bad age | function', `期望保存/抛错/独立校验全对，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },

  // ================= 新功能类（6） =================
  {
    id: 'feat-clamp',
    category: '新功能',
    title: '新增 clamp 函数',
    prompt: 'utils/math.js 新增并导出 clamp(n, min, max)：把 n 限制在闭区间 [min, max] 内，越界时取最近的边界值。已有的 sumRange 不要改动。',
    seed: {
      'utils/math.js': `function sumRange(a, b) {
  let s = 0;
  for (let i = a; i <= b; i++) s += i;
  return s;
}
module.exports = { sumRange };
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./utils/math.js')}.then(m => console.log(m.clamp(5,0,10), m.clamp(-5,0,10), m.clamp(15,0,10), m.sumRange(1,5)))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === '5 0 10 15', `期望 "5 0 10 15"，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'feat-cli-arg',
    category: '新功能',
    title: 'CLI 支持 --name 参数',
    prompt: 'scripts/greet.js 是个 CLI 脚本：支持 --name=xxx 参数（node scripts/greet.js --name=World 输出 "Hello, World!"），未提供该参数时默认输出 "Hello, Guest!"。请实现。',
    seed: {
      'scripts/greet.js': `// TODO: 支持 --name=xxx 参数
console.log('Hello, Guest!');
`,
    },
    verify: (ws) => {
      const r1 = runCli(ws, ['scripts/greet.js', '--name=World']);
      assert(r1.status === 0, '带参运行失败: ' + r1.err);
      assert(r1.out === 'Hello, World!', `期望 "Hello, World!"，实际 "${r1.out}"`);
      const r2 = runCli(ws, ['scripts/greet.js']);
      assert(r2.status === 0, '缺省运行失败: ' + r2.err);
      assert(r2.out === 'Hello, Guest!', `期望 "Hello, Guest!"，实际 "${r2.out}"`);
      return { ok: true, detail: r1.out + ' / ' + r2.out };
    },
  },
  {
    id: 'feat-validate-age',
    category: '新功能',
    title: '新增年龄校验函数',
    prompt: 'utils/validate.js 新增并导出 validateAge(age)：必须是整数且 0≤age≤150，合法时返回该数本身，否则抛出 Error（消息含 "invalid age"）。',
    seed: {
      'utils/validate.js': `module.exports = {};
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./utils/validate.js')}.then(m => {
        const out = [];
        out.push(m.validateAge(30));
        try { m.validateAge(-1); out.push('NO_THROW'); } catch (e) { out.push(/invalid age/.test(e.message) ? 'THREW_OK' : 'THREW_BAD_MSG:' + e.message); }
        try { m.validateAge(1.5); out.push('NO_THROW2'); } catch (e) { out.push('THREW2'); }
        try { m.validateAge(200); out.push('NO_THROW3'); } catch (e) { out.push('THREW3'); }
        console.log(out.join(' | '));
      })`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === '30 | THREW_OK | THREW2 | THREW3', `期望合法返回/三类非法全抛，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'feat-date-format',
    category: '新功能',
    title: '新建日期格式化模块',
    prompt: '新建 lib/date.js，导出 formatDate(d)：接收 Date 对象，返回本地时区的 "YYYY-MM-DD" 字符串（月、日补零）。例如 formatDate(new Date(2024, 0, 5)) 应为 "2024-01-05"。',
    seed: {},
    verify: (ws) => {
      const r = runNode(ws, `${load('./lib/date.js')}.then(m => console.log(m.formatDate(new Date(2024,0,5)), m.formatDate(new Date(2024,11,31))))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === '2024-01-05 2024-12-31', `期望 "2024-01-05 2024-12-31"，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'feat-slugify-option',
    category: '新功能',
    title: 'slugify 增加保留大小写选项',
    prompt: 'lib/slug.js 的 slugify(s) 目前总是转小写。请新增可选第二参数 opts（对象）：opts.lower 为 false 时保留原大小写（如 "Hello World" → "Hello-World"），缺省行为不变（默认转小写）。两种模式都要正确。',
    seed: {
      'lib/slug.js': `function slugify(s) {
  return s.toLowerCase().replace(/\\s+/g, '-');
}
module.exports = { slugify };
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./lib/slug.js')}.then(m => console.log(m.slugify('Hello World'), m.slugify('Hello World', { lower: false }), m.slugify('Foo Bar')))`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === 'hello-world Hello-World foo-bar', `期望 "hello-world Hello-World foo-bar"，实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
  {
    id: 'feat-retry',
    category: '新功能',
    title: '新增重试工具函数',
    prompt: 'lib/retry.js 新增并导出 retry(fn, times)：依次调用 fn（支持同步或异步，均按 await 处理），成功即返回其结果；全部 times 次都失败则抛出最后一次的错误。示例：一个前 2 次抛错、第 3 次成功的函数，retry(fn, 5) 应在第 3 次调用后返回结果。',
    seed: {
      'lib/retry.js': `module.exports = {};
`,
    },
    verify: (ws) => {
      const r = runNode(ws, `${load('./lib/retry.js')}.then(async m => {
        let calls = 0;
        const flaky = async () => { calls += 1; if (calls < 3) throw new Error('x'); return 'ok'; };
        const res = await m.retry(flaky, 5);
        let calls2 = 0;
        const alwaysFail = async () => { calls2 += 1; throw new Error('y'); };
        let failMode = 'NO_THROW';
        try { await m.retry(alwaysFail, 2); } catch (e) { failMode = e.message; }
        console.log(res, calls, failMode, calls2);
      })`);
      assert(r.status === 0, '运行失败: ' + r.err);
      assert(r.out === 'ok 3 y 2', `期望 "ok 3 y 2"（第3次成功/耗尽后抛最后错误/恰好2次调用），实际 "${r.out}"`);
      return { ok: true, detail: r.out };
    },
  },
];

export { runNode, runCli, assert };
