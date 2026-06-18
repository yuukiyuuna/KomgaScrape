// ==UserScript==
// @name         Komga Metadata Scraper
// @namespace    https://github.com/yourname/komga-scraper
// @version      0.1.1
// @description  Metadata scraper for Komga comics server - 从外部数据源获取漫画/书籍元数据
// @author       You
// @match        http://192.168.0.204:25600/*
// @match        http://localhost:25600/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      *
// @connect      api.bgm.tv
// @connect      *.bgm.tv
// @connect      bangumi.tv
// @connect      *.bangumi.tv
// @connect      mangadex.org
// @connect      *.mangadex.org
// @connect      graphql.anilist.co
// @connect      anilist.co
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @run-at       document-end
// @sandbox      JavaScript
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // 1. 配置管理模块
    // ============================================================

    const CONFIG_KEY = 'komga_scraper_config';
    const SCRIPT_VERSION = '1.0.0';

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
        debug: false
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

    function checkConfigVersion() {
        const config = getConfig();
        if (!config.version || config.version !== SCRIPT_VERSION) {
            if (config.debug) console.log('[KomgaScraper] Config version upgraded:', config.version || 'none', '->', SCRIPT_VERSION);
            config.version = SCRIPT_VERSION;
            saveConfig(config);
        }
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
     * 判断是否为本地/内网请求（这些请求需要携带认证 Cookie）
     */
    function isLocalRequest(url) {
        // 本地/内网地址模式
        const localPatterns = [
            'localhost',
            '127.0.0.1',
            '192.168.',
            '10.0.',
            '172.16.',
            '172.17.',
            '172.18.',
            '172.19.',
            '172.20.',
            '172.21.',
            '172.22.',
            '172.23.',
            '172.24.',
            '172.25.',
            '172.26.',
            '172.27.',
            '172.28.',
            '172.29.',
            '172.30.',
            '172.31.',
            '0.0.0.0'
        ];

        for (let i = 0; i < localPatterns.length; i++) {
            if (url.indexOf(localPatterns[i]) !== -1) {
                return true;
            }
        }
        return false;
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
            if (!headers['User-Agent']) {
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
            const useAnonymous = !isLocal;

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

    /**
     * 备用方案：使用 fetch API（如果 GM_xmlhttpRequest 失败）
     * 特别对本地请求更可靠，因为会自动携带 Cookie
     */
    async function fetchWithBackup(options) {
        return await doGMRequest(options);
    }

    async function fetchWithRateLimit(options) {
        await rateLimiter.acquire();
        return fetchWithBackup(options);
    }

    // ============================================================
    // 5. Komga API 模块
    // ============================================================

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
            return false;
        } catch (e) {
            console.error('[KomgaScraper] Failed to update book metadata:', e);
            return false;
        }
    }

    // ============================================================
    // 6. 数据映射模块 (Bangumi -> Komga)
    // ============================================================

    function mapBangumiStatus(bangumiStatus) {
        const statusMap = {
            'Air': 'ONGOING',
            'Ongoing': 'ONGOING',
            '连载中': 'ONGOING',
            '已完结': 'ENDED',
            'Ended': 'ENDED'
        };
        return statusMap[bangumiStatus] || '';
    }

    function mapBangumiToSeries(bangumiData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        newMetadata.title = bangumiData.title || bangumiData.originalTitle || metadata.title;
        newMetadata.summary = bangumiData.summary || metadata.summary;
        newMetadata.status = mapBangumiStatus(bangumiData.status) || metadata.status;

        if (bangumiData.rating) {
            newMetadata.summary = (newMetadata.summary || '') + '\n\n评分: ' + bangumiData.rating;
        }

        return newMetadata;
    }

    function mapBangumiToBook(bangumiData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        newMetadata.title = bangumiData.title || bangumiData.originalTitle || metadata.title;
        newMetadata.summary = bangumiData.summary || metadata.summary;
        newMetadata.releaseDate = bangumiData.airDate || metadata.releaseDate;

        return newMetadata;
    }

    // ============================================================
    // 7. Bangumi 刮削源
    // ============================================================

    const BANGUMI_API_BASE = 'https://api.bgm.tv';
    const BANGUMI_USER_AGENT = 'KomgaMetadataScraper/1.1.0 (https://github.com/yourname/komga-scraper)';

    async function scrapeFromBangumi(keyword) {
        try {
            const config = getConfig();
            const debug = config.debug;

            if (debug) console.log('[KomgaScraper] [Bangumi] Searching for keyword:', keyword);

            // 构造搜索 URL
            const encodedKeyword = encodeURIComponent(keyword);
            const searchUrl = BANGUMI_API_BASE + '/search/subject/' + encodedKeyword + '?type=1&responseGroup=medium&max_results=10';

            if (debug) console.log('[KomgaScraper] [Bangumi] Request URL:', searchUrl);

            // 发起请求
            const response = await fetchWithRateLimit({
                method: 'GET',
                url: searchUrl,
                headers: {
                    'User-Agent': BANGUMI_USER_AGENT,
                    'Accept': 'application/json',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                }
            });

            if (debug) console.log('[KomgaScraper] [Bangumi] Response status:', response.status, 'hasData:', !!response.data);

            // 检查响应
            if (response.status !== 200) {
                console.warn('[KomgaScraper] [Bangumi] Non-200 status code:', response.status);
                // 如果 status 为 0，说明请求被 CORS 阻止
                if (response.status === 0) {
                    console.warn('[KomgaScraper] [Bangumi] Status 0 detected - request was blocked by CORS');
                    throw new Error('请求被阻止，请检查网络或浏览器权限');
                }
                return [];
            }

            if (!response.data) {
                if (debug) console.log('[KomgaScraper] [Bangumi] Response data is null, raw response:', response.raw ? response.raw.substring(0, 200) : 'empty');
                return [];
            }

            if (!response.data.list || response.data.list.length === 0) {
                if (debug) console.log('[KomgaScraper] [Bangumi] No results in response');
                return [];
            }

            // 解析结果
            const results = response.data.list.map(function(item, index) {
                const result = {
                    id: item.id,
                    title: item.name_cn || item.name,
                    originalTitle: item.name,
                    summary: item.summary || '',
                    image: item.images && item.images.common ? item.images.common : '',
                    largeImage: item.images && item.images.large ? item.images.large : '',
                    rating: item.rating && item.rating.score ? item.rating.score : null,
                    status: item.air_date && item.air_date > new Date().toISOString().slice(0, 10) ? 'Ongoing' : 'Ended',
                    airDate: item.air_date || '',
                    url: 'https://bgm.tv/subject/' + item.id
                };

                if (debug) console.log('[KomgaScraper] [Bangumi] Result ' + (index + 1) + ':', result.title, result.originalTitle);
                return result;
            });

            if (debug) console.log('[KomgaScraper] [Bangumi] Total', results.length, 'results found');
            return results;

        } catch (e) {
            console.error('[KomgaScraper] [Bangumi] Search failed with error:', e);
            throw e;
        }
    }

    // ============================================================
    // 8. UI 模块 - 按钮
    // ============================================================

    const SCRAPE_BTN_ID = 'komga-scraper-btn-container';
    const SETTINGS_BTN_ID = 'komga-scraper-settings-btn-container';

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

    function createSettingsButton() {
        const container = document.createElement('div');
        container.className = 'col col-auto';
        container.id = SETTINGS_BTN_ID;

        const button = document.createElement('a');
        button.className = 'v-btn v-btn--is-elevated v-btn--has-bg theme--dark v-size--small';
        button.title = '刮削设置';
        button.style.cursor = 'pointer';
        button.style.textDecoration = 'none';

        const content = document.createElement('span');
        content.className = 'v-btn__content';

        const icon = document.createElement('i');
        icon.className = 'v-icon notranslate v-icon--left mdi mdi-cog theme--dark';
        icon.setAttribute('aria-hidden', 'true');
        icon.style.fontSize = '16px';

        content.appendChild(icon);
        content.appendChild(document.createTextNode(' 设置 '));
        button.appendChild(content);

        button.addEventListener('click', function(e) {
            e.preventDefault();
            showSettingsModal();
        });

        container.appendChild(button);
        return container;
    }

    function injectScrapeButton() {
        if (document.getElementById(SCRAPE_BTN_ID)) {
            return;
        }

        const downloadBtn = document.querySelector('a.v-btn[title*="下载"]');

        if (downloadBtn) {
            const parentRow = downloadBtn.closest('.row.align-center');
            if (parentRow) {
                parentRow.appendChild(createScrapeButton());
                parentRow.appendChild(createSettingsButton());
            }
        }
    }

    // ============================================================
    // 9. 模态框工具模块
    // ============================================================

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
    }

    function showLoading(message) {
        closeAllModals();
        const contentHtml = `
            <div style="text-align:center;padding:20px;">
                <div style="width:48px;height:48px;margin:0 auto 16px;border:4px solid rgba(255,255,255,0.1);border-top-color:#667eea;border-radius:50%;animation:ks-spin 1s linear infinite;"></div>
                <div style="color:#fff;font-size:16px;margin-bottom:8px;">${message || '加载中...'}</div>
            </div>
            <style>
                @keyframes ks-spin { to { transform: rotate(360deg); } }
            </style>
        `;
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
            <style>
                .ks-btn { border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s; }
                .ks-btn-primary { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff; }
                .ks-btn-primary:hover { transform: translateY(-1px); box-shadow:0 4px 12px rgba(102,126,234,0.4); }
                .ks-btn-secondary { background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8); }
                .ks-btn-secondary:hover { background:rgba(255,255,255,0.15); }
            </style>
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
                <div style="color:rgba(255,255,255,0.5);font-size:13px;text-align:center;margin-bottom:16px;">页面将在 2 秒后自动刷新...</div>
                <div style="display:flex;gap:10px;justify-content:center;margin-top:20px;">
                    <button class="ks-btn ks-btn-secondary" id="ks-close-btn-2">关闭</button>
                    <button class="ks-btn ks-btn-primary" id="ks-refresh-btn">立即刷新</button>
                </div>
            </div>
            <style>
                .ks-btn { border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s; }
                .ks-btn-primary { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;font-weight:500; }
                .ks-btn-primary:hover { transform: translateY(-1px); box-shadow:0 4px 12px rgba(102,126,234,0.4); }
                .ks-btn-secondary { background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8); }
                .ks-btn-secondary:hover { background:rgba(255,255,255,0.15); }
            </style>
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

        setTimeout(function() {
            if (document.body.contains(modal)) {
                modal.remove();
                window.location.reload();
            }
        }, 2000);
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

                <div style="color:rgba(255,255,255,0.4);font-size:13px;text-align:center;margin:16px 0 8px 0;">更多数据源 (MangaDex, AniList) 即将推出...</div>
            </div>
            <style>
                .ks-source-card:hover { background:rgba(255,255,255,0.1); border-color:rgba(100,200,255,0.3); transform:translateY(-2px); }
                .ks-btn { border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s; }
                .ks-btn-primary { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff; }
                .ks-btn-primary:hover { transform: translateY(-1px); box-shadow:0 4px 12px rgba(102,126,234,0.4); }
            </style>
        `;

        const modal = createModalBase('选择刮削源', contentHtml, null);

        const bangumiCard = modal.querySelector('.ks-source-card[data-source="bangumi"]');
        bangumiCard.addEventListener('click', function() {
            modal.remove();
            startScrapeProcess('bangumi');
        });
    }

    // ============================================================
    // 11. 搜索结果选择界面
    // ============================================================

    function showSearchResults(results, onSelect) {
        closeAllModals();

        if (!results || results.length === 0) {
            showError('未找到匹配结果', '请尝试修改关键词或更换刮削源');
            return;
        }

        let resultsHtml = '<div style="padding:4px 0;">';
        resultsHtml += '<div style="color:rgba(255,255,255,0.7);font-size:14px;margin-bottom:16px;">找到 ' + results.length + ' 个匹配结果，请选择一个:</div>';

        results.forEach(function(result, index) {
            const safeImage = (result.image || '').replace(/"/g, '&quot;');
            const safeTitle = String(result.title || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            const safeOriginal = String(result.originalTitle || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            const safeSummary = String(result.summary || '').replace(/</g, '&lt;').replace(/"/g, '&quot;').substring(0, 120);
            const safeAirDate = String(result.airDate || '').replace(/"/g, '&quot;');

            resultsHtml += `
                <div class="ks-result-card" data-index="${index}" style="background:rgba(255,255,255,0.05);border-radius:12px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.08);cursor:pointer;transition:all 0.3s ease;">
                    <div style="display:flex;gap:12px;">
                        ${safeImage ? `
                            <img src="${safeImage}" alt="" onerror="this.style.display='none'" style="width:60px;height:80px;object-fit:cover;border-radius:6px;flex-shrink:0;">
                        ` : `
                            <div style="width:60px;height:80px;background:rgba(255,255,255,0.05);border-radius:6px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.3);font-size:24px;flex-shrink:0;">📚</div>
                        `}
                        <div style="flex:1;min-width:0;">
                            <div style="color:#fff;font-size:15px;font-weight:500;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeTitle}</div>
                            ${safeOriginal && safeOriginal !== safeTitle ? `
                                <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeOriginal}</div>
                            ` : ''}
                            <div style="display:flex;gap:8px;align-items:center;font-size:12px;margin-top:6px;flex-wrap:wrap;">
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
        });

        resultsHtml += '</div>';
        resultsHtml += `
            <style>
                .ks-result-card:hover { background:rgba(255,255,255,0.1); border-color:rgba(100,200,255,0.3); transform:translateY(-2px); }
            </style>
        `;

        const modal = createModalBase('搜索结果', resultsHtml, null);

        const resultCards = modal.querySelectorAll('.ks-result-card');
        resultCards.forEach(function(card) {
            card.addEventListener('click', function() {
                const idx = parseInt(card.getAttribute('data-index'));
                modal.remove();
                onSelect(results[idx]);
            });
        });
    }

    // ============================================================
    // 12. 元数据预览编辑界面
    // ============================================================

    function showMetadataPreview(scrapeResult, currentData, pageType, onConfirm) {
        closeAllModals();

        const config = getConfig();
        const currentMetadata = currentData && currentData.metadata ? currentData.metadata : {};
        const mappedMetadata = pageType === 'series'
            ? mapBangumiToSeries(scrapeResult, currentMetadata)
            : mapBangumiToBook(scrapeResult, currentMetadata);

        const fields = [
            { key: 'title', label: '标题', type: 'text', value: mappedMetadata.title || '', checked: true },
            { key: 'summary', label: '简介', type: 'textarea', value: mappedMetadata.summary || '', checked: true },
            { key: 'status', label: '状态', type: 'text', value: mappedMetadata.status || '', checked: !!mappedMetadata.status }
        ];

        if (pageType === 'book') {
            fields.push({ key: 'releaseDate', label: '发布日期', type: 'text', value: mappedMetadata.releaseDate || '', checked: !!mappedMetadata.releaseDate });
        }

        let previewHtml = '<div style="padding:4px 0;">';

        const safeLargeImage = (scrapeResult.largeImage || scrapeResult.image || '').replace(/"/g, '&quot;');
        const safeTitle = String(scrapeResult.title || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const safeOriginal = String(scrapeResult.originalTitle || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const safeUrl = String(scrapeResult.url || '#').replace(/"/g, '&quot;');

        previewHtml += `
            <div style="background:rgba(255,255,255,0.05);border-radius:12px;padding:12px;margin-bottom:20px;border:1px solid rgba(255,255,255,0.08);">
                <div style="display:flex;gap:12px;align-items:flex-start;">
                    ${safeLargeImage ? `
                        <img src="${safeLargeImage}" alt="" onerror="this.style.display='none'" style="width:80px;height:110px;object-fit:cover;border-radius:8px;flex-shrink:0;">
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
            previewHtml += `
                <div class="ks-field-row" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.06);">
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;">
                        <input type="checkbox" class="ks-field-checkbox" data-field="${field.key}" ${field.checked ? 'checked' : ''} style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:#fff;font-size:14px;font-weight:500;">${field.label}</span>
                    </label>
                    ${isTextarea ? `
                        <textarea class="ks-field-input" data-field="${field.key}" style="width:calc(100% - 16px);min-height:80px;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;resize:vertical;font-family:inherit;line-height:1.5;">${safeValue}</textarea>
                    ` : `
                        <input type="text" class="ks-field-input" data-field="${field.key}" value="${safeValue}" style="width:calc(100% - 16px);padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
                    `}
                </div>
            `;
        });

        previewHtml += `
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.1);">
                <button class="ks-btn ks-btn-secondary" id="ks-cancel-btn">取消</button>
                <button class="ks-btn ks-btn-primary" id="ks-confirm-btn">确认写入</button>
            </div>
        `;

        previewHtml += '</div>';
        previewHtml += `
            <style>
                .ks-field-row:hover { background:rgba(255,255,255,0.05); border-color:rgba(255,255,255,0.1); }
                .ks-field-row:hover .ks-field-input { border-color:rgba(102,126,234,0.3); }
                .ks-field-input:focus { outline:none; border-color:#667eea !important; box-shadow:0 0 0 2px rgba(102,126,234,0.2); }
                .ks-btn { border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s; }
                .ks-btn-primary { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;font-weight:500; }
                .ks-btn-primary:hover { transform: translateY(-1px); box-shadow:0 4px 12px rgba(102,126,234,0.4); }
                .ks-btn-secondary { background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8); }
                .ks-btn-secondary:hover { background:rgba(255,255,255,0.15); }
            </style>
        `;

        const modal = createModalBase('预览并编辑元数据', previewHtml, null);

        document.getElementById('ks-cancel-btn').onclick = function() {
            modal.remove();
        };

        document.getElementById('ks-confirm-btn').onclick = function() {
            const checkboxes = modal.querySelectorAll('.ks-field-checkbox');
            const inputs = modal.querySelectorAll('.ks-field-input');
            const selectedFields = {};
            const updatedFields = [];

            checkboxes.forEach(function(cb) {
                if (cb.checked) {
                    const fieldKey = cb.getAttribute('data-field');
                    const input = modal.querySelector('.ks-field-input[data-field="' + fieldKey + '"]');
                    if (input) {
                        selectedFields[fieldKey] = input.value;
                        const fieldLabels = { title: '标题', summary: '简介', status: '状态', releaseDate: '发布日期' };
                        updatedFields.push(fieldLabels[fieldKey] || fieldKey);
                    }
                }
            });

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
                <div style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="ks-setting-debug" ${config.debug ? 'checked' : ''} style="width:18px;height:18px;accent-color:#667eea;cursor:pointer;">
                    <label for="ks-setting-debug" style="color:rgba(255,255,255,0.7);font-size:13px;cursor:pointer;">启用调试日志 (在浏览器 Console 中输出详细日志)</label>
                </div>
            </div>

            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.1);">
                <button class="ks-btn ks-btn-secondary" id="ks-reset-btn">恢复默认</button>
                <button class="ks-btn ks-btn-secondary" id="ks-settings-cancel-btn">取消</button>
                <button class="ks-btn ks-btn-primary" id="ks-save-btn">保存设置</button>
            </div>
        `;

        settingsHtml += '</div>';
        settingsHtml += `
            <style>
                .ks-btn { border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s; }
                .ks-btn-primary { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;font-weight:500; }
                .ks-btn-primary:hover { transform: translateY(-1px); box-shadow:0 4px 12px rgba(102,126,234,0.4); }
                .ks-btn-secondary { background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8); }
                .ks-btn-secondary:hover { background:rgba(255,255,255,0.15); }
            </style>
        `;

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
            newConfig.debug = document.getElementById('ks-setting-debug').checked;

            saveConfig(newConfig);
            alert('设置已保存');
            modal.remove();
        };
    }

    // ============================================================
    // 14. 主流程控制
    // ============================================================

    async function startScrapeProcess(source) {
        try {
            const config = getConfig();
            if (config.debug) console.log('[KomgaScraper] Starting scrape process with source:', source);

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
            if (pageType === 'series') {
                searchTitle = currentData.metadata && currentData.metadata.title ? currentData.metadata.title : currentData.name;
            } else {
                searchTitle = currentData.metadata && currentData.metadata.title ? currentData.metadata.title : currentData.name;
            }

            const cleanKeyword = cleanSearchKeyword(searchTitle);
            if (!cleanKeyword) {
                loading.remove();
                showError('无法获取有效的搜索关键词', '请确保系列/书籍有标题信息');
                return;
            }

            if (config.debug) console.log('[KomgaScraper] Searching for:', cleanKeyword);
            loading.remove();
            showLoading('正在搜索 Bangumi: ' + cleanKeyword);

            let searchResults;
            try {
                searchResults = await scrapeFromBangumi(cleanKeyword);
            } catch (e) {
                loading.remove();
                showError('搜索请求失败', '请检查网络连接', function() {
                    startScrapeProcess(source);
                });
                return;
            }

            loading.remove();

            showSearchResults(searchResults, function(selectedResult) {
                showMetadataPreview(selectedResult, currentData, pageType, function(selectedFields, updatedFields) {
                    if (Object.keys(selectedFields).length === 0) {
                        showError('未选择任何字段', '请至少勾选一个要更新的字段');
                        return;
                    }

                    writeMetadataToKomga(pageType, pageId, selectedFields, updatedFields);
                });
            });

        } catch (e) {
            console.error('[KomgaScraper] Scrape process failed:', e);
            showError('刮削过程中发生错误', e.message || '请查看浏览器控制台获取详细信息');
        }
    }

    async function writeMetadataToKomga(pageType, pageId, metadata, updatedFields) {
        try {
            const config = getConfig();
            if (config.debug) console.log('[KomgaScraper] Writing metadata to Komga:', metadata);

            showLoading('正在写入元数据到 Komga...');

            let success;
            if (pageType === 'series') {
                success = await updateSeriesMetadata(pageId, metadata);
            } else {
                success = await updateBookMetadata(pageId, metadata);
            }

            if (success) {
                if (config.debug) console.log('[KomgaScraper] Metadata updated successfully');
                showSuccess(updatedFields, function() {
                    window.location.reload();
                });
            } else {
                showError('写入元数据失败', '请检查 API Key 或页面权限设置');
            }

        } catch (e) {
            console.error('[KomgaScraper] Failed to write metadata:', e);
            showError('写入元数据失败', e.message || '请查看浏览器控制台获取详细信息');
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
        registerShortcuts();

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
