# geo-v0

检测 → 修复 → 复测闭环。用同一把尺子测 AI 引擎引用率的前后变化。

- 测试床:gospelhub.love
- 成功标准:detail / aggregate / fresh 三档中任一档引用率从基线(预计 ≈0%)升至正数,且报告可复现

对 spec 的偏离及理由见 [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md)。**跑之前先读那份。**

---

## 装

```bash
cd geo-v0
npm install
cp .env.example .env      # 填 OPENROUTER_API_KEY
npm run e2e               # 端到端自测,不需要任何 API key
```

`npm run e2e` 会起一个本地 fixture 站点,把 extract → queries → audit → fixpack → score → report → diff
整条链路跑一遍并断言结果。改了抽取或评分逻辑之后先跑它。

---

## 跑

顺序不能跳。

```bash
# 1. B5 可读性体检 —— 必须最先跑
npm run audit -- --site gospelhub
```

站点对抓取器不可读时,基线的 0% 是「被封/空白的 0%」而不是「未被引用的 0%」,
两者对应完全不同的修复方案。有 blocker 时退出码为 2。

```bash
# 2. 引擎冒烟 —— 验证 citations 透传
npm run verify
```

原始响应落在 `data/_verify/`。**尺子读不出数就别跑基线** —— 你会得到一批
无法区分「没被引用」和「没读数」的 0。

```bash
# 3. 实体抽取
npm run extract -- --site gospelhub --propose    # 先看真实 URL 形态
# 把选中的模式写进 sites/gospelhub.json 的 entityPatterns,然后:
npm run extract -- --site gospelhub

# 4. 题库(生成后即冻结)
npm run queries -- --site gospelhub

# 5. 探测 —— 先小跑冒烟,再全量
npm run probe -- --site gospelhub --label baseline --limit 4
npm run probe -- --site gospelhub --label baseline

# 6-7. 评分与基线报告
npm run score  -- --site gospelhub --run baseline-2026-07-29
npm run report -- --site gospelhub --run baseline-2026-07-29

# 8. 修复包
npm run fixpack -- --site gospelhub
# 按 fixpack/output/gospelhub/DEPLOY.md 部署

# 9. 索引推送(key 文件必须先上线)
npm run indexnow -- --site gospelhub --dry-run
npm run indexnow -- --site gospelhub --submit

# 10. 复测(Day 0 + 15 / + 30)
npm run probe -- --site gospelhub --label d15
npm run score -- --site gospelhub --run d15-2026-08-20
npm run diff  -- --site gospelhub --runs baseline-2026-07-29,d15-2026-08-20
```

`npm run geo -- help` 有完整选项。

---

## 结构

```
src/
  probe/          模块 A:实体抽取 → 题库 → 引擎探测 → 评分
    sitemap.ts      sitemap 递归 + URL 模式自动提议
    entityFacts.ts  HTML → 事实(JSON-LD > microdata > 启发式)
    queries.ts      模板确定性填充;模型只做受约束的辅助
    engines/        引擎适配器 + citation 提取器(尺子本体)
    verify.ts       透传冒烟
    run.ts          探测,断点续跑 + 预算护栏
    score.ts        评分 + 噪声底噪
  fixpack/        模块 B:修复包
    audit.ts        B5 体检
    jsonld.ts       B1 结构化标记
    llmstxt.ts      B2
    assets.ts       B3 问答块 / 聚合页 / 新发行页
    indexnow.ts     B4 索引推送
    build.ts        组包
    nextjs.ts       GospelHub 的 Next.js 集成片段
  report/         模块 C:基线报告 / 对比报告 / 诚实边界
  testkit/        fixture 站点 + 端到端自测
sites/            站点 profile
data/             entities.json / queries.json / scores/ / raw/
report/           生成的报告
fixpack/output/   生成的修复包(交付物)
```

---

## 三条设计约束

**1. probe 的输入只允许是一个 URL。**
sitemap 模式是主路径。`--source supabase` 是 GospelHub 自用的捷径,存在但不是主路径 ——
未来的客户只有一个 URL。db 模式拿到的事实更全会让 detail 档题目更多,
但那不代表 sitemap 模式坏了:它代表站点的公开页缺结构化数据,而那正是 B5 要报告的问题。

**2. fixpack 的输出是独立文件包。**
`fixpack/output/{site}/` 是一个自足的目录,含所有修复文件 + `DEPLOY.md`。
`public/` 下的东西任何站点都能直接用;`nextjs/` 是可选的代码集成片段。
文件包就是未来产品的交付形态。

**3. 无数据不作答。**
JSON-LD、问答块、聚合页 —— 所有内容的每一个字段都必须能在 `entities.json` 里找到出处。
没有默认值,没有占位符,没有 "Unknown"。缺数据的后果是少生成几个页面,
不是生成假内容 —— 一个编造的答案比没有答案伤害大得多。

e2e 里对这三条都有断言。

---

## 复现性

- **题库冻结**:`queries.json` 一经生成即冻结,重复调用不重新生成。`--force` 会作废已有基线。
- **指纹校验**:每个 run 记录题库指纹;评分与 diff 在指纹不匹配时**拒绝运行**。
  不可比就不出数 —— 一份看起来正常但比错了东西的报告,比没有报告有害。
- **确定性抽样**:种子 PRNG,同样的 entities.json 必然得到同样的题库。
- **断点续跑**:已落盘的调用直接跳过,失败的调用也落盘(避免无限重试注定失败的题)。
- **原始响应全量落盘**:`data/raw/{run_id}/{engine}/{qid}.a{n}.json`,便于事后审计。

---

## 环境变量

见 `.env.example`。最少只需要 `OPENROUTER_API_KEY`。

`ANTHROPIC_API_KEY` 只在 `--paraphrase` / `--llm-themes` 时用到,默认走纯模板。
`GEMINI_API_KEY` 可选(v0 可省略,Day 15 复测前再加);有 key 时自动加入引擎列表 ——
但注意中途加入的引擎没有基线,diff 会把它移出主对比表。
