// ==UserScript==
// @name         MineBBS 静默自动签到（新版首页组件）
// @namespace    https://www.minebbs.com/
// @version      2.1.4
// @description  打开浏览器自动检查 MineBBS 签到时间，需要时静默签到；未登录弹窗可选去登录或跳过，登录成功后自动补签并询问是否关闭网页
// @author       you
// @homepageURL  https://github.com/Zeiver1337/minebbs-auto-checkin
// @supportURL   https://github.com/Zeiver1337/minebbs-auto-checkin/issues
// @updateURL    https://raw.githubusercontent.com/Zeiver1337/minebbs-auto-checkin/main/minebbs-auto-sign.user.js
// @downloadURL  https://raw.githubusercontent.com/Zeiver1337/minebbs-auto-checkin/main/minebbs-auto-sign.user.js
// @match        *://*.minebbs.com/*
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * ────────────────────────────────────────────────
 * 2026 新站变化（旧版失效原因）
 * 1) 签到入口不再是 https://www.minebbs.com/credits/，该页已没有签到模块；
 * 2) 新签到组件在首页侧栏：.mjc-signin-status > form.mjc-signin-form；
 * 3) 表单提交地址改为 POST /credits/clock，并携带 _xfToken 与 currency_ids[]；
 * 4) 旧选择器 form[action*="credits/sign"] 与 /credits/sign 已不存在。
 *
 * 工作方式
 * 1) 打开任意网页时读取本地「上次签到时间」；
 * 2) 若时间未知、跨天或超过 EXPIRE_HOURS 小时，后台静默打开 MineBBS 首页（不抢焦点）；
 * 3) 后台页识别 .mjc-signin-status：未签到就点击「立即签到」，让站点自身提交表单；
 * 4) 提交后页面会刷新，脚本用 sessionStorage 记住「本标签已提交」，刷新后只做结果确认，
 *    不会重复提交；确认已签到后写回时间并自动关闭后台标签；
 * 5) 会话内与提交后都有冷却保护，签到失败也不会反复弹标签；
 * 6) 未登录时不执行签到，会弹窗提醒；弹窗有「是/否」：
 *    是 = 切换到登录页；否 = 关闭标签并记录本次选择，20 小时后再尝试签到；
 * 7) 提醒后会持续检测登录状态（页面 data-logged-in + 后台请求首页双重确认），
 *    确认登录成功后自动打开补签页；补签完成会回到官网首页，并询问「是否关闭此网页」（是/否）。
 *
 * 注意：油猴脚本无法注入 chrome://newtab 等浏览器内置页。若启动页是新标签页，
 * 脚本没有运行机会，请把启动页设为任意普通网址（推荐直接设为 https://www.minebbs.com/）。
 * ────────────────────────────────────────────────
 */

