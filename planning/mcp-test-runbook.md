# MCP 全功能测试流程（命令行直测）

Status: 测试手册。不接任何智能体，全部用 curl / Node 脚本直接打 `http://127.0.0.1:3093/mcp`，
覆盖当前全部 MCP 功能：可见文档会话、演示(PPT)会话、表格(xlsx)会话、后台生成、读取/打开、
错误路径、日志、旧版 SSE 与 stdio 桥。

适用版本：带"可见编辑会话 + 演示会话 + 后台生成开关 + 日志"的构建（2026-09 之后）。若工具列表与本文不符，
先重新构建：`npm run build -w @genoffice/shell && npm run build -w @genoffice/docs`，重启 app。

---

## 0. 前置条件

1. GenOffice app 正在运行，**设置 → MCP 设置 → 本地 MCP 服务**已打开（开关为开，状态行绿点"运行中"）。
   端口默认 `3093`。若改过端口，下文所有命令先执行 `export MCP_PORT=你的端口`。
2. 设置里**后台生成**默认关——这本身是测试项之一（见 §2）。
3. 保存探针脚本（后面的测试都靠它）。把下面内容存为**仓库外**的临时文件，如 `%TEMP%\mcp-probe.mjs`：

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

4. 准备一个输出目录，例如 `export OUT=$(mktemp -d)`（或自定 `D:/tmp/mcp-test`）。

> 注意：可见会话的测试会**真实打开标签页**，请在 GenOffice 窗口里同步观察；`save_session` 会写真实文件。

---

## 1. 健康检查

```bash
curl -s http://127.0.0.1:${MCP_PORT:-3093}/health
```

**期望**：`{"status":"ok","server":"GenOffice","transport":"StreamableHTTP + SSE","port":3093}`

## 2. 工具列表（后台生成 开/关 两种状态）

```bash
node "$TEMP/mcp-probe.mjs" tools
```

**期望（后台生成 = 关，默认）**，14 个工具：

```
apply_ops, apply_sheet_ops, apply_slide_ops, create_session, get_app_info,
insert_content, open_in_genoffice, read_deck, read_docx, read_document,
read_pdf, read_sheet, replace_blocks, save_session
```

**不应出现 `create_docx`、`create_pptx`、`create_xlsx`。**

然后到 **设置 → MCP 设置 → 后台生成** 打开开关（服务会自动重启），再跑一次：

**期望（后台生成 = 开）**，17 个工具：上面 14 个 + `create_docx` + `create_pptx` + `create_xlsx`。

测完可以把开关拨回默认（关），不影响后续章节。

顺手验证只读的 PDF 抽取（不需要 app 界面）：

```bash
node "$TEMP/mcp-probe.mjs" call read_pdf '{"path":"C:/绝对路径/某个文件.pdf"}'
```

**期望**：返回 `pageCount`、`info.title`（如有）与逐页 `text`；用 `{"pages":"1-2"}` 再试一次应只返回前两页。扫描件（无文本层）页面 `text` 为空且 `hasTextLayer:false`；损坏/加密文件报"could not open the PDF"。

## 3. 可见文档会话（核心功能）

依次执行（每条之间在 app 窗口观察）：

```bash
# 3.1 打开一个空白文档标签页 —— app 应立刻出现一个新标签
node "$TEMP/mcp-probe.mjs" call create_session '{"family":"docx"}'

# 3.2 写入内容 —— 编辑器里应实时出现标题/正文/列表/表格
node "$TEMP/mcp-probe.mjs" call insert_content '{"html":"<h1>测试文档</h1><p>第一段内容。</p><ul><li>甲</li><li>乙</li></ul><table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>"}'

# 3.3 改格式 —— 标题居中、第二块加粗
node "$TEMP/mcp-probe.mjs" call apply_ops '{"ops":[{"op":"setParagraphFormat","target":{"blockIndexes":[0]},"align":"center"},{"op":"setFont","target":{"blockIndexes":[1]},"bold":true}]}'

# 3.4 读回当前文档
node "$TEMP/mcp-probe.mjs" call read_document '{}'
```

