# 抽奖页面固定网址部署说明

## 结论

这个项目不是纯静态网页。它需要运行 `server.js`，因为员工登记、老板端名单同步、抽奖结果保存都依赖 `/api/*` 接口和 `data/lottery-data.json`。

如果只是把 `index.html` 上传到普通静态空间，老板端和员工端不能稳定共享同一份名单。

## 正式推荐方案：Render 付费 Web Service + Persistent Disk

本项目已经带有 `render.yaml`，用于创建一套正式部署配置：

- Node.js Web Service
- `starter` 付费实例，避免免费实例休眠
- 新加坡区域
- `/healthz` 健康检查
- `/var/data` 持久磁盘
- `ADMIN_PASSWORD` 老板端密码

不要使用 Render Free，也不要使用纯静态部署。

部署后：

- 老板打开主页面：`https://你的固定域名/`
- 员工登记链接：`https://你的固定域名/?join=1` 或 `https://你的固定域名/join`
- 页面里的二维码会自动指向登记链接
- 员工提交姓名后，老板页面会自动刷新名单，当前间隔约 1.5 秒

## Render 正式部署步骤

1. 把本文件夹内容上传到一个 GitHub 仓库。
2. 在 Render 选择 `New` -> `Blueprint`。
3. 选择这个 GitHub 仓库。
4. Render 会读取仓库里的 `render.yaml`。
5. 在环境变量页面填写：
   - `ADMIN_PASSWORD`: 老板端密码
6. 创建服务并等待部署完成。
7. 部署完成后，Render 会给一个固定网址，例如：
   - `https://your-lottery.onrender.com/`
8. 老板用这个网址打开主页面。
9. 员工扫码页面上的二维码，或直接访问：
   - `https://your-lottery.onrender.com/?join=1`

## 老板端密码

如果设置了 `ADMIN_PASSWORD`，老板打开主页面时浏览器会弹出登录框：

```text
用户名：admin
密码：你在 Render 里填写的 ADMIN_PASSWORD
```

员工登记页不需要密码。

## 数据持久化

正式部署时名单保存在 Render 持久磁盘：

```text
/var/data/lottery-data.json
```

本地开发时名单仍保存在：

```text
data/lottery-data.json
```

Render 的持久磁盘会在服务重启和重新部署后保留名单。

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

- 在老板页面清空测试名单和中奖结果。
- 用老板电脑打开 `https://你的固定域名/`。
- 用至少两台手机扫码登记，确认老板页面 1 到 2 秒内出现姓名。
- 测试重复姓名是否提示“姓名已登记”。
- 测试导出 CSV。
- 确认老板页面需要密码，员工登记页不需要密码。
- 确认 Render 服务是 `starter` 或更高付费实例。
- 确认 Render 服务已经挂载 `/var/data` 持久磁盘。
- 确认健康检查 `/healthz` 正常。

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
