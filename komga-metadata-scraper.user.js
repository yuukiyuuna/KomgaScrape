// ==UserScript==
// @name         Komga Metadata Scraper
// @namespace    https://github.com/yourname/komga-scraper
// @version      1.2.11
// @description  Komga 漫画/书籍元数据抓取脚本：支持 Bangumi 和 Fanza/DMM 手动刮削（FANZA 无结果时自动回退 駿河屋 兜底）；支持系列级 Bangumi 自动刮削（按卷号匹配，自动加锁）
// @author       Hancl
// @match        https://www.suruga-ya.jp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @grant        GM_cookie
// @connect      *
// @connect      api.bgm.tv
// @connect      www.dmm.co.jp
// @connect      doujin-assets.dmm.co.jp
// @connect      www.suruga-ya.jp
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @run-at       document-end
// @sandbox      JavaScript
// ==/UserScript==

/*
 * 关于元数据块里的第二个 @match（https://www.suruga-ya.jp/*）：
 *   · 它是给「桥接标签页」用的（见脚本内模块 0）—— 駿河屋 直连被 Cloudflare 拦下时，
 *     脚本会开一个真实标签页去取搜索页 HTML，再回传给 Komga 页；
 *   · 不要删掉它，否则桥接标签页里没有脚本在跑，回传就无从发生；
 *   · 元数据块里 @match 的取值会一直取到行尾（不留行内注释），改动时请保持一行一个值。
 *
 * ============================================================
 *  版本号约定（给后续修改此脚本的 AI / 开发者看）
 * ============================================================
 *  · 本文件中版本号只有一个真实来源：上方元数据块中的 @version
 *  · 脚本运行时通过 GM_info.script.version 读取该值，
 *    再赋值给 SCRIPT_VERSION 常量（见 getScriptVersion()）
 *  · SCRIPT_VERSION 被用于：
 *      1) defaultConfig.version       —— 写入配置默认值，判断配置是否为旧版本遗留
 *      2) checkConfigVersion()        —— 脚本升级后对旧配置做迁移 / 重置
 *      3) BANGUMI_USER_AGENT          —— 对外 API 请求的 UA 标识
 *      4) 启动 / 初始化日志            —— 控制台版本标识，方便排障
 *  · 禁止在脚本任何位置再出现 '1.x.x' 之类的硬编码版本字符串！
 *    升级版本时只改顶部 @version 一行，其它地方自动同步。
 *  · 勿删除或改写 getScriptVersion() / SCRIPT_VERSION，
 *    否则配置版本迁移逻辑与 UA 都会失去版本来源。
 * ============================================================
 */

