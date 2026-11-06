# 任务中心来源与个人上下文表单

2026-11-06。实现已完成，等待任务中心真实应用启动后进行页面验证。

- `app/src/components/task-center/source-settings.tsx` 导出 `SourceSettings({sources,onChanged})`：来源新增、编辑、暂停/启用、立即巡检；按实际采集器 config 字段提供表单，连接未就绪与扫描错误就近显示。支持所有八种来源，凭据连接跳转既有账号设置。
- `app/src/components/task-center/context-settings.tsx` 导出 `ContextSettings()`：职责、项目、目标、兴趣、习惯、偏好六字段；使用现有 API envelope 和 query key，保存反馈与未保存导航保护。保存期间禁用编辑避免旧回包覆盖新输入。
- API 已与 `app/src/lib/task-center-api.ts` 当前定义一致；没有新增依赖、模拟数据或全局样式。

2026-11-06 `bun x tsc --noEmit --project app/tsconfig.json` 完成：本次两个表单无诊断。全项目尚有其他并行 UI 错误：`create-task.tsx` 与 `task-center.tsx` 的 feedback 缺 success/error，tasks 路由尚未生成；另有已有 `app/tests/model-setting-drafts.test.tsx` 的 exact 属性错误。对应文件由其 owner 修复。

父 UI owner 需在真实页面一轮检查来源创建/编辑、巡检失败反馈、上下文保存；包含 1280/420 与暗色视口。来源 config 依据 `task-center-sources-handoff.md` 与 `sources.ts`，尚未认定后台账号均已连接。
