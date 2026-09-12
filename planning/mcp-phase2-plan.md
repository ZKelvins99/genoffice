# MCP 里程碑计划:PPT 与表格

Status 文档。基于 [mcp-phase2-feasibility.md](./mcp-phase2-feasibility.md) 的调研结论,
拆成两个里程碑:**M1 = Slides(pptx)**,**M2 = Sheets(xlsx)**。
专项验收测试手册:[mcp-slides-sheets-test.md](./mcp-slides-sheets-test.md)。

**标记规则**:每完成一项,把 `- [ ]` 改成 `- [x]`,并在「进度记录」追加一行
(日期 + 完成内容 + 提交哈希)。里程碑全部勾完时把该里程碑的 `Status` 改为 `已完成`。

通用背景:能力开关沿用 `mcpBackground` 语义(后台生成默认关,翻转即重启服务);
工具描述保持英文;所有新增 UI 文案进 20 语言 strings(zh 定义 keyset)。

---

## 里程碑 1: Slides (pptx)

Status: **已完成**（2026-09-12，提交 ef4b620）

调研要点:pptx-engine 纯 Node(`createBlankPptx`/`openPptx`/`savePptxToFile`);
编辑会话在主进程(`Session`/`runTxn`,约 60 个原子 op);可见编辑**不需要渲染器桥**,
直接调 slides-main 会话再广播。

### M1.1 后台生成 `create_pptx`

- [x] `apps/shell/src/main/mcp/tools/slides-tools.ts`:大纲(markdown/JSON)→ op 序列 →
      `createBlankPptx` + `runTxn` + `savePptxToFile`,输出路径策略复用 docx 的
      `resolveTargetPath`(sanitize/unique/overwrite)
      —— 实现为 `outlineToTxns` 两段式批事务(runTxn 按事务前状态做计划,
      同批内新建页不能被后续 op 引用:先 addBlankSlide 建满页,再统一填充)
- [x] 受 `background` 开关门控(与 `create_docx` 同规则),翻转重启服务
- [x] 单测:大纲映射、路径策略、background 门控(`apps/shell/tests/mcp/slides-tools.test.ts`)

### M1.2 可见会话(演示逐页生成,用户可观看)

- [x] `SlidesControl`(`{ openBlankTab, runTxn }` 形态)注入 `McpRuntimeDeps`;无注入时工具不注册
- [x] 会话工具:`create_deck`(开新标签页)→ `read_deck`(页/元素索引)→
      `apply_slide_ops`(批量 op,复用 `runTxn` 的原子/dryRun)→ `save_deck`(指定路径)
- [x] 编辑落库走主进程会话:`runTxn` + history + `scheduleDeckBroadcast`(对齐
      `slides:apply-txn` 行为),app 窗口实时可见
      —— `applySessionTxn` 从 `slides:apply-txn` IPC 处理器中提取,
      IPC 与 MCP 桥共用同一实现(含 autofit 渲染后处理);单窗口时 broadcast 是
      no-op(它假设发起方渲染器会自己应用 IPC 返回值,而 MCP 没有发起方),
      所以桥在事务成功后主动向标签页 webContents 推送一次 deck-changed
      (多窗口场景仍由 broadcast 负责;渲染器幂等应用)
- [x] 会话结束语义与 docs 一致:`save_deck` 后会话关闭,再编辑报错提示先 `create_deck`

### M1.3 集成收尾

- [x] 设置页能力行:演示从「即将支持」改为已提供(动态化或改静态行均可,倾向动态化);
      20 语言 strings 补齐
      —— `McpStatus.capabilities` 驱动能力行(docs/slides/sheets),PDF 保持
      "即将支持"行;新增 setMcpCapSlides/setMcpCapSheets 系列 × 20 语言
- [x] e2e:`e2e/mcp-visible-deck.spec.ts` 跑真机——可见建 deck → 写内容 → 存盘 → 解包 pptx 验证
      —— 含**画布重绘断言**:快照应用 op 前后所有 canvas 的像素指纹,断言可见标签页
      实时上屏(曾在验收测试中暴露单窗口广播被吞的 P1,先红后绿修复,见进度记录)
- [x] `planning/mcp-test-runbook.md` 增补 Slides 章节(§11,含后台/可见两路径)
- [x] `planning/mcp-server.md` 工具清单更新;shell 全量测试 + typecheck + prettier 通过

**验收标准**:runbook 新增章节全过;关开关时 `tools/list` 无任何 slides 工具,
开后 `create_pptx`/会话工具齐备;保存的 .pptx 能被 `openPptx` 重新解析且内容一致。

---

## 里程碑 2: Sheets (xlsx)

Status: **已完成**（2026-09-12，提交 9d6dcbd；M2.2 公式保真为可选项，按计划延后）

调研要点:纯值 xlsx 已有 Node-safe 写入(`blankXlsxBuffer`/`sheetCsvToXlsxBuffer`,
shell 主进程已在用);公式保真走 Rust sidecar(`XlsxSidecarClient` + recalc);
可见编辑需**新建**渲染器 ops 通道(workbook-dsl → `applyChangePlan`)。

### M2.1 后台生成 `create_xlsx`(纯值版先行)

- [x] `apps/shell/src/main/mcp/tools/sheets-tools.ts`:CSV/行数组 → `sheetCsvToXlsxBuffer`
      → 落盘,路径策略同上;受 `background` 门控
      —— 落地为 `rowsToXlsxBuffer`(行矩阵直写,不做 CSV 往返,单元格文本可含任意字符)
