# MCP Slides + Sheets 测试流程（命令行直测）

Status: phase-2 专项测试手册。不接任何智能体，全部用 curl / Node 脚本直接打
`http://127.0.0.1:3093/mcp`，只覆盖本次新增的两个能力：

- **M1 演示（pptx）**：后台 `create_pptx` + 可见演示会话（`create_session family=pptx` / `read_deck` /
  `apply_slide_ops` / `save_session`）
- **M2 表格（xlsx）**：后台 `create_xlsx`（纯值版）+ 可见表格会话（`create_session family=xlsx` /
  `read_sheet` / `apply_sheet_ops` / `save_session`）

phase 1（docx）的完整回归不在本文范围，需要时见 [mcp-test-runbook.md](./mcp-test-runbook.md)。
计划与实现备注见 [mcp-phase2-plan.md](./mcp-phase2-plan.md)。

---

## 0. 前置条件（必须先做）

### 0.1 重新构建 + 重启 app

改动横跨 shell 主进程与 sheets 渲染层，**旧构建里没有这些功能**：

```bash
cd /d/Code_zkelvins/GenOffice/genoffice
npm run build -w @genoffice/sheets
npm run build -w @genoffice/shell
```

然后完全退出并重启 GenOffice（Windows 任务栏托盘也要退出）。

### 0.2 打开 MCP

设置 → MCP 设置 → 本地 MCP 服务 打开（绿点"运行中"，端口默认 `3093`）。
若改过端口，下文所有命令先执行 `export MCP_PORT=你的端口`。

**后台生成开关先保持默认（关）**——§1 和 §2/§3 都依赖这个初始状态。

### 0.3 探针脚本

保存为仓库**外**的临时文件，如 `%TEMP%\mcp-probe.mjs`（后面的测试都靠它）：

```js
// 用法:
//   node mcp-probe.mjs tools                       列出工具名
//   node mcp-probe.mjs call <tool> '<jsonArgs>'    调用工具,打印结果;isError 时退出码 1
//   node mcp-probe.mjs expect-error <tool> '<jsonArgs>'  断言工具报错,打印错误文本
// 端口: 环境变量 MCP_PORT (默认 3093)
import http from 'node:http'

const PORT = Number(process.env.MCP_PORT) || 3093
let sid = null

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const headers = { Accept: 'application/json, text/event-stream' }
    if (data !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(data)
    }
    if (sid) headers['Mcp-Session-Id'] = sid
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    r.on('error', reject)
    if (data !== undefined) r.write(data)
    r.end()
  })
}

function parse(text) {
  const t = text.trim()
  if (!t) return null
  if (t[0] === '{' || t[0] === '[') return JSON.parse(t)
  const out = []
  for (const line of t.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        out.push(JSON.parse(line.slice(6)))
      } catch {}
    }
  }
  return out.length === 1 ? out[0] : out
}

async function handshake() {
  const init = await req('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-probe', version: '1.0' },
    },
  })
  if (init.status !== 200) throw new Error(`initialize HTTP ${init.status}`)
  sid = init.headers['mcp-session-id'] ?? null
  await req('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })
}

async function call(name, args) {
  const r = await req('POST', '/mcp', {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: args ?? {} },
  })
  const body = parse(r.text)
  const result = body?.result
  const text = result?.content?.map((c) => c.text ?? '').join('') ?? ''
  return { isError: result?.isError === true, text }
}

const [, , cmd, tool, argsJson] = process.argv
await handshake()

if (cmd === 'tools') {
  const r = await req('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const names = (parse(r.text)?.result?.tools ?? []).map((t) => t.name).sort()
  console.log(names.join('\n'))
} else if (cmd === 'call' || cmd === 'expect-error') {
  const { isError, text } = await call(tool, argsJson ? JSON.parse(argsJson) : {})
  console.log(text)
  if (cmd === 'expect-error' && !isError) {
    console.error('FAIL: expected a tool error')
    process.exit(1)
  }
  if (cmd === 'call' && isError) process.exit(1)
} else {
  console.error('unknown command')
  process.exit(2)
}
```

### 0.4 内容验证脚本

