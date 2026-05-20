# 抽奖页面免费固定网址部署说明

## 结论

不付费时，不建议使用 Render Free。Render Free 会休眠，且没有持久磁盘，不适合“老板随时打开、员工扫码登记、数据不能丢”的活动页面。

当前项目已经改成免费部署方案：

- 页面托管：Netlify 免费站点
- API：Netlify Functions
- 数据存储：Netlify Blobs
- 固定网址：Netlify 自动提供 `https://xxx.netlify.app`
- 老板端密码：`ADMIN_PASSWORD`
- 员工登记页公开：`/join` 或 `/?join=1`

## 部署后链接

- 老板主页面：`https://你的站点.netlify.app/`
- 员工登记页：`https://你的站点.netlify.app/join`
- 备用登记页：`https://你的站点.netlify.app/?join=1`

员工提交姓名后，老板页面会自动刷新名单，当前间隔约 1.5 秒。

## Netlify 免费部署步骤

1. 打开 Netlify。
2. 选择 `Add new site` -> `Import an existing project`。
3. 选择 GitHub 仓库：
   - `leejiyoungchloe/wpp-lottery`
4. Netlify 会读取仓库里的 `netlify.toml`。
5. Build command 使用：
   - `npm install`
6. Publish directory 使用：
   - `.`
7. 在环境变量里添加：
   - `ADMIN_PASSWORD`: 老板密码
   - `ADMIN_USERNAME`: 可选，默认是 `admin`
8. 部署。

## 老板端密码

老板打开主页面时，页面会要求输入老板密码。

默认用户名：

```text
admin
```

密码就是你在 Netlify 环境变量里设置的 `ADMIN_PASSWORD`。

员工登记页不需要密码。

## 数据保存位置

正式线上数据保存在 Netlify Blobs：

```text
wpp-lottery-data
```

本地运行 `npm start` 时，数据仍保存在：

```text
data/lottery-data.json
```

## 正式活动前检查清单

- 在 Netlify 设置好 `ADMIN_PASSWORD`。
- 部署完成后，打开老板主页面，确认会要求输入密码。
- 用手机打开 `/join`，确认不需要密码。
- 用至少两台手机登记不同姓名，确认老板页面 1 到 2 秒内出现姓名。
- 测试重复姓名是否提示“姓名已登记”。
- 测试导出 CSV。
- 活动开始前在老板页面清空测试名单和中奖结果。

## 不推荐方案

### Render Free

不推荐，因为免费服务会休眠，且本地文件不适合长期保存名单。

### Cloudflare Tunnel 本地公网模式

项目里已有：

```bash
npm run start:tunnel
```

这个适合临时测试，但 `trycloudflare.com` 链接通常每次启动都会变化，不满足“网址固定不变”。

### 纯静态托管

GitHub Pages、普通静态服务器、只上传 HTML 的空间都不适合原始版本，因为无法可靠保存和同步员工名单。

## 本地测试命令

```bash
npm start
```

打开：

```text
http://127.0.0.1:5173/
```
