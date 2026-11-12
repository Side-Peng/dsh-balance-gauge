# dsh-balance-gauge

DeepSeek Harness 网页版 GUI 的一个小插件：把**账户余额**和**实时输出速度**画成两个小仪表，嵌在左侧边栏脚部、账户行正上方。

- 余额 **小于 10 元 → 红色**，表盘红区跟着轻轻呼吸，文案变成「油快没啦」
- **10 到 50 元 → 黄色**（含 10 和 50 本身）
- **大于 50 元 → 绿色**，文案变成「油箱满满」
- 满格刻度按 **¥100** 算，超过就指针顶到底；数字始终显示真实金额
- 右边的速度表显示 **全进程实时流量**：刻度 0 → 500 tok/s，线性映射到 180° 摆角（0 tok/s 在最左、500 tok/s 在最右；237 tok/s = 85.3°，约在表盘 47% 处）
- 每分钟自动刷新一次余额，**单击卡片**立刻刷新；带键盘可达性（Tab + Enter/Space）
- 位置固定在左下角侧边栏脚部、账户行上方，**不可拖动**

## 速度表的数据从哪来

**不读任何会话统计**。插件的 Node 半边直接监听宿主的流式事件，统计全进程的 token 流量：

```
agent/assistant-stream  →  frame.chunk.type === 'text-delta' | 'reasoning-delta'
                          →  estimateTokens(text) 累加进 3.5 秒滑动窗口
GET /balance-gauge/traffic →  { tokensPerSecond, windowMs, at }
```

前端每 300ms 拉一次这个只读路由，把 `tokensPerSecond` 直接喂给指针。

几个由此而来的性质：

- **是真正的「总流量」**：主会话、子代理、任何正在流式输出的 agent 都计入，因为它们走的是同一个全局事件。
- **切会话不可能飙**：读数与「哪个会话在前台」无关，没有跨会话相减，也没有累计值被替换。
- **自然回落**：没有新 token 时窗口里的样本会逐个过期，约 3.5 秒内回到 0，不需要前端再做衰减。
- **不需要额外接口或密钥**：路由只回一个数字，且只在本机回环端口上。
- 没有帧事件的老宿主会退化到已提交的 `assistant/chunk` 事件（同样只数文本增量）；两条通路有 1.5 秒去重窗口，不会重复计数。
- 读不到路由时（Node 半边没起来 / 还没重启）速度表置灰、读数 0，悬停会说明。

> token 数是用字符估算的（CJK ×1.5、其余 ÷4，与 working-activity 同款口径），不是分词器精确值——用于速度表足够，别拿它记账。

- 指针是**物理指针**：一个 `requestAnimationFrame` 里跑弹簧-阻尼积分（刚度 120、阻尼 19，接近临界阻尼），数据变化只改「目标角度」，指针自己带着惯性滑过去，静止后不再写 DOM
- **实时抖动**：正在出字时，速度指针叠加两道不同频率的正弦微颤（11.5Hz + 4.7Hz，峰值 ±4°，随读数变大），像仪表盘跟着发动机震；**读数落到 0 就自动归于平静**
- 余额指针不抖（油箱不该跟着发动机抖），只做平滑滑行
- 尊重 `prefers-reduced-motion`：系统开了减少动态效果时指针直接落位，不做过渡
- 余额表同样走这套动画（换钱/重登时会滑到新刻度）

## 放置位置

固定在**左侧边栏脚部、账户/设置那一行的正上方**，也就是整个页面的左下角：

- 座位是 `sidebar.footer.action`（侧边栏声明的一个 list 槽，原住客是 Cordis 面板按钮），所以它会跟着侧边栏一起移动、一起收起，不是浮在页面上的绝对定位。
- **不能拖动**，位置固定，不会因为你换会话、刷新页面而跑掉。
- 侧边栏收成 56px 图标栏时卡片自动隐藏（那里只放得下图示，账户行本身也变成了头像）。
- 卡片宽度跟随侧边栏（默认 280px），文字过长会省略号截断。

样式上刻意做成「侧边栏原生的一行」，不是贴上去的卡片：

- **无底色、无描边、无阴影**（背景透明，直接坐在侧边栏表面上）
- 只有鼠标悬停时才出现一层侧边栏行的浅色高亮（`--dsw-alias-interactive-bg-hover`）
- 分区颜色压过饱和度（红 `#D96C64`、黄 `#D9A05F`、绿 `#6BA689`），金额文字的墨色比弧线再深一档

单击卡片立刻刷新，每 60 秒自动刷新一次。

## 数据从哪来

用的是宿主**已经挂载的**账户远程方法 `ctx.remote.account.getBalance`——也就是设置 → 账户页显示的那个余额（充值余额 + 赠送余额，同币种合计，优先显示 CNY）。

因此这个插件：

- 不读取 API key，不往磁盘写任何凭据；
- 不新增网络接口，不直连 `api.deepseek.com`；
- 拿不到余额时（未登录、请求失败）只把表盘置灰，不会让界面报错。

## 安装

插件是**自挂载 bundle**：包里的 `cordis.patch.yml` 自带那行 `insert:`，装上即启用，不需要手工改 profile。

```sh
# 发布到 npm 之后
dsh plugin --profile desktop add dsh-balance-gauge
```

从源码装（clone 本仓库后）：

```sh
# 1) 把包放进 profile 的 node_modules（Windows 下可用目录联接）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-balance-gauge" -Target "<本仓库路径>"

# 2) 把包里的 cordis.patch.yml 那行 insert 追加到
#    ~/.dsh/profiles/desktop/cordis.patch.yml
```

