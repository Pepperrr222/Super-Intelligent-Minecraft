import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brainPromptManifest } from '../dist/src/agent-brain.js';

// Does not load credentials, connect to Minecraft, or call a model.
const manifest = brainPromptManifest();
const intro = `# 大脑提示词审阅包\n\n由 pnpm prompts:export 从实际运行注册表生成，不手工维护提示词副本。\n\n版本：${manifest.version}。审批标识：\n\n\`${manifest.hash}\`\n\nsim-v2-9 合并为唯一 decision 角色：同一个模型理解消息、选择查询/动作/可选阶段、根据结果纠错并判断完成。不再调用主控、执行或独立验收模型。统一方块/实体 ref，区分方块名、实体名和掉落物内容过滤。\n\n此文件包含每个角色完整的 system 消息（角色前缀、正文、输出 Schema），以及动态 user 消息模板。实际玩家原话、实时观测、目标和错误无法提前固定；这些值按下列模板填入，不另加隐藏提示词。finish 使用同一目标上下文；程序核对要求覆盖和证据引用，但不宣称能证明所有自然语言语义。\n\n## 动态输入契约\n\n\`\`\`json\n${JSON.stringify(manifest.inputContract, null, 2)}\n\`\`\`\n\n普通输入为压缩后的上下文 JSON；格式校验失败最多补一次 correction。压缩可添加 contextCompaction/omitted 标记，不能删除核心原话和要求。完整字段来自 src/agent-loop.ts 的 context()，压缩规则来自 src/agent-context.ts。\n\n## 审阅后启用\n\n只有你确认本文件后才设置下列环境变量；导出动作本身不表示同意，也不会修改本机环境。提示词、Schema、输入契约变化后旧标识失效。\n\n\`\`\`powershell\n$env:SIM_APPROVED_PROMPTS = '${manifest.hash}'\npnpm companion\n\`\`\`\n\n也可使用项目本地 .prompt-approval.local.json 保存当前 hash；显式环境变量优先。两者均无匹配授权时 V2 保留停止/暂停入口，拒绝发送模型请求。显式 legacy 模式保留旧代码与旧提示词，不属于本包的审阅范围。\n`;
const sections = manifest.prompts.map(({ role, system, maxTokens }) =>
  `\n## ${role}\n\n输出上限：${maxTokens} tokens。\n\n\`\`\`text\n${system}\n\`\`\`\n`).join('');
writeFileSync(fileURLToPath(new URL('../docs/brain-prompts-review.md', import.meta.url)), intro + sections, 'utf8');
console.log(`Exported ${manifest.prompts.length} complete prompts; review hash ${manifest.hash}`);