保存为 `%TEMP%\mcp-verify.mjs`。解包 pptx/xlsx 并在 XML 里找关键词，用于"落盘内容正确"的
断言（不需要真的打开 PowerPoint/Excel）：

```js
// 用法: node mcp-verify.mjs <pptx或xlsx文件> <关键词> [关键词...]
// 全部命中 → 退出码 0;任一缺失 → 打印 FAIL 并退出码 1
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// jszip 从仓库的 node_modules 解析(脚本本身在仓库外)
const require = createRequire(
  process.env.GENOFFICE_REPO ?? 'D:/Code_zkelvins/GenOffice/genoffice/package.json',
)
const JSZip = require('jszip')

const [file, ...needles] = process.argv.slice(2)
const zip = await JSZip.loadAsync(readFileSync(file))
const texts = []
for (const name of Object.keys(zip.files)) {
  if (!name.endsWith('.xml')) continue
  texts.push(`${name}: ${await zip.file(name).async('string')}`)
}
const all = texts.join('\n')
let ok = true
for (const needle of needles) {
  const hit = all.includes(needle)
  console.log(`${hit ? 'PASS' : 'FAIL'} ${needle}`)
  if (!hit) ok = false
}
process.exit(ok ? 0 : 1)
```

### 0.5 输出目录

```bash
export OUT=$(mktemp -d)   # 或自定 export OUT=D:/tmp/mcp-test && mkdir -p "$OUT"
```

> 可见会话的测试会**真实打开标签页**，请在 GenOffice 窗口里同步观察。
> 一次只保持一个可见会话（每类 app 同时只有一个 MCP 会话）。

---

## 1. 工具列表（后台生成 = 关，默认）

```bash
node "$TEMP/mcp-probe.mjs" tools
curl -s http://127.0.0.1:${MCP_PORT:-3093}/health
```

**期望**：health 返回 ok；工具 **14 个**：

```
apply_ops, apply_sheet_ops, apply_slide_ops, create_session, get_app_info,
insert_content, open_in_genoffice, read_deck, read_docx, read_document,
read_pdf, read_sheet, replace_blocks, save_session
```

**不应出现** `create_docx` / `create_pptx` / `create_xlsx`（这三个属于"后台生成"，默认关）。

---

## 2. Slides · 可见演示会话（无需开后台）

依次执行（每条之间在 app 窗口观察）：

```bash
# 2.1 打开一个空白演示标签页 —— app 应立刻出现一个新标签（首次可能等 1-3 秒渲染）
node "$TEMP/mcp-probe.mjs" call create_session '{"family":"pptx"}'

# 2.2 建第 1 页内容 —— 幻灯片上应**实时**出现标题与两个项目符号
# offset 单位为 EMU（1 px = 9525 EMU）
node "$TEMP/mcp-probe.mjs" call apply_slide_ops '{"ops":[{"op":"addElement","target":{"slide":0},"kind":"textbox","offset":{"x":1143000,"y":685800,"cx":7315200,"cy":1127760},"paragraphs":[{"runs":[{"text":"MCP 标题","bold":true,"fontSize":36}],"align":"left"}]},{"op":"addElement","target":{"slide":0},"kind":"textbox","offset":{"x":1143000,"y":2057400,"cx":7315200,"cy":3657600},"paragraphs":[{"runs":[{"text":"第一点","fontSize":20}],"bullet":{"type":"char","char":"•"},"marL":342900,"indent":-342900},{"runs":[{"text":"第二点","fontSize":20}],"bullet":{"type":"char","char":"•"},"marL":342900,"indent":-342900}]}]}'

# 2.3 读回元素清单（id/几何/文本，供后续 op 定位）
node "$TEMP/mcp-probe.mjs" call read_deck '{}'

# 2.4 dryRun 只出计划不改内容；再读一次确认仍是 1 页
node "$TEMP/mcp-probe.mjs" call apply_slide_ops '{"ops":[{"op":"deleteSlide","target":{"slide":0}}],"dryRun":true}'
node "$TEMP/mcp-probe.mjs" call read_deck '{}'

# 2.5 非法 op → 整批原子拒绝，错误带 usage 提示
node "$TEMP/mcp-probe.mjs" expect-error apply_slide_ops '{"ops":[{"op":"NoSuchOp"}]}'
```

**期望**：

