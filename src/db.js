import Dexie from 'dexie'
import { requestSync } from './autosync'

// 本地优先数据库（IndexedDB），不依赖任何云端
export const db = new Dexie('PersonalWorkbench')

// v1: 原始表；v2: 新增 handles（存放用户选择的本地目录句柄，仅 Chromium 可用）
db.version(1).stores({
  tasks:
    '++id, title, quadrant, status, followUpAt, nextRemindAt, createdAt, completedAt',
  folders: '++id, name, parentId',
  notes:
    '++id, title, type, folderId, tags, content, meetingTime, attendees, createdAt, updatedAt',
  shortcuts: '++id, name, url, icon',
  duty: '++id, date, person, shift, remark, workContent',
  settings: 'key'
})

db.version(2).stores({
  tasks:
    '++id, title, quadrant, status, followUpAt, nextRemindAt, createdAt, completedAt',
  folders: '++id, name, parentId',
  notes:
    '++id, title, type, folderId, tags, content, meetingTime, attendees, createdAt, updatedAt',
  shortcuts: '++id, name, url, icon',
  duty: '++id, date, person, shift, remark, workContent',
  settings: 'key',
  // 存放 FileSystemDirectoryHandle（不可序列化索引，仅作单例存储）
  handles: '&id'
})

// v3: 新增 projects 表 + tasks.projectId 索引
// 项目用于 Dashboard 的 3D 卡片堆叠，完成度可自动计算或手动指定
db.version(3)
  .stores({
    tasks:
      '++id, title, quadrant, status, projectId, followUpAt, nextRemindAt, createdAt, completedAt',
    folders: '++id, name, parentId',
    notes:
      '++id, title, type, folderId, tags, content, meetingTime, attendees, createdAt, updatedAt',
    shortcuts: '++id, name, url, icon',
    duty: '++id, date, person, shift, remark, workContent',
    settings: 'key',
    handles: '&id',
    // progressMode: 'auto'（按任务完成比例）| 'manual'（用 manualProgress）
    projects: '++id, name, color, progressMode, order, archived, startAt, endAt, createdAt'
  })
  .upgrade(async (tx) => {
    // 迁移：建一个「默认项目」，把所有历史任务挂进去，保证老数据不丢
    const now = Date.now()
    const defaultId = await tx.table('projects').add({
      name: '默认项目',
      color: '#4f46e5',
      progressMode: 'auto',
      manualProgress: 0,
      order: 0,
      archived: 0,
      startAt: null,
      endAt: null,
      desc: '升级时自动创建，用于收纳此前未归属项目的任务',
      createdAt: now
    })
    await tx
      .table('tasks')
      .toCollection()
      .modify((t) => {
        if (t.projectId == null) t.projectId = defaultId
      })
  })

// v4: projects 增加 parentId，支持「项目下嵌套子项目」
db.version(4).stores({
  tasks:
    '++id, title, quadrant, status, projectId, followUpAt, nextRemindAt, createdAt, completedAt',
  folders: '++id, name, parentId',
  notes:
    '++id, title, type, folderId, tags, content, meetingTime, attendees, createdAt, updatedAt',
  shortcuts: '++id, name, url, icon',
  duty: '++id, date, person, shift, remark, workContent',
  settings: 'key',
  handles: '&id',
  // parentId: 顶层项目为 null/undefined，子项目指向父项目 id
  projects: '++id, name, color, parentId, progressMode, order, archived, startAt, endAt, createdAt'
})

// 自动同步中间件：任何数据表发生增删改（handles 表除外）后，触发一次落盘到选定目录
db.use({
  name: 'autosync-mw',
  stack: 'dbcore',
  create: (down) => ({
    table: (name) => {
      const t = down.table(name)
      return {
        ...t,
        mutate: (req) => {
          const res = t.mutate(req)
          if (name !== 'handles') res.then(() => requestSync()).catch(() => {})
          return res
        }
      }
    }
  })
})

export default db