(function () {
    'use strict';

    // ============ 可调参数 ============
    const CFG = {
        // 新站签到组件位于首页侧栏
        SIGN_URL: 'https://www.minebbs.com/',
        // 登录页
        LOGIN_URL: 'https://www.minebbs.com/login/',
        // 距离上次签到超过多少小时就判定为「长时间未更新」
        EXPIRE_HOURS: 20,
        // 用户在未登录弹窗选择「否」后，多少小时内不再尝试签到
        SKIP_HOURS: 20,
        // 是否同时按自然日判断（更贴合「每日签到」：昨天签的，今天就要重新签）
        BY_NATURAL_DAY: true,
        // 同一浏览器会话内，两次「启动检查」的最小间隔（分钟），避免每开一页都检查
        CHECK_GAP_MIN: 5,
        // 判定需要签到后，两次「打开后台标签页」的最小间隔（分钟），避免签到失败时反复弹标签
        OPEN_COOLDOWN_MIN: 20,
        // 提交表单后，在这个时间内（毫秒）只确认结果、不重复提交
        POST_GUARD_MS: 120000,
        // 未登录提醒的最小间隔（分钟），避免每个页面都弹窗
        LOGIN_WARN_GAP_MIN: 360,
        // 等待用户登录时，多久向站点确认一次登录状态（毫秒）
        LOGIN_POLL_MS: 5000,
        // 等待登录的最长时间（毫秒），超时后停止轮询，页面仍然保留
        LOGIN_POLL_MAX_MS: 300000,
        // 未登录待办状态的有效期（毫秒），超过后视为放弃本次登录
        LOGIN_PENDING_TTL_MS: 1800000,
        // 关闭询问选择后，多久内不再重复弹出（毫秒）
        CLOSE_PROMPT_SUPPRESS_MS: 300000,
        // 是否弹系统通知（默认关闭 = 完全静默）
        NOTIFY: false,
        // 日志最多保留条数
        LOG_MAX: 30,
    };

    const K = {
        LAST_SIGN: 'mb_lastSignTime', // 上次签到成功时间戳
        LAST_TRY: 'mb_lastTryTime', // 上次尝试打开签到页时间戳
        LAST_CHECK: 'mb_lastCheckTime', // 上次启动检查时间戳
        LAST_WARN: 'mb_lastLoginWarnTime', // 上次未登录提醒时间戳
        LOGIN_STATE: 'mb_loginState', // 上次检测到的登录状态
        LOGIN_PENDING: 'mb_loginPending', // 等待用户登录的时间戳
        LAST_SKIP: 'mb_lastSkipTime', // 用户在未登录弹窗选择「否」的时间戳
        LOG: 'mb_log', // 日志
    };

    // 只存在于当前标签页的会话标记（表单提交会刷新页面，sessionStorage 仍会保留）
    const S = {
        AUTO_TAB: 'mb_auto_tab', // 本标签是脚本自己打开的后台签到页
        POSTED: 'mb_posted', // 本标签已经提交过签到表单
        HOME_TRIED: 'mb_home_tried', // 是否已经回退过一次首页，防止循环
        LOGIN_FLOW: 'mb_login_flow', // 本标签是「登录后补签」的交互标签
        PROMPTED: 'mb_closePromptTime', // 上次回答「是否关闭」的时间戳
    };

    // ============ GM API 兼容层（同时支持 GM_xxx 与 GM.xxx） ============
    const G = {
        get(k, d) {
            try {
                if (typeof GM_getValue === 'function') return GM_getValue(k, d);
                if (typeof GM !== 'undefined' && GM.getValue) return GM.getValue(k, d);
            } catch (e) { /* ignore */ }
            return d;
        },
        set(k, v) {
            try {
                if (typeof GM_setValue === 'function') return GM_setValue(k, v);
                if (typeof GM !== 'undefined' && GM.setValue) return GM.setValue(k, v);
            } catch (e) { /* ignore */ }
        },
        openTab(url, opts) {
            try {
                if (typeof GM_openInTab === 'function') return GM_openInTab(url, opts);
                if (typeof GM !== 'undefined' && GM.openInTab) return GM.openInTab(url, opts);
            } catch (e) { /* ignore */ }
            try { return window.open(url, '_blank'); } catch (e) { /* ignore */ }
        },
        menu(name, fn) {
            try {
                if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(name, fn);
                else if (typeof GM !== 'undefined' && GM.registerMenuCommand) GM.registerMenuCommand(name, fn);
            } catch (e) { /* ignore */ }
        },
        notify(text, title) {
            if (!CFG.NOTIFY) return;
            try {
                if (typeof GM_notification === 'function') {
                    GM_notification({ text: text, title: title || 'MineBBS 自动签到', timeout: 5000 });
                }
            } catch (e) { /* ignore */ }
        },
    };

    // ============ 工具函数 ============
    function num(v) {
        const n = Number(v);
        return isFinite(n) && n > 0 ? n : 0;
    }

    function norm(s) {
        return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function fmtTime(ts) {
        if (!ts) return '未知';
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function log(msg) {
        const line = `[${fmtTime(Date.now())}] ${msg}`;
        try {
            const arr = G.get(K.LOG, []);
            const list = Array.isArray(arr) ? arr : [];
            list.push(line);
            while (list.length > CFG.LOG_MAX) list.shift();
            G.set(K.LOG, list);
        } catch (e) { /* ignore */ }
        console.log('[MineBBS签到]', msg);
    }

    function isMineBBS() {
        return /(^|\.)minebbs\.com$/i.test(location.hostname);
    }

    function sessionGet(k) {
        try { return sessionStorage.getItem(k); } catch (e) { return null; }
    }

    function sessionSet(k, v) {
        try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ }
    }

    function sessionRemove(k) {
        try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ }
    }

    // 本标签是否由脚本自己打开（地址带 #mb_auto=1，或刷新后仍保留的会话标记）
    function isAutoTab() {
        let flag = location.hash.indexOf('mb_auto=1') >= 0 || location.search.indexOf('mb_auto=1') >= 0;
        if (flag) sessionSet(S.AUTO_TAB, '1');
        else flag = sessionGet(S.AUTO_TAB) === '1';
        return flag;
    }

    function markPosted() {
        sessionSet(S.POSTED, String(Date.now()));
    }

    function getPosted() {
        return num(sessionGet(S.POSTED));
    }

    // 用户是否在未登录弹窗里选择了「否」，并且在跳过有效期内
    function isSkipped(now) {
        const t = num(G.get(K.LAST_SKIP, 0));
        return t > 0 && ((now || Date.now()) - t) < CFG.SKIP_HOURS * 3600000;
    }

    // 记录「暂不登录」的选择
    function markSkip() {
        const now = Date.now();
        G.set(K.LAST_SKIP, now);
        clearLoginPending();
        log('用户选择暂不登录，已记录：' + fmtTime(now) + '，' + CFG.SKIP_HOURS + ' 小时后再尝试签到');
    }

    // 是否需要（重新）签到
    function needSign(lastSign, now) {
        now = now || Date.now();
        if (isSkipped(now)) return false; // 用户选择「否」，20 小时内不再尝试
        if (!lastSign) return true; // 时间未知
        if (now - lastSign > CFG.EXPIRE_HOURS * 3600000) return true; // 长时间未更新
        if (CFG.BY_NATURAL_DAY) {
            const a = new Date(lastSign);
            const b = new Date(now);
            if (a.getFullYear() !== b.getFullYear() ||
                a.getMonth() !== b.getMonth() ||
                a.getDate() !== b.getDate()) return true; // 跨天了
        }
        return false;
    }

    function markSigned(extra) {
        const now = Date.now();
        G.set(K.LAST_SIGN, now);
        G.set(K.LAST_SKIP, 0); // 真的签到了，清掉「暂不登录」记录
        clearLoginPending();
        log('签到成功，已记录时间：' + fmtTime(now) + (extra ? '（' + extra + '）' : ''));
        G.notify('签到成功：' + fmtTime(now));
    }

    // 未登录弹窗：是 = 去登录；否 = 关闭标签并跳过 20 小时
    // context = 'page'（当前页面） / 'auto'（脚本打开的后台签到标签）
    // 返回是否真的展示了弹窗（冷却期内返回 false）
    function warnNotLoggedIn(context) {
        const now = Date.now();
        const lastWarn = num(G.get(K.LAST_WARN, 0));
        if (now - lastWarn < CFG.LOGIN_WARN_GAP_MIN * 60000) return false;
        G.set(K.LAST_WARN, now);

        log('未登录 MineBBS，已提醒用户登录');
        const show = () => showLoginPrompt(context);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', show, { once: true });
        } else {
            show();
        }
        return true;
    }

    function showLoginPrompt(context) {
        if (document.getElementById('mb-login-prompt')) return;
        if (!document.body) return;

        // 后台标签页里尝试把窗口带到前台，方便用户看到选择
        if (context === 'auto') {
            try { window.focus(); } catch (e) { /* ignore */ }
        }

        const font = '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif';

        const overlay = document.createElement('div');
        overlay.id = 'mb-login-prompt';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483646',
            'background:rgba(15,23,42,.55)', 'display:flex',
            'align-items:center', 'justify-content:center',
            'font-family:' + font,
        ].join(';');

        const box = document.createElement('div');
        box.style.cssText = [
            'min-width:300px', 'max-width:380px', 'background:#fff', 'border-radius:12px',
            'padding:24px 22px 18px', 'box-shadow:0 20px 50px rgba(0,0,0,.28)',
            'text-align:center', 'color:#1f2937',
        ].join(';');

        const title = document.createElement('div');
        title.textContent = 'MineBBS 未登录';
        title.style.cssText = 'font-size:17px;font-weight:600;margin-bottom:10px;';

        const desc = document.createElement('div');
        desc.textContent = '自动签到需要先登录账号，是否现在去登录？';
        desc.style.cssText = 'font-size:14px;color:#4b5563;margin-bottom:8px;';

        const hint = document.createElement('div');
        hint.textContent = '选择「否」将关闭本页，并记录本次选择，' + CFG.SKIP_HOURS + ' 小时后再尝试签到。';
        hint.style.cssText = 'font-size:12px;color:#9ca3af;line-height:1.6;margin-bottom:18px;';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:12px;justify-content:center;';

        const btnYes = document.createElement('button');
        btnYes.type = 'button';
        btnYes.textContent = '是';
        btnYes.style.cssText = [
            'flex:1', 'padding:9px 0', 'border:0', 'border-radius:8px',
            'background:#2563eb', 'color:#fff', 'font-size:14px',
            'font-weight:600', 'cursor:pointer',
        ].join(';');

        const btnNo = document.createElement('button');
        btnNo.type = 'button';
        btnNo.textContent = '否';
        btnNo.style.cssText = [
            'flex:1', 'padding:9px 0', 'border:1px solid #d1d5db', 'border-radius:8px',
            'background:#f3f4f6', 'color:#374151', 'font-size:14px',
            'font-weight:600', 'cursor:pointer',
        ].join(';');

        const dismiss = () => {
            try { overlay.remove(); } catch (e) { /* ignore */ }
        };

        const closeSelf = () => {
            try { window.close(); } catch (e) { /* ignore */ }
            setTimeout(() => {
                try {
                    if (!document.body) return;
                    const tip = document.createElement('div');
                    tip.textContent = '已记录本次选择；浏览器未允许自动关闭，请手动关闭此标签页。';
                    tip.style.cssText = [
                        'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
                        'z-index:2147483647', 'background:#111827', 'color:#fff',
                        'padding:10px 16px', 'border-radius:8px', 'font-size:13px',
                        'box-shadow:0 8px 24px rgba(0,0,0,.3)', 'font-family:' + font,
                    ].join(';');
                    document.body.appendChild(tip);
                    setTimeout(() => { try { tip.remove(); } catch (e) { /* ignore */ } }, 5000);
                } catch (e) { /* ignore */ }
            }, 500);
        };

        btnYes.addEventListener('click', () => {
            dismiss();
            log('用户选择去登录');
            // 已经在登录页就不重复打开
            if (location.pathname.indexOf('/login') !== 0) {
                G.openTab(CFG.LOGIN_URL, { active: true, insert: true, setParent: true });
            }
            // 后台签到标签已无用途，切换后直接关掉
            if (context === 'auto') setTimeout(closeSelf, 300);
        });

        btnNo.addEventListener('click', () => {
            dismiss();
            markSkip();
            stopLoginWatch();
            closeSelf();
        });

        row.appendChild(btnYes);
        row.appendChild(btnNo);
        box.appendChild(title);
        box.appendChild(desc);
        box.appendChild(hint);
        box.appendChild(row);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }

    // ============ 登录待办与登录成功检测 ============
    // 思路：不监听「登录」按钮点击（AJAX/跳转/扫码都不可靠），而是持续用站点真实状态确认：
    //       1) 当前页 <html data-logged-in="true">；
    //       2) 同源请求首页，检查返回的 HTML 是否 data-logged-in="true"。
    //       第二条能检测到「在别的标签页/扫码完成登录」的情况。

    function markLoginPending() {
        G.set(K.LOGIN_PENDING, Date.now());
    }

    function clearLoginPending() {
        G.set(K.LOGIN_PENDING, 0);
    }

    function hasLoginPending() {
        const t = num(G.get(K.LOGIN_PENDING, 0));
        if (!t) return false;
        if (Date.now() - t > CFG.LOGIN_PENDING_TTL_MS) {
            G.set(K.LOGIN_PENDING, 0);
            return false;
        }
        return true;
    }

    // 当前标签是否是「登录后补签」的交互标签
    function isLoginFlowTab() {
        let flag = location.hash.indexOf('mb_login_flow=1') >= 0 || location.search.indexOf('mb_login_flow=1') >= 0;
        if (flag) sessionSet(S.LOGIN_FLOW, '1');
        else flag = sessionGet(S.LOGIN_FLOW) === '1';
        return flag;
    }

    // 同源请求一次首页并解析登录状态，能识别其他标签页完成的登录
    // 用当前站点根地址而不是写死的 www，避免子域访问时被跨域限制
    function checkLoginByServer() {
        return fetch(location.origin + '/', {
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'follow',
        }).then((res) => res.text()).then((html) => {
            if (/data-logged-in\s*=\s*["']true["']/i.test(html)) return true;
            if (/data-logged-in\s*=\s*["']false["']/i.test(html)) return false;
            return null;
        }).catch(() => null);
    }

    let loginWatchTimer = null;
    let loginWatchStartedAt = 0;
    let loginWatchMode = '';
    let loginWatchVisibilityHandler = null;
    let pendingLoginConfirmStarted = false;

    function stopLoginWatch() {
        if (loginWatchTimer) {
            clearInterval(loginWatchTimer);
            loginWatchTimer = null;
        }
        if (loginWatchVisibilityHandler) {
            document.removeEventListener('visibilitychange', loginWatchVisibilityHandler);
            loginWatchVisibilityHandler = null;
        }
        loginWatchMode = '';
    }

    function onLoginSuccess(mode) {
        stopLoginWatch();
        if (!hasLoginPending()) {
            log('检测到登录状态，但补签已由其他标签页处理');
            return;
        }
        const lastSign = num(G.get(K.LAST_SIGN, 0));
        clearLoginPending();
        G.set(K.LOGIN_STATE, 'true');
        G.set(K.LAST_TRY, 0);
        if (!needSign(lastSign)) {
            log('登录成功，但签到记录仍然有效，不再补签');
            return;
        }
        log('检测到登录成功，开始自动补签');
        if (mode === 'reload-self') {
            // 当前标签本身就是补签标签：刷新后页面会以登录态重新加载
            location.reload();
            return;
        }
        openLoginFlowTab();
    }

    function startLoginWatch(mode) {
        if (loginWatchTimer && loginWatchMode === mode) return; // 已经在等待，不重复启动
        stopLoginWatch();
        loginWatchMode = mode;
        loginWatchStartedAt = Date.now();
        log('开始等待登录（每 ' + Math.round(CFG.LOGIN_POLL_MS / 1000) + ' 秒检测一次）');

        const poll = () => {
            if (!loginWatchMode) return;
            if (Date.now() - loginWatchStartedAt > CFG.LOGIN_POLL_MAX_MS) {
                stopLoginWatch();
                log('等待登录超时，停止检测');
                return;
            }
            checkLoginByServer().then((logged) => {
                if (!loginWatchMode) return;
                if (logged === true) onLoginSuccess(mode);
            });
        };

        loginWatchTimer = setInterval(poll, CFG.LOGIN_POLL_MS);
        loginWatchVisibilityHandler = () => {
            if (document.visibilityState === 'visible') poll();
        };
        document.addEventListener('visibilitychange', loginWatchVisibilityHandler);
    }

    // 页面加载时确认「之前的未登录待办」是否已完成登录
    function confirmPendingLogin() {
        if (pendingLoginConfirmStarted) return;
        pendingLoginConfirmStarted = true;

        const deadline = Date.now() + 15000;
        const step = () => {
            const logged = isLoggedIn();
            if (logged === true) {
                onLoginSuccess('open-tab');
                return;
            }
            if (logged === false) {
                // 仍未登录：继续等待（提醒已经发过）
                startLoginWatch('open-tab');
                return;
            }
            if (Date.now() >= deadline) {
                startLoginWatch('open-tab');
                return;
            }
            setTimeout(step, 500);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(step, 200), { once: true });
        } else {
            setTimeout(step, 200);
        }
    }

    // ============ 菜单 ============
    function registerMenus() {
        G.menu('查看上次签到时间', () => {
            const last = num(G.get(K.LAST_SIGN, 0));
            const skip = num(G.get(K.LAST_SKIP, 0));
            const logs = G.get(K.LOG, []);
            let status = '暂无记录';
            if (skip > last) {
                const left = Math.max(0, CFG.SKIP_HOURS - (Date.now() - skip) / 3600000);
                status = '上次未登录，选择了「否」→ 跳过（约 ' + left.toFixed(1) + ' 小时后重试）';
            } else if (last) {
                status = '上次已签到';
            }
            alert(
                '上次签到：' + fmtTime(last) + '\n' +
                (last ? '距今 ' + ((Date.now() - last) / 3600000).toFixed(1) + ' 小时' : '（无记录）') + '\n' +
                '上次状态：' + status + '\n\n' +
                '最近日志：\n' + (Array.isArray(logs) ? logs.slice(-10).join('\n') : '无')
            );
        });

        G.menu('立即后台签到', () => {
            G.set(K.LAST_TRY, 0);
            G.set(K.LAST_CHECK, 0);
            G.set(K.LAST_SKIP, 0);
            openSignTab('manual');
        });

        G.menu('清除签到记录', () => {
            if (!confirm('确定清除签到时间与日志？')) return;
            G.set(K.LAST_SIGN, 0);
            G.set(K.LAST_TRY, 0);
            G.set(K.LAST_CHECK, 0);
            G.set(K.LAST_SKIP, 0);
            G.set(K.LOG, []);
            alert('已清除');
        });
    }

    // ============ 打开后台签到标签页 ============
    function openSignTab(from) {
        const url = CFG.SIGN_URL + '#mb_auto=1';
        log('打开后台签到页（来源：' + (from || 'auto') + '）');
        G.openTab(url, { active: false, insert: true, setParent: true });
    }

    // 登录成功后打开的可见补签标签（脚本打开的标签才能被 window.close 关闭）
    function openLoginFlowTab() {
        const url = CFG.SIGN_URL + '#mb_login_flow=1';
        log('打开登录后补签页面');
        G.openTab(url, { active: true, insert: true, setParent: true });
    }

    // ============ 非 MineBBS 页面：启动检查 ============
    function bootCheck() {
        if (window.top !== window.self) return; // 只处理顶层页面
        if (document.visibilityState === 'prerender') return;

        const now = Date.now();
        const lastCheck = num(G.get(K.LAST_CHECK, 0));
        if (now - lastCheck < CFG.CHECK_GAP_MIN * 60000) return; // 会话内去重
        G.set(K.LAST_CHECK, now);

        // 正在等待用户登录：不要反复打开后台签到标签
        if (hasLoginPending()) {
            log('等待用户登录中，跳过启动检查');
            return;
        }

        const lastSign = num(G.get(K.LAST_SIGN, 0));
        const expired = needSign(lastSign, now);

        if (!expired) {
            log(isSkipped(now)
                ? '用户已选择暂不登录，跳过期内不再检查'
                : '签到时间正常（' + fmtTime(lastSign) + '），无需处理');
            return;
        }

        const lastTry = num(G.get(K.LAST_TRY, 0));
        if (now - lastTry < CFG.OPEN_COOLDOWN_MIN * 60000) {
            log('签到时间已过期，但仍在冷却期，跳过（上次尝试 ' + fmtTime(lastTry) + '）');
            return;
        }

        G.set(K.LAST_TRY, now);
        log(lastSign === 0 ? '签到时间未知，启动静默签到' : '签到时间已过期（' + fmtTime(lastSign) + '），启动静默签到');
        openSignTab(lastSign === 0 ? 'unknown' : 'expired');
    }

    // ============ MineBBS 页面：签到执行 ============
    // 登录状态：true 已登录 / false 未登录 / null 未知
    function isLoggedIn() {
        try {
            const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
            if (w.XF && w.XF.config && w.XF.config.userId) return true;
            if (w.MineBBSUserInfo) return true;
        } catch (e) { /* ignore */ }
        try {
            const html = document.documentElement;
            const flag = html && html.getAttribute('data-logged-in');
            if (flag === 'true') return true;
            if (flag === 'false') return false;
        } catch (e) { /* ignore */ }
        // DOM 还没解析完时不要用导航栏做判断，容易误判
        if (document.readyState === 'loading') return null;
        try {
            if (document.querySelector('.p-navgroup-link--user, a[href*="/account/"], .p-account')) return true;
            if (document.querySelector('.p-navgroup-link--login, a[href*="login/"], .p-navgroup--guest')) return false;
        } catch (e) { /* ignore */ }
        return null;
    }

    // 新版签到组件
    function getWidget() {
        try { return document.querySelector('.mjc-signin-status'); } catch (e) { return null; }
    }

    function getSignForm() {
        const w = getWidget();
        try {
            if (w) {
                const f = w.querySelector('form.mjc-signin-form, form[action*="credits/clock"]');
                if (f) return f;
            }
            return document.querySelector('form.mjc-signin-form, form[action*="credits/clock"]');
        } catch (e) { return null; }
    }

    function getSignButton() {
        const f = getSignForm();
        if (!f) return null;
        try {
            // 优先真正的提交按钮，避免误点到表单里的其他按钮
            return f.querySelector('button[type="submit"], input[type="submit"]') || f.querySelector('button');
        } catch (e) { return null; }
    }

    // 旧版签到按钮/链接（保留兜底，以防站点临时切回旧结构）
    function getLegacySignNodes() {
        const out = [];
        const sel = 'form[action*="credits/sign"] button, form[action*="credits/sign"] input[type="submit"], ' +
            'a[href*="credits/sign"], button[data-action*="sign"], .credits-sign-button';
        let nodes = [];
        try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { nodes = []; }
        for (const n of nodes) {
            const t = ((n.innerText || n.textContent || n.value || '') + '').trim();
            if (/签到/.test(t)) out.push({ node: n, text: t });
        }
        return out;
    }

    function getBodyText() {
        return document.body ? (document.body.innerText || document.body.textContent || '') : '';
    }

    // 页面提示里是否出现签到成功
    function detectFlashSuccess() {
        let nodes = [];
        try {
            nodes = Array.from(document.querySelectorAll('.p-flashMessage, .notice-content, .p-notices, .alert'));
        } catch (e) { nodes = []; }
        for (const n of nodes) {
            const t = norm(n.innerText || n.textContent || '');
            if (/签到成功|签到完成|签到已完成|成功签到|今日已签到|已签到/.test(t) && !/尚未签到/.test(t)) return true;
        }
        return false;
    }

    // 判断页面状态：'signed' 已签到 / 'unsigned' 未签到 / 'pending' 提交中 / null 无法判断
    function detectState() {
        const w = getWidget();
        if (w) {
            const text = norm(w.innerText || w.textContent || '');
            const form = getSignForm();
            const btn = getSignButton();
            const btnText = norm(btn ? (btn.innerText || btn.textContent || btn.value || '') : '');

            // 先看明确的文案状态，避免残留的提交标记把「已签到」误判成「提交中」
            if (/已签到|已签|签到完成|签到已完成|签到成功|明天再来|明日再来/.test(text)) return 'signed';
            if (/签到中/.test(text) || /签到中/.test(btnText)) return 'pending';
            if (/尚未签到|未签到|还没签到|没有签到/.test(text)) return 'unsigned';

            // 站点内联脚本提交时会打标记并把按钮改成「签到中…」
            if (form && (form.hasAttribute('data-mjc-clock-sent') || form.hasAttribute('data-mjc-clock-submitted'))) return 'pending';

            if (/已签|明天再来|明日再来/.test(btnText)) return 'signed';
            // 按钮可用且文案是「立即签到」才算未签到；禁用状态先等待，避免误提交
            if (/立即签到/.test(btnText)) return btn && btn.disabled ? 'pending' : 'unsigned';
            if (!form || !btn) return 'signed'; // 表单被移除通常表示今日已签
            return null;
        }

        // ===== 旧站兜底 =====
        const bodyText = getBodyText();
        if (!bodyText) return null;

        if (/今日已签到|今天已签到|今日已签完成|今日已签过|今日签到完成/.test(bodyText)) return 'signed';

        const nodes = getLegacySignNodes();
        if (nodes.some((x) => /已签/.test(x.text))) return 'signed';
        if (nodes.length > 0) return 'unsigned';
        if (document.querySelector('form[action*="credits/sign"], form[action*="sign"]')) return 'unsigned';
        return null;
    }

    function doSign() {
        // 1. 新版：点击「立即签到」，让站点自己的 submit 处理器提交表单
        const form = getSignForm();
        const btn = getSignButton();
        if (btn) {
            const t = norm(btn.innerText || btn.textContent || btn.value || '');
            // 按钮已禁用或已显示「已签到/签到中」时不要绕过站点校验强行提交
            if (btn.disabled || /已签|签到中/.test(t)) return null;
            btn.click();
            return 'click-mjc-button';
        }
        if (form) {
            const submit = form.querySelector('button[type="submit"], input[type="submit"]');
            if (submit && !submit.disabled) {
                submit.click();
                return 'click-mjc-submit';
            }
            try {
                const token = form.querySelector('input[name="_xfToken"]');
                if (!token || !token.value) return null;
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit();
                    return 'requestSubmit-mjc';
                }
                HTMLFormElement.prototype.submit.call(form);
                return 'submit-mjc-form';
            } catch (e) { /* ignore */ }
        }

        // 2. 旧版兜底
        const nodes = getLegacySignNodes().filter((x) => !/已签/.test(x.text));
        if (nodes.length > 0) {
            nodes[0].node.click();
            return 'click-sign-button';
        }
        const legacyForm = document.querySelector('form[action*="credits/sign"], form[action*="sign"]');
        if (legacyForm) {
            const legacyBtn = legacyForm.querySelector('button[type="submit"], input[type="submit"], button');
            if (legacyBtn) {
                legacyBtn.click();
                return 'click-form-button';
            }
            try {
                HTMLFormElement.prototype.submit.call(legacyForm);
                return 'submit-form';
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    // ============ 补签完成：回首页 + 是否关闭询问 ============
    function isPromptSuppressed() {
        const t = num(sessionGet(S.PROMPTED));
        return t > 0 && Date.now() - t < CFG.CLOSE_PROMPT_SUPPRESS_MS;
    }

    function finishInteractive() {
        // 不在首页就先回首页，回到首页后再询问
        if (location.pathname !== '/') {
            location.replace(CFG.SIGN_URL + '#mb_login_flow=1');
            return;
        }
        const show = () => showClosePrompt();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', show, { once: true });
        } else {
            show();
        }
    }

    // 自定义「是/否」弹窗（confirm 的按钮文案是「确定/取消」，不符合要求）
    function showClosePrompt() {
        if (isPromptSuppressed()) return;
        if (document.getElementById('mb-close-prompt')) return;
        if (!document.body) return;

        const font = '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif';

        const overlay = document.createElement('div');
        overlay.id = 'mb-close-prompt';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483646',
            'background:rgba(15,23,42,.55)', 'display:flex',
            'align-items:center', 'justify-content:center',
            'font-family:' + font,
        ].join(';');

        const box = document.createElement('div');
        box.style.cssText = [
            'min-width:300px', 'max-width:360px', 'background:#fff', 'border-radius:12px',
            'padding:24px 22px 18px', 'box-shadow:0 20px 50px rgba(0,0,0,.28)',
            'text-align:center', 'color:#1f2937',
        ].join(';');

        const title = document.createElement('div');
        title.textContent = 'MineBBS 签到完成';
        title.style.cssText = 'font-size:17px;font-weight:600;margin-bottom:10px;';

        const desc = document.createElement('div');
        desc.textContent = '是否关闭此网页？';
        desc.style.cssText = 'font-size:14px;color:#4b5563;margin-bottom:20px;';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:12px;justify-content:center;';

        const btnYes = document.createElement('button');
        btnYes.type = 'button';
        btnYes.textContent = '是';
        btnYes.style.cssText = [
            'flex:1', 'padding:9px 0', 'border:0', 'border-radius:8px',
            'background:#2563eb', 'color:#fff', 'font-size:14px',
            'font-weight:600', 'cursor:pointer',
        ].join(';');

        const btnNo = document.createElement('button');
        btnNo.type = 'button';
        btnNo.textContent = '否';
        btnNo.style.cssText = [
            'flex:1', 'padding:9px 0', 'border:1px solid #d1d5db', 'border-radius:8px',
            'background:#f3f4f6', 'color:#374151', 'font-size:14px',
            'font-weight:600', 'cursor:pointer',
        ].join(';');

        const dismiss = () => {
            sessionSet(S.PROMPTED, String(Date.now()));
            sessionRemove(S.LOGIN_FLOW);
            try { history.replaceState(null, '', '/'); } catch (e) { /* ignore */ }
        };

        btnYes.addEventListener('click', () => {
            dismiss();
            overlay.remove();
            try { window.close(); } catch (e) { /* ignore */ }
            // 脚本打开的标签可以关闭；若被浏览器阻止，给出手动关闭提示
            setTimeout(() => {
                try {
                    if (!document.body) return;
                    const tip = document.createElement('div');
                    tip.textContent = '浏览器未允许自动关闭，请手动关闭此标签页。';
                    tip.style.cssText = [
                        'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
                        'z-index:2147483647', 'background:#111827', 'color:#fff',
                        'padding:10px 16px', 'border-radius:8px', 'font-size:13px',
                        'box-shadow:0 8px 24px rgba(0,0,0,.3)', 'font-family:' + font,
                    ].join(';');
                    document.body.appendChild(tip);
                    setTimeout(() => { try { tip.remove(); } catch (e) { /* ignore */ } }, 4000);
                } catch (e) { /* ignore */ }
            }, 500);
        });

        btnNo.addEventListener('click', () => {
            dismiss();
            overlay.remove();
        });

        row.appendChild(btnYes);
        row.appendChild(btnNo);
        box.appendChild(title);
        box.appendChild(desc);
        box.appendChild(row);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }

    let signFlowStarted = false;

    function runSignFlow() {
        if (signFlowStarted) return;
        signFlowStarted = true;

        const interactive = isLoginFlowTab();
        const auto = isAutoTab() || interactive;

        // 普通页面：只负责判断并打开签到页，不在用户当前页提交
        if (!auto) {
            const now = Date.now();
            const lastSign = num(G.get(K.LAST_SIGN, 0));
            const expired = needSign(lastSign, now);

            // 之前提醒过用户登录：确认登录成功后直接进入补签
            if (hasLoginPending()) {
                if (!expired) {
                    clearLoginPending();
                    log('签到记录已有效，清除登录待办');
                    return;
                }
                confirmPendingLogin();
                return;
            }

            if (!expired) return;

            const logged = isLoggedIn();
            if (logged === false) {
                G.set(K.LOGIN_STATE, 'false');
                markLoginPending();
                warnNotLoggedIn('page');
                startLoginWatch('open-tab');
                return;
            }
            if (logged === true) {
                // 刚从「未登录」变成「已登录」：清掉上次失败留下的冷却，立即补签
                if (G.get(K.LOGIN_STATE, '') === 'false') G.set(K.LAST_TRY, 0);
                G.set(K.LOGIN_STATE, 'true');
            }

            const lastTry = num(G.get(K.LAST_TRY, 0));
            if (now - lastTry < CFG.OPEN_COOLDOWN_MIN * 60000) {
                log('签到时间已过期，但仍在冷却期，跳过（上次尝试 ' + fmtTime(lastTry) + '）');
                return;
            }
            G.set(K.LAST_TRY, now);
            log(lastSign === 0 ? '签到时间未知，启动静默签到' : '签到时间已过期（' + fmtTime(lastSign) + '），启动静默签到');
            openSignTab(lastSign === 0 ? 'unknown' : 'expired');
            return;
        }

        // 后台签到页：执行签到并确认结果
        let settled = false;
        let tries = 0;
        let observer = null;
        let timer = null;

        const stop = (reason) => {
            if (settled) return;
            settled = true;
            if (timer) clearInterval(timer);
            if (observer) observer.disconnect();
            log('签到流程结束：' + reason);
        };

        const closeIfAuto = () => {
            if (!auto || interactive) return; // 交互补签标签保留给用户，由「是否关闭」决定
            sessionRemove(S.AUTO_TAB);
            // 这个标签页是脚本自己悄悄打开的，签完自动关掉
            setTimeout(() => { try { window.close(); } catch (e) { /* ignore */ } }, 1200);
        };

        // 签到成功后的收尾：交互标签回首页并询问，后台标签直接关闭
        const finishAfterSign = () => {
            if (interactive) finishInteractive();
            else closeIfAuto();
        };

        const tick = () => {
            if (settled) return;

            // 明确处于未登录状态就别白折腾，提醒用户登录
            if (isLoggedIn() === false) {
                // 用户已经选择「否」：跳过期内直接收工，不再提醒
                if (isSkipped()) {
                    stop('用户已选择暂不登录，跳过期内不再尝试');
                    closeIfAuto();
                    return;
                }
                G.set(K.LOGIN_STATE, 'false');
                G.set(K.LAST_TRY, Date.now());
                markLoginPending();
                if (interactive) {
                    // 交互标签不关闭：等用户登录成功后自动刷新补签
                    warnNotLoggedIn('page');
                    stop('未登录，等待用户登录');
                    startLoginWatch('reload-self');
                    return;
                }
                const shown = warnNotLoggedIn('auto');
                stop('未登录，等待用户选择');
                // 弹窗里由用户选择「是/否」；冷却期内没有弹窗，直接关闭后台标签
                if (!shown) closeIfAuto();
                return;
            }

            const state = detectState();

            if (state === 'pending') {
                tries++;
                if (tries > 30) {
                    stop('签到提交超时');
                    closeIfAuto();
                }
                return;
            }

            if (state === 'signed') {
                const lastSign = num(G.get(K.LAST_SIGN, 0));
                if (needSign(lastSign)) markSigned('页面显示已签到');
                else log('签到时间仍有效（' + fmtTime(lastSign) + '），无需重复记录');
                stop('已签到');
                finishAfterSign();
                return;
            }

            if (state === 'unsigned') {
                const posted = getPosted();
                // 刚提交过：刷新后页面可能还没更新完，只等结果，绝不重复提交
                if (posted && Date.now() - posted < CFG.POST_GUARD_MS) {
                    tries++;
                    if (tries > 20) {
                        stop('提交后仍未确认签到成功');
                        closeIfAuto();
                    }
                    return;
                }

                if (tries === 0) {
                    const how = doSign();
                    if (!how) {
                        log('未找到签到按钮/链接');
                        stop('找不到签到入口');
                        closeIfAuto();
                        return;
                    }
                    markPosted();
                    log('已触发签到动作：' + how);
                    tries = 1;
                    return;
                }

                // 点击之后：站点可能只弹一个成功提示，按钮文案并不变化
                if (/签到成功|签到完成|签到已完成|成功签到/.test(getBodyText())) {
                    markSigned('出现签到成功提示');
                    stop('已签到（成功提示）');
                    finishAfterSign();
                    return;
                }
                tries++;
                if (tries > 20) { // 20 * 1.5s = 30s 还没变成已签到
                    stop('点击后未检测到签到成功，下次再试');
                    closeIfAuto();
                }
                return;
            }

            // state === null：页面还没加载好 / 当前页没有签到模块
            if (detectFlashSuccess()) {
                markSigned('检测到签到成功提示');
                stop('已签到（提示）');
                finishAfterSign();
                return;
            }
            tries++;
            if (tries > 20) {
                // 兜底：签到组件在首页，不在首页就回首页再试一次（每个标签只回退一次，防循环）
                const homeTried = sessionGet(S.HOME_TRIED) === '1';
                if (location.pathname !== '/' && !homeTried) {
                    log('当前页未发现签到模块，转到首页再试');
                    sessionSet(S.HOME_TRIED, '1');
                    location.replace(CFG.SIGN_URL + (interactive ? '#mb_login_flow=1' : '#mb_auto=1'));
                    return;
                }
                stop('页面未出现签到模块');
                closeIfAuto();
            }
        };

        // DOM 变化很频繁，做 600ms 节流后再检测
        let lastRun = 0;
        observer = new MutationObserver(() => {
            const now = Date.now();
            if (now - lastRun < 600) return;
            lastRun = now;
            tick();
        });
        timer = setInterval(tick, 1500);

        const start = () => {
            try {
                observer.observe(document.documentElement || document, { childList: true, subtree: true });
            } catch (e) { /* ignore */ }
            tick();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }

    // ============ 入口 ============
    try {
        registerMenus();
        if (isMineBBS()) {
            runSignFlow();
        } else {
            bootCheck();
        }
    } catch (e) {
        console.error('[MineBBS签到] 初始化失败', e);
    }
})();