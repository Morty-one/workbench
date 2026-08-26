import { db } from './db'

/**
 * 保证至少存在一个项目。
 * - 老用户：v3 upgrade 已建「默认项目」，这里直接返回它
 * - 新用户：upgrade 不触发（直接建 v3 库），由这里补建
 * 返回默认项目 id，供 seed / 新建任务兜底使用。
 */
export async function ensureDefaultProject() {
  const existing = await db.projects.orderBy('order').first()
  if (existing) return existing.id
  return await db.projects.add({
    name: '默认项目',
    color: '#10b981',
    progressMode: 'auto',
    manualProgress: 0,
    order: 0,
    archived: 0,
    startAt: null,
    endAt: null,
    desc: '用于收纳未归属具体项目的任务',
    createdAt: Date.now()
  })
}

// 首次打开时写入示例数据，让用户立刻看到效果
// 包含一条"已逾期/已到点"的待办，用于验证提醒机制
export async function seedIfEmpty() {
  const count = await db.tasks.count()
  if (count > 0) return false

  const now = Date.now()
  const overdue = now - 60 * 60 * 1000 // 1 小时前已到点
  const day = 24 * 60 * 60 * 1000

  // 示例项目：让 Dashboard 的 3D 卡片首屏就有内容
  const pDefault = await ensureDefaultProject()
  const pSite = await db.projects.add({
    name: '工作台改版',
    color: '#14b8a6',
    progressMode: 'auto',
    manualProgress: 0,
    order: 1,
    archived: 0,
    startAt: now - 10 * day,
    endAt: now + 20 * day,
    desc: '个人数字工作台的界面与功能迭代',
    createdAt: now
  })
  const pDoc = await db.projects.add({
    name: '资料归档',
    color: '#84cc16',
    progressMode: 'manual',
    manualProgress: 62,
    order: 2,
    archived: 0,
    startAt: now - 30 * day,
    endAt: now + 10 * day,
    desc: '历史文档整理与知识库沉淀',
    createdAt: now
  })

  await db.tasks.bulkAdd([
    {
      title: '示例：整理本周待办清单',
      quadrant: 'urgent-important',
      status: '待办',
      projectId: pDefault,
      followUpAt: overdue,
      nextRemindAt: overdue,
      createdAt: now - 2 * 60 * 60 * 1000,
      completedAt: null,
      remark: '这是一条示例待办，用于演示四象限与跟进提醒。'
    },
    {
      title: '示例：阅读一篇技术文章',
      quadrant: 'noturgent-important',
      status: '待办',
      projectId: pDefault,
      followUpAt: now + 4 * 60 * 60 * 1000,
      nextRemindAt: now + 4 * 60 * 60 * 1000,
      createdAt: now - 60 * 60 * 1000,
      completedAt: null,
      remark: ''
    },
    {
      title: '示例：完成侧边栏导航改版',
      quadrant: 'urgent-important',
      status: '已完成',
      projectId: pSite,
      followUpAt: null,
      nextRemindAt: null,
      createdAt: now - 3 * day,
      completedAt: now - 1 * day,
      remark: ''
    },
    {
      title: '示例：调试深色主题配色',
      quadrant: 'noturgent-important',
      status: '跟进中',
      projectId: pSite,
      followUpAt: now + 2 * day,
      nextRemindAt: now + 2 * day,
      createdAt: now - 2 * day,
      completedAt: null,
      remark: ''
    },
    {
      title: '示例：整理旧会议纪要',
      quadrant: 'noturgent-notimportant',
      status: '待办',
      projectId: pDoc,
      followUpAt: now + 5 * day,
      nextRemindAt: now + 5 * day,
      createdAt: now - 5 * day,
      completedAt: null,
      remark: ''
    }
  ])

  const root = await db.folders.add({ name: '我的知识库', parentId: null })
  await db.folders.add({ name: '工作', parentId: root })
  await db.notes.bulkAdd([
    {
      title: '示例速记：AI 工作流要点',
      type: 'flash',
      folderId: root,
      tags: ['AI', '方法论'],
      content: '# AI 工作流\n- 先梳理高频痛点\n- 小步快跑做 MVP\n- 反向蒸馏补丁清单',
      meetingTime: null,
      attendees: '',
      createdAt: now,
      updatedAt: now
    },
    {
      title: '示例会议：周一站会',
      type: 'meeting',
      folderId: root,
      tags: ['会议'],
      content: '## 议题\n1. 上周进展\n2. 本周计划\n\n## 结论\n聚焦核心模块。',
      meetingTime: '2026-08-03 09:30',
      attendees: '张三, 李四',
      createdAt: now,
      updatedAt: now
    }
  ])

  await db.shortcuts.bulkAdd([
    { name: '邮箱', url: 'https://mail.example.com', icon: 'mail' },
    { name: '项目管理', url: 'https://pm.example.com', icon: 'board' }
  ])

  await db.duty.bulkAdd([
    { date: '2026-08-03', person: '张三', shift: '早班', remark: '' },
    { date: '2026-08-04', person: '李四', shift: '晚班', remark: '需交接服务器巡检' }
  ])

  await db.settings.bulkPut([
    { key: 'defaultFollowUp', value: 60 }, // 默认跟进：60 分钟
    {
      key: 'quadrantColors',
      value: {
        'urgent-important': '#ef4444',
        'urgent-notimportant': '#f59e0b',
        'noturgent-important': '#3b82f6',
        'noturgent-notimportant': '#9ca3af'
      }
    }
  ])

  return true
}