**期望**：

- 3.1 返回 `{"ok":true,"family":"docx","sessionId":<数字>,"message":...}`
- 3.2 / 3.3 返回 `{"summary":"...","mutated":true}`，界面同步变化（表格可见、标题居中）
- 3.4 返回 `{"text":"..."}`，含"测试文档"和列表项
- 会话期间标签页标题为"未命名文档"之类；全程**没有**保存对话框

```bash
# 3.5 输出到指定位置
node "$TEMP/mcp-probe.mjs" call save_session "{\"path\":\"$OUT/visible.docx\",\"overwrite\":true}"

# 3.6 会话已结束: 再编辑应报错
node "$TEMP/mcp-probe.mjs" expect-error insert_content '{"html":"<p>迟到内容</p>"}'
```

**期望**：3.5 返回 `{"ok":true,"path":"...visible.docx"}`，文件存在（`ls "$OUT"`）；
3.6 报错且文案含 `create_session`。保存后标签页标题变为 `visible.docx`。

## 4. 后台生成（需要 §2 中把"后台生成"打开）

```bash
# 4.1 Markdown → docx，直接落盘,不打开任何标签页
node "$TEMP/mcp-probe.mjs" call create_docx "{\"title\":\"后台测试\",\"content\":\"# 后台标题\\n\\n正文**加粗**。\\n\\n- 项一\\n- 项二\\n\",\"path\":\"$OUT/bg.docx\",\"overwrite\":true}"

# 4.2 blocks 格式
node "$TEMP/mcp-probe.mjs" call create_docx "{\"title\":\"Blocks\",\"format\":\"blocks\",\"content\":\"[{\\\"kind\\\":\\\"generated\\\",\\\"block\\\":{\\\"type\\\":\\\"heading\\\",\\\"level\\\":1,\\\"runs\\\":[{\\\"text\\\":\\\"Blocks 标题\\\"}]}}]\",\"path\":\"$OUT/blocks.docx\",\"overwrite\":true}"

# 4.3 同名再写不带 overwrite → 必须被拒
node "$TEMP/mcp-probe.mjs" expect-error create_docx "{\"title\":\"后台测试\",\"content\":\"x\",\"path\":\"$OUT/bg.docx\"}"
```

**期望**：4.1/4.2 返回 `{"path":...,"bytes":>0}`，**app 不出现新标签页**；
4.3 报错含 `already exists`。

## 5. 读取与在应用中打开

```bash
node "$TEMP/mcp-probe.mjs" call read_docx "{\"path\":\"$OUT/visible.docx\"}"
node "$TEMP/mcp-probe.mjs" call open_in_genoffice "{\"path\":\"$OUT/visible.docx\"}"
```

**期望**：

- `read_docx` 返回 `{"path":...,"name":"visible.docx","text":...}`，文本含"测试文档"和列表项。
  **已知边界**：表格单元格文本**不会**出现在返回里（read_docx 只提取段落），不算失败。
- `open_in_genoffice` 返回 `{"ok":true,...}`，app 聚焦/打开该文件对应的标签页。

## 6. 错误路径

```bash
# 不存在的文件
node "$TEMP/mcp-probe.mjs" expect-error read_docx '{"path":"D:/nope/none.docx"}'
# 相对路径
node "$TEMP/mcp-probe.mjs" expect-error read_docx '{"path":"relative.docx"}'
# 没有活动文档就编辑 → 必须提示先 create_session
node "$TEMP/mcp-probe.mjs" expect-error insert_content '{"html":"<p>x</p>"}'
```

**期望**：三条错误文案分别含 `file not found` / `path must be absolute` / `no session is open`。

