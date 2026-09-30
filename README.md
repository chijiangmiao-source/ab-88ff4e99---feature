# 深海观测缆 · 站间偏移校核台

检修期间工程师在浏览器粘贴脚本（最多 **64 个站点、180 行**），依次
登记 / 撤回站间整数偏移关系 `x_v − x_u = d`，并在检查点确认当时仍活动的
读数能否共同成立。冲突时按关系标识稳定选出矛盾环，展示环中各式相加得到的
**推导值**与登记关系的**冲突值**，可逐项复算。

## 快速开始

```bash
# 默认宿主机端口 8080
docker compose up web

# 可配置宿主机端口
WEB_PORT=9090 docker compose up web
# 打开 http://localhost:9090 ，健康状态 http://localhost:9090/healthz
```

## 一次性验收服务 verify

```bash
docker compose build
WEB_PORT=8080 docker compose run verify   # 退出码 0 = 验收通过，1 = 失败
```

`verify` 依次执行并以退出码报告结果：

1. **复现业务场景**：登记 `A→B=5`、`B→C=-2` ⇒ 可行且推导 `A→C=3`；
   再登记 `A→C=4` ⇒ 展示推导值 3 与冲突值 4 的矛盾环（环内各式逐项相加
   复算）；撤回该关系后下一检查点恢复可行。
2. **代码测试**：`node --test test/`（解析器、带势并查集、分治求解、稳定选环）。
3. **构建产物检查**：生成 `dist/`，校验 sha256 清单与页面资源引用。
4. **HTTP 冒烟**：对容器网络 `http://web:8080` 与宿主机映射端口
   `http://host.docker.internal:${WEB_PORT}` 请求 `/`、`/healthz`、
   `/js/solver.js`，确认页面与健康状态可达后退出。

## 脚本文法

| 语句 | 含义 |
| --- | --- |
| `stations: A,B,C` | 可选，至多一行，显式声明站点（≤64） |
| `[id:] A→B=5` | 登记关系 `x_B − x_A = 5`（`->` 与 `→` 等价；省略 id 自动编号 `#1`） |
| `withdraw id` | 撤回关系（亦接受 `撤回 id` / `drop id`） |
| `checkpoint` | 检查点（亦接受 `检查点` / `cp`） |

- 标识：`^[A-Za-z_][A-Za-z0-9_-]{0,31}$`
- 整数范围：±9007199254740991；空行与 `#` 注释行忽略。
- **一次性定位全部问题**：重复登记、未知/已撤回标识、无效标识、未知端点、
  非整数/超界整数、超 64 站点、超 180 行，在一次校核中全部标出，
  并清除旧审计结果（页面提示“旧审计结果已清除”）。

示例：

```
stations: A,B,C
r1: A→B=5
r2: B→C=-2
checkpoint
r3: A→C=4
checkpoint
withdraw r3
checkpoint
```

## 算法（后台不逐检查点重扫活动关系）

1. 每条“登记—撤回”关系换算为在检查点时间轴上的活动区间 `[l,r]`；
2. 区间挂到检查点线段树的 O(log K) 个节点（**时间区间分治**）；
3. DFS 线段树，进入节点并入**可回滚带势并查集**：
   - 按大小合并、不做路径压缩，`pot[x] = value(x) − value(parent[x])`；
   - 合并已连通两端时，若势推出的偏移与登记值不符即得到矛盾环；
   - 离开节点按快照恢复 parent/size/pot/link；
4. 总复杂度 O((E+K) log K · α)，稳定选环规则：节点内按登记行号升序贪心并入，
   候选矛盾环中取**关系标识最小**者。

## 目录

```
web/            静态页面（index.html / css / js：parser、solver、app）
test/           node --test 单元测试
tools/build.mjs 产物构建与清单校验
verify/         一次性验收服务
deploy/         nginx 配置（含 /healthz）
Dockerfile.web / Dockerfile.verify / docker-compose.yml
```

本地开发（无需容器）：

```bash
node --test test/         # 测试
node tools/build.mjs      # 构建到 dist/
node tools/build.mjs --check
```
