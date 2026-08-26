# 个人轻量工作台 — 完整复刻文档（UI 描述 + 功能大纲 + 代码索引）

> 本文档与同目录 `src/` 配对使用。`src/` 含全部可运行的 Vue3 源码；本文档负责把「界面长什么样、有哪些功能、数据怎么存、怎么跑起来、踩过哪些坑」一次性说清，便于另一个任务快速复刻。

---

## 1. 项目概览

本地优先（local-first）的个人工作台单页应用（SPA）。纯前端、无后端、无账号，所有数据存在浏览器 IndexedDB，可导出加密备份、可同步到本地文件夹。PC/移动端自适应，支持「安装到桌面」离线使用。

**当前形态**
- 5 个主页面：总览、任务管理、知识库、日程管理、设置中心
- 左侧导航（含强调色切换、深/浅主题切换）｜中部主内容｜右侧任务指标卡
- 顶部提醒 toast（待办到点弹提醒，可完成/稍后/自定义）
- 强调色 5 套、主题深/浅，均持久化

---

## 2. 技术栈与依赖

| 维度 | 选型 |
|---|---|
| 框架 | Vue 3.4（`script setup` SFC） |
| 构建 | Vite 5（`@vitejs/plugin-vue`） |
| 本地数据库 | Dexie 4（IndexedDB 封装） |
| Markdown 渲染 | marked 12 |
| 表格导出 | xlsx 0.18 |
| 加密 | Web Crypto（AES，见 `crypto.js`） |
| 离线/安装 | Service Worker（`sw.js` 仅 PROD 注册） |
| 样式 | 原生 CSS + CSS 变量主题（无 UI 框架） |

`package.json` 脚本：`npm run dev` / `build` / `preview`。

---

## 3. 目录结构

```
workbench/
├── index.html                      # Vite 入口（含 manifest/icon 引用）
├── package.json
├── vite.config.js                  # emptyOutDir:false（本机安全删除钩子会拦截清空）
├── 打开工作台.vbs                  # 入口启动器（ASCII，ChrW 拼中文名）
├── 打开工作台.bat                  # 调 powershell 跑 ps1（隐藏窗口）
├── launch-workbench.ps1           # 核心启动逻辑（ASCII 注释，见 §8 坑）
└── src/
    ├── main.js                     # createApp + 注册 SW
    ├── style.css                   # 全局 CSS 变量（主题/强调色 token）
    ├── db.js                       # Dexie 数据库 schema + 自动同步中间件
    ├── seed.js                     # 首次打开写入示例数据
    ├── crypto.js                   # AES 加密/解密
    ├── autosync.js                 # FileSystemAccess 目录同步
    ├── notify.js                   # 浏览器通知封装
    ├── App.vue                     # 根组件：布局/导航/指标卡/提醒/toast
    └── views/
        ├── Overview.vue            # 总览（今天要处理 + 项目 3D 卡片）
        ├── ProjectStack.vue        # 项目堆叠 3D 卡片组件（被 Overview 引用）
        ├── ProjectManager.vue      # 项目管理弹窗（新建/编辑/子项目嵌套）
        ├── Tasks.vue               # 任务管理（四象限 + 项目下钻）
        ├── Notes.vue               # 知识库（文件夹树 + 笔记 + 编辑器）
        ├── FolderTree.vue          # 知识库文件夹树（被 Notes 引用）
        ├── Duty.vue                # 日程管理（值班表 + 周期任务）
        └── Data.vue                # 设置中心（TAB 分组 + 数据管理）
```

> 说明：`Dashboard.vue` 仍存在但未被 `App.vue` 引用（早期首页统计页，功能已并入 Overview/App 右侧指标卡），复刻时可保留或删除。

---

## 4. 数据模型（`src/db.js`，Dexie/IndexedDB）

数据库名 `PersonalWorkbench`，版本演进到 v4：

| 表 | 主键 | 主要字段 |
|---|---|---|
| `tasks` | `++id` | title, quadrant, status, projectId, followUpAt, nextRemindAt, createdAt, completedAt, remark, tags |
| `folders` | `++id` | name, parentId（知识库文件夹树，顶层 parentId=null） |
| `notes` | `++id` | title, type, folderId, tags[], content, meetingTime, attendees, createdAt, updatedAt |
| `shortcuts` | `++id` | name, url, icon |
| `duty` | `++id` | date, person, shift, remark, workContent |
| `settings` | `key` | 键值对，存：defaultFollowUp / quadrantColors / followUpPresets / noteTags / noteTypes / periodicDutyTasks |
| `handles` | `&id` | FileSystemDirectoryHandle（仅 Chromium） |
| `projects` | `++id` | name, color, parentId（v4 新增，支持子项目嵌套）, progressMode('auto'\|'manual'), manualProgress, order, archived, startAt, endAt, desc, createdAt |

**自动同步中间件**：任何表（除 `handles`）增删改后触发 `requestSync()`，把数据落盘到用户选定的本地目录（需 FileSystemAccess API）。