- 2.1 返回 `{"ok":true,"deckId":<数字>,"message":...}`
- 2.2 返回 `"applied": true` 和 `created` 元素 id；幻灯片实时出现标题与项目符号
- 2.3 返回 `{"emuPerPx":9525,"slideSize":{...},"slides":[{"index":0,"id":"s_1","elements":[...]}]}`，
  元素文本含 "MCP 标题"
- 2.4 dryRun 返回 `"dryRun": true` 和 `plan`；第二次 `read_deck` 仍是 1 页
- 2.5 报错含 `unknown op "NoSuchOp"`

```bash
# 2.6 输出到指定位置（会话结束）
node "$TEMP/mcp-probe.mjs" call save_session "{\"path\":\"$OUT/visible.pptx\",\"overwrite\":true}"

# 2.7 会话已结束：再编辑应报错
node "$TEMP/mcp-probe.mjs" expect-error read_deck '{}'

# 2.8 落盘内容验证
node "$TEMP/mcp-verify.mjs" "$OUT/visible.pptx" "MCP 标题" "第一点" "第二点"
```

**期望**：

- 2.6 返回 `{"path":"...visible.pptx"}`，文件存在；保存后标签页标题变为 `visible.pptx`
- 2.7 报错文案含 `create_session`
- 2.8 三个关键词全部 PASS；有条件的话用 PowerPoint/WPS 打开看一眼版式（标题 + 两条 • 项目符号）

---

## 3. Sheets · 可见表格会话（无需开后台）

```bash
# 3.1 打开一个空白表格标签页
# 注意：与 app 内"新建表格"一致，默认保存目录会先落一个"未命名表格N.xlsx"底稿（属预期）
node "$TEMP/mcp-probe.mjs" call create_session '{"family":"xlsx"}'

# 3.2 读工作簿概览 —— 拿到 sheetId（apply_sheet_ops 的 ops 必须带它）
node "$TEMP/mcp-probe.mjs" call read_sheet '{}'
```

**期望**：

- 3.1 返回 `{"ok":true,"workbookId":<数字>,"message":...}`，app 出现表格标签页
- 3.2 返回 `{"context":{"mode":"lazy",...,"sheetId":"...","sheets":[...]}}`——记下 `sheetId`

```bash
# 3.3 填数据 + 公式（一批一个撤销步骤；把 <SHEET_ID> 换成 3.2 的值）
node "$TEMP/mcp-probe.mjs" call apply_sheet_ops '{"ops":[{"op":"set_cell","sheetId":"<SHEET_ID>","address":"A1","value":"品名"},{"op":"set_cell","sheetId":"<SHEET_ID>","address":"A2","value":"零件"},{"op":"set_cell","sheetId":"<SHEET_ID>","address":"B1","value":"数量"},{"op":"set_cell","sheetId":"<SHEET_ID>","address":"B2","value":12},{"op":"set_formula","sheetId":"<SHEET_ID>","address":"B3","formula":"=SUM(B2:B2)"}]}'

# 3.4 读回单元格（值 + 公式）
node "$TEMP/mcp-probe.mjs" call read_sheet '{"addresses":["A1","A2","B2","B3"]}'

# 3.5 dryRun 只出计划不改网格
node "$TEMP/mcp-probe.mjs" call apply_sheet_ops '{"ops":[{"op":"set_cell","sheetId":"<SHEET_ID>","address":"C1","value":"x"}],"dryRun":true}'
node "$TEMP/mcp-probe.mjs" call read_sheet '{"addresses":["C1"]}'

# 3.6 非法 op → 整批拒绝
node "$TEMP/mcp-probe.mjs" expect-error apply_sheet_ops '{"ops":[{"op":"NoSuchOp"}]}'
```

**期望**：

- 3.3 返回 `"ok": true`（可能带附加字段）；**网格实时**出现数据，B3 显示计算结果 12
- 3.4 返回 `{"cells":{"A1":{"value":"品名"},...,"B3":{"value":...,"formula":"=SUM(B2:B2)"}}}`
  —— B3 的 `value` 可能是 `null`（读取时引擎尚未算完）或 `12`，`formula` 必须在
