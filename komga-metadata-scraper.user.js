// ==UserScript==
// @name         Komga Metadata Scraper
// @namespace    https://github.com/yourname/komga-scraper
// @version      1.0.2
// @description  Metadata scraper for Komga comics server - 从外部数据源获取漫画/书籍元数据
// @author       You
// @match        {你自己的komga网站地址}
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
// @connect      www.dmm.co.jp
// @connect      *.dmm.co.jp
// @connect      dmm.co.jp
// @connect      doujin-assets.dmm.co.jp
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
        autoRefresh: true,
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

    async function fetchWithRateLimit(options) {
        await rateLimiter.acquire();
        return doGMRequest(options);
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

    function mergeLinks(newLinks, currentLinks) {
        const byUrl = {};
        const result = [];
        const addLink = function(link) {
            if (!link) return;
            const url = cleanUrl(link.url);
            if (!url) return;
            const label = String(link.label || '').trim();
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

    function extractStatusFromInfobox(infobox) {
        if (!infobox || !Array.isArray(infobox)) return null;
        for (let i = 0; i < infobox.length; i++) {
            const item = infobox[i];
            const key = String(item.key || '');
            const val = getInfoboxValue(item.value);
            if (key.indexOf('连载') !== -1 || key.indexOf('状态') !== -1 ||
                key.indexOf('完结') !== -1 || key.indexOf('结束') !== -1) {
                if (val.indexOf('完结') !== -1 || val.indexOf('结束') !== -1 || val.indexOf('已完结') !== -1) {
                    return 'ENDED';
                }
                if (val.indexOf('连载') !== -1 || val.indexOf('进行') !== -1 || val.indexOf('播出') !== -1) {
                    return 'ONGOING';
                }
            }
        }
        return null;
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

    function mapBangumiToSeries(bangumiData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        const isZh = String(metadata.language || '').toLowerCase() === 'zh';
        const preferredTitle = isZh ? bangumiData.title : bangumiData.originalTitle;
        const fallbackTitle = isZh ? bangumiData.originalTitle : bangumiData.title;
        newMetadata.title = preferredTitle || fallbackTitle || metadata.title;

        newMetadata.summary = bangumiData.summary || metadata.summary;

        const infoboxStatus = extractStatusFromInfobox(bangumiData.infobox);
        newMetadata.status = infoboxStatus || mapBangumiStatus(bangumiData.status) || metadata.status;

        if (bangumiData.rating) {
            newMetadata.summary = (newMetadata.summary || '') + '\n\n评分: ' + bangumiData.rating;
        }

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

    function mapBangumiToBook(bangumiData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        const isZh = String(metadata.language || '').toLowerCase() === 'zh';
        const preferredTitle = isZh ? bangumiData.title : bangumiData.originalTitle;
        const fallbackTitle = isZh ? bangumiData.originalTitle : bangumiData.title;
        newMetadata.title = preferredTitle || fallbackTitle || metadata.title;

        let summaryExtra = '';
        if (bangumiData.pages) {
            summaryExtra += '\n\n页数: ' + bangumiData.pages;
        }
        newMetadata.summary = (bangumiData.summary || metadata.summary || '') + summaryExtra;
        if (!newMetadata.summary) delete newMetadata.summary;

        newMetadata.releaseDate = bangumiData.airDate || metadata.releaseDate;

        const normalizedIsbn = normalizeIsbn(bangumiData.isbn);
        if (normalizedIsbn) newMetadata.isbn = normalizedIsbn;
        if (bangumiData.pages) newMetadata.pages = bangumiData.pages;
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

    const BANGUMI_API_BASE = 'https://api.bgm.tv';
    const BANGUMI_USER_AGENT = 'KomgaMetadataScraper/1.2.0 (https://github.com/yourname/komga-scraper)';

    async function scrapeFromBangumi(keyword) {
        try {
            const config = getConfig();
            const debug = config.debug;

            if (debug) console.log('[KomgaScraper] [Bangumi] Searching v0 for keyword:', keyword);

            const searchUrl = BANGUMI_API_BASE + '/v0/search/subjects?limit=10';

            if (debug) console.log('[KomgaScraper] [Bangumi] Request URL:', searchUrl);

            const requestBody = JSON.stringify({
                keyword: keyword,
                sort: 'rank',
                filter: {
                    type: [1],
                    nsfw: true
                }
            });

            if (debug) console.log('[KomgaScraper] [Bangumi] Request body:', requestBody);

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

            if (debug) console.log('[KomgaScraper] [Bangumi] Response status:', response.status, 'hasData:', !!response.data);

            if (response.status !== 200) {
                console.warn('[KomgaScraper] [Bangumi] Non-200 status code:', response.status);
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

            if (!response.data.data || response.data.data.length === 0) {
                if (debug) console.log('[KomgaScraper] [Bangumi] No results in response');
                return [];
            }

            const results = response.data.data.map(function(item, index) {
                const airDateVal = item.date || item.air_date || '';
                const itemId = String(item.id || '').replace(/[^0-9a-zA-Z]/g, '');
                const bangumiUrl = cleanUrl('https://bgm.tv/subject/' + itemId);
                const result = {
                    id: itemId,
                    title: item.name_cn || item.name,
                    originalTitle: item.name,
                    summary: item.summary || '',
                    image: item.images && item.images.common ? item.images.common : '',
                    largeImage: item.images && item.images.large ? item.images.large : '',
                    rating: item.rating && item.rating.score ? item.rating.score : null,
                    status: airDateVal && airDateVal > new Date().toISOString().slice(0, 10) ? 'Ongoing' : 'Ended',
                    airDate: airDateVal,
                    url: bangumiUrl,
                    date: item.date || '',
                    links: [{ label: 'Bangumi', url: bangumiUrl }]
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

    async function fetchSubjectDetail(subjectIdParam) {
        try {
            const config = getConfig();
            const debug = config.debug;

            if (debug) console.log('[KomgaScraper] [Bangumi] Fetching detail for subject:', subjectIdParam);

            const detailUrl = BANGUMI_API_BASE + '/v0/subjects/' + subjectIdParam;

            if (debug) console.log('[KomgaScraper] [Bangumi] Detail URL:', detailUrl);

            const response = await fetchWithRateLimit({
                method: 'GET',
                url: detailUrl,
                headers: {
                    'User-Agent': BANGUMI_USER_AGENT,
                    'Accept': 'application/json',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                }
            });

            if (debug) console.log('[KomgaScraper] [Bangumi] Detail response status:', response.status);

            if (response.status !== 200 || !response.data) {
                console.warn('[KomgaScraper] [Bangumi] Failed to get subject detail');
                return null;
            }

            const data = response.data;
            const infobox = data.infobox || [];

            if (debug) console.log('[KomgaScraper] [Bangumi] Infobox:', JSON.stringify(infobox));

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
            if (!publishDate && data.date && looksLikeDate(data.date)) publishDate = data.date;
            if (!publishDate && data.air_date && looksLikeDate(data.air_date)) publishDate = data.air_date;

            const pagesRaw = extractFromInfobox(
                infobox,
                ['页数', '页数', 'page', 'Page', 'p.', 'P.'],
                ['出版社', '作者', '原作', '脚本']
            );
            let pages = '';
            if (pagesRaw) {
                const pageMatch = pagesRaw.match(/\d+/);
                if (pageMatch) pages = pageMatch[0];
            }

            const authors = extractAllAuthorsFromInfobox(infobox);

            const subjectItemId = String(data.id || '').replace(/[^0-9a-zA-Z]/g, '');
            const subjectDate = data.date || data.air_date || '';
            const bangumiLinkUrl = cleanUrl('https://bgm.tv/subject/' + subjectItemId);
            const detail = {
                id: subjectItemId,
                title: data.name_cn || data.name,
                originalTitle: data.name,
                summary: data.summary || '',
                image: data.images && data.images.common ? data.images.common : '',
                largeImage: data.images && data.images.large ? data.images.large : '',
                rating: data.rating && data.rating.score ? data.rating.score : null,
                status: subjectDate && subjectDate > new Date().toISOString().slice(0, 10) ? 'Ongoing' : 'Ended',
                airDate: publishDate || subjectDate || '',
                url: bangumiLinkUrl,
                infobox: infobox,
                isbn: isbn,
                pages: pages,
                authors: authors,
                links: [{ label: 'Bangumi', url: bangumiLinkUrl }]
            };

            if (debug) console.log('[KomgaScraper] [Bangumi] Detail result:', JSON.stringify(detail, null, 2));
            return detail;

        } catch (e) {
            console.error('[KomgaScraper] [Bangumi] Failed to fetch subject detail:', e);
            return null;
        }
    }

    // ============================================================
    // 7.5. Fanza (DMM) 刮削源
    // ============================================================

    const FANZA_SEARCH_URL = 'https://www.dmm.co.jp/search/=/searchstr={keyword}/limit=30/sort=date/';

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

    async function scrapeFromFanza(keyword) {
        try {
            const config = getConfig();
            const debug = config.debug;

            if (debug) console.log('[KomgaScraper] [Fanza] Searching for keyword:', keyword);

            const encodedKeyword = encodeURIComponent(keyword);
            const searchUrl = FANZA_SEARCH_URL.replace('{keyword}', encodedKeyword);

            if (debug) console.log('[KomgaScraper] [Fanza] Search URL:', searchUrl);

            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ja,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
                'Cookie': 'age_check_done=1'
            };

            const response = await fetchWithRateLimit({
                method: 'GET',
                url: searchUrl,
                headers: headers
            });

            if (debug) console.log('[KomgaScraper] [Fanza] Response status:', response.status);

            if (response.status !== 200 || !response.raw) {
                console.warn('[KomgaScraper] [Fanza] Search request failed or empty response');
                return [];
            }

            const html = response.raw;

            // 步骤 1: 从搜索结果页提取唯一的 dc/doujin CID
            const cidSet = {};
            const cidPattern = /dc\/doujin[^"'\s]*cid=([^\/&'"]+)/gi;
            let cidMatch;
            while ((cidMatch = cidPattern.exec(html)) !== null && Object.keys(cidSet).length < 15) {
                const cid = cidMatch[1].trim();
                if (cid && cid.length >= 3 && cid.length <= 30 && !cidSet[cid]) {
                    cidSet[cid] = true;
                }
            }

            const cids = Object.keys(cidSet);
            if (debug) console.log('[KomgaScraper] [Fanza] Found', cids.length, 'unique CIDs:', cids);

            // 步骤 2: 对每个 CID 获取详情页信息
            // 新的 Next.js Fanza 页面使用 og 标签，这是最可靠的元数据来源
            const results = [];
            for (let idx = 0; idx < cids.length; idx++) {
                const cid = cids[idx];
                const detailUrl = 'https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=' + cid + '/';

                if (debug) console.log('[KomgaScraper] [Fanza] Fetching detail for', cid, '(' + (idx + 1) + '/' + cids.length + ')');

                const detailResp = await fetchWithRateLimit({
                    method: 'GET',
                    url: detailUrl,
                    headers: headers
                });

                if (detailResp.status !== 200 || !detailResp.raw) {
                    console.warn('[KomgaScraper] [Fanza] Failed to get detail for', cid);
                    continue;
                }

                const detailHtml = detailResp.raw;

                // og:title - 作品标题
                let title = '';
                const ogTitle = extractMetaContent(detailHtml, 'og:title');
                if (ogTitle) {
                    title = ogTitle.replace(/\s*\(FANZA.*\)/, '').trim();
                }
                if (!title) {
                    const titleMatch = detailHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
                    if (titleMatch) title = titleMatch[1].trim();
                }

                // og:image - 封面图
                let image = extractMetaContent(detailHtml, 'og:image') || '';

                // 处理图片 URL 协议
                if (image && image.indexOf('http') !== 0) {
                    if (image.indexOf('//') === 0) {
                        image = 'https:' + image;
                    } else if (image.indexOf('/') === 0) {
                        image = 'https://www.dmm.co.jp' + image;
                    }
                }

                // og:description - 作品简介
                const description = extractMetaContent(detailHtml, 'og:description') || '';

                if (title && title.length >= 2) {
                    results.push({
                        source: 'fanza',
                        id: cid,
                        url: detailUrl,
                        title: title,
                        originalTitle: title,
                        author: '',
                        image: image,
                        largeImage: image,
                        rating: null,
                        status: 'Completed',
                        date: '',
                        airDate: '',
                        summary: description,
                        links: [{ label: 'Fanza', url: detailUrl }]
                    });
                }
            }

            if (debug) console.log('[KomgaScraper] [Fanza] Found', results.length, 'valid search results');
            return results;

        } catch (e) {
            console.error('[KomgaScraper] [Fanza] Search failed:', e);
            throw e;
        }
    }

    async function fetchFanzaDetail(url) {
        try {
            const config = getConfig();
            const debug = config.debug;

            if (debug) console.log('[KomgaScraper] [Fanza] Fetching detail:', url);

            const response = await fetchWithRateLimit({
                method: 'GET',
                url: url,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'ja,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
                    'Cookie': 'age_check_done=1'
                }
            });

            if (response.status !== 200 || !response.raw) {
                console.warn('[KomgaScraper] [Fanza] Failed to get detail page');
                return null;
            }

            const html = response.raw;
            const doc = parseHtmlToDoc(html);

            const titleMeta = extractMetaContent(html, 'og:title');
            const title = titleMeta || (doc && doc.querySelector('title') ? doc.querySelector('title').textContent.trim() : '');

            const imageMeta = extractMetaContent(html, 'og:image');
            const descriptionMeta = extractMetaContent(html, 'og:description');
            const cleanDesc = cleanFanzaSummary(descriptionMeta);

            let releaseDate = '';
            let pageCount = '';
            let author = '';
            const tags = [];
            const infoKeysRaw = {};

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

                const tagLinks = doc.querySelectorAll('a[href*="genre"], a[href*="keyword"], span[class*="genreTag"], a[href*="tag"]');
                for (let i = 0; i < tagLinks.length; i++) {
                    const t = tagLinks[i].textContent && tagLinks[i].textContent.trim();
                    if (t && t.length <= 30 && tags.indexOf(t) === -1 && tags.length < 30) {
                        tags.push(t);
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
                if (/シリーズ|series|題材|原作|ジャンル|genre/i.test(k)) {
                    const parts = val.split(/[,，、\/]/).map(function(s) { return s.trim(); }).filter(function(s) { return s && s.length <= 30; });
                    parts.forEach(function(p) {
                        if (tags.indexOf(p) === -1) tags.push(p);
                    });
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

    function mapFanzaToBook(fanzaData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        newMetadata.title = fanzaData.title || metadata.title;
        newMetadata.summary = fanzaData.summary || metadata.summary;

        if (fanzaData.releaseDate) {
            newMetadata.releaseDate = fanzaData.releaseDate;
        }

        if (fanzaData.pages) {
            newMetadata.pages = fanzaData.pages;
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

        const fanzaCard = modal.querySelector('.ks-source-card[data-source="fanza"]');
        fanzaCard.addEventListener('click', function() {
            modal.remove();
            startScrapeProcess('fanza');
        });
    }

    // ============================================================
    // 11. 搜索结果选择界面
    // ============================================================

    function showSearchResults(results, onSelect, currentKeyword, onRetry, source) {
        closeAllModals();

        const hasResults = results && results.length > 0;
        const safeKeyword = String(currentKeyword || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');

        if (!hasResults) {
            const retryHtml = `
                <div style="padding:10px 0;">
                    <div style="text-align:center;font-size:48px;margin-bottom:16px;">🔍</div>
                    <div style="color:#f44336;font-size:18px;font-weight:500;text-align:center;margin-bottom:8px;">未找到匹配结果</div>
                    <div style="color:rgba(255,255,255,0.6);font-size:13px;text-align:center;margin-bottom:20px;">
                        当前搜索词可能过于精确，可手动修改后重试
                    </div>

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
                <style>
                    .ks-btn { border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s; }
                    .ks-btn-primary { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff; }
                    .ks-btn-primary:hover { transform: translateY(-1px); box-shadow:0 4px 12px rgba(102,126,234,0.4); }
                    .ks-btn-secondary { background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8); }
                    .ks-btn-secondary:hover { background:rgba(255,255,255,0.15); }
                </style>
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

        let resultsHtml = '<div style="padding:4px 0;">';
        resultsHtml += '<div style="color:rgba(255,255,255,0.7);font-size:14px;margin-bottom:16px;">找到 ' + results.length + ' 个匹配结果，请选择一个:</div>';

        results.forEach(function(result, index) {
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

            resultsHtml += `
                <div class="ks-result-card" data-index="${index}" style="background:rgba(255,255,255,0.05);border-radius:12px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.08);cursor:pointer;transition:all 0.3s ease;">
                    <div style="display:flex;gap:12px;">
                        ${safeImage ? `
                            <img src="${safeImage}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" style="width:60px;height:80px;object-fit:cover;border-radius:6px;flex-shrink:0;">
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
        if (onRetry && currentKeyword) {
            resultsHtml += `
                <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;">
                    <button class="ks-btn ks-btn-retry" id="ks-change-keyword-btn" style="border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.8);">✏️ 修改搜索词重新搜索</button>
                </div>
            `;
        }
        resultsHtml += `
            <style>
                .ks-result-card:hover { background:rgba(255,255,255,0.1); border-color:rgba(100,200,255,0.3); transform:translateY(-2px); }
                .ks-btn-retry:hover { background:rgba(255,255,255,0.15); }
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

        const changeKeywordBtn = document.getElementById('ks-change-keyword-btn');
        if (changeKeywordBtn) {
            changeKeywordBtn.onclick = function() {
                modal.remove();
                showSearchResults(null, onSelect, currentKeyword, onRetry, source);
            };
        }
    }

    // ============================================================
    // 12. 元数据预览编辑界面
    // ============================================================

    function showMetadataPreview(scrapeResult, currentData, pageType, source, onConfirm) {
        closeAllModals();

        const config = getConfig();
        const currentMetadata = currentData && currentData.metadata ? currentData.metadata : {};
        const isFanzaSource = source === 'fanza';

        let mappedMetadata;
        if (isFanzaSource) {
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

        const fields = [
            { key: 'title', label: '标题', type: 'text', value: mappedMetadata.title || '', checked: !isFieldLocked('title'), locked: isFieldLocked('title') },
            { key: 'summary', label: '简介', type: 'textarea', value: mappedMetadata.summary || '', checked: !isFieldLocked('summary'), locked: isFieldLocked('summary') },
            { key: 'status', label: '状态', type: 'text', value: mappedMetadata.status || '', checked: !isFieldLocked('status') && !!mappedMetadata.status, locked: isFieldLocked('status') }
        ];

        if (pageType === 'book') {
            fields.push({ key: 'releaseDate', label: '发布日期', type: 'text', value: mappedMetadata.releaseDate || '', checked: !isFieldLocked('releaseDate') && !!mappedMetadata.releaseDate, locked: isFieldLocked('releaseDate') });
            fields.push({ key: 'isbn', label: 'ISBN', type: 'text', value: mappedMetadata.isbn || '', checked: !isFieldLocked('isbn') && !!mappedMetadata.isbn, locked: isFieldLocked('isbn') });
            fields.push({ key: 'pages', label: '页数', type: 'text', value: mappedMetadata.pages || '', checked: !isFieldLocked('pages') && !!mappedMetadata.pages, locked: isFieldLocked('pages') });
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
            const inputDisabled = field.locked ? 'disabled' : '';
            const checkboxDisabled = field.locked ? 'disabled' : '';
            const cursorStyle = field.locked ? 'not-allowed' : 'pointer';
            const inputOpacity = field.locked ? 'opacity:0.55;' : '';
            const lockBadge = field.locked ? `<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>` : '';
            previewHtml += `
                <div class="ks-field-row" style="background:${rowBg};border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid ${rowBorder};">
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:${cursorStyle};">
                        <input type="checkbox" class="ks-field-checkbox" data-field="${field.key}" data-locked="${field.locked ? 'true' : 'false'}" ${field.checked ? 'checked' : ''} ${checkboxDisabled} style="width:16px;height:16px;accent-color:#667eea;cursor:${cursorStyle};">
                        <span style="color:${labelColor};font-size:14px;font-weight:500;">${field.label}${lockBadge}</span>
                    </label>
                    ${isTextarea ? `
                        <textarea class="ks-field-input" data-field="${field.key}" ${inputDisabled} style="width:calc(100% - 16px);min-height:80px;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;resize:vertical;font-family:inherit;line-height:1.5;${inputOpacity}">${safeValue}</textarea>
                    ` : `
                        <input type="text" class="ks-field-input" data-field="${field.key}" value="${safeValue}" ${inputDisabled} style="width:calc(100% - 16px);padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;${inputOpacity}">
                    `}
                </div>
            `;
        });

        if (hasAuthors) {
            const authorLocked = currentMetadata.authorsLock === true;
            previewHtml += `
                <div class="ks-field-row" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.06);">
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;">
                        <input type="checkbox" class="ks-author-checkbox" ${authorLocked ? 'disabled' : 'checked'} style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:#fff;font-size:14px;font-weight:500;">作者 / 作画${authorLocked ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>' : ''}</span>
                    </label>
            `;
            mappedMetadata.authors.forEach(function(a, idx) {
                const safeName = String(a.name || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
                const safeRole = a.role === 'artist' ? '作画' : '作者';
                previewHtml += `
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                        <span style="color:rgba(255,255,255,0.6);font-size:12px;width:40px;flex-shrink:0;">${safeRole}</span>
                        <input type="text" class="ks-author-input" data-role="${a.role}" data-idx="${idx}" value="${safeName}" ${authorLocked ? 'disabled' : ''} style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
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
                        <input type="checkbox" class="ks-tags-checkbox" ${tagsLocked ? 'disabled' : 'checked'} style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:#fff;font-size:14px;font-weight:500;">标签 (Tags)${tagsLocked ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>' : ''}</span>
                    </label>
                    <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:8px;">多个标签请用英文逗号 "," 分隔</div>
                    <textarea class="ks-tags-input" ${tagsLocked ? 'disabled' : ''} style="width:calc(100% - 16px);min-height:60px;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;resize:vertical;font-family:inherit;line-height:1.5;">${safeTagText}</textarea>
                </div>
            `;
        }

        if (pageType === 'series') {
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
                        <input type="checkbox" class="ks-reading-direction-checkbox" ${rdLocked ? 'disabled' : ''} checked style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:#fff;font-size:14px;font-weight:500;">阅读方向 (Reading Direction)${rdLocked ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>' : ''}</span>
                    </label>
                    <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:8px;">默认设置为从右到左，可根据实际漫画类型手动切换</div>
                    <select class="ks-reading-direction" ${rdLocked ? 'disabled' : ''} style="width:calc(100% - 16px);padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
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
            const selectedFields = {};
            const updatedFields = [];
            const skippedFields = [];
            const fieldLabels = { title: '标题', summary: '简介', status: '状态', releaseDate: '发布日期', isbn: 'ISBN', pages: '页数', author: '作者', tags: '标签', readingDirection: '阅读方向' };

            checkboxes.forEach(function(cb) {
                const fieldKey = cb.getAttribute('data-field');
                const isLocked = cb.getAttribute('data-locked') === 'true' || currentMetadata[fieldKey + 'Lock'] === true;
                if (isLocked) {
                    if (cb.checked) {
                        skippedFields.push(fieldKey);
                    }
                    return;
                }
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
            }

            if (config.debug && skippedFields.length > 0) {
                console.log('[KomgaScraper] Skipped locked fields:', skippedFields);
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
            newConfig.autoRefresh = document.getElementById('ks-setting-auto-refresh').checked;
            newConfig.debug = document.getElementById('ks-setting-debug').checked;

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
                const bookNumber = currentData.number != null ? String(currentData.number) : '';
                const bookName = (currentData.metadata && currentData.metadata.title) || currentData.name || '';

                if (isFanza) {
                    if (seriesTitle && bookName) {
                        searchTitle = seriesTitle + ' ' + bookName;
                    } else if (bookName) {
                        searchTitle = bookName;
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
            try {
                if (isFanza) {
                    searchResults = await scrapeFromFanza(cleanKeyword);
                } else {
                    searchResults = await scrapeFromBangumi(cleanKeyword);
                }
            } catch (e) {
                loading.remove();
                showError('搜索请求失败', '请检查网络连接', function() {
                    startScrapeProcess(source);
                });
                return;
            }

            loading.remove();

            showSearchResults(searchResults, async function(selectedResult) {
                // showSearchResults 第 3-5 参数用于无结果时修改搜索词重试
                showLoading('正在获取详细数据...');
                let detail;
                if (isFanza) {
                    detail = await fetchFanzaDetail(selectedResult.url);
                } else {
                    detail = await fetchSubjectDetail(selectedResult.id);
                }
                closeAllModals();

                if (!detail) {
                    showError('获取详情失败', '无法获取详细数据，将使用搜索结果');
                    showMetadataPreview(selectedResult, currentData, pageType, source, function(selectedFields, updatedFields) {
                        if (Object.keys(selectedFields).length === 0) {
                            showError('未选择任何字段', '请至少勾选一个要更新的字段');
                            return;
                        }
                        writeMetadataToKomga(pageType, pageId, selectedFields, updatedFields, currentData);
                    });
                    return;
                }

                showMetadataPreview(detail, currentData, pageType, source, function(selectedFields, updatedFields) {
                    if (Object.keys(selectedFields).length === 0) {
                        showError('未选择任何字段', '请至少勾选一个要更新的字段');
                        return;
                    }

                    writeMetadataToKomga(pageType, pageId, selectedFields, updatedFields, currentData);
                });
            }, cleanKeyword, doRetry, source);

        } catch (e) {
            console.error('[KomgaScraper] Scrape process failed:', e);
            showError('刮削过程中发生错误', e.message || '请查看浏览器控制台获取详细信息');
        }
    }

    async function writeMetadataToKomga(pageType, pageId, metadata, updatedFields, currentData) {
        try {
            const config = getConfig();

            const currentMetadata = currentData && currentData.metadata ? currentData.metadata : {};
            const finalMetadata = {};
            const finalUpdated = [];
            const writtenScalarKeys = [];
            const fieldLabels = { title: '标题', summary: '简介', status: '状态', releaseDate: '发布日期', isbn: 'ISBN', author: '作者', authors: '作者', links: '来源链接', tags: '标签', readingDirection: '阅读方向' };

            if (config.debug) console.log('[KomgaScraper] Raw metadata from UI:', JSON.stringify(metadata, null, 2));

            Object.keys(metadata).forEach(function(key) {
                const value = metadata[key];

                if (key === 'pages') return;
                if (currentMetadata[key + 'Lock'] === true) {
                    if (config.debug) console.log('[KomgaScraper] Skipping locked field:', key);
                    return;
                }

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

            if (Object.keys(finalMetadata).length === 0) {
                showError('无可用字段', '所有勾选的字段都已被锁定或包含无效值，无法写入');
                return;
            }

            if (config.debug) console.log('[KomgaScraper] Writing metadata to Komga:', JSON.stringify(finalMetadata, null, 2));

            showLoading('正在写入元数据到 Komga...');

            let success;
            if (pageType === 'series') {
                success = await updateSeriesMetadata(pageId, finalMetadata);
            } else {
                success = await updateBookMetadata(pageId, finalMetadata);
            }

            if (success) {
                if (config.debug) console.log('[KomgaScraper] Metadata updated successfully');
                showSuccess(finalUpdated, function() {
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

// @match        {你自己的komga网站地址}
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
        autoRefresh: true,
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

    function mergeLinks(newLinks, currentLinks) {
        const byUrl = {};
        const result = [];
        const addLink = function(link) {
            if (!link) return;
            const url = cleanUrl(link.url);
            if (!url) return;
            const label = String(link.label || '').trim();
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

    function extractStatusFromInfobox(infobox) {
        if (!infobox || !Array.isArray(infobox)) return null;
        for (let i = 0; i < infobox.length; i++) {
            const item = infobox[i];
            const key = String(item.key || '');
            const val = getInfoboxValue(item.value);
            if (key.indexOf('连载') !== -1 || key.indexOf('状态') !== -1 ||
                key.indexOf('完结') !== -1 || key.indexOf('结束') !== -1) {
                if (val.indexOf('完结') !== -1 || val.indexOf('结束') !== -1 || val.indexOf('已完结') !== -1) {
                    return 'ENDED';
                }
                if (val.indexOf('连载') !== -1 || val.indexOf('进行') !== -1 || val.indexOf('播出') !== -1) {
                    return 'ONGOING';
                }
            }
        }
        return null;
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

    function mapBangumiToSeries(bangumiData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        const isZh = String(metadata.language || '').toLowerCase() === 'zh';
        const preferredTitle = isZh ? bangumiData.title : bangumiData.originalTitle;
        const fallbackTitle = isZh ? bangumiData.originalTitle : bangumiData.title;
        newMetadata.title = preferredTitle || fallbackTitle || metadata.title;

        newMetadata.summary = bangumiData.summary || metadata.summary;

        const infoboxStatus = extractStatusFromInfobox(bangumiData.infobox);
        newMetadata.status = infoboxStatus || mapBangumiStatus(bangumiData.status) || metadata.status;

        if (bangumiData.rating) {
            newMetadata.summary = (newMetadata.summary || '') + '\n\n评分: ' + bangumiData.rating;
        }

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

    function mapBangumiToBook(bangumiData, currentMetadata) {
        const metadata = currentMetadata || {};
        const newMetadata = {};

        const isZh = String(metadata.language || '').toLowerCase() === 'zh';
        const preferredTitle = isZh ? bangumiData.title : bangumiData.originalTitle;
        const fallbackTitle = isZh ? bangumiData.originalTitle : bangumiData.title;
        newMetadata.title = preferredTitle || fallbackTitle || metadata.title;

        let summaryExtra = '';
        if (bangumiData.pages) {
            summaryExtra += '\n\n页数: ' + bangumiData.pages;
        }
        newMetadata.summary = (bangumiData.summary || metadata.summary || '') + summaryExtra;
        if (!newMetadata.summary) delete newMetadata.summary;

        newMetadata.releaseDate = bangumiData.airDate || metadata.releaseDate;

        const normalizedIsbn = normalizeIsbn(bangumiData.isbn);
        if (normalizedIsbn) newMetadata.isbn = normalizedIsbn;
        if (bangumiData.pages) newMetadata.pages = bangumiData.pages;
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

    const BANGUMI_API_BASE = 'https://api.bgm.tv';
    const BANGUMI_USER_AGENT = 'KomgaMetadataScraper/1.2.0 (https://github.com/yourname/komga-scraper)';

    async function scrapeFromBangumi(keyword) {
        try {
            const config = getConfig();
            const debug = config.debug;

            if (debug) console.log('[KomgaScraper] [Bangumi] Searching v0 for keyword:', keyword);

            const searchUrl = BANGUMI_API_BASE + '/v0/search/subjects?limit=10';

            if (debug) console.log('[KomgaScraper] [Bangumi] Request URL:', searchUrl);

            const requestBody = JSON.stringify({
                keyword: keyword,
                sort: 'rank',
                filter: {
                    type: [1],
                    nsfw: true
                }
            });

            if (debug) console.log('[KomgaScraper] [Bangumi] Request body:', requestBody);

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

            if (debug) console.log('[KomgaScraper] [Bangumi] Response status:', response.status, 'hasData:', !!response.data);

            if (response.status !== 200) {
                console.warn('[KomgaScraper] [Bangumi] Non-200 status code:', response.status);
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

            if (!response.data.data || response.data.data.length === 0) {
                if (debug) console.log('[KomgaScraper] [Bangumi] No results in response');
                return [];
            }

            const results = response.data.data.map(function(item, index) {
                const airDateVal = item.date || item.air_date || '';
                const itemId = String(item.id || '').replace(/[^0-9a-zA-Z]/g, '');
                const bangumiUrl = cleanUrl('https://bgm.tv/subject/' + itemId);
                const result = {
                    id: itemId,
                    title: item.name_cn || item.name,
                    originalTitle: item.name,
                    summary: item.summary || '',
                    image: item.images && item.images.common ? item.images.common : '',
                    largeImage: item.images && item.images.large ? item.images.large : '',
                    rating: item.rating && item.rating.score ? item.rating.score : null,
                    status: airDateVal && airDateVal > new Date().toISOString().slice(0, 10) ? 'Ongoing' : 'Ended',
                    airDate: airDateVal,
                    url: bangumiUrl,
                    date: item.date || '',
                    links: [{ label: 'Bangumi', url: bangumiUrl }]
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

    async function fetchSubjectDetail(subjectIdParam) {
        try {
            const config = getConfig();
            const debug = config.debug;

            if (debug) console.log('[KomgaScraper] [Bangumi] Fetching detail for subject:', subjectIdParam);

            const detailUrl = BANGUMI_API_BASE + '/v0/subjects/' + subjectIdParam;

            if (debug) console.log('[KomgaScraper] [Bangumi] Detail URL:', detailUrl);

            const response = await fetchWithRateLimit({
                method: 'GET',
                url: detailUrl,
                headers: {
                    'User-Agent': BANGUMI_USER_AGENT,
                    'Accept': 'application/json',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                }
            });

            if (debug) console.log('[KomgaScraper] [Bangumi] Detail response status:', response.status);

            if (response.status !== 200 || !response.data) {
                console.warn('[KomgaScraper] [Bangumi] Failed to get subject detail');
                return null;
            }

            const data = response.data;
            const infobox = data.infobox || [];

            if (debug) console.log('[KomgaScraper] [Bangumi] Infobox:', JSON.stringify(infobox));

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
            if (!publishDate && data.date && looksLikeDate(data.date)) publishDate = data.date;
            if (!publishDate && data.air_date && looksLikeDate(data.air_date)) publishDate = data.air_date;

            const pagesRaw = extractFromInfobox(
                infobox,
                ['页数', '页数', 'page', 'Page', 'p.', 'P.'],
                ['出版社', '作者', '原作', '脚本']
            );
            let pages = '';
            if (pagesRaw) {
                const pageMatch = pagesRaw.match(/\d+/);
                if (pageMatch) pages = pageMatch[0];
            }

            const authors = extractAllAuthorsFromInfobox(infobox);

            const subjectItemId = String(data.id || '').replace(/[^0-9a-zA-Z]/g, '');
            const subjectDate = data.date || data.air_date || '';
            const bangumiLinkUrl = cleanUrl('https://bgm.tv/subject/' + subjectItemId);
            const detail = {
                id: subjectItemId,
                title: data.name_cn || data.name,
                originalTitle: data.name,
                summary: data.summary || '',
                image: data.images && data.images.common ? data.images.common : '',
                largeImage: data.images && data.images.large ? data.images.large : '',
                rating: data.rating && data.rating.score ? data.rating.score : null,
                status: subjectDate && subjectDate > new Date().toISOString().slice(0, 10) ? 'Ongoing' : 'Ended',
                airDate: publishDate || subjectDate || '',
                url: bangumiLinkUrl,
                infobox: infobox,
                isbn: isbn,
                pages: pages,
                authors: authors,
                links: [{ label: 'Bangumi', url: bangumiLinkUrl }]
            };

            if (debug) console.log('[KomgaScraper] [Bangumi] Detail result:', JSON.stringify(detail, null, 2));
            return detail;

        } catch (e) {
            console.error('[KomgaScraper] [Bangumi] Failed to fetch subject detail:', e);
            return null;
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
        const config = getConfig();
        const shouldAutoRefresh = config.autoRefresh !== false;
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

        function isFieldLocked(key) {
            return currentMetadata[key + 'Lock'] === true;
        }

        const fields = [
            { key: 'title', label: '标题', type: 'text', value: mappedMetadata.title || '', checked: !isFieldLocked('title'), locked: isFieldLocked('title') },
            { key: 'summary', label: '简介', type: 'textarea', value: mappedMetadata.summary || '', checked: !isFieldLocked('summary'), locked: isFieldLocked('summary') },
            { key: 'status', label: '状态', type: 'text', value: mappedMetadata.status || '', checked: !isFieldLocked('status') && !!mappedMetadata.status, locked: isFieldLocked('status') }
        ];

        if (pageType === 'book') {
            fields.push({ key: 'releaseDate', label: '发布日期', type: 'text', value: mappedMetadata.releaseDate || '', checked: !isFieldLocked('releaseDate') && !!mappedMetadata.releaseDate, locked: isFieldLocked('releaseDate') });
            fields.push({ key: 'isbn', label: 'ISBN', type: 'text', value: mappedMetadata.isbn || '', checked: !isFieldLocked('isbn') && !!mappedMetadata.isbn, locked: isFieldLocked('isbn') });
            fields.push({ key: 'pages', label: '页数', type: 'text', value: mappedMetadata.pages || '', checked: !isFieldLocked('pages') && !!mappedMetadata.pages, locked: isFieldLocked('pages') });
        }

        const hasAuthors = mappedMetadata.authors && mappedMetadata.authors.length > 0;
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
            const rowBg = field.locked ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.03)';
            const rowBorder = field.locked ? 'rgba(255,200,100,0.25)' : 'rgba(255,255,255,0.06)';
            const labelColor = field.locked ? 'rgba(255,255,255,0.5)' : '#fff';
            const inputDisabled = field.locked ? 'disabled' : '';
            const checkboxDisabled = field.locked ? 'disabled' : '';
            const cursorStyle = field.locked ? 'not-allowed' : 'pointer';
            const inputOpacity = field.locked ? 'opacity:0.55;' : '';
            const lockBadge = field.locked ? `<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>` : '';
            previewHtml += `
                <div class="ks-field-row" style="background:${rowBg};border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid ${rowBorder};">
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:${cursorStyle};">
                        <input type="checkbox" class="ks-field-checkbox" data-field="${field.key}" data-locked="${field.locked ? 'true' : 'false'}" ${field.checked ? 'checked' : ''} ${checkboxDisabled} style="width:16px;height:16px;accent-color:#667eea;cursor:${cursorStyle};">
                        <span style="color:${labelColor};font-size:14px;font-weight:500;">${field.label}${lockBadge}</span>
                    </label>
                    ${isTextarea ? `
                        <textarea class="ks-field-input" data-field="${field.key}" ${inputDisabled} style="width:calc(100% - 16px);min-height:80px;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;resize:vertical;font-family:inherit;line-height:1.5;${inputOpacity}">${safeValue}</textarea>
                    ` : `
                        <input type="text" class="ks-field-input" data-field="${field.key}" value="${safeValue}" ${inputDisabled} style="width:calc(100% - 16px);padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;${inputOpacity}">
                    `}
                </div>
            `;
        });

        if (hasAuthors) {
            const authorLocked = currentMetadata.authorsLock === true;
            previewHtml += `
                <div class="ks-field-row" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.06);">
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;">
                        <input type="checkbox" class="ks-author-checkbox" ${authorLocked ? 'disabled' : 'checked'} style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:#fff;font-size:14px;font-weight:500;">作者 / 作画${authorLocked ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>' : ''}</span>
                    </label>
            `;
            mappedMetadata.authors.forEach(function(a, idx) {
                const safeName = String(a.name || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
                const safeRole = a.role === 'artist' ? '作画' : '作者';
                previewHtml += `
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                        <span style="color:rgba(255,255,255,0.6);font-size:12px;width:40px;flex-shrink:0;">${safeRole}</span>
                        <input type="text" class="ks-author-input" data-role="${a.role}" data-idx="${idx}" value="${safeName}" ${authorLocked ? 'disabled' : ''} style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
                    </div>
                `;
            });
            previewHtml += `</div>`;
        }

        if (pageType === 'series') {
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
                        <input type="checkbox" class="ks-reading-direction-checkbox" ${rdLocked ? 'disabled' : ''} checked style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;">
                        <span style="color:#fff;font-size:14px;font-weight:500;">阅读方向 (Reading Direction)${rdLocked ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;background:rgba(255,193,7,0.15);color:#ffc107;font-size:11px;font-weight:500;line-height:1.4;">已锁定</span>' : ''}</span>
                    </label>
                    <div style="color:rgba(255,255,255,0.5);font-size:12px;margin-bottom:8px;">默认设置为从右到左，可根据实际漫画类型手动切换</div>
                    <select class="ks-reading-direction" ${rdLocked ? 'disabled' : ''} style="width:calc(100% - 16px);padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;font-family:inherit;">
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
            const selectedFields = {};
            const updatedFields = [];
            const skippedFields = [];
            const fieldLabels = { title: '标题', summary: '简介', status: '状态', releaseDate: '发布日期', isbn: 'ISBN', pages: '页数', author: '作者', readingDirection: '阅读方向' };

            checkboxes.forEach(function(cb) {
                const fieldKey = cb.getAttribute('data-field');
                const isLocked = cb.getAttribute('data-locked') === 'true' || currentMetadata[fieldKey + 'Lock'] === true;
                if (isLocked) {
                    if (cb.checked) {
                        skippedFields.push(fieldKey);
                    }
                    return;
                }
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
            }

            if (config.debug && skippedFields.length > 0) {
                console.log('[KomgaScraper] Skipped locked fields:', skippedFields);
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
            newConfig.autoRefresh = document.getElementById('ks-setting-auto-refresh').checked;
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
                const seriesTitle = currentData.seriesTitle ? currentData.seriesTitle.trim() : '';
                const bookNumber = currentData.number != null ? String(currentData.number) : '';
                if (seriesTitle && bookNumber) {
                    searchTitle = seriesTitle + ' ' + bookNumber;
                } else if (seriesTitle) {
                    searchTitle = seriesTitle;
                } else {
                    searchTitle = currentData.name;
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

            showSearchResults(searchResults, async function(selectedResult) {
                showLoading('正在获取详细数据...');
                const detail = await fetchSubjectDetail(selectedResult.id);
                closeAllModals();

                if (!detail) {
                    showError('获取详情失败', '无法获取详细数据，将使用搜索结果');
                    showMetadataPreview(selectedResult, currentData, pageType, function(selectedFields, updatedFields) {
                        if (Object.keys(selectedFields).length === 0) {
                            showError('未选择任何字段', '请至少勾选一个要更新的字段');
                            return;
                        }
                        writeMetadataToKomga(pageType, pageId, selectedFields, updatedFields, currentData);
                    });
                    return;
                }

                showMetadataPreview(detail, currentData, pageType, function(selectedFields, updatedFields) {
                    if (Object.keys(selectedFields).length === 0) {
                        showError('未选择任何字段', '请至少勾选一个要更新的字段');
                        return;
                    }

                    writeMetadataToKomga(pageType, pageId, selectedFields, updatedFields, currentData);
                });
            });

        } catch (e) {
            console.error('[KomgaScraper] Scrape process failed:', e);
            showError('刮削过程中发生错误', e.message || '请查看浏览器控制台获取详细信息');
        }
    }

    async function writeMetadataToKomga(pageType, pageId, metadata, updatedFields, currentData) {
        try {
            const config = getConfig();

            const currentMetadata = currentData && currentData.metadata ? currentData.metadata : {};
            const finalMetadata = {};
            const finalUpdated = [];
            const writtenScalarKeys = [];
            const fieldLabels = { title: '标题', summary: '简介', status: '状态', releaseDate: '发布日期', isbn: 'ISBN', author: '作者', authors: '作者', links: '来源链接', readingDirection: '阅读方向' };

            if (config.debug) console.log('[KomgaScraper] Raw metadata from UI:', JSON.stringify(metadata, null, 2));

            Object.keys(metadata).forEach(function(key) {
                const value = metadata[key];

                if (key === 'pages') return;
                if (currentMetadata[key + 'Lock'] === true) {
                    if (config.debug) console.log('[KomgaScraper] Skipping locked field:', key);
                    return;
                }

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
                        } else if (config.debug) {
                            console.log('[KomgaScraper] Skipping invalid author value:', value);
                        }
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

            if (Object.keys(finalMetadata).length === 0) {
                showError('无可用字段', '所有勾选的字段都已被锁定或包含无效值，无法写入');
                return;
            }

            if (config.debug) console.log('[KomgaScraper] Writing metadata to Komga:', JSON.stringify(finalMetadata, null, 2));

            showLoading('正在写入元数据到 Komga...');

            let success;
            if (pageType === 'series') {
                success = await updateSeriesMetadata(pageId, finalMetadata);
            } else {
                success = await updateBookMetadata(pageId, finalMetadata);
            }

            if (success) {
                if (config.debug) console.log('[KomgaScraper] Metadata updated successfully');
                showSuccess(finalUpdated, function() {
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
