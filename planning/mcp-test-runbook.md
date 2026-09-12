# MCP 全功能测试流程（命令行直测）

Status: 测试手册。不接任何智能体，全部用 curl / Node 脚本直接打 `http://127.0.0.1:3093/mcp`，
覆盖当前全部 MCP 功能：可见文档会话、后台生成、读取/打开、错误路径、日志、旧版 SSE 与 stdio 桥。

适用版本：带"可见编辑会话 + 后台生成开关 + 日志"的构建（2026-09 之后）。若工具列表与本文不符，
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

> 注意：可见会话的测试会**真实打开标签页**，请在 GenOffice 窗口里同步观察；`save_document` 会写真实文件。

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

**期望（后台生成 = 关，默认）**，9 个工具：

```
apply_ops, create_document, get_app_info, insert_content, open_in_genoffice,
read_docx, read_document, replace_blocks, save_document
```

**不应出现 `create_docx`。**

然后到 **设置 → MCP 设置 → 后台生成** 打开开关（服务会自动重启），再跑一次：

**期望（后台生成 = 开）**，10 个工具：上面 9 个 + `create_docx`。

测完可以把开关拨回默认（关），不影响后续章节。

## 3. 可见文档会话（核心功能）

依次执行（每条之间在 app 窗口观察）：

```bash
# 3.1 打开一个空白文档标签页 —— app 应立刻出现一个新标签
node "$TEMP/mcp-probe.mjs" call create_document '{}'

# 3.2 写入内容 —— 编辑器里应实时出现标题/正文/列表/表格
node "$TEMP/mcp-probe.mjs" call insert_content '{"html":"<h1>测试文档</h1><p>第一段内容。</p><ul><li>甲</li><li>乙</li></ul><table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>"}'

# 3.3 改格式 —— 标题居中、第二块加粗
node "$TEMP/mcp-probe.mjs" call apply_ops '{"ops":[{"op":"setParagraphFormat","target":{"blockIndexes":[0]},"align":"center"},{"op":"setFont","target":{"blockIndexes":[1]},"bold":true}]}'

# 3.4 读回当前文档
node "$TEMP/mcp-probe.mjs" call read_document '{}'
```

**期望**：

- 3.1 返回 `{"ok":true,"documentId":<数字>,"message":...}`
- 3.2 / 3.3 返回 `{"summary":"...","mutated":true}`，界面同步变化（表格可见、标题居中）
- 3.4 返回 `{"text":"..."}`，含"测试文档"和列表项
- 会话期间标签页标题为"未命名文档"之类；全程**没有**保存对话框

```bash
# 3.5 输出到指定位置
node "$TEMP/mcp-probe.mjs" call save_document "{\"path\":\"$OUT/visible.docx\",\"overwrite\":true}"

# 3.6 会话已结束: 再编辑应报错
node "$TEMP/mcp-probe.mjs" expect-error insert_content '{"html":"<p>迟到内容</p>"}'
```

**期望**：3.5 返回 `{"ok":true,"path":"...visible.docx"}`，文件存在（`ls "$OUT"`）；
3.6 报错且文案含 `create_document`。保存后标签页标题变为 `visible.docx`。

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
# 没有活动文档就编辑 → 必须提示先 create_document
node "$TEMP/mcp-probe.mjs" expect-error insert_content '{"html":"<p>x</p>"}'
```

**期望**：三条错误文案分别含 `file not found` / `path must be absolute` / `no document is open`。

```bash
# 打开会话后:非法 ops(整批原子拒绝,返回含 usage 提示)
node "$TEMP/mcp-probe.mjs" call create_document '{}'
node "$TEMP/mcp-probe.mjs" expect-error apply_ops '{"ops":[{"op":"NoSuchOp"}]}'
# dryRun 只校验不修改
node "$TEMP/mcp-probe.mjs" call apply_ops '{"ops":[{"op":"setHeadingLevel","target":{"blockIndexes":[0]},"level":2}],"dryRun":true}'
node "$TEMP/mcp-probe.mjs" call read_document '{}'
# 结束会话(顺带验证 dryRun 没有破坏文档)
node "$TEMP/mcp-probe.mjs" call save_document "{\"path\":\"$OUT/dry.docx\",\"overwrite\":true}"
```

**期望**：非法 ops 错误含 `unknown op`；dryRun 返回 `plan` 且 `read_document` 显示文档**没有**变化；
最后的 save_document 正常写出文件。

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

**期望**：stdout 收到 2 条 JSON-RPC 响应；id=2 的响应 `result.tools` 含 `create_document` 等工具名。
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
- **后台生成开关即时生效**：开→`tools` 多出 `create_docx`；关→消失（对应旧会话已失效，见 §9 的 404 行为）。

---

## 通过标准（核对清单）

| #   | 项目           | 通过条件                                                                                     |
| --- | -------------- | -------------------------------------------------------------------------------------------- |
| 1   | 健康检查       | `/health` 返回 ok + 正确端口                                                                 |
| 2   | 工具列表       | 默认 9 个无 `create_docx`；后台开 10 个                                                      |
| 3   | 可见会话       | 建空档→写内容→改格式→读回→存盘，界面全程同步、无对话框；保存后文件存在；会话结束后再编辑报错 |
| 4   | 后台生成       | markdown/blocks 直接落盘、无新标签页；覆盖保护生效                                           |
| 5   | 读取/打开      | `read_docx` 文本正确（表格除外，已知边界）；`open_in_genoffice` 聚焦标签页                   |
| 6   | 错误路径       | 缺文件/相对路径/非法 ops/伪造 session(404)/未初始化(400) 全部按预期拒绝                      |
| 7   | 日志           | 开关控制写入；含 listening/session/tool ok 行；清除有效                                      |
| 8   | SSE + stdio 桥 | SSE 握手回包；桥转发 tools/list 成功                                                         |
| 9   | 会话生命周期   | DELETE 后旧 session 404                                                                      |
| 10  | 设置行为       | 改端口/切后台开关即时生效，连接信息 URL 同步                                                 |

全部通过后清理：关闭测试产生的标签页、删除 `$OUT` 临时目录、删除 `%TEMP%\mcp-probe.mjs`。