- 3.5 dryRun 返回 `"dryRun": true` 和 `cellChanges`；第二次 read 确认 **C1 没有被写入**
- 3.6 报错,校验信息点名违规 op(如 `op #0 (NoSuchOp) is invalid`);
  漏 sheetId 的 op 会附「先 read_sheet 拿 sheetId」提示
  (早期版本此处误报 `Unknown sheet: undefined`)

```bash
# 3.7 输出到指定位置（会话结束；走与 Ctrl+S 相同的保存管线）
node "$TEMP/mcp-probe.mjs" call save_session "{\"path\":\"$OUT/visible.xlsx\",\"overwrite\":true}"

# 3.8 会话已结束：再编辑应报错
node "$TEMP/mcp-probe.mjs" expect-error read_sheet '{"addresses":["A1"]}'

# 3.9 落盘内容验证（值 + 公式都要在）
node "$TEMP/mcp-verify.mjs" "$OUT/visible.xlsx" "品名" "零件" "<f>SUM(B2:B2)</f>"
```

**期望**：

- 3.7 返回 `{"ok":true,"path":"...visible.xlsx"}`，文件存在；保存后标签页标题变为 `visible.xlsx`
- 3.8 报错文案含 `create_session`
- 3.9 三个关键词全部 PASS；有条件的话用 Excel/WPS 打开——B2 是数字类型（右对齐），
  B3 是公式且显示 12

---

## 4. 后台生成（需要把"后台生成"打开）

到 **设置 → MCP 设置 → 后台生成** 打开开关（服务会自动重启，属预期——旧会话失效）。

```bash
# 4.1 工具数变为 20
node "$TEMP/mcp-probe.mjs" tools

# 4.2 Slides：Markdown 大纲 → pptx（# 开新页，- 项目符号，1. 编号，## 加粗行）
node "$TEMP/mcp-probe.mjs" call create_pptx "{\"title\":\"后台演示\",\"outline\":\"# 开场\\n- 第一点\\n- 第二点\\n\\n# 结论\\n## 加粗小结\\n1. 编号项\\n\",\"path\":\"$OUT/bg.pptx\",\"overwrite\":true}"

# 4.3 Slides：JSON 大纲
node "$TEMP/mcp-probe.mjs" call create_pptx "{\"title\":\"JsonDeck\",\"format\":\"json\",\"outline\":\"{\\\"slides\\\":[{\\\"title\\\":\\\"JSON 页\\\",\\\"bullets\\\":[\\\"a\\\",{\\\"text\\\":\\\"二级\\\",\\\"level\\\":1}]}]}\",\"path\":\"$OUT/json.pptx\",\"overwrite\":true}"

# 4.4 同名再写不带 overwrite → 必须被拒
node "$TEMP/mcp-probe.mjs" expect-error create_pptx "{\"title\":\"后台演示\",\"outline\":\"# A\",\"path\":\"$OUT/bg.pptx\"}"

# 4.5 Sheets：行数组 → xlsx（数字自动按数值类型写入；纯值版，不做公式/样式）
node "$TEMP/mcp-probe.mjs" call create_xlsx "{\"title\":\"后台表格\",\"data\":[[\"品名\",\"数量\"],[\"零件\",12],[\"部件\",3.5]],\"sheetName\":\"数据\",\"path\":\"$OUT/bg.xlsx\",\"overwrite\":true}"

# 4.6 同名再写不带 overwrite → 必须被拒
node "$TEMP/mcp-probe.mjs" expect-error create_xlsx "{\"title\":\"后台表格\",\"data\":[[1]],\"path\":\"$OUT/bg.xlsx\"}"

# 4.7 落盘内容验证
node "$TEMP/mcp-verify.mjs" "$OUT/bg.pptx" "开场" "第一点" "结论" "加粗小结"
node "$TEMP/mcp-verify.mjs" "$OUT/json.pptx" "JSON 页" "二级"
node "$TEMP/mcp-verify.mjs" "$OUT/bg.xlsx" "品名" "零件" "<c r=\"B2\"><v>12</v></c>"
```

**期望**：

