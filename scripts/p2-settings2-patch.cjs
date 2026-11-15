// P2 设置二期：设置壳导航扩展（记忆/技能/使用统计/快捷键四页）
const fs = require('node:fs');
const p = 'packages/ui/src/views/settings/SettingsView.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) { console.error('MISS: ' + a.slice(0, 70)); process.exit(1); }
  s = s.replace(a, b);
};

rep(
  "import { DataDirCard } from './DataDirCard';",
  "import { DataDirCard } from './DataDirCard';\nimport { MemorySettings, ShortcutsSettings, SkillsSettings, UsageSettings } from './capability-panels';",
);
rep(
  "type Section = 'models' | 'appearance' | 'datadir';",
  "type Section = 'models' | 'appearance' | 'datadir' | 'memory' | 'skills' | 'usage' | 'shortcuts';",
);
rep(
  "    { id: 'datadir', label: '数据目录', group: '基础设置' },\n  ];",
  "    { id: 'datadir', label: '数据目录', group: '基础设置' },\n    { id: 'shortcuts', label: '键盘快捷键', group: '基础设置' },\n    { id: 'memory', label: '记忆', group: 'Agent 能力' },\n    { id: 'skills', label: '技能', group: 'Agent 能力' },\n    { id: 'usage', label: '使用统计', group: '数据与统计' },\n  ];",
);
rep(
  "        {['基础设置'].map((group) => (",
  "        {['基础设置', 'Agent 能力', '数据与统计'].map((group) => (",
);
rep(
  `        <div className="settings-nav-group">
          <div className="settings-nav-title">Agent 能力</div>
          <button className="settings-nav-item" disabled title="P2.0 已内置：聊天区 ⋯ 菜单">记忆 / 技能</button>
          <button className="settings-nav-item" disabled title="P2 插件系统提供">MCP 服务器</button>
        </div>`,
  '',
);
rep(
  "        {section === 'datadir' ? <DataDirCard /> : null}",
  "        {section === 'datadir' ? <DataDirCard /> : null}\n        {section === 'memory' ? <MemorySettings /> : null}\n        {section === 'skills' ? <SkillsSettings /> : null}\n        {section === 'usage' ? <UsageSettings /> : null}\n        {section === 'shortcuts' ? <ShortcutsSettings /> : null}",
);
fs.writeFileSync(p, s);
console.log('shell expanded');
