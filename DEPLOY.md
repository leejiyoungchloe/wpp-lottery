# 抽奖页面固定网址部署说明

## 结论

这个项目不是纯静态网页。它需要运行 `server.js`，因为员工登记、老板端名单同步、抽奖结果保存都依赖 `/api/*` 接口和 `data/lottery-data.json`。

如果只是把 `index.html` 上传到普通静态空间，老板端和员工端不能稳定共享同一份名单。

## 推荐方案：部署到支持 Node.js 的云服务

适合：Render、Railway、Fly.io、阿里云/腾讯云轻量服务器、普通 VPS。

部署后：

- 老板打开主页面：`https://你的固定域名/`
- 员工登记链接：`https://你的固定域名/?join=1`
- 页面里的二维码会自动指向登记链接
- 员工提交姓名后，老板页面会自动刷新名单，当前间隔约 1.5 秒

## Render 部署步骤

1. 把本文件夹内容上传到一个 GitHub 仓库。
2. 在 Render 新建 `Web Service`，选择这个 GitHub 仓库。
3. 配置：
   - Runtime: `Node`
   - Build Command: 留空，或填 `npm install`
   - Start Command: `npm start`
   - Environment Variable: 可选，`NODE_VERSION=20`
4. 部署完成后，Render 会给一个固定网址，例如：
   - `https://your-lottery.onrender.com/`
5. 老板用这个网址打开主页面。
6. 员工扫码页面上的二维码，或直接访问：
   - `https://your-lottery.onrender.com/?join=1`

## 数据持久化提醒

当前名单保存在：

```text
data/lottery-data.json
```

如果云平台重启、重新部署，普通免费容器的本地文件可能丢失。正式活动建议二选一：

1. 使用带持久磁盘的 Node 服务，把磁盘挂载到项目的 `data` 目录。
2. 把存储改成外部数据库或云存储，例如 Supabase、Redis、Netlify Blobs、云数据库。

如果只是当天活动，并且活动前不会重启服务，现有文件存储通常够用；但正式使用前最好安排一次完整演练。

## 不推荐方案

### Cloudflare Tunnel 本地公网模式

项目里已有：

```bash
npm run start:tunnel
```

这个适合临时测试，手机不同网络也能扫码，但 `trycloudflare.com` 链接通常每次启动都会变化，不满足“网址固定不变”。

### 纯静态托管

GitHub Pages、普通静态服务器、仅上传 HTML 的空间都不适合当前需求，因为无法保存和同步员工名单。

### 直接上 Netlify/Vercel 静态站

Netlify/Vercel 可以托管页面，但当前 `server.js` 不能原样作为长期运行的 Node 服务。要上这些平台，需要把 `/api/*` 改造成 Serverless Functions，并把 `data/lottery-data.json` 改成外部存储。

## 正式活动前检查清单

- 清空测试名单和中奖结果。
- 用老板电脑打开 `https://你的固定域名/`。
- 用至少两台手机扫码登记，确认老板页面 1 到 2 秒内出现姓名。
- 测试重复姓名是否提示“姓名已登记”。
- 测试导出 CSV。
- 确认活动期间云服务不会自动休眠。
- 如不希望员工进入老板端操作抽奖，建议增加老板端密码或管理入口。

## 本地测试命令

```bash
npm start
```

打开：

```text
http://127.0.0.1:5173/
```

同一 Wi-Fi 下，手机可访问终端显示的局域网地址，例如：

```text
http://192.168.x.x:5173/?join=1
```