```bash
# 打开会话后:非法 ops(整批原子拒绝,返回含 usage 提示)
node "$TEMP/mcp-probe.mjs" call create_session '{"family":"docx"}'
node "$TEMP/mcp-probe.mjs" expect-error apply_ops '{"ops":[{"op":"NoSuchOp"}]}'
# dryRun 只校验不修改
node "$TEMP/mcp-probe.mjs" call apply_ops '{"ops":[{"op":"setHeadingLevel","target":{"blockIndexes":[0]},"level":2}],"dryRun":true}'
node "$TEMP/mcp-probe.mjs" call read_document '{}'
# 结束会话(顺带验证 dryRun 没有破坏文档)
node "$TEMP/mcp-probe.mjs" call save_session "{\"path\":\"$OUT/dry.docx\",\"overwrite\":true}"
```

**期望**：非法 ops 错误含 `unknown op`；dryRun 返回 `plan` 且 `read_document` 显示文档**没有**变化；
最后的 save_session 正常写出文件。

**裸 HTTP 会话防护**（不经探针）：

```bash
# 伪造 session id → 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:${MCP_PORT:-3093}/mcp" \
  -H 'Content-Type: application/json' -H 'Mcp-Session-Id: 00000000-0000-0000-0000-000000000000' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# 未初始化就发消息 → 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:${MCP_PORT:-3093}/mcp" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**期望**：分别输出 `404` 和 `400`。

## 7. 日志

1. **设置 → MCP 设置 → 日志**打开开关。下方应出现"日志文件"行（`mcp-log.txt`，带"打开/清除"按钮）。
2. 触发一次调用：
   ```bash
   node "$TEMP/mcp-probe.mjs" call get_app_info '{}'
   ```
3. 检查日志文件（开发版路径；点设置里的"打开"按钮最直接）：
   ```bash
   tail -5 "$APPDATA/GenOffice Dev/mcp-log.txt"
   ```
   **期望**：含 `[mcp] listening on ...`、`[mcp] session initialized: ...`、
   `[mcp] tool get_app_info ok (...ms)`。
4. 点**清除** → 文件被清空（`wc -c "$APPDATA/GenOffice Dev/mcp-log.txt"` 为 0）。
5. 关闭日志开关 → 再调用工具 → 文件不再增长。

## 8. 旧版 SSE 传输 + stdio 桥

```bash
# 8.1 SSE 握手（后台挂 6 秒抓事件）
(curl -s -N -m 6 "http://127.0.0.1:${MCP_PORT:-3093}/sse" > /tmp/sse.raw &)
sleep 2
SID=$(grep -o 'sessionId=[a-z0-9-]*' /tmp/sse.raw | head -1 | cut -d= -f2)
echo "SID=$SID"   # 应非空,且 /tmp/sse.raw 里有 event: endpoint