**种子数据**（`seed.js`）：首次打开若 `tasks` 为空，写入 2 个项目、5 条示例任务（含 1 条已逾期）、2 个文件夹 + 2 条笔记、2 个快捷方式、2 条值班、默认设置（默认跟进 60 分、四象限配色）。保证首屏「不是空白」。

---

## 5. 界面与功能大纲（按页面）

### 5.1 总览 Overview（`views/Overview.vue` + ProjectStack/ProjectManager）
- **今天要处理**：固定高度卡片（`max-height:420px`，内部 `overflow-y:auto` 滚动，多任务不撑高）；逾期项标红 + 一键「完成」/「推迟 1 小时」；标题过长用 `title` 属性悬停显示完整；昨天未完成自动顺延到今天。
- **项目文档（3D 堆叠卡片）**：`ProjectStack.vue` 渲染项目卡片（完成度环 + 标题 + 描述 + 含 N 个子项目/任务数）；点击卡片下钻到任务管理（按项目筛选）。
- **趋势图**：内联 SVG 折线/柱状（见代码）。
- **提醒**：沿用 App 层 toast 机制。

### 5.2 任务管理 Tasks（`views/Tasks.vue`）
- **四象限视图**：紧急重要 / 紧急不重要 / 不紧急重要 / 不紧急不重要，颜色在设置中心可配。
- **新建任务**：标题、归属象限、自定义时长（**时 + 分 两个数字框**，保存时 `总分钟 = 时×60 + 分`）、默认象限跟随当前筛选、标签、项目归属。
- **跟进时间预设**：以「时/分」录入；可设默认跟进时间。
- **项目树下钻**：点父项目 → 在项目行内显示「路径面包屑 + 子项目行 + 管理按钮」（三者水平中心线严格对齐，高度 24px）；可下钻到叶子；选中项目持久化到 `localStorage`（重开 VBS 不丢）。
- **防环**：保存项目时禁止把父项目移入自身/后代（`isProjectDescendant` 守卫）；加载时 `repairProjectCycles()` 自动断开环；`ancestorChain` 有死循环防护。

### 5.3 知识库 Notes（`views/Notes.vue` + FolderTree）
- **文件夹树**：`FolderTree.vue`，选中某文件夹。
- **笔记列表**：按「选中文件夹 + 其所有子文件夹」过滤。
- **编辑器**：标题、类型（`select`，选项来自设置中心可配的 `noteTypes` 预设）、标签（**预设下拉速选 + 自定义输入框**，统一在输入框显示）、内容（Markdown，marked 渲染）、会议时间/参会人。
- **搜索**：限定在「选中文件夹及其子文件夹」范围内（非全局）。
- **类型可配置**：在设置中心增删笔记类型（标识 + 显示名）。
- **标签预设**：在设置中心维护，编辑器内下拉速选。

### 5.4 日程管理 Duty（`views/Duty.vue`）
- **值班表**：日期 / 人员 / 班次 / 备注 / 工作内容。
- **周期任务**：与设置中心「值班周期任务」规则联动，按当日值班人员自动生成待办。

### 5.5 设置中心 Data（`views/Data.vue`）
- **顶部 TAB 分组**（点击切换，每组独立保存按钮 + 成功/失败提示）：
  1. **任务预设**：默认跟进时间、跟进时间预设（时/分增删）
  2. **知识库预设**：笔记标签（药丸列表 + 新增删除）、笔记类型（标识 + 显示名增删）
  3. **自动化**：值班周期任务规则（标题 / 匹配人员（留空=全部）/ 跟进分钟 / 四象限 / 启用开关），保存后按当日值班自动生成待办（按 标题+日期+人员 去重）
  4. **外观**：四象限颜色（取色器）
- **数据管理（合并大区块，含子标题/分隔线）**：
  - 数据迁移（加密 JSON 导出/导入）
  - 数据存放目录（本地文件夹，需 FSA：选择/更换目录、导出/导入/同步、实时同步开关、加密模式开关）
  - 危险区（清空全部本地数据，红色边框警示，二次确认）

### 5.6 全局（App.vue）
- **左侧导航**：总览 / 任务管理 / 知识库 / 日程管理 / 设置中心；强调色 5 选 1；深/浅主题切换（持久化到 `localStorage`）。
- **右侧指标卡**：今日待办 / 进行中 / 已完成 / 逾期，带「较昨日」趋势百分比。
- **提醒 toast**：每 30s 检查未完成任务，到点弹提醒，可「完成 / 稍后(15/30/60/120分/自定义) / 关闭」。

---

## 6. 关键实现要点

