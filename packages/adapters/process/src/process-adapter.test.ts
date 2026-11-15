// F1.1：真机进程执行（Windows shell）+ 超时树杀 + 并发闸 + registry 登记
import { describe, expect, it } from 'vitest';
import { NodeProcessAdapter } from './process-adapter';
import { ProcessRegistry } from './registry';

const CWD = process.cwd();

describe('NodeProcessAdapter', () => {
  it('执行命令并返回输出与退出码', async () => {
    const adapter = new NodeProcessAdapter();
    const r = await adapter.spawn({ command: 'node -e "console.log(\'hello-loomery\')"', cwd: CWD });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('hello-loomery');
    expect(r.timedOut).toBe(false);
  });

  it('非零退出码保留（模型自纠信号）', async () => {
    const adapter = new NodeProcessAdapter();
    const r = await adapter.spawn({ command: 'node -e "process.exit(3)"', cwd: CWD });
    expect(r.exitCode).toBe(3);
  });

  it('超时树杀：timedOut + 已捕获输出保留', async () => {
    const adapter = new NodeProcessAdapter();
    const r = await adapter.spawn({
      command: 'node -e "setTimeout(()=>{console.log(\'late\')},5000)"',
      cwd: CWD,
      timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('abort 联动：signal 触发即杀', async () => {
    const adapter = new NodeProcessAdapter();
    const ac = new AbortController();
    const p = adapter.spawn({ command: 'node -e "setInterval(()=>{},1000)"', cwd: CWD, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    expect(r.exitCode).toBeNull();
  });

  it('并发闸：超限拒绝', async () => {
    const adapter = new NodeProcessAdapter({ maxConcurrentAgent: 1 });
    const p1 = adapter.spawn({ command: 'node -e "setTimeout(()=>{},400)"', cwd: CWD });
    await expect(
      adapter.spawn({ command: 'echo blocked', cwd: CWD }),
    ).rejects.toThrow('并发进程已达上限');
    await p1;
  });

  it('registry 登记：exit 后状态收尾，killAll 杀运行中', async () => {
    const registry = new ProcessRegistry();
    const adapter = new NodeProcessAdapter({ registry });
    await adapter.spawn({ command: 'node -e "console.log(1)"', cwd: CWD });
    expect(registry.list().every((e) => e.state === 'exited')).toBe(true);

    const p = adapter.spawn({ command: 'node -e "setInterval(()=>{},1000)"', cwd: CWD });
    await new Promise((r) => setTimeout(r, 200));
    const killed = await registry.killAll();
    expect(killed).toBeGreaterThanOrEqual(1);
    await p;
    expect(registry.list().filter((e) => e.state === 'killed').length).toBeGreaterThanOrEqual(1);
  });

  // ===== 2026-11-13 卡死修复（start /B 后台化孤儿握 stdio 管道 → close 永不触发）=====

  it('外层自然退出+孤儿握管道：exit 后 bounded 宽限内强制结算（不再永久执行中）', async () => {
    const adapter = new NodeProcessAdapter();
    // 外层 & 链 ~1s 自然退出；start /B 的 ping 孤儿 15s 内自灭，其继承管道阻塞 close
    const t0 = Date.now();
    const r = await adapter.spawn({
      command: 'start /B "" cmd.exe /c "ping -n 8 127.0.0.1 > nul" & timeout /t 1 /nobreak >NUL & echo outer-done',
      cwd: CWD,
    });
    const elapsed = Date.now() - t0;
    expect(r.output).toContain('outer-done');
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    // exit(≈1s) + 宽限(5s) 内结算；修复前此处永不返回
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it('超时递归树杀：外层仍活着 + start /B 孤儿 → 超时后全部清场并结算', async () => {
    const adapter = new NodeProcessAdapter();
    // 外层 wait 长驻（活着到超时）；start /B ping 孤儿长驻
    const t0 = Date.now();
    const r = await adapter.spawn({
      command: 'start /B "" cmd.exe /c "ping -n 60 127.0.0.1 > nul" & ping -n 60 127.0.0.1 > nul',
      cwd: CWD,
      timeoutMs: 3000,
    });
    const elapsed = Date.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(null);
    // timeout(3s) + 树杀 + 兜底宽限(3s) 内结算
    expect(elapsed).toBeLessThan(12_000);
    // 孤儿树已被递归清场（ping 进程数归零；留 2s 给 taskkill 收尾）
    await new Promise((res) => setTimeout(res, 2000));
    const check = await import('node:child_process');
    const ps = check.spawn('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"name='ping.exe'\" | Where-Object {$_.CommandLine -like '*ping -n 60*'} | Measure-Object).Count"], { windowsHide: true });
    const out: string[] = [];
    for await (const d of ps.stdout!) out.push(d.toString());
    expect(parseInt(out.join('').trim(), 10)).toBe(0);
  }, 30_000);

  it('环境清洗：LOOMERY_* 不泄漏给子进程', async () => {
    const adapter = new NodeProcessAdapter();
    const r = await adapter.spawn({
      command: 'node -e "process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith(\'LOOMERY_\'))))"',
      cwd: CWD,
      env: { LOOMERY_E2E_TEST: '1' },
    });
    expect(r.output).toContain('[]');
  });
});