(function() {
    'use strict';

    // ============================================================
    // 0. 駿河屋「桥接标签页」模块
    // ============================================================
    // 【为什么需要它】
    // 駿河屋（www.suruga-ya.jp）全站挂在 Cloudflare 后面。若本机出口 IP 被 Cloudflare
    // 判为可疑，任何客户端都会拿到 403 +「Just a moment...」的人机校验页；这是
    // 「托管挑战」（managed challenge），只有真实浏览器导航才过得去。
    // 校验成功后下发的 cf_clearance 又绑定「浏览器 UA + 出口 IP + 请求指纹」，
    // 而 GM_xmlhttpRequest 发出的请求既不是浏览器导航（没有 sec-fetch 导航类请求头、
    // 发起方是扩展上下文、TLS/HTTP2 指纹也不同），所以即使带上该 Cookie 也会被重新挑战
    // —— 这就是「在新标签页里手动过了人机验证，脚本依旧 403」的原因。
    //
    // 【做法】把「你手动开标签页过验证」这套动作自动化：
    //   1) Komga 页直连被拦后，把请求写进 GM 存储（komga_scraper_surugaya_bridge_request）；
    //   2) 用 GM_openInTab 在后台打开目标搜索页 URL；
    //   3) 本文件的同一份脚本会在駿河屋标签页里运行（@match 里有 suruga-ya.jp），
    //      发现「当前地址 == 请求记录里的地址」就等页面就绪，把整页 HTML 写回 GM 存储；
    //   4) Komga 页收到 HTML 后照常解析；若标签页停在人机校验页，桥接页会先回传
    //      challenge 状态，Komga 页据此提示用户切过去点一下「确认」。
    // 注意：该模块必须在脚本最前面执行 —— 駿河屋标签页里要「只做桥接、不做 Komga 业务」。
    const SURUGAYA_BRIDGE_HOST_RE = /(^|\.)suruga-ya\.jp$/i;
    const SURUGAYA_BRIDGE_REQUEST_KEY = 'komga_scraper_surugaya_bridge_request';
    const SURUGAYA_BRIDGE_RESULT_KEY = 'komga_scraper_surugaya_bridge_result';
    const SURUGAYA_BRIDGE_REQUEST_TTL_MS = 120000;  // 请求记录有效期，超过即视为上一次的残留
    const SURUGAYA_BRIDGE_CHILD_MAX_MS = 90000;     // 桥接页最多等多久页面就绪
    const SURUGAYA_BRIDGE_TIMEOUT_MS = 100000;      // Komga 页最多等多久结果（要大于子页上限）
    // Cloudflare 校验页的标题（英文站 / 日文站都覆盖），用来识别「还没过校验」
    const SURUGAYA_BRIDGE_CHALLENGE_RE = /Just a moment|Attention Required|しばらくお待ちください|確認中/;

    /** 桥接页判定「搜索页已经就绪」：命中列表容器或「該当件数」文案 */
    function isSurugayaSearchPageReady() {
        if (document.querySelector('div.item, #search_result, h3.product-name')) return true;
        const body = document.body;
        return !!(body && /該当件数/.test(body.innerText || body.textContent || ''));
    }

    /** 比较键：忽略 URL 哈希，只比 origin + path + query（判断当前页是否就是桥接目标） */
    function surugayaBridgeUrlKey(url) {
        try {
            const parsed = new URL(url, location.href);
            return parsed.origin + parsed.pathname + parsed.search;
        } catch (e) {
            return String(url || '');
        }
    }

    /** 桥接功能依赖的 GM API 是否齐全（缺任意一个就退回纯直连） */
    function surugayaBridgeSupported() {
        return typeof GM_openInTab === 'function'
            && typeof GM_setValue === 'function'
            && typeof GM_getValue === 'function'
            && typeof GM_addValueChangeListener === 'function';
    }

    /** 桥接页侧：把结果（或 challenge 提示）写回 GM 存储 */
    function postSurugayaBridgeResult(result) {
        try {
            GM_setValue(SURUGAYA_BRIDGE_RESULT_KEY, Object.assign({ ts: Date.now() }, result));
        } catch (e) { }
    }

    /**
     * 桥接页侧：轮询等待页面就绪，然后回传整页 HTML 并关掉自己。
     * 页面停在 Cloudflare 校验页时先回传一次 challenge 状态（让 Komga 页提示用户去点确认），
     * 校验完成后本页会重新加载、脚本重新进来，再正常回传 HTML。
     */
    function watchSurugayaBridgePage(request) {
        const startedAt = Date.now();
        let challengeNotified = false;
        const timer = setInterval(function() {
            let result = null;
            if (isSurugayaSearchPageReady()) {
                result = {
                    id: request.id,
                    ok: true,
                    html: document.documentElement.outerHTML,
                    url: location.href
                };
            } else if (SURUGAYA_BRIDGE_CHALLENGE_RE.test(document.title || '')) {
                if (challengeNotified) return;
                challengeNotified = true;
                postSurugayaBridgeResult({ id: request.id, phase: 'challenge' });
                return;
            } else if (Date.now() - startedAt > SURUGAYA_BRIDGE_CHILD_MAX_MS) {
                result = { id: request.id, ok: false, reason: 'timeout' };
            }
            if (!result) return;
            clearInterval(timer);
            postSurugayaBridgeResult(result);
            // 结果已回传：关掉自己（脚本打开的标签页一般允许 window.close()；
            // 关不掉也没关系，Komga 页那边还会调用 GM_openInTab 返回对象的 close()）
            try { window.close(); } catch (e) { }
        }, 1000);
    }

    /** 桥接页侧入口：当前页确实是 Komga 页要求桥接的那个地址时才启动 */
    function runSurugayaBridgeTab() {
        let request = null;
        try {
            request = GM_getValue(SURUGAYA_BRIDGE_REQUEST_KEY, null);
        } catch (e) {
            return;
        }
        if (!request || !request.id || !request.url) return;
        if (Date.now() - (Number(request.ts) || 0) > SURUGAYA_BRIDGE_REQUEST_TTL_MS) return;
        if (surugayaBridgeUrlKey(request.url) !== surugayaBridgeUrlKey(location.href)) return;
        watchSurugayaBridgePage(request);
    }

    // 駿河屋 标签页：只做桥接，不再执行下面的 Komga 业务逻辑
    if (SURUGAYA_BRIDGE_HOST_RE.test(location.hostname)) {
        runSurugayaBridgeTab();
        return;
    }

    /**
     * Komga 页侧：开一个真实标签页去取 url 的 HTML，成功返回 HTML 字符串，失败返回 ''。
     * onChallenge 会在「桥接页停在人机校验页」时被调用一次，用于提示用户去点确认。
     */
    function fetchSurugayaViaBridge(url, debug, onChallenge) {
        return new Promise(function(resolve) {
            if (!surugayaBridgeSupported()) {
                if (debug) console.warn('[KomgaScraper] [Suruga-ya] 桥接不可用：缺少 GM_openInTab / GM_addValueChangeListener 权限');
                resolve('');
                return;
            }

            const id = 'sg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            let settled = false;
            let listenerId = null;
            let tab = null;

            const finish = function(html) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (listenerId !== null && typeof GM_removeValueChangeListener === 'function') {
                    try { GM_removeValueChangeListener(listenerId); } catch (e) { }
                }
                try { GM_setValue(SURUGAYA_BRIDGE_REQUEST_KEY, null); } catch (e) { }
                if (tab && typeof tab.close === 'function') {
                    try { tab.close(); } catch (e) { }
                }
                resolve(html || '');
            };

            const timer = setTimeout(function() {
                if (debug) console.warn('[KomgaScraper] [Suruga-ya] 桥接标签页超时，未取到结果');
                finish('');
            }, SURUGAYA_BRIDGE_TIMEOUT_MS);

            listenerId = GM_addValueChangeListener(SURUGAYA_BRIDGE_RESULT_KEY, function(name, oldValue, newValue) {
                if (!newValue || newValue.id !== id) return;
                if (newValue.phase === 'challenge') {
                    if (debug) console.warn('[KomgaScraper] [Suruga-ya] 桥接标签页停在 Cloudflare 人机校验页，等待用户完成');
                    if (typeof onChallenge === 'function') {
                        try { onChallenge(); } catch (e) { }
                    }
                    return;
                }
                if (newValue.ok && newValue.html) {
                    if (debug) console.log('[KomgaScraper] [Suruga-ya] 桥接标签页取回 HTML，长度:', newValue.html.length);
                    finish(newValue.html);
                } else {
                    if (debug) console.warn('[KomgaScraper] [Suruga-ya] 桥接标签页失败:', newValue.reason || 'unknown');
                    finish('');
                }
            });

            // 必须先写请求记录再开标签页：桥接页加载时就要能读到它
            try {
                GM_setValue(SURUGAYA_BRIDGE_REQUEST_KEY, { id: id, url: url, ts: Date.now() });
            } catch (e) {
                console.error('[KomgaScraper] [Suruga-ya] 写入桥接请求失败:', e);
                finish('');
                return;
            }

            try {
                tab = GM_openInTab(url, { active: false, insert: true });
                if (debug) console.log('[KomgaScraper] [Suruga-ya] 已打开桥接标签页:', url);
            } catch (e) {
                console.error('[KomgaScraper] [Suruga-ya] 打开桥接标签页失败:', e);
                finish('');
            }
        });
    }

    // ============================================================
    // 1. 配置管理模块
    // ============================================================

    const CONFIG_KEY = 'komga_scraper_config';

    /**
     * 从元数据块的 @version 中解析版本号（单一来源，避免多处硬编码不同步）
     * 注意：Tampermonkey/Violentmonkey 通过 GM_info.script.version 提供 @version 值；
     * 若环境不支持，则回退为 '0.0.0'，以便于本地测试。
     *
     * 【给 AI Agent 的修改约定】
     * · 版本号只在脚本顶部 // @version 处维护，这里不要再写死任何版本字符串。
     * · SCRIPT_VERSION 用于 defaultConfig.version / checkConfigVersion()
     *   / BANGUMI_USER_AGENT / 启动日志，切勿删除或改写此函数与常量。
     * · 若要升级版本，仅修改顶部 // @version 一行的值即可，其它地方自动同步。
     */
    function getScriptVersion() {
        try {
            if (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) {
                return String(GM_info.script.version);
            }
        } catch (_) { }
        return '0.0.0';
    }
    const SCRIPT_VERSION = getScriptVersion();

    const defaultConfig = {
        version: SCRIPT_VERSION,
        defaultSource: 'bangumi',
        language: 'zh',
        komga: {
            apiKey: ''
        },
        scrapers: {
            bangumi: {
                token: ''
            }
        },
        rateLimit: {
            enabled: true,
            minInterval: 2000
        },
        write: {
            autoLockFields: []
        },
        autoRefresh: true,
        debug: false,
        // 搜索结果相关（必须是顶层键：getConfig() 用 Object.assign 浅合并配置，
        // 嵌套对象的默认值无法自动补齐，放在子对象里会导致旧配置读不到默认值）
        searchFetchLimit: 50,      // 单次拉取条数（旧版降级接口硬上限 25）
        searchVisibleCount: 10,    // 弹窗默认显示条数，0 表示显示全部
        // 駿河屋 直连被 Cloudflare 拦下时，是否自动改用「桥接标签页」重取（见文件顶部模块 0）
        surugayaBridgeTab: true
    };

    function getConfig() {
        try {
            const saved = GM_getValue(CONFIG_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                return Object.assign({}, defaultConfig, parsed);
            }
            return Object.assign({}, defaultConfig);
        } catch (e) {
            console.error('[KomgaScraper] Failed to read config:', e);
            return Object.assign({}, defaultConfig);
        }
    }

    function saveConfig(config) {
        try {
            GM_setValue(CONFIG_KEY, JSON.stringify(config));
            if (config.debug) console.log('[KomgaScraper] Config saved');
        } catch (e) {
            console.error('[KomgaScraper] Failed to save config:', e);
        }
    }

    // 【给 AI Agent 看】此处使用 SCRIPT_VERSION 判断配置版本是否过时；
    // 请勿把具体版本号写死在这里，也请勿改写 getScriptVersion()。
    function checkConfigVersion() {
        const config = getConfig();
        if (!config.version || config.version !== SCRIPT_VERSION) {
            if (config.debug) console.log('[KomgaScraper] Config version upgraded:', config.version || 'none', '->', SCRIPT_VERSION);
            config.version = SCRIPT_VERSION;
            saveConfig(config);
        }
    }

    // 搜索结果相关的配置读取（配置可能被手改成任意值，这里统一收敛到安全范围）
    const SEARCH_FETCH_LIMIT_MIN = 10;
    const SEARCH_FETCH_LIMIT_MAX = 100;
    const SEARCH_VISIBLE_COUNT_MAX = 100;
    // 旧版降级接口（/search/subject/{keyword}）文档规定 max_results 最多 25
    const BANGUMI_LEGACY_MAX_RESULTS = 25;

    function getSearchFetchLimit() {
        const value = parseInt(getConfig().searchFetchLimit, 10);
        if (isNaN(value)) return defaultConfig.searchFetchLimit;
        return Math.min(SEARCH_FETCH_LIMIT_MAX, Math.max(SEARCH_FETCH_LIMIT_MIN, value));
    }

    // 0（或非法值回退后的默认值）表示「显示全部」
    function getSearchVisibleCount() {
        const value = parseInt(getConfig().searchVisibleCount, 10);
        if (isNaN(value)) return defaultConfig.searchVisibleCount;
        return Math.min(SEARCH_VISIBLE_COUNT_MAX, Math.max(0, value));
    }

    // ============================================================
    // 2. 页面检测模块
    // ============================================================

    function getCurrentPageType() {
        const path = window.location.pathname;
        if (path.startsWith('/series/')) {
            return 'series';
        }
        if (path.startsWith('/books/') || path.startsWith('/book/')) {
            return 'book';
        }
        return 'other';
    }

    function extractIdFromUrl() {
        const path = window.location.pathname;
        const seriesMatch = path.match(/\/series\/([^\/]+)/);
        if (seriesMatch) return seriesMatch[1];

        const bookMatch = path.match(/\/book[s]?\/([^\/]+)/);
        if (bookMatch) return bookMatch[1];

        return null;
    }

    function cleanSearchKeyword(title) {
        if (!title) return '';

        let keyword = title.trim();

        keyword = keyword.replace(/\([^)]*\)/g, '');
        keyword = keyword.replace(/【[^】]*】/g, '');
        keyword = keyword.replace(/\[[^\]]*\]/g, '');
        keyword = keyword.replace(/第\s*\d+\s*卷/g, '');
        keyword = keyword.replace(/Vol\.?\s*\d+/gi, '');
        keyword = keyword.replace(/Volume\s*\d+/gi, '');
        keyword = keyword.replace(/[!@#$%^&*()_+=\[\]{};':"\\|,<>\/?]/g, ' ');
        keyword = keyword.replace(/\s+/g, ' ').trim();

        return keyword;
    }

    // ============================================================
    // 3. 频率限制模块
    // ============================================================

    class RateLimiter {
        constructor() {
            this.lastRequestTime = 0;
        }

        async acquire() {
            const config = getConfig();
            if (!config.rateLimit.enabled) return;

            const now = Date.now();
            const timeSinceLast = now - this.lastRequestTime;
            const minInterval = config.rateLimit.minInterval;

            if (timeSinceLast < minInterval) {
                const waitTime = minInterval - timeSinceLast;
                if (config.debug) console.log('[KomgaScraper] Rate limiting - waiting', waitTime, 'ms');
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            this.lastRequestTime = Date.now();
        }
    }

    const rateLimiter = new RateLimiter();

    // ============================================================
    // 4. 请求模块
    // ============================================================

    /**
     * 判断是否为 Komga 本地请求（需要携带认证 Cookie）
     * Komga API 调用始终使用 window.location.origin，外部请求则指向其他域名
     */
    function isLocalRequest(url) {
        return url.startsWith(window.location.origin);
    }

    /**
     * 核心请求函数 - 智能判断请求类型，正确处理 Cookie
     */
    function doGMRequest(options) {
        return new Promise((resolve, reject) => {
            const config = getConfig();
            const debug = config.debug;
            const url = options.url;
            const isLocal = isLocalRequest(url);

            if (debug) {
                console.log('[KomgaScraper] doGMRequest:', options.method || 'GET', url);
                console.log('[KomgaScraper] Is local request:', isLocal);
            }

            // 构造完整的 headers
            const headers = Object.assign({}, options.headers || {});

            // 确保有基本的 headers
            // （駿河屋 用 useBrowserUserAgent 跳过这里的写死 UA：Cloudflare 的 cf_clearance 与 UA 绑定，
            //   换了 UA 会让浏览器里已通过的校验 Cookie 失效）
            if (!headers['User-Agent'] && !options.useBrowserUserAgent) {
                headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
            }
            if (!headers['Accept']) {
                headers['Accept'] = 'application/json, text/plain, */*';
            }
            if (!headers['Accept-Language']) {
                headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
            }

            // 关键修复:
            // 1. 本地请求（Komga）不使用 anonymous: true - 需要携带登录 Cookie
            // 2. 外部请求（如 Bangumi）使用 anonymous: true - 避免发送不必要的 Cookie
            // 3. options.anonymous 可显式覆盖：駿河屋 需要浏览器 Cookie 罐里的 Cloudflare 校验 Cookie 时会传 false
            const useAnonymous = typeof options.anonymous === 'boolean' ? options.anonymous : !isLocal;

            const gmOptions = {
                method: options.method || 'GET',
                url: url,
                headers: headers,
                timeout: options.timeout || 30000,
                anonymous: useAnonymous,  // 智能设置：本地请求 false，外部请求 true
                fetch: true,
                onload: function(response) {
                    if (debug) {
                        console.log('[KomgaScraper] Response status:', response.status, 
                                   'responseText length:', response.responseText ? response.responseText.length : 0);
                    }

                    try {
                        let data = null;
                        if (response.responseText && response.responseText.trim().length > 0) {
                            try {
                                data = JSON.parse(response.responseText);
                            } catch (parseError) {
                                if (debug) console.log('[KomgaScraper] JSON parse failed, using raw text');
                            }
                        }
                        resolve({
                            status: response.status,
                            statusText: response.statusText,
                            data: data,
                            raw: response.responseText
                        });
                    } catch (e) {
                        console.error('[KomgaScraper] Response processing error:', e);
                        resolve({
                            status: response.status,
                            statusText: response.statusText,
                            data: null,
                            raw: response.responseText
                        });
                    }
                },
                onerror: function(error) {
                    console.error('[KomgaScraper] GM_xmlhttpRequest onerror:', error);
                    reject(error);
                },
                ontimeout: function() {
                    console.error('[KomgaScraper] GM_xmlhttpRequest timeout');
                    reject(new Error('Request timeout'));
                }
            };

            if (options.data) {
                gmOptions.data = typeof options.data === 'string' ? options.data : JSON.stringify(options.data);
                if (!gmOptions.headers['Content-Type']) {
                    gmOptions.headers['Content-Type'] = 'application/json';
                }
            }

            if (debug) {
                console.log('[KomgaScraper] GM_xmlhttpRequest options:', JSON.stringify(gmOptions, null, 2));
            }

            try {
                GM_xmlhttpRequest(gmOptions);
            } catch (e) {
                console.error('[KomgaScraper] Failed to invoke GM_xmlhttpRequest:', e);
                reject(e);
            }
        });
    }

    async function fetchWithRateLimit(options) {
        await rateLimiter.acquire();
        return doGMRequest(options);
    }

    // ============================================================
    // 5. Komga API 模块
    // ============================================================
    // Komga API 文档： https://komga.org/docs/api/rest/
    // 本脚本从 window.location.origin 动态取基础地址；
    // 常用接口（便于 agent 直接调用测试，{origin} 替换为你的 Komga 站点）：
    //   - 系列详情：  GET {origin}/api/v1/series/{seriesId}
    //   - 书籍详情：  GET {origin}/api/v1/books/{bookId}
    //   - 系列下书籍：GET {origin}/api/v1/series/{seriesId}/books?size=500
    //   - 系列元数据：PATCH {origin}/api/v1/series/{seriesId}/metadata
    //   - 书籍元数据：PATCH {origin}/api/v1/books/{bookId}/metadata

    function getKomgaBaseUrl() {
        return window.location.origin;
    }

    async function fetchSeriesData(seriesId) {
        try {
            const response = await doGMRequest({
                method: 'GET',
                url: getKomgaBaseUrl() + '/api/v1/series/' + seriesId,
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (response.status === 200 && response.data) {
                return response.data;
            }
            return null;
        } catch (e) {
            console.error('[KomgaScraper] Failed to fetch series data:', e);
            return null;
        }
    }

    async function fetchBookData(bookId) {
        try {
            const response = await doGMRequest({
                method: 'GET',
                url: getKomgaBaseUrl() + '/api/v1/books/' + bookId,
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (response.status === 200 && response.data) {
                return response.data;
            }
            return null;
        } catch (e) {
            console.error('[KomgaScraper] Failed to fetch book data:', e);
            return null;
        }
    }

    async function fetchBooksOfSeries(seriesId) {
        try {
            const response = await doGMRequest({
                method: 'GET',
                url: getKomgaBaseUrl() + '/api/v1/series/' + encodeURIComponent(seriesId) + '/books?size=500',
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (response.status === 200 && response.data) {
                const payload = response.data;
                const content = Array.isArray(payload) ? payload : (payload && payload.content ? payload.content : []);
                return content.map(function(book) {
                    const metadata = book.metadata || {};
                    const metadataNumber = metadata.number != null ? String(metadata.number).trim() : '';
                    const fileVolume = extractVolumeNumberFromFileName(book.name || fileNameFromUrl(book.url));

                    // 卷号以文件名解析结果为准：Komga 扫描时会把系列内的书按文件名排序后
                    // 按位置重编号（见 SeriesLifecycle.sortBooks），因此 BookDto.number 与
                    // metadata.number 往往只是位置序号（1,2,5,7,10 会被改成 1..5）。
                    // 只有文件名解析不出卷号时，才退回使用 Komga 已有的 metadata.number。
                    let volumeNumber = null;
                    let volumeSource = null;
                    if (fileVolume != null) {
                        volumeNumber = fileVolume;
                        volumeSource = 'filename';
                    } else if (metadataNumber) {
                        volumeNumber = metadataNumber;
                        volumeSource = 'metadata';
                    }

                    return {
                        id: book.id,
                        name: book.name,
                        url: book.url,
                        metadata: metadata,
                        metadataNumber: metadataNumber,
                        numberLocked: metadata.numberLock === true,
                        volumeNumber: volumeNumber,
                        volumeSource: volumeSource
                    };
                });
            }
            return [];
        } catch (e) {
            console.error('[KomgaScraper] Failed to fetch books of series:', e);
            return [];
        }
    }

    // ------------------------------------------------------------
    // 系列文件夹名 -> 语言识别（仅用于系列级 language 元数据的自动填充）
    // ------------------------------------------------------------

    /**
     * 取 Komga 系列对应的文件夹名。
     * 优先使用 SeriesDto.url（库内相对路径，最后一段即系列文件夹名）；
     * url 为空（例如受限用户被隐去）时回退到 series.name。
     */
    function getSeriesFolderName(seriesData) {
        if (!seriesData) return '';

        let segment = '';
        const rawUrl = String(seriesData.url || '').trim();
        if (rawUrl) {
            const trimmed = rawUrl.replace(/[\\/]+$/, '');
            const parts = trimmed.split(/[\\/]/);
            segment = parts.length > 0 ? parts[parts.length - 1] : '';
            if (segment) {
                try {
                    segment = decodeURIComponent(segment);
                } catch (_) { /* 非百分号编码，保持原样 */ }
            }
        }

        if (!segment) segment = String(seriesData.name || '');
        return segment.trim();
    }

    /**
     * 按文件夹名的字符属性推断语言代码（BCP47 主语言子标签）。
     * 判定直接基于完整文件夹名，不做括号剔除（日文名常把标签写在括号里）。
     * 规则（从高到低）：
     *   含假名（平假名 / 片假名 / 半角片假名）-> ja
     *     例：「[全巻セット] ONE PIECE」虽然以英文为主，但含片假名，仍判为 ja
     *   含谚文（韩文）                        -> ko
     *   含汉字（且无假名、无谚文）            -> zh
     *   整名不含以上文字、且只由英文字母构成  -> en（"全字符为英文" 才算纯英文）
     *   其余（含西里尔 / 希腊 / 阿拉伯等其它文字）-> ''（调用方据此不写入 language）
     * 已知限制：纯汉字的日文名（如「東京喰種」）无法与中文名区分，会判为 zh。
     */
    function detectLanguageFromFolderName(name) {
        const raw = String(name || '').trim();
        if (!raw) return '';

        const otherLetterRe = /\p{L}/u;
        let kana = 0;
        let hangul = 0;
        let han = 0;
        let latin = 0;
        let otherLetter = 0;

        const chars = Array.from(raw);
        for (let i = 0; i < chars.length; i++) {
            const cp = chars[i].codePointAt(0);
            if ((cp >= 0x3040 && cp <= 0x309F) ||   // 平假名
                (cp >= 0x30A0 && cp <= 0x30FF) ||   // 片假名
                (cp >= 0x31F0 && cp <= 0x31FF) ||   // 片假名扩展
                (cp >= 0xFF66 && cp <= 0xFF9D)) {   // 半角片假名
                kana++;
            } else if ((cp >= 0x1100 && cp <= 0x11FF) ||   // 谚文字母
                       (cp >= 0x3130 && cp <= 0x318F) ||   // 谚文兼容字母
                       (cp >= 0xA960 && cp <= 0xA97F) ||   // 谚文字母扩展-A
                       (cp >= 0xAC00 && cp <= 0xD7AF)) {   // 谚文音节
                hangul++;
            } else if ((cp >= 0x3400 && cp <= 0x4DBF) ||   // 汉字扩展-A
                       (cp >= 0x4E00 && cp <= 0x9FFF) ||   // 汉字基本区
                       (cp >= 0xF900 && cp <= 0xFAFF) ||   // 兼容汉字
                       (cp >= 0x20000 && cp <= 0x2FFFF)) { // 汉字扩展-B 及以上
                han++;
            } else if ((cp >= 0x41 && cp <= 0x5A) ||        // A-Z
                       (cp >= 0x61 && cp <= 0x7A) ||        // a-z
                       (cp >= 0x00C0 && cp <= 0x00D6) ||    // 拉丁字母（带变音符号）
                       (cp >= 0x00D8 && cp <= 0x00F6) ||
                       (cp >= 0x00F8 && cp <= 0x024F)) {
                latin++;
            } else if (otherLetterRe.test(chars[i])) {
                otherLetter++;
            }
        }

        if (kana > 0) return 'ja';
        if (hangul > 0) return 'ko';
        if (han > 0) return 'zh';
        // 只有整名不含其它文字、且全部由英文字母构成时才判为纯英文
        if (latin > 0 && otherLetter === 0) return 'en';
        return '';
    }

    async function updateSeriesMetadata(seriesId, metadata) {
        try {
            const response = await doGMRequest({
                method: 'PATCH',
                url: getKomgaBaseUrl() + '/api/v1/series/' + seriesId + '/metadata',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                data: metadata
            });

            if (response.status === 200 || response.status === 204) {
                return true;
            }
            console.error('[KomgaScraper] updateSeriesMetadata failed - status:', response.status, 'response:', response.raw || response.text || response.data);
            return false;
        } catch (e) {
            console.error('[KomgaScraper] Failed to update series metadata:', e);
            return false;
        }
    }

    async function updateBookMetadata(bookId, metadata) {
        try {
            const response = await doGMRequest({
                method: 'PATCH',
                url: getKomgaBaseUrl() + '/api/v1/books/' + bookId + '/metadata',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                data: metadata
            });

            if (response.status === 200 || response.status === 204) {
                return true;
            }
            console.error('[KomgaScraper] updateBookMetadata failed - status:', response.status, 'response:', response.raw || response.text || response.data);
            return false;
        } catch (e) {
            console.error('[KomgaScraper] Failed to update book metadata:', e);
            return false;
        }
    }

    // ============================================================
    // 6. 数据映射模块 (Bangumi -> Komga)
    // ============================================================

    // [STATUS-DETECT-BEGIN]
    // 说明：以下 getInfoboxValue / detectBangumiStatus 会被临时校验脚本按此标记抽取，
    // 便于直接拿真实 Bangumi 数据跑判定用例；改动这两个函数时请保留标记。
    function getInfoboxValue(val) {
        if (typeof val === 'string') return val;
        if (Array.isArray(val) && val.length > 0) {
            const first = val[0];
            if (first && typeof first === 'object' && 'v' in first) return String(first.v);
            return String(first);
        }
        if (val && typeof val === 'object' && 'v' in val) return String(val.v);
        return '';
    }

    /**
     * 判定 Bangumi 条目的连载状态，返回 'ENDED' | 'ONGOING' | null。
     *
     * 为什么不能按日期猜：漫画 series 条目的 date / airDate 是「第 1 卷发售日」，
     * 例如 subject/511859（实际连载中）date=2025-02-07 早于今天，早期版本据此判成已完结。
     * 实测（v0 接口与网页 infobox 一致）：已完结条目必有「结束 / 连载结束 / 播放结束」等字段，
     * 连载中条目只有「开始 / 连载开始 / 放送开始」，所以改为按 infobox 字段判定。
     *
     * 判定优先级：
     *   1. 显式状态字段：key 含「状态 / 狀態」，或 key 恰为「连载 / 連載 / 连载中 / 連載中」，
     *      再按值里的关键字判定（"已完结" 等优先于 "连载中" 等）
     *   2. 结束字段：key 含「结束 / 結束 / 終了 / 完结 / 完結」（结束、连载结束、播放结束…）
     *      且值非空 → ENDED
     *   3. 开始字段：key 含「开始 / 開始」（开始、连载开始、放送开始…）且值非空 → ONGOING
     *   4. 都不满足 → null（调用方不写入状态，保留 Komga 现值）
     *
     * 注意两点：
     *   · 不再像早期版本那样只要 key 含「连载」（如「连载杂志」）就去扫值里的关键字；
     *   · 「开始」必须等整张 infobox 扫完才能定论 —— 已完结条目通常是「开始」在前、「结束」在后
     *     （subject/354229 就是这个顺序），提前返回会把已完结误判成连载中。
     */
    function detectBangumiStatus(infobox) {
        if (!infobox || !Array.isArray(infobox)) return null;

        const ENDED_KEYWORDS = ['已完结', '完结', '完結', '終了', '结束', '結束'];
        const ONGOING_KEYWORDS = ['连载中', '連載中', '放送中', '进行', '進行'];
        const END_KEYS = ['结束', '結束', '終了', '完结', '完結'];
        const START_KEYS = ['开始', '開始'];

        const containsAny = function(text, keywords) {
            if (!text) return false;
            for (let i = 0; i < keywords.length; i++) {
                if (text.indexOf(keywords[i]) !== -1) return true;
            }
            return false;
        };

        let hasStartField = false;

        for (let i = 0; i < infobox.length; i++) {
            const item = infobox[i];
            if (!item) continue;
            const key = String(item.key || '').trim();
            if (!key) continue;
            const val = String(getInfoboxValue(item.value) || '').trim();

            // 1) 显式状态字段（如「连载状态: 已完结」）
            const isStatusKey = key.indexOf('状态') !== -1 || key.indexOf('狀態') !== -1 ||
                key === '连载' || key === '連載' || key === '连载中' || key === '連載中';
            if (isStatusKey) {
                if (containsAny(val, ENDED_KEYWORDS)) return 'ENDED';
                if (containsAny(val, ONGOING_KEYWORDS)) return 'ONGOING';
            }

            // 2) 结束字段：只要存在且非空，即可判定完结
            if (val && containsAny(key, END_KEYS)) return 'ENDED';

            // 3) 开始字段：先记录，扫完整张 infobox 再定论
            if (val && containsAny(key, START_KEYS)) hasStartField = true;
        }

        if (hasStartField) return 'ONGOING';
        return null;
    }
    // [STATUS-DETECT-END]

    function looksLikeDate(val) {
        if (!val) return false;
        const s = String(val).trim();
        if (/^\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}/.test(s)) return true;
        if (/^\d{4}[-\/.]\d{1,2}/.test(s)) return true;
        if (/\d{4}年\d{1,2}月\d{0,2}/.test(s)) return true;
        if (/^\d{4}$/.test(s)) return true;
        return false;
    }

    function cleanUrl(url) {
        if (!url) return '';
        let s = String(url).trim();
        s = s.replace(/^[\s`'"]+|[\s`'"]+$/g, '');
        s = s.replace(/^<|>$/g, '');
        return s.trim();
    }

    // Bangumi 相关图片可能是 http:// 或 // 开头（Komga 一般是 https 页面），统一成 https
    function toHttpsUrl(url) {
        const s = String(url == null ? '' : url).trim();
        if (!s) return '';
        if (s.indexOf('//') === 0) return 'https:' + s;
        if (/^http:\/\//i.test(s)) return 'https://' + s.substring('http://'.length);
        return s;
    }

    function convertIsbn10ToIsbn13(isbn10) {
        if (!isbn10 || isbn10.length !== 10) return '';
        const prefix = '978' + isbn10.substring(0, 9);
        let sum = 0;
        for (let i = 0; i < prefix.length; i++) {
            const digit = parseInt(prefix.charAt(i), 10);
            if (isNaN(digit)) return '';
            sum += (i % 2 === 0) ? digit : digit * 3;
        }
        const check = (10 - (sum % 10)) % 10;
        return prefix + check;
    }

    function normalizeIsbn(rawIsbn) {
        if (!rawIsbn) return '';
        const digits = String(rawIsbn).replace(/[^0-9Xx]/g, '').toUpperCase();
        if (digits.length === 13) {
            return digits;
        }
        if (digits.length === 10) {
            return convertIsbn10ToIsbn13(digits);
        }
        return '';
    }

    function mergeTags(newTags, currentTags) {
        const seen = {};
        const result = [];
        const addTag = function(t) {
            const s = String(t || '').trim();
            if (!s) return;
            if (seen[s]) return;
            seen[s] = true;
            result.push(s);
        };
        if (Array.isArray(currentTags)) {
            currentTags.forEach(addTag);
        } else if (currentTags && typeof currentTags === 'string') {
            currentTags.split(/[,，]/).forEach(addTag);
        }
        if (Array.isArray(newTags)) {
            newTags.forEach(addTag);
        } else if (newTags && typeof newTags === 'string') {
            newTags.split(/[,，]/).forEach(addTag);
        }
        return result;
    }

    // Bangumi 来源链接统一使用的小写标签（写回 Komga 的 metadata.links[].label）
    const BANGUMI_LINK_LABEL = 'bangumi';
    // 命中该模式的链接（bgm.tv/subject/{id}，含 www./api. 子域）标签一律归一化
    const BANGUMI_SUBJECT_URL_PATTERN = /bgm\.tv\/subject\//i;

    function mergeLinks(newLinks, currentLinks) {
        const byUrl = {};
        const result = [];
        const addLink = function(link) {
            if (!link) return;
            const url = cleanUrl(link.url);
            if (!url) return;
            let label = String(link.label || '').trim();
            // 历史数据里可能是 'Bangumi' 或空标签，这里统一成 'bangumi'，避免新旧写法并存
            if (BANGUMI_SUBJECT_URL_PATTERN.test(url)) {
                label = BANGUMI_LINK_LABEL;
            }
            if (!byUrl[url]) {
                const entry = { label: label, url: url };
                byUrl[url] = entry;
                result.push(entry);
            } else if (label && !byUrl[url].label) {
                byUrl[url].label = label;
            }
        };
        if (Array.isArray(currentLinks)) {
            currentLinks.forEach(addLink);
        }
        if (Array.isArray(newLinks)) {
            newLinks.forEach(addLink);
        }
        return result;
    }

    function isArrayField(key) {
        return key === 'tags' || key === 'links' || key === 'authors';
    }

    function extractFromInfobox(infobox, keyPatterns, excludePatterns, validator) {
        if (!infobox || !Array.isArray(infobox)) return '';
        const excl = excludePatterns || [];
        for (let i = 0; i < infobox.length; i++) {
            const item = infobox[i];
            const key = String(item.key || '');
            let matched = false;
            for (let j = 0; j < keyPatterns.length; j++) {
                if (key.indexOf(keyPatterns[j]) !== -1) {
                    matched = true;
                    break;
                }
            }
            if (!matched) continue;
            let excluded = false;
            for (let k = 0; k < excl.length; k++) {
                if (key.indexOf(excl[k]) !== -1) {
                    excluded = true;
                    break;
                }
            }
            if (excluded) continue;
            const val = getInfoboxValue(item.value);
            if (validator && !validator(val)) continue;
            if (val && val.trim()) return val;
        }
        return '';
    }

    function extractAllAuthorsFromInfobox(infobox) {
        if (!infobox || !Array.isArray(infobox)) return [];

        const keyRoles = {
            '作者': 'writer',
            '原作': 'writer',
            '作画': 'artist'
        };

        const result = [];
        const seen = {};

        for (let i = 0; i < infobox.length; i++) {
            const item = infobox[i];
            const key = String(item.key || '');
            const role = keyRoles[key];
            if (!role) continue;

            const rawVal = item.value;
            const names = [];
            if (typeof rawVal === 'string') {
                names.push(rawVal);
            } else if (Array.isArray(rawVal)) {
                for (let vi = 0; vi < rawVal.length; vi++) {
                    if (typeof rawVal[vi] === 'string') {
                        names.push(rawVal[vi]);
                    } else if (rawVal[vi] && typeof rawVal[vi] === 'object' && 'v' in rawVal[vi]) {
                        names.push(String(rawVal[vi].v));
                    }
                }
            } else if (rawVal && typeof rawVal === 'object' && 'v' in rawVal) {
                names.push(String(rawVal.v));
            }

            for (let ni = 0; ni < names.length; ni++) {
                const name = names[ni].replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
                if (name && !seen[name]) {
                    seen[name] = true;
                    result.push({ name: name, role: role });
                }
            }
        }

        return result;
    }

    // 从 infobox 中提取「册数」（系列总卷数），解析为正整数
    // 匹配逻辑：
    //   - 直接匹配 key 等于或包含「册数」的条目（如 {"key": "册数", "value": "8"}）
    //   - value 可能是字符串 "8"、"8卷"、"3卷既刊"，只取首次出现的正整数
    //   - value 也可能是对象数组（如 [{k: "册数", v: "3卷既刊"}]），同样取里面的 k/v
    // 如果找不到有效的正整数，返回 null（避免误写入未完结的系列）
    function extractTotalBookCountFromInfobox(infobox) {
        if (!infobox || !Array.isArray(infobox)) return null;

        const parsePositiveInt = function(s) {
            if (!s) return null;
            const m = String(s).match(/\d+/);
            if (!m) return null;
            const n = parseInt(m[0], 10);
            return n > 0 ? n : null;
        };

        for (let i = 0; i < infobox.length; i++) {
            const item = infobox[i];
            const key = String(item.key || '');
            if (key.indexOf('册数') === -1 && key.indexOf('册') === -1) continue;

            // 跳过版本区分（"版本:xxx" 中的册数是该版本独立的册数，通常不是原版总卷数）
            // 由于顶层 infobox 的 key 本身就是「册数」，所以这里直接取即可

            let value = item.value;
            if (typeof value === 'string') {
                const n = parsePositiveInt(value);
                if (n) return n;
            } else if (Array.isArray(value)) {
                // 数组形式，遍历其中的 {k, v} 对象
                for (let vi = 0; vi < value.length; vi++) {
                    const sub = value[vi];
                    if (!sub) continue;
                    if (typeof sub === 'string') {
                        const n = parsePositiveInt(sub);
                        if (n) return n;
                    } else if (sub && typeof sub === 'object') {
                        const subK = String(sub.k || '');
                        if (subK.indexOf('册数') !== -1 || subK.indexOf('册') !== -1) {
                            const n = parsePositiveInt(sub.v);
                            if (n) return n;
                        }
                    }
                }
            } else if (value && typeof value === 'object' && 'v' in value) {
                const n = parsePositiveInt(value.v);
                if (n) return n;
            }
        }
        return null;
    }

    function mapBangumiToSeries(bangumiData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        const isZh = String(metadata.language || '').toLowerCase() === 'zh';
        const preferredTitle = isZh ? bangumiData.title : bangumiData.originalTitle;
        const fallbackTitle = isZh ? bangumiData.originalTitle : bangumiData.title;
        newMetadata.title = preferredTitle || fallbackTitle || metadata.title;

        newMetadata.summary = bangumiData.summary || metadata.summary;

        // 状态只认 Bangumi infobox 的「开始 / 结束」字段判定结果（详见 detectBangumiStatus）。
        // 不要退回“按发售日/放送日与今天比较”的猜测：漫画 series 的 date 是第 1 卷发售日，
        // 连载中的作品会被误判成已完结（subject/511859 即为此 bug）。
        // bangumiData.status 为空（Bangumi 没有等价信息）时保持 Komga 现值不动。
        newMetadata.status = bangumiData.status || metadata.status;

        // 如果 infobox 中存在「册数」，写入 Komga 的 totalBookCount 字段
        // 未完结的作品通常没有此字段，函数会返回 null，此时不写入
        const totalBookCount = extractTotalBookCountFromInfobox(bangumiData.infobox);
        if (totalBookCount) {
            newMetadata.totalBookCount = totalBookCount;
        }

        // 出版社（仅系列级字段：Komga 的书籍元数据 API 不支持 publisher）
        const publisher = String(bangumiData.publisher || '').trim();
        if (publisher) {
            newMetadata.publisher = publisher;
        }

        if (bangumiData.links && bangumiData.links.length > 0) {
            newMetadata.links = bangumiData.links;
        }

        // 只有当系列名有两个或两个以上时才写入 alternateTitles（别名）字段
        // 格式：[{label: "中文", title: "..."}, {label: "日文", title: "..."}]
        // 只有一个或一个都没有时，不写入 Komga
        const titleZh = (bangumiData.nameCn || '').trim();
        const titleJp = (bangumiData.name || '').trim();
        const altTitles = [];
        if (titleZh) altTitles.push({ label: '中文', title: titleZh });
        if (titleJp) altTitles.push({ label: '日文', title: titleJp });
        if (altTitles.length >= 2) {
            newMetadata.alternateTitles = altTitles;
        }

        return newMetadata;
    }

    function mapBangumiToBook(bangumiData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        const isZh = String(metadata.language || '').toLowerCase() === 'zh';
        const preferredTitle = isZh ? bangumiData.title : bangumiData.originalTitle;
        const fallbackTitle = isZh ? bangumiData.originalTitle : bangumiData.title;
        newMetadata.title = preferredTitle || fallbackTitle || metadata.title;

        newMetadata.summary = bangumiData.summary || metadata.summary;
        if (!newMetadata.summary) delete newMetadata.summary;

        newMetadata.releaseDate = bangumiData.airDate || metadata.releaseDate;

        const normalizedIsbn = normalizeIsbn(bangumiData.isbn);
        if (normalizedIsbn) newMetadata.isbn = normalizedIsbn;
        if (bangumiData.authors && bangumiData.authors.length > 0) {
            newMetadata.authors = bangumiData.authors;
        } else if (bangumiData.author) {
            newMetadata.authors = [{ name: bangumiData.author, role: 'writer' }];
        }
        if (bangumiData.links && bangumiData.links.length > 0) {
            newMetadata.links = bangumiData.links;
        }

        return newMetadata;
    }

    // ============================================================
    // 7. Bangumi 刮削源
    // ============================================================

    // Bangumi API 文档： https://bangumi.github.io/api/
    // OpenAPI spec（可直接下载核对参数）： https://bangumi.github.io/api/dist.json
    // 常用接口（便于 agent 直接调用测试）：
    //   - 搜索条目：   POST https://api.bgm.tv/v0/search/subjects?limit=10
    //                  body: {"keyword":"xxx","sort":"match","filter":{"type":[1]}}
    //                  文档要点：sort 默认 'match'（另有 heat/rank/score），按匹配度排序最相关；
    //                  filter.nsfw 是 boolean：true=只返回 R18、false=只返回非 R18、缺省/null=返回全部，
    //                  因此脚本不传该字段 —— 传 true 会把普通条目过滤掉，是“搜不到结果”的常见原因；
    //                  filter.type: 1=书籍 2=动画 3=音乐 4=游戏 6=三次元。
    //   - 系列关系：   GET  https://api.bgm.tv/v0/subjects/{subjectId}/subjects
    //                  返回 SubjectRelation[]（id/type/name/name_cn/relation），
    //                  脚本只保留 type===1 的书籍条目，并让 relation==='单行本' 的排在前面。
    //   - 章节详情：   GET  https://api.bgm.tv/v0/subjects/{subjectId}
    // 降级链（v0 接口不可用时启用；实测 v0 未缓存请求可能返回 502，而以下接口正常）：
    //   - 搜索：  GET https://api.bgm.tv/search/subject/{keyword}?type=1&responseGroup=small&max_results=10
    //   - 详情：  GET https://bgm.tv/subject/{id} （HTML，infobox 最全）
    //             GET https://api.bgm.tv/subject/{id}?responseGroup=large （旧版 JSON，无 infobox）
    //   - 系列：  GET https://bgm.tv/subject/{id}/offprints （HTML 单行本列表）
    const BANGUMI_API_BASE = 'https://api.bgm.tv';
    // 旧版接口与 v0 同域，但属于不同代 API，可用性互相独立
    const BANGUMI_LEGACY_API_BASE = 'https://api.bgm.tv';
    // 网页兜底（HTML 解析）
    const BANGUMI_WEB_BASE = 'https://bgm.tv';
    // 【给 AI Agent 看】UA 中版本号必须从 SCRIPT_VERSION 读取；
    // 不要在此处写死 '1.x.x' 之类的具体版本号。
    const BANGUMI_USER_AGENT = 'KomgaMetadataScraper/' + SCRIPT_VERSION + ' (https://github.com/chenglin-han/KomgaScrape)';

    // ---------------- 7.1 Bangumi 通用工具 ----------------

    // v0 接口短期熔断：任一 v0 请求返回 status 0（网络错误/被拦截）或 >= 500 时，
    // 在该 TTL 内直接走降级链，避免自动刮削时每本书都先白等一次失败请求。
    const BANGUMI_V0_DOWN_TTL_MS = 5 * 60 * 1000;
    const BANGUMI_V0_SKIPPED = 'skipped';
    let bangumiV0DownUntil = 0;

    function isBangumiV0Down() {
        return Date.now() < bangumiV0DownUntil;
    }

    function markBangumiV0Down(status) {
        if (status === 0 || status >= 500) {
            bangumiV0DownUntil = Date.now() + BANGUMI_V0_DOWN_TTL_MS;
        }
    }

    function describeBangumiFailure(status) {
        if (status === BANGUMI_V0_SKIPPED) return '此前请求失败，5 分钟内暂不重试';
        if (status === 0 || status == null) return '网络错误或请求超时';
        return 'HTTP ' + status;
    }

    // 把失败/异常统一收敛成 { ok, status, ... }，便于降级链判断
    async function safeBangumiRequest(fn) {
        try {
            return await fn();
        } catch (e) {
            console.warn('[KomgaScraper] [Bangumi] request threw:', e && e.message ? e.message : e);
            return { ok: false, status: 0 };
        }
    }

    // 统一构造搜索结果对象（v0 与旧版接口共用，保证 UI 与后续流程一致）
    function createBangumiSearchResult(raw) {
        const itemId = String(raw.id || '').replace(/[^0-9a-zA-Z]/g, '');
        const name = String(raw.name || '').trim();
        const nameCn = String(raw.nameCn || '').trim();
        const airDate = String(raw.airDate || '').trim();
        const bangumiUrl = cleanUrl(BANGUMI_WEB_BASE + '/subject/' + itemId);
        return {
            id: itemId,
            title: nameCn || name,
            originalTitle: name,
            name: name,
            nameCn: nameCn,
            summary: raw.summary || '',
            image: toHttpsUrl(raw.image),
            largeImage: toHttpsUrl(raw.largeImage),
            rating: raw.rating != null && raw.rating !== '' ? raw.rating : null,
            // 搜索结果里没有 infobox，无法判定连载状态，一律留空：
            // 详情接口全部失败时脚本会退回用搜索结果，留空可避免把猜测当成事实写进 Komga
            status: '',
            airDate: airDate,
            url: bangumiUrl,
            date: String(raw.date || airDate || ''),
            // isSeries: Bangumi v0 搜索响应自带字段「是否为书籍系列的主条目」。
            //   true  = 系列主条目（系列刮削的目标）
            //   false = 单行本 / 分卷条目（书籍刮削的目标）
            //   null  = 未知（旧版降级接口不返回该字段），UI 在任何过滤档位下都照常展示
            isSeries: typeof raw.isSeries === 'boolean' ? raw.isSeries : null,
            links: [{ label: BANGUMI_LINK_LABEL, url: bangumiUrl }]
        };
    }

    /**
     * v0 搜索（POST /v0/search/subjects），严格按官方文档构造请求体：
     *   - sort 默认 'match'（另有 heat/rank/score），按匹配度排序，最相关的条目排在最前
     *   - filter.type: [1] 表示只搜索「书籍」条目
     *   - 不传 filter.nsfw：文档中 true=只返回 R18、false=只返回非 R18，
     *     缺省/null 才是“返回全部”；传 true 会把普通条目全部过滤掉
     *   - limit/offset 为分页参数（limit 无文档上限，由配置 searchFetchLimit 控制）
     * options: { offset, limit }
     * 返回 { ok, status, results, total }（total 为接口给出的命中总数，缺失为 null）
     */
    async function searchBangumiViaV0(keyword, options) {
        const config = getConfig();
        const debug = config.debug;
        const opts = options || {};
        const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
        const limit = Math.max(1, parseInt(opts.limit, 10) || getSearchFetchLimit());

        const searchUrl = BANGUMI_API_BASE + '/v0/search/subjects?limit=' + limit + '&offset=' + offset;
        const requestBody = JSON.stringify({
            keyword: keyword,
            sort: 'match',
            filter: {
                type: [1]
            }
        });

        if (debug) console.log('[KomgaScraper] [Bangumi] v0 search URL:', searchUrl);
        if (debug) console.log('[KomgaScraper] [Bangumi] v0 search body:', requestBody);

        const response = await fetchWithRateLimit({
            method: 'POST',
            url: searchUrl,
            headers: {
                'User-Agent': BANGUMI_USER_AGENT,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            },
            data: requestBody
        });

        if (debug) console.log('[KomgaScraper] [Bangumi] v0 search status:', response.status, 'hasData:', !!response.data);

        if (response.status !== 200 || !response.data || !Array.isArray(response.data.data)) {
            markBangumiV0Down(response.status);
            console.warn('[KomgaScraper] [Bangumi] v0 search unavailable, status:', response.status,
                response.raw ? String(response.raw).replace(/\s+/g, ' ').substring(0, 120) : '');
            return { ok: false, status: response.status, results: [], total: null };
        }

        const results = response.data.data.map(function(item) {
            return createBangumiSearchResult({
                id: item.id,
                name: item.name,
                nameCn: item.name_cn,
                summary: item.summary,
                image: item.images && item.images.common,
                largeImage: item.images && item.images.large,
                rating: item.rating && item.rating.score,
                date: item.date || '',
                airDate: item.date || item.air_date || '',
                isSeries: item.series
            });
        });

        const total = typeof response.data.total === 'number' ? response.data.total : null;

        if (debug) {
            results.forEach(function(r, index) {
                console.log('[KomgaScraper] [Bangumi] v0 result ' + (index + 1) + ':', r.title, r.originalTitle,
                    '(isSeries=' + String(r.isSeries) + ')');
            });
            console.log('[KomgaScraper] [Bangumi] v0 returned', results.length, 'results, total:', total,
                '(offset ' + offset + ', limit ' + limit + ')');
        }
        return { ok: true, status: 200, results: results, total: total };
    }

    /**
     * 旧版搜索（GET /search/subject/{keyword}?type=1&responseGroup=small&max_results=25）
     * 用于 v0 接口不可用/无结果时降级；返回结构较简单（无 infobox、无评分）。
     * 旧接口不会返回 series 标记（结果 isSeries 恒为 null），也没有命中总数。
     * options: { offset, limit }（limit 会被收敛到文档规定的上限 25）
     * 返回 { ok, status, results, total }
     */
    async function searchBangumiViaLegacy(keyword, options) {
        const config = getConfig();
        const debug = config.debug;
        const opts = options || {};
        const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
        const requested = Math.max(1, parseInt(opts.limit, 10) || getSearchFetchLimit());
        const maxResults = Math.min(requested, BANGUMI_LEGACY_MAX_RESULTS);

        const url = BANGUMI_LEGACY_API_BASE + '/search/subject/' + encodeURIComponent(keyword) +
            '?type=1&responseGroup=small&max_results=' + maxResults +
            (offset > 0 ? '&start=' + offset : '');

        if (debug) console.log('[KomgaScraper] [Bangumi] legacy search URL:', url);

        const response = await fetchWithRateLimit({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': BANGUMI_USER_AGENT,
                'Accept': 'application/json',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            }
        });

        if (debug) console.log('[KomgaScraper] [Bangumi] legacy search status:', response.status, 'hasData:', !!response.data);

        if (response.status !== 200 || !response.data || !Array.isArray(response.data.list)) {
            console.warn('[KomgaScraper] [Bangumi] legacy search failed, status:', response.status);
            return { ok: false, status: response.status, results: [], total: null };
        }

        const results = response.data.list.map(function(item) {
            return createBangumiSearchResult({
                id: item.id,
                name: item.name,
                nameCn: item.name_cn,
                summary: item.summary,
                image: item.images && (item.images.common || item.images.medium),
                largeImage: item.images && item.images.large,
                rating: null,
                date: item.air_date || '',
                airDate: item.air_date || ''
            });
        });

        if (debug) console.log('[KomgaScraper] [Bangumi] legacy total', results.length, 'results found');
        return { ok: true, status: 200, results: results, total: null };
    }

    /**
     * Bangumi 搜索入口：v0 优先，失败或无结果时降级到旧版接口。
     * 两条链路都失败时抛出带 bangumiApiError 标记的错误，
     * 让 UI 能区分“接口不可用”和“真的没有结果”。
     * options: { offset, limit }（「加载更多」时由 UI 传入 offset）
     * 返回 { results, total, via, notice }：
     *   via    —— 'v0' | 'legacy'，UI 仅对 v0 结果提供「加载更多」
     *   total  —— 命中总数（旧接口未知为 null）
     *   notice —— 降级提示文案（无降级时为空串）
     */
    async function scrapeFromBangumi(keyword, options) {
        const config = getConfig();
        const debug = config.debug;

        let notice = '';

        let v0Failure = null;
        let v0Failed = false;
        if (isBangumiV0Down()) {
            v0Failure = BANGUMI_V0_SKIPPED;
            v0Failed = true;
            if (debug) console.log('[KomgaScraper] [Bangumi] v0 marked unavailable, skipping to legacy API');
        } else {
            const v0 = await safeBangumiRequest(function() { return searchBangumiViaV0(keyword, options); });
            if (v0.ok && v0.results.length > 0) {
                return { results: v0.results, total: v0.total, via: 'v0', notice: '' };
            }
            if (v0.ok) {
                if (debug) console.log('[KomgaScraper] [Bangumi] v0 returned no results, trying legacy API');
            } else {
                v0Failure = v0.status;
                v0Failed = true;
            }
        }

        // 降级链只在首屏有意义：加载更多时不重复降级（分页由 v0 承担）
        const legacyOpts = options || {};
        if (legacyOpts.offset > 0) {
            if (debug) console.log('[KomgaScraper] [Bangumi] legacy fallback skipped for paginated request');
            return { results: [], total: null, via: 'legacy', notice: '' };
        }

        const legacy = await safeBangumiRequest(function() { return searchBangumiViaLegacy(keyword, options); });
        if (legacy.ok) {
            if (legacy.results.length > 0) {
                // v0 报错时说明降级原因；v0 只是没匹配到时用更中性的措辞
                notice = v0Failed
                    ? 'Bangumi v0 接口当前不可用，已使用旧版接口搜索'
                    : 'Bangumi v0 接口无匹配结果，已使用旧版接口搜索';
                if (debug) console.log('[KomgaScraper] [Bangumi] legacy search succeeded:', legacy.results.length);
                return { results: legacy.results, total: null, via: 'legacy', notice: notice };
            }
            if (debug) console.log('[KomgaScraper] [Bangumi] legacy search returned no results');
            return { results: [], total: null, via: 'legacy', notice: '' };
        }

        const detail = 'v0 接口：' + describeBangumiFailure(v0Failure) + '；旧版接口：' + describeBangumiFailure(legacy.status);
        const error = new Error(detail);
        error.bangumiApiError = true;
        error.v0Status = v0Failure;
        error.legacyStatus = legacy.status;
        console.error('[KomgaScraper] [Bangumi] Search failed:', detail);
        throw error;
    }

    // ---------------- 7.2 Bangumi 详情（v0 -> 网页 HTML -> 旧版 JSON） ----------------

    /**
     * 把不同来源（v0 / HTML / 旧版）的数据统一映射为脚本内部的 detail 结构。
     * raw: { id, name, nameCn, summary, image, largeImage, rating, date, airDate, infobox }
     */
    function buildBangumiDetail(raw) {
        const subjectItemId = String(raw.id || '').replace(/[^0-9a-zA-Z]/g, '');
        const infobox = Array.isArray(raw.infobox) ? raw.infobox : [];

        const isbnRaw = extractFromInfobox(infobox, ['ISBN', 'isbn', 'Isbn']);
        let isbn = '';
        if (isbnRaw) {
            isbn = normalizeIsbn(isbnRaw);
        }

        const dateExcludePatterns = ['商', '社', '者', '国家', '地区', '语言', '定价', '价格'];
        let publishDate = extractFromInfobox(
            infobox,
            ['发售日期', '发售日', '发售', '发行日期', '发行日', '出版日期', '出版年', '出版'],
            dateExcludePatterns,
            looksLikeDate
        );
        if (!publishDate && raw.date && looksLikeDate(raw.date)) publishDate = raw.date;
        if (!publishDate && raw.airDate && looksLikeDate(raw.airDate)) publishDate = raw.airDate;

        const pagesRaw = extractFromInfobox(
            infobox,
            ['页数', 'page', 'Page', 'p.', 'P.'],
            ['出版社', '作者', '原作', '脚本']
        );
        let pages = '';
        if (pagesRaw) {
            const pageMatch = pagesRaw.match(/\d+/);
            if (pageMatch) pages = pageMatch[0];
        }

        const authors = extractAllAuthorsFromInfobox(infobox);

        // 出版社：Bangumi infobox 中 key 含「出版社」「出版者」「出版商」的条目
        // （排除「连载杂志」等无关条目；value 可能是数组/对象，由 getInfoboxValue 归一化取首个值）
        const publisher = extractFromInfobox(infobox, ['出版社', '出版者', '出版商'], ['杂志', '连载']);

        // 连载状态只按 infobox 的「开始 / 结束」字段判定。
        // 不能用 date（漫画 series 的 date 是第 1 卷发售日）与今天比较 —— 连载中的
        // 作品（如 subject/511859）会因此被误判成已完结，这是本次修复的根因。
        const subjectDate = String(raw.date || raw.airDate || '');
        const bangumiLinkUrl = cleanUrl(BANGUMI_WEB_BASE + '/subject/' + subjectItemId);
        const rawName = String(raw.name || '').trim();
        const rawNameCn = String(raw.nameCn || '').trim();

        return {
            id: subjectItemId,
            title: rawNameCn || rawName,
            originalTitle: rawName,
            name: rawName,
            nameCn: rawNameCn,
            summary: raw.summary || '',
            image: toHttpsUrl(raw.image),
            largeImage: toHttpsUrl(raw.largeImage),
            rating: raw.rating != null && raw.rating !== '' ? raw.rating : null,
            status: detectBangumiStatus(infobox) || '',
            airDate: publishDate || subjectDate || '',
            url: bangumiLinkUrl,
            infobox: infobox,
            isbn: isbn,
            pages: pages,
            authors: authors,
            publisher: publisher,
            links: [{ label: BANGUMI_LINK_LABEL, url: bangumiLinkUrl }]
        };
    }

    async function fetchBangumiDetailFromV0(subjectIdParam) {
        const config = getConfig();
        const debug = config.debug;

        const detailUrl = BANGUMI_API_BASE + '/v0/subjects/' + encodeURIComponent(subjectIdParam);
        if (debug) console.log('[KomgaScraper] [Bangumi] v0 detail URL:', detailUrl);

        const response = await fetchWithRateLimit({
            method: 'GET',
            url: detailUrl,
            headers: {
                'User-Agent': BANGUMI_USER_AGENT,
                'Accept': 'application/json',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            }
        });

        if (debug) console.log('[KomgaScraper] [Bangumi] v0 detail status:', response.status);

        if (response.status !== 200 || !response.data) {
            markBangumiV0Down(response.status);
            console.warn('[KomgaScraper] [Bangumi] v0 detail unavailable, status:', response.status);
            return { ok: false, status: response.status };
        }

        const data = response.data;
        const infobox = data.infobox || [];
        if (debug) console.log('[KomgaScraper] [Bangumi] v0 infobox:', JSON.stringify(infobox));

        const subjectDate = data.date || data.air_date || '';
        return {
            ok: true,
            status: 200,
            data: buildBangumiDetail({
                id: data.id != null ? data.id : subjectIdParam,
                name: data.name,
                nameCn: data.name_cn,
                summary: data.summary,
                image: data.images && data.images.common,
                largeImage: data.images && data.images.large,
                rating: data.rating && data.rating.score,
                date: subjectDate,
                airDate: subjectDate,
                infobox: infobox
            })
        };
    }

    /**
     * 从 bgm.tv 条目页解析 infobox 等字段（网页可用性通常优于 v0 接口）。
     * 关键结构缺失时返回 null，由调用方继续降级。
     */
    function parseBangumiSubjectHtml(html, subjectIdParam) {
        const doc = parseHtmlToDoc(html);
        if (!doc) return null;

        const infobox = [];
        const infoboxList = doc.querySelector('#infobox');
        if (infoboxList) {
            const items = infoboxList.children;
            for (let i = 0; i < items.length; i++) {
                const li = items[i];
                if (!li || String(li.tagName || '').toUpperCase() !== 'LI') continue;
                const tip = li.querySelector('span.tip');
                if (!tip) continue;
                const key = String(tip.textContent || '').replace(/[:：]\s*$/, '').trim();
                if (!key) continue;

                // 多值字段（如「别名」）在 li 内以嵌套 ul>li 的形式给出
                const nested = li.querySelectorAll('ul li');
                let value;
                if (nested.length > 0) {
                    value = [];
                    for (let n = 0; n < nested.length; n++) {
                        const text = String(nested[n].textContent || '').trim();
                        if (text) value.push({ v: text });
                    }
                } else {
                    value = String(li.textContent || '').replace(String(tip.textContent || ''), '').trim();
                }
                infobox.push({ key: key, value: value });
            }
        }

        const nameEl = doc.querySelector('h1.nameSingle a') || doc.querySelector('h1.nameSingle');
        const name = nameEl ? String(nameEl.textContent || '').trim() : '';
        if (!name && infobox.length === 0) return null;

        let nameCn = '';
        for (let i = 0; i < infobox.length; i++) {
            if (infobox[i].key === '中文名') {
                nameCn = String(getInfoboxValue(infobox[i].value) || '').trim();
                break;
            }
        }

        const summaryEl = doc.querySelector('#subject_summary');
        const summary = summaryEl ? String(summaryEl.textContent || '').trim() : '';

        const coverImg = doc.querySelector('.infobox .cover img') || doc.querySelector('img.cover');
        const coverLink = doc.querySelector('.infobox a.thickbox.cover') || doc.querySelector('a.thickbox.cover');
        const image = coverImg ? toHttpsUrl(coverImg.getAttribute('src')) : '';
        const largeImage = (coverLink ? toHttpsUrl(coverLink.getAttribute('href')) : '') || image;

        let rating = null;
        const ratingEl = doc.querySelector('#bangumiRating');
        if (ratingEl) {
            const ratingText = String(ratingEl.getAttribute('title') || ratingEl.textContent || '').trim();
            const ratingMatch = ratingText.match(/\d+(\.\d+)?/);
            if (ratingMatch) rating = parseFloat(ratingMatch[0]);
        }

        const infoboxDate = extractFromInfobox(
            infobox,
            ['发售日期', '发售日', '发售', '发行日期', '发行日', '出版日期', '出版年', '出版'],
            ['商', '社', '者', '国家', '地区', '语言', '定价', '价格'],
            looksLikeDate
        );

        return buildBangumiDetail({
            id: subjectIdParam,
            name: name,
            nameCn: nameCn,
            summary: summary,
            image: image,
            largeImage: largeImage,
            rating: rating,
            date: infoboxDate || '',
            airDate: infoboxDate || '',
            infobox: infobox
        });
    }

    async function fetchBangumiDetailFromWeb(subjectIdParam) {
        const config = getConfig();
        const debug = config.debug;

        const url = BANGUMI_WEB_BASE + '/subject/' + encodeURIComponent(subjectIdParam);
        if (debug) console.log('[KomgaScraper] [Bangumi] web detail URL:', url);

        const response = await fetchWithRateLimit({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': BANGUMI_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            }
        });

        if (debug) console.log('[KomgaScraper] [Bangumi] web detail status:', response.status);

        if (response.status !== 200 || !response.raw) {
            return { ok: false, status: response.status };
        }

        const detail = parseBangumiSubjectHtml(response.raw, subjectIdParam);
        if (!detail) {
            console.warn('[KomgaScraper] [Bangumi] failed to parse subject page:', subjectIdParam);
            return { ok: false, status: response.status };
        }
        return { ok: true, status: 200, data: detail };
    }

    async function fetchBangumiDetailFromLegacy(subjectIdParam) {
        const config = getConfig();
        const debug = config.debug;

        const url = BANGUMI_LEGACY_API_BASE + '/subject/' + encodeURIComponent(subjectIdParam) + '?responseGroup=large';
        if (debug) console.log('[KomgaScraper] [Bangumi] legacy detail URL:', url);

        const response = await fetchWithRateLimit({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': BANGUMI_USER_AGENT,
                'Accept': 'application/json',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            }
        });

        if (debug) console.log('[KomgaScraper] [Bangumi] legacy detail status:', response.status);

        if (response.status !== 200 || !response.data) {
            console.warn('[KomgaScraper] [Bangumi] legacy detail unavailable, status:', response.status);
            return { ok: false, status: response.status };
        }

        const data = response.data;
        return {
            ok: true,
            status: 200,
            data: buildBangumiDetail({
                id: data.id != null ? data.id : subjectIdParam,
                name: data.name,
                nameCn: data.name_cn,
                summary: data.summary,
                image: data.images && data.images.common,
                largeImage: data.images && data.images.large,
                rating: data.rating && data.rating.score,
                date: data.air_date || '',
                airDate: data.air_date || '',
                infobox: []
            })
        };
    }

    /**
     * 详情入口：v0 -> 网页 HTML（infobox 最全）-> 旧版 JSON。
     * 三条链路都失败时返回 null（调用方会退回使用搜索结果）。
     */
    async function fetchSubjectDetail(subjectIdParam) {
        const config = getConfig();
        const debug = config.debug;

        const failures = [];

        if (isBangumiV0Down()) {
            failures.push('v0 接口：' + describeBangumiFailure(BANGUMI_V0_SKIPPED));
        } else {
            const v0 = await safeBangumiRequest(function() { return fetchBangumiDetailFromV0(subjectIdParam); });
            if (v0.ok) return v0.data;
            failures.push('v0 接口：' + describeBangumiFailure(v0.status));
        }

        const web = await safeBangumiRequest(function() { return fetchBangumiDetailFromWeb(subjectIdParam); });
        if (web.ok) {
            if (debug) console.log('[KomgaScraper] [Bangumi] detail from bgm.tv page:', subjectIdParam);
            return web.data;
        }
        failures.push('网页：' + describeBangumiFailure(web.status));

        const legacy = await safeBangumiRequest(function() { return fetchBangumiDetailFromLegacy(subjectIdParam); });
        if (legacy.ok) return legacy.data;
        failures.push('旧版接口：' + describeBangumiFailure(legacy.status));

        console.error('[KomgaScraper] [Bangumi] Failed to fetch subject detail:', subjectIdParam, failures.join('；'));
        return null;
    }

    // ---------------- 7.3 Bangumi 系列关系（v0 -> 网页 offprints） ----------------

    // 官方文档：SubjectRelation.type 为条目类型（1=书籍 2=动画 3=音乐 4=游戏 6=三次元）。
    // 系列关系里会混入动画、广播剧、相同世界观等条目（如「魔女の旅々19 ドラマ」），
    // 它们的标题里也可能带卷号，必须过滤掉，否则会与真正的单行本抢同一个卷号。
    function isBangumiBookRelation(item) {
        return Number(item && item.type) === 1;
    }

    function mapBangumiRelation(item) {
        return {
            id: String(item.id || '').replace(/[^0-9a-zA-Z]/g, ''),
            name: item.name || '',
            nameCn: item.name_cn || '',
            date: item.date || '',
            relation: item.relation || '',
            volumeNumber: null
        };
    }

    async function fetchBangumiRelationsV0(seriesSubjectId) {
        const config = getConfig();
        const debug = config.debug;

        const url = BANGUMI_API_BASE + '/v0/subjects/' + encodeURIComponent(seriesSubjectId) + '/subjects';
        if (debug) console.log('[KomgaScraper] [Bangumi] v0 relations URL:', url);

        const response = await fetchWithRateLimit({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': BANGUMI_USER_AGENT,
                'Accept': 'application/json'
            }
        });

        if (response.status !== 200 || !response.data) {
            markBangumiV0Down(response.status);
            console.warn('[KomgaScraper] [Bangumi] v0 relations unavailable:', seriesSubjectId, 'status:', response.status);
            return { ok: false, status: response.status, items: [] };
        }

        const list = Array.isArray(response.data) ? response.data : (response.data && Array.isArray(response.data.data) ? response.data.data : []);
        if (debug) console.log('[KomgaScraper] [Bangumi] v0 returned', list.length, 'relations');

        // 只保留书籍条目，并让「单行本」排在前面（卷号匹配按顺序取第一条，见 matchBooksByNumber）
        const books = list.filter(isBangumiBookRelation).sort(function(a, b) {
            const ra = (a && a.relation) === '单行本' ? 0 : 1;
            const rb = (b && b.relation) === '单行本' ? 0 : 1;
            return ra - rb;
        }).map(mapBangumiRelation);

        if (debug) console.log('[KomgaScraper] [Bangumi] book relations after type filter:', books.length);
        return { ok: true, status: 200, items: books };
    }

    async function fetchBangumiRelationsFromWeb(seriesSubjectId) {
        const config = getConfig();
        const debug = config.debug;

        const url = BANGUMI_WEB_BASE + '/subject/' + encodeURIComponent(seriesSubjectId) + '/offprints';
        if (debug) console.log('[KomgaScraper] [Bangumi] web offprints URL:', url);

        const response = await fetchWithRateLimit({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': BANGUMI_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            }
        });

        if (debug) console.log('[KomgaScraper] [Bangumi] web offprints status:', response.status);

        if (response.status !== 200 || !response.raw) {
            return { ok: false, status: response.status, items: [] };
        }

        const doc = parseHtmlToDoc(response.raw);
        if (!doc) return { ok: false, status: response.status, items: [] };

        const nodes = doc.querySelectorAll('#browserItemList li[id^="item_"]');
        const items = [];
        for (let i = 0; i < nodes.length; i++) {
            const li = nodes[i];
            const id = String(li.getAttribute('id') || '').replace(/^item_/, '');
            const link = li.querySelector('a.l') || li.querySelector('h3 a');
            if (!id || !link) continue;
            const name = String(link.textContent || '').trim();
            if (!name) continue;
            const infoEl = li.querySelector('p.info.tip');
            const info = infoEl ? String(infoEl.textContent || '').trim() : '';
            items.push({
                id: id,
                name: name,
                nameCn: '',
                date: info.split('/')[0].trim(),
                relation: '单行本',
                volumeNumber: null
            });
        }

        if (debug) console.log('[KomgaScraper] [Bangumi] web offprints items:', items.length);
        return { ok: true, status: 200, items: items };
    }

    /**
     * 读取系列下的书籍条目：v0 优先，失败或无书籍条目时回退到网页单行本列表。
     * 两条链路都因 HTTP/网络错误失败时抛出带 bangumiApiError 标记的错误，
     * 让调用方能区分「接口不可用」与「真的没有子条目」。
     */
    async function fetchBangumiSubjectsOfSeries(seriesSubjectId) {
        const config = getConfig();
        const debug = config.debug;


        if (!seriesSubjectId) return [];

        const failures = [];
        let anySuccess = false;

        if (isBangumiV0Down()) {
            failures.push('v0 接口：' + describeBangumiFailure(BANGUMI_V0_SKIPPED));
        } else {
            const v0 = await safeBangumiRequest(function() { return fetchBangumiRelationsV0(seriesSubjectId); });
            if (v0.ok) {
                anySuccess = true;
                if (v0.items.length > 0) return v0.items;
                if (debug) console.log('[KomgaScraper] [Bangumi] no book relations in v0 result, trying web list');
            } else {
                failures.push('v0 接口：' + describeBangumiFailure(v0.status));
            }
        }

        const web = await safeBangumiRequest(function() { return fetchBangumiRelationsFromWeb(seriesSubjectId); });
        if (web.ok) {
            anySuccess = true;
            if (web.items.length > 0) return web.items;
        } else {
            failures.push('网页：' + describeBangumiFailure(web.status));
        }

        if (anySuccess) return [];

        const error = new Error(failures.join('；'));
        error.bangumiApiError = true;
        console.error('[KomgaScraper] [Bangumi] Failed to list subjects of series:', seriesSubjectId, failures.join('；'));
        throw error;
    }
    // ============================================================
    // 7.4. 卷号解析（Komga 文件名 / Bangumi 标题共用）
    // ============================================================

    // 明确的卷标写法，按优先级排列；命中后还要校验卷号范围（1–999，允许 10.5 这类小数）
    const EXPLICIT_VOLUME_PATTERNS = [
        /第\s*([0-9]{1,4}(?:\.[0-9]+)?)\s*[巻卷]/,
        /([0-9]{1,4}(?:\.[0-9]+)?)\s*[巻卷]/,
        /第\s*([0-9]{1,4}(?:\.[0-9]+)?)\s*[話话回]/,
        /(?:vol|volume)\.?\s*([0-9]{1,4}(?:\.[0-9]+)?)/i,
        /#\s*([0-9]{1,4}(?:\.[0-9]+)?)/,
        /([0-9]{1,4}(?:\.[0-9]+)?)\s*[冊册]/
    ];

    // 这些扩展名会在解析卷号前去掉（文件名通常已无扩展名，这里只是兜底）。
    // 不能用 “.\w+” 这种通用写法：「Series 1.5」这类小数卷号会被误当扩展名截断。
    const FILE_EXTENSION_PATTERN = /\.(cbz|cbr|cb7|cbt|zip|rar|7z|pdf|epub|mobi|azw3?|djvu)$/i;

    /** 全角数字 / 全角小数点 -> 半角（「第１０巻」这类日文命名很常见） */
    function toHalfWidthDigits(text) {
        return String(text == null ? '' : text)
            .replace(/[０-９]/g, function(ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
            .replace(/．/g, '.');
    }

    /** 卷号合法性：必须是 1–999 的有限数字，否则返回 null */
    function toValidVolumeNumber(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        if (num <= 0 || num > 999) return null;
        return num;
    }

    /**
     * 文本是否「只是卷标」：「第3話」「Vol.2」「#07」「5」「第5巻」这类。
     * Komga 里常有书名直接就是话数的书，单独拿它当搜索词搜不到任何东西。
     */
    function isVolumeMarkerOnly(text) {
        const normalized = toHalfWidthDigits(String(text == null ? '' : text).replace(/\s+/g, ''));
        if (!normalized) return false;
        return /^(?:第)?[0-9]{1,4}(?:\.[0-9]+)?(?:[巻卷話话回冊册集部])?$/.test(normalized)
            || /^(?:vol|volume)\.?[0-9]{1,4}(?:\.[0-9]+)?$/i.test(normalized)
            || /^#[0-9]{1,4}(?:\.[0-9]+)?$/.test(normalized);
    }

    /** 显式卷标（第N巻 / N巻 / 第N話 / Vol.N / #N / N冊），命中即返回；否则 null */
    function parseExplicitVolumeNumber(text) {
        const normalized = toHalfWidthDigits(text);
        if (!normalized) return null;
        for (let i = 0; i < EXPLICIT_VOLUME_PATTERNS.length; i++) {
            const re = new RegExp(EXPLICIT_VOLUME_PATTERNS[i].source, 'gi');
            let m;
            while ((m = re.exec(normalized)) !== null) {
                const vol = toValidVolumeNumber(m[1]);
                if (vol != null) return vol;
                if (m.index === re.lastIndex) re.lastIndex++;   // 防御零宽匹配死循环
            }
        }
        return null;
    }

    /**
     * 文本中所有“独立的 1–3 位数字”候选（四位年份如 2020 天然不会被匹配到）。
     * 前一个字符不能是数字/小数点，后一个字符不能是数字，避免从长数字里截取片段。
     */
    function findStandaloneVolumeCandidates(text) {
        const normalized = toHalfWidthDigits(text);
        const found = [];
        if (!normalized) return found;
        const re = /(?:^|[^0-9.])([0-9]{1,3}(?:\.[0-9]+)?)(?![0-9])/g;
        let m;
        while ((m = re.exec(normalized)) !== null) {
            const vol = toValidVolumeNumber(m[1]);
            if (vol != null) found.push(vol);
            if (m.index === re.lastIndex) re.lastIndex++;   // 防御零宽匹配死循环
        }
        return found;
    }

    /** 取 Komga BookDto.url 中的文件名（受限用户只会看到文件名，取到什么用什么） */
    function fileNameFromUrl(url) {
        const text = String(url == null ? '' : url).replace(/[\\/]+$/, '');
        if (!text) return '';
        const parts = text.split(/[\\/]/);
        let name = parts[parts.length - 1] || '';
        try {
            name = decodeURIComponent(name);
        } catch (_) { /* 非百分号编码，保持原样 */ }
        return name;
    }

    /**
     * 从 Komga 书籍的文件名（不含扩展名）解析卷号。
     * 1) 显式卷标：第N巻 / N巻 / 第N話 / Vol.N / #N / N冊
     * 2) 兜底：文件名中最后一个 1–3 位独立数字（如「Series 10」；四位年份不会被算进来）
     * 解析不到返回 null，由调用方回退 Komga 已有的 metadata.number。
     */
    function extractVolumeNumberFromFileName(fileName) {
        const raw = String(fileName == null ? '' : fileName).trim();
        if (!raw) return null;
        const base = raw.replace(FILE_EXTENSION_PATTERN, '');

        const explicit = parseExplicitVolumeNumber(base);
        if (explicit != null) return explicit;

        // 文件名里的数字几乎总在卷号位置靠后（前面可能有年份、期刊号等），取最后一个
        const candidates = findStandaloneVolumeCandidates(base);
        return candidates.length > 0 ? candidates[candidates.length - 1] : null;
    }

    /**
     * Bangumi 条目标题 -> 卷号：显式卷标优先，其次退化为标题中首个 1–3 位独立数字。
     */
    function normalizeVolumeNumber(name, nameCn) {
        if (!name && !nameCn) return null;
        const candidates = [nameCn, name];
        for (let i = 0; i < candidates.length; i++) {
            const text = String(candidates[i] || '');
            if (!text) continue;
            const explicit = parseExplicitVolumeNumber(text);
            if (explicit != null) return explicit;
            const found = findStandaloneVolumeCandidates(text);
            if (found.length > 0) return found[0];
        }
        return null;
    }

    /** 卷号归一化：'10.0'、10、'10' 视为同一卷（匹配时按数值等价比较） */
    function normalizeVolumeKey(value) {
        if (value === null || value === undefined) return null;
        const text = String(value).trim();
        if (!text) return null;
        const num = Number(text);
        return Number.isFinite(num) ? String(num) : text;
    }

    // ============================================================
    // 7.5. Fanza (DMM) 刮削源
    // ============================================================

    // 搜索走 FANZA 同人专用搜索页（/dc/doujin/-/search/）。
    // 不要用 www.dmm.co.jp/search/（全站搜索）：它的同人分区只在少数关键词下出现，
    // 且带上 /sort=date/ 后同人条目会整段消失（实测关键词「オリジナル」：带 /sort=date/ 时 0 条，去掉后约 10 条）。
    // 实测该端点每页固定返回 120 条：limit=30/60/120 拿到的都是同一页（「1～120 タイトル」），
    // 也就是说 limit 目前根本没生效，这里仍然带上只是为了将来 DMM 恢复该参数时不用改代码。
    const FANZA_SEARCH_URL = 'https://www.dmm.co.jp/dc/doujin/-/search/=/searchstr={keyword}/limit={limit}/';
    const FANZA_DETAIL_BASE = 'https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=';
    const FANZA_SEARCH_LIMITS = [30, 60, 120];

    // 详情页「ジャンル」里混着受众/营销标记与年龄分级，作为标签没有意义
    // （成人向け / 全年齢向け 是分级信息，改由 ageRating 承载，见下方 ADULT_AGE_RATING）
    const FANZA_TAG_BLOCKLIST = ['男性向け', '女性向け', '成人向け', '全年齢向け', '新作', 'イチオシ', 'セール', '無料', 'ポイント', '割引'];

    // 限制级统一写 Komga 的 ageRating=18（Komga 的 "Adults Only 18+" / "R18+" / "X18+" 都映射成整数 18）。
    // 非限制级与判定不出时不写该字段，保持 Komga 原值。
    const ADULT_AGE_RATING = 18;

    // 书籍页刮削时，这些「系列级」字段要改写到所属系列：Komga 的书籍元数据没有这些字段
    // （只有 SeriesMetadata 有 title / titleSort / ageRating），直接发给书籍 PATCH 会被 Komga 400 拒绝
    const SERIES_SCOPED_FIELD_KEYS = {
        __seriesTitle: 'title',
        __seriesTitleSort: 'titleSort',
        __seriesAgeRating: 'ageRating'
    };

    // 駿河屋（兜底源）：只取搜索列表页，不抓商品详情页
    // （/product/detail/* 有 Cloudflare 拦截，实测直连返回 403「Just a moment...」；
    //   列表页本身已含 作品名/作者/サークル/発売日/封面/商品链接，够用）
    const SURUGAYA_SEARCH_URL = 'https://www.suruga-ya.jp/search?category=&search_word={keyword}&searchbox=1&adult_s=3';
    // 18 禁条目在未确认年龄时标题与链接会被抹成空串；带上服务端下发的 safe_search_option 才能取到完整条目
    const SURUGAYA_COOKIE = 'safe_search_option=3; safe_search_expired=3';
    // 直连一旦被 Cloudflare 拦下，短时间内就别再试直连了（省掉每次注定失败的 403）；
    // 只记在内存里，刷新页面即失效，IP 恢复正常后会自动回到直连
    const SURUGAYA_DIRECT_BLOCK_COOLDOWN_MS = 5 * 60 * 1000;
    let surugayaDirectBlockedUntil = 0;

    // FANZA 与 駿河屋 的年龄门禁都只能靠显式 Cookie：
    // GM_xmlhttpRequest 对外部请求默认 anonymous:true，不会携带浏览器里的 Cookie
    const EXTERNAL_HTML_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
    };

    function fanzaHeaders() {
        return Object.assign({}, EXTERNAL_HTML_HEADERS, { 'Cookie': 'age_check_done=1' });
    }

    /** 是否读得到浏览器 Cookie 罐（Tampermonkey 且已授予 GM_cookie 权限） */
    function canReadBrowserCookies() {
        return typeof GM_cookie !== 'undefined' && !!GM_cookie && typeof GM_cookie.list === 'function';
    }

    /** 当前脚本管理器名称（Tampermonkey / Violentmonkey / ...），取不到时返回空串 */
    function getScriptHandler() {
        try {
            return (typeof GM_info !== 'undefined' && GM_info && GM_info.scriptHandler) ? String(GM_info.scriptHandler) : '';
        } catch (e) {
            return '';
        }
    }

    /** 读取浏览器里 駿河屋 域的 Cookie（依赖 Tampermonkey 的 GM_cookie；不支持时返回空数组） */
    function listSurugayaJarCookies() {
        return new Promise(function(resolve) {
            if (!canReadBrowserCookies()) {
                resolve([]);
                return;
            }
            try {
                GM_cookie.list({}, function(cookies, error) {
                    if (error || !cookies) {
                        resolve([]);
                        return;
                    }
                    resolve(cookies.filter(function(cookie) {
                        return cookie && typeof cookie.domain === 'string' && /(^|\.)suruga-ya\.jp$/i.test(cookie.domain);
                    }));
                });
            } catch (e) {
                resolve([]);
            }
        });
    }

    /**
     * 构造 駿河屋 请求用的 Cookie 头。
     * 除了必需的 safe_search（不带的话 18 禁条目的标题与链接会被服务端抹成空串），
     * 还要带上浏览器里已通过 Cloudflare 人机校验的 Cookie（cf_clearance 等），
     * 否则脚本发出的请求会被 Cloudflare 当成新访客、每次都要求重新校验。
     *
     * 返回 { cookie, mergedFromJar }：
     *   mergedFromJar=true  → 已把浏览器 Cookie 显式拼进 cookie（含 cf_clearance）；
     *   mergedFromJar=false → 读不到浏览器 Cookie（非 Tampermonkey / 未授予 GM_cookie），
     *                          调用方会退回旧行为，只带 safe_search。
     */
    async function buildSurugayaCookie() {
        const jar = await listSurugayaJarCookies();
        const merged = {};
        jar.forEach(function(cookie) { merged[cookie.name] = cookie.value; });
        const mergedFromJar = Object.keys(merged).length > 0;
        SURUGAYA_COOKIE.split(';').forEach(function(pair) {
            const idx = pair.indexOf('=');
            if (idx > 0) merged[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
        });
        const cookie = Object.keys(merged).map(function(name) { return name + '=' + merged[name]; }).join('; ');
        return { cookie: cookie, mergedFromJar: mergedFromJar };
    }

    /** 駿河屋 请求参数：合并浏览器 Cookie 罐 + 必需 Cookie，并且不覆盖浏览器真实 UA */
    async function surugayaRequestOptions() {
        const info = await buildSurugayaCookie();
        const headers = Object.assign({}, EXTERNAL_HTML_HEADERS);
        delete headers['User-Agent'];
        if (info.mergedFromJar) {
            // 读到浏览器 Cookie（含 cf_clearance）时显式整串带上、匿名发送（与 FANZA 同款做法）：
            // 匿名 + 显式头可以避免和 Cookie 罐里的同名 Cookie 重复（罐里的 safe_search 旧值可能覆盖我们的 =3）
            headers['Cookie'] = info.cookie;
            return { headers: headers, anonymous: true };
        }
        // 读不到浏览器 Cookie（非 Tampermonkey 或未授予 GM_cookie）：退回旧行为，只显式带 safe_search
        headers['Cookie'] = SURUGAYA_COOKIE;
        return { headers: headers, anonymous: true };
    }

    /** 实测 limit 未生效（每页固定 120 条），这里仅收敛成 30/60/120 以备 DMM 恢复该参数 */
    function normalizeFanzaSearchLimit(value) {
        const num = parseInt(value, 10);
        if (!isFinite(num) || num <= 0) return FANZA_SEARCH_LIMITS[0];
        for (let i = 0; i < FANZA_SEARCH_LIMITS.length; i++) {
            if (num <= FANZA_SEARCH_LIMITS[i]) return FANZA_SEARCH_LIMITS[i];
        }
        return FANZA_SEARCH_LIMITS[FANZA_SEARCH_LIMITS.length - 1];
    }

    /**
     * FANZA/DMM 的地域限制页与年齢認証页都返回 HTTP 200，
     * 必须在解析前识别，否则会被当成「没有搜索结果」。
     */
    function detectFanzaBlockedPage(html) {
        const text = String(html || '');
        if (!text) return '';
        if (/not-available-in-your-region|お住まいの地域/.test(text)) return 'region';
        if (/<title[^>]*>[^<]*年齢認証/.test(text)) return 'age';
        return '';
    }

    function describeFanzaBlocked(reason) {
        if (reason === 'region') return 'FANZA/DMM 提示当前网络无法访问（地域限制）';
        if (reason === 'age') return 'FANZA/DMM 要求年龄确认（返回了年齢認証页）';
        if (reason === 'parse') return 'FANZA/DMM 结果页结构可能已变更（未解析到任何作品）';
        return 'FANZA/DMM 请求失败';
    }

    function buildFanzaBlockedError(reason, detail) {
        const err = new Error(detail || describeFanzaBlocked(reason));
        err.fanzaBlocked = reason;
        return err;
    }

    function extractFanzaSearchTotal(html) {
        const m = String(html || '').match(/全\s*([\d,]+)\s*タイトル/);
        if (!m) return null;
        const num = parseInt(m[1].replace(/,/g, ''), 10);
        return isFinite(num) ? num : null;
    }

    function parseHtmlToDoc(html) {
        try {
            const parser = new DOMParser();
            return parser.parseFromString(html, 'text/html');
        } catch (e) {
            return null;
        }
    }

    function extractMetaContent(html, property) {
        const pattern = new RegExp('<meta[^>]+(?:property|name)=["\']' + property + '["\'][^>]*content=(["\'])([^"\']+)\\1', 'i');
        const m = html.match(pattern);
        return m ? m[2].trim() : '';
    }

    function cleanFanzaSummary(rawDesc) {
        if (!rawDesc) return '';
        let text = String(rawDesc);
        const lastColon = text.lastIndexOf(':');
        if (lastColon !== -1) {
            text = text.substring(lastColon + 1).trim();
        }
        text = text.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
        if (text.length > 800) text = text.substring(0, 800).trim() + '...';
        return text;
    }

    /**
     * 解析 FANZA 同人搜索列表页（li.productList__item）。
     * 列表页自带 标题/封面/圈名，选中后才会去抓详情页，所以这里不再逐个 CID 预抓详情。
     */
    function parseFanzaSearchItems(html) {
        const doc = parseHtmlToDoc(html);
        if (!doc) return null;

        const nodes = doc.querySelectorAll('li.productList__item');
        const results = [];

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const link = node.querySelector('a[href*="cid="]');
            if (!link) continue;

            const cidMatch = String(link.getAttribute('href') || '').match(/cid=([A-Za-z0-9_]+)/);
            if (!cidMatch) continue;

            const detailUrl = FANZA_DETAIL_BASE + cidMatch[1] + '/';

            const titleNode = node.querySelector('.tileListTtl__txt a') || node.querySelector('.tileListTtl__txt');
            let title = titleNode ? String(titleNode.textContent || '').trim() : '';
            if (!title) {
                const altImg = node.querySelector('img[alt]');
                title = altImg ? String(altImg.getAttribute('alt') || '').trim() : '';
            }
            if (!title) continue;

            const imgNode = node.querySelector('.tileListImg img') || node.querySelector('img');
            let image = imgNode ? String(imgNode.getAttribute('src') || '').trim() : '';
            if (image.indexOf('//') === 0) {
                image = 'https:' + image;
            } else if (image.indexOf('http') !== 0 && image.indexOf('/') === 0) {
                image = 'https://www.dmm.co.jp' + image;
            }

            const circleNode = node.querySelector('.tileListTtl__txt--author a');

            results.push({
                source: 'fanza',
                sourceLabel: 'FANZA/DMM',
                id: detailUrl,
                url: detailUrl,
                title: title,
                originalTitle: title,
                // 列表页没有简介/发售日，选中后由 fetchFanzaDetail 补全
                summary: '',
                image: image,
                largeImage: image,
                publisher: circleNode ? String(circleNode.textContent || '').trim() : '',
                rating: null,
                isSeries: null,
                airDate: '',
                authors: [],
                tags: [],
                links: [{ label: 'Fanza', url: detailUrl }]
            });
        }

        return results;
    }

    /** 返回 { results, total }；被地域限制/年龄门禁/改版拦下时抛出带 fanzaBlocked 标记的错误 */
    async function scrapeFromFanza(keyword) {
        const config = getConfig();
        const debug = config.debug;

        const limit = normalizeFanzaSearchLimit(getSearchFetchLimit());
        const searchUrl = FANZA_SEARCH_URL
            .replace('{keyword}', encodeURIComponent(keyword))
            .replace('{limit}', String(limit));

        if (debug) console.log('[KomgaScraper] [Fanza] Searching for:', keyword, '/ limit:', limit, '/ url:', searchUrl);

        const response = await fetchWithRateLimit({
            method: 'GET',
            url: searchUrl,
            headers: fanzaHeaders()
        });

        if (debug) console.log('[KomgaScraper] [Fanza] Response status:', response.status);

        const html = response.raw || '';

        // 地域限制 / 年齢認証 页同样是 200，需要优先识别
        const blocked = detectFanzaBlockedPage(html);
        if (blocked) throw buildFanzaBlockedError(blocked);

        // DMM 在「0 条结果」时返回 HTTP 404，但页面里其实写着「一致する作品は見つかりませんでした」，
        // 这属于正常空结果而不是请求失败；若当成 HTTP 错误处理，兜底的提示会变成一串报错
        const noHitPage = /一致する作品は見つかりませんでした/.test(html);
        if (response.status === 404 && noHitPage) {
            return { results: [], total: 0 };
        }

        if (response.status !== 200 || !html) {
            throw buildFanzaBlockedError('http', 'FANZA/DMM 请求失败（HTTP ' + response.status + '）');
        }

        const items = parseFanzaSearchItems(html);
        if (items === null) throw buildFanzaBlockedError('parse');

        // 0 条且页面明确写着「一致する作品は見つかりませんでした」才是真的没搜到，
        // 否则说明页面结构变了（宁可报错，也不要假装没搜到）
        if (items.length === 0 && !noHitPage) {
            throw buildFanzaBlockedError('parse');
        }

        const total = extractFanzaSearchTotal(html);
        if (debug) console.log('[KomgaScraper] [Fanza] Parsed', items.length, 'items / total:', total);

        return { results: items, total: total };
    }

    async function fetchFanzaDetail(url) {
        try {
            const config = getConfig();
            const debug = config.debug;

            if (debug) console.log('[KomgaScraper] [Fanza] Fetching detail:', url);

            const response = await fetchWithRateLimit({
                method: 'GET',
                url: url,
                headers: fanzaHeaders()
            });

            if (response.status !== 200 || !response.raw) {
                console.warn('[KomgaScraper] [Fanza] Failed to get detail page');
                return null;
            }

            const html = response.raw;

            // 地域限制 / 年齢認証 页同样是 200，需要显式识别
            const blocked = detectFanzaBlockedPage(html);
            if (blocked) {
                console.warn('[KomgaScraper] [Fanza] Detail page blocked:', blocked);
                return null;
            }

            const doc = parseHtmlToDoc(html);

            const titleMeta = extractMetaContent(html, 'og:title');
            const title = titleMeta || (doc && doc.querySelector('title') ? doc.querySelector('title').textContent.trim() : '');

            const imageMeta = extractMetaContent(html, 'og:image');
            const descriptionMeta = extractMetaContent(html, 'og:description');
            const cleanDesc = cleanFanzaSummary(descriptionMeta);

            let releaseDate = '';
            let pageCount = '';
            let author = '';
            let publisher = '';
            let ageRating = null;
            const tags = [];
            const infoKeysRaw = {};
            // 信息表里 dd 内的链接文本（FANZA 的「ジャンル」是一串 <a>，拼成整串文本没法切分）
            const infoKeyLinks = {};

            if (doc) {
                const tableRows = doc.querySelectorAll('table tr, div[class*="information"] tr, dl[class*="info"] dt, dl[class*="info"] dd');
                if (tableRows.length > 0) {
                    let currentKey = '';
                    tableRows.forEach(function(node) {
                        const tagName = node.tagName;
                        const text = node.textContent && node.textContent.trim();
                        if (!text) return;

                        if (tagName === 'DT' || tagName === 'TH' || (tagName === 'TR' && text.indexOf(':') !== -1)) {
                            if (tagName === 'TR') {
                                const parts = text.split(/[:：]/);
                                if (parts.length >= 2) {
                                    currentKey = parts[0].trim();
                                    const val = parts.slice(1).join(':').trim();
                                    infoKeysRaw[currentKey] = val;
                                }
                            } else {
                                currentKey = text.replace(/[:：]/g, '').trim();
                            }
                        } else if (tagName === 'DD' || tagName === 'TD') {
                            if (currentKey) {
                                infoKeysRaw[currentKey] = text;
                                const anchors = node.querySelectorAll('a');
                                if (anchors.length > 0) {
                                    const anchorTexts = [];
                                    for (let a = 0; a < anchors.length; a++) {
                                        const anchorText = anchors[a].textContent && anchors[a].textContent.trim();
                                        if (anchorText) anchorTexts.push(anchorText);
                                    }
                                    if (anchorTexts.length > 0) infoKeyLinks[currentKey] = anchorTexts;
                                }
                            }
                        }
                    });
                } else {
                    const infoBlocks = doc.querySelectorAll('dl[class*="product"], dl[class*="Product"], dl[class*="detail"], div[class*="productInfo"]');
                    for (let b = 0; b < infoBlocks.length; b++) {
                        const block = infoBlocks[b];
                        const dts = block.querySelectorAll('dt, th');
                        const dds = block.querySelectorAll('dd, td');
                        for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
                            const key = dts[i].textContent.replace(/[:：]/g, '').trim();
                            const val = dds[i].textContent.trim();
                            if (key && val) infoKeysRaw[key] = val;
                        }
                    }
                }

            }

            for (const k in infoKeysRaw) {
                const val = infoKeysRaw[k];
                if (/配信|発売|release|date/i.test(k)) {
                    if (!releaseDate) {
                        const datePart = val.match(/(\d{4})[\/年.\-](\d{1,2})[\/月.\-](\d{1,2})/);
                        if (datePart) {
                            releaseDate = datePart[1] + '-' + (datePart[2].length === 1 ? '0' : '') + datePart[2] + '-' + (datePart[3].length === 1 ? '0' : '') + datePart[3];
                        }
                    }
                }
                if (/ページ|page/i.test(k)) {
                    const pm = val.match(/(\d+)/);
                    if (pm) pageCount = pm[1];
                }
                if (/作者|著者|creator|author|作家/i.test(k)) {
                    if (!author) author = val.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
                }
                if (/出版社|ブランド|メーカー|レーベル|サークル/i.test(k)) {
                    if (!publisher) publisher = val.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
                }
                if (/シリーズ|series|題材|原作|ジャンル|genre/i.test(k)) {
                    // 优先取 dd 里逐个链接的文本（每个链接是一个真实标签），没有链接才退回按分隔符切分
                    const linked = infoKeyLinks[k];
                    const parts = (linked && linked.length > 0)
                        ? linked
                        : val.split(/[,，、\/]/).map(function(s) { return s.trim(); });
                    // 年龄分级：FANZA 同人详情页把「成人向け / 全年齢向け」放在 ジャンル 里，两者互斥（实测）。
                    // 只在检出「成人向け」时记为限制级；两个标记都没有说明数据缺失，此时不猜、不写分级。
                    if (/ジャンル/i.test(k) && parts.indexOf('成人向け') !== -1) {
                        ageRating = ADULT_AGE_RATING;
                    }
                    parts.forEach(function(p) {
                        if (!p || p.length > 30) return;
                        if (FANZA_TAG_BLOCKLIST.indexOf(p) !== -1) return;
                        if (tags.indexOf(p) === -1 && tags.length < 30) tags.push(p);
                    });
                }
            }

            // 出版社：FANZA 同人详情页的信息表里没有社名，圈名在 m-circleInfo 区块的 a.circleName__txt 上
            if (!publisher && doc) {
                const circleNode = doc.querySelector('a.circleName__txt') || doc.querySelector('.circleName a');
                if (circleNode) {
                    const circleText = String(circleNode.textContent || '').replace(/全作品一覧へ/g, '').trim();
                    if (circleText && circleText.length <= 40) publisher = circleText;
                }
            }

            if (!author) {
                const circleMatch = title.match(/\((.+?)\)/);
                if (circleMatch && circleMatch[1] && circleMatch[1].length <= 30) {
                    author = circleMatch[1].trim();
                }
            }

            if (debug) {
                console.log('[KomgaScraper] [Fanza] Parsed detail:', {
                    title: title,
                    releaseDate: releaseDate,
                    pageCount: pageCount,
                    author: author,
                    tags: tags,
                    ageRating: ageRating,
                    image: imageMeta
                });
            }

            return {
                source: 'fanza',
                id: url,
                title: title,
                originalTitle: title,
                summary: cleanDesc,
                image: imageMeta,
                largeImage: imageMeta,
                rating: null,
                status: 'Completed',
                airDate: releaseDate,
                date: releaseDate,
                releaseDate: releaseDate,
                pages: pageCount,
                authors: author ? [{ name: author, role: 'writer' }] : [],
                publisher: publisher,
                ageRating: ageRating,
                tags: tags,
                isbn: '',
                url: url,
                links: [{ label: 'Fanza', url: url }]
            };

        } catch (e) {
            console.error('[KomgaScraper] [Fanza] Failed to fetch detail:', e);
            return null;
        }
    }

    function mapFanzaToSeries(fanzaData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        newMetadata.title = fanzaData.title || metadata.title;
        newMetadata.summary = fanzaData.summary || metadata.summary;
        newMetadata.status = 'ENDED';

        // 出版社（仅系列级字段：Komga 的书籍元数据 API 不支持 publisher）
        const fanzaPublisher = String(fanzaData.publisher || '').trim();
        if (fanzaPublisher) {
            newMetadata.publisher = fanzaPublisher;
        }

        // 年龄分级：取值语义是「作品的年龄分级」，只在最终写系列时使用
        // （系列页直接写系列，书籍页走 __seriesAgeRating 同步到所属系列）
        if (fanzaData.ageRating) {
            newMetadata.ageRating = fanzaData.ageRating;
        }

        if (fanzaData.tags && fanzaData.tags.length > 0) {
            newMetadata.tags = fanzaData.tags;
        }

        if (fanzaData.links && fanzaData.links.length > 0) {
            newMetadata.links = fanzaData.links;
        }

        return newMetadata;
    }

    function mapFanzaToBook(fanzaData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        newMetadata.title = fanzaData.title || metadata.title;
        newMetadata.summary = fanzaData.summary || metadata.summary;

        // 见 mapFanzaToSeries：这里只透传，书籍本身没有 ageRating 字段
        if (fanzaData.ageRating) {
            newMetadata.ageRating = fanzaData.ageRating;
        }

        if (fanzaData.releaseDate) {
            newMetadata.releaseDate = fanzaData.releaseDate;
        }

        if (fanzaData.authors && fanzaData.authors.length > 0) {
            newMetadata.authors = fanzaData.authors;
        }

        if (fanzaData.tags && fanzaData.tags.length > 0) {
            newMetadata.tags = fanzaData.tags;
        }

        if (fanzaData.links && fanzaData.links.length > 0) {
            newMetadata.links = fanzaData.links;
        }

        return newMetadata;
    }

    // ============================================================
    // 7.6. 駿河屋 (Suruga-ya) 兜底源
    // ============================================================
    // 只在 FANZA/DMM 搜不到（或请求失败）时才启用，绝不与 FANZA 结果混排。
    // 只解析搜索列表页：商品详情页 /product/detail/* 有 Cloudflare 人机校验，
    // 而列表页已含 作品名 / 作者 / サークル / 発売日 / 封面 / 商品链接。

    /**
     * 駿河屋商品名形如「作品名 / 作者 / サークル」，另有单独的 [サークル] 字段可作准绳：
     * 与 brand 相同的尾段判为サークル，其余中段都是作者（合同志会有多个）。
     */
    function splitSurugayaProductName(rawName, brandText) {
        const parts = String(rawName || '').split(/\s*\/\s*/).map(function(s) { return s.trim(); }).filter(function(s) { return !!s; });
        const title = parts.length > 0 ? parts[0] : String(rawName || '').trim();

        // brand 是「[サークル] 」（前后可能有空白），先去空白再剥方括号
        let circle = String(brandText || '').replace(/\s+/g, ' ').trim().replace(/^\[/, '').replace(/\]$/, '').trim();
        const rest = parts.slice(1);

        if (!circle && rest.length >= 2) {
            circle = rest.pop();
        } else if (circle && rest.length > 0 && rest[rest.length - 1] === circle) {
            rest.pop();
        }

        // 作者里常带（CP 表记）这类括号补充，去掉
        const authors = rest
            .map(function(s) { return s.replace(/[（(][^（）()]*[）)]/g, '').trim(); })
            .filter(function(s) { return !!s; });

        return { title: title, authors: authors, circle: circle };
    }

    function extractSurugayaReleaseDate(text) {
        const m = String(text || '').match(/(\d{4})[\/年.\-](\d{1,2})[\/月.\-](\d{1,2})/);
        if (!m) return '';
        return m[1] + '-' + (m[2].length === 1 ? '0' : '') + m[2] + '-' + (m[3].length === 1 ? '0' : '') + m[3];
    }

    function extractSurugayaSearchTotal(html) {
        const m = String(html || '').match(/該当件数[：:]\s*([\d,]+)\s*件中/);
        if (!m) return null;
        const num = parseInt(m[1].replace(/,/g, ''), 10);
        return isFinite(num) ? num : null;
    }

    /** 解析駿河屋搜索列表页（div.item），返回结果数组；页面结构不认返回 null */
    function parseSurugayaSearchItems(html) {
        const doc = parseHtmlToDoc(html);
        if (!doc) return null;

        const nodes = doc.querySelectorAll('div.item');
        const results = [];
        const seen = {};

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const nameNode = node.querySelector('h3.product-name');
            if (!nameNode) continue;

            const rawName = String(nameNode.textContent || '').replace(/\s+/g, ' ').trim();
            if (!rawName) continue;

            const link = node.querySelector('.item_detail .title a') || node.querySelector('a[href*="/product/"]');
            let productUrl = link ? String(link.getAttribute('href') || '').trim() : '';
            // 列表页里有绝对 URL 也有相对 URL（/product/detail/xxx）
            if (productUrl.indexOf('//') === 0) {
                productUrl = 'https:' + productUrl;
            } else if (productUrl.indexOf('/') === 0) {
                productUrl = 'https://www.suruga-ya.jp' + productUrl;
            }
            if (!productUrl || seen[productUrl]) continue;
            seen[productUrl] = true;

            const brandNode = node.querySelector('p.brand');
            const name = splitSurugayaProductName(rawName, brandNode ? brandNode.textContent : '');

            const dateNode = node.querySelector('p.release_date');
            const releaseDate = dateNode ? extractSurugayaReleaseDate(dateNode.textContent) : '';

            const imgNode = node.querySelector('.photo_box img') || node.querySelector('img[src*="photo.php"]');
            let image = imgNode ? String(imgNode.getAttribute('src') || '').trim() : '';
            if (image.indexOf('//') === 0) image = 'https:' + image;
            // 列表缩略图是 size=m，换成 size=l 拿更大的封面
            image = image.replace(/([?&]size=)m\b/, '$1l');

            // 年龄分级：駿河屋 用分类标签 + r18.png 图标标注限制级商品
            // （实测标签如「男性向18禁同人誌」「女性向けアダルト同人誌（BL含む）」「インディーズアダルトDVD」；
            //   非限制级商品不带该图标，对照实测无 r18 标记）
            const conditionTexts = [];
            const conditionNodes = node.querySelectorAll('p.condition');
            for (let c = 0; c < conditionNodes.length; c++) {
                conditionTexts.push(String(conditionNodes[c].textContent || ''));
            }
            const isAdultProduct = !!node.querySelector('img[src*="r18"]')
                || /18禁|アダルト/.test(conditionTexts.join(' '));

            results.push({
                source: 'surugaya',
                sourceLabel: '駿河屋',
                id: productUrl,
                url: productUrl,
                title: name.title,
                originalTitle: name.title,
                // 列表页没有商品说明，简介保持 Komga 现值
                summary: '',
                image: image,
                largeImage: image,
                publisher: name.circle,
                ageRating: isAdultProduct ? ADULT_AGE_RATING : null,
                releaseDate: releaseDate,
                airDate: releaseDate,
                authors: name.authors.map(function(authorName) { return { name: authorName, role: 'writer' }; }),
                rating: null,
                isSeries: null,
                tags: [],
                links: [{ label: '駿河屋', url: productUrl }]
            });
        }

        return results;
    }

    function buildSurugayaBlockedError(reason, detail) {
        const err = new Error(detail || '駿河屋 请求失败');
        err.surugayaBlocked = reason;
        return err;
    }

    function describeSurugayaBlocked(reason) {
        if (reason === 'cloudflare') {
            let message = '駿河屋 触发了 Cloudflare 人机校验（HTTP 403 / Just a moment）。'
                + '脚本会自动改用「桥接标签页」：新开一个后台标签页去访问同一个搜索页，'
                + '由那个真实标签页把结果 HTML 回传（只有真实浏览器导航才能过校验）。'
                + '如果那个标签页停在人机校验页，请切过去点一下「确认」，脚本会自动继续。';
            if (!surugayaBridgeSupported()) {
                message += '（当前脚本管理器缺少 GM_openInTab / GM_addValueChangeListener 权限，无法自动开桥接标签页：'
                    + '请在脚本管理器中更新本脚本并允许新增权限后重试。）';
            } else if (!canReadBrowserCookies()) {
                message += /tampermonkey/i.test(getScriptHandler())
                    ? '（当前脚本读不到浏览器 Cookie：需要 Tampermonkey 的 GM_cookie 权限，请在脚本管理器中更新本脚本并允许新增权限后重试。）'
                    : '（当前脚本管理器不支持读取浏览器 Cookie（需要 Tampermonkey 的 GM_cookie 权限），因此无法复用校验 Cookie。）';
            }
            message += '若始终失败，说明本机出口 IP 被 Cloudflare 判定为可疑：'
                + '可只让 suruga-ya.jp 走代理 / 代理软件规则换出口 IP 后重试（换 IP 后校验会重新触发一次，属正常现象）。';
            return message;
        }
        if (reason === 'parse') return '駿河屋 结果页结构可能已变更（未解析到任何商品）';
        return '请检查网络连接后重试';
    }

    /**
     * 取駿河屋搜索页 HTML。
     * 1) 先直连：GM_xmlhttpRequest + 浏览器 Cookie 罐里的校验 Cookie（干净 IP 下这一步就够了）；
     * 2) 被判为人机校验（403 / Just a moment）时，改用「桥接标签页」重取（见文件顶部模块 0）。
     * 两条路都失败时抛出带 surugayaBlocked 标记的错误。
     */
    async function fetchSurugayaSearchHtml(searchUrl, debug) {
        const skipDirect = Date.now() < surugayaDirectBlockedUntil;
        if (skipDirect && debug) console.log('[KomgaScraper] [Suruga-ya] 直连刚被 Cloudflare 拦下过，本次直接走桥接标签页');

        let response = { status: 0, raw: '' };
        if (!skipDirect) {
            const surugayaOptions = await surugayaRequestOptions();

            response = await fetchWithRateLimit({
                method: 'GET',
                url: searchUrl,
                headers: surugayaOptions.headers,
                useBrowserUserAgent: true,
                anonymous: surugayaOptions.anonymous
            });

            if (debug) console.log('[KomgaScraper] [Suruga-ya] Response status:', response.status);
        }

        const body = response.raw || '';
        // Cloudflare 校验页既可能是 403，也可能是 200（标题固定 Just a moment...）
        const challenged = skipDirect || response.status === 403 || /<title[^>]*>\s*Just a moment/i.test(body);
        if (!challenged) {
            if (response.status === 200 && body) return body;
            throw buildSurugayaBlockedError(
                'http',
                '駿河屋 请求失败（HTTP ' + response.status + '）'
            );
        }

        if (getConfig().surugayaBridgeTab === false || !surugayaBridgeSupported()) {
            throw buildSurugayaBlockedError('cloudflare');
        }

        surugayaDirectBlockedUntil = Date.now() + SURUGAYA_DIRECT_BLOCK_COOLDOWN_MS;
        if (debug) console.log('[KomgaScraper] [Suruga-ya] 直连被 Cloudflare 拦下，改用桥接标签页重取');
        const bridged = await fetchSurugayaViaBridge(searchUrl, debug, function() {
            showLoading('駿河屋 需要人机验证：请切到刚打开的 駿河屋 标签页完成验证，脚本会自动继续');
        });
        if (bridged) return bridged;

        throw buildSurugayaBlockedError('cloudflare');
    }

    /** 返回 { results, total }；被 Cloudflare 拦下时抛出带 surugayaBlocked 标记的错误 */
    async function searchSurugaYa(keyword) {
        const config = getConfig();
        const debug = config.debug;

        const searchUrl = SURUGAYA_SEARCH_URL.replace('{keyword}', encodeURIComponent(keyword));
        if (debug) console.log('[KomgaScraper] [Suruga-ya] Searching for:', keyword, '/ url:', searchUrl);

        const html = await fetchSurugayaSearchHtml(searchUrl, debug);

        const items = parseSurugayaSearchItems(html);
        if (items === null) throw buildSurugayaBlockedError('parse');

        const total = extractSurugayaSearchTotal(html);
        if (debug) console.log('[KomgaScraper] [Suruga-ya] Parsed', items.length, 'items / total:', total);

        return { results: items, total: total };
    }

    function mapSurugaYaToSeries(surugayaData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        newMetadata.title = surugayaData.title || metadata.title;
        newMetadata.summary = surugayaData.summary || metadata.summary;
        // 駿河屋 只有中古/新品在售信息，连载状态无从判断 → 不猜、不写 status

        const surugayaPublisher = String(surugayaData.publisher || '').trim();
        if (surugayaPublisher) {
            newMetadata.publisher = surugayaPublisher;
        }

        // 见 mapFanzaToSeries：取值语义是「作品的年龄分级」，只在最终写系列时使用
        if (surugayaData.ageRating) {
            newMetadata.ageRating = surugayaData.ageRating;
        }

        if (surugayaData.links && surugayaData.links.length > 0) {
            newMetadata.links = surugayaData.links;
        }

        return newMetadata;
    }

    function mapSurugaYaToBook(surugayaData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        newMetadata.title = surugayaData.title || metadata.title;
        newMetadata.summary = surugayaData.summary || metadata.summary;

        // 见 mapFanzaToSeries：这里只透传，书籍本身没有 ageRating 字段
        if (surugayaData.ageRating) {
            newMetadata.ageRating = surugayaData.ageRating;
        }

        if (surugayaData.releaseDate) {
            newMetadata.releaseDate = surugayaData.releaseDate;
        }

        if (surugayaData.authors && surugayaData.authors.length > 0) {
            newMetadata.authors = surugayaData.authors;
        }

        if (surugayaData.links && surugayaData.links.length > 0) {
            newMetadata.links = surugayaData.links;
        }

        return newMetadata;
    }

    // ============================================================
    // 8. UI 模块 - 按钮
    // ============================================================

    const SCRAPE_BTN_ID = 'komga-scraper-btn-container';
    const AUTO_SCRAPE_BTN_ID = 'komga-scraper-auto-btn-container';

    function createScrapeButton() {
        const container = document.createElement('div');
        container.className = 'col col-auto';
        container.id = SCRAPE_BTN_ID;

        const button = document.createElement('a');
        button.className = 'v-btn v-btn--is-elevated v-btn--has-bg theme--dark v-size--small';
        button.title = '刮削元数据';
        button.style.cursor = 'pointer';
        button.style.textDecoration = 'none';

        const content = document.createElement('span');
        content.className = 'v-btn__content';

        const icon = document.createElement('i');
        icon.className = 'v-icon notranslate v-icon--left mdi mdi-database-search theme--dark';
        icon.setAttribute('aria-hidden', 'true');
        icon.style.fontSize = '16px';

        content.appendChild(icon);
        content.appendChild(document.createTextNode(' 刮削 '));
        button.appendChild(content);

        button.addEventListener('click', function(e) {
            e.preventDefault();
            showScraperSourceMenu();
        });

        container.appendChild(button);
        return container;
    }

    function createAutoScrapeButton() {
        const container = document.createElement('div');
        container.className = 'col col-auto';
        container.id = AUTO_SCRAPE_BTN_ID;

        const button = document.createElement('a');
        button.className = 'v-btn v-btn--is-elevated v-btn--has-bg theme--dark v-size--small';
        button.title = '自动刮削：按 Bangumi 系列中的卷号批量写入并锁定书籍元数据';
        button.style.cursor = 'pointer';
        button.style.textDecoration = 'none';

        const content = document.createElement('span');
        content.className = 'v-btn__content';

        const icon = document.createElement('i');
        icon.className = 'v-icon notranslate v-icon--left mdi mdi-auto-fix theme--dark';
        icon.setAttribute('aria-hidden', 'true');
        icon.style.fontSize = '16px';

        content.appendChild(icon);
        content.appendChild(document.createTextNode(' 自动刮削 '));
        button.appendChild(content);

        button.addEventListener('click', function(e) {
            e.preventDefault();
            startAutoScrape();
        });

        container.appendChild(button);
        return container;
    }

    function injectScrapeButton() {
        if (document.getElementById(SCRAPE_BTN_ID)) {
            return;
        }

        const pageType = getCurrentPageType();

        const downloadBtn = document.querySelector('a.v-btn[title*="下载"]');

        if (downloadBtn) {
            const parentRow = downloadBtn.closest('.row.align-center');
            if (parentRow) {
                parentRow.appendChild(createScrapeButton());
                if (pageType === 'series') {
                    parentRow.appendChild(createAutoScrapeButton());
                }
            }
        }
    }

    // ============================================================
    // 9. 模态框工具模块
    // ============================================================

    let __ksStylesInjected = false;
    function injectCommonStyles() {
        if (__ksStylesInjected) return;
        const style = document.createElement('style');
        style.id = 'ks-common-styles';
        style.textContent = [
            '.ks-btn { border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s; }',
            '.ks-btn-primary { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;font-weight:500; }',
            '.ks-btn-primary:hover { transform: translateY(-1px); box-shadow:0 4px 12px rgba(102,126,234,0.4); }',
            '.ks-btn-secondary { background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8); }',
            '.ks-btn-secondary:hover { background:rgba(255,255,255,0.15); }',
            '.ks-btn-block { width:100%; }',
            '.ks-source-card:hover { background:rgba(255,255,255,0.1); border-color:rgba(100,200,255,0.3); transform:translateY(-2px); }',
            '.ks-result-card:hover { background:rgba(255,255,255,0.1); border-color:rgba(100,200,255,0.3); transform:translateY(-2px); }',
            '.ks-field-row:hover { background:rgba(255,255,255,0.05); border-color:rgba(255,255,255,0.1); }',
            '.ks-field-row:hover .ks-field-input { border-color:rgba(102,126,234,0.3); }',
            '.ks-field-input:focus { outline:none; border-color:#667eea !important; box-shadow:0 0 0 2px rgba(102,126,234,0.2); }',
            '@keyframes ks-spin { to { transform: rotate(360deg); } }',
            '.ks-btn-retry { background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.8); }',
            '.ks-btn-retry:hover { background:rgba(255,255,255,0.15); }',
            '.ks-result-card:hover, .ks-source-card, .ks-field-row { transition: all 0.3s ease; }',
            '.ks-result-control { display:flex;align-items:center;gap:6px;color:rgba(255,255,255,0.6);font-size:12px; }',
            '.ks-result-select { padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.35);color:#fff;font-size:12px;font-family:inherit;cursor:pointer; }',
            '.ks-result-select:focus { outline:none;border-color:#667eea; }',
            '.ks-tooltip { position:fixed;z-index:' + (MODAL_Z_INDEX + 1) + ';max-width:min(480px,80vw);padding:8px 10px;border-radius:8px;background:rgba(18,18,30,0.98);border:1px solid rgba(255,255,255,0.16);box-shadow:0 6px 20px rgba(0,0,0,0.55);color:#fff;font-size:13px;line-height:1.5;white-space:normal;word-break:break-word;pointer-events:none; }'
        ].join('\n');
        document.head.appendChild(style);
        __ksStylesInjected = true;
    }

    const MODAL_Z_INDEX = 10000;

    function createModalBase(title, contentHtml, onClose) {
        const modal = document.createElement('div');
        modal.className = 'ks-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);display:flex;justify-content:center;align-items:center;z-index:' + MODAL_Z_INDEX + ';backdrop-filter:blur(4px);overflow-y:auto;padding:20px;box-sizing:border-box;';

        const modalContent = document.createElement('div');
        modalContent.style.cssText = 'background:linear-gradient(135deg,#1e1e2e 0%,#2d2d44 100%);border-radius:16px;padding:24px;max-width:520px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);margin:auto;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.1);';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'color:#fff;font-size:18px;font-weight:600;';
        titleEl.textContent = title;

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'background:rgba(255,255,255,0.1);border:none;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:14px;transition:all 0.2s;';
        closeBtn.onmouseover = function() { this.style.background = 'rgba(244,67,54,0.3)'; };
        closeBtn.onmouseout = function() { this.style.background = 'rgba(255,255,255,0.1)'; };
        closeBtn.onclick = function() {
            if (onClose) onClose();
            modal.remove();
        };

        header.appendChild(titleEl);
        header.appendChild(closeBtn);
        modalContent.appendChild(header);

        const body = document.createElement('div');
        body.innerHTML = contentHtml;
        modalContent.appendChild(body);

        modal.appendChild(modalContent);

        modal.addEventListener('click', function(e) {
            if (e.target === modal) {
                if (onClose) onClose();
                modal.remove();
            }
        });

        document.body.appendChild(modal);
        return modal;
    }

    function closeAllModals() {
        const modals = document.querySelectorAll('.ks-modal');
        modals.forEach(function(modal) {
            modal.remove();
        });
        destroyTitleTooltip();
    }

    function showLoading(message, progress) {
        closeAllModals();
        const hasProgress = progress && typeof progress.processed === 'number' && typeof progress.total === 'number';
        const textMsg = message || '加载中...';
        const contentHtml = hasProgress
            ? '<div style="text-align:center;padding:20px;">' +
                '<div style="width:48px;height:48px;margin:0 auto 16px;border:4px solid rgba(255,255,255,0.1);border-top-color:#667eea;border-radius:50%;animation:ks-spin 1s linear infinite;"></div>' +
                '<div id="ks-auto-message" style="color:#fff;font-size:16px;margin-bottom:8px;">' + textMsg + '</div>' +
                '<div id="ks-auto-progress" style="color:rgba(255,255,255,0.6);font-size:13px;">' + String(progress.processed) + '/' + String(progress.total) + '</div>' +
              '</div>'
            : '<div style="text-align:center;padding:20px;">' +
                '<div style="width:48px;height:48px;margin:0 auto 16px;border:4px solid rgba(255,255,255,0.1);border-top-color:#667eea;border-radius:50%;animation:ks-spin 1s linear infinite;"></div>' +
                '<div style="color:#fff;font-size:16px;margin-bottom:8px;">' + textMsg + '</div>' +
              '</div>';
        return createModalBase('请稍候', contentHtml, null);
    }

    function showError(message, detail, onRetry) {
        closeAllModals();
        const contentHtml = `
            <div style="padding:10px 0;">
                <div style="text-align:center;font-size:48px;margin-bottom:16px;">❌</div>
                <div style="color:#f44336;font-size:18px;font-weight:500;text-align:center;margin-bottom:12px;">${message}</div>
                ${detail ? `<div style="color:rgba(255,255,255,0.7);font-size:14px;text-align:center;margin-bottom:16px;">${detail}</div>` : ''}
                <div style="display:flex;gap:10px;justify-content:center;margin-top:20px;">
                    ${onRetry ? '<button class="ks-btn ks-btn-primary" id="ks-retry-btn">重试</button>' : ''}
                    <button class="ks-btn ks-btn-secondary" id="ks-close-btn">关闭</button>
                </div>
            </div>
        `;
        const modal = createModalBase('错误', contentHtml, null);

        if (onRetry) {
            document.getElementById('ks-retry-btn').onclick = function() {
                modal.remove();
                onRetry();
            };
        }
        document.getElementById('ks-close-btn').onclick = function() {
            modal.remove();
        };
    }

    function showSuccess(fields, onRefresh) {
        closeAllModals();
        const config = getConfig();
        // 来自手动修改搜索词的重试流程，不触发自动刷新
        const fromKeywordEdit = window.__ks_fromKeywordEdit === true;
        const shouldAutoRefresh = config.autoRefresh !== false && !fromKeywordEdit;
        const autoRefreshMsg = shouldAutoRefresh
            ? '页面将在 2 秒后自动刷新...'
            : '自动刷新已关闭，可手动点击刷新按钮';
        const contentHtml = `
            <div style="padding:10px 0;">
                <div style="text-align:center;font-size:48px;margin-bottom:16px;">✅</div>
                <div style="color:#4caf50;font-size:18px;font-weight:500;text-align:center;margin-bottom:16px;">元数据更新成功</div>
                ${fields && fields.length > 0 ? `
                    <div style="background:rgba(76,175,80,0.1);border-radius:8px;padding:12px;margin-bottom:16px;">
                        <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-bottom:8px;">已更新字段:</div>
                        ${fields.map(function(f) { return '<span style="display:inline-block;background:rgba(76,175,80,0.2);color:#4caf50;padding:4px 10px;border-radius:6px;font-size:13px;margin:4px 4px 4px 0;">' + f + '</span>'; }).join('')}
                    </div>
                ` : ''}
                <div style="color:rgba(255,255,255,0.5);font-size:13px;text-align:center;margin-bottom:16px;">${autoRefreshMsg}</div>
                <div style="display:flex;gap:10px;justify-content:center;margin-top:20px;">
                    <button class="ks-btn ks-btn-secondary" id="ks-close-btn-2">关闭</button>
                    <button class="ks-btn ks-btn-primary" id="ks-refresh-btn">立即刷新</button>
                </div>
            </div>
        `;
        const modal = createModalBase('成功', contentHtml, null);

        document.getElementById('ks-close-btn-2').onclick = function() {
            modal.remove();
        };
        document.getElementById('ks-refresh-btn').onclick = function() {
            modal.remove();
            if (onRefresh) {
                onRefresh();
            } else {
                window.location.reload();
            }
        };

        if (shouldAutoRefresh) {
            setTimeout(function() {
                if (document.body.contains(modal)) {
                    modal.remove();
                    window.location.reload();
                }
            }, 2000);
        }
    }

    // ============================================================
    // 10. 刮削源选择菜单
    // ============================================================

    function showScraperSourceMenu() {
        closeAllModals();

        const contentHtml = `
            <div style="padding:4px 0;">
                <div style="color:rgba(255,255,255,0.7);font-size:14px;margin-bottom:16px;">请选择刮削数据源:</div>

                <div class="ks-source-card" data-source="bangumi" style="background:rgba(255,255,255,0.05);border-radius:12px;padding:16px;margin-bottom:12px;border:1px solid rgba(255,255,255,0.08);cursor:pointer;transition:all 0.3s ease;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <span style="color:#fff;font-size:16px;font-weight:500;">🎌 Bangumi (番组计划)</span>
                        <span style="font-size:12px;background:rgba(76,175,80,0.2);color:#4caf50;padding:4px 8px;border-radius:6px;">推荐</span>
                    </div>
                    <div style="color:rgba(255,255,255,0.6);font-size:13px;margin-bottom:12px;">动漫/漫画数据库，中文支持良好，无需认证</div>
                    <button class="ks-btn ks-btn-primary ks-btn-block" style="width:100%;padding:10px;">选择此源</button>
                </div>

                <div class="ks-source-card" data-source="fanza" style="background:rgba(255,255,255,0.05);border-radius:12px;padding:16px;margin-bottom:12px;border:1px solid rgba(255,255,255,0.08);cursor:pointer;transition:all 0.3s ease;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <span style="color:#fff;font-size:16px;font-weight:500;">🌸 Fanza / DMM (同人本)</span>
                        <span style="font-size:12px;background:rgba(255,152,0,0.2);color:#ff9800;padding:4px 8px;border-radius:6px;">新</span>
                    </div>
                    <div style="color:rgba(255,255,255,0.6);font-size:13px;margin-bottom:12px;">日本同人本/成人漫画数据库，日文数据，无需认证</div>
                    <button class="ks-btn ks-btn-primary ks-btn-block" style="width:100%;padding:10px;">选择此源</button>
                </div>

                <div style="color:rgba(255,255,255,0.4);font-size:13px;text-align:center;margin:16px 0 8px 0;">更多数据源 (MangaDex, AniList) 即将推出...</div>
            </div>
        `;

        const modal = createModalBase('选择刮削源', contentHtml, null);

        const bangumiCard = modal.querySelector('.ks-source-card[data-source="bangumi"]');
        bangumiCard.addEventListener('click', function() {
            modal.remove();
            startScrapeProcess('bangumi');
        });

        const fanzaCard = modal.querySelector('.ks-source-card[data-source="fanza"]');
        fanzaCard.addEventListener('click', function() {
            modal.remove();
            startScrapeProcess('fanza');
        });
    }

    // ============================================================
    // 11. 搜索结果选择界面
    // ============================================================

    // 结果类型过滤档位。只有 Bangumi v0 的结果自带 series 标记，
    // 旧版降级接口与 Fanza 没有这个概念（对应结果 isSeries 为 null）。
    const RESULT_TYPE_ALL = 'all';
    const RESULT_TYPE_SERIES = 'series';
    const RESULT_TYPE_VOLUME = 'volume';
    const RESULT_TYPE_LABELS = { all: '全部', series: '仅系列', volume: '仅单行本' };
    // 「显示数量」下拉的预设档位（配置里的自定义值会动态补进去）
    const RESULT_VISIBLE_PRESETS = [10, 25, 50];

    function escapeHtmlText(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---------------- 11.1 长标题悬浮提示 ----------------
    // 结果卡片里的标题行是 nowrap + ellipsis，被截断时用固定定位的提示层显示完整文字。
    // 提示层挂在 document.body 上（而不是弹窗内部），避免被弹窗的 overflow 裁掉。

    let titleTooltipEl = null;
    let titleTooltipResizeBound = false;

    function hideTitleTooltip() {
        if (titleTooltipEl) titleTooltipEl.style.display = 'none';
    }

    /** 关闭弹窗时清理提示层与全局监听，避免残留 DOM / 监听器 */
    function destroyTitleTooltip() {
        hideTitleTooltip();
        if (titleTooltipResizeBound) {
            window.removeEventListener('resize', hideTitleTooltip, true);
            titleTooltipResizeBound = false;
        }
        if (titleTooltipEl && titleTooltipEl.parentNode) {
            titleTooltipEl.parentNode.removeChild(titleTooltipEl);
        }
        titleTooltipEl = null;
    }

    function ensureTitleTooltip() {
        if (titleTooltipEl && document.body.contains(titleTooltipEl)) return titleTooltipEl;

        titleTooltipEl = document.createElement('div');
        titleTooltipEl.className = 'ks-tooltip';
        titleTooltipEl.style.display = 'none';
        document.body.appendChild(titleTooltipEl);

        if (!titleTooltipResizeBound) {
            window.addEventListener('resize', hideTitleTooltip, true);
            titleTooltipResizeBound = true;
        }
        return titleTooltipEl;
    }

    /** 在锚点元素下方显示提示，空间不足时翻到上方，并收敛到视口内 */
    function showTitleTooltip(anchor, text) {
        if (!anchor || !text) return;

        const tip = ensureTitleTooltip();
        tip.textContent = text;
        tip.style.display = 'block';

        const tipRect = tip.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        const margin = 8;

        let top = anchorRect.bottom + 6;
        if (top + tipRect.height > window.innerHeight - margin) {
            const above = anchorRect.top - tipRect.height - 6;
            top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - tipRect.height);
        }

        let left = anchorRect.left;
        if (left + tipRect.width > window.innerWidth - margin) {
            left = window.innerWidth - margin - tipRect.width;
        }
        if (left < margin) left = margin;

        tip.style.top = Math.max(margin, top) + 'px';
        tip.style.left = left + 'px';
    }

    /**
     * 绑定标题悬浮提示（事件委托：列表重渲染后无需重新绑定）。
     * 只有标题真的被 CSS 截断（scrollWidth > clientWidth）时才显示提示。
     */
    function bindTitleTooltipDelegates(listEl) {
        listEl.addEventListener('mouseover', function(e) {
            const el = e.target && e.target.closest ? e.target.closest('[data-full-text]') : null;
            if (!el) return;
            const fullText = el.getAttribute('data-full-text') || '';
            if (!fullText) return;
            if (el.scrollWidth <= el.clientWidth + 1) return;   // 没被截断就不提示
            showTitleTooltip(el, fullText);
        });

        listEl.addEventListener('mouseout', function(e) {
            const el = e.target && e.target.closest ? e.target.closest('[data-full-text]') : null;
            if (!el) return;
            hideTitleTooltip();
        });

        // 列表滚动会让提示位置失效，滚动时直接收起
        listEl.addEventListener('scroll', hideTitleTooltip);
    }

    /**
     * 搜索结果选择界面。
     * context（收成单个对象，避免参数过多）：
     *   results    —— 已加载的结果数组
     *   total      —— 接口给出的命中总数（未知传 null）
     *   via        —— 'v0' | 'legacy'
     *   source     —— 'bangumi' | 'fanza'
     *   pageType   —— 'series' | 'book'
     *   keyword    —— 当前搜索词
     *   notice     —— 降级提示文案
     *   onSelect   —— 选中结果后的回调
     *   onRetry    —— 修改搜索词后重试的回调
     *   onLoadMore —— 加载下一页的回调（仅 Bangumi v0 提供），
     *                 接收 offset，返回 Promise<{ results, total }>
     */
    function showSearchResults(context) {
        closeAllModals();

        const ctx = context || {};
        const source = ctx.source || '';
        const pageType = ctx.pageType || '';
        const initialResults = Array.isArray(ctx.results) ? ctx.results : [];
        const keyword = ctx.keyword || '';
        const notice = ctx.notice || '';
        const onSelect = ctx.onSelect;
        const onRetry = ctx.onRetry;
        const onLoadMore = ctx.onLoadMore;

        const safeKeyword = escapeHtmlText(keyword);

        if (initialResults.length === 0) {
            const retryHtml = `
                <div style="padding:10px 0;">
                    <div style="text-align:center;font-size:48px;margin-bottom:16px;">🔍</div>
                    <div style="color:#f44336;font-size:18px;font-weight:500;text-align:center;margin-bottom:8px;">未找到匹配结果</div>
                    <div style="color:rgba(255,255,255,0.6);font-size:13px;text-align:center;margin-bottom:20px;">
                        当前搜索词可能过于精确，可手动修改后重试
                    </div>
                    ${notice ? '<div style="color:#ffc107;font-size:12px;text-align:center;margin-bottom:16px;">提示：' + escapeHtmlText(notice) + '</div>' : ''}

                    <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;margin-bottom:20px;">
                        <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-bottom:8px;">搜索词：</div>
                        <input id="ks-keyword-input" type="text" value="${safeKeyword}"
                               style="width:calc(100% - 20px);padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.3);color:#fff;font-size:14px;font-family:inherit;">
                    </div>

                    <div style="display:flex;gap:10px;justify-content:center;">
                        <button class="ks-btn ks-btn-primary" id="ks-retry-btn">重新搜索</button>
                        <button class="ks-btn ks-btn-secondary" id="ks-cancel-btn">取消</button>
                    </div>
                </div>
            `;
            const modal = createModalBase('未找到结果 — 手动修改搜索词', retryHtml, null);

            const input = document.getElementById('ks-keyword-input');
            if (input) {
                setTimeout(function() { input.focus(); input.select(); }, 50);
                input.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') document.getElementById('ks-retry-btn').click();
                });
            }
            document.getElementById('ks-retry-btn').onclick = function() {
                const newKeyword = document.getElementById('ks-keyword-input').value.trim();
                if (newKeyword && newKeyword.length > 0) {
                    modal.remove();
                    if (onRetry) onRetry(newKeyword);
                }
            };
            document.getElementById('ks-cancel-btn').onclick = function() {
                modal.remove();
            };
            return;
        }

        function buildCardHtml(result, index) {
            let safeImage = '';
            if (result.image) {
                let imgUrl = String(result.image);
                if (imgUrl.indexOf('//') === 0) {
                    imgUrl = 'https:' + imgUrl;
                } else if (imgUrl.indexOf('http') !== 0 && imgUrl.indexOf('/') === 0) {
                    imgUrl = 'https://www.dmm.co.jp' + imgUrl;
                }
                safeImage = imgUrl.replace(/"/g, '&quot;');
            }
            const safeTitle = String(result.title || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            const safeOriginal = String(result.originalTitle || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            const safeSummary = String(result.summary || '').replace(/</g, '&lt;').replace(/"/g, '&quot;').substring(0, 120);
            const safeAirDate = String(result.airDate || '').replace(/"/g, '&quot;');

            const seriesBadge = typeof result.isSeries === 'boolean'
                ? `<span style="color:${result.isSeries ? '#4caf50' : 'rgba(255,255,255,0.5)'};background:rgba(255,255,255,0.07);padding:2px 6px;border-radius:4px;">${result.isSeries ? '系列' : '单行本'}</span>`
                : '';

            // 每条结果都必须标明来源：兜底命中时列表里可能是駿河屋的数据
            const sourceBadge = result.sourceLabel
                ? `<span style="color:#ffd54f;background:rgba(255,213,79,0.14);padding:2px 6px;border-radius:4px;">${escapeHtmlText(result.sourceLabel)}</span>`
                : '';

            return `
                <div class="ks-result-card" data-index="${index}" style="background:rgba(255,255,255,0.05);border-radius:12px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.08);cursor:pointer;transition:all 0.3s ease;">
                    <div style="display:flex;gap:12px;">
                        ${safeImage ? `
                            <img src="${safeImage}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" style="width:60px;height:80px;object-fit:cover;border-radius:6px;flex-shrink:0;">
                        ` : `
                            <div style="width:60px;height:80px;background:rgba(255,255,255,0.05);border-radius:6px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.3);font-size:24px;flex-shrink:0;">📚</div>
                        `}
                        <div style="flex:1;min-width:0;">
                            <div class="ks-truncate-text" data-full-text="${escapeHtmlText(result.title)}" style="color:#fff;font-size:15px;font-weight:500;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeTitle}</div>
                            ${safeOriginal && safeOriginal !== safeTitle ? `
                                <div class="ks-truncate-text" data-full-text="${escapeHtmlText(result.originalTitle)}" style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeOriginal}</div>
                            ` : ''}
                            <div style="display:flex;gap:8px;align-items:center;font-size:12px;margin-top:6px;flex-wrap:wrap;">
                                ${sourceBadge}
                                ${seriesBadge}
                                ${result.rating ? `<span style="color:#ffc107;">★ ${String(result.rating)}</span>` : ''}
                                ${safeAirDate ? `<span style="color:rgba(255,255,255,0.4);">📅 ${safeAirDate}</span>` : ''}
                            </div>
                            ${safeSummary ? `
                                <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-top:6px;line-height:1.5;overflow:hidden;-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;">${safeSummary}...</div>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `;
        }

        // 只有 Bangumi v0 的结果带 series 标记，其它情况不提供类型过滤
        const hasSeriesFlag = source === 'bangumi' && initialResults.some(function(result) {
            return typeof result.isSeries === 'boolean';
        });

        const state = {
            loaded: initialResults.slice(),
            total: typeof ctx.total === 'number' ? ctx.total : null,
            // 系列页默认只看系列主条目，书籍页默认只看单行本 / 分卷
            typeFilter: !hasSeriesFlag
                ? RESULT_TYPE_ALL
                : (pageType === 'series' ? RESULT_TYPE_SERIES : (pageType === 'book' ? RESULT_TYPE_VOLUME : RESULT_TYPE_ALL)),
            visibleCount: getSearchVisibleCount(),   // 0 表示显示全部
            loadingMore: false
        };

        function passesTypeFilter(result) {
            if (state.typeFilter === RESULT_TYPE_ALL) return true;
            // 类型未知（旧接口降级 / 非 Bangumi 源）的结果在任何档位下都展示，避免误藏结果
            if (typeof result.isSeries !== 'boolean') return true;
            return state.typeFilter === RESULT_TYPE_SERIES ? result.isSeries === true : result.isSeries === false;
        }

        function getFilteredResults() {
            return state.loaded.filter(passesTypeFilter);
        }

        function getVisibleResults() {
            const filtered = getFilteredResults();
            if (!state.visibleCount || state.visibleCount <= 0) return filtered;
            return filtered.slice(0, state.visibleCount);
        }

        function buildVisibleCountOptions() {
            const values = RESULT_VISIBLE_PRESETS.slice();
            if (state.visibleCount > 0 && values.indexOf(state.visibleCount) === -1) {
                values.push(state.visibleCount);
            }
            values.sort(function(a, b) { return a - b; });
            return values.map(function(value) {
                return '<option value="' + value + '">' + value + '</option>';
            }).join('') + '<option value="0">全部</option>';
        }

        const typeFilterHtml = hasSeriesFlag
            ? `<label class="ks-result-control">
                   <span>结果类型</span>
                   <select id="ks-result-type-filter" class="ks-result-select">
                       ${Object.keys(RESULT_TYPE_LABELS).map(function(key) {
                           return '<option value="' + key + '">' + RESULT_TYPE_LABELS[key] + '</option>';
                       }).join('')}
                   </select>
               </label>`
            : '';

        const resultsHtml = `
            <div style="padding:4px 0;">
                <div id="ks-results-count" style="color:rgba(255,255,255,0.7);font-size:14px;margin-bottom:12px;"></div>
                ${notice ? '<div style="color:#ffc107;font-size:12px;margin:-6px 0 12px 0;">提示：' + escapeHtmlText(notice) + '</div>' : ''}
                <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px;">
                    ${typeFilterHtml}
                    <label class="ks-result-control">
                        <span>显示数量</span>
                        <select id="ks-result-visible-count" class="ks-result-select">${buildVisibleCountOptions()}</select>
                    </label>
                </div>
                <div id="ks-results-list" style="max-height:60vh;overflow-y:auto;padding-right:4px;"></div>
                <div id="ks-results-empty" style="display:none;padding:16px 0;text-align:center;"></div>
                <div id="ks-load-more-wrap" style="display:none;margin-top:12px;text-align:center;"></div>
                ${onRetry && keyword ? `
                    <div style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;">
                        <button class="ks-btn ks-btn-retry" id="ks-change-keyword-btn" style="border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.8);">✏️ 修改搜索词重新搜索</button>
                    </div>
                ` : ''}
            </div>
        `;

        const modal = createModalBase('搜索结果', resultsHtml, null);

        const listEl = modal.querySelector('#ks-results-list');
        const countEl = modal.querySelector('#ks-results-count');
        const emptyEl = modal.querySelector('#ks-results-empty');
        const loadMoreWrap = modal.querySelector('#ks-load-more-wrap');
        const typeFilterEl = modal.querySelector('#ks-result-type-filter');
        const visibleCountEl = modal.querySelector('#ks-result-visible-count');

        // 当前实际渲染出来的结果（data-index 以此为下标）
        let visibleResults = [];

        function updateCountLine() {
            const filtered = getFilteredResults();
            let text = state.total != null
                ? '共 ' + state.total + ' 条结果，已加载 ' + state.loaded.length + ' 条'
                : '已加载 ' + state.loaded.length + ' 条结果';
            text += '，当前显示 ' + visibleResults.length + ' 条';
            if (state.typeFilter !== RESULT_TYPE_ALL) {
                text += '（过滤：' + RESULT_TYPE_LABELS[state.typeFilter] + '，符合 ' + filtered.length + ' 条）';
            }
            countEl.textContent = text;
        }

        function updateLoadMoreButton() {
            if (!onLoadMore || state.total == null || state.loaded.length >= state.total) {
                loadMoreWrap.style.display = 'none';
                loadMoreWrap.innerHTML = '';
                return;
            }
            loadMoreWrap.style.display = 'block';
            loadMoreWrap.innerHTML = '<button class="ks-btn ks-btn-secondary" id="ks-load-more-btn">加载更多（还有 ' +
                (state.total - state.loaded.length) + ' 条）</button>';
            const btn = document.getElementById('ks-load-more-btn');
            btn.onclick = function() { handleLoadMore(btn); };
        }

        function renderResults(options) {
            const opts = options || {};
            const prevScrollTop = opts.keepScroll ? listEl.scrollTop : 0;

            visibleResults = getVisibleResults();
            listEl.innerHTML = visibleResults.map(buildCardHtml).join('');

            if (visibleResults.length === 0) {
                // 过滤后一条不剩：提示并用一键切回「全部」兜底，而不是伪装成“搜索无结果”
                listEl.style.display = 'none';
                emptyEl.style.display = 'block';
                emptyEl.innerHTML = `
                    <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-bottom:12px;">
                        当前过滤条件下没有结果（已加载 ${state.loaded.length} 条）
                    </div>
                    <button class="ks-btn ks-btn-secondary" id="ks-show-all-btn">显示全部 ${state.loaded.length} 条结果</button>
                `;
                document.getElementById('ks-show-all-btn').onclick = function() {
                    state.typeFilter = RESULT_TYPE_ALL;
                    if (typeFilterEl) typeFilterEl.value = RESULT_TYPE_ALL;
                    renderResults();
                };
            } else {
                listEl.style.display = 'block';
                emptyEl.style.display = 'none';
                emptyEl.innerHTML = '';
            }

            listEl.scrollTop = prevScrollTop;
            updateCountLine();
            updateLoadMoreButton();
        }

        async function handleLoadMore(btn) {
            if (state.loadingMore) return;
            state.loadingMore = true;
            btn.disabled = true;
            btn.textContent = '加载中...';

            try {
                const page = await onLoadMore(state.loaded.length);
                const known = {};
                const before = state.loaded.length;
                state.loaded.forEach(function(item) { known[item.id || item.url] = true; });
                ((page && page.results) || []).forEach(function(item) {
                    const key = item.id || item.url;
                    if (key && known[key]) return;
                    if (key) known[key] = true;
                    state.loaded.push(item);
                });
                if (page && typeof page.total === 'number') state.total = page.total;

                // 服务端这一页没给新数据时收掉按钮，避免反复请求同一个 offset
                if (state.loaded.length === before && state.total != null && state.total > before) {
                    state.total = before;
                }

                // 新加载的结果必须是可见的，否则「加载更多」看起来毫无反应
                state.visibleCount = 0;
                if (visibleCountEl) visibleCountEl.value = '0';
                state.loadingMore = false;
                renderResults({ keepScroll: true });
            } catch (e) {
                console.error('[KomgaScraper] Load more failed:', e);
                state.loadingMore = false;
                btn.disabled = false;
                btn.textContent = '加载失败，点击重试';
            }
        }

        if (typeFilterEl) {
            typeFilterEl.value = state.typeFilter;
            typeFilterEl.onchange = function() {
                state.typeFilter = typeFilterEl.value;
                renderResults();
            };
        }

        if (visibleCountEl) {
            visibleCountEl.value = String(state.visibleCount);
            visibleCountEl.onchange = function() {
                state.visibleCount = parseInt(visibleCountEl.value, 10) || 0;
                renderResults({ keepScroll: true });
            };
        }

        listEl.addEventListener('click', function(e) {
            const card = e.target && e.target.closest ? e.target.closest('.ks-result-card') : null;
            if (!card) return;
            const result = visibleResults[parseInt(card.getAttribute('data-index'), 10)];
            if (!result) return;
            hideTitleTooltip();
            modal.remove();
            onSelect(result);
        });

        bindTitleTooltipDelegates(listEl);
        // 弹窗整体滚动（含列表内部滚动）时收起提示层，避免提示停在旧位置
        modal.addEventListener('scroll', hideTitleTooltip, true);

        const changeKeywordBtn = document.getElementById('ks-change-keyword-btn');
        if (changeKeywordBtn) {
            changeKeywordBtn.onclick = function() {
                modal.remove();
                showSearchResults(Object.assign({}, ctx, { results: [], total: null }));
            };
        }

        renderResults();
    }

    // ============================================================
    // 12. 元数据预览编辑界面
    // ============================================================

    // Komga 系列状态枚举 -> 中文，仅用于预览弹窗的提示文案
    const KOMGA_STATUS_LABELS = {
        ONGOING: '连载中',
        ENDED: '已完结',
        ABANDONED: '弃坑',
        HIATUS: '休载'
    };

    function formatKomgaStatusLabel(value) {
        const raw = String(value || '').trim();
        if (!raw) return '空';
        return KOMGA_STATUS_LABELS[raw.toUpperCase()] || raw;
    }

    // 锁定字段的通用提示：预览里默认不勾选，但允许勾选覆盖（覆盖后 Komga 中该字段仍保持锁定）
    const LOCKED_FIELD_HINT = '已锁定：默认不勾选；勾选后将覆盖 Komga 中的当前值（锁定状态保持不变）。';

    /**
     * 「状态」字段已锁定时的提示文案：展示 Komga 现值与脚本判定值的差异，
     * 并说明勾选后会覆盖为脚本判定值（字段在 Komga 中保持锁定）。
     */
    function buildStatusLockHint(mappedMetadata, currentMetadata) {
        if (!mappedMetadata || !currentMetadata) return '';
        if (currentMetadata.statusLock !== true) return '';
        const detected = String(mappedMetadata.status || '').trim();
        const current = String(currentMetadata.status || '').trim();
        if (!detected || detected.toUpperCase() === current.toUpperCase()) return LOCKED_FIELD_HINT;
        return 'Komga 当前值：' + formatKomgaStatusLabel(current) + '（已锁定）／脚本判定：' +
            formatKomgaStatusLabel(detected) + '。勾选后将覆盖为脚本判定值，锁定状态保持不变。';
    }

    function showMetadataPreview(scrapeResult, currentData, pageType, source, onConfirm, seriesData) {
        closeAllModals();

        const config = getConfig();
        const currentMetadata = currentData && currentData.metadata ? currentData.metadata : {};
        // 书籍页：父系列的元数据 DTO（用于渲染「同步到系列」字段的锁定态；取不到时按未锁定处理）
        const currentSeriesMetadata = seriesData && seriesData.metadata ? seriesData.metadata : {};
        // 以抓到的数据自身来源为准：FANZA 流程兜底命中时拿到的是駿河屋的数据
        const mapSource = (scrapeResult && scrapeResult.source) ? scrapeResult.source : source;

        let mappedMetadata;
        if (mapSource === 'surugaya') {
            mappedMetadata = pageType === 'series'
                ? mapSurugaYaToSeries(scrapeResult, currentMetadata)
                : mapSurugaYaToBook(scrapeResult, currentMetadata);
        } else if (mapSource === 'fanza') {
            mappedMetadata = pageType === 'series'
                ? mapFanzaToSeries(scrapeResult, currentMetadata)
                : mapFanzaToBook(scrapeResult, currentMetadata);
        } else {
            mappedMetadata = pageType === 'series'
                ? mapBangumiToSeries(scrapeResult, currentMetadata)
                : mapBangumiToBook(scrapeResult, currentMetadata);
        }

        function isFieldLocked(key) {
            return currentMetadata[key + 'Lock'] === true;
        }

        function isSeriesFieldLocked(key) {
            return currentSeriesMetadata[key + 'Lock'] === true;
        }

        // 语言自动识别：仅系列页、且 Komga 系列当前 language 为空、且未被锁定时，
        // 按系列文件夹名的字符属性推断语言，作为可勾选字段呈现（不参与标题选择）
        let detectedLanguage = '';
        if (pageType === 'series' &&
            !String(currentMetadata.language || '').trim() &&
            currentMetadata.languageLock !== true) {
            detectedLanguage = detectLanguageFromFolderName(getSeriesFolderName(currentData));
            if (detectedLanguage) {
                mappedMetadata.language = detectedLanguage;
            }
        }

        const fields = [
            { key: 'title', label: '标题', type: 'text', value: mappedMetadata.title || '', checked: !isFieldLocked('title'), locked: isFieldLocked('title') },
            { key: 'summary', label: '简介', type: 'textarea', value: mappedMetadata.summary || '', checked: !isFieldLocked('summary'), locked: isFieldLocked('summary') }
        ];

        if (pageType === 'series') {
            fields.push({ key: 'titleSort', label: '排序标题', type: 'text', value: currentMetadata.titleSort || mappedMetadata.titleSort || mappedMetadata.title || '', checked: !isFieldLocked('titleSort'), locked: isFieldLocked('titleSort') });
            fields.push({
                key: 'status',
                label: '状态',
                type: 'text',
                value: mappedMetadata.status || '',
                checked: !isFieldLocked('status') && !!mappedMetadata.status,
                locked: isFieldLocked('status'),
                hint: buildStatusLockHint(mappedMetadata, currentMetadata)
            });
            if (mappedMetadata.totalBookCount) {
                fields.push({ key: 'totalBookCount', label: '书籍总数', type: 'text', value: String(mappedMetadata.totalBookCount), checked: !isFieldLocked('totalBookCount'), locked: isFieldLocked('totalBookCount') });
            }
            const publisherValue = String(mappedMetadata.publisher || '').trim();
            if (publisherValue) {
                fields.push({ key: 'publisher', label: '出版社', type: 'text', value: publisherValue, checked: !isFieldLocked('publisher'), locked: isFieldLocked('publisher') });
            }
            // 分级（仅系列级字段）：FANZA/駿河屋 判定为限制级时写 18；判不出/非限制级时 mappedMetadata 里没有该字段
            if (mappedMetadata.ageRating) {
                fields.push({ key: 'ageRating', label: '分级 (18禁)', type: 'text', value: String(mappedMetadata.ageRating), checked: !isFieldLocked('ageRating'), locked: isFieldLocked('ageRating') });
            }
            if (detectedLanguage) {
                fields.push({ key: 'language', label: '语言 (按文件夹名识别)', type: 'text', value: detectedLanguage, checked: !isFieldLocked('language'), locked: isFieldLocked('language') });
            }
        }

        if (pageType === 'book') {
            // 序号默认填文件名解析出的卷号（Komga 的 metadata.number 往往只是按位置重编号的
            // 结果，例如 1,2,5,7,10 会变成 1..5），解析不到才退回 Komga 当前值
            const metadataNumber = currentMetadata.number != null ? String(currentMetadata.number).trim() : '';
            const parsedVolume = extractVolumeNumberFromFileName(currentData && (currentData.name || fileNameFromUrl(currentData.url)));
            const currentNumber = parsedVolume != null ? String(parsedVolume) : metadataNumber;
            const currentNumberSort = parsedVolume != null
                ? String(parsedVolume)
                : (currentMetadata.numberSort != null && currentMetadata.numberSort !== '' ? String(currentMetadata.numberSort) : metadataNumber);
            fields.push({ key: 'number', label: '序号', type: 'text', value: currentNumber, checked: !isFieldLocked('number') && !!currentNumber, locked: isFieldLocked('number') });
            fields.push({ key: 'numberSort', label: '排序序号', type: 'text', value: currentNumberSort, checked: !isFieldLocked('numberSort') && !!currentNumberSort, locked: isFieldLocked('numberSort') });
            fields.push({ key: 'releaseDate', label: '发布日期', type: 'text', value: mappedMetadata.releaseDate || '', checked: !isFieldLocked('releaseDate') && !!mappedMetadata.releaseDate, locked: isFieldLocked('releaseDate') });
            fields.push({ key: 'isbn', label: 'ISBN', type: 'text', value: mappedMetadata.isbn || '', checked: !isFieldLocked('isbn') && !!mappedMetadata.isbn, locked: isFieldLocked('isbn') });
        }

        // 书籍页同步到所属系列：Komga 只在系列级有 title / titleSort / ageRating。
        // 仅 FANZA 流程（source === 'fanza'，含駿河屋兜底）且能确定所属系列时提供这些字段。
        if (pageType === 'book' && source === 'fanza' && currentData && currentData.seriesId) {
            const seriesTitleValue = String(mappedMetadata.title || '').trim();
            if (seriesTitleValue) {
                fields.push({ key: '__seriesTitle', label: '系列标题（同步到系列）', type: 'text', value: seriesTitleValue, checked: !isSeriesFieldLocked('title'), locked: isSeriesFieldLocked('title') });
                fields.push({ key: '__seriesTitleSort', label: '系列排序标题（同步到系列）', type: 'text', value: seriesTitleValue, checked: !isSeriesFieldLocked('titleSort'), locked: isSeriesFieldLocked('titleSort') });
            }
            if (mappedMetadata.ageRating) {
                fields.push({ key: '__seriesAgeRating', label: '系列分级 (18禁，同步到系列)', type: 'text', value: String(mappedMetadata.ageRating), checked: !isSeriesFieldLocked('ageRating'), locked: isSeriesFieldLocked('ageRating') });
            }
        }

        const hasAuthors = mappedMetadata.authors && mappedMetadata.authors.length > 0;
        const hasTags = mappedMetadata.tags && mappedMetadata.tags.length > 0;
        const hasLinks = scrapeResult.links && scrapeResult.links.length > 0;

        let previewHtml = '<div style="padding:4px 0;">';

        const safeLargeImage = (scrapeResult.largeImage || scrapeResult.image || '').replace(/"/g, '&quot;');
        const safeTitle = String(scrapeResult.title || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const safeOriginal = String(scrapeResult.originalTitle || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const safeUrl = String(scrapeResult.url || '#').replace(/"/g, '&quot;');

        previewHtml += `
            <div style="background:rgba(255,255,255,0.05);border-radius:12px;padding:12px;margin-bottom:20px;border:1px solid rgba(255,255,255,0.08);">
                <div style="display:flex;gap:12px;align-items:flex-start;">
                    ${safeLargeImage ? `
                        <img src="${safeLargeImage}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" style="width:80px;height:110px;object-fit:cover;border-radius:8px;flex-shrink:0;">
                    ` : `
                        <div style="width:80px;height:110px;background:rgba(255,255,255,0.05);border-radius:8px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.3);font-size:32px;flex-shrink:0;">📚</div>
                    `}
                    <div style="flex:1;min-width:0;">
                        <div style="color:#fff;font-size:16px;font-weight:500;margin-bottom:4px;">${safeTitle}</div>
                        ${safeOriginal && safeOriginal !== safeTitle ? `
                            <div style="color:rgba(255,255,255,0.5);font-size:13px;margin-bottom:8px;">${safeOriginal}</div>
                        ` : ''}
                        <div style="display:flex;gap:12px;font-size:13px;color:rgba(255,255,255,0.6);flex-wrap:wrap;">
                            ${scrapeResult.rating ? `<span>★ ${String(scrapeResult.rating)}</span>` : ''}
                            <span><a href="${safeUrl}" target="_blank" style="color:#667eea;text-decoration:none;">查看详情 →</a></span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        previewHtml += '<div style="color:rgba(255,255,255,0.7);font-size:14px;margin-bottom:12px;">勾选要更新的字段，可直接编辑内容:</div>';

        fields.forEach(function(field) {
            const isTextarea = field.type === 'textarea';
            const safeValue = String(field.value || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            const rowBg = field.locked ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.03)';
            const rowBorder = field.locked ? 'rgba(255,200,100,0.25)' : 'rgba(255,255,255,0.06)';
            const labelColor = field.locked ? 'rgba(255,255,255,0.5)' : '#fff';
            const lockBadge = field.locked ? `<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>` : '';
            // 锁定字段：默认不勾选，但允许勾选覆盖（覆盖后 Komga 中该字段仍保持锁定）
            const hintText = field.hint || (field.locked ? LOCKED_FIELD_HINT : '');
            previewHtml += `
                <div class="ks-field-row" style="background:${rowBg};border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid ${rowBorder};">
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;">
                        <input type="checkbox" class="ks-field-checkbox" data-field="${field.key}" data-locked="${field.locked ? 'true' : 'false'}" ${field.checked ? 'checked' : ''} style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:${labelColor};font-size:14px;font-weight:500;">${field.label}${lockBadge}</span>
                    </label>
                    ${isTextarea ? `
                        <textarea class="ks-field-input" data-field="${field.key}" style="width:calc(100% - 16px);min-height:80px;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;resize:vertical;font-family:inherit;line-height:1.5;">${safeValue}</textarea>
                    ` : `
                        <input type="text" class="ks-field-input" data-field="${field.key}" value="${safeValue}" style="width:calc(100% - 16px);padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
                    `}
                    ${hintText ? `
                        <div style="margin-top:6px;color:#ffb74d;font-size:12px;line-height:1.5;">${escapeHtmlText(hintText)}</div>
                    ` : ''}
                </div>
            `;
        });

        if (hasAuthors) {
            const authorLocked = currentMetadata.authorsLock === true;
            previewHtml += `
                <div class="ks-field-row" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.06);">
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;">
                        <input type="checkbox" class="ks-author-checkbox" ${authorLocked ? '' : 'checked'} style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:#fff;font-size:14px;font-weight:500;">作者 / 作画${authorLocked ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>' : ''}</span>
                    </label>
                    ${authorLocked ? `<div style="color:#ffb74d;font-size:12px;margin-bottom:8px;line-height:1.5;">${LOCKED_FIELD_HINT}</div>` : ''}
            `;
            mappedMetadata.authors.forEach(function(a, idx) {
                const safeName = String(a.name || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
                const safeRole = a.role === 'artist' ? '作画' : '作者';
                previewHtml += `
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                        <span style="color:rgba(255,255,255,0.6);font-size:12px;width:40px;flex-shrink:0;">${safeRole}</span>
                        <input type="text" class="ks-author-input" data-role="${a.role}" data-idx="${idx}" value="${safeName}" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
                    </div>
                `;
            });
            previewHtml += `</div>`;
        }

        if (hasTags) {
            const tagsLocked = currentMetadata.tagsLock === true;
            const safeTagText = mappedMetadata.tags.map(function(t) { return String(t).replace(/</g, '&lt;').replace(/"/g, '&quot;'); }).join(', ');
            previewHtml += `
                <div class="ks-field-row" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.06);">
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;">
                        <input type="checkbox" class="ks-tags-checkbox" ${tagsLocked ? '' : 'checked'} style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:#fff;font-size:14px;font-weight:500;">标签 (Tags)${tagsLocked ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>' : ''}</span>
                    </label>
                    ${tagsLocked ? `<div style="color:#ffb74d;font-size:12px;margin-bottom:8px;line-height:1.5;">${LOCKED_FIELD_HINT}</div>` : ''}
                    <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:8px;">多个标签请用英文逗号 "," 分隔</div>
                    <textarea class="ks-tags-input" style="width:calc(100% - 16px);min-height:60px;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;resize:vertical;font-family:inherit;line-height:1.5;">${safeTagText}</textarea>
                </div>
            `;
        }

        if (pageType === 'series') {
            // alternateTitles：显示和编辑中文/日文别名，格式每行 "label|title"
            const altTitlesRaw = Array.isArray(mappedMetadata.alternateTitles) && mappedMetadata.alternateTitles.length > 0
                ? mappedMetadata.alternateTitles
                : null;
            if (altTitlesRaw) {
                const altTitlesLocked = currentMetadata.alternateTitlesLock === true;
                const altText = altTitlesRaw.map(function(at) {
                    const lbl = String(at.label || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
                    const ttl = String(at.title || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
                    return lbl + '|' + ttl;
                }).join('\n');
                previewHtml += `
                    <div class="ks-field-row" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.06);">
                        <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;">
                            <input type="checkbox" class="ks-alt-titles-checkbox" ${altTitlesLocked ? '' : 'checked'} style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                            <span style="color:#fff;font-size:14px;font-weight:500;">别名 (Alternate Titles)${altTitlesLocked ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>' : ''}</span>
                        </label>
                        ${altTitlesLocked ? `<div style="color:#ffb74d;font-size:12px;margin-bottom:8px;line-height:1.5;">${LOCKED_FIELD_HINT}</div>` : ''}
                        <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:8px;">每行一个别名，格式: <code style="color:#ffc107;">label|title</code>（例: <code style="color:#ffc107;">中文|我的作品</code>）</div>
                        <textarea class="ks-alt-titles-input" style="width:calc(100% - 16px);min-height:60px;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;resize:vertical;font-family:inherit;line-height:1.5;">${altText}</textarea>
                    </div>
                `;
            }

            const rdLocked = currentMetadata.readingDirectionLock === true;
            const currentRd = (currentMetadata.readingDirection || '').toUpperCase();
            const defaultRd = 'RIGHT_TO_LEFT';
            const options = [
                { label: '从右到左（日漫 / 港台）', value: 'RIGHT_TO_LEFT' },
                { label: '从左到右（欧漫 / 美漫 / 国漫）', value: 'LEFT_TO_RIGHT' },
                { label: '纵向（Webtoon）', value: 'VERTICAL' },
                { label: '不修改', value: '' }
            ];
            let selectHtml = '';
            options.forEach(function(opt) {
                const selected = (currentRd && currentRd === opt.value)
                    ? 'selected'
                    : (!currentRd && opt.value === defaultRd ? 'selected' : '');
                selectHtml += '<option value="' + opt.value + '" ' + selected + '>' + opt.label + '</option>';
            });
            previewHtml += `
                <div class="ks-field-row" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.06);">
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;">
                        <input type="checkbox" class="ks-reading-direction-checkbox" ${rdLocked ? '' : 'checked'} style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:#fff;font-size:14px;font-weight:500;">阅读方向 (Reading Direction)${rdLocked ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>' : ''}</span>
                    </label>
                    ${rdLocked ? `<div style="color:#ffb74d;font-size:12px;margin-bottom:8px;line-height:1.5;">${LOCKED_FIELD_HINT}</div>` : ''}
                    <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:8px;">默认设置为从右到左，可根据实际漫画类型手动切换</div>
                    <select class="ks-reading-direction" style="width:calc(100% - 16px);padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
                        ${selectHtml}
                    </select>
                </div>
            `;
        }

        previewHtml += `
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.1);">
                <button class="ks-btn ks-btn-secondary" id="ks-cancel-btn">取消</button>
                <button class="ks-btn ks-btn-primary" id="ks-confirm-btn">确认写入</button>
            </div>
        `;

        previewHtml += '</div>';

        const modal = createModalBase('预览并编辑元数据', previewHtml, null);

        document.getElementById('ks-cancel-btn').onclick = function() {
            modal.remove();
        };

        document.getElementById('ks-confirm-btn').onclick = function() {
            const checkboxes = modal.querySelectorAll('.ks-field-checkbox');
            const selectedFields = {};
            const updatedFields = [];
            const fieldLabels = { title: '标题', titleSort: '排序标题', summary: '简介', status: '状态', number: '序号', numberSort: '排序序号', releaseDate: '发布日期', isbn: 'ISBN', pages: '页数', author: '作者', tags: '标签', readingDirection: '阅读方向', totalBookCount: '书籍总数', publisher: '出版社', language: '语言' };

            checkboxes.forEach(function(cb) {
                const fieldKey = cb.getAttribute('data-field');
                if (cb.checked) {
                    const input = modal.querySelector('.ks-field-input[data-field="' + fieldKey + '"]');
                    if (input) {
                        selectedFields[fieldKey] = input.value;
                        updatedFields.push(fieldLabels[fieldKey] || fieldKey);
                    }
                }
            });

            if (hasAuthors) {
                const authorCb = modal.querySelector('.ks-author-checkbox');
                if (authorCb && authorCb.checked) {
                    const authorInputs = modal.querySelectorAll('.ks-author-input');
                    const collectedAuthors = [];
                    authorInputs.forEach(function(inp) {
                        const nm = String(inp.value || '').trim();
                        if (nm) {
                            collectedAuthors.push({ name: nm, role: inp.getAttribute('data-role') || 'writer' });
                        }
                    });
                    if (collectedAuthors.length > 0) {
                        selectedFields.authors = collectedAuthors;
                        updatedFields.push('作者');
                    }
                }
            }

            if (hasLinks) {
                selectedFields.links = scrapeResult.links;
                updatedFields.push('来源链接');
            }

            if (hasTags) {
                const tagsCb = modal.querySelector('.ks-tags-checkbox');
                if (tagsCb && tagsCb.checked) {
                    const tagsInput = modal.querySelector('.ks-tags-input');
                    if (tagsInput) {
                        const rawTags = String(tagsInput.value || '').trim();
                        if (rawTags) {
                            const tagList = rawTags.split(/[,，]/).map(function(t) { return t.trim(); }).filter(function(t) { return t && t.length > 0; });
                            if (tagList.length > 0) {
                                selectedFields.tags = tagList;
                                updatedFields.push('标签');
                            }
                        }
                    }
                }
            }

            if (pageType === 'series') {
                const rdCb = modal.querySelector('.ks-reading-direction-checkbox');
                const rdSelect = modal.querySelector('.ks-reading-direction');
                if (rdCb && rdCb.checked && rdSelect) {
                    const rdValue = String(rdSelect.value || '').trim();
                    if (rdValue) {
                        selectedFields.readingDirection = rdValue;
                        updatedFields.push('阅读方向');
                    }
                }

                // alternateTitles：解析多行 "label|title" 格式为对象数组
                const altCb = modal.querySelector('.ks-alt-titles-checkbox');
                const altInput = modal.querySelector('.ks-alt-titles-input');
                if (altCb && altCb.checked && altInput) {
                    const rawAlt = String(altInput.value || '').trim();
                    if (rawAlt) {
                        const altLines = rawAlt.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l && l.length > 0; });
                        const altArr = [];
                        for (let ali = 0; ali < altLines.length; ali++) {
                            const line = altLines[ali];
                            const pipeIdx = line.indexOf('|');
                            if (pipeIdx === -1) continue;
                            const labelPart = line.substring(0, pipeIdx).trim();
                            const titlePart = line.substring(pipeIdx + 1).trim();
                            if (labelPart && titlePart) {
                                altArr.push({ label: labelPart, title: titlePart });
                            }
                        }
                        if (altArr.length > 0) {
                            selectedFields.alternateTitles = altArr;
                            updatedFields.push('别名');
                        }
                    }
                }
            }

            if (config.debug) console.log('[KomgaScraper] Selected fields for update:', selectedFields);

            modal.remove();
            onConfirm(selectedFields, updatedFields);
        };
    }

    // ============================================================
    // 13. 设置界面
    // ============================================================

    function showSettingsModal() {
        closeAllModals();

        const config = getConfig();

        let settingsHtml = '<div style="padding:4px 0;">';

        settingsHtml += `

            <div style="margin-bottom:20px;">
                <label style="color:#fff;font-size:14px;display:block;margin-bottom:8px;">⏱️ 请求频率限制</label>
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                    <input type="number" id="ks-setting-rate-limit" value="${config.rateLimit.minInterval}" min="500" max="30000" step="500" style="width:120px;padding:10px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
                    <span style="color:rgba(255,255,255,0.7);font-size:13px;">毫秒 (ms)</span>
                </div>
                <div style="color:rgba(255,255,255,0.4);font-size:12px;margin-top:4px;">默认 2000 毫秒，最小值 500 毫秒。<br>提高频率限制可防止被 Ban，降低可加快刮削速度。</div>
            </div>

            <div style="margin-bottom:20px;">
                <label style="color:#fff;font-size:14px;display:block;margin-bottom:8px;">🔎 搜索结果</label>
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                    <input type="number" id="ks-setting-search-fetch-limit" value="${getSearchFetchLimit()}" min="${SEARCH_FETCH_LIMIT_MIN}" max="${SEARCH_FETCH_LIMIT_MAX}" step="10" style="width:120px;padding:10px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
                    <span style="color:rgba(255,255,255,0.7);font-size:13px;">单次拉取条数 (10-100)</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                    <input type="number" id="ks-setting-search-visible-count" value="${getSearchVisibleCount()}" min="0" max="${SEARCH_VISIBLE_COUNT_MAX}" step="5" style="width:120px;padding:10px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
                    <span style="color:rgba(255,255,255,0.7);font-size:13px;">默认显示条数 (0 = 全部)</span>
                </div>
                <div style="color:rgba(255,255,255,0.4);font-size:12px;margin-top:4px;">默认拉取 50 条、显示 10 条。弹窗内仍可临时切换显示数量，命中更多时可用「加载更多」继续拉取。</div>
            </div>

            <div style="margin-bottom:20px;">
                <div style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="ks-setting-auto-refresh" ${config.autoRefresh ? 'checked' : ''} style="width:18px;height:18px;accent-color:#667eea;cursor:pointer;">
                    <label for="ks-setting-auto-refresh" style="color:rgba(255,255,255,0.7);font-size:13px;cursor:pointer;">刮削成功后自动刷新页面</label>
                </div>
            </div>

            <div style="margin-bottom:20px;">
                <div style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="ks-setting-debug" ${config.debug ? 'checked' : ''} style="width:18px;height:18px;accent-color:#667eea;cursor:pointer;">
                    <label for="ks-setting-debug" style="color:rgba(255,255,255,0.7);font-size:13px;cursor:pointer;">启用调试日志 (在浏览器 Console 中输出详细日志)</label>
                </div>
            </div>

            <div style="margin-bottom:20px;">
                <div style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="ks-setting-surugaya-bridge" ${config.surugayaBridgeTab !== false ? 'checked' : ''} style="width:18px;height:18px;accent-color:#667eea;cursor:pointer;">
                    <label for="ks-setting-surugaya-bridge" style="color:rgba(255,255,255,0.7);font-size:13px;cursor:pointer;">駿河屋 被 Cloudflare 拦下时自动开「桥接标签页」重取</label>
                </div>
                <div style="color:rgba(255,255,255,0.4);font-size:12px;margin-top:4px;">关闭后，駿河屋 兜底只会直连请求；本机 IP 被人机校验拦住时会直接报错。</div>
            </div>

            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.1);">
                <button class="ks-btn ks-btn-secondary" id="ks-reset-btn">恢复默认</button>
                <button class="ks-btn ks-btn-secondary" id="ks-settings-cancel-btn">取消</button>
                <button class="ks-btn ks-btn-primary" id="ks-save-btn">保存设置</button>
            </div>
        `;

        settingsHtml += '</div>';

        const modal = createModalBase('⚙️ 刮削设置', settingsHtml, null);

        document.getElementById('ks-settings-cancel-btn').onclick = function() {
            modal.remove();
        };

        document.getElementById('ks-reset-btn').onclick = function() {
            saveConfig(Object.assign({}, defaultConfig));
            alert('设置已恢复默认值');
            modal.remove();
        };

        document.getElementById('ks-save-btn').onclick = function() {
            const newConfig = getConfig();
            newConfig.rateLimit.minInterval = parseInt(document.getElementById('ks-setting-rate-limit').value) || 2000;
            const fetchLimit = parseInt(document.getElementById('ks-setting-search-fetch-limit').value, 10);
            newConfig.searchFetchLimit = isNaN(fetchLimit)
                ? defaultConfig.searchFetchLimit
                : Math.min(SEARCH_FETCH_LIMIT_MAX, Math.max(SEARCH_FETCH_LIMIT_MIN, fetchLimit));
            const visibleCount = parseInt(document.getElementById('ks-setting-search-visible-count').value, 10);
            newConfig.searchVisibleCount = isNaN(visibleCount)
                ? defaultConfig.searchVisibleCount
                : Math.min(SEARCH_VISIBLE_COUNT_MAX, Math.max(0, visibleCount));
            newConfig.autoRefresh = document.getElementById('ks-setting-auto-refresh').checked;
            newConfig.debug = document.getElementById('ks-setting-debug').checked;
            newConfig.surugayaBridgeTab = document.getElementById('ks-setting-surugaya-bridge').checked;

            saveConfig(newConfig);
            alert('设置已保存');
            modal.remove();
        };
    }

    // ============================================================
    // 14. 主流程控制
    // ============================================================

    async function startScrapeProcess(source, overrideKeyword) {
        try {
            const config = getConfig();
            // 来自手动修改搜索词的重试流程，不触发自动刷新
            if (overrideKeyword && overrideKeyword.length > 0) {
                window.__ks_fromKeywordEdit = true;
            } else {
                window.__ks_fromKeywordEdit = false;
            }
            if (config.debug) console.log('[KomgaScraper] Starting scrape process with source:', source, overrideKeyword ? ' / override keyword: ' + overrideKeyword : '');

            const pageType = getCurrentPageType();
            if (pageType !== 'series' && pageType !== 'book') {
                showError('不支持的页面', '请在系列详情页或书籍详情页使用刮削功能');
                return;
            }

            const pageId = extractIdFromUrl();
            if (!pageId) {
                showError('无法识别页面 ID', '请确认您在正确的页面上');
                return;
            }

            const loading = showLoading('正在获取页面信息...');

            let currentData;
            if (pageType === 'series') {
                currentData = await fetchSeriesData(pageId);
            } else {
                currentData = await fetchBookData(pageId);
            }

            if (!currentData) {
                loading.remove();
                showError('获取 Komga 数据失败', '请检查网络连接或页面权限');
                return;
            }

            let searchTitle;
            if (overrideKeyword && overrideKeyword.length > 0) {
                // 来自修改搜索词重试的场景 — 直接使用用户输入的关键词
                searchTitle = overrideKeyword;
            } else if (pageType === 'series') {
                searchTitle = currentData.metadata && currentData.metadata.title ? currentData.metadata.title : currentData.name;
            } else {
                const isFanza = source === 'fanza';
                const seriesTitle = currentData.seriesTitle ? currentData.seriesTitle.trim() : '';
                // 卷号以文件名为准：Komga 的 number 只是按位置重编号的结果，
                // 用它拼关键词会去搜错误的卷（如第10巻被当成第3巻）
                const parsedVolume = extractVolumeNumberFromFileName(currentData.name || fileNameFromUrl(currentData.url));
                const bookNumber = parsedVolume != null
                    ? String(parsedVolume)
                    : (currentData.metadata && currentData.metadata.number ? String(currentData.metadata.number).trim() : '');
                const bookName = (currentData.metadata && currentData.metadata.title) || currentData.name || '';

                if (isFanza) {
                    // FANZA/DMM 面向同人本：一本就是一个作品，绝大多数没有「卷」的概念，
                    // 拼上系列名只会把关键词搞得过窄（实测「系列名 + 书名」在 FANZA 上搜不到），
                    // 所以书名本身能用就直接用书名；只有书名缺失或只是纯卷标（第3話 / Vol.2）时才拼系列名
                    if (bookName && !isVolumeMarkerOnly(bookName)) {
                        searchTitle = bookName;
                    } else if (seriesTitle && bookName) {
                        searchTitle = seriesTitle + ' ' + bookName;
                    } else if (seriesTitle) {
                        searchTitle = seriesTitle;
                    } else {
                        searchTitle = currentData.name;
                    }
                } else {
                    if (seriesTitle && bookNumber) {
                        searchTitle = seriesTitle + ' ' + bookNumber;
                    } else if (seriesTitle) {
                        searchTitle = seriesTitle;
                    } else {
                        searchTitle = currentData.name;
                    }
                }
            }

            const cleanKeyword = cleanSearchKeyword(searchTitle);
            if (!cleanKeyword) {
                loading.remove();
                showError('无法获取有效的搜索关键词', '请确保系列/书籍有标题信息');
                return;
            }

            if (config.debug) console.log('[KomgaScraper] Searching for:', cleanKeyword);
            loading.remove();

            const isFanza = source === 'fanza';
            const sourceLabel = isFanza ? 'Fanza/DMM' : 'Bangumi';
            showLoading('正在搜索 ' + sourceLabel + ': ' + cleanKeyword);

            const doRetry = function(newKeyword) {
                startScrapeProcess(source, newKeyword);
            };

            let searchResults;
            let searchTotal = null;
            let searchVia = '';
            let searchNotice = '';
            try {
                if (isFanza) {
                    searchVia = 'fanza';
                    let fanzaError = null;
                    try {
                        const fanzaSearch = await scrapeFromFanza(cleanKeyword);
                        searchResults = fanzaSearch.results;
                        searchTotal = fanzaSearch.total;
                    } catch (fanzaErr) {
                        console.warn('[KomgaScraper] [Fanza] Search failed, will try Suruga-ya fallback:', fanzaErr);
                        fanzaError = fanzaErr;
                        searchResults = [];
                    }

                    // 駿河屋只作兜底：FANZA 无结果或请求失败时才查，两个源的结果绝不混排
                    if (searchResults.length === 0) {
                        let fallback = null;
                        let fallbackError = null;
                        try {
                            fallback = await searchSurugaYa(cleanKeyword);
                        } catch (surugayaErr) {
                            fallbackError = surugayaErr;
                        }

                        if (fallback && fallback.results.length > 0) {
                            searchResults = fallback.results;
                            searchTotal = fallback.total;
                            searchVia = 'surugaya';
                            searchNotice = (fanzaError
                                ? 'FANZA/DMM 搜索失败（' + describeFanzaBlocked(fanzaError.fanzaBlocked) + '）'
                                : 'FANZA/DMM 未找到结果')
                                + '，已自动改用「駿河屋」兜底';
                        } else if (fanzaError) {
                            // 兜底也没结果：优先报 FANZA 的原始错误（更有诊断价值）
                            throw fanzaError;
                        } else if (fallbackError) {
                            throw fallbackError;
                        } else {
                            searchNotice = 'FANZA/DMM 与 駿河屋 均未找到结果';
                        }
                    }
                } else {
                    // 分页只由 v0 承担：首屏按配置拉取，offset 由「加载更多」传入
                    const bangumiSearch = await scrapeFromBangumi(cleanKeyword, { offset: 0, limit: getSearchFetchLimit() });
                    searchResults = bangumiSearch.results;
                    searchTotal = bangumiSearch.total;
                    searchVia = bangumiSearch.via;
                    searchNotice = bangumiSearch.notice;
                }
            } catch (e) {
                loading.remove();
                if (e && e.bangumiApiError) {
                    const retryKeyword = cleanKeyword;
                    showError('Bangumi 搜索接口不可用', 'Bangumi 接口暂时无法访问（' + (e.message || '未知错误') +
                        '），通常是 Bangumi 源站问题，请稍后重试', function() {
                        startScrapeProcess(source, retryKeyword);
                    });
                    return;
                }
                if (e && e.fanzaBlocked) {
                    const retryKeyword = cleanKeyword;
                    showError('无法访问 FANZA/DMM', describeFanzaBlocked(e.fanzaBlocked) +
                        '（已尝试用駿河屋兜底，同样没有结果）', function() {
                        startScrapeProcess(source, retryKeyword);
                    });
                    return;
                }
                if (e && e.surugayaBlocked) {
                    const retryKeyword = cleanKeyword;
                    showError('无法访问 駿河屋', describeSurugayaBlocked(e.surugayaBlocked), function() {
                        startScrapeProcess(source, retryKeyword);
                    });
                    return;
                }
                showError('搜索请求失败', '请检查网络连接', function() {
                    startScrapeProcess(source);
                });
                return;
            }

            loading.remove();

            const onSelectResult = async function(selectedResult) {
                showLoading('正在获取详细数据...');
                let detail;
                const selectedSource = selectedResult && selectedResult.source ? selectedResult.source : source;
                if (selectedSource === 'surugaya') {
                    // 駿河屋 搜索列表页已含全部可用字段，不用再抓（且详情页有 Cloudflare 校验）
                    detail = selectedResult;
                } else if (isFanza) {
                    detail = await fetchFanzaDetail(selectedResult.url);
                } else {
                    detail = await fetchSubjectDetail(selectedResult.id);
                }

                // 书籍页需要父系列的元数据：把「系列标题 / 排序标题 / 分级」同步回所属系列时，
                // 要用它渲染锁定态（取不到时按未锁定处理，不阻断刮削）
                let seriesData = null;
                if (pageType === 'book' && isFanza && currentData && currentData.seriesId) {
                    seriesData = await fetchSeriesData(currentData.seriesId);
                }
                closeAllModals();

                if (!detail) {
                    showError('获取详情失败', '无法获取详细数据，将使用搜索结果');
                    showMetadataPreview(selectedResult, currentData, pageType, source, function(selectedFields, updatedFields) {
                        if (Object.keys(selectedFields).length === 0) {
                            showError('未选择任何字段', '请至少勾选一个要更新的字段');
                            return;
                        }
                        writeMetadataToKomga(pageType, pageId, selectedFields, updatedFields, currentData, seriesData);
                    }, seriesData);
                    return;
                }

                showMetadataPreview(detail, currentData, pageType, source, function(selectedFields, updatedFields) {
                    if (Object.keys(selectedFields).length === 0) {
                        showError('未选择任何字段', '请至少勾选一个要更新的字段');
                        return;
                    }

                    writeMetadataToKomga(pageType, pageId, selectedFields, updatedFields, currentData, seriesData);
                }, seriesData);
            };

            // 「加载更多」只在 v0 首屏结果上提供：旧接口降级没有总数、也无法稳定分页
            const onLoadMore = (!isFanza && searchVia === 'v0')
                ? async function(offset) {
                    const page = await scrapeFromBangumi(cleanKeyword, { offset: offset, limit: getSearchFetchLimit() });
                    return { results: page.results, total: page.total };
                }
                : null;

            showSearchResults({
                results: searchResults,
                total: searchTotal,
                via: searchVia,
                source: source,
                pageType: pageType,
                keyword: cleanKeyword,
                notice: searchNotice,
                onSelect: onSelectResult,
                onRetry: doRetry,
                onLoadMore: onLoadMore
            });

        } catch (e) {
            console.error('[KomgaScraper] Scrape process failed:', e);
            showError('刮削过程中发生错误', e.message || '请查看浏览器控制台获取详细信息');
        }
    }

    async function writeMetadataToKomga(pageType, pageId, metadata, updatedFields, currentData, seriesData) {
        try {
            const config = getConfig();

            const currentMetadata = currentData && currentData.metadata ? currentData.metadata : {};
            // 书籍页要同步到所属系列的字段（见 SERIES_SCOPED_FIELD_KEYS）：单独收集，绝不并入书籍 PATCH
            const currentSeriesMetadata = seriesData && seriesData.metadata ? seriesData.metadata : {};
            const seriesId = (seriesData && seriesData.id) || (currentData && currentData.seriesId) || '';
            const seriesPayload = {};
            const seriesUpdated = [];
            const seriesScalarKeys = [];
            const finalMetadata = {};
            const finalUpdated = [];
            const writtenScalarKeys = [];
            const fieldLabels = { title: '标题', titleSort: '排序标题', summary: '简介', status: '状态', number: '序号', numberSort: '排序序号', releaseDate: '发布日期', isbn: 'ISBN', author: '作者', authors: '作者', links: '来源链接', tags: '标签', readingDirection: '阅读方向', totalBookCount: '书籍总数', publisher: '出版社', language: '语言', ageRating: '分级', __seriesTitle: '系列标题', __seriesTitleSort: '系列排序标题', __seriesAgeRating: '系列分级' };

            if (config.debug) console.log('[KomgaScraper] Raw metadata from UI:', JSON.stringify(metadata, null, 2));

            Object.keys(metadata).forEach(function(key) {
                const value = metadata[key];

                // 系列级字段（书籍页同步到所属系列）：先归一化再单独收集，不进入书籍 PATCH
                // （Komga 的 BookMetadataUpdateDto 没有 title/titleSort/ageRating，混进去会让整个 PATCH 400）
                if (Object.prototype.hasOwnProperty.call(SERIES_SCOPED_FIELD_KEYS, key)) {
                    const targetKey = SERIES_SCOPED_FIELD_KEYS[key];
                    let normalized = null;
                    if (targetKey === 'ageRating') {
                        const num = Number(value);
                        if (Number.isInteger(num) && num >= 0 && num <= 99) normalized = num;
                    } else {
                        const text = value === null || value === undefined ? '' : String(value).trim();
                        if (text) normalized = text;
                    }
                    if (normalized === null) {
                        if (config.debug) console.log('[KomgaScraper] Skipping invalid series-scoped value:', key, value);
                        return;
                    }
                    seriesPayload[targetKey] = normalized;
                    seriesUpdated.push(fieldLabels[key] || key);
                    if (!isArrayField(targetKey)) {
                        seriesScalarKeys.push(targetKey);
                    }
                    return;
                }

                if (key === 'pages') return;

                if (key === 'links') {
                    const existingLinks = Array.isArray(currentMetadata.links) ? currentMetadata.links : [];
                    const incoming = Array.isArray(value) ? value : [];
                    const merged = mergeLinks(incoming, existingLinks);
                    if (merged.length > 0) {
                        finalMetadata.links = merged;
                        finalUpdated.push(fieldLabels.links || 'links');
                    }
                    return;
                }

                if (key === 'alternateTitles') {
                    // 预期格式：[{label: "中文", title: "xxx"}, {label: "日文", title: "yyy"}]
                    if (Array.isArray(value) && value.length > 0) {
                        const validTitles = value.filter(function(at) {
                            if (!at || !at.title) return false;
                            const lbl = String(at.label || '').trim();
                            const ttl = String(at.title || '').trim();
                            return lbl.length > 0 && ttl.length > 0 && ttl.length <= 300;
                        }).map(function(at) {
                            return { label: String(at.label || '').trim(), title: String(at.title || '').trim() };
                        });
                        if (validTitles.length > 0) {
                            finalMetadata.alternateTitles = validTitles;
                            finalUpdated.push('别名');
                            writtenScalarKeys.push('alternateTitles');
                        } else if (config.debug) {
                            console.log('[KomgaScraper] Skipping invalid alternateTitles value:', value);
                        }
                    }
                    return;
                }

                if (key === 'authors') {
                    if (Array.isArray(value) && value.length > 0) {
                        const validAuthors = value.filter(function(au) {
                            if (!au || !au.name) return false;
                            const nm = String(au.name).trim();
                            return nm.length > 0 && nm.length <= 100 && !looksLikeDate(nm);
                        }).map(function(au) {
                            return { name: String(au.name).trim(), role: au.role || 'writer' };
                        });
                        if (validAuthors.length > 0) {
                            finalMetadata.authors = validAuthors;
                            finalUpdated.push(fieldLabels.author || 'author');
                            writtenScalarKeys.push('authors');
                        }
                    }
                    return;
                }

                if (key === 'author') {
                    if (value && typeof value === 'string') {
                        const authorName = String(value).trim();
                        if (authorName && !looksLikeDate(authorName) && authorName.length <= 50) {
                            finalMetadata.authors = [{ name: authorName, role: 'writer' }];
                            finalUpdated.push(fieldLabels.author || 'author');
                            writtenScalarKeys.push('authors');
                        } else if (config.debug) {
                            console.log('[KomgaScraper] Skipping invalid author value:', value);
                        }
                    }
                    return;
                }

                if (key === 'tags') {
                    const existingTags = Array.isArray(currentMetadata.tags) ? currentMetadata.tags : [];
                    const incoming = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
                    const merged = mergeTags(incoming, existingTags);
                    if (merged.length > 0) {
                        finalMetadata.tags = merged;
                        finalUpdated.push('标签');
                    }
                    return;
                }

                if (key === 'releaseDate') {
                    if (value && typeof value === 'string' && looksLikeDate(value)) {
                        finalMetadata.releaseDate = String(value).trim();
                        finalUpdated.push(fieldLabels.releaseDate || 'releaseDate');
                        writtenScalarKeys.push('releaseDate');
                    } else if (config.debug) {
                        console.log('[KomgaScraper] Skipping invalid releaseDate value:', value);
                    }
                    return;
                }

                if (key === 'isbn') {
                    if (value && typeof value === 'string') {
                        const normalizedIsbn = normalizeIsbn(value);
                        if (normalizedIsbn) {
                            finalMetadata.isbn = normalizedIsbn;
                            finalUpdated.push(fieldLabels.isbn || 'isbn');
                            writtenScalarKeys.push('isbn');
                        } else if (config.debug) {
                            console.log('[KomgaScraper] Skipping invalid ISBN value:', value);
                        }
                    }
                    return;
                }

                if (key === 'readingDirection') {
                    if (value && typeof value === 'string') {
                        const rd = String(value).trim().toUpperCase();
                        if (['RIGHT_TO_LEFT', 'LEFT_TO_RIGHT', 'VERTICAL', 'WEBTOON'].indexOf(rd) !== -1) {
                            finalMetadata.readingDirection = rd;
                            finalUpdated.push(fieldLabels.readingDirection || 'readingDirection');
                            writtenScalarKeys.push('readingDirection');
                        } else if (config.debug) {
                            console.log('[KomgaScraper] Skipping invalid readingDirection value:', value);
                        }
                    }
                    return;
                }

                if (key === 'totalBookCount') {
                    if (value !== null && value !== undefined && value !== '') {
                        const num = Number(value);
                        if (Number.isInteger(num) && num > 0) {
                            finalMetadata.totalBookCount = num;
                            finalUpdated.push('书籍总数');
                            writtenScalarKeys.push('totalBookCount');
                        } else if (config.debug) {
                            console.log('[KomgaScraper] Skipping invalid totalBookCount value:', value);
                        }
                    }
                    return;
                }

                // ageRating 只存在于系列元数据（SeriesMetadataUpdateDto.ageRating: Int）
                if (key === 'ageRating') {
                    if (value !== null && value !== undefined && value !== '') {
                        const num = Number(value);
                        if (Number.isInteger(num) && num >= 0 && num <= 99) {
                            finalMetadata.ageRating = num;
                            finalUpdated.push(fieldLabels.ageRating || 'ageRating');
                            writtenScalarKeys.push('ageRating');
                        } else if (config.debug) {
                            console.log('[KomgaScraper] Skipping invalid ageRating value:', value);
                        }
                    }
                    return;
                }

                if (key === 'number' || key === 'numberSort') {
                    const text = value === null || value === undefined ? '' : String(value).trim();
                    if (!text) {
                        // 空值直接忽略，不写回也不加锁
                    } else if (key === 'numberSort') {
                        const sortValue = Number(text);
                        if (Number.isFinite(sortValue)) {
                            finalMetadata.numberSort = sortValue;
                            finalUpdated.push(fieldLabels.numberSort || 'numberSort');
                            writtenScalarKeys.push('numberSort');
                        } else if (config.debug) {
                            console.log('[KomgaScraper] Skipping invalid numberSort value:', value);
                        }
                    } else {
                        // Komga 的 number 是字符串字段（BookMetadataUpdateDto.number: String），
                        // 以字符串提交，避免依赖 Jackson 的数字->字符串隐式转换
                        finalMetadata.number = text;
                        finalUpdated.push(fieldLabels.number || 'number');
                        writtenScalarKeys.push('number');
                    }
                    return;
                }

                // language 只允许 BCP47 形式（Komga 侧有校验，非法值会让整个 PATCH 400）
                if (key === 'language') {
                    const lang = String(value || '').trim();
                    if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(lang)) {
                        finalMetadata.language = lang;
                        finalUpdated.push(fieldLabels.language || 'language');
                        writtenScalarKeys.push('language');
                    } else if (config.debug) {
                        console.log('[KomgaScraper] Skipping invalid language value:', value);
                    }
                    return;
                }

                // publisher 为空时跳过（不写回也不加锁），避免误清空 Komga 已有的出版社
                if (key === 'publisher') {
                    const publisherValue = String(value || '').trim();
                    if (publisherValue) {
                        finalMetadata.publisher = publisherValue;
                        finalUpdated.push(fieldLabels.publisher || 'publisher');
                        writtenScalarKeys.push('publisher');
                    } else if (config.debug) {
                        console.log('[KomgaScraper] Skipping empty publisher value');
                    }
                    return;
                }

                if (typeof value === 'string') {
                    finalMetadata[key] = value.trim();
                } else {
                    finalMetadata[key] = value;
                }
                finalUpdated.push(fieldLabels[key] || key);
                if (!isArrayField(key)) {
                    writtenScalarKeys.push(key);
                }
            });

            // 自动为写入的标量字段加锁，防止后续被 Komga 自带扫描覆盖
            writtenScalarKeys.forEach(function(key) {
                if (currentMetadata[key + 'Lock'] !== true) {
                    finalMetadata[key + 'Lock'] = true;
                }
            });

            if (Object.keys(seriesPayload).length > 0) {
                // 系列级字段加锁：沿用同一语义，目标字段当前未锁才发 Lock（已锁定则只更新值、保持锁定）
                seriesScalarKeys.forEach(function(key) {
                    if (currentSeriesMetadata[key + 'Lock'] !== true) {
                        seriesPayload[key + 'Lock'] = true;
                    }
                });
            }

            if (Object.keys(finalMetadata).length === 0 && Object.keys(seriesPayload).length === 0) {
                showError('无可用字段', '所有勾选的字段都包含无效值，无法写入');
                return;
            }

            if (config.debug) {
                console.log('[KomgaScraper] Writing metadata to Komga:', JSON.stringify(finalMetadata, null, 2));
                if (Object.keys(seriesPayload).length > 0) {
                    console.log('[KomgaScraper] Writing series metadata to Komga:', seriesId, JSON.stringify(seriesPayload, null, 2));
                }
            }

            showLoading('正在写入元数据到 Komga...');

            let success = true;
            let failureDetail = '';

            if (Object.keys(finalMetadata).length > 0) {
                if (pageType === 'series') {
                    success = await updateSeriesMetadata(pageId, finalMetadata);
                } else {
                    success = await updateBookMetadata(pageId, finalMetadata);
                }
                if (!success) {
                    failureDetail = pageType === 'series' ? '系列元数据写入失败' : '书籍元数据写入失败';
                }
            }

            // 书籍页：把系列级字段同步到所属系列（Komga 只在系列级有 title / titleSort / ageRating）
            if (success && Object.keys(seriesPayload).length > 0) {
                if (!seriesId) {
                    success = false;
                    failureDetail = '无法确定所属系列，系列标题 / 系列分级未同步';
                } else {
                    const seriesOk = await updateSeriesMetadata(seriesId, seriesPayload);
                    if (seriesOk) {
                        seriesUpdated.forEach(function(label) { finalUpdated.push(label); });
                    } else {
                        success = false;
                        failureDetail = '书籍已更新，但所属系列元数据写入失败';
                    }
                }
            }

            if (success) {
                if (config.debug) console.log('[KomgaScraper] Metadata updated successfully');
                showSuccess(finalUpdated, function() {
                    window.location.reload();
                });
            } else {
                showError('写入元数据失败', failureDetail || '请检查 API Key 或页面权限设置');
            }

        } catch (e) {
            console.error('[KomgaScraper] Failed to write metadata:', e);
            showError('写入元数据失败', e.message || '请查看浏览器控制台获取详细信息');
        }
    }

    // ============================================================
    // 14.5. 自动刮削（系列页面：Bangumi 子条目 -> Komga 书籍）
    // ============================================================

    function findBangumiSeriesSubjectId(currentMetadata) {
        if (!currentMetadata) return null;
        const links = Array.isArray(currentMetadata.links) ? currentMetadata.links : [];
        const pattern = /bgm\.tv\/subject\/([0-9a-zA-Z]+)/i;
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            if (!link) continue;
            const url = String(link.url || '');
            const m = url.match(pattern);
            if (m && m[1]) return m[1];
        }
        return null;
    }

    function matchBooksByNumber(komgaBooks, bangumiBooks) {
        const map = {};
        for (let i = 0; i < bangumiBooks.length; i++) {
            const b = bangumiBooks[i];
            const key = normalizeVolumeKey(b.volumeNumber);
            if (key == null) continue;
            if (!map[key]) map[key] = b;
        }

        // 统计 Komga 侧的重复卷号（仅用于确认弹窗提示，不改变匹配结果）
        const keyCounts = {};
        for (let k = 0; k < komgaBooks.length; k++) {
            const key = normalizeVolumeKey(komgaBooks[k].volumeNumber);
            if (key == null) continue;
            keyCounts[key] = (keyCounts[key] || 0) + 1;
        }

        const result = [];
        for (let j = 0; j < komgaBooks.length; j++) {
            const kb = komgaBooks[j];
            const key = normalizeVolumeKey(kb.volumeNumber);
            const matched = key != null ? map[key] : null;
            result.push({
                komgaBook: kb,
                bangumiBook: matched || null,
                reason: matched ? null : (key == null ? '未识别卷号' : 'Bangumi 无该卷号'),
                duplicate: key != null && keyCounts[key] > 1
            });
        }
        return result;
    }

    async function writeAutoScrapedBookMetadata(bookId, bangumiDetail, komgaBook) {
        try {
            // 把 Bangumi detail 映射为 Komga 可写字段
            const mapped = mapBangumiToBook(bangumiDetail, (komgaBook && komgaBook.metadata) || {});

            // 卷号：只信任从文件名解析出来的值，并写回 Komga 修正被按位置重编号的序号
            // （旧实现直接沿用 BookDto.number —— 那只是位置序号，会写回错误的序号并加锁）。
            // 文件名解析不出卷号、只能靠 metadata.number 兜底匹配的书，不写这两个字段。
            if (komgaBook && komgaBook.volumeSource === 'filename' && komgaBook.volumeNumber != null) {
                mapped.number = String(komgaBook.volumeNumber);
                mapped.numberSort = Number(komgaBook.volumeNumber);
            }

            // links 字段：确保写入当前 Bangumi subject 的链接
            if (!mapped.links || mapped.links.length === 0) {
                const subjectId = bangumiDetail && bangumiDetail.id;
                if (subjectId) {
                    mapped.links = [{ label: BANGUMI_LINK_LABEL, url: BANGUMI_WEB_BASE + '/subject/' + subjectId }];
                }
            }

            // 直接调用已有的写回逻辑：传入 currentMetadata={} 以强制所有值以 bangumi 为来源
            await writeMetadataToKomga('book', bookId, mapped, null, { metadata: {} });
            return true;
        } catch (e) {
            console.error('[KomgaScraper] [Auto] Failed to write metadata for book', bookId, e);
            return false;
        }
    }

    function updateLoadingProgress(processed, total, message) {
        try {
            const prog = document.getElementById('ks-auto-progress');
            const msg = document.getElementById('ks-auto-message');
            if (prog) {
                prog.textContent = String(processed) + '/' + String(total);
                if (msg && message) msg.textContent = message;
                return;
            }
            // 第一次调用还没有进度元素时，创建进度浮层
            const text = (message || '正在自动刮削') + '，已处理 ' + String(processed) + '/' + String(total);
            showLoading(text, { processed: processed, total: total });
        } catch (_) { /* ignore */ }
    }

    function showAutoScrapeResultSummary(successCount, skippedCount, failedCount, total) {
        try {
            closeAllModals();
            const contentHtml =
                '<div style="padding:10px 0;">' +
                    '<div style="text-align:center;font-size:48px;margin-bottom:16px;">' + (failedCount === 0 ? '✅' : '⚠️') + '</div>' +
                    '<div style="color:#fff;font-size:18px;font-weight:500;text-align:center;margin-bottom:16px;">自动刮削完成</div>' +
                    '<div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:12px;margin-bottom:12px;">' +
                        '<div style="color:rgba(255,255,255,0.8);font-size:14px;line-height:1.8;">' +
                            '总书籍数：' + String(total) + '<br/>' +
                            '<span style="color:#4caf50;">成功写入：' + String(successCount) + '</span><br/>' +
                            '<span style="color:#ffb74d;">跳过（未匹配或手动取消）：' + String(skippedCount) + '</span><br/>' +
                            (failedCount > 0 ? '<span style="color:#ef5350;">失败：' + String(failedCount) + '</span><br/>' : '') +
                        '</div>' +
                    '</div>' +
                    '<div style="color:rgba(255,255,255,0.5);font-size:13px;text-align:center;margin-bottom:16px;">所有写入字段已在 Komga 中加锁，避免被内部扫描覆盖。</div>' +
                    '<div style="display:flex;gap:10px;justify-content:center;margin-top:20px;">' +
                        '<button class="ks-btn ks-btn-secondary" id="ks-auto-close">关闭</button>' +
                        '<button class="ks-btn ks-btn-primary" id="ks-auto-refresh">刷新页面</button>' +
                    '</div>' +
                '</div>';
            const modal = createModalBase('自动刮削完成', contentHtml, null);
            document.getElementById('ks-auto-close').onclick = function() { modal.remove(); };
            document.getElementById('ks-auto-refresh').onclick = function() { modal.remove(); window.location.reload(); };
        } catch (e) {
            console.error('[KomgaScraper] [Auto] Failed to render summary modal:', e);
            alert('自动刮削完成。成功 ' + successCount + ' / 跳过 ' + skippedCount + ' / 失败 ' + failedCount + ' / 总计 ' + total);
        }
    }

    /**
     * 自动刮削确认弹窗。
     * 除了计数，还逐本列出「解析卷号 / Komga 文件名 / 匹配到的 Bangumi 条目」，
     * 便于在写入前发现错配（未识别卷号、卷号重复、覆盖已锁定序号等）。
     */
    function showAutoScrapeConfirm(seriesTitle, pairs, onConfirm) {
        closeAllModals();
        const title = String(seriesTitle || '该系列');
        const list = Array.isArray(pairs) ? pairs : [];
        const totalBooks = list.length;
        const matchedBooks = list.filter(function(p) { return p && p.bangumiBook; }).length;

        const rowsHtml = list.map(function(p, idx) {
            const kb = (p && p.komgaBook) || {};
            const selectable = !!(p && p.bangumiBook);
            const bookName = String(kb.name || fileNameFromUrl(kb.url) || '(未命名)');
            const hasVolume = kb.volumeNumber != null && String(kb.volumeNumber).trim() !== '';
            const volumeCell = escapeHtmlText(hasVolume ? String(kb.volumeNumber) : '—') +
                (p && p.duplicate ? '<span style="color:#ffb74d;" title="多本书解析出同一卷号">⚠</span>' : '');

            // 逐本勾选：有匹配的默认勾选，未匹配的不可勾选（本来就没东西可写）
            const checkboxCell = '<input type="checkbox" class="ks-as-book-checkbox" data-index="' + String(idx) + '"' +
                (selectable ? ' checked' : ' disabled') +
                ' style="flex:0 0 auto;width:16px;height:16px;accent-color:#667eea;' +
                (selectable ? 'cursor:pointer;' : 'cursor:not-allowed;opacity:0.4;') + '">';

            let rightCell;
            let noteHtml = '';
            if (p && p.bangumiBook) {
                const bangumiName = String(p.bangumiBook.name || '');
                const bangumiNameCn = String(p.bangumiBook.nameCn || '');
                const display = bangumiNameCn && bangumiNameCn !== bangumiName
                    ? bangumiName + '（' + bangumiNameCn + '）'
                    : (bangumiName || bangumiNameCn);
                rightCell = '<div class="ks-truncate-text" data-full-text="' + escapeHtmlText(display) + '" style="flex:1 1 52%;min-width:0;color:rgba(255,255,255,0.85);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtmlText(display) + '</div>';
                if (kb.volumeSource === 'filename' && kb.numberLocked === true &&
                    kb.metadataNumber && kb.metadataNumber !== String(kb.volumeNumber)) {
                    noteHtml = '<div style="color:#ffb74d;font-size:12px;margin-top:2px;">' +
                        'Komga 序号 ' + escapeHtmlText(kb.metadataNumber) + ' → ' + escapeHtmlText(String(kb.volumeNumber)) + '（已锁定，将被覆盖）' +
                    '</div>';
                }
            } else {
                rightCell = '<div style="flex:1 1 52%;min-width:0;color:#ffb74d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">未匹配：' +
                    escapeHtmlText((p && p.reason) || '未匹配') + '（跳过）</div>';
            }

            return '<div style="padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.06);">' +
                '<div style="display:flex;gap:8px;align-items:center;">' +
                    checkboxCell +
                    '<div style="flex:0 0 46px;text-align:right;color:#4fc3f7;font-weight:600;">' + volumeCell + '</div>' +
                    '<div class="ks-truncate-text" data-full-text="' + escapeHtmlText(bookName) + '" style="flex:1 1 48%;min-width:0;color:rgba(255,255,255,0.6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtmlText(bookName) + '</div>' +
                    rightCell +
                '</div>' + noteHtml +
            '</div>';
        }).join('');

        const listHtml =
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">' +
                '<label style="display:flex;align-items:center;gap:6px;color:rgba(255,255,255,0.7);font-size:12px;cursor:pointer;">' +
                    '<input type="checkbox" id="ks-as-select-all"' + (matchedBooks > 0 ? ' checked' : ' disabled') +
                    ' style="width:15px;height:15px;accent-color:#667eea;cursor:pointer;">全选' +
                '</label>' +
                '<div style="color:rgba(255,255,255,0.4);font-size:12px;">卷号　文件名　→　Bangumi 条目</div>' +
            '</div>' +
            '<div id="ks-as-list" style="max-height:240px;overflow-y:auto;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.08);border-radius:8px;margin-bottom:16px;">' +
                (rowsHtml || '<div style="padding:12px;color:rgba(255,255,255,0.5);font-size:13px;text-align:center;">该系列下没有书籍</div>') +
            '</div>';

        const contentHtml =
            '<div style="padding:10px 0;">' +
                '<div style="text-align:center;font-size:48px;margin-bottom:16px;">🤖</div>' +
                '<div style="color:#fff;font-size:18px;font-weight:500;text-align:center;margin-bottom:12px;">开始自动刮削</div>' +
                '<div style="color:rgba(255,255,255,0.7);font-size:14px;text-align:center;margin-bottom:16px;">' + escapeHtmlText(title) + '</div>' +
                '<div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:12px;margin-bottom:16px;">' +
                    '<div style="color:rgba(255,255,255,0.8);font-size:14px;line-height:1.8;">' +
                        '系列下书籍总数：<span style="color:#fff;font-weight:500;">' + String(totalBooks) + '</span><br/>' +
                        'Bangumi 匹配数：<span style="color:#4caf50;font-weight:500;">' + String(matchedBooks) + '</span><br/>' +
                        '无法匹配（跳过）：<span style="color:#ffb74d;font-weight:500;">' + String(totalBooks - matchedBooks) + '</span><br/>' +
                        '本次将刮削（已勾选）：<span id="ks-as-selected-count" style="color:#4caf50;font-weight:500;">' + String(matchedBooks) + '</span> 本' +
                    '</div>' +
                '</div>' +
                listHtml +
                '<div style="color:rgba(255,255,255,0.5);font-size:13px;text-align:center;margin-bottom:16px;line-height:1.6;">' +
                    '逐本列表默认全选，可取消不想刮削的书；' +
                    '点击「开始」后将逐本抓取 Bangumi 元数据并写入 Komga；' +
                    '所有写入的字段会自动在 Komga 中加锁，防止被内置扫描覆盖；' +
                    '文件名解析出卷号的书会顺带把「序号 / 排序序号」修正为该卷号。' +
                '</div>' +
                '<div id="ks-as-empty-hint" style="display:none;color:#ffb74d;font-size:12px;text-align:center;margin-bottom:12px;">没有可刮削的书（全部未匹配或已取消勾选）</div>' +
                '<div style="display:flex;gap:10px;justify-content:center;margin-top:20px;">' +
                    '<button class="ks-btn ks-btn-secondary" id="ks-as-cancel">取消</button>' +
                    '<button class="ks-btn ks-btn-primary" id="ks-as-confirm">开始</button>' +
                '</div>' +
            '</div>';
        const modal = createModalBase('自动刮削确认', contentHtml, null);
        const listEl = document.getElementById('ks-as-list');
        if (listEl) {
            bindTitleTooltipDelegates(listEl);
            modal.addEventListener('scroll', hideTitleTooltip, true);
        }

        // 逐本勾选的状态联动：全选框、已选计数、开始按钮可用性
        const bookCheckboxes = modal.querySelectorAll('.ks-as-book-checkbox');
        const selectAllCb = document.getElementById('ks-as-select-all');
        const selectedCountEl = document.getElementById('ks-as-selected-count');
        const confirmBtn = document.getElementById('ks-as-confirm');
        const emptyHintEl = document.getElementById('ks-as-empty-hint');
        const selectableCheckboxes = [];
        bookCheckboxes.forEach(function(cb) {
            if (!cb.disabled) selectableCheckboxes.push(cb);
        });

        function refreshSelectionState() {
            let selected = 0;
            selectableCheckboxes.forEach(function(cb) {
                if (cb.checked) selected++;
            });
            if (selectedCountEl) selectedCountEl.textContent = String(selected);
            if (selectAllCb) {
                selectAllCb.checked = selectableCheckboxes.length > 0 && selected === selectableCheckboxes.length;
                selectAllCb.indeterminate = selected > 0 && selected < selectableCheckboxes.length;
                selectAllCb.disabled = selectableCheckboxes.length === 0;
            }
            if (confirmBtn) {
                confirmBtn.disabled = selected === 0;
                confirmBtn.style.opacity = selected === 0 ? '0.5' : '';
                confirmBtn.style.cursor = selected === 0 ? 'not-allowed' : 'pointer';
            }
            if (emptyHintEl) emptyHintEl.style.display = selected === 0 ? 'block' : 'none';
        }

        bookCheckboxes.forEach(function(cb) {
            cb.onchange = refreshSelectionState;
        });
        if (selectAllCb) {
            selectAllCb.onchange = function() {
                const target = selectAllCb.checked;
                selectableCheckboxes.forEach(function(cb) { cb.checked = target; });
                refreshSelectionState();
            };
        }
        refreshSelectionState();

        document.getElementById('ks-as-cancel').onclick = function() { modal.remove(); };
        document.getElementById('ks-as-confirm').onclick = function() {
            if (confirmBtn && confirmBtn.disabled) return;
            const selectedPairs = [];
            bookCheckboxes.forEach(function(cb) {
                if (!cb.checked) return;
                const idx = parseInt(cb.getAttribute('data-index'), 10);
                if (!isNaN(idx) && list[idx]) selectedPairs.push(list[idx]);
            });
            modal.remove();
            onConfirm(selectedPairs);
        };
    }

    async function startAutoScrape() {
        // 自动刮削仅支持 Bangumi 源。Fanza/DMM 源主要是同人本，命名不规范、数量通常较少，
        // 不提供自动刮削功能；如需刮取 Fanza 系列请使用页面上的“刮削”按钮手动执行。
        try {
            closeAllModals();
            const config = getConfig();
            const debug = config.debug;

            const pageType = getCurrentPageType();
            if (pageType !== 'series') {
                showError('无法自动刮削', '请在系列详情页使用自动刮削功能');
                return;
            }

            const seriesId = extractIdFromUrl();
            if (!seriesId) {
                showError('无法识别系列 ID', '请确认您在正确的系列页面');
                return;
            }

            showLoading('正在读取 Komga 系列信息...');
            const seriesData = await fetchSeriesData(seriesId);
            if (!seriesData) {
                closeAllModals();
                showError('读取系列信息失败', '请检查网络或页面权限');
                return;
            }

            const bangumiSubjectId = findBangumiSeriesSubjectId(seriesData.metadata);
            if (!bangumiSubjectId) {
                closeAllModals();
                showError('请先手动刮削系列或在元数据中加入 Bangumi 链接', '自动刮削需要知道该系列在 Bangumi 的 subject id，可通过手动刮削或在 links 字段添加 bgm.tv/subject/{id} 的链接');
                return;
            }

            if (debug) console.log('[KomgaScraper] [Auto] Bangumi series subject id:', bangumiSubjectId);

            showLoading('正在读取 Komga 书籍列表...');
            const komgaBooks = await fetchBooksOfSeries(seriesId);
            if (!komgaBooks || komgaBooks.length === 0) {
                closeAllModals();
                showError('该系列下没有书籍', '当前系列没有可写入的书籍条目');
                return;
            }

            showLoading('正在从 Bangumi 读取系列中的章节列表...');
            let bangumiSubjectsRaw;
            try {
                bangumiSubjectsRaw = await fetchBangumiSubjectsOfSeries(bangumiSubjectId);
            } catch (e) {
                closeAllModals();
                console.error('[KomgaScraper] [Auto] Bangumi relations unavailable:', e);
                showError('Bangumi 接口不可用', '无法读取该系列在 Bangumi 上的子条目（' +
                    (e && e.message ? e.message : '未知错误') + '）；这通常是 Bangumi 源站问题，请稍后重试');
                return;
            }
            if (!bangumiSubjectsRaw || bangumiSubjectsRaw.length === 0) {
                closeAllModals();
                showError('Bangumi 中没有找到子条目', '无法为该系列下的书籍匹配数据；请确认该 subject id 是否正确');
                return;
            }

            const bangumiBooks = bangumiSubjectsRaw.map(function(b) {
                return {
                    id: b.id,
                    name: b.name,
                    nameCn: b.nameCn,
                    date: b.date,
                    volumeNumber: normalizeVolumeNumber(b.name, b.nameCn)
                };
            });

            if (debug) console.log('[KomgaScraper] [Auto] Bangumi books parsed:', bangumiBooks);

            const pairs = matchBooksByNumber(komgaBooks, bangumiBooks);
            const total = pairs.length;
            const seriesTitle = (seriesData.metadata && seriesData.metadata.title) || seriesData.name || '';

            // 弹出确认框（含逐本映射预览），用户确认后再开始逐本刮削
            showAutoScrapeConfirm(seriesTitle, pairs, function(selectedPairs) {
                runAutoScrapeLoop(selectedPairs, total);
            });

        } catch (e) {
            console.error('[KomgaScraper] [Auto] Auto scrape failed:', e);
            showError('自动刮削过程中发生错误', e.message || '请查看浏览器控制台获取详细信息');
        }

        // selectedPairs：确认弹窗里勾选的书籍（只有匹配到 Bangumi 条目、且用户没取消的书）；
        // allBooksCount：该系列下的书籍总数，用于在完成汇总里把「未匹配 / 手动取消」合并成「跳过」。
        async function runAutoScrapeLoop(selectedPairs, allBooksCount) {
            try {
                const pairs = Array.isArray(selectedPairs) ? selectedPairs : [];
                const total = pairs.length;
                if (total === 0) {
                    showError('没有可刮削的书', '未选择任何书籍，或所选书籍在 Bangumi 中没有对应条目');
                    return;
                }
                let successCount = 0;
                let skippedCount = 0;
                let failedCount = 0;
                const lastFetchedDetailById = {};
                const maxRetries = 2;

                for (let i = 0; i < total; i++) {
                    const pair = pairs[i];
                    if (!pair.bangumiBook) {
                        skippedCount++;
                        updateLoadingProgress(i + 1, total, '自动刮削中');
                        continue;
                    }

                    updateLoadingProgress(i + 1, total, '正在处理第 ' + String(i + 1) + ' 本');

                    let detail = lastFetchedDetailById[pair.bangumiBook.id];
                    if (!detail) {
                        // 最多重试 maxRetries 次，每次之间加一个小延迟
                        for (let attempt = 0; attempt <= maxRetries; attempt++) {
                            try {
                                detail = await fetchSubjectDetail(pair.bangumiBook.id);
                                if (detail) {
                                    lastFetchedDetailById[pair.bangumiBook.id] = detail;
                                    break;
                                }
                            } catch (e) {
                                console.warn('[KomgaScraper] [Auto] Fetch subject detail failed (attempt ' + (attempt + 1) + '/' + (maxRetries + 1) + '):', pair.bangumiBook.id, e);
                            }
                            if (attempt < maxRetries) {
                                await new Promise(function(res) { setTimeout(res, 1500); });
                            }
                        }
                    }

                    if (!detail) {
                        failedCount++;
                        continue;
                    }

                    const ok = await writeAutoScrapedBookMetadata(pair.komgaBook.id, detail, pair.komgaBook);
                    if (ok) successCount++;
                    else failedCount++;
                }

                // 完成汇总：「跳过」= 未匹配 + 手动取消 + 循环内跳过，保证 成功 + 跳过 + 失败 = 系列书籍总数
                skippedCount = Math.max(0, Number(allBooksCount) - successCount - failedCount);
                showAutoScrapeResultSummary(successCount, skippedCount, failedCount, allBooksCount);
            } catch (e) {
                console.error('[KomgaScraper] [Auto] Auto scrape loop failed:', e);
                showError('自动刮削过程中发生错误', e.message || '请查看浏览器控制台获取详细信息');
            }
        }
    }

    // ============================================================
    // 15. 快捷键支持
    // ============================================================

    function registerShortcuts() {
        document.addEventListener('keydown', function(e) {
            const activeElement = document.activeElement;
            if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) {
                return;
            }

            if (e.ctrlKey && e.shiftKey && e.key === 'S') {
                e.preventDefault();
                const pageType = getCurrentPageType();
                if (pageType === 'series' || pageType === 'book') {
                    showScraperSourceMenu();
                }
            }

            if (e.ctrlKey && e.shiftKey && e.key === ',') {
                e.preventDefault();
                showSettingsModal();
            }

            if (e.key === 'Escape') {
                closeAllModals();
            }
        });
    }

    // ============================================================
    // 16. 初始化
    // ============================================================

    function init() {
        checkConfigVersion();
        injectCommonStyles();
        registerShortcuts();

        if (typeof GM_registerMenuCommand === 'function') {
            try {
                GM_registerMenuCommand('刮削设置', showSettingsModal, { title: '打开刮削脚本设置面板' });
            } catch (_) {
                // ignore
            }
        }

        const config = getConfig();
        if (config.debug) console.log('[KomgaScraper] Initializing scraper v' + SCRIPT_VERSION);

        const observer = new MutationObserver(function() {
            const pageType = getCurrentPageType();
            if (pageType === 'series' || pageType === 'book') {
                injectScrapeButton();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        if (config.debug) console.log('[KomgaScraper] Scraper initialized and ready');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('[KomgaScraper] Script loaded v' + SCRIPT_VERSION);

})();