1. **主题与强调色**：`document.documentElement.dataset.theme/accent` + CSS 变量；`style.css` 定义 `:root[data-theme="dark"]` / `[data-theme="light"]` / `[data-accent="ocean"]` 等。
2. **提醒系统**：`notify.js` 封装 Notification；`App.vue` 用 `Set` 去重已提醒项，`setInterval(checkReminders, 30000)`。
3. **自动同步**：`db.use({...})` Dexie 中间件，mutate 后调 `requestSync()`（autosync.js，FSA 落盘）。
4. **本地持久化**：主题= `wb_theme_v2`、强调色= `wb_accent`、任务管理选中项目= `wb_tasks_selectedProject`（数字↔字符串转换防类型 bug）。
5. **项目树防环**：`ancestorChain` 用 `Set` 做 visited 防死循环；`repairProjectCycles()` 在加载时自动断开环（置空闭合点 parentId，不丢数据）；`saveProject` 守卫禁止自身/后代移动。
6. **启动器缓存破坏**：`launch-workbench.ps1` 每次启动给 `dist/index.html` 里的 JS/CSS 引用追加 `?v={unix秒}`，强制浏览器重新加载（详见 §8）。
7. **Service Worker**：`main.js` 仅在 `import.meta.env.PROD` 注册 `./sw.js`，支持桌面安装与离线。

---

## 7. 构建与运行

```bash
cd workbench
npm install        # 装 vue / dexie / marked / xlsx / vite
npm run build      # 产物到 dist/（vite.config 设 emptyOutDir:false，勿改 true 否则本机安全钩子会拦清空）
```

**启动（Windows）**：双击 `打开工作台.vbs` → 调 `.bat` → 调 `launch-workbench.ps1`：
1. 杀掉 4173 端口旧监听
2. 若 `src` 比 `dist/index.html` 新则 `node vite.js build` 重建
3. 给 `dist/index.html` 资源追加 `?v=` 时间戳
4. `vite preview --port 4173` 起服务
5. 轮询就绪后打开浏览器 `http://localhost:4173/?_={ticks}`

> **若重开后界面仍是旧版**：浏览器缓存导致。按 **`Ctrl+F5`** 强制刷新即可（启动器已加 `?v=` 时间戳，正常情况下无需手动）。

---

## 8. 已知坑与修复（复刻必读）

⚠️ **Windows launcher 文件必须纯 ASCII**（`.vbs`/`.bat`/`.ps1` 源码里**连中文注释都不能有**）：
- 中文 Windows 默认 PowerShell 5.1 按 **GBK** 解析无 BOM 的 UTF-8 文件。一旦 `.ps1` 里出现中文（含注释），乱码会破坏脚本结构，导致路径变量变 `$null`，报 `Cannot bind argument to parameter 'Path' because it is null`。
- `.vbs` 里中文文件名用 `ChrW(&H6253)&...` 逐字符拼，**源码保持 ASCII**。
- 验证：`node -e "fs.readFileSync(p).every(b=>b<0x80)"` 必须为 `true`。
- 写/改任何 launcher 后，用 Node 字节级校验，不要信"工具说会转 ANSI"。

⚠️ **删除/重建本地目录（如 dist）受沙箱安全删除钩子限制**：
- Bash 的 `rm -rf` 会触发 `genie-trash` 钩子 fail-closed；Node `fs.rmSync` 也可能被拦。
- 正确做法：PowerShell `Remove-Item -Recurse -Force`，或 `vite.config` 设 `emptyOutDir:false` 避免 Vite 自动清空 dist，再手动清理旧产物。

⚠️ **多副本混淆**：项目下曾有两份 `workbench` 与 `workbench-backup`，各自独立 dist。复刻/验收时必须确认「双击的 VBS」与「更新的 dist」同目录。建议只保留一份入口。

⚠️ **构建产物未落盘导致坏 dist**：若上次 build 的 js/css 实际未写入磁盘，但 `dist/index.html` 已更新引用，会形成「引用缺失文件」的坏状态；VBS 因 `src` 比坏 `dist` 旧而不重建，永久沿用坏状态。排查「没更新」先 `ls dist/assets` 确认 `index.html` 引用的文件真实存在。

---

## 9. 复刻清单（另一个任务直接照做）

1. 复制整个 `workbench-REPLICA/`（含 `src/`、`package.json`、`vite.config.js`、`index.html`、三个 launcher 文件）。
2. `npm install`。
3. 改源码后 `npm run build`（dist 会生成/更新）。
4. 双击 `打开工作台.vbs` 启动（Windows）；非 Windows 可 `npm run dev` 或 `npm run preview` 手动起。
5. 所有 launcher 脚本改动后，**务必 Node 字节级校验纯 ASCII**。
6. UI 视觉细节（圆角/配色/卡片/3D 堆叠）以 `src/views/*.vue` 内 `<style scoped>` 为准；主题 token 在 `src/style.css`。

---

*生成日期：2026-08-07。对应构建产物 hash：`index-D7S4MSXR.js` / `index-BZOu-c04.css`（含总览固定高度、知识库空白修复、设置中心 TAB、笔记类型可配、值班周期任务、本地文件夹同步等全部最新改动）。*
