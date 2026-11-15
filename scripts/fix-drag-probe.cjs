// 1) 探针隔离 userData；2) 清理细粒度探针残留
const fs = require('fs');
const p = 'packages/shell/src/main/index.ts';
let s = fs.readFileSync(p, 'utf8');

if (!s.includes('LOOMERY_USER_DATA')) {
  const anchor = "const DEV_URL = process.env.LOOMERY_RENDERER_URL;";
  s = s.replace(
    anchor,
    anchor +
      "\n\n// 探针/排障隔离：LOOMERY_USER_DATA 指定独立数据目录（避免探针实例互写用户布局）\nif (process.env.LOOMERY_USER_DATA) app.setPath('userData', process.env.LOOMERY_USER_DATA);",
  );
  console.log('userData isolation ok');
} else {
  console.log('isolation present');
}

// 删除 fine 探针注入块（从注入起点到 [fine-drag] 日志行结束）
const fineStart = s.indexOf("          await new Promise((r) => setTimeout(r, 120));\n          const fine:");
if (fineStart !== -1) {
  const logIdx = s.indexOf("[fine-drag]'", fineStart);
  const endIdx = s.indexOf('`;', logIdx);
  if (logIdx !== -1 && endIdx !== -1) {
    s = s.slice(0, fineStart) + s.slice(endIdx + 2).replace(/^\n/, '\n');
    console.log('fine probe removed');
  } else {
    console.log('fine block anchors incomplete', logIdx, endIdx);
  }
} else {
  console.log('fine probe absent');
}

fs.writeFileSync(p, s);