# 8.2 经 /messages 发 initialize,响应回到 SSE 流
curl -s -X POST "http://127.0.0.1:${MCP_PORT:-3093}/messages?sessionId=$SID" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sse-probe","version":"1"}}}'
sleep 2
grep 'serverInfo' /tmp/sse.raw   # 期望出现 "name":"GenOffice"
```

```bash
# 8.3 stdio 桥（供 Claude Desktop / Cursor 等纯 stdio 客户端）
{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bridge-probe","version":"1"}}}' \
       '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
       '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 6; } \
| node scripts/mcp-stdio-bridge.js
```

**期望**：stdout 收到 2 条 JSON-RPC 响应；id=2 的响应 `result.tools` 含 `create_session` 等工具名。
（仓库根目录运行；stdin 必须保持打开几秒，否则进程提前退出。）

## 9. 会话生命周期

```bash
# 用探针之外的方式拿一个真实 session,然后 DELETE 它
INIT=$(curl -s -i -X POST "http://127.0.0.1:${MCP_PORT:-3093}/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"lifecycle","version":"1"}}}')
REAL_SID=$(echo "$INIT" | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
echo "REAL_SID=$REAL_SID"
curl -s -o /dev/null -w 'DELETE -> %{http_code}\n' -X DELETE "http://127.0.0.1:${MCP_PORT:-3093}/mcp" -H "Mcp-Session-Id: $REAL_SID"
curl -s -o /dev/null -w 'reuse   -> %{http_code}\n' -X POST "http://127.0.0.1:${MCP_PORT:-3093}/mcp" \
  -H "Mcp-Session-Id: $REAL_SID" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

**期望**：`DELETE -> 200`（或 204），复用旧 session → `404`。

## 10. 设置行为（可选）

- **改端口**：设置里把端口改成 `3094` → `curl -s http://127.0.0.1:3094/health` 应为 ok，3093 失效；
  连接信息区的三个 URL 同步变为 3094。测完改回。
- **后台生成开关即时生效**：开→`tools` 多出 `create_docx`、`create_pptx`、`create_xlsx`；关→消失（对应旧会话已失效，见 §9 的 404 行为）。
- **能力行**：设置 → MCP 设置 → 可用能力 应列出"文档 (Word)"、"演示 (PowerPoint)"、"表格 (Excel)"、"PDF"（读取，只读是最终设计）。

## 11. 演示（PPT，两个路径）

### 11.1 后台生成 `create_pptx`（需要 §2 中把"后台生成"打开）

```bash
# 11.1.1 Markdown 大纲 → pptx：`#` 开新页,`-` 项目符号,`1.` 编号,`##` 加粗行
node "$TEMP/mcp-probe.mjs" call create_pptx "{\"title\":\"后台演示\",\"outline\":\"# 开场\\n- 第一点\\n- 第二点\\n\\n# 结论\\n## 加粗小结\\n1. 编号项\\n\",\"path\":\"$OUT/bg.pptx\",\"overwrite\":true}"

# 11.1.2 JSON 大纲
node "$TEMP/mcp-probe.mjs" call create_pptx "{\"title\":\"JsonDeck\",\"format\":\"json\",\"outline\":\"{\\\"slides\\\":[{\\\"title\\\":\\\"JSON 页\\\",\\\"bullets\\\":[\\\"a\\\",{\\\"text\\\":\\\"二级\\\",\\\"level\\\":1}]}]}\",\"path\":\"$OUT/json.pptx\",\"overwrite\":true}"

# 11.1.3 同名再写不带 overwrite → 必须被拒
node "$TEMP/mcp-probe.mjs" expect-error create_pptx "{\"title\":\"后台演示\",\"outline\":\"# A\",\"path\":\"$OUT/bg.pptx\"}"
```

**期望**：11.1.1 返回 `{"path":...,"slides":2,"bytes":>0}`，11.1.2 返回 `"slides":1`，
**app 不出现新标签页**；11.1.3 报错含 `already exists`。
用 PowerPoint/WPS 打开 `bg.pptx`：两页，每页有标题与项目符号/编号，版式正常。

### 11.2 可见演示会话（默认可用，无需开"后台生成"）

```bash
# 11.2.1 打开一个空白演示标签页 —— app 应立刻出现一个新标签
node "$TEMP/mcp-probe.mjs" call create_session '{"family":"pptx"}'

# 11.2.2 建第 1 页内容 —— 幻灯片上应实时出现文本框
# offset 单位为 EMU（1 px = 9525 EMU）
node "$TEMP/mcp-probe.mjs" call apply_slide_ops '{"ops":[{"op":"addElement","target":{"slide":0},"kind":"textbox","offset":{"x":1143000,"y":685800,"cx":7315200,"cy":1127760},"paragraphs":[{"runs":[{"text":"MCP 标题","bold":true,"fontSize":36}],"align":"left"}]},{"op":"addElement","target":{"slide":0},"kind":"textbox","offset":{"x":1143000,"y":2057400,"cx":7315200,"cy":3657600},"paragraphs":[{"runs":[{"text":"第一点","fontSize":20}],"bullet":{"type":"char","char":"•"},"marL":342900,"indent":-342900},{"runs":[{"text":"第二点","fontSize":20}],"bullet":{"type":"char","char":"•"},"marL":342900,"indent":-342900}]}]}'

# 11.2.3 读回元素清单（拿到 id/几何，供后续 op 定位）
node "$TEMP/mcp-probe.mjs" call read_deck '{}'

# 11.2.4 dryRun 只出计划不改内容；再读一次确认没有变化
node "$TEMP/mcp-probe.mjs" call apply_slide_ops '{"ops":[{"op":"deleteSlide","target":{"slide":0}}],"dryRun":true}'
node "$TEMP/mcp-probe.mjs" call read_deck '{}'

# 11.2.5 非法 op → 整批原子拒绝,错误带 usage 提示
node "$TEMP/mcp-probe.mjs" expect-error apply_slide_ops '{"ops":[{"op":"NoSuchOp"}]}'

# 11.2.6 输出到指定位置（会话结束）
node "$TEMP/mcp-probe.mjs" call save_session "{\"path\":\"$OUT/visible.pptx\",\"overwrite\":true}"

# 11.2.7 会话已结束: 再编辑应报错
node "$TEMP/mcp-probe.mjs" expect-error read_deck '{}'
```

**期望**：

- 11.2.1 返回 `{"ok":true,"deckId":<数字>,"message":...}`，app 出现演示标签页
- 11.2.2 返回 `"applied": true` 和 `created` 元素 id；幻灯片**实时**出现标题与两个项目符号
- 11.2.3 返回 `{"emuPerPx":9525,...,"slides":[...]}`，元素文本含 "MCP 标题"
- 11.2.4 dryRun 返回 `plan`；第二次 `read_deck` 仍是 1 页
- 11.2.5 报错含 `unknown op`
- 11.2.6 返回 `{"path":"...visible.pptx"}`，文件存在；保存后标签页标题变为 `visible.pptx`
- 11.2.7 报错文案含 `create_session`

## 12. 表格（xlsx，两个路径）

### 12.1 后台生成 `create_xlsx`（需要 §2 中把"后台生成"打开；纯值版）

```bash
# 12.1.1 行数组 → xlsx（数字单元格自动按数值写入）
node "$TEMP/mcp-probe.mjs" call create_xlsx "{\"title\":\"后台表格\",\"data\":[[\"品名\",\"数量\"],[\"零件\",12],[\"部件\",3.5]],\"sheetName\":\"数据\",\"path\":\"$OUT/bg.xlsx\",\"overwrite\":true}"

# 12.1.2 同名再写不带 overwrite → 必须被拒
node "$TEMP/mcp-probe.mjs" expect-error create_xlsx "{\"title\":\"后台表格\",\"data\":[[1]],\"path\":\"$OUT/bg.xlsx\"}"
```

**期望**：12.1.1 返回 `{"path":...,"cells":6,"bytes":>0}`，**app 不出现新标签页**；
12.1.2 报错含 `already exists`。用 Excel/WPS 打开：数值列是数字类型（右对齐），文本正常。
已知边界：纯值版不做公式/样式——后台路径需要公式请改走 12.2 可见会话。

### 12.2 可见表格会话（默认可用，无需开"后台生成"）

```bash
# 12.2.1 打开一个空白表格标签页 —— app 应立刻出现一个新标签
# （与 app 内"新建表格"一致:默认保存目录会先落一个空白 .xlsx 作为底稿）
node "$TEMP/mcp-probe.mjs" call create_session '{"family":"xlsx"}'

# 12.2.2 读工作簿概览 —— 拿到 sheetId
node "$TEMP/mcp-probe.mjs" call read_sheet '{}'

# 12.2.3 填数据 + 公式（一次一批，整体一个撤销步骤）
# 把 <SHEET_ID> 换成 12.2.2 返回的 sheetId
node "$TEMP/mcp-probe.mjs" call apply_sheet_ops '{"ops":[{"op":"set_cell","sheetId":"<SHEET_ID>","address":"A1","value":"品名"},{"op":"set_cell","sheetId":"<SHEET_ID>","address":"A2","value":"零件"},{"op":"set_cell","sheetId":"<SHEET_ID>","address":"B1","value":"数量"},{"op":"set_cell","sheetId":"<SHEET_ID>","address":"B2","value":12},{"op":"set_formula","sheetId":"<SHEET_ID>","address":"B3","formula":"=SUM(B2:B2)"}]}'

# 12.2.4 读回单元格（值 + 公式）
node "$TEMP/mcp-probe.mjs" call read_sheet '{"addresses":["A1","A2","B2","B3"]}'

# 12.2.5 dryRun 只出计划不改网格
node "$TEMP/mcp-probe.mjs" call apply_sheet_ops '{"ops":[{"op":"set_cell","sheetId":"<SHEET_ID>","address":"C1","value":"x"}],"dryRun":true}'

# 12.2.6 非法 op → 整批拒绝
node "$TEMP/mcp-probe.mjs" expect-error apply_sheet_ops '{"ops":[{"op":"NoSuchOp"}]}'

# 12.2.7 输出到指定位置（会话结束;走与 Ctrl+S 相同的保存管线）
node "$TEMP/mcp-probe.mjs" call save_session "{\"path\":\"$OUT/visible.xlsx\",\"overwrite\":true}"

# 12.2.8 会话已结束: 再编辑应报错
node "$TEMP/mcp-probe.mjs" expect-error read_sheet '{"addresses":["A1"]}'
```

**期望**：

- 12.2.1 返回 `{"ok":true,"workbookId":<数字>,"message":...}`，app 出现表格标签页
- 12.2.2 返回 `{"context":{...}}`，含 sheets 数组（id/name/行列数）与活动 sheet
- 12.2.3 返回 `"ok": true`；**网格实时**出现数据与公式结果
- 12.2.4 返回 `{"cells":{...}}`：A1/A2/B2 有值，B3 含 `formula":"=SUM(B2:B2)"`
- 12.2.5 dryRun 返回计划（cellChanges/structuralChanges），`read_sheet` 确认 C1 没有被写入
- 12.2.6 报错（zod 校验拒绝或 unknown op）
- 12.2.7 返回 `{"ok":true,"path":"...visible.xlsx"}`，文件存在；保存后标签页标题变为 `visible.xlsx`
- 12.2.8 报错文案含 `create_session`
- 用 Excel/WPS 打开 `visible.xlsx`：数值正确，B3 是公式 `=SUM(B2:B2)` 且显示计算结果 12

---

## 通过标准（核对清单）

| #   | 项目           | 通过条件                                                                                                                                   |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 健康检查       | `/health` 返回 ok + 正确端口                                                                                                               |
| 2   | 工具列表       | 默认 14 个无 `create_docx`/`create_pptx`/`create_xlsx`；后台开 17 个                                                                       |
| 3   | 可见会话       | 建空档→写内容→改格式→读回→存盘，界面全程同步、无对话框；保存后文件存在；会话结束后再编辑报错                                               |
| 4   | 后台生成       | markdown/blocks 直接落盘、无新标签页；覆盖保护生效                                                                                         |
| 5   | 读取/打开      | `read_docx` 文本正确（表格除外，已知边界）；`read_pdf` 逐页文本/页数/标题正确，扫描页 `hasTextLayer:false`；`open_in_genoffice` 聚焦标签页 |
| 6   | 错误路径       | 缺文件/相对路径/非法 ops/伪造 session(404)/未初始化(400) 全部按预期拒绝                                                                    |
| 7   | 日志           | 开关控制写入；含 listening/session/tool ok 行；清除有效                                                                                    |
| 8   | SSE + stdio 桥 | SSE 握手回包；桥转发 tools/list 成功                                                                                                       |
| 9   | 会话生命周期   | DELETE 后旧 session 404                                                                                                                    |
| 10  | 设置行为       | 改端口/切后台开关即时生效，连接信息 URL 同步；能力行含文档+演示+表格+PDF(读取)                                                             |
| 11  | 演示 (PPT)     | 后台大纲落盘（PPT/WPS 可开）；可见会话建页→实时渲染→读回→存盘→结束后报错                                                                   |
| 12  | 表格 (xlsx)    | 后台纯值落盘（数值类型正确）；可见会话填值+公式→实时渲染→读回→存盘（公式保真）→结束后报错                                                  |

全部通过后清理：关闭测试产生的标签页、删除 `$OUT` 临时目录、删除 `%TEMP%\mcp-probe.mjs`。