- 4.1 工具 20 个 = §1 的 17 个 + `create_docx` + `create_pptx` + `create_xlsx`
- 4.2 返回 `{"path":...,"slides":2,"bytes":>0}`；4.3 返回 `"slides":1`；**app 不出现新标签页**
- 4.4 / 4.6 报错含 `already exists`
- 4.7 全部 PASS；有条件的话用 PowerPoint/Excel 打开——pptx 两页版式正常，
  xlsx 的数量列是数字类型（右对齐）
- 已知边界：`create_xlsx` 是**纯值版**，写公式/样式请走 §3 的可见会话

测完把**后台生成开关拨回默认（关）**，再跑一次 `tools` 确认回到 17 个。

---

## 5. 设置页检查

1. **能力行**：设置 → MCP 设置 → 可用能力，应列出
   "文档 (Word)"、"演示 (PowerPoint)"、"表格 (Excel)"、"PDF" 四行；
   PDF 行描述为读取能力（只读是最终设计）。
2. **后台开关热切换**（回归项）：开→`tools` 多出 3 个 create_* 工具；关→消失。
   切换期间 app 不需要重启。
3. **连接信息**：三个 URL 与端口一致，复制按钮可用（顺手验证，不做硬性要求）。

---

## 6. 通过标准（核对清单）

| #   | 项目             | 通过条件                                                                                    |
| --- | ---------------- | ------------------------------------------------------------------------------------------- |
| 1   | 工具列表（默认） | 14 个（含 `read_pdf`），无任何 `create_docx/pptx/xlsx`                                      |
| 2   | Slides 可见会话  | 建页→实时渲染→读回→dryRun 不改→非法 op 拒绝→存盘→结束后报错；pptx 内容验证 PASS             |
| 3   | Sheets 可见会话  | 建表→实时填充→读回(值+公式)→dryRun 不改→非法 op 拒绝→存盘→结束后报错；xlsx 值+公式验证 PASS |
| 4   | 后台 create_pptx | markdown/JSON 直接落盘、无新标签页；覆盖保护生效                                            |
| 5   | 后台 create_xlsx | 行数组直接落盘、数值类型正确；覆盖保护生效                                                  |
| 6   | 后台开关热切换   | 开 17 / 关 14，即时生效                                                                     |
| 7   | 能力行           | 文档 + 演示 + 表格 + PDF 四行已提供；PDF 为只读描述                                         |

**判定口径**：任何一条 FAIL 都算 bug，按 P0（功能不可用）/ P1（功能错误）/ P2（体验/文案）分级。

---

## 7. 已知边界与已知存量失败（不要误报）

**功能边界（设计如此）**：

- `create_xlsx` 后台版只写值，不写公式/样式（公式走可见会话）
- `read_sheet` 对 B3 这类公式单元格，`value` 可能是 `null`（引擎尚未算完的瞬时读取），
  `formula` 字段必须在；保存后的文件里缓存值正确
- 每类 app 同时只有一个 MCP 可见会话；`save_session` 会结束会话
- `create_session family=xlsx` 会在默认保存目录留下一个"未命名表格N.xlsx"底稿（与 app 内新建表格一致）

**测试基础设施**：

- 仓库级 `npx vitest run`（全工作区）在本 Windows 机器上有约 11 个**存量失败**，与本次改动无关
  （已用 stash 对照验证）。涉及：ai-search genoffice-auth、docs protect-dialog、
  electron-utils dialog-memory/default-save-dir、pdf generated-output、sheets csv-import/
  promote-file-atomically、slides ai-panel-collapse、html2docx features。
  不要把它们算进本次测试结论。
- **shell 工作区全量测试是绿的**（`cd apps/shell && npx vitest run`，312 个），可作为对照。

---

## 8. 清理

- 关闭测试产生的所有标签页
- 删除 `$OUT` 临时目录
- 删除 `%TEMP%\mcp-probe.mjs`、`%TEMP%\mcp-verify.mjs`
- 删除默认保存目录里测试留下的"未命名表格N.xlsx"（每个 `create_session family=xlsx` 调用一个）
- 把"后台生成"开关拨回关（如 §4 后没拨回）

## 报告格式

按 §6 核对清单逐项给 PASS/FAIL；FAIL 附：执行的命令 + 实际输出（文本或截图）+ 复现步骤。
另请记录：app 版本、构建时间（`out/main/index.js` 的 mtime）、是否先完成了 §0.1 的重建。
