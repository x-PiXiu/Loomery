// ADR-0022：技能设置（对齐 ZCode 技能页）——清单+启停开关、外部导入（Claude Code 等来源）、新建占位
// 启停 = AppConfig.skills.disabled（SkillIndexProvider 实时过滤注入索引）；导入 = 目录复制到 userData/skills
import { useEffect, useState, type ReactElement } from 'react';
import { Trash2, X } from 'lucide-react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import type { SkillManifest } from '@loomery/domain';
import { runtime, useRuntime } from '../../stores/runtime';

interface SkillSource {
  id: string;
  label: string;
  dir: string;
  count: number;
  skills: SkillManifest[];
}

/** 描述显示去 markdown 标记（粗体星号、反引号、井号等），纯文本一行 */
function stripMarkdown(t: string): string {
  return t.replace(/[*`#_]+/g, '').trim();
}

export function SkillsSettings(): ReactElement {
  const config = useRuntime((s) => s.config);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [search, setSearch] = useState('');
  const [body, setBody] = useState<{ name: string; text: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [creatorNote, setCreatorNote] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const deleteSkill = async (name: string): Promise<void> => {
    const r = await rpc.call<{ ok: boolean; error?: string }>(RPC.skillDelete, { name }).catch((err: unknown) => ({ ok: false, error: String(err) }));
    setDeleting(null);
    if (!r.ok) { setCreatorNote('删除失败：' + (r.error ?? '未知原因')); setTimeout(() => setCreatorNote(''), 5000); return; }
    void rpc.call<SkillManifest[]>(RPC.skillList, {}).then(setSkills);
  };

  const importCreator = async (): Promise<void> => {
    setCreatorNote('查找内置 skill-creator…');
    const sources = await rpc.call<SkillSource[]>(RPC.skillSources, {}).catch(() => [] as SkillSource[]);
    const src = sources.find((x) => x.id === 'zcode-builtin');
    const sk = src?.skills.find((k) => k.name === 'skill-creator');
    if (!src || !sk) { setCreatorNote('未找到 ZCode 内置 skill-creator（需已安装 ZCode）'); return; }
    const r = await rpc.call<{ imported: number; errors: string[] }>(RPC.skillImport, { sourceDir: src.dir, skills: [{ dirName: sk.dirName ?? sk.name, singleFile: sk.singleFile }] }).catch((err: unknown) => ({ imported: 0, errors: [String(err)] }));
    if (r.imported > 0) {
      setCreatorNote('已导入 skill-creator ✓ —— 在对话中对 agent 说："用 skill-creator 帮我创建一个 XX 技能"');
      void rpc.call<SkillManifest[]>(RPC.skillList, {}).then(setSkills);
    } else {
      setCreatorNote('导入失败：' + (r.errors.join('；') || '未知原因'));
    }
    setTimeout(() => setCreatorNote(''), 6000);
  };



  useEffect(() => {
    void rpc.call<SkillManifest[]>(RPC.skillList, {}).then(setSkills).catch(() => undefined);
  }, []);

  const disabled = new Set(config?.skills?.disabled ?? []);
  const visible = skills.filter(
    (s) => s.name.toLowerCase().includes(search.toLowerCase()) || s.description.toLowerCase().includes(search.toLowerCase()),
  );

  const toggle = (name: string, enable: boolean): void => {
    if (!config) return;
    const cur = new Set(config.skills?.disabled ?? []);
    if (enable) cur.delete(name);
    else cur.add(name);
    void rpc
      .call(RPC.configSave, { skills: { disabled: [...cur] } })
      .then(async () => runtime.set({ config: await rpc.call<typeof config>(RPC.configGet) }))
      .catch(() => undefined);
  };

  if (body) {
    return (
      <div className="settings-pane">
        <div className="settings-pane-title">技能：{body.name}</div>
        <pre className="artifact-viewer">{body.text}</pre>
        <button className="mode-btn" onClick={() => setBody(null)}>← 返回清单</button>
      </div>
    );
  }

  return (
    <div className="settings-pane skills-pane">
      <div className="settings-pane-title">技能</div>
      <div className="notice">
        启用的技能会以索引形式注入对话（agent 判断相关后经 read_skill 读取全文）。项目级技能（.loomery/skills）agent 首次读取需确认。
      </div>
      {creatorNote ? <div className="notice">{creatorNote}</div> : null}
      <div className="skills-toolbar">
        <span className="skills-count">技能 {skills.length}</span>
        <input className="search-input" placeholder="搜索技能…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="mode-btn" onClick={() => setImportOpen(true)}>导入技能</button>
        <button className="mode-btn" title="导入内置 skill-creator，随后在对话中让 agent 按需创建技能" onClick={() => void importCreator()}>＋ 新建</button>
      </div>
      <div className="memory-list">
        {visible.map((s) => {
          const enabled = !disabled.has(s.name);
          return (
            <div key={s.entry} className={`memory-row skill-row ${enabled ? '' : 'off'}`}>
              <span className="skill-body">
                <span className="skill-name"><b>{s.name}</b><span className="memory-kind" title="全局=数据目录 skills/（跨项目可用）">{s.scope === 'project' ? '项目' : '全局'}</span>{disabled.has(s.name) ? <span className="skill-off-tag">已停用</span> : null}</span>
                <span className="skill-desc">{stripMarkdown(s.description)}</span>
              </span>
              <span className="skill-actions">
                <button className="mode-btn" onClick={() => void rpc.call<string>(RPC.skillBody, { name: s.name }).then((text) => setBody({ name: s.name, text }))}>查看</button>
                {s.scope === 'user' ? (
                  <button
                    className={`icon-btn ${deleting === s.name ? 'danger-active' : ''}`}
                    title={deleting === s.name ? '再次点击确认删除' : '删除技能'}
                    onClick={() => (deleting === s.name ? void deleteSkill(s.name) : setDeleting(s.name))}
                    onBlur={() => setDeleting(null)}
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
                <label className="switch" title={enabled ? '停用（从对话索引移除）' : '启用（注入对话索引）'}>
                  <input type="checkbox" checked={enabled} onChange={(e) => toggle(s.name, e.target.checked)} />
                  <span className="switch-slider" />
                </label>
              </span>
            </div>
          );
        })}
        {skills.length === 0 ? (
          <div className="notice">暂无技能。点"导入技能"从 Claude Code 等来源导入，或手动放置 SKILL.md。</div>
        ) : null}
        {skills.length > 0 && visible.length === 0 ? <div className="notice">没有匹配" {search} "的技能。</div> : null}
      </div>
      {importOpen ? (
        <ImportDialog
          existing={new Set(skills.map((s) => s.name))}
          onClose={() => setImportOpen(false)}
          onImported={() => void rpc.call<SkillManifest[]>(RPC.skillList, {}).then(setSkills)}
        />
      ) : null}
    </div>
  );
}

  /** 导入对话框：扫描外部来源（Claude Code / ZCode / Agents），按源展开勾选，导入到用户级 */
function ImportDialog({ existing, onClose, onImported }: { existing: Set<string>; onClose: () => void; onImported: () => void }): ReactElement {
  const [sources, setSources] = useState<SkillSource[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set()); // key = dir + '::' + name
  const [note, setNote] = useState('');
  useEffect(() => {
    void rpc.call<SkillSource[]>(RPC.skillSources, {}).then(setSources).catch(() => setSources([]));
  }, []);
  const togglePick = (dir: string, dirName: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      const key = dir + '::' + dirName;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const doImport = async (): Promise<void> => {
    const byDir = new Map<string, { dirName: string; singleFile?: boolean }[]>();
    const allSkills = (sources ?? []).flatMap((s) => s.skills.map((k) => ({ dir: s.dir, k })));
    for (const key of picked) {
      const idx = key.indexOf('::');
      if (idx < 0) continue;
      const dir = key.slice(0, idx);
      const dirName = key.slice(idx + 2);
      const sk = allSkills.find((x) => x.dir === dir && x.k.dirName === dirName);
      if (!sk) continue;
      byDir.set(dir, [...(byDir.get(dir) ?? []), { dirName, singleFile: sk.k.singleFile }]);
    }
    let imported = 0;
    const errors: string[] = [];
    for (const [dir, skills] of byDir) {
      const r = await rpc.call<{ imported: number; errors: string[] }>(RPC.skillImport, { sourceDir: dir, skills }).catch((err: unknown) => ({
        imported: 0,
        errors: [String(err)],
      }));
      imported += r.imported;
      errors.push(...r.errors);
    }
    setNote('已导入 ' + imported + ' 个技能' + (errors.length > 0 ? '；跳过 ' + errors.length + ' 个：' + errors.join('；') : ''));
    setPicked(new Set());
    if (imported > 0) onImported();
    // 有跳过项时保持对话框打开让用户看到原因；全部成功才自动关
    if (imported > 0 && errors.length === 0) setTimeout(() => { setNote(''); onClose(); }, 1000);
  };
  const totalAvailable = (sources ?? []).reduce((s, x) => s + x.count, 0);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card import-card" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <span>导入外部技能</span>
          <button className="icon-btn" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="import-body">
          {sources === null ? (
            <div className="notice">扫描中…</div>
          ) : totalAvailable === 0 ? (
            <div className="notice">未发现外部技能来源。支持 ~/.claude/skills、~/.zcode/skills、~/.agents/skills。</div>
          ) : (
            sources.filter((s) => s.count > 0).map((s) => (
              <div key={s.id} className="import-source">
                <div className="import-source-row">
                  <input
                    type="checkbox"
                    checked={s.skills.filter((k) => !existing.has(k.name)).length > 0 && s.skills.filter((k) => !existing.has(k.name)).every((k) => picked.has(s.dir + '::' + k.dirName))}
                    onChange={(e) => {
                      setPicked((prev) => {
                        const next = new Set(prev);
                        for (const k of s.skills) {
                          const key = s.dir + '::' + k.dirName;
                          if (existing.has(k.name)) continue; // 已存在的跳过
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                        }
                        return next;
                      });
                    }}
                  />
                  <b>{s.label}</b>
                  <span className="import-dir" title={s.dir}>{s.dir}</span>
                  <span className="memory-kind">{s.count} 个技能</span>
                  <button className="mode-btn" onClick={() => setExpanded((v) => (v === s.id ? null : s.id))}>{expanded === s.id ? '收起' : '展开'}</button>
                </div>
                {expanded === s.id ? (
                  <div className="import-skills">
                    {s.skills.map((k) => {
                      const key = s.dir + '::' + k.dirName;
                      const dup = existing.has(k.name);
                      return (
                        <label key={key} className={`import-skill-row ${dup ? 'dup' : ''}`}>
                          <input type="checkbox" disabled={dup} checked={picked.has(key)} onChange={() => togglePick(s.dir, k.dirName ?? k.name)} />
                          <span className="skill-name"><b>{k.name}</b>{k.singleFile ? <span className="skill-off-tag">单文件</span> : null}{dup ? <span className="skill-off-tag">已存在</span> : null}</span>
                          <span className="skill-desc">{stripMarkdown(k.description ?? '')}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
        <div className="import-foot">
          <span className="notice">
            发现 {totalAvailable} 个可导入技能{picked.size > 0 ? `，已选 ${picked.size} 个` : ''}
          </span>
          <button className="mode-btn active" disabled={picked.size === 0} onClick={() => void doImport()}>导入到用户级</button>
        </div>
        {note ? <div className="notice" style={{ padding: '0 14px 10px' }}>{note}</div> : null}
      </div>
    </div>
  );
}