- [x] 单测(纯 Node,参照 `apps/sheets/tests/xlsx-sidecar.test.ts` 可脱离 Electron 的先例)
      (`apps/shell/tests/mcp/sheets-tools.test.ts`:数值类型、路径策略、门控)

### M2.2 后台生成·公式保真(可选增强,允许延后)

- [ ] 驱动 `XlsxSidecarClient`:写入含公式的 workbook → `recalc_cells` 补缓存值 →
      `save_archive`
      —— **延后**:`saveWorkbookViaSidecar` 依赖 gateway 的整套编辑计划结构
      (`planCellEditsToXlsx` 约 25 组参数),装配成本高;后台需要公式时
      走 M2.3 的可见会话(`set_formula` + 保存管线自带 recalc/缓存值)
- [ ] 单测断言公式与缓存值;确认打包产物含 sidecar 二进制

### M2.3 可见会话(网格实时填充)

- [x] `sheets-bridge.ts`:仿 docs-bridge 的请求/响应通道
      (`sheets:mcp-command` / `sheets:mcp-result` / 就绪信号),渲染层把 DSL ops
      转发给 `planFromOps` + `applyChangePlan`(与内置 AI 共用执行器)
      —— 渲染层 `apps/sheets/src/renderer/mcp-bridge.ts`:read 走 AI 的
      workbook readers,save 走 `handleSave` 新增的显式路径参数
- [x] 会话工具:`create_sheet`(开空表标签页)→ `read_sheet`(范围/单元格读取)→
      `apply_sheet_ops`(`set_cell`/`set_formula`/`fill_range`/`add_sheet`…)→
      `save_sheet`(指定路径,走既有保存管线)
      —— `create_sheet` 与 app 内"新建表格"一致,先落一个真实空白 .xlsx
      再打开(sidecar 保存管线需要落盘文件;内存演示网格无法保存)
      —— `save_sheet`:保存请求新增 `targetPath`/`overwrite` 字段,免对话框
      走常规 sidecar 保存管线(含 recalc 缓存值),docs:save-to 同款覆盖保护
- [x] `SheetsControl` 注入 + 门控 + 翻转重启,语义与 docs/slides 对齐
- [x] 20 语言 strings(新设置文案);能力行更新
      —— sheets 能力行/文案随 M1.3 的动态化一并落地(20 语言已齐)

### M2.4 集成收尾

- [x] e2e 真机:`e2e/mcp-visible-sheet.spec.ts` 可见建表 → 填数据/公式 → 存盘 → 解包
      验证值与公式(可见路径;公式由保存管线的 recalc 写缓存值)
- [x] `planning/mcp-test-runbook.md` 增补 Sheets 章节(§12)
- [x] `planning/mcp-server.md` 更新;shell 全量测试 + typecheck + prettier 通过

**验收标准**:runbook 新增章节全过;后台路径生成的 .xlsx 在 Excel/WPS 打开数值正确
(公式版缓存值正确);可见路径界面实时填充、保存走既有白名单管线。
—— 后台纯值版数值类型已验证;公式缓存值由可见路径的保存管线覆盖。

---

## 共用完成定义(DoD)

1. 新工具在后台关时不注册、开时注册,翻转即时生效(回归:同端口 tools/list 变化)
2. 所有错误路径有文案并返回 isError(路径校验/覆盖保护/无会话)
3. 单测 + 真机 e2e 双覆盖;`npm run typecheck -w @genoffice/shell`、全量 shell 测试、
   `check:theme-colors`、prettier 全绿
4. 新 UI 文案 20 语言齐全(strings parity 测试过)
5. runbook 与 mcp-server.md 同步更新

## 进度记录

| 日期       | 完成项                                                                                                                                                             | 提交    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 2026-09-12 | M1.1 create_pptx(大纲→两段式批事务)、M1.2 可见演示会话(applySessionTxn 共用)、M1.3 能力行动态化/20 语言/e2e/runbook                                                | ef4b620 |
| 2026-09-12 | M2.1 create_xlsx 纯值版、M2.3 可见表格会话(渲染器桥 + 显式路径保存)、M2.4 runbook/mcp-server/e2e                                                                   | 9d6dcbd |
| 2026-09-12 | 验收修复(P1):MCP 单标签页 deck-changed 推送(画布实时渲染)+ e2e 画布重绘断言(先红后绿);(P2)apply_sheet_ops 按 DSL schema 校验,漏 sheetId 报 op 名 + read_sheet 提示 | 7c225cd |
| (待做)     | M2.2 公式保真(可选项,延后)                                                                                                                                         | —       |

验证记录(2026-09-12):shell 全量 312 测试通过;shell/sheets/slides typecheck 零错误;
三个 MCP e2e(docx/deck/sheet)真机全过;prettier + check:theme-colors 全绿。
仓库级全量测试中 10 个失败为存量平台问题(Windows 本机,与本次改动无关,
已用 stash 对照验证;另有 1 个 csv-import 断言失败同属存量)。

复核记录(2026-09-12,验收测试后):7 项核对 6 过 1 挂——Slides 可见会话画布不渲染
(P1,数据/落盘路径全正常,仅可见性)。修复 7c225cd:桥主动推送 deck-changed,
e2e 补画布重绘断言并对旧构建验证先红后绿;apply_sheet_ops 补 DSL 校验报错。
复核后 shell 313 测试、sheets 2508 测试(3 个存量平台失败)通过,三个 MCP e2e 全绿。
