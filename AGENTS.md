# AGENTS.md

给在本仓库工作的 agent 的规则。仓库是 `GeTitDD/pi-data-agent-sdk`，公开仓库。

## 先读什么

- `README.md` 仓库索引与发布方式
- `data-agent-sdk/README.md` SDK 自述，四条不变量在这里
- `data-agent-sdk/SDK-SPEC-v1.md` 冻结版规格

## 跑什么

```bash
cd data-agent-sdk
npm test          # 39 项契约测试，必须全绿
npm run typecheck # tsc --noEmit，strict
```

Node `>=22.18`。`.ts` 由 Node 类型擦除直接执行，无构建步骤。`demo/demo.db` 被 gitignore，缺失时先跑 `npm run seed`。

## 怎么提 issue

**不要用网页、不要用 `gh issue create` 之外的猜测路径，也不要等别人代提。** 仓库带一个只依赖 node 的脚本：

```bash
node tools/new-issue.mjs --title "..." --body-file /tmp/body.md --label bug
node tools/new-issue.mjs --title "..." --body "..." --dry-run   # 只看 payload
```

token 按顺序取 `GITHUB_TOKEN`、`GH_TOKEN`、`~/.ghtok`。仓库默认从 `origin` 解析，跨目录跑时用 `--repo GeTitDD/pi-data-agent-sdk`。

token 需要 `Issues: write`。细粒度 PAT 只勾这个仓库即可，不要用账号级全权 token。

若本机已登录 `gh`，也可以 `gh issue create -R GeTitDD/pi-data-agent-sdk`，两者等价。

## issue 必须满足什么

照 `.github/ISSUE_TEMPLATE/agent.md` 的结构写。硬要求三条：

1. **带实测输出**。命令与结果贴原文，不要写"我推测"。
2. **可复现**。别人能直接粘贴就跑。
3. **说清是 bug 还是设计取舍**。规格里明确不做的事（例如 `node-sql-parser`、向量检索、Python 执行）不当作 bug 提，见 `SDK-SPEC-v1.md` 的非目标章节。

## 代码边界

- 不变量写进 `data-agent-sdk/README.md`，改动前先读。破坏其中任一条要单独说明理由。
- `guard.ts` 与 `adapters/runner.mjs` 各有一份词法护栏，改一处必须同步另一处。
- `test/` 里的 39 项是冻结契约。新增行为补用例，不要改既有断言。
- 直接改代码请开分支提 PR，不要推 `main`。
