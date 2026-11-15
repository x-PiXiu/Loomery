// ADR-0021/0022：任务简报/记忆/产物/技能面板（谦卑视图：RPC 读模型 + 事件流，不直接触文件）
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import type { ArtifactRef, Brief, MemoryFact, SkillManifest } from '@loomery/domain';

function OverlayShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactElement {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card task-panel-card" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose}><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 任务简报：每轮自动注入的常驻文档；人类手编与 agent 维护同一份（文件为主） */
export function BriefPanel({ threadId, onClose }: { threadId: string; onClose: () => void }): ReactElement {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    void rpc.call<Brief | null>(RPC.briefGet, { threadId }).then((b) => {
      setBrief(b);
      setDraft(b?.content ?? '');
    }).catch(() => undefined);
  }, [threadId]);
  const save = async (): Promise<void> => {
    const next = await rpc.call<Brief>(RPC.briefSet, { threadId, content: draft });
    setBrief(next);
    setNote(`已保存（rev ${next.rev}）——下一轮对话起自动注入`);
    setTimeout(() => setNote(''), 3000);
  };
  return (
    <OverlayShell title="任务简报（每轮自动注入 · 文件为主）" onClose={onClose}>
      <textarea
        className="brief-editor"
        value={draft}
        placeholder="任务目标、关键约束、已定决策、当前进度……"
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="panel-actions">
        <span className="notice">{brief ? `rev ${brief.rev}` : '尚无简报'}</span>
        <button className="mode-btn active" onClick={() => void save()}>保存</button>
      </div>
      {note ? <div className="notice">{note}</div> : null}
    </OverlayShell>
  );
}

/** 任务记忆：pinned 恒前；取消钉住经事件（journal 落盘 → 读模型折叠） */
export function MemoryPanel({ threadId, onClose }: { threadId: string; onClose: () => void }): ReactElement {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  useEffect(() => {
    void rpc.call<MemoryFact[]>(RPC.memoryList, { threadId }).then(setFacts).catch(() => undefined);
  }, [threadId]);
  const unpin = async (factId: string): Promise<void> => {
    await rpc.call(RPC.memoryUnpin, { threadId, factId });
    setFacts((prev) => prev.map((f) => (f.id === factId ? { ...f, status: 'superseded' } : f)));
  };
  return (
    <OverlayShell title="任务记忆（📌 钉住每轮注入永不裁）" onClose={onClose}>
      {facts.length === 0 ? (
        <div className="notice">暂无。对 agent 说"记住…"或让它维护简报。</div>
      ) : (
        <div className="memory-list">
          {facts.filter((f) => f.status !== 'superseded').map((f) => (
            <div key={f.id} className="memory-row">
              <span className="memory-pin">{f.source === 'user-pinned' ? '📌' : '🧠'}</span>
              <span className="memory-content">{f.content}</span>
              {f.source === 'user-pinned' ? (
                <button className="mode-btn" onClick={() => void unpin(f.id)}>取消钉住</button>
              ) : <span className="memory-kind">{f.kind}</span>}
            </div>
          ))}
        </div>
      )}
    </OverlayShell>
  );
}

/** 任务产物浏览：ref 列表 + 分页查看 blob 原文（超长工具输出/生成文档） */
export function ArtifactsPanel({ threadId, onClose }: { threadId: string; onClose: () => void }): ReactElement {
  const [refs, setRefs] = useState<ArtifactRef[]>([]);
  const [viewing, setViewing] = useState<{ ref: ArtifactRef; page: number; content: string } | null>(null);
  useEffect(() => {
    void rpc.call<ArtifactRef[]>(RPC.artifactList, { threadId }).then(setRefs).catch(() => undefined);
  }, [threadId]);
  const open = async (ref: ArtifactRef, page = 0): Promise<void> => {
    const content = await rpc.call<string>(RPC.artifactGet, { hash: ref.hash, offset: page * 20000 });
    setViewing({ ref, page, content });
  };
  if (viewing) {
    return (
      <OverlayShell title={`产物 ${viewing.ref.hash.slice(0, 8)}（第 ${viewing.page + 1} 页）`} onClose={() => setViewing(null)}>
        <pre className="artifact-viewer">{viewing.content || '（无更多内容）'}</pre>
        <div className="panel-actions">
          <button className="mode-btn" disabled={viewing.page === 0} onClick={() => void open(viewing.ref, viewing.page - 1)}>上一页</button>
          <button className="mode-btn" disabled={viewing.content.length < 20000} onClick={() => void open(viewing.ref, viewing.page + 1)}>下一页</button>
        </div>
      </OverlayShell>
    );
  }
  return (
    <OverlayShell title={`任务产物（${refs.length} 项 · hash 寻址不可变）`} onClose={onClose}>
      {refs.length === 0 ? (
        <div className="notice">暂无产物。超长工具输出会自动入库存为产物。</div>
      ) : (
        <div className="memory-list">
          {refs.map((r) => (
            <div key={r.hash} className="memory-row">
              <span className="memory-kind">{r.kind}</span>
              <span className="memory-content" title={r.hash}>{r.summary || '（无摘要）'}</span>
              <button className="mode-btn" onClick={() => void open(r)}>查看</button>
            </div>
          ))}
        </div>
      )}
    </OverlayShell>
  );
}

/** 技能管理：双作用域清单 + 全文查看（用户自看不经首用确认；确认只管 agent 读取） */
export function SkillsPanel({ onClose }: { onClose: () => void }): ReactElement {
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [body, setBody] = useState<{ name: string; text: string } | null>(null);
  useEffect(() => {
    void rpc.call<SkillManifest[]>(RPC.skillList, {}).then(setSkills).catch(() => undefined);
  }, []);
  if (body) {
    return (
      <OverlayShell title={`技能：${body.name}`} onClose={() => setBody(null)}>
        <pre className="artifact-viewer">{body.text}</pre>
      </OverlayShell>
    );
  }
  return (
    <OverlayShell title={`技能（${skills.length} 个 · 用户级 userData/skills · 项目级 .loomery/skills）`} onClose={onClose}>
      {skills.length === 0 ? (
        <div className="notice">
          暂无技能。把 SKILL.md 放到 <code>数据目录/skills/&lt;名&gt;/</code>（用户级）或项目 <code>.loomery/skills/&lt;名&gt;/</code>（项目级）即可被扫描。
        </div>
      ) : (
        <div className="memory-list">
          {skills.map((s) => (
            <div key={s.entry} className="memory-row">
              <span className="memory-kind">{s.scope === 'project' ? '项目' : '用户'}</span>
              <span className="memory-content"><b>{s.name}</b> — {s.description}</span>
              <button className="mode-btn" onClick={() => void rpc.call<string>(RPC.skillBody, { name: s.name }).then((text) => setBody({ name: s.name, text }))}>查看</button>
            </div>
          ))}
        </div>
      )}
    </OverlayShell>
  );
}
