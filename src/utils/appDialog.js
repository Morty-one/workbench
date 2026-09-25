/* 应用内对话框（第 44 轮）
 *
 * 替代浏览器自带的 confirm() / prompt()。理由：
 *  ① 原生弹窗样式完全不可控 —— 标题会带「localhost:4173 显示」这种前缀，不跟主题皮肤；
 *  ② 原生 prompt 输入框放不下业务上下文（「导入时需输入相同密码」这类说明只能塞进标题里）；
 *  ③ 原生弹窗是**阻塞**的，样式上也无法区分「不可恢复」和「可恢复」两种危险级别。
 *
 * 设计要点：
 *  - **Promise 化 API**：现有调用点全是 `if (!confirm(x)) return` 的命令式写法，
 *    改成 `if (!(await appConfirm({...}))) return` 几乎零结构改动，最不容易改出 bug。
 *  - **全局单例**：状态放在模块里，由 App.vue 根部挂**一个** <AppDialog> 渲染。
 *    这样任何视图都能弹、切页不断、也不会出现两套弹窗抢焦点。
 *  - **队列**：同一时刻只允许一个对话框。Duty.vue:confirmClear 存在「弹窗里再弹窗」的嵌套
 *    （清空选择弹窗 → 二次确认），串行化可避免两个遮罩叠在一起分不清先点哪个。
 *  - **保留原生语义**：prompt 取消返 null、点确定但留空返 ''。现有调用点用法**不统一** ——
 *    `Data.vue:729 if (!p)` 把两者都当取消，`Notes.vue:441 if (next == null)` 明确区分。
 *    这里必须保留区别，不许「顺手统一」，否则会悄悄改变行为。
 *
 * ⚠️ 从**同步函数**里调用 appConfirm/appPrompt，必须给那个函数补 async
 *    （第 44 轮盘点出 4 处：TaskFormModal:localRemove、Data:clearSyncLogs、Data:clearPullLogs、Data:toggleEncrypt）。
 */
import { reactive } from 'vue'

export const dialogState = reactive({
  visible: false,
  mode: 'confirm', // 'confirm' | 'prompt'
  title: '',
  message: '',
  warn: '',
  okText: '确定',
  cancelText: '取消',
  danger: false,
  input: '',
  inputType: 'text', // 'text' | 'password'
  placeholder: '',
  selectOnFocus: false,
})

/* resolve 放在模块变量里，不塞进 reactive（避免被代理包一层） */
let currentResolve = null
let currentMode = 'confirm'
const queue = []

/**
 * 打开一个对话框。返回 Promise：
 *  - confirm ⇒ 确定 true / 取消 false
 *  - prompt  ⇒ 确定「输入内容（可能是空串 ''）」/ 取消 null
 */
function open(opts) {
  return new Promise((resolve) => {
    queue.push({ opts: opts || {}, resolve })
    drain()
  })
}

function drain() {
  if (currentResolve) return // 已有对话框在场，排队等着
  const job = queue.shift()
  if (!job) return
  const o = job.opts
  currentResolve = job.resolve
  currentMode = o.mode === 'prompt' ? 'prompt' : 'confirm'
  dialogState.mode = currentMode
  dialogState.title = o.title || ''
  dialogState.message = o.message || ''
  dialogState.warn = o.warn || ''
  dialogState.okText =
    o.okText || (currentMode === 'prompt' ? '确定' : o.danger ? '确认删除' : '确定')
  dialogState.cancelText = o.cancelText || '取消'
  dialogState.danger = currentMode === 'confirm' && !!o.danger
  // prompt 的 value 允许是 ''（重命名场景要预填原名）⇒ 只在 null/undefined 时退化为 ''
  dialogState.input = o.value == null ? '' : String(o.value)
  dialogState.inputType = o.password ? 'password' : 'text'
  dialogState.placeholder = o.placeholder || ''
  dialogState.selectOnFocus = !!o.selectOnFocus
  dialogState.visible = true
}

function settle(result) {
  if (!currentResolve) return // 已收场（连点两下 / Enter 与 click 同时到），忽略
  const resolve = currentResolve
  currentResolve = null
  dialogState.visible = false
  dialogState.input = ''
  resolve(result)
  drain() // 队列里还有就接着弹
}

/** 点「确定」/ 按 Enter。confirm ⇒ true；prompt ⇒ 当前输入内容（留空是 ''，不是 null） */
export function dialogOk() {
  if (!currentResolve) return
  settle(currentMode === 'prompt' ? dialogState.input : true)
}

/** 点「取消」/ 按 Esc / 点遮罩。confirm ⇒ false；prompt ⇒ null */
export function dialogCancel() {
  if (!currentResolve) return
  settle(currentMode === 'prompt' ? null : false)
}

/** 有待确认的破坏性操作 ⇒ 用这个。opts: { title, message, warn, okText, danger } */
export function appConfirm(opts) {
  return open({ ...(opts || {}), mode: 'confirm' })
}

/** 需要用户输入一段文本 ⇒ 用这个。opts: { title, message, value, password, placeholder, selectOnFocus, okText } */
export function appPrompt(opts) {
  return open({ ...(opts || {}), mode: 'prompt' })
}

/** 仅供测试：清空队列与在场状态，避免用例之间互相污染 */
export function __resetDialog() {
  queue.length = 0
  currentResolve = null
  dialogState.visible = false
  dialogState.input = ''
}
