# MCP 里程碑计划:PPT 与表格

Status 文档。基于 [mcp-phase2-feasibility.md](./mcp-phase2-feasibility.md) 的调研结论,
拆成两个里程碑:**M1 = Slides(pptx)**,**M2 = Sheets(xlsx)**。

**标记规则**:每完成一项,把 `- [ ]` 改成 `- [x]`,并在「进度记录」追加一行
(日期 + 完成内容 + 提交哈希)。里程碑全部勾完时把该里程碑的 `Status` 改为 `已完成`。

通用背景:能力开关沿用 `mcpBackground` 语义(后台生成默认关,翻转即重启服务);
工具描述保持英文;所有新增 UI 文案进 20 语言 strings(zh 定义 keyset)。

---

## 里程碑 1: Slides (pptx)

Status: **未开始**

调研要点:pptx-engine 纯 Node(`createBlankPptx`/`openPptx`/`savePptxToFile`);
编辑会话在主进程(`Session`/`runTxn`,约 60 个原子 op);可见编辑**不需要渲染器桥**,
直接调 slides-main 会话再广播。

### M1.1 后台生成 `create_pptx`

- [ ] `apps/shell/src/main/mcp/tools/slides-tools.ts`:大纲(markdown/JSON)→ op 序列 →
      `createBlankPptx` + `runTxn` + `savePptxToFile`,输出路径策略复用 docx 的
      `resolveTargetPath`(sanitize/unique/overwrite)
- [ ] 受 `background` 开关门控(与 `create_docx` 同规则),翻转重启服务
- [ ] 单测:大纲映射、路径策略、background 门控(参照 `document-tools.test.ts` 形态)

### M1.2 可见会话(演示逐页生成,用户可观看)

- [ ] `SlidesControl`(`{ openBlankTab, runTxn }` 形态)注入 `McpRuntimeDeps`;无注入时工具不注册
- [ ] 会话工具:`create_deck`(开新标签页)→ `read_deck`(页/元素索引)→
      `apply_slide_ops`(批量 op,复用 `runTxn` 的原子/dryRun)→ `save_deck`(指定路径)
- [ ] 编辑落库走主进程会话:`runTxn` + history + `scheduleDeckBroadcast`(对齐
      `slides:apply-txn` 行为),app 窗口实时可见
- [ ] 会话结束语义与 docs 一致:`save_deck` 后会话关闭,再编辑报错提示先 `create_deck`

### M1.3 集成收尾

- [ ] 设置页能力行:演示从「即将支持」改为已提供(动态化或改静态行均可,倾向动态化);
      20 语言 strings 补齐
- [ ] e2e:`e2e/mcp-*.spec.ts` 跑真机——可见建 deck → 写内容 → 存盘 → 解包 pptx 验证
- [ ] `planning/mcp-test-runbook.md` 增补 Slides 章节(含后台/可见两路径)
- [ ] `planning/mcp-server.md` 工具清单更新;shell 全量测试 + typecheck + prettier 通过

**验收标准**:runbook 新增章节全过;关开关时 `tools/list` 无任何 slides 工具,
开后 `create_pptx`/会话工具齐备;保存的 .pptx 能被 `openPptx` 重新解析且内容一致。

---

## 里程碑 2: Sheets (xlsx)

Status: **未开始**

调研要点:纯值 xlsx 已有 Node-safe 写入(`blankXlsxBuffer`/`sheetCsvToXlsxBuffer`,
shell 主进程已在用);公式保真走 Rust sidecar(`XlsxSidecarClient` + recalc);
可见编辑需**新建**渲染器 ops 通道(workbook-dsl → `applyChangePlan`)。

### M2.1 后台生成 `create_xlsx`(纯值版先行)

- [ ] `apps/shell/src/main/mcp/tools/sheets-tools.ts`:CSV/行数组 → `sheetCsvToXlsxBuffer`
      → 落盘,路径策略同上;受 `background` 门控
- [ ] 单测(纯 Node,参照 `apps/sheets/tests/xlsx-sidecar.test.ts` 可脱离 Electron 的先例)

### M2.2 后台生成·公式保真(可选增强,允许延后)

- [ ] 驱动 `XlsxSidecarClient`:写入含公式的 workbook → `recalc_cells` 补缓存值 →
      `save_archive`
- [ ] 单测断言公式与缓存值;确认打包产物含 sidecar 二进制

### M2.3 可见会话(网格实时填充)

- [ ] `sheets-bridge.ts`:仿 docs-bridge 的请求/响应通道
      (`sheets:mcp-command` / `sheets:mcp-result` / 就绪信号),渲染层把 DSL ops
      转发给 `planFromOps` + `applyChangePlan`(与内置 AI 共用执行器)
- [ ] 会话工具:`create_sheet`(开空表标签页)→ `read_sheet`(范围/单元格读取)→
      `apply_sheet_ops`(`set_cell`/`set_formula`/`fill_range`/`add_sheet`…)→
      `save_sheet`(指定路径,走既有保存管线)
- [ ] `SheetsControl` 注入 + 门控 + 翻转重启,语义与 docs/slides 对齐
- [ ] 20 语言 strings(新设置文案);能力行更新

### M2.4 集成收尾

- [ ] e2e 真机:可见建表 → 填数据/公式 → 存盘 → sidecar 读回验证值与公式
- [ ] `planning/mcp-test-runbook.md` 增补 Sheets 章节
- [ ] `planning/mcp-server.md` 更新;shell 全量测试 + typecheck + prettier 通过

**验收标准**:runbook 新增章节全过;后台路径生成的 .xlsx 在 Excel/WPS 打开数值正确
(公式版缓存值正确);可见路径界面实时填充、保存走既有白名单管线。

---

## 共用完成定义(DoD)

1. 新工具在后台关时不注册、开时注册,翻转即时生效(回归:同端口 tools/list 变化)
2. 所有错误路径有文案并返回 isError(路径校验/覆盖保护/无会话)
3. 单测 + 真机 e2e 双覆盖;`npm run typecheck -w @genoffice/shell`、全量 shell 测试、
   `check:theme-colors`、prettier 全绿
4. 新 UI 文案 20 语言齐全(strings parity 测试过)
5. runbook 与 mcp-server.md 同步更新

## 进度记录

| 日期              | 完成项 | 提交    |
| ----------------- | ------ | ------- |
| (示例) 2026-09-12 | M1.1   | abc1234 |
