# 云模型接入

支持 DeepSeek 官方和 SiliconFlow 的 Chat Completions 接口。模型只提出结构化目标和下一步，所有游戏动作仍通过相同校验器、状态机和独立完成检查。

## 本机配置

API Key 只写在本机文件中，一行一个，不加 Bearer 或引号。配置中的 key_file 是文件路径，不能直接填写密钥。UTF-8 与带 BOM 的 UTF-8 文件均可读取。

DeepSeek 的 model 区块示例：

```json
{
  "provider": "deepseek",
  "base_url": "https://api.deepseek.com",
  "name": "deepseek-flash",
  "key_file": ".secrets/deepseek.key",
  "thinking": true,
  "stream": true,
  "max_tokens": 1600,
  "timeout_seconds": 60
}
```

SiliconFlow 示例：

```json
{
  "provider": "siliconflow",
  "base_url": "https://api.siliconflow.cn/v1",
  "name": "deepseek-ai/DeepSeek-V3.2",
  "key_file": ".secrets/siliconflow.key",
  "thinking": true,
  "stream": true,
  "max_tokens": 1600,
  "timeout_seconds": 60
}
```

模型 ID 以账户实际可用列表为准，不能把一家平台的 Key 发给另一家。单次运行只使用配置指定的平台，失败不会静默切换，便于复现实验和核对费用。

config.json、config.*.local.json 和 .secrets/ 均被 Git 忽略。团队可以提交不含密钥的配置示例，不提交本机配置、认证缓存或原始运行日志。

## 思考模式与输出

provider=deepseek 时，thinking=false 映射为 `thinking: {"type":"disabled"}`。provider=siliconflow 时映射为 `enable_thinking:false`。generic 模式不附加厂商专用参数。

stream=true 使用异步 SSE 接收，兼容 DeepSeek/SiliconFlow 的 reasoning_content 与 content 双通道。思考原文单独保存在本机 model-calls/，不会进入动作解析、TaskSpec 或长期经验。非流式接口返回的思考也可在调用结束后回看。接口未提供、显式关闭、达到上限、断流和取消均有明确状态，不推测或补写缺失内容。

max_tokens 由模型服务解释，DeepSeek 与 SiliconFlow 的思考计量口径可能不同；用量以接口返回值为准。达到 token 上限的最终回复会被拒绝，不能当成完整动作。开启思考不会自动提高本项目的 token、步数或时间上限。

请求不跟随 HTTP 重定向，避免将认证头转发至其他地址。HTTP 错误仅保留状态码，不输出原始响应体或密钥。

参数说明来自 [DeepSeek 思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/) 和 [SiliconFlow Chat Completions 文档](https://api-docs.siliconflow.cn/docs/api/chat-completions-post)。

## 联通和真实任务验收

一次极小 JSON 联通测试：

```bash
python scripts/probe_model.py --config config.deepseek.local.json
python scripts/probe_model.py --config config.siliconflow.local.json
```

探测会显式关闭思考和流式，仅检查小额 JSON 联通；不验收思考输出。它实际调用 API 并产生少量用量，只显示状态、模型、延迟和 token。普通启动可用：

```bash
sim-agent --planner llm --config config.siliconflow.local.json
```

准备好独立原版实验服和本机配置后，关闭手动测试服，再运行：

```bash
python scripts/cloud_acceptance.py --providers deepseek siliconflow --max-steps 10
```

脚本启动自己的本机隔离世界，分别测试移动、约束交付、保留材料时补料合成、歧义澄清。每平台每任务最多指定轮数，B0 不检索长期经验。它不会使用规则规划器回退，也不允许模型访问管理员夹具命令。

结果需要同时满足程序完成判定和独立世界状态检查。原始决策、用量与任务日志保存在 runtime/cloud-acceptance/，默认不提交。一次验收不等于学习效果或模型优劣统计，错误和失败也应保留。

通过后导出可提交的白名单摘要：

```bash
python scripts/export_cloud_acceptance.py
```

已运行的 DeepSeek/SiliconFlow 验收与开发失败记录见 [云模型证据](../benchmarks/results/cloud-2026-10-28.json)。用量来自任务请求的 API 返回值，不包括模型列表发现、小额联通探测和单独诊断；不能当作账户账单。HTTP错误缺少用量时会标注不完整。
