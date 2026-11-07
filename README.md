# MineBBS Auto Check-in

MineBBS 新版首页自动签到油猴脚本（v2.1.4）。

## 功能

- 打开浏览器后自动检查上次签到时间，超过 20 小时、跨天或没有记录时自动签到
- 后台静默打开 MineBBS 首页并提交新版侧栏签到表单，成功后自动关闭标签页
- 未登录时弹出「是/否」选择：
  - **是**：切换到登录页，登录成功后自动补签
  - **否**：关闭标签页并记录本次选择，20 小时后再尝试签到
- 因登录触发的补签完成后自动回到官网首页，并询问是否关闭网页
- 包含重复提交保护、冷却保护，并可在油猴菜单中查看上次签到时间与日志

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或兼容的油猴管理器
2. 点击下面的 GitHub Raw 安装链接：

   **<https://raw.githubusercontent.com/Zeiver1337/minebbs-auto-checkin/main/minebbs-auto-sign.user.js>**

3. 在油猴的安装页面确认安装
4. 建议把浏览器启动页设为普通网页（推荐 `https://www.minebbs.com/`），油猴脚本无法注入 `chrome://newtab` 等浏览器内置页

> 请通过上面的 Raw 链接安装，不要复制粘贴代码。通过链接安装的脚本会记录更新地址，油猴可以定期检查新版本；复制粘贴安装的脚本无法自动检查更新，只能手动重装。

## 更新

- 脚本头部已声明 `@updateURL` 和 `@downloadURL`，指向 GitHub `main` 分支的 raw 文件
- 发布新版本时只需提高 `@version` 并推送到 GitHub，油猴会定期检查并在有新版本时提示更新
- 也可以在油猴管理面板中手动点击「检查更新」
- Greasy Fork 安装的用户：Greasy Fork 会从 GitHub 同步新版本，并按其自身机制提示更新

Greasy Fork 发布页：<https://greasyfork.org/zh-CN/scripts/604253>

## 使用说明

- 默认完全静默，不需要手动操作
- 未登录时按弹窗提示选择「是」或「否」
- 油猴菜单提供「查看上次签到时间」「立即后台签到」「清除签到记录」

## 文件

- `minebbs-auto-sign.user.js`：主脚本

## 支持作者

GitHub 仓库：<https://github.com/Zeiver1337/minebbs-auto-checkin>

欢迎来 GitHub 上支持我（Star、Issue、PR 都欢迎）。

## 说明

脚本依赖 MineBBS 当前页面结构（`.mjc-signin-status`、`POST /credits/clock`）。站点改版后可能需要更新选择器。