装完**重启 DeepSeek Harness**（Host 在启动时读取 profile 与 Loader 条目；Node 半边的流量路由也是那时注册的）。

改代码的开发流程同理：本仓库即源码目录，`node scripts/build.mjs` 重新构建 `lib/client.js`，刷新页面即可看客户端改动；改了 `lib/index.js`（Node 半边）则需要重启。

## 卸载

删掉 profile 的 `cordis.patch.yml` 里那段 `insert:` 行（或用 `dsh plugin --profile desktop remove dsh-balance-gauge`）即可；想彻底清掉再删 `node_modules/dsh-balance-gauge` 这个链接。

## 改数值

阈值和满格刻度都在 `src/gauge.js` 顶部：

```js
export const FULL_SCALE = 100      // 余额指针到最右端对应的金额
export const LOW_THRESHOLD = 10    // 低于它变红
export const HIGH_THRESHOLD = 50   // 高于它变绿
export const SPEED_MAX = 500       // 速度满格（tok/s，0→500 映射 180° 摆角）
```

配色在 `ZONE_COLORS`，文案在 `COPY`。改完执行：

```powershell
node scripts/build.mjs
```

只改 `lib/client.js` 也行，但那是构建产物，下次构建会被覆盖。

## 开发与验证

```powershell
node scripts/build.mjs        # 生成 lib/client.js + preview/index.html
node scripts/harness.mjs      # 生成 preview/harness.html（用桩 React/桩账户/桩流量跑真 bundle）
node scripts/node-probe.mjs   # 单独验证 Node 半边的流量统计与路由
node scripts/screenshot.mjs   # 用本机 Edge 无头截图 preview/gauge.png
```

- `preview/index.html`：同一套 CSS 与 SVG 的静态预览，覆盖红/黄/绿/未登录/失败/加载六种状态，含深色主题。
- `preview/harness-index.html`：把**构建产物**装进浏览器，用桩 `__ModuleLoader__`、桩 React、桩 `ctx.remote.account` 真跑一遍，验证注册、余额解析与渲染。这两处是发布前的回归入口。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | Node 侧：统计全进程 token 流量，注册 `/balance-gauge/traffic` 只读路由 |
| `lib/client.js` | 浏览器 bundle（构建产物），宿主从 `/plugins/dsh-balance-gauge/client.js` 提供 |
| `src/gauge.js` | 金额 → 角度、分区、配色、文案（纯函数） |
| `src/gauge.css` | 全部样式，类名统一 `bg-` 前缀 |
| `src/client.js` | React 组件与 slot 注册、轮询、余额解析 |
| `scripts/build.mjs` | 内联两个模块生成 bundle，并产出静态预览 |
| `scripts/harness.mjs` | 真 bundle 的集成测试页（桩 fetch 提供流量） |
| `scripts/node-probe.mjs` | Node 半边的单元探针：喂合成帧、读路由、验算速率 |

## 取不到数时

卡片金额位显示 `--`，下面那行小字会带上**原因码**，照着念就能定位：

| 小字后缀 | 含义 | 处理 |
| --- | --- | --- |
| `· service` | 拿不到账户远程（命名空间还没挂载 / 没注入） | 一般几秒后自愈；一直这样再报 |
| `· rpc` / `· <错误码>` | 调用被宿主拒绝 | 多与登录态或协议版本有关 |
| `· shape` | 返回结构不是预期的钱包数组 | 宿主改版了，需要更新解析 |
| `· failed` / `· initializing` | 账户本身没就绪（未登录、token 过期） | 去「设置 → 账户」登录 |

读到失败后会按 1.5s → 4s → 10s → 30s 的阶梯自动重试，成功后回到 60s 常规轮询——因为账户命名空间可能比这个插件晚挂载，第一轮读取失败是正常的。

## 已知限制

- 宿主没起 Web 服务、或侧边栏的 `sidebar.footer.action` 槽位不在（比如侧边栏插件没装载）时，插件安静地不出现。
- 余额只在**页面打开时**拉取：一分钟一次 + 手动点击，不做服务端推送。
- 插件只读账户快照，不含积分/代金券明细；赠送额并入总数，明细请到设置 → 账户看。

## 宿主版本兼容

| 宿主 | 状态 |
| --- | --- |
| 0.2.2-rc.1 | ✅ 当前适配版本 |
| 0.2.1-rc.2 | ✅ 曾在该版本验证 |

0.2.2 的破坏性变化与对应处理：

- **`@deepseek-ai/dsh-client-ui-slots` 包被移除**（实现合并进 `dsh-client-ui-renderer`）。`dsh.client.inject` 里若还列它，宿主组合 boot graph 时找不到 supplier，整个客户端插件会被拒载——本包已改为 `api-remotes` + `client-locale` + `renderer` + `session`（分别提供 `remote` / `locale` / `slots` 服务，与官方 sidebar、account 插件的声明方式一致）。
- **账户 Remote 的客户端版本字面量**随宿主发布递增；`FALLBACK_CLIENT_VERSION` 已同步为 `0.2.2-rc.1`（正常路径仍从 `__DSH_BOOT__.release.version` 读取，这个只是兜底）。
- 未变的部分：`sidebar.footer.action` 槽位、`ctx.remote.account.getBalance`、`ctx.webServer.register({kind:'exact'})`、`window.__ModuleLoader__` bundle 形态。
