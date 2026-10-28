# TIGER POWER · 双钱包网页版

基于 [bzd6661/TIGER-POWER-Terminal](https://github.com/bzd6661/TIGER-POWER-Terminal)，保留原作者署名及原有交易、报价、持仓、扫链和追踪功能。新增一个网站访问层，供**一个人管理两个 Binance Agentic Wallet 账号**，不是面向公众的多用户托管钱包服务。

## 临时在自己电脑的浏览器使用

1. 安装 **Node.js 24.7 或更新版本**，解压项目。
2. Windows 双击 `start-web.cmd`；macOS / Linux 在项目目录运行 `bash start-web.sh`。
3. 首次启动按终端提示设置网站地址和一个至少 12 位的网站密码。只在自己电脑临时用时，地址填 `http://localhost:4400`。密码输入不会回显；这里只设置网站密码，不是 Binance 密码。
4. 保持终端运行，在浏览器打开设置的地址，输入网站密码。依次点「登录账号 1」「登录账号 2」，用**各自对应的 Binance 账号**扫码并核对配对码，在 App 中批准。也可复制登录链接到手机浏览器。二维码约 5 分钟过期，可在网页里重新生成；切换标签页或短暂关闭弹窗不会中断服务器验证。
5. 粘贴 BSC 代币合约地址，选择账号 1 / 账号 2 / 两个号，查看报价并确认买卖。网站不会代替你开通 Agentic Wallet、绑定 Agent ID 或启用开发者模式；相关操作仍在 Binance App 中完成。
6. 临时使用结束后，网页的「锁定网站」只退出网站访问；钱包卡片的「退出」分别退出对应的 Binance 钱包。需要完全退出时先退出两个钱包，再停止终端。

也可以手动启动：

```bash
npm ci
npm run web:setup
npm run web
```

钱包在 Binance 中的最长登录时间和不活跃超时仍适用。合约交易需启用开发者模式；仅有网站登录不能取得钱包权限。必须自行核对合约地址、账号、金额、滑点和 App 中的交易提示。

## 临时公网网址 / 服务器

现在支持在允许 HTTPS / WebSocket 出站连接的环境中创建临时网址：

```bash
npm run temporary
```

服务通过 `service.tunnelmole.com:8083` 建立加密连接，并分配 `*.tunnelmole.net` 临时域名。公开访问只有通过网站鉴权才能操作钱包。首次运行会生成一个一小时内有效、仅能使用一次的私人初始化链接，保存在 `PANEL_DATA_DIR/temporary-entry.json`，不要公开该文件。访问初始化链接后在网页中设置至少 12 位网站密码；密码只保存 scrypt 哈希，初始化链接随即失效。部署者不需要在聊天中索取你的密码。

程序和当前云环境必须保持运行；地址可能在重启后改变。这不是永久网站托管。临时中继将响应缓冲后返回，因此交易日志可能在执行结束后一次显示；发起需确认的卖出后请同时留意 Binance App。等待确认或连接超时会显示「状态待核对」，应先核对 App 和链上记录，不要因为等待而重复提交。实时事件使用短响应及定时刷新。完整流式体验建议使用支持流式转发的正式 HTTPS 托管。

本次已在实际 HTTPS 临时地址验证登录页面和未登录钱包接口拦截。BSC RPC 读取已通过；Binance 现货价格接口返回 451，美元价格可能暂不可用。未连接真实钱包或广播交易。

当有 HTTPS 反向代理或平台公开地址时：

1. 运行 `npm run web:setup`，把网站地址设为你实际访问的 **HTTPS 根地址**。`PANEL_PUBLIC_URL` 的 Host / Origin 必须精确匹配；不能将本机地址直接替换成公网地址而不修改配置。
2. 直接运行 `npm start`。也提供 `docker compose up --build -d` 的可选配置，但当前云环境中完整镜像构建未验证完成，详见 [VALIDATION.md](VALIDATION.md)。
3. 将 HTTPS 反向代理指向服务器端口 4400，保留真实 Host；关闭响应缓冲并给流式交易请求至少 5 分钟超时。Compose 默认只向服务器本机开放端口。应用不信任任意 `X-Forwarded-Host` / `X-Forwarded-For`，不开放跨域访问。
4. 配置持久卷；不要公开挂载数据目录。重启后网站需重新登录，两个钱包的加密会话与设置保存在卷中。

在标准服务器上，反向代理示例：

```caddy
trade.example.com {
    reverse_proxy 127.0.0.1:4400 {
        flush_interval -1
    }
}
```

公网模式必须配置网站密码。请勿给陌生人网站访问密码：通过网站登录的人可以操作本部署中的两个钱包。网站 cookie 使用 HttpOnly、SameSite=Strict，公网 HTTPS 下还使用 Secure；12 小时后或不活跃 30 分钟后失效。网站 POST 和实时事件流均校验当前浏览器会话对应的令牌。密码仅保存 scrypt 哈希，失败登录会限速。

## 两个钱包与数据

- 两个槽位自动可用，无需另外安装 `baw2`。
- 使用固定的 `@binance/agentic-wallet@1.12.0`，通过 Node 直接调用，不依赖 Windows `.cmd` 或全局 `baw`。
- 网站模式禁用 CLI 的共享系统钥匙串，各自使用独立加密会话目录及持久实例身份，防止重启或容器更换网卡导致会话无法解密。
- 默认私有数据在 `.data/`；`PANEL_DATA_DIR` 可以指定持久数据目录。包含钱包会话、钱包地址锁定、设置、持仓缓存、收藏和追踪列表。整个目录必须保密，不要发送给别人。两份会话是独立的；可以用不同钱包账号分别授权，并单独退出。
- 不会导入或覆盖此次聊天之前的 `/workspace/.baw` 登录信息。
- 项目原有的地址锁定、交易预览、风险检查、精确授权和默认下单确认保留；自动操作仍默认关闭。
- Gang V2 已将官方 `@gangfun/cli@0.8.0` 固定为项目依赖，`npm ci` 会一并安装，无需全局安装。交易脚本优先使用项目内 CLI，默认复用 `BSC_RPC`；需要单独的节点时可设置 `GANG_RPC_URL`。

## 网络与验证范围

基础钱包登录需要 `www.binance.com`；用户手机上的登录链接可能是 `app.binance.com`。行情与读链还使用 `api.binance.com`、`bsc-dataseed.bnbchain.org`、`bsc-rpc.publicnode.com`、`bsc-rpc.48.club`、`four.meme`、`gang.fun`、`api.dexscreener.com`、`gateway.pinata.cloud` 等，K 线嵌入 `www.gmgn.cc`。受限制的云环境需按实际使用功能放行对应 HTTPS / WSS，或设置 `.env.example` 中的私有 RPC。不要通过关闭 TLS 校验来解决连接问题。

```bash
npm test
# 需要 Chromium；可用 CHROMIUM_PATH 指向浏览器可执行文件
npm run test:browser
```

测试覆盖访问拦截、Origin / CSRF、密码限速、会话过期、双钱包扫码、地址锁定、账号退出隔离、桌面 / 手机页面和网站锁定。集成测试使用**明确的模拟钱包**及模拟报价源，没有创建真实钱包或广播交易。真实资金交易、全平台链上兼容性、外网部署和新云任务还原不在此次已验证范围。
