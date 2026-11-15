// reducer 增加 guardrailTriggered / threadResumed 两个 case
const fs = require('fs');
const p = 'packages/ui/src/stores/runtime.ts';
let s = fs.readFileSync(p, 'utf8');
let ok = 0;

if (!s.includes("case 'guardrailTriggered'")) {
  const anchor = "      case 'retrying':";
  const inject = [
    "      case 'guardrailTriggered': {",
    "        if (mine) {",
    "          const ruleLabel: Record<string, string> = {",
    "            pathOutside: '路径越界',",
    "            dangerousCommand: '危险命令',",
    "            readonlyBlocked: '只读限制',",
    "            schemaInvalid: '参数不合法',",
    "            injectionWarning: '疑似提示词注入',",
    "          };",
    "          append({ kind: 'notice', turnId: curTurn, text: `🛡 护栏拦截（${ruleLabel[ev.payload.rule] ?? ev.payload.rule}）：${ev.payload.detail}`, tone: 'warn' });",
    "        }",
    "        break;",
    "      }",
    "      case 'retrying':",
  ].join('\n');
  s = s.replace(anchor, inject);
  ok++;
} else console.log('guardrail present');

if (!s.includes("case 'threadResumed'")) {
  const anchor = "      case 'threadCreated':";
  const inject = [
    "      case 'threadResumed':",
    "        if (mine) {",
    "          const parts: string[] = [`已恢复 ${ev.payload.restoredTurnCount} 轮对话`];",
    "          if (ev.payload.interruptedTurnIds.length > 0) parts.push(`${ev.payload.interruptedTurnIds.length} 轮未完成已中止`);",
    "          if (ev.payload.pendingApprovalCount) parts.push(`${ev.payload.pendingApprovalCount} 个未决审批已失效`);",
    "          append({ kind: 'notice', text: parts.join('，'), tone: 'warn' });",
    "        }",
    "        break;",
    "      case 'threadCreated':",
  ].join('\n');
  s = s.replace(anchor, inject);
  ok++;
} else console.log('resumed present');

fs.writeFileSync(p, s);
console.log('cases added:', ok);
