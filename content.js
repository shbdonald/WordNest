// WordNest 单词窝 - Content Script
(function() {
  'use strict';

  // DeepSeek 仅允许详情页手动按钮触发，内容脚本永不自动调用
  const ENABLE_DEEPSEEK_API = false;
  // Free Dictionary：自动补全，已缓存则跳过
  const AUTO_API_ENRICH = true;

  // 存储已记录的单词
  let savedWords = new Set();
  let wordTranslations = new Map(); // 简单中文翻译（用于页面标记）
  let wordDictionaryData = new Map(); // 完整词典数据（Free Dictionary / 离线等）
  let wordChineseTranslations = new Map(); // 中文翻译（离线/有道/百度/Google 等）
  let wordChineseSources = new Map(); // 中文词义来源：ecd|gt|bd|mm|youdao|deepseek 等
  let wordStatus = new Map(); // 单词状态：'new'未记住, 'mastered'已记住
  let wordNotes = new Map(); // 用户对生词的个人备注（不影响词库）
  let isLoaded = false;
  let isMarking = false;
  let currentTooltip = null;
  let currentPopup = null;
  // 记录每个单词最近一次翻译/词典的来源，用于 tooltip 来源显示
  const wordSourceMap = new Map(); // key: lowerWord, value: 'ecd' | 'fd' | 'gt' | 'bd' | 'mm' 等

  const DICT_ZH_IDS = ['offline', 'youdao_dict', 'd3325'];
  const DICT_EN_IDS = ['fd', 'datamuse'];

  const DEFAULT_API_ROUTE = {
    translateOrder: ['offline', 'youdao', 'baidu', 'gt', 'mm'],
    dictZhPrimary: 'offline',
    dictZhBackup: 'youdao_dict',
    dictEnPrimary: 'fd',
    dictEnBackup: 'datamuse',
    dictOrder: ['offline', 'youdao_dict', 'fd', 'datamuse'],
    ttsOrder: ['youdao_tts', 'google_tts']
  };

  const EXTENSION_RELOAD_HINT = '扩展已更新，请刷新页面';
  const FAILED_TRANSLATION_TEXTS = new Set([
    '翻译失败',
    '翻译失败，请检查网络',
    '翻译失败，请稍后重试',
    EXTENSION_RELOAD_HINT
  ]);

  function isFailedTranslationText(text) {
    return FAILED_TRANSLATION_TEXTS.has(String(text || '').trim());
  }

  function isExtensionContextValid() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  let extensionReloadHintShown = false;
  function notifyExtensionContextInvalid() {
    if (extensionReloadHintShown) return;
    extensionReloadHintShown = true;
    try {
      if (typeof showVocabToast === 'function') showVocabToast(EXTENSION_RELOAD_HINT, 'error');
    } catch (e) {}
  }

  function mergeOrderWithDefaults(order, defaults) {
    const out = Array.isArray(order) ? order.filter((id) => defaults.includes(id)) : [];
    defaults.forEach((id) => {
      if (!out.includes(id)) out.push(id);
    });
    return out;
  }

  function resolveDetailSlots(cfg) {
    const raw = cfg && typeof cfg === 'object' ? cfg : {};
    const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
    let zhPrimary = pick(raw.dictZhPrimary, DICT_ZH_IDS, DEFAULT_API_ROUTE.dictZhPrimary);
    let zhBackup = pick(raw.dictZhBackup, DICT_ZH_IDS, DEFAULT_API_ROUTE.dictZhBackup);
    let enPrimary = pick(raw.dictEnPrimary, DICT_EN_IDS, DEFAULT_API_ROUTE.dictEnPrimary);
    let enBackup = pick(raw.dictEnBackup, DICT_EN_IDS, DEFAULT_API_ROUTE.dictEnBackup);
    if (!raw.dictZhPrimary && !raw.dictEnPrimary && Array.isArray(raw.dictOrder)) {
      const zh = raw.dictOrder.filter((id) => DICT_ZH_IDS.includes(id));
      const en = raw.dictOrder.filter((id) => DICT_EN_IDS.includes(id));
      if (zh[0]) zhPrimary = zh[0];
      if (zh.find((id) => id !== zhPrimary)) zhBackup = zh.find((id) => id !== zhPrimary);
      if (en[0]) enPrimary = en[0];
      if (en.find((id) => id !== enPrimary)) enBackup = en.find((id) => id !== enPrimary);
    }
    if (zhBackup === zhPrimary) zhBackup = DICT_ZH_IDS.find((id) => id !== zhPrimary) || zhPrimary;
    if (enBackup === enPrimary) enBackup = DICT_EN_IDS.find((id) => id !== enPrimary) || enPrimary;
    return { zhPrimary, zhBackup, enPrimary, enBackup };
  }

  async function getApiRouteConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['apiRouteConfig'], (result) => {
          const cfg = result && result.apiRouteConfig;
          if (!cfg || typeof cfg !== 'object') {
            resolve({ ...DEFAULT_API_ROUTE });
            return;
          }
          const slots = resolveDetailSlots(cfg);
          resolve({
            translateOrder: mergeOrderWithDefaults(cfg.translateOrder, DEFAULT_API_ROUTE.translateOrder),
            dictZhPrimary: slots.zhPrimary,
            dictZhBackup: slots.zhBackup,
            dictEnPrimary: slots.enPrimary,
            dictEnBackup: slots.enBackup,
            dictOrder: [slots.zhPrimary, slots.zhBackup, slots.enPrimary, slots.enBackup]
              .filter((id, i, arr) => id && arr.indexOf(id) === i),
            ttsOrder: mergeOrderWithDefaults(cfg.ttsOrder, DEFAULT_API_ROUTE.ttsOrder)
          });
        });
      } catch (e) {
        resolve({ ...DEFAULT_API_ROUTE });
      }
    });
  }

  const CHINESE_SOURCE_LABELS = {
    deepseek: 'DeepSeek',
    ecd: '离线英汉词典',
    gt: 'Google 翻译',
    bd: '百度翻译',
    mm: 'MyMemory 翻译',
    youdao: '有道翻译',
    youdao_dict: '有道词典',
    d3325: '3325词典',
    bing: 'Bing 翻译',
    offline: '离线词典'
  };

  const EXTENSION_FETCH_HOSTS = new Set([
    'api.dictionaryapi.dev',
    'api.datamuse.com',
    'dict.youdao.com',
    'fanyi.youdao.com',
    'translate.googleapis.com',
    '3325.cn',
    'api.mymemory.translated.net'
  ]);

  // 网页 CSP 会拦截内容脚本的 fetch，词典请求改走后台。
  function extensionFetch(url, options) {
    const timeoutMs = (options && options.timeoutMs) || 8000;
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch (e) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (parsed.protocol !== 'https:' || !EXTENSION_FETCH_HOSTS.has(parsed.hostname)) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (!isExtensionContextValid()) {
      notifyExtensionContextInvalid();
      return Promise.reject(new Error(EXTENSION_RELOAD_HINT));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error('Request timeout');
        err.name = 'AbortError';
        reject(err);
      }, timeoutMs + 800);
      try {
        chrome.runtime.sendMessage(
          { action: 'proxyHttpGet', url: parsed.toString(), timeoutMs },
          (res) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              reject(new TypeError(chrome.runtime.lastError.message || 'Failed to fetch'));
              return;
            }
            if (!res || res.success === false) {
              const message = (res && res.error) || 'Failed to fetch';
              if (/timeout|abort/i.test(message)) {
                const err = new Error('Request timeout');
                err.name = 'AbortError';
                reject(err);
                return;
              }
              reject(new TypeError(message === 'Failed to fetch' ? 'Failed to fetch' : message));
              return;
            }
            const text = typeof res.text === 'string' ? res.text : '';
            resolve({
              ok: !!res.ok,
              status: res.status || 0,
              text: async () => text,
              json: async () => JSON.parse(text)
            });
          }
        );
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  function chineseSourceLabel(code) {
    if (!code) return '';
    return CHINESE_SOURCE_LABELS[code] || String(code);
  }

  function setChineseSource(word, source) {
    const lower = String(word || '').toLowerCase();
    const src = String(source || '').trim();
    if (!lower || !src) return;
    wordChineseSources.set(lower, src);
  }

  function appendChineseSourcesToPayload(userData, userKey) {
    if (!userData || !userKey) return userData;
    userData[`${userKey}wordChineseSources`] = Array.from(wordChineseSources.entries());
    return userData;
  }

  // 获取当前用户ID
  function getCurrentUserId() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['currentUserId'], (result) => {
        resolve(result.currentUserId || 'default');
      });
    });
  }

  // 从存储中加载已记录的单词
  async function loadWords() {
    return new Promise(async (resolve) => {
      const currentUserId = await getCurrentUserId();
      const userKey = `user_${currentUserId}_`;
      
      chrome.storage.local.get([
        `${userKey}savedWords`, 
        `${userKey}wordTranslations`, 
        `${userKey}wordDictionaryData`, 
        `${userKey}wordChineseTranslations`,
        `${userKey}wordChineseSources`,
        `${userKey}wordStatus`,
        `${userKey}wordNotes`
      ], (result) => {
        if (result[`${userKey}savedWords`] && Array.isArray(result[`${userKey}savedWords`])) {
          savedWords = new Set(result[`${userKey}savedWords`]);
          wordTranslations = new Map(result[`${userKey}wordTranslations`] || []);
          wordDictionaryData = new Map(result[`${userKey}wordDictionaryData`] || []);
          wordChineseTranslations = new Map(result[`${userKey}wordChineseTranslations`] || []);
          wordChineseSources = new Map(result[`${userKey}wordChineseSources`] || []);
          wordStatus = new Map(result[`${userKey}wordStatus`] || []);
          wordNotes = new Map(result[`${userKey}wordNotes`] || []);
        } else {
          // 如果没有用户数据，初始化为空
          savedWords = new Set();
          wordTranslations = new Map();
          wordDictionaryData = new Map();
          wordChineseTranslations = new Map();
          wordChineseSources = new Map();
          wordStatus = new Map();
          wordNotes = new Map();
        }
        isLoaded = true;
        resolve();
      });
    });
  }

  // 初始化加载改由底部 initMarking() 统一触发，避免整页扫描两次

  // 本地刚写入 storage 时，短暂忽略 onChanged 触发的重复整页重标记
  let suppressStorageRemountUntil = 0;
  function noteLocalVocabWrite() {
    suppressStorageRemountUntil = Date.now() + 1000;
  }

  // 格式化翻译文本（用于标记显示：始终中文）
  function formatTranslationForDisplay(dictData, chineseHint) {
    if (chineseHint) return String(chineseHint);
    if (!dictData) return '';
    if (dictData.translation) return String(dictData.translation);
    return formatEnglishDefinition(dictData) || '';
  }

  // 保存单词到存储（中文释义 + 词典详情；详情链路按地区优先级）
  async function saveWord(word, translation) {
    return new Promise(async (resolve) => {
      const currentUserId = await getCurrentUserId();
      const userKey = `user_${currentUserId}_`;
      const lowerWord = word.toLowerCase();
      savedWords.add(lowerWord);

      const [dictData, chineseTranslation] = await Promise.all([
        fetchDictionaryInfo(word),
        translateWordToChinese(word)
      ]);
      
      if (dictData) {
        wordDictionaryData.set(lowerWord, dictData);
      }
      
      if (chineseTranslation && !isFailedTranslationText(chineseTranslation)) {
        wordChineseTranslations.set(lowerWord, chineseTranslation);
        if (!wordChineseSources.has(lowerWord)) {
          setChineseSource(lowerWord, wordSourceMap.get(lowerWord) || 'offline');
        }
      } else if (translation) {
        wordChineseTranslations.set(lowerWord, translation);
        if (!wordChineseSources.has(lowerWord)) {
          setChineseSource(lowerWord, wordSourceMap.get(lowerWord) || 'offline');
        }
      }

      const displayText = wordChineseTranslations.get(lowerWord) || translation || '';
      wordTranslations.set(lowerWord, displayText);
      
      if (!wordStatus.has(lowerWord)) {
        wordStatus.set(lowerWord, 'new');
      }
      
      const userData = {};
      userData[`${userKey}savedWords`] = Array.from(savedWords);
      userData[`${userKey}wordTranslations`] = Array.from(wordTranslations.entries());
      userData[`${userKey}wordDictionaryData`] = Array.from(wordDictionaryData.entries());
      userData[`${userKey}wordChineseTranslations`] = Array.from(wordChineseTranslations.entries());
      appendChineseSourcesToPayload(userData, userKey);
      userData[`${userKey}wordStatus`] = Array.from(wordStatus.entries());
      userData[`${userKey}wordNotes`] = Array.from(wordNotes.entries());
      
      noteLocalVocabWrite();
      chrome.storage.local.set(userData, () => {
        setTimeout(() => {
          markNearSelectionOrFull();
          resolve();
        }, 100);
      });
    });
  }

  // 标记单词为已记住
  async function markWordAsMastered(word) {
    return new Promise(async (resolve) => {
      const currentUserId = await getCurrentUserId();
      const userKey = `user_${currentUserId}_`;
      const lowerWord = word.toLowerCase();
      if (savedWords.has(lowerWord)) {
        wordStatus.set(lowerWord, 'mastered');
        
        // 使用用户ID作为key保存数据
        const userData = {};
        userData[`${userKey}savedWords`] = Array.from(savedWords);
        userData[`${userKey}wordTranslations`] = Array.from(wordTranslations.entries());
        userData[`${userKey}wordDictionaryData`] = Array.from(wordDictionaryData.entries());
        userData[`${userKey}wordChineseTranslations`] = Array.from(wordChineseTranslations.entries());
        appendChineseSourcesToPayload(userData, userKey);
        userData[`${userKey}wordStatus`] = Array.from(wordStatus.entries());
        userData[`${userKey}wordNotes`] = Array.from(wordNotes.entries());
        
        noteLocalVocabWrite();
        chrome.storage.local.set(userData, () => {
          setTimeout(() => {
            markSavedWords();
            resolve();
          }, 100);
        });
      } else {
        resolve();
      }
    });
  }

  // 删除单词
  async function removeWord(word) {
    return new Promise(async (resolve) => {
      const currentUserId = await getCurrentUserId();
      const userKey = `user_${currentUserId}_`;
      const lowerWord = word.toLowerCase();
      savedWords.delete(lowerWord);
      wordTranslations.delete(lowerWord);
      wordDictionaryData.delete(lowerWord);
      wordChineseTranslations.delete(lowerWord);
      wordChineseSources.delete(lowerWord);
      wordStatus.delete(lowerWord);
      
      // 使用用户ID作为key保存数据
      const userData = {};
      userData[`${userKey}savedWords`] = Array.from(savedWords);
      userData[`${userKey}wordTranslations`] = Array.from(wordTranslations.entries());
      userData[`${userKey}wordDictionaryData`] = Array.from(wordDictionaryData.entries());
      userData[`${userKey}wordChineseTranslations`] = Array.from(wordChineseTranslations.entries());
      appendChineseSourcesToPayload(userData, userKey);
      userData[`${userKey}wordStatus`] = Array.from(wordStatus.entries());
      userData[`${userKey}wordNotes`] = Array.from(wordNotes.entries());
      
      noteLocalVocabWrite();
      chrome.storage.local.set(userData, () => {
        setTimeout(() => {
          markSavedWords();
          resolve();
        }, 100);
      });
    });
  }

  // 更新弹窗状态（保存/移除/标记后）
  function updatePopupAfterSave(popup, word, translation, isSaved, status) {
    if (!popup || !popup.parentNode) return;
    
    const lowerWord = word.toLowerCase();
    const isMastered = status === 'mastered';
    
    // 更新弹窗内容
    const statusEl = popup.querySelector('.vocab-popup-status');
    const actionsEl = popup.querySelector('.vocab-popup-actions');
    
    if (statusEl) {
      statusEl.innerHTML = isMastered 
        ? '<span class="status-badge mastered">✓ 已记住</span>' 
        : '<span class="status-badge new">未记住</span>';
    }
    
    if (actionsEl) {
      if (isSaved) {
        actionsEl.innerHTML = `
          <button class="vocab-btn vocab-btn-remove" data-word="${word}">移除收藏</button>
          ${!isMastered ? `<button class="vocab-btn vocab-btn-master" data-word="${word}">✓ 已记住</button>` : ''}
        `;
        
        // 重新绑定事件
        const removeBtn = actionsEl.querySelector('.vocab-btn-remove');
        if (removeBtn) {
          removeBtn.addEventListener('click', async (e) => {
            await removeWord(word);
            updatePopupAfterSave(popup, word, translation, false, 'new');
          });
        }
        
        const masterBtn = actionsEl.querySelector('.vocab-btn-master');
        if (masterBtn) {
          masterBtn.addEventListener('click', async (e) => {
            await markWordAsMastered(word);
            updatePopupAfterSave(popup, word, translation, true, 'mastered');
          });
        }
      } else {
        actionsEl.innerHTML = `<button class="vocab-btn vocab-btn-save" data-word="${word}">收藏单词</button>`;
        
        const saveBtn = actionsEl.querySelector('.vocab-btn-save');
        if (saveBtn) {
          saveBtn.addEventListener('click', async (e) => {
            await saveWord(word, translation);
            updatePopupAfterSave(popup, word, translation, true, 'new');
          });
        }
      }
    }
  }

  // 从Free Dictionary API获取单词信息（带重试）
  function hasRichMeanings(dictData) {
    return !!(dictData && Array.isArray(dictData.meanings) && dictData.meanings.length > 0);
  }

  function isMostlyChineseText(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    return (cjk / t.length) >= 0.35;
  }

  function isEnglishDefText(text) {
    const t = String(text || '').trim();
    if (t.length < 6) return false;
    return !isMostlyChineseText(t);
  }

  function hasEnglishDefinitions(dictData) {
    if (!hasRichMeanings(dictData)) return false;
    return dictData.meanings.some((m) =>
      (m.definitions || []).some((d) => isEnglishDefText(d && d.definition))
    );
  }

  function extractZhMeanings(dictData) {
    if (!dictData) return [];
    if (Array.isArray(dictData.zhMeanings) && dictData.zhMeanings.length) return dictData.zhMeanings;
    if (!hasRichMeanings(dictData)) return [];
    const out = [];
    dictData.meanings.forEach((m) => {
      const zhDefs = (m.definitions || []).filter((d) => isMostlyChineseText(d && d.definition));
      if (!zhDefs.length) return;
      out.push({
        partOfSpeech: m.partOfSpeech || '',
        definitions: zhDefs.map((d) => ({
          definition: String(d.definition || '').trim(),
          example: d.example || undefined
        }))
      });
    });
    return out;
  }

  function mergeZhMeaningsList(a, b) {
    const list = [];
    const addAll = (meanings) => {
      (meanings || []).forEach((m) => {
        const pos = String((m && m.partOfSpeech) || '');
        let bucket = list.find((x) => x.partOfSpeech === pos);
        if (!bucket) {
          bucket = { partOfSpeech: pos || '释义', definitions: [] };
          list.push(bucket);
        }
        (m.definitions || []).forEach((d) => {
          const def = String((d && d.definition) || '').trim();
          if (!def) return;
          if (bucket.definitions.some((x) => x.definition === def)) return;
          bucket.definitions.push({ definition: def, example: (d && d.example) || undefined });
        });
      });
    };
    addAll(a);
    addAll(b);
    return list.filter((m) => m.definitions && m.definitions.length);
  }

  function zhMeaningsToTranslation(zhMeanings) {
    return (zhMeanings || [])
      .map((m) => {
        const defs = (m.definitions || []).map((d) => d.definition).filter(Boolean).join('，');
        if (!defs) return '';
        const pos = String(m.partOfSpeech || '').trim();
        return pos ? `${pos} ${defs}` : defs;
      })
      .filter(Boolean)
      .join('；');
  }

  function preferZhText(a, b) {
    const sa = String(a || '').trim();
    const sb = String(b || '').trim();
    if (!sa) return sb;
    if (!sb) return sa;
    const score = (s) => (s.split(/[;；]/).filter(Boolean).length * 1000) + s.length;
    return score(sb) > score(sa) ? sb : sa;
  }

  function englishOnlyMeanings(meanings) {
    const out = [];
    (meanings || []).forEach((m) => {
      const defs = (m.definitions || []).filter((d) => isEnglishDefText(d && d.definition));
      if (!defs.length) return;
      out.push({ partOfSpeech: m.partOfSpeech || '', definitions: defs, synonyms: m.synonyms || [] });
    });
    return out;
  }

  function isLookupMiss(dictData) {
    return !!(dictData && dictData.lookupMiss === true);
  }

  function isDetailCached(dictData) {
    if (!dictData || !hasEnglishDefinitions(dictData)) return false;
    if (dictData.detailCached === true) return true;
    const src = dictData.sourceAbbr;
    return src === 'deepseek' || src === 'wordsapi' || src === 'fd' || src === 'datamuse' || src === 'api';
  }

  function mergeDictData(base, incoming) {
    if (!incoming) return base || null;
    if (!base) {
      const zh0 = extractZhMeanings(incoming);
      const en0 = hasEnglishDefinitions(incoming)
        ? englishOnlyMeanings(incoming.meanings)
        : (incoming.meanings || []);
      return {
        ...incoming,
        meanings: en0.length ? en0 : (incoming.meanings || []),
        zhMeanings: zh0,
        translation: preferZhText(incoming.translation, zhMeaningsToTranslation(zh0))
      };
    }
    const phonetics = (incoming.phonetics && incoming.phonetics.length)
      ? incoming.phonetics
      : ((base.phonetics && base.phonetics.length) ? base.phonetics : []);
    const zhMeanings = mergeZhMeaningsList(
      extractZhMeanings(base),
      hasEnglishDefinitions(incoming) ? (incoming.zhMeanings || []) : extractZhMeanings(incoming)
    );
    let meanings = Array.isArray(base.meanings) ? base.meanings : [];
    if (hasEnglishDefinitions(incoming)) {
      meanings = englishOnlyMeanings(incoming.meanings);
    } else if (hasEnglishDefinitions(base)) {
      meanings = englishOnlyMeanings(base.meanings);
    } else if (!hasRichMeanings(base) && hasRichMeanings(incoming)) {
      meanings = incoming.meanings;
    }
    const sources = [];
    const pushSrc = (c) => { if (c && !sources.includes(c)) sources.push(c); };
    (Array.isArray(base.sources) ? base.sources : []).forEach(pushSrc);
    if (base.sourceAbbr) pushSrc(base.sourceAbbr);
    (Array.isArray(incoming.sources) ? incoming.sources : []).forEach(pushSrc);
    if (incoming.sourceAbbr) pushSrc(incoming.sourceAbbr);
    const fromZh = zhMeaningsToTranslation(zhMeanings);
    let translation = preferZhText(base.translation, incoming.translation);
    translation = preferZhText(translation, fromZh);
    let translationSource = base.translationSource || base.zhSourceAbbr || '';
    if (translation && translation === String(incoming.translation || '').trim()) {
      const incomingZhSrc = incoming.translationSource || incoming.zhSourceAbbr ||
        (!hasEnglishDefinitions(incoming) ? (incoming.sourceAbbr || '') : '');
      translationSource = incomingZhSrc || translationSource;
    } else if (!translationSource) {
      translationSource = base.translationSource || base.zhSourceAbbr || '';
    }
    const preferIncomingSrc = hasEnglishDefinitions(incoming);
    const enSourceAbbr = preferIncomingSrc
      ? (incoming.enSourceAbbr || incoming.sourceAbbr || base.enSourceAbbr || '')
      : (base.enSourceAbbr || incoming.enSourceAbbr || '');
    return {
      ...base,
      ...incoming,
      phonetics,
      meanings,
      zhMeanings,
      translation,
      translationSource,
      zhSourceAbbr: translationSource || base.zhSourceAbbr || '',
      enSourceAbbr,
      usage: incoming.usage || base.usage || '',
      sourceAbbr: preferIncomingSrc
        ? (incoming.sourceAbbr || base.sourceAbbr || '')
        : (base.sourceAbbr || incoming.sourceAbbr || ''),
      sources,
      lookupMiss: false,
      lookupMissReason: '',
      lookupMissAt: undefined
    };
  }

  function parseYoudaoJsonapiToDict(word, data) {
    if (!data || typeof data !== 'object') return null;
    const ecWordRaw = data.ec && data.ec.word;
    const ecWord = Array.isArray(ecWordRaw) ? ecWordRaw[0] : ecWordRaw;
    const phonetics = [];
    const uk = ecWord && (ecWord.ukphone || ecWord.ukPhone);
    const us = ecWord && (ecWord.usphone || ecWord.usPhone);
    if (uk) phonetics.push({ text: String(uk).replace(/^\/|\/$/g, ''), source: 'youdao_uk' });
    if (us) phonetics.push({ text: String(us).replace(/^\/|\/$/g, ''), source: 'youdao_us' });

    const meanings = [];
    const trs = ecWord && Array.isArray(ecWord.trs) ? ecWord.trs : [];
    trs.forEach((item) => {
      const lines = ((((item || {}).tr || [])[0] || {}).l || {}).i || [];
      const arr = Array.isArray(lines) ? lines : [lines];
      arr.forEach((raw) => {
        const text = String(raw || '').trim();
        if (!text) return;
        let pos = '';
        let def = text;
        const m = text.match(/^([a-z]+\.)\s*(.+)$/i);
        if (m) {
          pos = m[1];
          def = m[2];
        }
        let bucket = meanings.find((x) => x.partOfSpeech === pos);
        if (!bucket) {
          bucket = { partOfSpeech: pos || '释义', definitions: [] };
          meanings.push(bucket);
        }
        bucket.definitions.push({ definition: def });
      });
    });

    // 双语例句
    const pairs = data.blng_sents_part && Array.isArray(data.blng_sents_part['sentence-pair'])
      ? data.blng_sents_part['sentence-pair']
      : [];
    if (meanings.length && pairs.length) {
      pairs.slice(0, 2).forEach((p) => {
        // 保留 <b> 标记，展示时再安全转成加粗高亮
        const eng = String((p && (p['sentence-eng'] || p.sentence)) || '').trim();
        const zh = stripHtmlToPlainText((p && p['sentence-translation']) || '');
        if (!eng) return;
        const first = meanings[0];
        if (!first.definitions.length) first.definitions.push({ definition: '' });
        if (!first.definitions[0].example) {
          first.definitions[0].example = eng;
          if (zh) first.definitions[0].exampleTranslation = zh;
        }
      });
    }

    const translation = meanings
      .map((m) => {
        const defs = (m.definitions || []).map((d) => d.definition).filter(Boolean).join('，');
        if (!defs) return '';
        const pos = String(m.partOfSpeech || '').trim();
        return pos ? `${pos} ${defs}` : defs;
      })
      .filter(Boolean)
      .join('；');

    if (!meanings.length && !translation && !phonetics.length) return null;
    return {
      word: String(word || '').trim(),
      phonetics,
      meanings,
      zhMeanings: meanings,
      translation,
      translationSource: 'youdao_dict',
      usage: '',
      sourceAbbr: 'youdao_dict'
    };
  }

  async function fetchYoudaoDictDetail(word) {
    const text = String(word || '').trim();
    if (!text) return null;
    const startedAt = Date.now();
    try {
      const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(text)}`;
      const resp = await extensionFetch(url, { timeoutMs: 4500 });
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const data = await resp.json();
      const parsed = parseYoudaoJsonapiToDict(text, data);
      appendDeepseekLog({
        word: text,
        success: !!parsed,
        error: parsed ? '' : 'empty_result',
        api: 'youdao_dict',
        source: 'content-youdao-dict',
        durationMs: Date.now() - startedAt,
        detail: parsed ? `meanings=${(parsed.meanings || []).length}` : ''
      });
      return parsed;
    } catch (e) {
      appendDeepseekLog({
        word: text,
        success: false,
        error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'failed'),
        api: 'youdao_dict',
        source: 'content-youdao-dict',
        durationMs: Date.now() - startedAt
      });
      return null;
    }
  }

  async function fetch3325DictDetail(word) {
    const text = String(word || '').trim();
    if (!text) return null;
    const startedAt = Date.now();
    try {
      const url = `https://3325.cn/api/word/${encodeURIComponent(text)}`;
      const resp = await extensionFetch(url, { timeoutMs: 4500 });
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const json = await resp.json();
      const data = json && json.data ? json.data : null;
      if (!(json && json.code === 200 && data)) throw new Error('empty_result');
      const phonetics = [];
      if (data.british) phonetics.push({ text: String(data.british).replace(/^\[|\]$/g, ''), source: '3325_uk' });
      if (data.american) phonetics.push({ text: String(data.american).replace(/^\[|\]$/g, ''), source: '3325_us' });
      const translation = String(data.jbjs || '').trim();
      const pos = String(data.cx || '释义').trim();
      const meanings = translation
        ? [{ partOfSpeech: pos, definitions: [{ definition: translation }] }]
        : [];
      const parsed = {
        word: String(data.word || text).trim(),
        phonetics,
        meanings,
        zhMeanings: meanings,
        translation,
        translationSource: 'd3325',
        usage: '',
        sourceAbbr: 'd3325'
      };
      if (!meanings.length && !phonetics.length) throw new Error('empty_result');
      appendDeepseekLog({
        word: text,
        success: true,
        api: 'd3325',
        source: 'content-3325',
        durationMs: Date.now() - startedAt,
        detail: `meanings=${meanings.length}`
      });
      return parsed;
    } catch (e) {
      appendDeepseekLog({
        word: text,
        success: false,
        error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'failed'),
        api: 'd3325',
        source: 'content-3325',
        durationMs: Date.now() - startedAt
      });
      return null;
    }
  }

  function isLookupSettled(dictData) {
    if (!dictData) return false;
    if (hasEnglishDefinitions(dictData) && (dictData.detailCached === true || isDetailCached(dictData))) {
      return true;
    }
    if (isLookupMiss(dictData) && hasEnglishDefinitions(dictData)) return true;
    if (isLookupMiss(dictData) && dictData.lookupFullChainTried === true) return true;
    return false;
  }

  function markLookupMiss(dictData, word, reason) {
    return {
      ...(dictData || {}),
      word: word || (dictData && dictData.word) || '',
      meanings: (dictData && Array.isArray(dictData.meanings)) ? dictData.meanings : [],
      lookupMiss: true,
      lookupMissAt: Date.now(),
      lookupMissReason: reason || 'not_found',
      lookupFullChainTried: true,
      detailCached: true,
      cachedAt: Date.now(),
      sourceAbbr: (dictData && dictData.sourceAbbr && dictData.sourceAbbr !== 'miss')
        ? dictData.sourceAbbr
        : 'miss'
    };
  }

  function markDetailCached(dictData, source) {
    if (!dictData) return null;
    return {
      ...dictData,
      detailCached: true,
      cachedAt: Date.now(),
      sourceAbbr: source || dictData.sourceAbbr || 'api',
      lookupMiss: false,
      lookupMissReason: '',
      lookupMissAt: undefined
    };
  }

  function isSingleLookupWord(text) {
    const value = String(text || '').trim();
    return !!value && !/\s/.test(value) && /^[A-Za-z][A-Za-z'-]{0,63}$/.test(value);
  }

  function readSharedLookup(word) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'getSharedLookup', word }, (res) => {
          if (chrome.runtime.lastError || !res || !res.success) {
            resolve(null);
            return;
          }
          resolve(res.entry || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function writeSharedLookup(word, patch) {
    if (!isSingleLookupWord(word) || !patch) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          action: 'putSharedLookup',
          word,
          dict: patch.dict || null,
          translation: patch.translation || '',
          translationSource: patch.translationSource || ''
        }, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  async function persistWordDictionaryData(word, dictData) {
    if (!word || !dictData) return;
    const lowerWord = word.toLowerCase();
    wordDictionaryData.set(lowerWord, dictData);
    if (isLookupSettled(dictData) || dictData.lookupFullChainTried === true) {
      writeSharedLookup(word, {
        dict: dictData,
        translation: dictData.translation || wordChineseTranslations.get(lowerWord) || '',
        translationSource: dictData.translationSource || wordChineseSources.get(lowerWord) || ''
      });
    }
    try {
      const currentUserId = await getCurrentUserId();
      const userKey = `user_${currentUserId}_`;
      const key = `${userKey}wordDictionaryData`;
      const result = await new Promise((resolve) => {
        chrome.storage.local.get([key], resolve);
      });
      const map = new Map(result[key] || []);
      map.set(lowerWord, dictData);
      const payload = {};
      payload[key] = Array.from(map.entries());
      await new Promise((resolve) => {
        chrome.storage.local.set(payload, resolve);
      });
    } catch (e) {
      console.warn('保存词典详情缓存失败:', e);
    }
  }

  function sanitizeDeepseekApiKey(key) {
    return String(key || '')
      .replace(/^\uFEFF/, '')
      .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
      .replace(/[“”‘’]/g, '')
      .trim()
      .replace(/[^\x21-\x7E]/g, '');
  }

  function extractDeepseekJsonObject(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch (e2) {
          return null;
        }
      }
      return null;
    }
  }

  function convertDeepseekToDictFormat(word, payload) {
    if (!payload || typeof payload !== 'object') return null;
    const phonetics = [];
    const phoneticText = payload.phonetic || payload.pronunciation || '';
    if (phoneticText) {
      phonetics.push({ text: String(phoneticText).trim(), source: 'deepseek' });
    }
    let meanings = [];
    if (Array.isArray(payload.meanings) && payload.meanings.length) {
      meanings = payload.meanings.map((m) => {
        const definitions = Array.isArray(m.definitions)
          ? m.definitions
          : (m.definition ? [{ definition: m.definition, example: m.example }] : []);
        return {
          partOfSpeech: m.partOfSpeech || m.pos || 'unknown',
          definitions: definitions
            .map((d) => ({
              definition: d.definition || d.meaning || '',
              example: d.example || undefined
            }))
            .filter((d) => d.definition),
          synonyms: Array.isArray(m.synonyms) ? m.synonyms.slice(0, 8) : []
        };
      }).filter((m) => m.definitions.length > 0);
    }
    if (!meanings.length) return null;
    return {
      word,
      phonetics,
      meanings,
      translation: payload.translation || payload.chinese || '',
      usage: payload.usage || '',
      sourceAbbr: 'deepseek'
    };
  }

  function appendDeepseekLog(entry) {
    try {
      chrome.runtime.sendMessage({ action: 'appendDeepseekApiLog', entry }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  function appendFreeDictionaryLog(entry) {
    appendDeepseekLog({
      ...entry,
      api: 'freedictionary'
    });
  }

  // 内容脚本直接请求 DeepSeek，避免经 service worker 长请求导致 message port closed
  async function fetchDeepseekInfo(word) {
    if (!ENABLE_DEEPSEEK_API) return null;
    const startedAt = Date.now();
    const cleanWord = String(word || '').trim();
    if (!cleanWord) return null;

    try {
      const keyResult = await new Promise((resolve) => {
        chrome.storage.local.get(['deepseekApiKey'], resolve);
      });
      const apiKey = sanitizeDeepseekApiKey(keyResult.deepseekApiKey || '');
      if (!apiKey) {
        appendDeepseekLog({
          word: cleanWord,
          success: false,
          error: 'missing_deepseek_key',
          source: 'content-direct',
          durationMs: Date.now() - startedAt
        });
        return null;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            temperature: 0.2,
            max_tokens: 600,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: 'You are an English learner dictionary assistant. Return ONLY valid JSON, no markdown.'
              },
              {
                role: 'user',
                content:
                  `For the English word "${cleanWord}", return JSON: ` +
                  `{"word":"${cleanWord}","phonetic":"...","translation":"中文","usage":"用法",` +
                  `"meanings":[{"partOfSpeech":"noun","definitions":[{"definition":"def","example":"ex"}]}]}`
              }
            ]
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          appendDeepseekLog({
            word: cleanWord,
            success: false,
            error: `http_${response.status}`,
            source: 'content-direct',
            durationMs: Date.now() - startedAt
          });
          return null;
        }

        const raw = await response.json();
        const content = raw && raw.choices && raw.choices[0] && raw.choices[0].message
          ? raw.choices[0].message.content
          : '';
        const parsed = extractDeepseekJsonObject(content);
        const data = convertDeepseekToDictFormat(cleanWord, parsed);
        appendDeepseekLog({
          word: cleanWord,
          success: !!(data && data.meanings && data.meanings.length),
          error: data ? '' : 'empty_result',
          source: 'content-direct',
          durationMs: Date.now() - startedAt
        });
        return data;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      appendDeepseekLog({
        word: cleanWord,
        success: false,
        error: (e && e.message) || 'request_failed',
        source: 'content-direct',
        durationMs: Date.now() - startedAt
      });
      return null;
    }
  }

  // 同一单词并发查详情时复用同一 Promise，避免悬停/收藏/详情同时打爆请求
  const inFlightDictionaryFetches = new Map();

  async function fetchDictionaryInfo(word) {
    const lowerWord = String(word || '').toLowerCase();
    if (inFlightDictionaryFetches.has(lowerWord)) {
      return inFlightDictionaryFetches.get(lowerWord);
    }

    const run = fetchDictionaryInfoUnguarded(word);
    inFlightDictionaryFetches.set(lowerWord, run);
    try {
      return await run;
    } finally {
      inFlightDictionaryFetches.delete(lowerWord);
    }
  }

  async function fetchDictionaryInfoUnguarded(word) {
    const lowerWord = String(word || '').toLowerCase();

    // 0. 本地已有英英详情，或完整链路 miss：直接返回；旧 miss 无英英则放行重试
    let cached = wordDictionaryData.get(lowerWord);
    if (cached && isLookupMiss(cached) && !hasEnglishDefinitions(cached) &&
        cached.lookupFullChainTried !== true) {
      cached = {
        ...cached,
        lookupMiss: false,
        lookupMissReason: '',
        lookupMissAt: undefined,
        detailCached: false
      };
      wordDictionaryData.set(lowerWord, cached);
    }
    if (isLookupSettled(cached)) {
      try { wordSourceMap.set(lowerWord, cached.sourceAbbr || (isLookupMiss(cached) ? 'miss' : 'api')); } catch (e) {}
      return cached;
    }

    if (isSingleLookupWord(word)) {
      const shared = await readSharedLookup(lowerWord);
      if (shared && shared.dict && isLookupSettled(shared.dict)) {
        wordDictionaryData.set(lowerWord, shared.dict);
        if (shared.translation) {
          wordChineseTranslations.set(lowerWord, shared.translation);
          wordTranslations.set(lowerWord, shared.translation);
          if (shared.translationSource) setChineseSource(lowerWord, shared.translationSource);
        }
        try {
          wordSourceMap.set(lowerWord, shared.dict.sourceAbbr || (isLookupMiss(shared.dict) ? 'miss' : 'api'));
        } catch (e) {}
        return shared.dict;
      }
    }

    if (!AUTO_API_ENRICH) {
      if (cached) {
        try { wordSourceMap.set(lowerWord, cached.sourceAbbr || 'local'); } catch (e) {}
      }
      return cached || null;
    }

    // 详情：中文一主一备，英文一主一备（主成功即停）
    const routeCfg = await getApiRouteConfig();
    const slots = resolveDetailSlots(routeCfg);
    let partialMerged = cached ? { ...cached } : null;

    const tryOfflineDetail = async () => {
      try {
        const offlineData = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: 'queryOfflineDictData', word: word },
            (response) => {
              if (chrome.runtime.lastError) resolve(null);
              else if (response && response.success && response.data) resolve(response.data);
              else resolve(null);
            }
          );
        });
        if (!(offlineData && (offlineData.translation || offlineData.phonetic ||
            (offlineData.meanings && offlineData.meanings.length)))) {
          return null;
        }
        const zhMeanings = (offlineData.meanings && offlineData.meanings.length)
          ? offlineData.meanings
          : (offlineData.translation
            ? [{ partOfSpeech: '释义', definitions: [{ definition: offlineData.translation }] }]
            : []);
        const offlinePayload = {
          word: word,
          phonetics: offlineData.phonetic ? [{
            text: offlineData.phonetic,
            source: 'offline'
          }] : [],
          meanings: zhMeanings,
          zhMeanings,
          translation: offlineData.translation || '',
          translationSource: 'ecd',
          sourceAbbr: 'ecd'
        };
        if (!(offlinePayload.translation || hasRichMeanings(offlinePayload) ||
            (offlinePayload.phonetics && offlinePayload.phonetics.length))) {
          return null;
        }
        appendDeepseekLog({
          word,
          success: true,
          api: 'offline',
          source: 'content-ecd',
          detail: 'zh_slot_offline'
        });
        return offlinePayload;
      } catch (e) {
        return null;
      }
    };

    for (const id of [slots.zhPrimary, slots.zhBackup]) {
      if (!id) continue;
      let hit = null;
      if (id === 'offline') hit = await tryOfflineDetail();
      else if (id === 'youdao_dict') hit = await fetchYoudaoDictDetail(word);
      else if (id === 'd3325') hit = await fetch3325DictDetail(word);
      // 仅音标不算中文命中，避免挡住备源
      const zhOk = !!(hit && (
        String(hit.translation || '').trim() ||
        (hit.zhMeanings && hit.zhMeanings.length) ||
        extractZhMeanings(hit).length
      ));
      if (hit && (zhOk || (hit.phonetics && hit.phonetics.length))) {
        partialMerged = mergeDictData(partialMerged, hit);
        try { wordSourceMap.set(lowerWord, hit.sourceAbbr || id); } catch (e) {}
        await persistWordDictionaryData(word, {
          ...partialMerged,
          detailCached: hasEnglishDefinitions(partialMerged) ? true : false,
          lookupMiss: false
        });
        if (zhOk) break; // 中文主成功即停；仅音标则继续试备源
      }
    }

    // 英文一主一备：若主源是 Datamuse，先试；否则默认 Free Dictionary 为主
    const lowerQuery = String(word || '').toLowerCase();
    if (slots.enPrimary === 'datamuse') {
      try {
        const dmStarted = Date.now();
        const dmUrl = `https://api.datamuse.com/words?sp=${encodeURIComponent(lowerQuery || word)}&md=d&max=1`;
        const dmResp = await extensionFetch(dmUrl, { timeoutMs: 8000 });
        if (dmResp.ok) {
          const dmText = await dmResp.text();
          const dmJson = dmText && dmText.trim() ? JSON.parse(dmText) : null;
          const row = Array.isArray(dmJson) ? dmJson[0] : null;
          const rowWord = String((row && row.word) || '').toLowerCase();
          // 必须整词精确匹配，避免 conponent 吃到 component 的释义
          if (row && rowWord === lowerQuery && Array.isArray(row.defs) && row.defs.length) {
            const posMap = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'unknown' };
            const byPos = new Map();
            row.defs.forEach((raw) => {
              const text = String(raw || '');
              const tab = text.indexOf('\t');
              const posCode = (tab >= 0 ? text.slice(0, tab) : 'u').trim().toLowerCase();
              const definition = (tab >= 0 ? text.slice(tab + 1) : text).trim();
              if (!definition) return;
              const pos = posMap[posCode] || posCode || 'unknown';
              if (!byPos.has(pos)) byPos.set(pos, []);
              byPos.get(pos).push({ definition });
            });
            const meanings = Array.from(byPos.entries()).map(([partOfSpeech, definitions]) => ({
              partOfSpeech, definitions, synonyms: []
            }));
            if (meanings.length) {
              const existing = wordDictionaryData.get(lowerWord) || partialMerged;
              const marked = markDetailCached(mergeDictData(existing, {
                word, meanings, phonetics: [], translation: '', usage: '', sourceAbbr: 'datamuse'
              }), 'datamuse');
              await persistWordDictionaryData(word, marked);
              try { wordSourceMap.set(lowerWord, 'datamuse'); } catch (e) {}
              appendDeepseekLog({
                word, success: true, api: 'datamuse', source: 'content-datamuse',
                durationMs: Date.now() - dmStarted, detail: 'en_primary_hit'
              });
              return marked;
            }
          }
        }
      } catch (e) { /* 主源失败，继续备源 FD */ }
    }

    // Free Dictionary API（英文主或备）
    // 部分词小写会返回空包（如 comfort），自动用首字母大写重试
    const fdStartedAt = Date.now();
    let fdLastError = '';
    const titledQuery = lowerQuery ? (lowerQuery.charAt(0).toUpperCase() + lowerQuery.slice(1)) : '';
    const morphBases = [];
    const pushBase = (v) => {
      const s = String(v || '').toLowerCase();
      if (s && s !== lowerQuery && s.length >= 2) morphBases.push(s);
    };
    if (lowerQuery.length > 4 && lowerQuery.endsWith('ies')) pushBase(lowerQuery.slice(0, -3) + 'y');
    if (lowerQuery.length > 4 && /(ches|shes|sses|xes|zes)$/.test(lowerQuery)) pushBase(lowerQuery.slice(0, -2));
    else if (lowerQuery.length > 3 && lowerQuery.endsWith('es')) pushBase(lowerQuery.slice(0, -2));
    if (lowerQuery.length > 3 && lowerQuery.endsWith('s') && !lowerQuery.endsWith('ss')) pushBase(lowerQuery.slice(0, -1));
    if (lowerQuery.length > 5 && lowerQuery.endsWith('ing')) {
      pushBase(lowerQuery.slice(0, -3));
      pushBase(lowerQuery.slice(0, -3) + 'e');
    }
    if (lowerQuery.length > 4 && lowerQuery.endsWith('ed')) {
      pushBase(lowerQuery.slice(0, -2));
      pushBase(lowerQuery.slice(0, -1));
    }
    let lemmaQuery = '';
    try {
      lemmaQuery = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'queryLemma', word: lowerQuery }, (response) => {
          if (chrome.runtime.lastError) {
            resolve('');
            return;
          }
          resolve((response && response.lemma) || '');
        });
      });
    } catch (e) {
      lemmaQuery = '';
    }
    const fdVariants = [word, lowerQuery, titledQuery]
      .concat(morphBases)
      .concat(morphBases.map((b) => b.charAt(0).toUpperCase() + b.slice(1)))
      .concat(lemmaQuery ? [String(lemmaQuery).toLowerCase()] : [])
      .filter((v, i, arr) => v && arr.indexOf(v) === i);

    for (let vi = 0; vi < fdVariants.length; vi++) {
      const variant = fdVariants[vi];
      const maxRetries = 3;
      let gotResult = false;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(variant)}`;

          try {
            const response = await extensionFetch(url, { timeoutMs: 5000 });

            if (!response.ok) {
              fdLastError = `http_${response.status}`;
              if (response.status === 404) {
                break;
              }
              // 5xx 临时故障：退避后重试
              if (response.status >= 500 && attempt < maxRetries - 1) {
                await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
                continue;
              }
              throw new Error(`HTTP error! status: ${response.status}`);
            }

            const rawText = await response.text();
            if (!rawText || !rawText.trim()) {
              fdLastError = 'empty_body';
              throw new Error('empty_body');
            }
            let data = null;
            try {
              data = JSON.parse(rawText);
            } catch (parseErr) {
              fdLastError = 'invalid_json';
              throw new Error('invalid_json');
            }
            if (data && data[0]) {
              let wordData = data[0];

              if (!wordData.phonetics || wordData.phonetics.length === 0 ||
                  !wordData.phonetics.some(p => p && p.text && p.text.trim())) {
                const googlePhonetic = await fetchPhoneticFromGoogle(word);
                if (googlePhonetic) {
                  if (!wordData.phonetics) wordData.phonetics = [];
                  wordData.phonetics.push({
                    text: googlePhonetic,
                    source: 'google'
                  });
                }
              }

              const existing = wordDictionaryData.get(lowerWord) || partialMerged;
              const fdPayload = {
                word,
                phonetics: wordData.phonetics || [],
                meanings: wordData.meanings || [],
                translation: wordData.translation || '',
                usage: '',
                sourceAbbr: 'fd'
              };
              const merged = mergeDictData(existing, fdPayload);
              const marked = markDetailCached(merged, 'fd');
              await persistWordDictionaryData(word, marked);
              try { wordSourceMap.set(lowerWord, 'fd'); } catch (e) {}
              appendFreeDictionaryLog({
                word,
                success: true,
                source: 'content-fd',
                durationMs: Date.now() - fdStartedAt,
                detail: `meanings=${(wordData.meanings || []).length}` +
                  (variant !== word ? `; query=${variant}` : '')
              });
              return marked;
            }
            fdLastError = 'empty_result';
            gotResult = true;
            break;
          } catch (fetchError) {
            if (fetchError.name === 'AbortError') {
              throw new Error('Request timeout');
            }
            throw fetchError;
          }
        } catch (error) {
          const raw = (error && error.message) || 'request_failed';
          fdLastError = /Unexpected end of JSON input/i.test(raw) ? 'empty_body' : raw;
          console.error(`获取词典信息失败 (变体 ${variant}, 尝试 ${attempt + 1}/${maxRetries}):`, error);
          if (attempt < maxRetries - 1 && fdLastError !== 'empty_body' && fdLastError !== 'invalid_json') {
            await new Promise(resolve => setTimeout(resolve, 500));
          } else if (fdLastError === 'empty_body' || fdLastError === 'invalid_json' || fdLastError === 'empty_result') {
            break; // 换下一个大小写变体
          }
        }
      }
      if (gotResult) continue;
    }
    appendFreeDictionaryLog({
      word,
      success: false,
      error: fdLastError || 'not_found',
      source: 'content-fd',
      durationMs: Date.now() - fdStartedAt,
      detail: 'will_try_datamuse'
    });

    // Free Dictionary 无词条时，仅当备源为 Datamuse 才回退（主源已是 Datamuse 则不再重复）
    if (slots.enBackup === 'datamuse' && slots.enPrimary !== 'datamuse') try {
      const dmStarted = Date.now();
      const dmQueries = fdVariants.map((v) => String(v || '').toLowerCase())
        .filter((v, i, arr) => v && arr.indexOf(v) === i);
      let dmHit = null;
      let dmQueryUsed = '';
      for (let di = 0; di < dmQueries.length; di++) {
        const q = dmQueries[di];
        const dmUrl = `https://api.datamuse.com/words?sp=${encodeURIComponent(q)}&md=d&max=1`;
        const dmResp = await extensionFetch(dmUrl, { timeoutMs: 8000 });
        if (!dmResp.ok) continue;
        const dmText = await dmResp.text();
        const dmJson = dmText && dmText.trim() ? JSON.parse(dmText) : null;
        const row = Array.isArray(dmJson) ? dmJson[0] : null;
        const rowWord = String((row && row.word) || '').toLowerCase();
        if (!(row && rowWord === q && Array.isArray(row.defs) && row.defs.length)) continue;
        const posMap = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'unknown' };
        const byPos = new Map();
        row.defs.forEach((raw) => {
          const text = String(raw || '');
          const tab = text.indexOf('\t');
          const posCode = (tab >= 0 ? text.slice(0, tab) : 'u').trim().toLowerCase();
          const definition = (tab >= 0 ? text.slice(tab + 1) : text).trim();
          if (!definition) return;
          const pos = posMap[posCode] || posCode || 'unknown';
          if (!byPos.has(pos)) byPos.set(pos, []);
          byPos.get(pos).push({ definition });
        });
        const meanings = Array.from(byPos.entries()).map(([partOfSpeech, definitions]) => ({
          partOfSpeech,
          definitions,
          synonyms: []
        }));
        if (meanings.length) {
          dmHit = meanings;
          dmQueryUsed = q;
          break;
        }
      }
      if (dmHit) {
        const existing = wordDictionaryData.get(lowerWord) || partialMerged;
        const dmPayload = {
          word,
          meanings: dmHit,
          phonetics: [],
          translation: '',
          usage: '',
          sourceAbbr: 'datamuse'
        };
        const merged = mergeDictData(existing, dmPayload);
        const marked = markDetailCached(merged, 'datamuse');
        await persistWordDictionaryData(word, marked);
        try { wordSourceMap.set(lowerWord, 'datamuse'); } catch (e) {}
        appendDeepseekLog({
          word,
          success: true,
          api: 'datamuse',
          source: 'content-datamuse',
          durationMs: Date.now() - dmStarted,
          detail: `meanings=${dmHit.length}; fallback_after_fd` +
            (dmQueryUsed && dmQueryUsed !== lowerWord ? `; query=${dmQueryUsed}` : '')
        });
        return marked;
      }
      appendDeepseekLog({
        word,
        success: false,
        error: 'empty_result',
        api: 'datamuse',
        source: 'content-datamuse',
        durationMs: Date.now() - dmStarted
      });
    } catch (dmErr) {
      appendDeepseekLog({
        word,
        success: false,
        error: (dmErr && dmErr.message) || 'request_failed',
        api: 'datamuse',
        source: 'content-datamuse',
        durationMs: 0
      });
    }

    // 3. 若前面未合并到离线中文，再补一次；有中文则保留，不因缺英英而抹掉
    if (!(partialMerged && partialMerged.translation)) {
      try {
        const offlineData = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: 'queryOfflineDictData', word: word },
            (response) => {
              if (chrome.runtime.lastError) resolve(null);
              else if (response && response.success && response.data) resolve(response.data);
              else resolve(null);
            }
          );
        });
        if (offlineData && offlineData.translation) {
          partialMerged = mergeDictData(partialMerged, {
            word,
            phonetics: offlineData.phonetic ? [{ text: offlineData.phonetic, source: 'offline' }] : [],
            meanings: [],
            translation: offlineData.translation,
            sourceAbbr: 'ecd'
          });
        }
      } catch (error) {
        console.warn('查询离线词典数据失败:', error);
      }
    }

    const transientFail = /^http_5\d\d$/.test(String(fdLastError || '')) ||
      /timeout|abort|Failed to fetch|NetworkError|empty_body/i.test(String(fdLastError || ''));
    if (transientFail) {
      // 不写 miss，避免 dawn 类 502 后永久跳过 Free Dictionary
      if (partialMerged) {
        await persistWordDictionaryData(word, {
          ...partialMerged,
          detailCached: false,
          lookupMiss: false
        });
        return partialMerged;
      }
      return cached || null;
    }

    const base = partialMerged || cached || null;
    if (base && (base.translation || hasRichMeanings(base))) {
      // 有中文/释义但无英英：保存部分结果；标 miss 以便不再狂刷，但可手动/主面板重试
      const missed = markLookupMiss(base, word, fdLastError || 'online_not_found');
      await persistWordDictionaryData(word, missed);
      try { wordSourceMap.set(lowerWord, base.sourceAbbr || 'ecd'); } catch (e) {}
      return missed;
    }

    const missed = markLookupMiss(base, word, fdLastError || 'online_not_found');
    await persistWordDictionaryData(word, missed);
    try { wordSourceMap.set(lowerWord, 'miss'); } catch (e) {}
    return missed;
  }

  // 从 Google Translate API 获取音标（作为备用）
  async function fetchPhoneticFromGoogle(word) {
    try {
      // Google Translate API 使用 dt=rm 参数可以获取音标
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=en&dt=rm&q=${encodeURIComponent(word)}`;

      try {
        const response = await extensionFetch(url, { timeoutMs: 2000 });
        
        if (!response.ok) {
          return null;
        }
        
        const data = await response.json();
        // Google API 返回格式: [[["word", "word", null, null, 5], [null, null, null, "音标"]]]
        // 音标在 data[0][1][3] 位置
        if (data && data[0] && Array.isArray(data[0]) && data[0][1] && data[0][1][3]) {
          const phonetic = data[0][1][3];
          if (phonetic && typeof phonetic === 'string' && phonetic.trim()) {
            return phonetic.trim();
          }
        }
        return null;
      } catch (fetchError) {
        return null;
      }
    } catch (error) {
      // 静默失败，不影响主流程
      return null;
    }
  }

  // 格式化词典定义（英英）
  function formatEnglishDefinition(wordData) {
    if (!wordData || !wordData.meanings) return '';
    
    let result = [];
    wordData.meanings.forEach((meaning, index) => {
      if (index < 3) { // 最多显示3个词性
        const partOfSpeech = meaning.partOfSpeech;
        const definitions = meaning.definitions.slice(0, 2); // 每个词性最多2个定义
        
        definitions.forEach((def, defIndex) => {
          let line = '';
          if (defIndex === 0) {
            line = `[${partOfSpeech}] ${def.definition}`;
          } else {
            line = `  ${def.definition}`;
          }
          result.push(line);
        });
      }
    });
    
    return result.join('\n') || '';
  }

  // 格式化完整词典信息：始终以中文释义为主；海外可附 Free Dictionary 词性/英文定义
  async function formatFullDictionaryInfo(wordData, _legacyDictType, chineseTranslation) {
    let html = '';
    const zh =
      (chineseTranslation && String(chineseTranslation).trim()) ||
      (wordData && wordData.translation && String(wordData.translation).trim()) ||
      '';

    if (zh) {
      html += `<div class="vocab-popup-simple-translation">${zh}</div>`;
    }

    if (!wordData) {
      return html || '<div class="vocab-popup-simple-translation">暂无详细信息</div>';
    }
    
    if (wordData.phonetics && wordData.phonetics.length > 0) {
      const phonetic = wordData.phonetics.find(p => p.text) || wordData.phonetics[0];
      if (phonetic && phonetic.text) {
        html += `<div class="dict-phonetic-display">/${phonetic.text}/</div>`;
      }
    }
    
    if (wordData.meanings && wordData.meanings.length > 0) {
      const meaningCount = Math.min(wordData.meanings.length, 4);
      for (let index = 0; index < meaningCount; index++) {
        const meaning = wordData.meanings[index];
        html += `<div class="dict-meaning-item">`;
        html += `<div class="dict-pos">${meaning.partOfSpeech || ''}</div>`;

        const defs = (meaning.definitions || []).slice(0, 3);
        for (let defIndex = 0; defIndex < defs.length; defIndex++) {
          const def = defs[defIndex];
          html += `<div class="dict-def-item">`;
          html += `<div class="dict-def-number">${defIndex + 1}.</div>`;
          html += `<div class="dict-def-content">`;

          let defText = def.definition || '';
          if (defText && !zh) {
            const defTranslation = await translateWordToChinese(defText);
            if (defTranslation && !isFailedTranslationText(defTranslation)) {
              defText = defTranslation;
            }
          }
          html += `<div class="dict-def-text">${defText}</div>`;

          if (def.example) {
            html += `<div class="dict-example-display">"${formatExampleHtml(def.example, wordData.word)}"</div>`;
          }

          html += `</div></div>`;
        }

        html += `</div>`;
      }
    }
    
    return html || '<div class="vocab-popup-simple-translation">暂无详细信息</div>';
  }

  const floatingDetailHistory = [];
  let floatingDetailCurrent = null;
  let floatingDetailExploreBusy = false;

  function clearFloatingDetailHistory() {
    floatingDetailHistory.length = 0;
    floatingDetailCurrent = null;
  }

  function closeFloatingDetailPopup() {
    if (currentPopup && currentPopup.parentNode) currentPopup.remove();
    currentPopup = null;
    clearFloatingDetailHistory();
  }

  // 绑定弹窗事件
  function bindPopupEvents(popup, word, translation, isSaved, status) {
    // 关闭按钮
    const closeBtn = popup.querySelector('.vocab-popup-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        closeFloatingDetailPopup();
      });
    }

    const backBtn = popup.querySelector('.vocab-popup-back');
    if (backBtn) {
      backBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!floatingDetailHistory.length) return;
        const prev = floatingDetailHistory.pop();
        if (!prev || !prev.word) return;
        const lower = String(prev.word).toLowerCase();
        const prevStatus = wordStatus.get(lower) || prev.status || 'new';
        const prevSaved = savedWords.has(lower);
        const prevDict = wordDictionaryData.get(lower) || prev.dictData || null;
        const prevZh = wordChineseTranslations.get(lower) || prev.chineseTranslation || prev.translation || '';
        const nextPopup = await createTranslationPopup(
          prev.word,
          prev.translation || prevZh,
          prevSaved,
          prevStatus,
          prevDict,
          prevZh,
          { skipHistory: true }
        );
        if (currentPopup && currentPopup.getBoundingClientRect) {
          const rect = popup.getBoundingClientRect();
          nextPopup.style.left = `${Math.max(10, rect.left)}px`;
          nextPopup.style.top = `${Math.max(10, rect.top)}px`;
        }
      });
    }

    // 发音按钮（英音和美音）
    const pronounceBtns = popup.querySelectorAll('.vocab-popup-pronounce');
    pronounceBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wordToSpeak = e.target.getAttribute('data-word');
        const type = parseInt(e.target.getAttribute('data-type')) || 1; // 1=英音, 2=美音
        speakWord(wordToSpeak, type);
      });
    });

    // 移除收藏按钮
    const removeBtn = popup.querySelector('.vocab-btn-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', async (e) => {
        const btnWord = e.target.getAttribute('data-word');
        await removeWord(btnWord);
        closeFloatingDetailPopup();
      });
    }

    // 已记住按钮
    const masterBtn = popup.querySelector('.vocab-btn-master');
    if (masterBtn) {
      masterBtn.addEventListener('click', async (e) => {
        const btnWord = e.target.getAttribute('data-word');
        await markWordAsMastered(btnWord);
        updatePopupAfterSave(popup, btnWord, translation, true, 'mastered');
      });
    }

    // 详情内双击生词：加入生词本并切换到该词详情
    popup.addEventListener('dblclick', async (ev) => {
      ev.stopPropagation();
      if (floatingDetailExploreBusy) return;
      if (ev.target.closest('.vocab-popup-close, .vocab-popup-back, .vocab-popup-pronounce, button, a, input, textarea')) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      floatingDetailExploreBusy = true;
      try {
        const result = await handleWordSelectionAndSave(ev);
        if (!result || !result.word) return;
        const next = String(result.word || '').trim();
        if (!next) return;
        if (next.toLowerCase() === String(word || '').toLowerCase()) return;
        const lower = next.toLowerCase();
        const nextStatus = wordStatus.get(lower) || 'new';
        const nextDict = wordDictionaryData.get(lower) || null;
        const nextZh = result.translation || wordChineseTranslations.get(lower) || '';
        const rect = popup.getBoundingClientRect();
        const nextPopup = await createTranslationPopup(
          next,
          nextZh,
          true,
          nextStatus,
          nextDict,
          nextZh
        );
        nextPopup.style.left = `${Math.max(10, rect.left)}px`;
        nextPopup.style.top = `${Math.max(10, rect.top)}px`;
      } finally {
        floatingDetailExploreBusy = false;
      }
    });

    // 点击外部关闭
    setTimeout(() => {
      document.addEventListener('click', function closePopup(e) {
        if (!popup.contains(e.target) && e.target !== popup) {
          if (currentPopup === popup) closeFloatingDetailPopup();
          else if (popup.parentNode) popup.remove();
          document.removeEventListener('click', closePopup);
        }
      });
    }, 100);
  }

  // 使用Google翻译API（client=gtx）。长句时拼接所有分段，避免只返回首句。
  async function translateWordToChineseGoogle(word, options = {}) {
    const timeoutMs = options.timeoutMs || 3000;
    const sourceLang = options.sourceLang || 'en';
    const targetLang = options.targetLang || 'zh-CN';
    const text = String(word || '').trim();
    if (!text) throw new Error('empty_text');

    try {
      const url =
        `https://translate.googleapis.com/translate_a/single?client=gtx` +
        `&sl=${encodeURIComponent(sourceLang)}&tl=${encodeURIComponent(targetLang)}` +
        `&dt=t&q=${encodeURIComponent(text)}`;

      try {
        const response = await extensionFetch(url, { timeoutMs });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (data && Array.isArray(data[0])) {
          const joined = data[0]
            .map((seg) => (seg && seg[0] ? String(seg[0]) : ''))
            .join('');
          if (joined.trim()) return joined;
        }
        throw new Error('Invalid response format');
      } catch (fetchError) {
        if (fetchError.name === 'AbortError') {
          throw new Error('Request timeout');
        }
        throw fetchError;
      }
    } catch (error) {
      console.error('Google翻译错误:', error);
      throw error;
    }
  }

  // 使用Bing翻译API翻译单词（中文）- 方法2（备选）
  async function translateWordToChineseBing(word) {
    try {
      // 使用Bing翻译的免费API
      const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans`;
      
      // 注意：Bing API需要密钥，这里使用备用方法
      // 使用Bing网页版翻译
      const bingUrl = `https://www.bing.com/translator?text=${encodeURIComponent(word)}&from=en&to=zh-Hans`;
      
      // 或者使用另一个免费的Bing翻译端点
      const response = await fetch(`https://api.microsofttranslator.com/v2/http.svc/Translate?text=${encodeURIComponent(word)}&from=en&to=zh-Hans`, {
        method: 'GET',
        mode: 'cors'
      });
      
      if (response.ok) {
        const text = await response.text();
        // 解析XML响应
        const match = text.match(/<string[^>]*>([^<]+)<\/string>/);
        if (match && match[1]) {
          return match[1];
        }
      }
      throw new Error('Bing translation failed');
    } catch (error) {
      console.error('Bing翻译错误:', error);
      throw error;
    }
  }

  // 使用MyMemory翻译API（免费备选方案，带超时）
  async function translateWordToChineseMyMemory(word) {
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|zh`;

      try {
        const response = await extensionFetch(url, { timeoutMs: 3000 });
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data && data.responseData && data.responseData.translatedText) {
          return data.responseData.translatedText;
        }
        throw new Error('Invalid response format');
      } catch (fetchError) {
        if (fetchError.name === 'AbortError') {
          throw new Error('Request timeout');
        }
        throw fetchError;
      }
    } catch (error) {
      console.error('MyMemory翻译错误:', error);
      throw error;
    }
  }

  // 离线词典查询（使用本地词典数据）
  let offlineDictionary = null;
  let offlineDictLoaded = false;

  // 加载离线词典
  async function loadOfflineDictionary() {
    if (offlineDictLoaded) return offlineDictionary;
    
    return new Promise((resolve) => {
      chrome.storage.local.get(['offlineDictionary'], (result) => {
        if (result.offlineDictionary) {
          offlineDictionary = result.offlineDictionary;
          offlineDictLoaded = true;
          resolve(offlineDictionary);
        } else {
          // 如果没有用户自定义词典，使用内置的精简词典
          offlineDictionary = getBuiltinDictionary();
          offlineDictLoaded = true;
          resolve(offlineDictionary);
        }
      });
    });
  }

  // 内置精简词典（常用词，作为保底）
  function getBuiltinDictionary() {
    return {
      "hello": "你好；问候",
      "world": "世界",
      "peace": "和平；安宁",
      "love": "爱；喜欢",
      "time": "时间；次数",
      "word": "单词；词",
      "translate": "翻译；转换",
      "dictionary": "词典；字典",
      "learn": "学习；了解",
      "study": "学习；研究",
      "read": "阅读；读",
      "write": "写；写作",
      "speak": "说；讲",
      "listen": "听；倾听",
      "understand": "理解；明白",
      "remember": "记住；回忆",
      "forget": "忘记",
      "practice": "练习；实践",
      "improve": "改进；提高",
      "language": "语言",
      "english": "英语；英文",
      "chinese": "中文；汉语",
      "student": "学生",
      "teacher": "教师；老师",
      "book": "书；书籍",
      "page": "页；页面",
      "computer": "电脑；计算机",
      "internet": "互联网；网络",
      "website": "网站",
      "browser": "浏览器",
      "extension": "扩展；延伸",
      "help": "帮助；协助",
      "thank": "感谢；谢谢",
      "please": "请",
      "sorry": "抱歉；对不起",
      "yes": "是；是的",
      "no": "不；不是",
      "good": "好的；良好的",
      "bad": "坏的；不好的",
      "big": "大的",
      "small": "小的",
      "new": "新的",
      "old": "旧的；老的",
      "easy": "容易的；简单的",
      "hard": "困难的；硬的",
      "fast": "快的；迅速的",
      "slow": "慢的",
      "hot": "热的",
      "cold": "冷的",
      "happy": "快乐的；高兴的",
      "sad": "悲伤的",
      "beautiful": "美丽的",
      "ugly": "丑陋的",
      "important": "重要的",
      "interesting": "有趣的",
      "difficult": "困难的",
      "different": "不同的",
      "same": "相同的",
      "first": "第一；首先",
      "last": "最后；最后的",
      "next": "下一个；接下来",
      "previous": "以前的；上一个",
      "today": "今天",
      "tomorrow": "明天",
      "yesterday": "昨天",
      "morning": "早晨；上午",
      "afternoon": "下午",
      "evening": "晚上；傍晚",
      "night": "夜晚",
      "week": "周；星期",
      "month": "月；月份",
      "year": "年；年份",
      "day": "天；日",
      "hour": "小时",
      "minute": "分钟",
      "second": "秒；第二",
      "people": "人们；人",
      "person": "人；个人",
      "man": "男人",
      "woman": "女人",
      "child": "孩子；儿童",
      "family": "家庭；家人",
      "friend": "朋友",
      "home": "家；家庭",
      "house": "房子；房屋",
      "room": "房间",
      "door": "门",
      "window": "窗户",
      "table": "桌子",
      "chair": "椅子",
      "bed": "床",
      "food": "食物",
      "water": "水",
      "drink": "喝；饮料",
      "eat": "吃",
      "sleep": "睡觉",
      "wake": "醒来；唤醒",
      "work": "工作",
      "job": "工作；职业",
      "money": "钱；金钱",
      "buy": "买；购买",
      "sell": "卖；出售",
      "price": "价格",
      "free": "免费的；自由的",
      "cost": "花费；成本",
      "pay": "支付；付款",
      "school": "学校",
      "university": "大学",
      "class": "班级；课",
      "lesson": "课；课程",
      "test": "测试；考试",
      "exam": "考试",
      "question": "问题",
      "answer": "答案；回答",
      "right": "正确的；右边",
      "wrong": "错误的；错的",
      "true": "真的；真实的",
      "false": "假的；错误的",
      "know": "知道；了解",
      "think": "想；思考",
      "see": "看；看见",
      "look": "看；看起来",
      "watch": "观看；手表",
      "hear": "听到",
      "feel": "感觉；感到",
      "touch": "触摸；接触",
      "smell": "闻；气味",
      "taste": "尝；味道",
      "walk": "走；步行",
      "run": "跑；运行",
      "jump": "跳",
      "sit": "坐",
      "stand": "站；站立",
      "go": "去；走",
      "come": "来",
      "leave": "离开；留下",
      "arrive": "到达",
      "start": "开始",
      "begin": "开始",
      "end": "结束；末尾",
      "finish": "完成；结束",
      "stop": "停止",
      "continue": "继续",
      "wait": "等待",
      "stay": "停留；待",
      "move": "移动；搬",
      "turn": "转；转弯",
      "open": "打开",
      "close": "关闭",
      "break": "打破；休息",
      "fix": "修理；固定",
      "make": "做；制造",
      "do": "做",
      "get": "得到；获得",
      "give": "给",
      "take": "拿；取",
      "put": "放；放置",
      "bring": "带来",
      "send": "发送；送",
      "receive": "接收；收到",
      "find": "找到；发现",
      "lose": "失去；丢失",
      "search": "搜索；寻找",
      "look for": "寻找",
      "need": "需要",
      "want": "想要",
      "like": "喜欢",
      "dislike": "不喜欢",
      "hate": "讨厌；恨",
      "enjoy": "享受；喜欢",
      "prefer": "更喜欢；宁愿",
      "choose": "选择",
      "decide": "决定",
      "plan": "计划",
      "try": "尝试",
      "hope": "希望",
      "wish": "希望；祝愿",
      "expect": "期望；预期",
      "believe": "相信",
      "trust": "信任",
      "doubt": "怀疑",
      "worry": "担心",
      "fear": "害怕；恐惧",
      "afraid": "害怕的",
      "scared": "害怕的",
      "brave": "勇敢的",
      "strong": "强壮的；强大的",
      "weak": "弱的",
      "healthy": "健康的",
      "sick": "生病的",
      "ill": "生病的",
      "well": "好的；健康的",
      "fine": "好的；精美的",
      "nice": "好的；漂亮的",
      "kind": "善良的；种类",
      "mean": "意思是；刻薄的",
      "polite": "有礼貌的",
      "rude": "粗鲁的",
      "honest": "诚实的",
      "lie": "说谎；谎言",
      "truth": "真相；真理",
      "secret": "秘密",
      "public": "公共的；公开的",
      "private": "私人的；私有的",
      "personal": "个人的",
      "special": "特殊的；特别的",
      "normal": "正常的",
      "usual": "通常的",
      "unusual": "不寻常的",
      "common": "常见的；共同的",
      "rare": "稀有的",
      "strange": "奇怪的",
      "weird": "奇怪的",
      "funny": "有趣的；好笑的",
      "serious": "严肃的；严重的",
      "calm": "平静的",
      "quiet": "安静的",
      "loud": "大声的",
      "noisy": "嘈杂的",
      "silent": "沉默的",
      "empty": "空的",
      "full": "满的；完整的",
      "complete": "完整的；完成",
      "whole": "整个的；全部的",
      "part": "部分",
      "piece": "片；块",
      "bit": "一点；少量",
      "little": "小的；少的",
      "few": "很少的；几个",
      "many": "许多",
      "much": "很多",
      "more": "更多的",
      "most": "最多的；大多数",
      "less": "更少的",
      "least": "最少的",
      "some": "一些",
      "any": "任何",
      "all": "所有的",
      "every": "每个",
      "each": "每个",
      "both": "两者都",
      "either": "要么；也",
      "neither": "两者都不",
      "other": "其他的",
      "another": "另一个",
      "else": "其他的",
      "only": "只有；仅仅",
      "just": "只是；刚刚",
      "even": "甚至；偶数",
      "still": "仍然；还",
      "yet": "还；然而",
      "already": "已经",
      "soon": "很快；不久",
      "now": "现在",
      "then": "然后；那时",
      "before": "在...之前",
      "after": "在...之后",
      "during": "在...期间",
      "while": "当...时；然而",
      "when": "当...时",
      "where": "在哪里",
      "why": "为什么",
      "what": "什么",
      "which": "哪一个",
      "who": "谁",
      "whom": "谁（宾格）",
      "whose": "谁的",
      "how": "如何；怎样",
      "how much": "多少（不可数）",
      "how many": "多少（可数）",
      "how long": "多久；多长",
      "how often": "多久一次",
      "how far": "多远",
      "how old": "多大年纪",
      "can": "能；可以",
      "could": "能；可以（过去式）",
      "may": "可能；可以",
      "might": "可能",
      "must": "必须",
      "should": "应该",
      "will": "将；会",
      "would": "将；会（过去式）",
      "shall": "将；应该",
      "ought to": "应该",
      "have to": "必须",
      "need to": "需要",
      "want to": "想要",
      "like to": "喜欢",
      "love to": "喜欢",
      "hate to": "讨厌",
      "prefer to": "更喜欢",
      "decide to": "决定",
      "plan to": "计划",
      "try to": "尝试",
      "hope to": "希望",
      "wish to": "希望",
      "expect to": "期望",
      "promise to": "承诺",
      "agree to": "同意",
      "refuse to": "拒绝",
      "fail to": "失败",
      "manage to": "设法",
      "seem to": "似乎",
      "appear to": "显得",
      "happen to": "碰巧",
      "tend to": "倾向于",
      "used to": "过去常常",
      "be used to": "习惯于",
      "get used to": "习惯于",
      "look forward to": "期待",
      "object to": "反对",
      "stick to": "坚持",
      "belong to": "属于",
      "listen to": "听",
      "talk to": "和...说话",
      "speak to": "和...说话",
      "write to": "写给",
      "send to": "发送给",
      "give to": "给",
      "show to": "展示给",
      "explain to": "解释给",
      "introduce to": "介绍给",
      "invite to": "邀请",
      "welcome to": "欢迎",
      "thanks to": "多亏",
      "due to": "由于",
      "according to": "根据",
      "next to": "旁边",
      "close to": "靠近",
      "near to": "接近",
      "far from": "远离",
      "away from": "离开",
      "out of": "从...出来",
      "into": "进入",
      "onto": "到...上面",
      "over": "在...上方；超过",
      "under": "在...下方",
      "above": "在...上方",
      "below": "在...下方",
      "up": "向上",
      "down": "向下",
      "on": "在...上面",
      "in": "在...里面",
      "at": "在",
      "by": "通过；在旁边",
      "with": "和；用",
      "without": "没有",
      "for": "为了；对于",
      "from": "从",
      "of": "的",
      "to": "到；向",
      "about": "关于",
      "around": "围绕；大约",
      "through": "通过",
      "across": "穿过",
      "along": "沿着",
      "beside": "在旁边",
      "between": "在...之间",
      "among": "在...之中",
      "inside": "在...里面",
      "outside": "在...外面",
      "behind": "在...后面",
      "in front of": "在...前面",
      "beside": "在旁边",
      "next to": "旁边",
      "near": "靠近",
      "far": "远的",
      "here": "这里",
      "there": "那里",
      "where": "哪里",
      "everywhere": "到处",
      "somewhere": "某处",
      "anywhere": "任何地方",
      "nowhere": "无处",
      "this": "这个",
      "that": "那个",
      "these": "这些",
      "those": "那些",
      "I": "我",
      "you": "你；你们",
      "he": "他",
      "she": "她",
      "it": "它",
      "we": "我们",
      "they": "他们",
      "me": "我（宾格）",
      "him": "他（宾格）",
      "her": "她（宾格）",
      "us": "我们（宾格）",
      "them": "他们（宾格）",
      "my": "我的",
      "your": "你的；你们的",
      "his": "他的",
      "her": "她的",
      "its": "它的",
      "our": "我们的",
      "their": "他们的",
      "mine": "我的（名词性）",
      "yours": "你的（名词性）",
      "his": "他的（名词性）",
      "hers": "她的（名词性）",
      "ours": "我们的（名词性）",
      "theirs": "他们的（名词性）",
      "myself": "我自己",
      "yourself": "你自己",
      "himself": "他自己",
      "herself": "她自己",
      "itself": "它自己",
      "ourselves": "我们自己",
      "yourselves": "你们自己",
      "themselves": "他们自己",
      "one": "一；一个",
      "two": "二",
      "three": "三",
      "four": "四",
      "five": "五",
      "six": "六",
      "seven": "七",
      "eight": "八",
      "nine": "九",
      "ten": "十",
      "eleven": "十一",
      "twelve": "十二",
      "thirteen": "十三",
      "fourteen": "十四",
      "fifteen": "十五",
      "sixteen": "十六",
      "seventeen": "十七",
      "eighteen": "十八",
      "nineteen": "十九",
      "twenty": "二十",
      "thirty": "三十",
      "forty": "四十",
      "fifty": "五十",
      "sixty": "六十",
      "seventy": "七十",
      "eighty": "八十",
      "ninety": "九十",
      "hundred": "百",
      "thousand": "千",
      "million": "百万",
      "billion": "十亿",
      "zero": "零",
      "number": "数字；号码",
      "count": "数；计算",
      "add": "加；添加",
      "subtract": "减",
      "multiply": "乘",
      "divide": "除",
      "equal": "等于",
      "plus": "加",
      "minus": "减",
      "times": "乘",
      "percent": "百分比",
      "half": "一半",
      "quarter": "四分之一",
      "third": "三分之一",
      "double": "双倍",
      "single": "单个的",
      "pair": "一对",
      "couple": "一对；几个",
      "dozen": "一打",
      "score": "分数；得分",
      "point": "点；分数",
      "line": "线；行",
      "row": "排；行",
      "column": "列",
      "circle": "圆；圈",
      "square": "正方形；广场",
      "triangle": "三角形",
      "rectangle": "长方形",
      "round": "圆的",
      "flat": "平的",
      "straight": "直的",
      "curved": "弯曲的",
      "long": "长的",
      "short": "短的",
      "tall": "高的",
      "high": "高的",
      "low": "低的",
      "wide": "宽的",
      "narrow": "窄的",
      "thick": "厚的",
      "thin": "薄的；瘦的",
      "deep": "深的",
      "shallow": "浅的",
      "heavy": "重的",
      "light": "轻的；光",
      "dark": "黑暗的",
      "bright": "明亮的",
      "color": "颜色",
      "red": "红色",
      "blue": "蓝色",
      "green": "绿色",
      "yellow": "黄色",
      "orange": "橙色",
      "purple": "紫色",
      "pink": "粉色",
      "brown": "棕色",
      "black": "黑色",
      "white": "白色",
      "gray": "灰色",
      "grey": "灰色",
      "beautiful": "美丽的",
      "pretty": "漂亮的",
      "handsome": "英俊的",
      "ugly": "丑陋的",
      "clean": "干净的",
      "dirty": "脏的",
      "neat": "整洁的",
      "messy": "凌乱的",
      "tidy": "整洁的",
      "organized": "有组织的",
      "disorganized": "无组织的",
      "order": "顺序；命令",
      "disorder": "混乱",
      "arrange": "安排",
      "organize": "组织",
      "prepare": "准备",
      "ready": "准备好的",
      "unready": "未准备好的",
      "ready": "准备好的",
      "prepare": "准备",
      "preparation": "准备",
      "plan": "计划",
      "planner": "计划者",
      "planning": "计划",
      "schedule": "时间表",
      "timetable": "时间表",
      "appointment": "约会；预约",
      "meeting": "会议",
      "conference": "会议",
      "discussion": "讨论",
      "talk": "谈话",
      "conversation": "对话",
      "chat": "聊天",
      "dialogue": "对话",
      "speech": "演讲",
      "lecture": "讲座",
      "presentation": "演示",
      "show": "显示；表演",
      "display": "显示",
      "exhibition": "展览",
      "museum": "博物馆",
      "gallery": "画廊",
      "art": "艺术",
      "artist": "艺术家",
      "painting": "绘画",
      "picture": "图片",
      "photo": "照片",
      "photograph": "照片",
      "camera": "相机",
      "film": "电影；胶片",
      "movie": "电影",
      "cinema": "电影院",
      "theater": "剧院",
      "play": "玩；戏剧",
      "game": "游戏",
      "sport": "运动",
      "exercise": "锻炼",
      "practice": "练习",
      "training": "训练",
      "coach": "教练",
      "player": "玩家；运动员",
      "team": "团队",
      "group": "组；群",
      "member": "成员",
      "leader": "领导",
      "boss": "老板",
      "manager": "经理",
      "director": "主任；导演",
      "president": "总统；校长",
      "king": "国王",
      "queen": "女王",
      "prince": "王子",
      "princess": "公主",
      "lord": "领主",
      "lady": "女士",
      "sir": "先生",
      "madam": "夫人",
      "miss": "小姐",
      "mister": "先生",
      "mrs": "夫人",
      "mr": "先生",
      "ms": "女士",
      "dr": "医生；博士",
      "professor": "教授",
      "teacher": "教师",
      "student": "学生",
      "pupil": "小学生",
      "classmate": "同学",
      "roommate": "室友",
      "friend": "朋友",
      "best friend": "最好的朋友",
      "close friend": "亲密的朋友",
      "good friend": "好朋友",
      "old friend": "老朋友",
      "new friend": "新朋友",
      "boyfriend": "男朋友",
      "girlfriend": "女朋友",
      "husband": "丈夫",
      "wife": "妻子",
      "son": "儿子",
      "daughter": "女儿",
      "brother": "兄弟",
      "sister": "姐妹",
      "father": "父亲",
      "dad": "爸爸",
      "daddy": "爸爸",
      "mother": "母亲",
      "mom": "妈妈",
      "mum": "妈妈",
      "mummy": "妈妈",
      "parent": "父母",
      "grandfather": "祖父",
      "grandpa": "爷爷",
      "grandmother": "祖母",
      "grandma": "奶奶",
      "grandparent": "祖父母",
      "uncle": "叔叔",
      "aunt": "阿姨",
      "cousin": "表兄弟；表姐妹",
      "nephew": "侄子",
      "niece": "侄女",
      "relative": "亲戚",
      "family": "家庭",
      "home": "家",
      "house": "房子",
      "apartment": "公寓",
      "flat": "公寓",
      "room": "房间",
      "bedroom": "卧室",
      "bathroom": "浴室",
      "kitchen": "厨房",
      "dining room": "餐厅",
      "living room": "客厅",
      "study": "书房",
      "office": "办公室",
      "garage": "车库",
      "garden": "花园",
      "yard": "院子",
      "balcony": "阳台",
      "roof": "屋顶",
      "floor": "地板；楼层",
      "wall": "墙",
      "ceiling": "天花板",
      "door": "门",
      "window": "窗户",
      "key": "钥匙；关键",
      "lock": "锁",
      "handle": "把手",
      "knob": "旋钮",
      "hinge": "铰链",
      "frame": "框架",
      "glass": "玻璃",
      "wood": "木头",
      "metal": "金属",
      "plastic": "塑料",
      "paper": "纸",
      "cloth": "布",
      "fabric": "织物",
      "leather": "皮革",
      "rubber": "橡胶",
      "stone": "石头",
      "rock": "岩石",
      "sand": "沙子",
      "soil": "土壤",
      "earth": "地球；土地",
      "ground": "地面",
      "land": "土地",
      "field": "田野；领域",
      "farm": "农场",
      "forest": "森林",
      "tree": "树",
      "plant": "植物",
      "flower": "花",
      "grass": "草",
      "leaf": "叶子",
      "branch": "树枝",
      "root": "根",
      "stem": "茎",
      "trunk": "树干",
      "bark": "树皮",
      "fruit": "水果",
      "vegetable": "蔬菜",
      "apple": "苹果",
      "banana": "香蕉",
      "orange": "橙子",
      "grape": "葡萄",
      "strawberry": "草莓",
      "watermelon": "西瓜",
      "peach": "桃子",
      "pear": "梨",
      "cherry": "樱桃",
      "lemon": "柠檬",
      "lime": "酸橙",
      "coconut": "椰子",
      "pineapple": "菠萝",
      "mango": "芒果",
      "papaya": "木瓜",
      "avocado": "鳄梨",
      "kiwi": "猕猴桃",
      "blueberry": "蓝莓",
      "raspberry": "覆盆子",
      "blackberry": "黑莓",
      "cranberry": "蔓越莓",
      "date": "日期；枣",
      "fig": "无花果",
      "plum": "李子",
      "apricot": "杏",
      "nectarine": "油桃",
      "pomegranate": "石榴",
      "dragon fruit": "火龙果",
      "star fruit": "杨桃",
      "passion fruit": "百香果",
      "durian": "榴莲",
      "jackfruit": "菠萝蜜",
      "lychee": "荔枝",
      "longan": "龙眼",
      "rambutan": "红毛丹",
      "mangosteen": "山竹",
      "guava": "番石榴",
      "persimmon": "柿子",
      "kumquat": "金橘",
      "tangerine": "橘子",
      "clementine": "小柑橘",
      "satsuma": "温州蜜柑",
      "blood orange": "血橙",
      "grapefruit": "葡萄柚",
      "pomelo": "柚子",
      "yuzu": "柚子",
      "quince": "榅桲",
      "elderberry": "接骨木",
      "gooseberry": "醋栗",
      "currant": "醋栗",
      "mulberry": "桑葚",
      "boysenberry": "波森莓",
      "loganberry": "罗甘莓",
      "tayberry": "泰莓",
      "huckleberry": "越橘",
      "cloudberry": "云莓",
      "lingonberry": "越橘",
      "bilberry": "越橘",
      "barberry": "小檗",
      "serviceberry": "唐棣",
      "juneberry": "六月莓",
      "saskatoon": "萨斯卡通莓",
      "chokeberry": "苦莓",
      "rowanberry": "花楸果",
      "hawthorn": "山楂",
      "rose hip": "玫瑰果",
      "sea buckthorn": "沙棘",
      "elderflower": "接骨木花",
      "dandelion": "蒲公英",
      "nettle": "荨麻",
      "plantain": "车前草",
      "clover": "三叶草",
      "alfalfa": "苜蓿",
      "chickweed": "繁缕",
      "purslane": "马齿苋",
      "lambsquarters": "藜",
      "amaranth": "苋菜",
      "spinach": "菠菜",
      "kale": "羽衣甘蓝",
      "collard greens": "羽衣甘蓝",
      "mustard greens": "芥菜",
      "turnip greens": "芜菁叶",
      "beet greens": "甜菜叶",
      "chard": "甜菜",
      "bok choy": "小白菜",
      "napa cabbage": "大白菜",
      "cabbage": "卷心菜",
      "red cabbage": "红卷心菜",
      "savoy cabbage": "皱叶甘蓝",
      "brussels sprouts": "抱子甘蓝",
      "broccoli": "西兰花",
      "cauliflower": "花椰菜",
      "romanesco": "罗马花椰菜",
      "broccolini": "西兰花苗",
      "broccoli rabe": "西兰花菜",
      "kohlrabi": "球茎甘蓝",
      "radish": "萝卜",
      "daikon": "白萝卜",
      "black radish": "黑萝卜",
      "watermelon radish": "西瓜萝卜",
      "horseradish": "辣根",
      "wasabi": "山葵",
      "carrot": "胡萝卜",
      "baby carrot": "小胡萝卜",
      "purple carrot": "紫胡萝卜",
      "parsnip": "欧洲萝卜",
      "celeriac": "根芹菜",
      "rutabaga": "芜菁",
      "turnip": "芜菁",
      "beet": "甜菜",
      "golden beet": "黄金甜菜",
      "chioggia beet": "基奥贾甜菜",
      "sugar beet": "糖用甜菜",
      "sweet potato": "红薯",
      "yam": "山药",
      "taro": "芋头",
      "cassava": "木薯",
      "jicama": "豆薯",
      "potato": "土豆",
      "russet potato": "赤褐色土豆",
      "red potato": "红土豆",
      "yellow potato": "黄土豆",
      "purple potato": "紫土豆",
      "fingerling potato": "指状土豆",
      "new potato": "新土豆",
      "baby potato": "小土豆",
      "onion": "洋葱",
      "yellow onion": "黄洋葱",
      "red onion": "红洋葱",
      "white onion": "白洋葱",
      "sweet onion": "甜洋葱",
      "Vidalia onion": "维达利亚洋葱",
      "Walla Walla onion": "瓦拉瓦拉洋葱",
      "shallot": "青葱",
      "scallion": "大葱",
      "green onion": "大葱",
      "spring onion": "春葱",
      "leek": "韭葱",
      "chive": "细香葱",
      "garlic": "大蒜",
      "elephant garlic": "象蒜",
      "black garlic": "黑蒜",
      "garlic scape": "蒜薹",
      "ginger": "姜",
      "young ginger": "嫩姜",
      "mature ginger": "老姜",
      "galangal": "高良姜",
      "turmeric": "姜黄",
      "cardamom": "豆蔻",
      "cinnamon": "肉桂",
      "nutmeg": "肉豆蔻",
      "mace": "肉豆蔻皮",
      "allspice": "多香果",
      "clove": "丁香",
      "star anise": "八角",
      "fennel": "茴香",
      "anise": "茴芹",
      "cumin": "孜然",
      "coriander": "香菜",
      "cilantro": "香菜",
      "parsley": "欧芹",
      "basil": "罗勒",
      "oregano": "牛至",
      "thyme": "百里香",
      "rosemary": "迷迭香",
      "sage": "鼠尾草",
      "mint": "薄荷",
      "spearmint": "留兰香",
      "peppermint": "胡椒薄荷",
      "chocolate mint": "巧克力薄荷",
      "apple mint": "苹果薄荷",
      "pineapple mint": "菠萝薄荷",
      "orange mint": "橙子薄荷",
      "lemon balm": "柠檬香蜂草",
      "lavender": "薰衣草",
      "dill": "莳萝",
      "tarragon": "龙蒿",
      "marjoram": "马郁兰",
      "chervil": "细叶芹",
      "chives": "细香葱",
      "scallions": "大葱",
      "green onions": "大葱",
      "spring onions": "春葱",
      "leeks": "韭葱",
      "shallots": "青葱",
      "garlic": "大蒜",
      "ginger": "姜",
      "turmeric": "姜黄",
      "galangal": "高良姜",
      "lemongrass": "柠檬草",
      "kaffir lime leaves": "卡菲尔酸橙叶",
      "curry leaves": "咖喱叶",
      "bay leaves": "月桂叶",
      "pandan leaves": "班兰叶",
      "hoja santa": "圣叶",
      "epazote": "土荆芥",
      "papalo": "帕帕洛",
      "culantro": "长香菜",
      "shiso": "紫苏",
      "perilla": "紫苏",
      "mitsuba": "三叶",
      "kinome": "木芽",
      "sansho": "山椒",
      "sichuan peppercorn": "花椒",
      "black pepper": "黑胡椒",
      "white pepper": "白胡椒",
      "green peppercorn": "绿胡椒",
      "pink peppercorn": "粉红胡椒",
      "long pepper": "长胡椒",
      "cubeb": "尾胡椒",
      "grains of paradise": "天堂谷",
      "melegueta pepper": "梅勒格塔胡椒",
      "ashanti pepper": "阿散蒂胡椒",
      "guinea pepper": "几内亚胡椒",
      "alligator pepper": "鳄鱼胡椒",
      "Ethiopian pepper": "埃塞俄比亚胡椒",
      "korarima": "科拉里马",
      "ajwain": "阿魏",
      "carom": "阿魏",
      "bishop's weed": "主教草",
      "caraway": "葛缕子",
      "nigella": "黑种草",
      "black cumin": "黑孜然",
      "kalonji": "卡隆吉",
      "onion seeds": "洋葱籽",
      "fennel seeds": "茴香籽",
      "anise seeds": "茴芹籽",
      "dill seeds": "莳萝籽",
      "mustard seeds": "芥菜籽",
      "yellow mustard": "黄芥菜",
      "brown mustard": "棕芥菜",
      "black mustard": "黑芥菜",
      "white mustard": "白芥菜",
      "poppy seeds": "罂粟籽",
      "sesame seeds": "芝麻",
      "white sesame": "白芝麻",
      "black sesame": "黑芝麻",
      "hulled sesame": "去壳芝麻",
      "unhulled sesame": "未去壳芝麻",
      "toasted sesame": "烤芝麻",
      "raw sesame": "生芝麻",
      "sunflower seeds": "葵花籽",
      "pumpkin seeds": "南瓜籽",
      "pepitas": "南瓜籽",
      "watermelon seeds": "西瓜籽",
      "squash seeds": "西葫芦籽",
      "cucumber seeds": "黄瓜籽",
      "melon seeds": "甜瓜籽",
      "cantaloupe seeds": "哈密瓜籽",
      "honeydew seeds": "蜜瓜籽",
      "charentais seeds": "夏朗泰籽",
      "gac seeds": "木鳖果籽",
      "bitter melon seeds": "苦瓜籽",
      "winter melon seeds": "冬瓜籽",
      "luffa seeds": "丝瓜籽",
      "snake gourd seeds": "蛇瓜籽",
      "ridge gourd seeds": "棱角丝瓜籽",
      "sponge gourd seeds": "海绵丝瓜籽",
      "dishcloth gourd seeds": "洗碗布丝瓜籽",
      "vegetable sponge seeds": "蔬菜海绵籽",
      "loofah seeds": "丝瓜络籽",
      "luffa aegyptiaca seeds": "埃及丝瓜籽",
      "luffa acutangula seeds": "棱角丝瓜籽",
      "angled luffa seeds": "棱角丝瓜籽",
      "ridged luffa seeds": "棱角丝瓜籽",
      "smooth luffa seeds": "光滑丝瓜籽",
      "cylindrical luffa seeds": "圆柱形丝瓜籽",
      "chinese okra seeds": "中国秋葵籽",
      "silk squash seeds": "丝瓜籽",
      "chinese okra": "中国秋葵",
      "silk squash": "丝瓜",
      "luffa": "丝瓜",
      "loofah": "丝瓜络",
      "vegetable sponge": "蔬菜海绵",
      "dishcloth gourd": "洗碗布丝瓜",
      "sponge gourd": "海绵丝瓜",
      "ridge gourd": "棱角丝瓜",
      "snake gourd": "蛇瓜",
      "winter melon": "冬瓜",
      "bitter melon": "苦瓜",
      "gac": "木鳖果",
      "charentais": "夏朗泰",
      "honeydew": "蜜瓜",
      "cantaloupe": "哈密瓜",
      "melon": "甜瓜",
      "cucumber": "黄瓜",
      "squash": "西葫芦",
      "watermelon": "西瓜",
      "pumpkin": "南瓜",
      "sunflower": "向日葵",
      "raw": "生的",
      "toasted": "烤的",
      "unhulled": "未去壳的",
      "hulled": "去壳的",
      "black": "黑色",
      "white": "白色",
      "sesame": "芝麻",
      "poppy": "罂粟",
      "mustard": "芥菜",
      "dill": "莳萝",
      "anise": "茴芹",
      "fennel": "茴香",
      "onion": "洋葱",
      "kalonji": "卡隆吉",
      "black cumin": "黑孜然",
      "nigella": "黑种草",
      "caraway": "葛缕子",
      "bishop's weed": "主教草",
      "carom": "阿魏",
      "ajwain": "阿魏",
      "Ethiopian pepper": "埃塞俄比亚胡椒",
      "alligator pepper": "鳄鱼胡椒",
      "guinea pepper": "几内亚胡椒",
      "ashanti pepper": "阿散蒂胡椒",
      "melegueta pepper": "梅勒格塔胡椒",
      "grains of paradise": "天堂谷",
      "cubeb": "尾胡椒",
      "long pepper": "长胡椒",
      "pink peppercorn": "粉红胡椒",
      "green peppercorn": "绿胡椒",
      "white pepper": "白胡椒",
      "black pepper": "黑胡椒",
      "sichuan peppercorn": "花椒",
      "sansho": "山椒",
      "kinome": "木芽",
      "mitsuba": "三叶",
      "perilla": "紫苏",
      "shiso": "紫苏",
      "culantro": "长香菜",
      "papalo": "帕帕洛",
      "epazote": "土荆芥",
      "hoja santa": "圣叶",
      "pandan leaves": "班兰叶",
      "bay leaves": "月桂叶",
      "curry leaves": "咖喱叶",
      "kaffir lime leaves": "卡菲尔酸橙叶",
      "lemongrass": "柠檬草",
      "galangal": "高良姜",
      "turmeric": "姜黄",
      "ginger": "姜",
      "garlic": "大蒜",
      "shallots": "青葱",
      "leeks": "韭葱",
      "spring onions": "春葱",
      "green onions": "大葱",
      "scallions": "大葱",
      "chives": "细香葱",
      "chervil": "细叶芹",
      "marjoram": "马郁兰",
      "tarragon": "龙蒿",
      "dill": "莳萝",
      "lavender": "薰衣草",
      "lemon balm": "柠檬香蜂草",
      "orange mint": "橙子薄荷",
      "pineapple mint": "菠萝薄荷",
      "apple mint": "苹果薄荷",
      "chocolate mint": "巧克力薄荷",
      "peppermint": "胡椒薄荷",
      "spearmint": "留兰香",
      "mint": "薄荷",
      "sage": "鼠尾草",
      "rosemary": "迷迭香",
      "thyme": "百里香",
      "oregano": "牛至",
      "basil": "罗勒",
      "parsley": "欧芹",
      "cilantro": "香菜",
      "coriander": "香菜",
      "cumin": "孜然",
      "anise": "茴芹",
      "fennel": "茴香",
      "star anise": "八角",
      "clove": "丁香",
      "allspice": "多香果",
      "mace": "肉豆蔻皮",
      "nutmeg": "肉豆蔻",
      "cinnamon": "肉桂",
      "cardamom": "豆蔻",
      "turmeric": "姜黄",
      "galangal": "高良姜",
      "ginger": "姜",
      "garlic": "大蒜",
      "garlic scape": "蒜薹",
      "black garlic": "黑蒜",
      "elephant garlic": "象蒜",
      "glass": "玻璃",
      "frame": "框架",
      "hinge": "铰链",
      "knob": "旋钮",
      "handle": "把手",
      "lock": "锁",
      "key": "钥匙；关键",
      "window": "窗户",
      "door": "门",
      "ceiling": "天花板",
      "wall": "墙",
      "floor": "地板；楼层",
      "roof": "屋顶",
      "balcony": "阳台",
      "yard": "院子",
      "garden": "花园",
      "garage": "车库",
      "office": "办公室",
      "study": "书房",
      "living room": "客厅",
      "dining room": "餐厅",
      "kitchen": "厨房",
      "bathroom": "浴室",
      "bedroom": "卧室",
      "room": "房间",
      "flat": "公寓",
      "apartment": "公寓",
      "house": "房子",
      "home": "家",
      "family": "家庭",
      "relative": "亲戚",
      "niece": "侄女",
      "nephew": "侄子",
      "cousin": "表兄弟；表姐妹",
      "aunt": "阿姨",
      "uncle": "叔叔",
      "grandparent": "祖父母",
      "grandma": "奶奶",
      "grandmother": "祖母",
      "grandpa": "爷爷",
      "grandfather": "祖父",
      "parent": "父母",
      "mummy": "妈妈",
      "mum": "妈妈",
      "mom": "妈妈",
      "mother": "母亲",
      "daddy": "爸爸",
      "dad": "爸爸",
      "father": "父亲",
      "sister": "姐妹",
      "brother": "兄弟",
      "daughter": "女儿",
      "son": "儿子",
      "wife": "妻子",
      "husband": "丈夫",
      "girlfriend": "女朋友",
      "boyfriend": "男朋友",
      "new friend": "新朋友",
      "old friend": "老朋友",
      "good friend": "好朋友",
      "close friend": "亲密的朋友",
      "best friend": "最好的朋友",
      "friend": "朋友",
      "roommate": "室友",
      "classmate": "同学",
      "pupil": "小学生",
      "student": "学生",
      "teacher": "教师",
      "professor": "教授",
      "dr": "医生；博士",
      "ms": "女士",
      "mr": "先生",
      "mrs": "夫人",
      "mister": "先生",
      "miss": "小姐",
      "madam": "夫人",
      "sir": "先生",
      "lady": "女士",
      "lord": "领主",
      "princess": "公主",
      "prince": "王子",
      "queen": "女王",
      "king": "国王",
      "president": "总统；校长",
      "director": "主任；导演",
      "manager": "经理",
      "boss": "老板",
      "leader": "领导",
      "member": "成员",
      "group": "组；群",
      "team": "团队",
      "player": "玩家；运动员",
      "coach": "教练",
      "training": "训练",
      "practice": "练习",
      "exercise": "锻炼",
      "sport": "运动",
      "game": "游戏",
      "play": "玩；戏剧",
      "theater": "剧院",
      "cinema": "电影院",
      "movie": "电影",
      "film": "电影；胶片",
      "camera": "相机",
      "photograph": "照片",
      "photo": "照片",
      "picture": "图片",
      "painting": "绘画",
      "artist": "艺术家",
      "art": "艺术",
      "gallery": "画廊",
      "museum": "博物馆",
      "exhibition": "展览",
      "display": "显示",
      "show": "显示；表演",
      "presentation": "演示",
      "lecture": "讲座",
      "speech": "演讲",
      "dialogue": "对话",
      "chat": "聊天",
      "conversation": "对话",
      "talk": "谈话",
      "discussion": "讨论",
      "conference": "会议",
      "meeting": "会议",
      "appointment": "约会；预约",
      "timetable": "时间表",
      "schedule": "时间表",
      "planning": "计划",
      "planner": "计划者",
      "plan": "计划",
      "preparation": "准备",
      "prepare": "准备",
      "unready": "未准备好的",
      "ready": "准备好的",
      "disorganized": "无组织的",
      "organized": "有组织的",
      "tidy": "整洁的",
      "messy": "凌乱的",
      "dirty": "脏的",
      "clean": "干净的",
      "ugly": "丑陋的",
      "handsome": "英俊的",
      "pretty": "漂亮的",
      "beautiful": "美丽的",
      "grey": "灰色",
      "gray": "灰色",
      "white": "白色",
      "black": "黑色",
      "brown": "棕色",
      "pink": "粉色",
      "purple": "紫色",
      "orange": "橙色",
      "yellow": "黄色",
      "green": "绿色",
      "blue": "蓝色",
      "red": "红色",
      "color": "颜色",
      "bright": "明亮的",
      "dark": "黑暗的",
      "light": "轻的；光",
      "heavy": "重的",
      "shallow": "浅的",
      "deep": "深的",
      "thin": "薄的；瘦的",
      "thick": "厚的",
      "narrow": "窄的",
      "wide": "宽的",
      "low": "低的",
      "high": "高的",
      "tall": "高的",
      "short": "短的",
      "long": "长的",
      "curved": "弯曲的",
      "straight": "直的",
      "flat": "平的",
      "round": "圆的",
      "rectangle": "长方形",
      "triangle": "三角形",
      "square": "正方形；广场",
      "circle": "圆；圈",
      "column": "列",
      "row": "排；行",
      "line": "线；行",
      "point": "点；分数",
      "score": "分数；得分",
      "dozen": "一打",
      "couple": "一对；几个",
      "pair": "一对",
      "single": "单个的",
      "double": "双倍",
      "third": "三分之一",
      "quarter": "四分之一",
      "half": "一半",
      "percent": "百分比",
      "times": "乘",
      "minus": "减",
      "plus": "加",
      "equal": "等于",
      "divide": "除",
      "multiply": "乘",
      "subtract": "减",
      "add": "加；添加",
      "count": "数；计算",
      "number": "数字；号码",
      "zero": "零",
      "billion": "十亿",
      "million": "百万",
      "thousand": "千",
      "hundred": "百",
      "ninety": "九十",
      "eighty": "八十",
      "seventy": "七十",
      "sixty": "六十",
      "fifty": "五十",
      "forty": "四十",
      "thirty": "三十",
      "twenty": "二十",
      "nineteen": "十九",
      "eighteen": "十八",
      "seventeen": "十七",
      "sixteen": "十六",
      "fifteen": "十五",
      "fourteen": "十四",
      "thirteen": "十三",
      "twelve": "十二",
      "eleven": "十一",
      "ten": "十",
      "nine": "九",
      "eight": "八",
      "seven": "七",
      "six": "六",
      "five": "五",
      "four": "四",
      "three": "三",
      "two": "二",
      "one": "一；一个",
      "themselves": "他们自己",
      "yourselves": "你们自己",
      "ourselves": "我们自己",
      "itself": "它自己",
      "herself": "她自己",
      "himself": "他自己",
      "yourself": "你自己",
      "myself": "我自己",
      "theirs": "他们的（名词性）",
      "ours": "我们的（名词性）",
      "hers": "她的（名词性）",
      "his": "他的（名词性）",
      "yours": "你的（名词性）",
      "mine": "我的（名词性）",
      "their": "他们的",
      "our": "我们的",
      "its": "它的",
      "her": "她的",
      "his": "他的",
      "your": "你的；你们的",
      "my": "我的",
      "them": "他们（宾格）",
      "us": "我们（宾格）",
      "her": "她（宾格）",
      "him": "他（宾格）",
      "me": "我（宾格）",
      "they": "他们",
      "we": "我们",
      "it": "它",
      "she": "她",
      "he": "他",
      "you": "你；你们",
      "I": "我",
      "those": "那些",
      "these": "这些",
      "that": "那个",
      "this": "这个",
      "nowhere": "无处",
      "anywhere": "任何地方",
      "somewhere": "某处",
      "everywhere": "到处",
      "where": "哪里",
      "there": "那里",
      "here": "这里",
      "far": "远的",
      "near": "靠近",
      "next to": "旁边",
      "beside": "在旁边",
      "in front of": "在...前面",
      "behind": "在...后面",
      "outside": "在...外面",
      "inside": "在...里面",
      "among": "在...之中",
      "between": "在...之间",
      "beside": "在旁边",
      "along": "沿着",
      "across": "穿过",
      "through": "通过",
      "around": "围绕；大约",
      "about": "关于",
      "to": "到；向",
      "of": "的",
      "from": "从",
      "for": "为了；对于",
      "without": "没有",
      "with": "和；用",
      "by": "通过；在旁边",
      "at": "在",
      "in": "在...里面",
      "on": "在...上面",
      "down": "向下",
      "up": "向上",
      "below": "在...下方",
      "above": "在...上方",
      "under": "在...下方",
      "over": "在...上方；超过",
      "onto": "到...上面",
      "into": "进入",
      "out of": "从...出来",
      "away from": "离开",
      "far from": "远离",
      "near to": "接近",
      "close to": "靠近",
      "next to": "旁边",
      "due to": "由于",
      "thanks to": "多亏",
      "welcome to": "欢迎",
      "invite to": "邀请",
      "introduce to": "介绍给",
      "explain to": "解释给",
      "show to": "展示给",
      "give to": "给",
      "send to": "发送给",
      "write to": "写给",
      "speak to": "和...说话",
      "talk to": "和...说话",
      "listen to": "听",
      "belong to": "属于",
      "stick to": "坚持",
      "object to": "反对",
      "look forward to": "期待",
      "get used to": "习惯于",
      "be used to": "习惯于",
      "used to": "过去常常",
      "tend to": "倾向于",
      "happen to": "碰巧",
      "appear to": "显得",
      "seem to": "似乎",
      "manage to": "设法",
      "fail to": "失败",
      "refuse to": "拒绝",
      "agree to": "同意",
      "promise to": "承诺",
      "expect to": "期望",
      "wish to": "希望",
      "hope to": "希望",
      "try to": "尝试",
      "plan to": "计划",
      "decide to": "决定",
      "prefer to": "更喜欢",
      "love to": "喜欢",
      "like to": "喜欢",
      "want to": "想要",
      "need to": "需要",
      "have to": "必须",
      "ought to": "应该",
      "shall": "将；应该",
      "would": "将；会（过去式）",
      "will": "将；会",
      "should": "应该",
      "must": "必须",
      "might": "可能",
      "may": "可能；可以",
      "could": "能；可以（过去式）",
      "can": "能；可以",
      "how old": "多大年纪",
      "how far": "多远",
      "how often": "多久一次",
      "how long": "多久；多长",
      "how many": "多少（可数）",
      "how much": "多少（不可数）",
      "how": "如何；怎样",
      "whose": "谁的",
      "whom": "谁（宾格）",
      "who": "谁",
      "which": "哪一个",
      "what": "什么",
      "why": "为什么",
      "where": "在哪里",
      "when": "当...时",
      "while": "当...时；然而",
      "during": "在...期间",
      "after": "在...之后",
      "before": "在...之前",
      "then": "然后；那时",
      "now": "现在",
      "soon": "很快；不久",
      "already": "已经",
      "yet": "还；然而",
      "still": "仍然；还",
      "even": "甚至；偶数",
      "just": "只是；刚刚",
      "only": "只有；仅仅",
      "else": "其他的",
      "another": "另一个",
      "other": "其他的",
      "neither": "两者都不",
      "either": "要么；也",
      "both": "两者都",
      "each": "每个",
      "every": "每个",
      "all": "所有的",
      "any": "任何",
      "some": "一些",
      "least": "最少的",
      "less": "更少的",
      "most": "最多的；大多数",
      "more": "更多的",
      "much": "很多",
      "many": "许多",
      "few": "很少的；几个",
      "little": "小的；少的",
      "bit": "一点；少量",
      "piece": "片；块",
      "part": "部分",
      "whole": "整个的；全部的",
      "complete": "完整的；完成",
      "full": "满的；完整的",
      "empty": "空的",
      "silent": "沉默的",
      "noisy": "嘈杂的",
      "loud": "大声的",
      "quiet": "安静的",
      "calm": "平静的",
      "serious": "严肃的；严重的",
      "funny": "有趣的；好笑的",
      "weird": "奇怪的",
      "strange": "奇怪的",
      "rare": "稀有的",
      "common": "常见的；共同的",
      "unusual": "不寻常的",
      "usual": "通常的",
      "normal": "正常的",
      "special": "特殊的；特别的",
      "personal": "个人的",
      "private": "私人的；私有的",
      "public": "公共的；公开的",
      "secret": "秘密",
      "truth": "真相；真理",
      "lie": "说谎；谎言",
      "honest": "诚实的",
      "rude": "粗鲁的",
      "polite": "有礼貌的",
      "mean": "意思是；刻薄的",
      "kind": "善良的；种类",
      "nice": "好的；漂亮的",
      "fine": "好的；精美的",
      "well": "好的；健康的",
      "ill": "生病的",
      "sick": "生病的",
      "healthy": "健康的",
      "weak": "弱的",
      "strong": "强壮的；强大的",
      "brave": "勇敢的",
      "scared": "害怕的",
      "afraid": "害怕的",
      "fear": "害怕；恐惧",
      "worry": "担心",
      "doubt": "怀疑",
      "trust": "信任",
      "believe": "相信",
      "expect": "期望；预期",
      "wish": "希望；祝愿",
      "hope": "希望",
      "try": "尝试",
      "plan": "计划",
      "decide": "决定",
      "choose": "选择",
      "prefer": "更喜欢；宁愿",
      "enjoy": "享受；喜欢",
      "hate": "讨厌；恨",
      "dislike": "不喜欢",
      "like": "喜欢",
      "want": "想要",
      "need": "需要",
      "look for": "寻找",
      "search": "搜索；寻找",
      "lose": "失去；丢失",
      "find": "找到；发现",
      "receive": "接收；收到",
      "send": "发送；送",
      "bring": "带来",
      "put": "放；放置",
      "take": "拿；取",
      "give": "给",
      "get": "得到；获得",
      "do": "做",
      "make": "做；制造",
      "fix": "修理；固定",
      "break": "打破；休息",
      "close": "关闭",
      "open": "打开",
      "turn": "转；转弯",
      "move": "移动；搬",
      "stay": "停留；待",
      "wait": "等待",
      "continue": "继续",
      "stop": "停止",
      "finish": "完成；结束",
      "end": "结束；末尾",
      "begin": "开始",
      "start": "开始",
      "arrive": "到达",
      "leave": "离开；留下",
      "come": "来",
      "go": "去；走",
      "stand": "站；站立",
      "sit": "坐",
      "jump": "跳",
      "run": "跑；运行",
      "walk": "走；步行",
      "taste": "尝；味道",
      "smell": "闻；气味",
      "touch": "触摸；接触",
      "feel": "感觉；感到",
      "hear": "听到",
      "watch": "观看；手表",
      "look": "看；看起来",
      "see": "看；看见",
      "think": "想；思考",
      "know": "知道；了解",
      "false": "假的；错误的",
      "true": "真的；真实的",
      "wrong": "错误的；错的",
      "right": "正确的；右边",
      "answer": "答案；回答",
      "question": "问题",
      "exam": "考试",
      "test": "测试；考试",
      "lesson": "课；课程",
      "class": "班级；课",
      "university": "大学",
      "school": "学校",
      "pay": "支付；付款",
      "cost": "花费；成本",
      "free": "免费的；自由的",
      "price": "价格",
      "sell": "卖；出售",
      "buy": "买；购买",
      "money": "钱；金钱",
      "job": "工作；职业",
      "work": "工作",
      "wake": "醒来；唤醒",
      "sleep": "睡觉",
      "eat": "吃",
      "drink": "喝；饮料",
      "water": "水",
      "food": "食物",
      "bed": "床",
      "chair": "椅子",
      "table": "桌子",
      "window": "窗户",
      "door": "门",
      "room": "房间",
      "house": "房子；房屋",
      "home": "家；家庭",
      "friend": "朋友",
      "family": "家庭；家人",
      "child": "孩子；儿童",
      "woman": "女人",
      "man": "男人",
      "person": "人；个人",
      "people": "人们；人",
      "second": "秒；第二",
      "minute": "分钟",
      "hour": "小时",
      "day": "天；日",
      "year": "年；年份",
      "month": "月；月份",
      "week": "周；星期",
      "night": "夜晚",
      "evening": "晚上；傍晚",
      "afternoon": "下午",
      "morning": "早晨；上午",
      "yesterday": "昨天",
      "tomorrow": "明天",
      "today": "今天",
      "previous": "以前的；上一个",
      "next": "下一个；接下来",
      "last": "最后；最后的",
      "first": "第一；首先",
      "same": "相同的",
      "different": "不同的",
      "difficult": "困难的",
      "interesting": "有趣的",
      "important": "重要的",
      "ugly": "丑陋的",
      "beautiful": "美丽的",
      "sad": "悲伤的",
      "happy": "快乐的；高兴的",
      "cold": "冷的",
      "hot": "热的",
      "slow": "慢的",
      "fast": "快的；迅速的",
      "hard": "困难的；硬的",
      "easy": "容易的；简单的",
      "old": "旧的；老的",
      "new": "新的",
      "small": "小的",
      "big": "大的",
      "no": "不；不是",
      "yes": "是；是的",
      "sorry": "抱歉；对不起",
      "please": "请",
      "thank": "感谢；谢谢",
      "help": "帮助；协助",
      "extension": "扩展；延伸",
      "browser": "浏览器",
      "website": "网站",
      "internet": "互联网；网络",
      "computer": "电脑；计算机",
      "page": "页；页面",
      "book": "书；书籍",
      "teacher": "教师；老师",
      "student": "学生",
      "english": "英语；英文",
      "language": "语言",
      "improve": "改进；提高",
      "practice": "练习；实践",
      "forget": "忘记",
      "remember": "记住；回忆",
      "understand": "理解；明白",
      "listen": "听；倾听",
      "speak": "说；讲",
      "write": "写；写作",
      "read": "阅读；读",
      "study": "学习；研究",
      "learn": "学习；了解",
      "dictionary": "词典；字典",
      "translate": "翻译；转换",
      "word": "单词；词",
      "time": "时间；次数",
      "love": "爱；喜欢",
      "peace": "和平；安宁",
      "world": "世界",
      "hello": "你好；问候"
    };
  }

  // 有道免 Key 接口：suggest（词典提示）→ fanyi（网页翻译）
  // 返回 { text, source:'youdao' } 或 null
  async function translateWordToChineseYoudao(word) {
    const text = String(word || '').trim();
    if (!text) return null;
    const startedAt = Date.now();

    const logYoudao = (success, error, detail) => {
      try {
        appendDeepseekLog({
          word: text,
          success: !!success,
          error: error || '',
          api: 'youdao',
          source: 'content-youdao',
          durationMs: Math.max(0, Date.now() - startedAt),
          detail: detail || ''
        });
      } catch (e) {}
    };

    const fetchJson = async (url, timeoutMs) => {
      const response = await extensionFetch(url, { timeoutMs });
      if (!response.ok) throw new Error(`http_${response.status}`);
      return await response.json();
    };

    // 1) 词典 suggest（适合单词）
    try {
      const suggestUrl =
        `https://dict.youdao.com/suggest?q=${encodeURIComponent(text)}&num=1&doctype=json`;
      const data = await fetchJson(suggestUrl, 3500);
      if (data && data.data && data.data.entries && data.data.entries.length > 0) {
        const entry = data.data.entries[0];
        const translation = entry && entry.explain ? String(entry.explain).trim() : '';
        if (translation) {
          logYoudao(true, '', 'suggest');
          return { text: translation, source: 'youdao' };
        }
      }
    } catch (error) {
      // 继续试网页翻译接口
    }

    // 2) 网页翻译（免 Key，适合词/短句）
    try {
      const fanyiUrl =
        `https://fanyi.youdao.com/translate?&doctype=json&type=EN2ZH_CN&i=${encodeURIComponent(text)}`;
      const data = await fetchJson(fanyiUrl, 4000);
      // { translateResult: [[{ tgt, src }]], type, errorCode }
      const parts = data && data.translateResult;
      if (Array.isArray(parts) && parts.length) {
        const joined = parts
          .map((row) => {
            if (!Array.isArray(row)) return '';
            return row.map((seg) => (seg && seg.tgt ? String(seg.tgt) : '')).join('');
          })
          .join('')
          .trim();
        if (joined) {
          logYoudao(true, '', 'fanyi');
          return { text: joined, source: 'youdao' };
        }
      }
      logYoudao(false, 'empty_result', 'fanyi');
    } catch (error) {
      const msg = (error && error.name === 'AbortError')
        ? 'timeout'
        : ((error && error.message) || 'request_failed');
      logYoudao(false, msg, 'fanyi');
    }

    return null;
  }

  // 查询离线词典（通过background service worker，使用IndexedDB）
  // 返回 { text, source }；source 可能为 ecd / youdao
  async function translateWordToChineseOffline(word) {
    try {
      // 通过消息传递查询background中的IndexedDB
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'queryOfflineDict', word: word },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('查询离线词典失败:', chrome.runtime.lastError);
              resolve(null);
            } else if (response && response.success && response.translation) {
              resolve({
                text: response.translation,
                source: response.source || 'ecd'
              });
            } else {
              resolve(null);
            }
          }
        );
      });
    } catch (error) {
      console.error('查询离线词典出错:', error);
      return null;
    }
  }
  
  // 旧的查询方法（保留作为备用，用于内置小词典）
  async function translateWordToChineseOfflineLegacy(word) {
    try {
      const dict = await loadOfflineDictionary();
      const lowerWord = word.toLowerCase().trim();
      
      // 1. 直接匹配
      if (dict[lowerWord]) {
        return dict[lowerWord];
      }
      
      // 2. 尝试匹配复数形式
      // -s: words -> word
      if (lowerWord.endsWith('s') && lowerWord.length > 1) {
        const base = lowerWord.slice(0, -1);
        if (dict[base]) return dict[base];
      }
      
      // -es: boxes -> box, studies -> study
      if (lowerWord.endsWith('es') && lowerWord.length > 2) {
        const base1 = lowerWord.slice(0, -2); // boxes -> box
        if (dict[base1]) return dict[base1];
        
        // -ies: studies -> study (y变i加es)
        if (lowerWord.endsWith('ies') && lowerWord.length > 3) {
          const base2 = lowerWord.slice(0, -3) + 'y'; // studies -> study
          if (dict[base2]) return dict[base2];
        }
      }
      
      // -ies: flies -> fly
      if (lowerWord.endsWith('ies') && lowerWord.length > 3) {
        const base = lowerWord.slice(0, -3) + 'y';
        if (dict[base]) return dict[base];
      }
      
      // 3. 尝试匹配过去式
      // -ed: walked -> walk
      if (lowerWord.endsWith('ed') && lowerWord.length > 2) {
        const base1 = lowerWord.slice(0, -2); // walked -> walk
        if (dict[base1]) return dict[base1];
        
        // -ied: studied -> study (y变i加ed)
        if (lowerWord.endsWith('ied') && lowerWord.length > 3) {
          const base2 = lowerWord.slice(0, -3) + 'y'; // studied -> study
          if (dict[base2]) return dict[base2];
        }
        
        // 双写辅音的情况: stopped -> stop
        if (lowerWord.length > 4) {
          const lastChar = lowerWord[lowerWord.length - 3];
          const secondLastChar = lowerWord[lowerWord.length - 4];
          if (lastChar === secondLastChar) {
            const base3 = lowerWord.slice(0, -3) + lastChar; // stopped -> stop
            if (dict[base3]) return dict[base3];
          }
        }
      }
      
      // -d: 以e结尾的过去式，如 loved -> love
      if (lowerWord.endsWith('d') && lowerWord.length > 1) {
        const base = lowerWord.slice(0, -1);
        if (dict[base]) return dict[base];
      }
      
      // 4. 尝试匹配进行时
      // -ing: walking -> walk
      if (lowerWord.endsWith('ing') && lowerWord.length > 3) {
        const base1 = lowerWord.slice(0, -3); // walking -> walk
        if (dict[base1]) return dict[base1];
        
        // -ying: studying -> study (ie变y加ing)
        if (lowerWord.endsWith('ying') && lowerWord.length > 4) {
          const base2 = lowerWord.slice(0, -4) + 'y'; // studying -> study
          if (dict[base2]) return dict[base2];
        }
        
        // 双写辅音的情况: running -> run
        if (lowerWord.length > 5) {
          const lastChar = lowerWord[lowerWord.length - 4];
          const secondLastChar = lowerWord[lowerWord.length - 5];
          if (lastChar === secondLastChar) {
            const base3 = lowerWord.slice(0, -4) + lastChar; // running -> run
            if (dict[base3]) return dict[base3];
          }
        }
        
        // -e结尾的进行时: making -> make
        if (lowerWord.endsWith('ing') && lowerWord.length > 4) {
          const base4 = lowerWord.slice(0, -3) + 'e'; // making -> make
          if (dict[base4]) return dict[base4];
        }
      }
      
      // 5. 尝试匹配比较级
      // -er: bigger -> big
      if (lowerWord.endsWith('er') && lowerWord.length > 2) {
        const base1 = lowerWord.slice(0, -2); // bigger -> big
        if (dict[base1]) return dict[base1];
        
        // -ier: happier -> happy (y变i加er)
        if (lowerWord.endsWith('ier') && lowerWord.length > 3) {
          const base2 = lowerWord.slice(0, -3) + 'y'; // happier -> happy
          if (dict[base2]) return dict[base2];
        }
        
        // 双写辅音的情况: bigger -> big
        if (lowerWord.length > 4) {
          const lastChar = lowerWord[lowerWord.length - 3];
          const secondLastChar = lowerWord[lowerWord.length - 4];
          if (lastChar === secondLastChar) {
            const base3 = lowerWord.slice(0, -3) + lastChar; // bigger -> big
            if (dict[base3]) return dict[base3];
          }
        }
      }
      
      // 6. 尝试匹配最高级
      // -est: biggest -> big
      if (lowerWord.endsWith('est') && lowerWord.length > 3) {
        const base1 = lowerWord.slice(0, -3); // biggest -> big
        if (dict[base1]) return dict[base1];
        
        // -iest: happiest -> happy (y变i加est)
        if (lowerWord.endsWith('iest') && lowerWord.length > 4) {
          const base2 = lowerWord.slice(0, -4) + 'y'; // happiest -> happy
          if (dict[base2]) return dict[base2];
        }
        
        // 双写辅音的情况: biggest -> big
        if (lowerWord.length > 5) {
          const lastChar = lowerWord[lowerWord.length - 4];
          const secondLastChar = lowerWord[lowerWord.length - 5];
          if (lastChar === secondLastChar) {
            const base3 = lowerWord.slice(0, -4) + lastChar; // biggest -> big
            if (dict[base3]) return dict[base3];
          }
        }
      }
      
      // 7. 尝试匹配第三人称单数
      // -s: walks -> walk
      if (lowerWord.endsWith('s') && lowerWord.length > 1) {
        const base = lowerWord.slice(0, -1);
        if (dict[base]) return dict[base];
      }
      
      // -es: goes -> go, does -> do
      if (lowerWord.endsWith('es') && lowerWord.length > 2) {
        const base1 = lowerWord.slice(0, -2);
        if (dict[base1]) return dict[base1];
      }
      
      // 旧路径备用：有道免 Key（主链已单独优先有道，这里仅兼容）
      const youdaoResult = await translateWordToChineseYoudao(word);
      if (youdaoResult && youdaoResult.text) {
        return youdaoResult.text;
      }
      
      return null;
    } catch (error) {
      try {
        const youdaoResult = await translateWordToChineseYoudao(word);
        if (youdaoResult && youdaoResult.text) {
          return youdaoResult.text;
        }
      } catch (youdaoError) {
        // 静默失败
      }
      return null;
    }
  }

  // 多引擎翻译：按测速保存的 translateOrder 依次尝试
  async function translateWordToChinese(word) {
    if (!isExtensionContextValid()) {
      notifyExtensionContextInvalid();
      return EXTENSION_RELOAD_HINT;
    }
    const lowerWord = String(word || '').toLowerCase();
    if (isSingleLookupWord(word)) {
      const shared = await readSharedLookup(lowerWord);
      const sharedText = shared && String(shared.translation || '').trim();
      if (sharedText && !isFailedTranslationText(sharedText)) {
        const sourceAbbr = shared.translationSource || (shared.dict && shared.dict.translationSource) || '';
        if (sourceAbbr) {
          wordSourceMap.set(lowerWord, sourceAbbr);
          setChineseSource(lowerWord, sourceAbbr);
        }
        return sharedText;
      }
    }
    const routeCfg = await getApiRouteConfig();

    const engines = {
      offline: {
        name: 'offline',
        run: async () => {
          const offline = await translateWordToChineseOffline(word);
          if (!offline || !offline.text) return null;
          return { text: offline.text, source: offline.source || 'ecd' };
        }
      },
      youdao: {
        name: 'youdao',
        run: async () => {
          const got = await translateWordToChineseYoudao(word);
          if (!got) return null;
          if (typeof got === 'string') return { text: got, source: 'youdao' };
          return got.text ? { text: got.text, source: got.source || 'youdao' } : null;
        }
      },
      gt: {
        name: 'google',
        run: async () => {
          const text = await translateWordToChineseGoogle(word);
          return text ? { text, source: 'gt' } : null;
        }
      },
      baidu: {
        name: 'baidu',
        run: async () => {
          const text = await translateWordWithBaiduSimple(word);
          return text ? { text, source: 'bd' } : null;
        }
      },
      mm: {
        name: 'mymemory',
        run: async () => {
          const text = await translateWordToChineseMyMemory(word);
          return text ? { text, source: 'mm' } : null;
        }
      }
    };

    const order = (routeCfg.translateOrder || DEFAULT_API_ROUTE.translateOrder)
      .map((id) => (id === 'google' ? 'gt' : id));
    const attempts = order.map((id) => engines[id]).filter(Boolean);
    // 兜底：确保默认引擎都在末尾补上，避免配置缺项
    DEFAULT_API_ROUTE.translateOrder.forEach((id) => {
      const eng = engines[id];
      if (eng && !attempts.includes(eng)) attempts.push(eng);
    });

    for (let i = 0; i < attempts.length; i++) {
      try {
        const got = await attempts[i].run();
        const text = got && got.text ? String(got.text).trim() : '';
        if (text && !isFailedTranslationText(text)) {
          const sourceAbbr = got.source || attempts[i].name;
          wordSourceMap.set(lowerWord, sourceAbbr);
          setChineseSource(lowerWord, sourceAbbr);
          if (isSingleLookupWord(word) && sourceAbbr && sourceAbbr !== 'ecd' && sourceAbbr !== 'offline') {
            writeSharedLookup(word, {
              dict: wordDictionaryData.get(lowerWord) || null,
              translation: text,
              translationSource: sourceAbbr
            });
          }
          return text;
        }
      } catch (error) {
        if (!isExtensionContextValid()) {
          notifyExtensionContextInvalid();
          return EXTENSION_RELOAD_HINT;
        }
        if (i === attempts.length - 1) {
          return '翻译失败，请检查网络';
        }
      }
    }

    return isExtensionContextValid() ? '翻译失败，请检查网络' : EXTENSION_RELOAD_HINT;
  }

  // 获取单词中文翻译（按地区引擎链）
  async function translateWord(word) {
    try {
      return await translateWordToChinese(word);
    } catch (error) {
      console.error('翻译过程出错:', error);
      if (!isExtensionContextValid()) {
        notifyExtensionContextInvalid();
        return EXTENSION_RELOAD_HINT;
      }
      return '翻译失败，请检查网络';
    }
  }

  // 创建翻译弹窗（显示完整词典信息；支持回退 / 双击探词）
  async function createTranslationPopup(word, translation, isSaved, status, dictData = null, chineseTranslation = null, options = {}) {
    const opts = options || {};
    const cleanWord = String(word || '').trim();
    if (!cleanWord) return null;
    const lowerWord = cleanWord.toLowerCase();

    if (!opts.skipHistory) {
      if (currentPopup && floatingDetailCurrent) {
        const prevLower = String(floatingDetailCurrent.word || '').toLowerCase();
        if (prevLower && prevLower !== lowerWord) {
          floatingDetailHistory.push({
            word: floatingDetailCurrent.word,
            translation: floatingDetailCurrent.translation || '',
            isSaved: floatingDetailCurrent.isSaved,
            status: floatingDetailCurrent.status,
            dictData: floatingDetailCurrent.dictData || null,
            chineseTranslation: floatingDetailCurrent.chineseTranslation || ''
          });
        }
      } else if (!currentPopup) {
        floatingDetailHistory.length = 0;
      }
    }

    // 移除现有弹窗（保留历史栈）
    if (currentPopup) {
      currentPopup.remove();
      currentPopup = null;
    }

    const isMastered = status === 'mastered';
    
    // 获取保存的数据（始终以中文释义为主）
    const savedDictData = dictData || wordDictionaryData.get(lowerWord);
    const savedChineseTranslation = chineseTranslation || wordChineseTranslations.get(lowerWord);
    floatingDetailCurrent = {
      word: cleanWord,
      translation: translation || savedChineseTranslation || '',
      isSaved: !!isSaved,
      status: status || 'new',
      dictData: savedDictData || null,
      chineseTranslation: savedChineseTranslation || ''
    };
    
    let displayContent = '';
    if (savedDictData || savedChineseTranslation) {
      displayContent = await formatFullDictionaryInfo(savedDictData, null, savedChineseTranslation);
    } else {
      displayContent = `<div class="vocab-popup-simple-translation">${escapeDisplayText(translation)}</div>`;
    }

    // 获取音标和音频
    let phoneticText = '';
    if (savedDictData && savedDictData.phonetics && savedDictData.phonetics.length > 0) {
      const phoneticWithAudio = savedDictData.phonetics.find(p => p.audio);
      const phonetic = phoneticWithAudio || savedDictData.phonetics.find(p => p.text) || savedDictData.phonetics[0];
      if (phonetic && phonetic.text) phoneticText = phonetic.text;
    }

    const canBack = floatingDetailHistory.length > 0;
    const safeWord = escapeDetailHtml(cleanWord);
    const safePhonetic = escapeDetailHtml(phoneticText);
    const popup = document.createElement('div');
    popup.className = 'vocab-translation-popup vocab-popup-full';
    popup.innerHTML = `
      <div class="vocab-popup-header">
        <div class="vocab-popup-word-section">
          <div class="vocab-popup-word-row">
            <button type="button" class="vocab-popup-back" title="返回上一词" aria-label="返回上一词"${canBack ? '' : ' hidden'}>← 返回</button>
            <span class="vocab-popup-word">${safeWord}</span>
          </div>
          ${phoneticText ? `<span class="vocab-popup-phonetic">/${safePhonetic}/</span>` : ''}
        </div>
        <div class="vocab-popup-header-actions">
          <div class="vocab-popup-pronounce-buttons">
            <button class="vocab-popup-pronounce" title="英音发音" data-word="${safeWord}" data-type="1">🔊</button>
            <button class="vocab-popup-pronounce" title="美音发音" data-word="${safeWord}" data-type="2">🔊</button>
          </div>
          <button class="vocab-popup-close">×</button>
        </div>
      </div>
      <div class="vocab-popup-content vocab-popup-dict-content">
        ${displayContent}
        <div class="vocab-popup-status">
          ${isMastered ? '<span class="status-badge mastered">✓ 已记住</span>' : '<span class="status-badge new">未记住</span>'}
        </div>
        <div class="vocab-popup-actions">
          <button class="vocab-btn vocab-btn-remove" data-word="${safeWord}">移除收藏</button>
          ${!isMastered ? `<button class="vocab-btn vocab-btn-master" data-word="${safeWord}">✓ 已记住</button>` : ''}
        </div>
      </div>
    `;

    // 挂到 <html> 下（与详情/划句弹窗一致）：Bing 的广告拦截脚本会删掉 body 里新插入、class 不以 b_ 开头的 DIV
    document.documentElement.appendChild(popup);
    currentPopup = popup;

    // 绑定事件
    bindPopupEvents(popup, cleanWord, translation, isSaved, status);

    return popup;
  }

  // 按地区引擎链获取最佳中文翻译
  async function getBestTranslation(word) {
    return translateWordToChinese(word);
  }

  // 显示翻译弹窗（双击时自动收藏）
  async function showTranslationPopup(event, word) {
    // 确保数据已加载
    if (!isLoaded) {
      await loadWords();
    }

    const lowerWord = word.toLowerCase();
    const isSaved = savedWords.has(lowerWord);
    
    // 如果已保存，直接从词库读取并显示
    if (isSaved) {
      const existingTranslation = wordTranslations.get(lowerWord);
      const existingDictData = wordDictionaryData.get(lowerWord);
      const status = wordStatus.get(lowerWord) || 'new';
      
      if (existingDictData) {
        // 有完整词典数据，显示完整信息
        const existingChineseTranslation = wordChineseTranslations.get(lowerWord);
        const popup = await createTranslationPopup(word, existingTranslation, true, status, existingDictData, existingChineseTranslation);
        positionPopup(popup, event);
      } else if (existingTranslation) {
        // 只有简单翻译，显示简单翻译
        const existingChineseTranslation = wordChineseTranslations.get(lowerWord);
        const popup = await createTranslationPopup(word, existingTranslation, true, status, null, existingChineseTranslation);
        positionPopup(popup, event);
      }
      return;
    }
    
    // 新单词：先搜索单词意思，再加入词库，再从词库显示
    // 1. 先显示加载提示
    const popup = await createTranslationPopup(word, '搜索中...', true, 'new');
    positionPopup(popup, event);
    
    // 2. 搜索单词意思（获取完整词典信息）
    const dictData = await fetchDictionaryInfo(word);
    
    // 3. 使用多引擎获取最佳翻译（作为备用，用于标记显示）
    const translation = await getBestTranslation(word);
    
    // 4. 加入词库（保存完整词典信息和翻译）
    await saveWord(word, translation);
    
    // 5. 从词库读取并显示
    // 重新加载数据以确保获取最新保存的信息
    await loadWords();
    
    const savedTranslation = wordTranslations.get(lowerWord);
    const savedDictData = wordDictionaryData.get(lowerWord);
    const savedStatus = wordStatus.get(lowerWord) || 'new';
    
    // 更新弹窗显示从词库读取的信息
    if (popup.parentNode) {
      const contentEl = popup.querySelector('.vocab-popup-dict-content');
      if (contentEl) {
        if (savedDictData || wordChineseTranslations.get(lowerWord)) {
          const savedChineseTranslation = wordChineseTranslations.get(lowerWord);
          const fullInfo = await formatFullDictionaryInfo(savedDictData, null, savedChineseTranslation);
          const statusEl = popup.querySelector('.vocab-popup-status');
          const actionsEl = popup.querySelector('.vocab-popup-actions');
          contentEl.innerHTML = fullInfo + (statusEl ? statusEl.outerHTML : '') + (actionsEl ? actionsEl.outerHTML : '');
        } else {
          // 如果没有词典数据，显示简单翻译
          const simpleEl = popup.querySelector('.vocab-popup-simple-translation');
          if (simpleEl) {
            simpleEl.textContent = savedTranslation || translation;
          } else {
            // 如果没有简单翻译元素，创建一个
            contentEl.innerHTML = `<div class="vocab-popup-simple-translation">${savedTranslation || translation}</div>` + 
                                  (popup.querySelector('.vocab-popup-status') ? popup.querySelector('.vocab-popup-status').outerHTML : '') + 
                                  (popup.querySelector('.vocab-popup-actions') ? popup.querySelector('.vocab-popup-actions').outerHTML : '');
          }
        }
        // 重新绑定事件
        bindPopupEvents(popup, word, savedTranslation || translation, true, savedStatus);
      }
    }
  }

  // 定位弹窗位置
  function positionPopup(popup, event) {
    const selection = window.getSelection();
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    
    if (range) {
      const rect = range.getBoundingClientRect();
      popup.style.left = rect.left + 'px';
      popup.style.top = (rect.bottom + 10) + 'px';
    } else if (event) {
      popup.style.left = event.clientX + 'px';
      popup.style.top = (event.clientY + 10) + 'px';
    }

    // 确保不超出视窗
    setTimeout(() => {
      const popupRect = popup.getBoundingClientRect();
      if (popupRect.right > window.innerWidth) {
        popup.style.left = (window.innerWidth - popupRect.width - 10) + 'px';
      }
      if (popupRect.bottom > window.innerHeight) {
        popup.style.top = (window.innerHeight - popupRect.height - 10) + 'px';
      }
      if (popupRect.left < 0) {
        popup.style.left = '10px';
      }
      if (popupRect.top < 0) {
        popup.style.top = '10px';
      }
    }, 0);
  }

  // 当前tooltip关联的单词
  let currentTooltipWord = null;
  let tooltipTimeout = null;


  // Edge 自然语音朗读：扩展无法直接调起系统「大声朗读」，改用同一套 Microsoft Natural 语音。
  // 优先 name 含 Natural 且 lang 为 en-US，否则任意 en-*；voices 可能异步加载（voiceschanged）。
  let wnSpeechText = null;
  let wnSpeechUtterance = null;
  let wnSpeechToken = 0;
  let wnSpeechPending = false;
  let wnVoicesReady = null;

  function wnGetSpeechVoices() {
    if (!('speechSynthesis' in window)) return Promise.resolve([]);
    try {
      const list = window.speechSynthesis.getVoices();
      if (list && list.length) return Promise.resolve(Array.from(list));
    } catch (e) {}
    if (wnVoicesReady) return wnVoicesReady;
    wnVoicesReady = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { window.speechSynthesis.removeEventListener('voiceschanged', finish); } catch (e) {}
        clearTimeout(tid);
        let voices = [];
        try { voices = Array.from(window.speechSynthesis.getVoices() || []); } catch (err) {}
        resolve(voices);
      };
      try { window.speechSynthesis.addEventListener('voiceschanged', finish); } catch (e) {}
      const tid = setTimeout(finish, 2500);
      try {
        const again = window.speechSynthesis.getVoices();
        if (again && again.length) finish();
      } catch (e) {}
    });
    return wnVoicesReady;
  }

  function wnPickEdgeVoice(voices) {
    const list = Array.isArray(voices) ? voices : [];
    const isEn = (v) => /^en([-_]|$)/i.test(v && v.lang || '');
    const isUs = (v) => /^en[-_]US/i.test(v && v.lang || '');
    const isNatural = (v) => /natural/i.test(v && v.name || '');
    return list.find((v) => isNatural(v) && isUs(v))
      || list.find((v) => isNatural(v) && isEn(v))
      || list.find(isUs)
      || list.find(isEn)
      || null;
  }

  function wnStopEdgeSpeech() {
    wnSpeechText = null;
    wnSpeechUtterance = null;
    wnSpeechPending = false;
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch (e) {}
  }

  function wnIsEdgeSpeaking() {
    try {
      return !!(window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending));
    } catch (e) {
      return false;
    }
  }

  function speakWithEdgeVoice(text) {
    const t = String(text || '').trim();
    if (!t) return Promise.resolve(false);
    if (!('speechSynthesis' in window)) return Promise.resolve(false);
    if (wnSpeechText === t && (wnIsEdgeSpeaking() || wnSpeechPending)) {
      wnSpeechToken += 1;
      wnStopEdgeSpeech();
      return Promise.resolve('stopped');
    }
    const token = ++wnSpeechToken;
    wnSpeechText = t;
    wnSpeechPending = true;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    return wnGetSpeechVoices().then((voices) => {
      if (token !== wnSpeechToken) return 'cancelled';
      wnSpeechPending = false;
      const utterance = new SpeechSynthesisUtterance(t);
      utterance.lang = 'en-US';
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;
      const voice = wnPickEdgeVoice(voices);
      if (voice) {
        utterance.voice = voice;
        if (voice.lang) utterance.lang = voice.lang;
      }
      utterance.onend = () => {
        if (wnSpeechUtterance === utterance) {
          wnSpeechText = null;
          wnSpeechUtterance = null;
        }
      };
      utterance.onerror = () => {
        if (wnSpeechUtterance === utterance) {
          wnSpeechText = null;
          wnSpeechUtterance = null;
        }
      };
      wnSpeechUtterance = utterance;
      window.speechSynthesis.speak(utterance);
      return true;
    }).catch(() => {
      if (token === wnSpeechToken) {
        wnSpeechPending = false;
        wnSpeechText = null;
      }
      return false;
    });
  }

  // 创建悬停提示框
  // 发音：按测速 ttsOrder，最后系统朗读
  function speakWord(word, type = 1) {
    // type: 1 = 英音, 2 = 美音
    const text = String(word || '').trim();
    if (!text) return;

    const lang = type === 1 ? 'en-GB' : 'en-US';
    const accent = type === 1 ? 'uk' : 'us';
    const googleUrl =
      `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx` +
      `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
    const youdaoUrl =
      `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=${type}`;

    const logTts = (api, success, error, startedAt, extraDetail) => {
      appendDeepseekLog({
        word: text,
        success: !!success,
        error: error || '',
        api,
        source: 'content-tts',
        durationMs: Math.max(0, Date.now() - startedAt),
        detail: [accent, extraDetail].filter(Boolean).join('; ')
      });
    };

    const speakWeb = (startedAt) => {
      if (!('speechSynthesis' in window)) {
        logTts('webspeech', false, 'unsupported', startedAt);
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = lang;
        utterance.rate = 0.9;
        utterance.pitch = 1;
        utterance.volume = 1;
        window.speechSynthesis.speak(utterance);
        logTts('webspeech', true, '', startedAt, 'fallback');
      } catch (e) {
        logTts('webspeech', false, (e && e.message) || 'speak_failed', startedAt);
      }
    };

    const playUrl = (url, api, onFail) => {
      const startedAt = Date.now();
      let settled = false;
      const audio = new Audio(url);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        logTts(api, false, err || 'audio_error', startedAt);
        onFail();
      };
      audio.onerror = () => fail('audio_error');
      audio.play().then(() => {
        if (settled) return;
        settled = true;
        logTts(api, true, '', startedAt);
      }).catch((e) => fail((e && e.name) || (e && e.message) || 'play_failed'));
    };

    chrome.storage.local.get(['apiRouteConfig'], (result) => {
      const cfg = result && result.apiRouteConfig;
      const order = (cfg && Array.isArray(cfg.ttsOrder) && cfg.ttsOrder.length)
        ? cfg.ttsOrder.slice()
        : DEFAULT_API_ROUTE.ttsOrder.slice();
      const steps = order.map((id) => {
        if (id === 'google_tts') return () => new Promise((resolve) => playUrl(googleUrl, 'google_tts', resolve));
        if (id === 'youdao_tts') return () => new Promise((resolve) => playUrl(youdaoUrl, 'youdao_tts', resolve));
        return null;
      }).filter(Boolean);

      const run = (i) => {
        if (i >= steps.length) {
          speakWeb(Date.now());
          return;
        }
        steps[i]().then(() => run(i + 1));
      };
      run(0);
    });
  }

  async function createTooltip(word, translation) {
    // 如果已经有相同单词的tooltip，不重复创建
    if (currentTooltip && currentTooltipWord === word) {
      return currentTooltip;
    }

    // 移除旧的tooltip
    if (currentTooltip) {
      currentTooltip.remove();
      currentTooltip = null;
      currentTooltipWord = null;
    }

    const lowerWord = word.toLowerCase();
    let dictData = wordDictionaryData.get(lowerWord);
    
    // 如果当前单词没有词典数据，始终优先查询离线词典（包括通过映射表查找原形词）
    if (!dictData) {
      try {
          const offlineData = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { action: 'queryOfflineDictData', word: lowerWord },
              (response) => {
                if (chrome.runtime.lastError) {
                  resolve(null);
                } else if (response && response.success && response.data) {
                  resolve(response.data);
                } else {
                  resolve(null);
                }
              }
            );
          });
          
          if (offlineData) {
            // 构建符合格式的词典数据对象
            // 悬停只读缓存/离线，不触发全量在线补全（避免鼠标划过引发请求风暴）
            dictData = {
              word: word,
              phonetics: offlineData.phonetic ? [{
                text: offlineData.phonetic,
                source: 'offline'
              }] : [],
              meanings: [],
              translation: offlineData.translation,
              sourceAbbr: 'ecd'
            };
            wordDictionaryData.set(lowerWord, dictData);
          }
        } catch (error) {
          console.warn('查询离线词典数据失败:', error);
          if (!isExtensionContextValid()) notifyExtensionContextInvalid();
        }
      }
      
      // 如果离线词典没有找到，尝试通过映射表查找原形词
      if (!dictData) {
        // 尝试算法匹配查找可能的原形词
        const possibleLemmas = [
          // 复数：expectancies -> expectancy
          lowerWord.endsWith('ies') ? lowerWord.slice(0, -3) + 'y' : null,
          lowerWord.endsWith('es') ? lowerWord.slice(0, -2) : null,
          lowerWord.endsWith('s') ? lowerWord.slice(0, -1) : null,
        ].filter(v => v !== null && v.length >= 2);
        
        // 先检查本地存储中是否有原形词的词典数据
        for (const lemma of possibleLemmas) {
          const lemmaDictData = wordDictionaryData.get(lemma);
          if (lemmaDictData) {
            dictData = lemmaDictData;
            break;
          }
        }
        
        // 如果本地没有，尝试通过 background script 查询映射表
        if (!dictData && isExtensionContextValid()) {
          chrome.runtime.sendMessage(
            { action: 'queryLemma', word: lowerWord },
            (response) => {
              if (response && response.success && response.lemma) {
                const lemma = response.lemma.toLowerCase();
                const lemmaDictData = wordDictionaryData.get(lemma);
                if (lemmaDictData) {
                  // 找到原形词的词典数据，更新 tooltip
                  if (currentTooltip && currentTooltipWord === word) {
                    const translation = currentTooltip.querySelector('.vocab-tooltip-translation')?.textContent || '';
                    removeTooltip();
                    // 使用原形词的词典数据重新创建 tooltip
                    const tempDictData = wordDictionaryData.get(lemma);
                    wordDictionaryData.set(lowerWord, tempDictData); // 缓存映射关系
                    showTooltip({ target: document.querySelector(`[data-word="${word}"]`) }, word, translation);
                  }
                }
              }
            }
          );
        }
      }
    
    // 获取音标
    let phoneticText = '';
    let phoneticAudio = '';
    if (dictData && dictData.phonetics && Array.isArray(dictData.phonetics) && dictData.phonetics.length > 0) {
      // 优先选择有音频的音标
      const phoneticWithAudio = dictData.phonetics.find(p => p && (p.audio || p.text));
      const phonetic = phoneticWithAudio || dictData.phonetics.find(p => p && p.text) || dictData.phonetics[0];
      
      if (phonetic) {
        if (phonetic.text && phonetic.text.trim()) {
          phoneticText = phonetic.text.trim();
        }
        if (phonetic.audio && phonetic.audio.trim()) {
          phoneticAudio = phonetic.audio.trim();
        }
      }
    }
    
    const tooltip = document.createElement('div');
    tooltip.className = 'vocab-tooltip';
    tooltip.setAttribute('data-word', word); // 标记tooltip对应的单词
    
    // 使用函数前面已有的 lowerWord
    const isSavedWord = savedWords.has(lowerWord);
    
    // 构建 tooltip HTML（外观与划句翻译悬浮窗统一）
    let tooltipHTML = '';
    tooltipHTML += `<div class="vocab-tooltip-header">`;
    tooltipHTML += `<span class="vocab-tooltip-word">${word}</span>`;
    tooltipHTML += `<div class="vocab-tooltip-actions">`;
    tooltipHTML += `<div class="vocab-tooltip-pronounce-buttons">`;
    tooltipHTML += `<button class="vocab-tooltip-pronounce" title="英音发音" data-word="${word}" data-type="1">🔊</button>`;
    tooltipHTML += `<button class="vocab-tooltip-pronounce" title="美音发音" data-word="${word}" data-type="2">🔊</button>`;
    tooltipHTML += `</div>`;
    tooltipHTML += `<button type="button" class="vocab-tooltip-readaloud" title="朗读（Edge 自然语音）" data-word="${word}">朗读</button>`;
    if (isSavedWord) {
      tooltipHTML += `<button class="vocab-tooltip-note-btn" title="添加/编辑备注" data-word="${word}">✎</button>`;
      tooltipHTML += `<button class="vocab-tooltip-delete" title="删除生词" data-word="${word}">×</button>`;
    }
    tooltipHTML += `</div></div>`;

    tooltipHTML += `<div class="vocab-tooltip-body">`;
    if (phoneticText) {
      tooltipHTML += `<div class="vocab-tooltip-phonetic">/${phoneticText}/</div>`;
    }
    tooltipHTML += `<div class="vocab-tooltip-translation">${String(translation || '').replace(/\\n/g, '；') || '暂无翻译'}</div>`;
    {
      const zhSrc = wordChineseSources.get(lowerWord)
        || (dictData && dictData.translationSource)
        || '';
      const zhLabel = chineseSourceLabel(zhSrc);
      if (zhLabel) {
        tooltipHTML += `<div class="vocab-tooltip-zh-source" style="font-size:11px;color:#888;margin-top:2px;">中文来源：${zhLabel}</div>`;
      }
    }
    if (wordNotes.get(lowerWord) && wordNotes.get(lowerWord).trim()) {
      const note = wordNotes.get(lowerWord);
      tooltipHTML += `<div class="vocab-tooltip-note">备注：${note.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
    }
    tooltipHTML += `</div>`;

    const sourceLabelMap = {
      deepseek: 'DeepSeek',
      wordsapi: 'WordsAPI',
      fd: 'Free Dictionary API',
      datamuse: 'Datamuse 词典',
      ecd: '离线英汉词典',
      api: '在线词典 API',
      gt: 'Google 翻译',
      bd: '百度翻译',
      mm: 'MyMemory 翻译',
      google: 'Google 音标',
      offline: '离线词典',
      local: '本地缓存',
      bing: 'Bing 翻译',
      youdao: '有道翻译',
      youdao_dict: '有道词典',
      d3325: '3325词典'
    };
    let sourceAbbr = null;
    if (dictData && dictData.sourceAbbr) {
      sourceAbbr = dictData.sourceAbbr;
    } else {
      try {
        sourceAbbr = wordSourceMap.get(lowerWord) || null;
      } catch (e) {
        sourceAbbr = null;
      }
    }
    const sourceParts = [];
    if (sourceAbbr) {
      sourceParts.push(`详情 ${sourceLabelMap[sourceAbbr] || sourceAbbr}`);
    }
    if (dictData && dictData.phonetics && dictData.phonetics.length) {
      const ph = dictData.phonetics.find((p) => p && p.text && p.source) || null;
      if (ph && ph.source && ph.source !== sourceAbbr) {
        sourceParts.push(`音标 ${sourceLabelMap[ph.source] || ph.source}`);
      }
    }
    if (sourceParts.length) {
      tooltipHTML += `<div class="vocab-tooltip-footer">来源：${sourceParts.join(' · ')}</div>`;
    }
    tooltipHTML += `<button type="button" class="vocab-tooltip-detail">查看详情</button>`;

    tooltip.innerHTML = tooltipHTML;
    
    const detailBtn = tooltip.querySelector('.vocab-tooltip-detail');
    if (detailBtn) {
      detailBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showPageWordDetail(word, translation);
      });
    }

    // 绑定发音按钮事件
    const pronounceBtns = tooltip.querySelectorAll('.vocab-tooltip-pronounce');
    pronounceBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wordToSpeak = e.target.getAttribute('data-word');
        const type = parseInt(e.target.getAttribute('data-type')) || 1; // 1=英音, 2=美音
        speakWord(wordToSpeak, type);
      });
    });

    const readAloudBtn = tooltip.querySelector('.vocab-tooltip-readaloud');
    if (readAloudBtn) {
      readAloudBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wordToSpeak = e.currentTarget.getAttribute('data-word') || word;
        speakWithEdgeVoice(wordToSpeak);
      });
    }
    
    // 绑定删除按钮事件（仅对已收藏生词）
    const deleteBtn = tooltip.querySelector('.vocab-tooltip-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const delWord = e.target.getAttribute('data-word') || word;
        await removeWord(delWord);
        removeTooltip();
      });
    }

    // 绑定备注按钮事件（仅对已收藏生词）——悬浮窗编辑
    const noteBtn = tooltip.querySelector('.vocab-tooltip-note-btn');
    if (noteBtn) {
      noteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const noteWord = e.target.getAttribute('data-word') || word;
        const lower = noteWord.toLowerCase();
        const currentNote = wordNotes.get(lower) || '';
        const newNote = await showVocabNoteDialog(noteWord, currentNote);
        if (newNote === null) {
          return; // 用户取消
        }
        const finalNote = String(newNote).trim();
        if (finalNote) {
          wordNotes.set(lower, finalNote);
        } else {
          wordNotes.delete(lower);
        }

        const currentUserId = await getCurrentUserId();
        const userKey = `user_${currentUserId}_`;
        const userData = {};
        userData[`${userKey}savedWords`] = Array.from(savedWords);
        userData[`${userKey}wordTranslations`] = Array.from(wordTranslations.entries());
        userData[`${userKey}wordDictionaryData`] = Array.from(wordDictionaryData.entries());
        userData[`${userKey}wordChineseTranslations`] = Array.from(wordChineseTranslations.entries());
        appendChineseSourcesToPayload(userData, userKey);
        userData[`${userKey}wordStatus`] = Array.from(wordStatus.entries());
        userData[`${userKey}wordNotes`] = Array.from(wordNotes.entries());

        noteLocalVocabWrite();
        chrome.storage.local.set(userData, () => {
          let noteEl = tooltip.querySelector('.vocab-tooltip-note');
          if (finalNote) {
            const safeNote = finalNote.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            if (!noteEl) {
              noteEl = document.createElement('div');
              noteEl.className = 'vocab-tooltip-note';
              tooltip.appendChild(noteEl);
            }
            noteEl.innerHTML = `备注: ${safeNote}`;
          } else if (noteEl) {
            noteEl.remove();
          }
        });
      });
    }
    
    // 挂到 <html> 下（与详情/划句弹窗一致）：Bing 的广告拦截脚本会删掉 body 里新插入、class 不以 b_ 开头的 DIV
    document.documentElement.appendChild(tooltip);
    currentTooltip = tooltip;
    currentTooltipWord = word;
    return tooltip;
  }

  // 显示悬停提示（使用 Promise，而不是 async/await，避免某些环境的解析问题）
  var showTooltip = function(event, word, translation) {
    // 如果已经有相同单词的tooltip，只更新位置
    if (currentTooltip && currentTooltipWord === word) {
      var rect = event.target.getBoundingClientRect();
      var tooltipRect = currentTooltip.getBoundingClientRect();
      // 计算位置，减少间隙，让鼠标更容易移动到 tooltip
      currentTooltip.style.left = rect.left + 'px';
      currentTooltip.style.top = (rect.top - tooltipRect.height - 3) + 'px'; // 减少间隙到 3px
      return Promise.resolve(currentTooltip);
    }
    
    return createTooltip(word, translation).then((tooltip) => {
      var rect = event.target.getBoundingClientRect();
      // 计算位置，减少间隙，让鼠标更容易移动到 tooltip
      tooltip.style.left = rect.left + 'px';
      tooltip.style.top = (rect.top - tooltip.offsetHeight - 3) + 'px'; // 减少间隙到 3px
      
      // 确保提示框不超出视窗
      setTimeout(() => {
        var tooltipRect = tooltip.getBoundingClientRect();
        if (tooltipRect.left < 0) {
          tooltip.style.left = '10px';
        }
        if (tooltipRect.top < 0) {
          // 如果上方空间不够，显示在下方
          tooltip.style.top = (rect.bottom + 3) + 'px'; // 减少间隙到 3px
        }
        if (tooltipRect.right > window.innerWidth) {
          tooltip.style.left = (window.innerWidth - tooltipRect.width - 10) + 'px';
        }
      }, 0);
      
      return tooltip;
    });
  };

  function escapeDetailHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 有道例句常含 <b>word</b>；直接转义会显示成「源码」
  function stripHtmlToPlainText(input) {
    if (input == null) return '';
    if (Array.isArray(input)) {
      return input.map((x) => stripHtmlToPlainText(x)).filter(Boolean).join(' ');
    }
    if (typeof input === 'object') {
      if (input.example != null) return stripHtmlToPlainText(input.example);
      if (input.text != null) return stripHtmlToPlainText(input.text);
      return '';
    }
    const s = String(input);
    if (!s) return '';
    if (!/[<&]/.test(s)) return s;
    try {
      const doc = new DOMParser().parseFromString(`<div>${s}</div>`, 'text/html');
      return String((doc.body && doc.body.textContent) || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch (e) {
      return s
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  function escapeDisplayText(text) {
    return escapeDetailHtml(stripHtmlToPlainText(text));
  }

  // 保留有道等来源的 <b>/<strong> 加粗；无标签时回退为高亮当前词
  function formatExampleHtml(raw, highlightWord) {
    const s = String(raw == null ? '' : raw);
    if (!s) return '';

    const segments = [];
    const boldRe = /<(b|strong)>([\s\S]*?)<\/\1>/gi;
    let last = 0;
    let match;
    let hasBold = false;
    while ((match = boldRe.exec(s)) !== null) {
      hasBold = true;
      if (match.index > last) {
        segments.push({ text: stripHtmlToPlainText(s.slice(last, match.index)), hl: false });
      }
      segments.push({ text: stripHtmlToPlainText(match[2]), hl: true });
      last = match.index + match[0].length;
    }

    if (!hasBold) {
      const plain = stripHtmlToPlainText(s);
      const hw = String(highlightWord || '').trim();
      if (hw) {
        const re = new RegExp(`(\\b${hw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b)`, 'gi');
        let i = 0;
        let m;
        while ((m = re.exec(plain)) !== null) {
          if (m.index > i) segments.push({ text: plain.slice(i, m.index), hl: false });
          segments.push({ text: m[1], hl: true });
          i = m.index + m[1].length;
        }
        if (i < plain.length) segments.push({ text: plain.slice(i), hl: false });
      }
      if (!segments.length) segments.push({ text: plain, hl: false });
    } else if (last < s.length) {
      segments.push({ text: stripHtmlToPlainText(s.slice(last)), hl: false });
    }

    return segments.map((seg) => {
      const t = escapeDetailHtml(seg.text);
      return seg.hl ? `<span class="word-ex-hl">${t}</span>` : t;
    }).join('');
  }

  function renderPageWordDetailBody(word, dictData, fallbackTranslation, loading) {
    const lower = String(word || '').toLowerCase();
    const zhMeanings = extractZhMeanings(dictData);
    const enMeanings = englishOnlyMeanings(dictData && dictData.meanings);
    const translation = (dictData && dictData.translation) || fallbackTranslation || '';
    const phonetic = (dictData && dictData.phonetics || []).find((p) => p && p.text);
    const phoneticText = phonetic && phonetic.text ? String(phonetic.text).trim() : '';
    const zhSrc = (dictData && (dictData.translationSource || dictData.zhSourceAbbr))
      || wordChineseSources.get(lower)
      || '';
    const zhLabel = chineseSourceLabel(zhSrc);
    const enSrc = (dictData && (dictData.enSourceAbbr || dictData.sourceAbbr)) || '';
    const enLabel = chineseSourceLabel(enSrc) || (enSrc === 'fd' ? 'Free Dictionary' : (enSrc === 'datamuse' ? 'Datamuse' : ''));
    const note = wordNotes.get(lower) || '';

    let html = `<div class="vocab-word-detail-phonetic">`;
    html += phoneticText
      ? `<span>/${escapeDetailHtml(phoneticText)}/</span>`
      : `<span class="muted">暂无音标</span>`;
    html += `<button type="button" class="vocab-word-detail-speak" data-type="1">英</button>`;
    html += `<button type="button" class="vocab-word-detail-speak" data-type="2">美</button>`;
    html += `</div>`;

    if (dictData && dictData.usage) {
      html += `<div class="vocab-word-detail-usage">用法：${escapeDisplayText(dictData.usage)}</div>`;
    }

    html += `<div class="vocab-word-detail-section">中文释义${zhLabel ? ` · ${escapeDetailHtml(zhLabel)}` : ''}</div>`;
    if (zhMeanings.length) {
      zhMeanings.forEach((meaning) => {
        if (meaning.partOfSpeech) {
          html += `<div class="vocab-word-detail-pos">${escapeDetailHtml(meaning.partOfSpeech)}</div>`;
        }
        (meaning.definitions || []).slice(0, 6).forEach((def, index) => {
          html += `<div class="vocab-word-detail-def">${index + 1}. ${escapeDisplayText(def.definition || '')}</div>`;
          if (def.example) {
            html += `<div class="vocab-word-detail-example">${formatExampleHtml(def.example, word)}</div>`;
          }
        });
      });
    } else if (translation) {
      html += `<div class="vocab-word-detail-def">${escapeDisplayText(translation)}</div>`;
    } else {
      html += `<div class="vocab-word-detail-empty">暂无中文释义</div>`;
    }

    html += `<div class="vocab-word-detail-section">英英释义${enLabel ? ` · ${escapeDetailHtml(enLabel)}` : ''}</div>`;
    if (enMeanings.length) {
      enMeanings.forEach((meaning) => {
        if (meaning.partOfSpeech) {
          html += `<div class="vocab-word-detail-pos">${escapeDetailHtml(meaning.partOfSpeech)}</div>`;
        }
        (meaning.definitions || []).slice(0, 3).forEach((def, index) => {
          html += `<div class="vocab-word-detail-def">${index + 1}. ${escapeDisplayText(def.definition || '')}</div>`;
          if (def.example) {
            html += `<div class="vocab-word-detail-example">${formatExampleHtml(def.example, word)}</div>`;
          }
        });
      });
    } else if (loading) {
      html += `<div class="vocab-word-detail-empty">正在补全详情...</div>`;
    } else {
      html += `<div class="vocab-word-detail-empty">暂无英文释义</div>`;
    }

    if (note && String(note).trim()) {
      html += `<div class="vocab-word-detail-note">备注：${escapeDisplayText(note)}</div>`;
    }
    return html;
  }

  const pageDetailHistory = [];
  let pageDetailCurrent = null;
  let pageDetailOverlay = null;
  let pageDetailRequestId = 0;
  let pageDetailExploreBusy = false;

  function updatePageDetailBackBtn() {
    if (!pageDetailOverlay) return;
    const backBtn = pageDetailOverlay.querySelector('.vocab-word-detail-back');
    if (!backBtn) return;
    const canBack = pageDetailHistory.length > 0;
    backBtn.hidden = !canBack;
    backBtn.disabled = !canBack;
  }

  function closePageWordDetail() {
    if (pageDetailOverlay && pageDetailOverlay.parentNode) {
      pageDetailOverlay.remove();
    }
    document.removeEventListener('keydown', onPageDetailKeydown, true);
    pageDetailOverlay = null;
    pageDetailHistory.length = 0;
    pageDetailCurrent = null;
    pageDetailRequestId += 1;
  }

  function onPageDetailKeydown(e) {
    if (e.key === 'Escape') closePageWordDetail();
  }

  function paintPageWordDetail(word, fallbackTranslation, dictData, loading) {
    if (!pageDetailOverlay) return;
    const titleEl = pageDetailOverlay.querySelector('.vocab-word-detail-title');
    const bodyEl = pageDetailOverlay.querySelector('.vocab-word-detail-body');
    if (titleEl) titleEl.textContent = word;
    if (!bodyEl) return;
    bodyEl.innerHTML = renderPageWordDetailBody(word, dictData, fallbackTranslation, loading);
    bodyEl.querySelectorAll('.vocab-word-detail-speak').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const type = parseInt(btn.getAttribute('data-type'), 10) || 2;
        speakWord(word, type);
      });
    });
    updatePageDetailBackBtn();
  }

  function ensurePageWordDetailOverlay() {
    if (pageDetailOverlay && pageDetailOverlay.isConnected) return pageDetailOverlay;

    removeTooltip();
    const overlay = document.createElement('div');
    overlay.className = 'vocab-word-detail-overlay';
    overlay.innerHTML = `
      <div class="vocab-word-detail-dialog" role="dialog" aria-modal="true">
        <div class="vocab-word-detail-header">
          <div class="vocab-word-detail-header-left">
            <button type="button" class="vocab-word-detail-back" title="返回上一词" aria-label="返回上一词" hidden>←</button>
            <span class="vocab-word-detail-title"></span>
          </div>
          <button type="button" class="vocab-word-detail-close" title="关闭">×</button>
        </div>
        <div class="vocab-word-detail-body"></div>
      </div>
    `;
    const closeBtn = overlay.querySelector('.vocab-word-detail-close');
    const backBtn = overlay.querySelector('.vocab-word-detail-back');

    closeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closePageWordDetail();
    });
    backBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!pageDetailHistory.length) return;
      const prev = pageDetailHistory.pop();
      updatePageDetailBackBtn();
      if (!prev || !prev.word) return;
      showPageWordDetail(prev.word, prev.translation || '', { skipHistory: true });
    });
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) closePageWordDetail();
    });

    // 详情内双击生词：加入生词本并切换到该词详情
    overlay.addEventListener('dblclick', async (ev) => {
      ev.stopPropagation();
      if (pageDetailExploreBusy) return;
      if (ev.target.closest('.vocab-word-detail-close, .vocab-word-detail-back, .vocab-word-detail-speak, button, a, input, textarea')) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const currentWord = pageDetailCurrent && pageDetailCurrent.word
        ? String(pageDetailCurrent.word)
        : '';
      pageDetailExploreBusy = true;
      try {
        const result = await handleWordSelectionAndSave(ev);
        if (!result || !result.word) return;
        const next = String(result.word || '').trim();
        if (!next) return;
        if (currentWord && next.toLowerCase() === currentWord.toLowerCase()) return;
        showPageWordDetail(next, result.translation || '');
      } finally {
        pageDetailExploreBusy = false;
      }
    });

    document.addEventListener('keydown', onPageDetailKeydown, true);
    document.documentElement.appendChild(overlay);
    pageDetailOverlay = overlay;
    return overlay;
  }

  function showPageWordDetail(word, fallbackTranslation, options) {
    const opts = options || {};
    const cleanWord = String(word || '').trim();
    if (!cleanWord) return;

    const hadOverlay = !!(pageDetailOverlay && pageDetailOverlay.isConnected);
    if (!opts.skipHistory) {
      if (hadOverlay && pageDetailCurrent) {
        const prevLower = String(pageDetailCurrent.word || '').toLowerCase();
        if (prevLower && prevLower !== cleanWord.toLowerCase()) {
          pageDetailHistory.push({
            word: pageDetailCurrent.word,
            translation: pageDetailCurrent.translation || ''
          });
        }
      } else if (!hadOverlay) {
        pageDetailHistory.length = 0;
      }
    }

    pageDetailCurrent = {
      word: cleanWord,
      translation: fallbackTranslation || ''
    };

    ensurePageWordDetailOverlay();
    updatePageDetailBackBtn();
    removeTooltip();

    const requestId = ++pageDetailRequestId;
    const lower = cleanWord.toLowerCase();
    let dictData = wordDictionaryData.get(lower) || null;
    const needsFetch = !isLookupSettled(dictData);
    paintPageWordDetail(cleanWord, fallbackTranslation, dictData, needsFetch);

    if (!needsFetch) return;

    fetchDictionaryInfo(cleanWord).then((fetched) => {
      if (requestId !== pageDetailRequestId) return;
      if (!pageDetailOverlay || !pageDetailOverlay.isConnected) return;
      const latest = fetched || wordDictionaryData.get(lower) || dictData;
      paintPageWordDetail(cleanWord, fallbackTranslation, latest, false);
    }).catch(() => {
      if (requestId !== pageDetailRequestId) return;
      if (!pageDetailOverlay || !pageDetailOverlay.isConnected) return;
      paintPageWordDetail(cleanWord, fallbackTranslation, wordDictionaryData.get(lower) || dictData, false);
    });
  }

  // 网页内备注悬浮窗（替代 prompt）
  function showVocabNoteDialog(noteWord, currentNote) {
    return new Promise((resolve) => {
      const existing = document.querySelector('.vocab-note-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.className = 'vocab-note-overlay';
      overlay.innerHTML = `
        <div class="vocab-note-dialog" role="dialog" aria-modal="true">
          <div class="vocab-note-header">编辑备注 · ${String(noteWord || '').replace(/</g, '&lt;')}</div>
          <div class="vocab-note-body">
            <div class="vocab-note-hint">留空并确定可删除备注</div>
            <textarea class="vocab-note-textarea"></textarea>
          </div>
          <div class="vocab-note-actions">
            <button type="button" class="vocab-note-btn cancel">取消</button>
            <button type="button" class="vocab-note-btn ok">确定</button>
          </div>
        </div>
      `;
      const textarea = overlay.querySelector('.vocab-note-textarea');
      const okBtn = overlay.querySelector('.vocab-note-btn.ok');
      const cancelBtn = overlay.querySelector('.vocab-note-btn.cancel');
      textarea.value = currentNote || '';

      const finish = (value) => {
        overlay.remove();
        resolve(value);
      };
      okBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        finish(textarea.value);
      });
      cancelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        finish(null);
      });
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) finish(null);
      });
      // 挂到 <html> 下（与详情/划句弹窗一致）：Bing 的广告拦截脚本会删掉 body 里新插入、class 不以 b_ 开头的 DIV
      document.documentElement.appendChild(overlay);
      setTimeout(() => textarea.focus(), 0);
    });
  }

  // 移除tooltip
  function removeTooltip() {
    if (currentTooltip) {
      currentTooltip.remove();
      currentTooltip = null;
      currentTooltipWord = null;
    }
    if (tooltipTimeout) {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = null;
    }
    if (tooltipRemoveTimeout) {
      clearTimeout(tooltipRemoveTimeout);
      tooltipRemoveTimeout = null;
    }
  }

  // 这些区域绝不能插入标记：否则 textarea/code 会把 HTML 当纯文本显示成「源码」，
  // contenteditable 里替换节点还会把光标打回开头。
  const MARK_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED',
    'CANVAS', 'HEAD', 'TITLE', 'META', 'LINK', 'TEMPLATE', 'XMP', 'PLAINTEXT'
  ]);

  function isOurVocabUiElement(el) {
    if (!el || !el.classList) return false;
    // 不含 vocab-word-marker：它是正文里的合法标记，只在 walker 里单独跳过其子文本
    return el.classList.contains('vocab-tooltip') ||
      el.classList.contains('vocab-sentence-popup') ||
      el.classList.contains('vocab-sentence-btn') ||
      el.classList.contains('vocab-chunk-btn') ||
      el.classList.contains('vocab-readaloud-btn') ||
      el.classList.contains('vocab-popup-full') ||
      el.classList.contains('vocab-translation-popup') ||
      el.classList.contains('vocab-word-detail-overlay') ||
      el.classList.contains('vocab-note-overlay') ||
      el.id === 'vocab-toast';
  }

  function isInsideOurVocabUi(el) {
    for (let cur = el; cur && cur.nodeType === 1; cur = wnParentAcrossShadow(cur)) {
      if (isOurVocabUiElement(cur)) return true;
    }
    return false;
  }

  function isMarkSkipHost(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (MARK_SKIP_TAGS.has(tag)) return true;
    if (el.isContentEditable) return true;
    const ce = el.getAttribute && el.getAttribute('contenteditable');
    if (ce === 'true' || ce === '') return true;
    if (el.getAttribute && (el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox')) {
      // 只有真正可编辑才跳过：新版 Gmail 用只读的 div[role=textbox] 包住邮件正文。
      // 可编辑的 contenteditable 上面已处理；这里再兜住「内含隐藏输入框」的自绘编辑器/下拉框。
      if (el.querySelector && el.querySelector('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
        return true;
      }
    }
    if (el.classList) {
      if (
        el.classList.contains('monaco-editor') ||
        el.classList.contains('CodeMirror') ||
        el.classList.contains('cm-editor') ||
        el.classList.contains('ace_editor') ||
        el.classList.contains('ql-editor') ||
        el.classList.contains('ProseMirror')
      ) {
        return true;
      }
    }
    return isOurVocabUiElement(el);
  }

  // 向上找父元素；到 shadowRoot 顶部时跳到宿主元素（host），这样宿主外的跳过区也能生效
  function wnParentAcrossShadow(node) {
    if (!node) return null;
    if (node.nodeType === 11) return node.host || null;
    if (node.parentElement) return node.parentElement;
    const p = node.parentNode;
    return (p && p.nodeType === 11 && p.host) ? p.host : null;
  }

  function isInsideMarkSkipZone(node) {
    let el = node;
    if (el && el.nodeType === 3) el = wnParentAcrossShadow(el);
    while (el && el !== document.documentElement) {
      if (el.classList && el.classList.contains('vocab-word-marker')) {
        // 已在标记内：对「是否可再标记」视为跳过；对「标记是否误入输入区」要看祖先
        el = wnParentAcrossShadow(el);
        continue;
      }
      if (isMarkSkipHost(el)) return true;
      el = wnParentAcrossShadow(el);
    }
    return false;
  }

  function unwrapMarker(marker) {
    const parent = marker && marker.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(marker.textContent || ''), marker);
    if (parent.normalize) parent.normalize();
  }

  function createWordMarkerSpan(word, translation, status) {
    const span = document.createElement('span');
    const statusClass = status === 'mastered' ? 'vocab-word-mastered' : 'vocab-word-new';
    span.className = 'vocab-word-marker ' + statusClass;
    span.setAttribute('data-word', word);
    span.setAttribute('data-translation', translation || '');
    span.setAttribute('data-status', status || 'new');
    span.textContent = word;
    return span;
  }

  // 用 DOM 节点拆分文本，避免 innerHTML 把页面弄成「源码」
  // skipChecker: 可选，单次扫描内复用跳过区判断缓存
  function wrapSavedWordsInTextNode(textNode, skipChecker) {
    const isSkip = skipChecker || isInsideMarkSkipZone;
    if (!textNode || !textNode.parentNode || isSkip(textNode)) return;
    const text = textNode.textContent;
    if (!text || !/[a-zA-Z]/.test(text)) return;

    // 快速路径：整段文本里没有任何已收藏词，避免无意义拆分
    let hasHit = false;
    const probe = /[a-zA-Z][a-zA-Z'-]*/g;
    let probeMatch;
    while ((probeMatch = probe.exec(text)) !== null) {
      const w = probeMatch[0];
      if (w.length >= 2 && savedWords.has(w.toLowerCase())) {
        hasHit = true;
        break;
      }
    }
    if (!hasHit) return;

    const re = /[a-zA-Z][a-zA-Z'-]*/g;
    let match;
    let lastIndex = 0;
    const fragment = document.createDocumentFragment();

    while ((match = re.exec(text)) !== null) {
      const word = match[0];
      const start = match.index;
      if (start > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
      }
      const lowerWord = word.toLowerCase();
      if (savedWords.has(lowerWord) && word.length >= 2) {
        fragment.appendChild(createWordMarkerSpan(
          word,
          wordTranslations.get(lowerWord) || '',
          wordStatus.get(lowerWord) || 'new'
        ));
      } else {
        fragment.appendChild(document.createTextNode(word));
      }
      lastIndex = start + word.length;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    try {
      const parentNode = textNode.parentNode;
      parentNode.replaceChild(fragment, textNode);
      // 标记落在 shadowRoot 里时，页面级 content.css 管不到，需要把样式注入该 shadowRoot
      const rootNode = parentNode.getRootNode ? parentNode.getRootNode() : null;
      if (rootNode && rootNode.nodeType === 11 && rootNode.host) ensureShadowMarkerStyle(rootNode);
    } catch (e) {
      // 页面可能在并发改 DOM，忽略单次失败
    }
  }

  function createSkipZoneChecker() {
    // 与 isInsideMarkSkipZone 规则相同，但祖先结果也缓存，长页面不再对每个文本节点重复爬整条祖先链
    const cache = new WeakMap();
    const check = (el) => {
      if (!el || el === document.documentElement) return false;
      if (cache.has(el)) return cache.get(el);
      let result;
      if (el.classList && el.classList.contains('vocab-word-marker')) {
        result = check(wnParentAcrossShadow(el));
      } else {
        result = isMarkSkipHost(el) ? true : check(wnParentAcrossShadow(el));
      }
      cache.set(el, result);
      return result;
    };
    return function isSkipCached(node) {
      let el = node;
      if (el && el.nodeType === 3) el = el.parentElement;
      if (!el) return false;
      return check(el);
    };
  }

  // ===== Shadow DOM 支持 =====
  // MSN 等用 Web Components 的站点，正文在自定义元素的 open shadowRoot 里：
  // document.body 上的 TreeWalker / MutationObserver / 页面级 CSS 都进不去，需要单独处理。
  // （closed shadowRoot 拿不到，无法支持。）
  const knownShadowRoots = new Set();
  // 悬停处理函数（在下方 mouseover 处定义后赋值）。
  // 鼠标在同一个 shadowRoot 内移动（正文文字 → 标记词）时，target 和 relatedTarget 重定向后
  // 都是同一个宿主，浏览器不会把 mouseover 派发到 document，所以必须在 shadowRoot 上也监听。
  let wnShadowHoverHandler = null;
  // 与 content.css 中标记样式一致；html[data-wn-mark] 改写为 :host-context(...)
  const WN_SHADOW_MARKER_CSS = `
.vocab-word-marker {
  cursor: help;
  position: relative;
  padding: 0 2px;
  border-radius: 3px;
  transition: background-color 0.2s;
  font-weight: 500;
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
  text-decoration-color: var(--wn-mark-color, #FF6B35);
  background-color: color-mix(in srgb, var(--wn-mark-color, #FF6B35) 14%, transparent);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.vocab-word-new { --wn-mark-color: var(--wn-mark-new, #FF6B35); }
.vocab-word-mastered { --wn-mark-color: var(--wn-mark-mastered, #4CAF50); }
.vocab-word-marker:hover { background-color: color-mix(in srgb, var(--wn-mark-color, #FF6B35) 24%, transparent); }
:host-context(html[data-wn-mark="solid"]) .vocab-word-marker { text-decoration-style: solid; }
:host-context(html[data-wn-mark="dashed"]) .vocab-word-marker { text-decoration-style: dashed; }
:host-context(html[data-wn-mark="dotted"]) .vocab-word-marker { text-decoration-style: dotted; }
:host-context(html[data-wn-mark="wavy"]) .vocab-word-marker { text-decoration-style: wavy; }
:host-context(html[data-wn-mark="highlight"]) .vocab-word-marker {
  text-decoration: none;
  background-color: color-mix(in srgb, var(--wn-mark-color, #FF6B35) 48%, transparent);
}
:host-context(html[data-wn-mark="highlight"]) .vocab-word-marker:hover {
  background-color: color-mix(in srgb, var(--wn-mark-color, #FF6B35) 64%, transparent);
}
`;

  function ensureShadowMarkerStyle(shadowRoot) {
    try {
      if (!shadowRoot || shadowRoot.querySelector('style[data-wordnest-style]')) return;
      const style = document.createElement('style');
      style.setAttribute('data-wordnest-style', '');
      style.textContent = WN_SHADOW_MARKER_CSS;
      shadowRoot.appendChild(style);
    } catch (e) {}
  }

  // 遍历 scope（Element / ShadowRoot）下所有 open shadowRoot（含嵌套），跳过输入区等跳过区
  function forEachOpenShadowRoot(scope, callback) {
    if (!scope) return;
    const handle = (sr) => {
      callback(sr);
      walkIn(sr);
    };
    const walkIn = (container) => {
      const tw = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (el) => (isMarkSkipHost(el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
      });
      let el;
      while ((el = tw.nextNode())) {
        if (el.shadowRoot) handle(el.shadowRoot);
      }
    };
    if (scope.nodeType === 1 && scope.shadowRoot && !isMarkSkipHost(scope)) handle(scope.shadowRoot);
    walkIn(scope);
  }

  function trackShadowRoot(shadowRoot) {
    if (!shadowRoot || knownShadowRoots.has(shadowRoot)) return;
    knownShadowRoots.add(shadowRoot);
    if (wnShadowHoverHandler) shadowRoot.addEventListener('mouseover', wnShadowHoverHandler);
    // 标记过程中 observer 处于断开状态，结束时 reconnectObserver 会统一接上
    if (!isMarking && observer) {
      try { observer.observe(shadowRoot, { childList: true, subtree: true }); } catch (e) {}
    }
  }

  // 替代原来的 observer.observe(document.body)：同时观察已知的 shadowRoot
  function reconnectObserver() {
    if (!observer || !document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    knownShadowRoots.forEach((sr) => {
      if (!sr.host || !sr.host.isConnected) {
        knownShadowRoots.delete(sr);
        return;
      }
      try { observer.observe(sr, { childList: true, subtree: true }); } catch (e) {}
    });
  }

  // document + 已知 shadowRoot 里的 querySelectorAll
  function querySelectorAllDeep(selector) {
    const out = Array.from(document.querySelectorAll(selector));
    knownShadowRoots.forEach((sr) => {
      try { out.push(...sr.querySelectorAll(selector)); } catch (e) {}
    });
    return out;
  }

  // 兜底：自定义元素升级较晚、挂 shadowRoot 时不一定有 childList 变化，补扫几次新出现的 shadowRoot
  function scanNewShadowRoots() {
    if (isMarking || !isLoaded || savedWords.size === 0 || !document.body) return;
    const fresh = [];
    forEachOpenShadowRoot(document.body, (sr) => {
      if (!knownShadowRoots.has(sr)) fresh.push(sr);
    });
    if (!fresh.length) return;
    isMarking = true;
    if (observer) observer.disconnect();
    try {
      const skipChecker = createSkipZoneChecker();
      fresh.forEach((sr) => {
        trackShadowRoot(sr);
        markSavedWordsInRoot(sr, { skipChecker, skipCleanup: true, noShadow: true });
      });
    } catch (e) {
      console.error('shadowRoot 标记出错:', e);
    } finally {
      isMarking = false;
      reconnectObserver();
    }
  }

  // root 限定时可只扫局部（动态插入内容），全页时传 document.body
  function markSavedWordsInRoot(root, options) {
    const opts = options || {};
    if (!root || !isLoaded || savedWords.size === 0) return;
    const skipChecker = opts.skipChecker || createSkipZoneChecker();
    const scope = (root.nodeType === 1 || root.nodeType === 11) ? root : (root.parentElement || document.body);
    if (!scope) return;

    if (!opts.skipCleanup) {
      const markers = scope.querySelectorAll
        ? scope.querySelectorAll('.vocab-word-marker')
        : [];
      markers.forEach((marker) => {
        if (skipChecker(marker.parentNode)) {
          unwrapMarker(marker);
          return;
        }
        const word = marker.getAttribute('data-word');
        const translation = marker.getAttribute('data-translation');
        const status = marker.getAttribute('data-status');
        const lowerWord = word ? word.toLowerCase() : '';
        if (savedWords.has(lowerWord)) {
          const storedTranslation = wordTranslations.get(lowerWord) || '';
          const storedStatus = wordStatus.get(lowerWord) || 'new';
          if (translation === storedTranslation && status === storedStatus) {
            return;
          }
        }
        unwrapMarker(marker);
      });
    }

    const walker = document.createTreeWalker(
      scope,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          if (!node.parentNode) return NodeFilter.FILTER_REJECT;
          if (node.parentElement && node.parentElement.classList &&
              node.parentElement.classList.contains('vocab-word-marker')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (skipChecker(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }
    textNodes.forEach((textNode) => wrapSavedWordsInTextNode(textNode, skipChecker));

    // 再处理 scope 内（含嵌套）的 open shadowRoot，并开始观察它们的动态变化
    if (!opts.noShadow) {
      forEachOpenShadowRoot(scope, (sr) => {
        trackShadowRoot(sr);
        markSavedWordsInRoot(sr, Object.assign({}, opts, { skipChecker, noShadow: true }));
      });
    }
  }

  // 优先只标记选区附近，避免每次收藏都整页 TreeWalker
  function getMarkScope(el) {
    if (!el || el.nodeType !== 1) return null;
    const tight = el.closest('p, li, td, th, h1, h2, h3, h4, h5, h6, figcaption, blockquote, label, dt, dd');
    if (tight && tight !== document.body && tight !== document.documentElement) return tight;

    // Div soup (job boards, React apps): don't remake a giant ancestor on the hot path
    const LIMIT = 400;
    let best = el;
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.nodeType === 1) {
        const count = node.getElementsByTagName('*').length;
        if (count > LIMIT) break;
        best = node;
      }
      node = node.parentElement;
    }
    return best;
  }

  function markNearSelectionOrFull() {
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const node = sel.getRangeAt(0).commonAncestorContainer;
        const el = node && node.nodeType === 3 ? node.parentElement : node;
        if (el && el.nodeType === 1 && document.body.contains(el) && !isInsideMarkSkipZone(el)) {
          // 优先局限在段落；避免 closest('div') 选中整页容器
          const scope = getMarkScope(el) || el;
          if (scope && scope !== document.body && scope !== document.documentElement) {
            if (isMarking) return;
            isMarking = true;
            if (observer) observer.disconnect();
            try {
              markSavedWordsInRoot(scope, { skipCleanup: false });
            } finally {
              isMarking = false;
              if (observer && document.body) {
                reconnectObserver();
              }
            }
            // 后台再补一次全页，不阻塞交互
            setTimeout(() => {
              if (!isMarking) markSavedWords();
            }, 1200);
            return;
          }
        }
      }
    } catch (e) {}
    markSavedWords();
  }

  // 标记已保存的单词（整页）
  function markSavedWords() {
    if (isMarking || !isLoaded) return;
    if (savedWords.size === 0) {
      // 删掉最后一个生词时也要清掉页面上残留的划线
      querySelectorAllDeep('.vocab-word-marker').forEach(unwrapMarker);
      return;
    }
    if (!document.body) return;

    // 用户正在输入/编辑区时不要动整页 DOM，避免光标跳到开头
    // 焦点在我们自己的弹窗里（如刚点了悬浮窗的「删除」按钮）不算，否则删词/收词后划线不刷新
    const active = document.activeElement;
    if (active && active !== document.body && isInsideMarkSkipZone(active) && !isInsideOurVocabUi(active)) {
      return;
    }
    
    isMarking = true;
    
    // 暂时禁用 MutationObserver，避免循环触发
    if (observer) {
      observer.disconnect();
    }
    
    // 保存当前悬停的元素信息，以便重新标记后恢复
    let savedHoverInfo = null;
    if (hoveredElement && hoveredElement.classList.contains('vocab-word-marker')) {
      savedHoverInfo = {
        word: hoveredElement.getAttribute('data-word'),
        translation: hoveredElement.getAttribute('data-translation')
      };
    }
    
    try {
      markSavedWordsInRoot(document.body);
    } catch (error) {
      console.error('标记单词时出错:', error);
    } finally {
      isMarking = false;
      
      // 重新连接 MutationObserver
      if (observer && document.body) {
        reconnectObserver();
      }
      
      // 恢复悬停状态（如果之前有）
      if (savedHoverInfo) {
        // 查找新创建的标记元素
        const newMarker = document.querySelector(`.vocab-word-marker[data-word="${savedHoverInfo.word}"]`);
        if (newMarker) {
          hoveredElement = newMarker;
        }
      }
    }
  }

  // 使用百度翻译API：通过 background 发送消息，避免 CORS
  async function translateWordWithBaiduSimple(word) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: 'baiduTranslate', word },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('发送百度翻译消息失败:', chrome.runtime.lastError);
              resolve(null);
              return;
            }
            if (response && response.success && response.translation) {
              resolve(response.translation);
            } else {
              // 返回 null，让上层按照引擎顺序继续尝试其他翻译源
              resolve(null);
            }
          }
        );
      } catch (error) {
        console.error('调用百度翻译失败:', error);
        resolve(null);
      }
    });
  }

  function showVocabToast(message, kind) {
    try {
      const old = document.getElementById('vocab-toast');
      if (old) old.remove();
      const el = document.createElement('div');
      el.id = 'vocab-toast';
      el.textContent = String(message || '');
      el.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:28px',
        'transform:translateX(-50%)',
        'z-index:2147483647',
        'max-width:min(420px,calc(100vw - 24px))',
        'padding:10px 14px',
        'border-radius:10px',
        'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
        'box-shadow:0 8px 24px rgba(0,0,0,.22)',
        'color:#fff',
        kind === 'error' ? 'background:#c62828' : (kind === 'ok' ? 'background:#2e7d32' : 'background:#334155')
      ].join(';');
      document.documentElement.appendChild(el);
      setTimeout(() => {
        try { el.remove(); } catch (e) {}
      }, 3200);
    } catch (e) {}
  }

  function cleanSelectedWordNoise(raw) {
    return String(raw || '')
      .replace(/[\u00AD\u200B-\u200D\uFEFF\u2060\u180E]/g, '')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[–—]/g, '-');
  }

  function validateVocabWordRemote(word) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'validateVocabWord', word }, (res) => {
          if (chrome.runtime.lastError || !res) {
            // 通道失败时放行，避免把真词误判成无效
            resolve({
              ok: true,
              reason: 'validate_failed',
              word: String(word || '').toLowerCase(),
              original: String(word || ''),
              corrected: false,
              suggestions: []
            });
            return;
          }
          resolve(res);
        });
      } catch (e) {
        resolve({
          ok: true,
          reason: 'validate_failed',
          word: String(word || '').toLowerCase(),
          original: String(word || ''),
          corrected: false,
          suggestions: []
        });
      }
    });
  }

  // 将“双击选词并保存”的逻辑抽成函数，方便复用（双击 / Ctrl+划词 / 详情内探词）
  // 返回 { word, translation, alreadySaved } 或 null
  async function handleWordSelectionAndSave(triggerEvent) {
    // 确保数据已加载
    if (!isLoaded) {
      await loadWords();
    }

    const selection = window.getSelection();
    let rawText = selection.toString();
    if (!rawText) {
      return null;
    }

    // 去掉软连字符/零宽字符（Gemmi 等文档站双击常会带上）
    rawText = cleanSelectedWordNoise(rawText);

    // 在选中的文本中，提取所有由字母和连字符组成的片段
    const candidates = rawText.match(/[A-Za-z-]{2,}/g);
    if (!candidates || candidates.length === 0) {
      return null;
    }

    // 优先选择包含连字符的片段（例如 then-destroyed），否则退回到第一个片段
    let selectedText = candidates.find(w => w.includes('-')) || candidates[0];

    // 拼写校验与离线短译并行：离线命中即可入库划线，不必等在线引擎
    const originalSelected = selectedText;
    const pendingOfflineOriginal = translateWordToChineseOffline(originalSelected).catch(() => null);
    const validationPromise = validateVocabWordRemote(originalSelected);
    const offlineOriginal = await pendingOfflineOriginal;
    const offlineOriginalText = (offlineOriginal && offlineOriginal.text && !isFailedTranslationText(offlineOriginal.text))
      ? String(offlineOriginal.text).trim()
      : '';

    let validation;
    if (offlineOriginalText) {
      // 离线词典已收录，视为有效词；在线校验不必挡住划线
      validation = { ok: true, corrected: false, word: originalSelected };
    } else {
      validation = await validationPromise;
    }
    if (!validation || !validation.ok) {
      const tips = (validation && Array.isArray(validation.suggestions) ? validation.suggestions : [])
        .slice(0, 3)
        .filter(Boolean);
      showVocabToast(
        tips.length
          ? `「${selectedText}」不是有效单词，未加入。你是不是想找：${tips.join(' / ')}？`
          : `「${selectedText}」不是有效英文单词，未加入生词本`,
        'error'
      );
      return null;
    }
    if (validation.corrected && validation.word) {
      showVocabToast(`已纠正拼写：${validation.original || selectedText} → ${validation.word}`, 'ok');
      selectedText = validation.word;
    }

    const lowerWord = selectedText.toLowerCase();
    
    // 已在生词本：仍返回结果，供详情页切换展示
    if (savedWords.has(lowerWord)) {
      if (validation.corrected) {
        showVocabToast(`纠正后的「${selectedText}」已在生词本中`, 'ok');
      }
      return {
        word: selectedText,
        translation: wordTranslations.get(lowerWord) || wordChineseTranslations.get(lowerWord) || '',
        alreadySaved: true
      };
    }
    
    // 双击短译只用离线词典，在线详情走后台补全，避免 youdao/Google 超时挡住划线
    let quickTranslation = '';
    let quickSource = '';
    try {
      if (selectedText === originalSelected && offlineOriginalText) {
        quickTranslation = offlineOriginalText;
        quickSource = offlineOriginal.source || 'ecd';
      } else {
        const offline = await translateWordToChineseOffline(selectedText).catch(() => null);
        if (offline && offline.text && !isFailedTranslationText(offline.text)) {
          quickTranslation = String(offline.text).trim();
          quickSource = offline.source || 'ecd';
        }
      }
    } catch (e) {}
    if (!quickTranslation) quickTranslation = '翻译中...';

    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const lowerWord2 = selectedText.toLowerCase();
    savedWords.add(lowerWord2);
    wordTranslations.set(lowerWord2, quickTranslation);
    wordChineseTranslations.set(lowerWord2, quickTranslation);
    if (quickSource && quickTranslation !== '翻译中...') {
      wordSourceMap.set(lowerWord2, quickSource);
      setChineseSource(lowerWord2, quickSource);
    }
    if (!wordStatus.has(lowerWord2)) {
      wordStatus.set(lowerWord2, 'new');
    }

    // 先划线再写 storage，不因 50ms 定时器或 storage 回执耽误可见刷新
    markNearSelectionOrFull();
    showVocabToast(`已加入生词：${selectedText}`, 'ok');

    const userData = {};
    userData[`${userKey}savedWords`] = Array.from(savedWords);
    userData[`${userKey}wordTranslations`] = Array.from(wordTranslations.entries());
    userData[`${userKey}wordDictionaryData`] = Array.from(wordDictionaryData.entries());
    userData[`${userKey}wordChineseTranslations`] = Array.from(wordChineseTranslations.entries());
    appendChineseSourcesToPayload(userData, userKey);
    userData[`${userKey}wordStatus`] = Array.from(wordStatus.entries());
    userData[`${userKey}wordNotes`] = Array.from(wordNotes.entries());

    noteLocalVocabWrite();
    chrome.storage.local.set(userData);

    // 后台按地区补全（不阻塞，带超时保护）
    {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Background API timeout')), 5000);
      });

      Promise.race([
        (async () => {
          const [dictData, chineseTranslation] = await Promise.all([
            fetchDictionaryInfo(selectedText),
            translateWordToChinese(selectedText)
          ]);
          return [dictData, chineseTranslation];
        })(),
        timeoutPromise
      ]).then(([dictData, chineseTranslation]) => {
        // 更新完整信息
        if (dictData) {
          wordDictionaryData.set(lowerWord2, dictData);
        }
        if (chineseTranslation &&
            !isFailedTranslationText(chineseTranslation) &&
            chineseTranslation !== quickTranslation) {
          wordChineseTranslations.set(lowerWord2, chineseTranslation);
          wordTranslations.set(lowerWord2, chineseTranslation);
          if (!wordChineseSources.has(lowerWord2)) {
            setChineseSource(lowerWord2, wordSourceMap.get(lowerWord2) || 'offline');
          }
        }

        // 保存完整信息（使用用户ID）
        const userData2 = {};
        userData2[`${userKey}savedWords`] = Array.from(savedWords);
        userData2[`${userKey}wordTranslations`] = Array.from(wordTranslations.entries());
        userData2[`${userKey}wordDictionaryData`] = Array.from(wordDictionaryData.entries());
        userData2[`${userKey}wordChineseTranslations`] = Array.from(wordChineseTranslations.entries());
        appendChineseSourcesToPayload(userData2, userKey);
        userData2[`${userKey}wordStatus`] = Array.from(wordStatus.entries());
        userData2[`${userKey}wordNotes`] = Array.from(wordNotes.entries());

        noteLocalVocabWrite();
        chrome.storage.local.set(userData2, () => {
          // 仅短译变化时才重扫；纯词典详情补全不必整页重标记
          if (chineseTranslation &&
              chineseTranslation !== quickTranslation &&
              !isFailedTranslationText(chineseTranslation)) {
            setTimeout(() => {
              markSavedWords();
            }, 100);
          }
        });
      }).catch(error => {
        // 静默失败，不影响用户体验
        if (error.message !== 'Background API timeout') {
          console.error('后台获取完整信息失败:', error);
        }
      });
    }

    return {
      word: selectedText,
      translation: quickTranslation || '',
      alreadySaved: false
    };
  }

  // ================= 划句翻译（按地区选引擎 → 自有悬浮窗，不写入词库） =================
  // sentenceTranslateMode: 'auto' 松开即译 | 'button' 先出浮动按钮，点击后再译
  let sentenceTranslateMode = 'auto';
  let currentSentencePopup = null;
  let currentSentenceButton = null;
  let sentenceButtonPayload = null;
  let sentenceTranslateToken = 0;

  function applySentenceTranslateMode(value) {
    sentenceTranslateMode = value === 'button' ? 'button' : 'auto';
  }

  function loadSentenceTranslateMode() {
    try {
      chrome.storage.local.get(['sentenceTranslateMode'], (result) => {
        applySentenceTranslateMode(result && result.sentenceTranslateMode);
      });
    } catch (e) {
      sentenceTranslateMode = 'auto';
    }
  }
  loadSentenceTranslateMode();

  const WORD_MARK_STYLES = ['wavy', 'solid', 'dashed', 'dotted', 'highlight'];

  function applyWordMarkConfig(cfg) {
    const style = WORD_MARK_STYLES.indexOf(cfg && cfg.style) >= 0 ? cfg.style : 'wavy';
    const hex = (value, fallback) => /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : fallback;
    const root = document.documentElement;
    root.setAttribute('data-wn-mark', style);
    root.style.setProperty('--wn-mark-new', hex(cfg && cfg.newColor, '#FF6B35'));
    root.style.setProperty('--wn-mark-mastered', hex(cfg && cfg.masteredColor, '#4CAF50'));
  }

  function loadWordMarkConfig() {
    try {
      chrome.storage.local.get(['wordMarkConfig'], (result) => {
        applyWordMarkConfig(result && result.wordMarkConfig);
      });
    } catch (e) {
      applyWordMarkConfig(null);
    }
  }
  loadWordMarkConfig();

  function isEditableOrOurUi(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], ' +
      '.vocab-sentence-popup, .vocab-sentence-btn, .vocab-chunk-btn, .vocab-readaloud-btn, .vocab-popup-full, .vocab-tooltip, .vocab-word-detail-overlay'
    );
  }

  function isSentenceSelection(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 4 || t.length > 800) return false;
    const words = t.split(' ').filter(Boolean);
    // 至少两个词，才当作「划句」；单词仍走双击/Ctrl 收藏
    return words.length >= 2;
  }

  function isUsableClientRect(rect) {
    return !!(rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && (rect.width > 0 || rect.height > 0));
  }

  function clientRectFromRange(range) {
    if (!range || range.collapsed) return null;
    try {
      const rect = range.getBoundingClientRect();
      if (isUsableClientRect(rect)) return rect;
      const list = range.getClientRects();
      for (let i = 0; i < list.length; i++) {
        if (isUsableClientRect(list[i])) return list[i];
      }
    } catch (e) {}
    return null;
  }

  function clientRectFromSelection(sel) {
    if (!sel) return null;
    try {
      if (typeof sel.getComposedRanges === 'function') {
        const composed = sel.getComposedRanges();
        if (composed && composed.length) {
          const rect = clientRectFromRange(composed[0]);
          if (rect) return rect;
        }
      }
    } catch (e) {}
    try {
      if (sel.rangeCount > 0) {
        const rect = clientRectFromRange(sel.getRangeAt(0));
        if (rect) return rect;
      }
    } catch (e) {}
    return null;
  }

  function selectionOfRoot(root) {
    try {
      if (root && typeof root.getSelection === 'function') return root.getSelection();
    } catch (e) {}
    return null;
  }

  function collectSelectionRoots(event) {
    const roots = [];
    const add = (root) => {
      if (root && roots.indexOf(root) === -1) roots.push(root);
    };
    try { add(document); } catch (e) {}
    try {
      if (typeof knownShadowRoots !== 'undefined' && knownShadowRoots) {
        knownShadowRoots.forEach((sr) => add(sr));
      }
    } catch (e) {}
    try {
      const path = event && event.composedPath ? event.composedPath() : null;
      if (path) {
        for (let i = 0; i < path.length; i++) {
          const n = path[i];
          if (!n) continue;
          if (n.nodeType === 11) add(n);
          if (n.shadowRoot) add(n.shadowRoot);
        }
      }
    } catch (e) {}
    try {
      const t = event && event.target;
      if (t && t.shadowRoot) add(t.shadowRoot);
    } catch (e) {}
    return roots;
  }

  function liveRangeFrom(rangeLike) {
    if (!rangeLike) return null;
    try {
      if (typeof rangeLike.cloneRange === 'function') return rangeLike.cloneRange();
    } catch (e) {}
    try {
      const r = document.createRange();
      r.setStart(rangeLike.startContainer, rangeLike.startOffset);
      r.setEnd(rangeLike.endContainer, rangeLike.endOffset);
      return r;
    } catch (e) {}
    return null;
  }

  function usableSelectedText(value) {
    const t = String(value || '').trim();
    if (!t || t === '[object StaticRange]' || t === '[object Range]') return '';
    return t;
  }

  function textFromSelection(sel) {
    if (!sel) return '';
    try {
      if (!sel.isCollapsed) {
        const t = usableSelectedText(sel.toString());
        if (t) return t;
      }
    } catch (e) {}
    try {
      if (typeof sel.getComposedRanges === 'function') {
        const composed = sel.getComposedRanges();
        if (composed && composed[0]) {
          const live = liveRangeFrom(composed[0]);
          if (live && !live.collapsed) {
            const t = usableSelectedText(live.toString());
            if (t) return t;
          }
        }
      }
    } catch (e) {}
    return '';
  }

  function getSelectedSentenceText(event) {
    let text = textFromSelection(window.getSelection());
    if (text) return text;
    try {
      const docSel = document.getSelection && document.getSelection();
      text = textFromSelection(docSel);
      if (text) return text;
    } catch (e) {}
    const roots = collectSelectionRoots(event);
    for (let i = 0; i < roots.length; i++) {
      text = textFromSelection(selectionOfRoot(roots[i]));
      if (text) return text;
    }
    return '';
  }

  function getSelectionAnchorRect(event) {
    let rect = clientRectFromSelection(window.getSelection());
    if (!rect) {
      try {
        const docSel = document.getSelection && document.getSelection();
        if (docSel) rect = clientRectFromSelection(docSel);
      } catch (e) {}
    }
    if (!rect) {
      const roots = collectSelectionRoots(event);
      for (let i = 0; i < roots.length; i++) {
        rect = clientRectFromSelection(selectionOfRoot(roots[i]));
        if (rect) break;
      }
    }

    const hasMouse = event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
    if (hasMouse) {
      const mouseRect = {
        left: event.clientX,
        right: event.clientX,
        top: event.clientY - 8,
        bottom: event.clientY + 8,
        width: 0,
        height: 16
      };
      if (!rect) return mouseRect;
      const cx = rect.left + (rect.width || 0) / 2;
      const cy = rect.top + (rect.height || 0) / 2;
      const dx = cx - event.clientX;
      const dy = cy - event.clientY;
      // Host/collapsed ranges often land at 0,0 or far from the real sentence
      if ((dx * dx + dy * dy) > (200 * 200)) return mouseRect;
    }
    return rect || null;
  }

  function removeSentenceTranslatePopup() {
    sentenceTranslateToken += 1;
    wnClearChunkHighlights();
    if (currentSentencePopup && currentSentencePopup.parentNode) {
      currentSentencePopup.parentNode.removeChild(currentSentencePopup);
    }
    currentSentencePopup = null;
  }

  function removeSentenceTranslateButton() {
    if (currentSentenceButton && currentSentenceButton.parentNode) {
      currentSentenceButton.parentNode.removeChild(currentSentenceButton);
    }
    currentSentenceButton = null;
    sentenceButtonPayload = null;
    removeChunkButton();
    removeReadAloudButton();
  }

  function positionSentenceButton(btn, anchorRect) {
    const margin = 8;
    const rect = anchorRect || {
      left: window.innerWidth / 2,
      right: window.innerWidth / 2,
      top: 80,
      bottom: 100
    };
    btn.style.visibility = 'hidden';
    btn.style.display = 'block';
    const bw = btn.offsetWidth || 56;
    const bh = btn.offsetHeight || 28;

    let left = rect.right - bw;
    let top = rect.top - bh - 6;
    if (top < margin) top = rect.bottom + 6;
    if (top + bh > window.innerHeight - margin) top = window.innerHeight - bh - margin;
    if (left + bw > window.innerWidth - margin) left = window.innerWidth - bw - margin;
    if (left < margin) left = margin;

    btn.style.left = `${Math.round(left)}px`;
    btn.style.top = `${Math.round(top)}px`;
    btn.style.visibility = 'visible';
  }

  function showSentenceTranslateButton(rawText, anchorRect) {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return;

    removeSentenceTranslatePopup();
    removeSentenceTranslateButton();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vocab-sentence-btn';
    btn.textContent = '翻译';
    btn.title = '翻译选中内容';
    document.documentElement.appendChild(btn);
    currentSentenceButton = btn;
    sentenceButtonPayload = { text, anchorRect };
    positionSentenceButton(btn, anchorRect);
    attachChunkButton(btn, text, anchorRect);
    attachReadAloudButton(btn, text);

    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const payload = sentenceButtonPayload;
      removeSentenceTranslateButton();
      if (payload) showSentenceTranslatePopup(payload.text, payload.anchorRect);
    });
  }

  function positionSentencePopup(popup, anchorRect) {
    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = anchorRect || { left: vw / 2, right: vw / 2, bottom: vh / 3, top: vh / 3, width: 0, height: 0 };
    popup.style.visibility = 'hidden';
    popup.style.display = 'block';
    const pw = popup.offsetWidth || 320;
    const ph = popup.offsetHeight || 120;

    let left = rect.left + window.scrollX;
    let top = rect.bottom + window.scrollY + margin;
    if (left + pw > window.scrollX + vw - margin) {
      left = window.scrollX + vw - pw - margin;
    }
    if (left < window.scrollX + margin) left = window.scrollX + margin;

    if (top + ph > window.scrollY + vh - margin) {
      top = rect.top + window.scrollY - ph - margin;
    }
    if (top < window.scrollY + margin) top = window.scrollY + margin;

    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.style.visibility = 'visible';
  }

  async function showSentenceTranslatePopup(rawText, anchorRect) {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return;

    removeSentenceTranslateButton();
    removeSentenceTranslatePopup();
    const token = ++sentenceTranslateToken;

    const popup = document.createElement('div');
    popup.className = 'vocab-sentence-popup';
    popup.innerHTML = `
      <div class="vocab-sentence-header">
        <span class="vocab-sentence-title">划句翻译</span>
        <span class="vocab-sentence-actions">
          <button type="button" class="vocab-sentence-readaloud" title="朗读选中内容（Edge 自然语音）">朗读</button>
          <button type="button" class="vocab-sentence-mode" data-mode="chunk" title="分析语义块（离线）">语义块</button>
          <button type="button" class="vocab-sentence-close" title="关闭">×</button>
        </span>
      </div>
      <div class="vocab-sentence-source">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      <div class="vocab-sentence-result">正在翻译...</div>
      <div class="vocab-sentence-footer">自动选路翻译 · 不加入词库</div>
    `;
    document.documentElement.appendChild(popup);
    currentSentencePopup = popup;
    positionSentencePopup(popup, anchorRect);

    const closeBtn = popup.querySelector('.vocab-sentence-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        removeSentenceTranslatePopup();
      });
    }

    const chunkModeBtn = popup.querySelector('.vocab-sentence-mode');
    if (chunkModeBtn) {
      chunkModeBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showChunkPopup(text, anchorRect);
      });
    }

    const sentenceReadBtn = popup.querySelector('.vocab-sentence-readaloud');
    if (sentenceReadBtn) {
      sentenceReadBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        speakWithEdgeVoice(text);
      });
    }

    const resultEl = popup.querySelector('.vocab-sentence-result');
    try {
      const translated = await translateWordToChinese(text);
      if (token !== sentenceTranslateToken || !resultEl) return;
      resultEl.textContent = translated || '（无译文）';
      positionSentencePopup(popup, anchorRect);
    } catch (err) {
      if (token !== sentenceTranslateToken || !resultEl) return;
      if (!isExtensionContextValid()) {
        notifyExtensionContextInvalid();
        resultEl.textContent = EXTENSION_RELOAD_HINT;
      } else {
        resultEl.textContent = '翻译失败，请稍后重试';
      }
      resultEl.classList.add('error');
    }
  }

  // ================= 语义块（Chunk）：划句后按需识别，CSS Custom Highlight 着色，不改页面 DOM =================
  // 词库只在用户第一次点「语义块」时加载（data/chunks-core.json + 可删除的 data/chunks-acl.json + 可删除的 data/chunks-slang.json）。
  const WN_CHUNK_CATS = {
    pv: { label: '动词短语', color: '#3B82F6' },
    col: { label: '固定搭配', color: '#0D9488' },
    prep: { label: '介词/连接短语', color: '#8B5CF6' },
    idiom: { label: '习语', color: '#B45309' },
    frame: { label: '句型框架', color: '#DB2777' },
    slang: { label: '俚语', color: '#4F46E5' }
  };
  const WN_CHUNK_CAT_ORDER = ['pv', 'col', 'prep', 'idiom', 'frame', 'slang'];
  const WN_CHUNK_FILES = ['data/chunks-core.json', 'data/chunks-acl.json', 'data/chunks-slang.json'];
  const WN_CHUNK_IRREGULAR = (
    'was:be,were:be,is:be,am:be,are:be,been:be,being:be,has:have,had:have,having:have,does:do,did:do,done:do,' +
    'went:go,gone:go,goes:go,took:take,taken:take,made:make,got:get,gotten:get,came:come,gave:give,given:give,' +
    'brought:bring,broke:break,broken:break,ran:run,kept:keep,held:hold,fell:fall,fallen:fall,found:find,' +
    'thought:think,told:tell,said:say,saw:see,seen:see,stood:stand,left:leave,led:lead,meant:mean,paid:pay,' +
    'sent:send,spent:spend,built:build,caught:catch,dealt:deal,drew:draw,drawn:draw,drove:drive,driven:drive,' +
    'felt:feel,fought:fight,hung:hang,laid:lay,lain:lie,lay:lie,lent:lend,lit:light,lost:lose,met:meet,rode:ride,' +
    'ridden:ride,rose:rise,risen:rise,sat:sit,shook:shake,shaken:shake,shot:shoot,sold:sell,sought:seek,' +
    'spoke:speak,spoken:speak,stuck:stick,struck:strike,swore:swear,sworn:swear,threw:throw,thrown:throw,' +
    'understood:understand,woke:wake,woken:wake,wore:wear,worn:wear,won:win,wrote:write,written:write,' +
    'began:begin,begun:begin,blew:blow,blown:blow,chose:choose,chosen:choose,ate:eat,eaten:eat,flew:fly,' +
    'flown:fly,forgot:forget,forgotten:forget,froze:freeze,frozen:freeze,grew:grow,grown:grow,hid:hide,' +
    'hidden:hide,knew:know,known:know,heard:hear,bought:buy,taught:teach,fed:feed,fled:flee,dug:dig,' +
    'sang:sing,sung:sing,sank:sink,sunk:sink,slept:sleep,slid:slide,spun:spin,stole:steal,stolen:steal,' +
    'swam:swim,swum:swim,tore:tear,torn:tear,bore:bear,borne:bear,born:bear,bent:bend,bound:bind,bit:bite,' +
    'bitten:bite,bled:bleed,bred:breed,burnt:burn,clung:cling,crept:creep,dreamt:dream,drank:drink,drunk:drink,' +
    'forgave:forgive,forgiven:forgive,ground:grind,knelt:kneel,leapt:leap,learnt:learn,meant:mean,mistook:mistake,' +
    'mistaken:mistake,overcame:overcome,rang:ring,rung:ring,sewn:sew,shone:shine,showed:show,shown:show,' +
    'shrank:shrink,shut:shut,slung:sling,smelt:smell,sped:speed,spelt:spell,spilt:spill,spat:spit,split:split,' +
    'spread:spread,sprang:spring,sprung:spring,stank:stink,stung:sting,strode:stride,strove:strive,swept:sweep,' +
    'swung:swing,undertook:undertake,undertaken:undertake,upset:upset,wept:weep,withdrew:withdraw,' +
    'withdrawn:withdraw,wound:wind,wrung:wring,men:man,women:woman,children:child,feet:foot,teeth:tooth,' +
    'mice:mouse,people:person,data:datum,criteria:criterion,phenomena:phenomenon,analyses:analysis,' +
    'hypotheses:hypothesis,theses:thesis,bases:basis,crises:crisis,lives:life,wives:wife,knives:knife,' +
    'leaves:leaf,halves:half,selves:self,better:good,best:good,worse:bad,worst:bad,further:far,farther:far'
  ).split(',').reduce((m, pair) => {
    const i = pair.indexOf(':');
    if (i > 0) {
      const k = pair.slice(0, i);
      (m[k] || (m[k] = [])).push(pair.slice(i + 1));
    }
    return m;
  }, Object.create(null));
  const WN_CHUNK_POSS = new Set(['my', 'your', 'his', 'her', 'its', 'our', 'their', "one's"]);
  const WN_CHUNK_REFL = new Set(['myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves', 'yourselves', 'themselves', 'oneself']);
  const WN_CHUNK_OBJ_PRON = new Set(['it', 'them', 'him', 'her', 'me', 'us', 'you', 'this', 'that', 'these', 'those', 'something', 'someone', 'somebody', 'everything', 'everyone', 'things']);
  const WN_CHUNK_DET = new Set(['a', 'an', 'the', 'his', 'her', 'their', 'its', 'our', 'my', 'your', 'this', 'that', 'these', 'those', 'some', 'any', 'all', 'every', 'each', 'no']);
  const WN_CHUNK_PLACEHOLDER = new Set(['sb', 'sth', 'someone', 'something', 'somebody', "sb's", "sth's", "someone's", "somebody's"]);

  let wnChunkDataPromise = null;
  let wnChunkLastRange = null;
  let wnChunkButton = null;
  let wnReadAloudButton = null;
  let wnChunkToken = 0;

  function wnChunkLemmas(w) {
    const out = [w];
    const add = (x) => { if (x && x.length >= 2 && out.indexOf(x) < 0) out.push(x); };
    const irr = WN_CHUNK_IRREGULAR[w];
    if (irr) irr.forEach(add);
    if (w.length > 3) {
      if (w.endsWith("'s")) add(w.slice(0, -2));
      if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
      if (w.endsWith('es')) add(w.slice(0, -2));
      if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
      if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
      if (w.endsWith('ed')) {
        const b = w.slice(0, -2);
        add(b); add(b + 'e');
        if (/([^aeiou])\1$/.test(b)) add(b.slice(0, -1));
      }
      if (w.endsWith('ing')) {
        const b = w.slice(0, -3);
        add(b); add(b + 'e');
        if (/([^aeiou])\1$/.test(b)) add(b.slice(0, -1));
        if (b.endsWith('y')) add(b.slice(0, -1) + 'ie');
      }
    }
    return out;
  }

  // 词条 → Trie 路径。特殊段：~ 可选 0-2 词；* 占位 1-3 词；#poss 物主代词；#refl 反身代词；% 动词宾语空位
  function wnChunkPattern(phrase) {
    return String(phrase || '').toLowerCase().split(/\s+/).filter(Boolean).map((t) => {
      if (t === '~') return '~';
      if (WN_CHUNK_PLACEHOLDER.has(t)) return t.endsWith("'s") ? '#poss' : '*';
      if (t === "one's") return '#poss';
      if (t === 'oneself') return '#refl';
      return t;
    });
  }

  function wnChunkInsert(root, pattern, entry) {
    let node = root;
    for (let i = 0; i < pattern.length; i++) {
      const k = pattern[i];
      let next = node.c.get(k);
      if (!next) { next = { c: new Map(), e: null }; node.c.set(k, next); }
      node = next;
    }
    if (!node.e) node.e = entry;
  }

  function wnBuildChunkTrie(lists) {
    const root = { c: new Map(), e: null };
    let count = 0;
    lists.forEach((list) => {
      (list || []).forEach((row) => {
        if (!Array.isArray(row) || !row[0]) return;
        const isVerb = row[3] === 'v' || row[4] === 'v';
        const note = (row[3] && row[3] !== 'v') ? String(row[3]) : ((row[4] && row[4] !== 'v') ? String(row[4]) : '');
        const entry = { phrase: String(row[0]).replace(/\s*~\s*/g, ' ').trim(), cat: WN_CHUNK_CATS[row[1]] ? row[1] : 'col', zh: row[2] || '', note };
        const pattern = wnChunkPattern(row[0]);
        const realParts = pattern.filter((t) => t[0] !== '~' && t !== '*' && t !== '%').length;
        // 普通语块至少两个实词；俚语允许 gonna / y'all 这类无歧义的单词或缩约形式
        if (realParts < 1) return;
        if (realParts < 2 && entry.cat !== 'slang') return;
        wnChunkInsert(root, pattern, entry);
        // 动词短语/搭配：允许动词后插入宾语（take it into account / turn the light off）
        if (isVerb && pattern.length >= 2 && pattern[1] !== '~' && pattern[1] !== '*') {
          wnChunkInsert(root, [pattern[0], '%'].concat(pattern.slice(1)), entry);
        }
        count++;
      });
    });
    return { root, count };
  }

  function wnLoadChunkData() {
    if (wnChunkDataPromise) return wnChunkDataPromise;
    wnChunkDataPromise = Promise.all(WN_CHUNK_FILES.map((file) => {
      let url;
      try { url = chrome.runtime.getURL(file); } catch (e) { return Promise.reject(e); }
      return fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    })).then((files) => {
      if (!files[0]) throw new Error('chunk data missing');
      return wnBuildChunkTrie(files.map((f) => (f && Array.isArray(f.e) ? f.e : [])));
    }).catch((err) => {
      wnChunkDataPromise = null;
      throw err;
    });
    return wnChunkDataPromise;
  }

  // 选区 → 文本片段 + 位置映射（只读 DOM）
  function wnChunkBlockOf(node, cache) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el.nodeType === 1) {
      if (cache.has(el)) return cache.get(el);
      let display = '';
      try { display = getComputedStyle(el).display || ''; } catch (e) {}
      if (display && display.indexOf('inline') !== 0 && display !== 'contents') {
        cache.set(el, el);
        return el;
      }
      el = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    }
    return null;
  }

  function wnCollectRangeText(range) {
    const segs = [];
    let text = '';
    if (!range || range.collapsed) return { text, segs };
    const rootNode = range.commonAncestorContainer;
    const nodes = [];
    if (rootNode.nodeType === 3) {
      nodes.push(rootNode);
    } else {
      const tw = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const p = n.parentElement;
          if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (p && isInsideOurVocabUi(p)) return NodeFilter.FILTER_REJECT;
          try { if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT; } catch (e) { return NodeFilter.FILTER_REJECT; }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let n;
      while ((n = tw.nextNode())) nodes.push(n);
    }
    const blockCache = new Map();
    let prevBlock;
    nodes.forEach((node) => {
      const full = node.data || '';
      const s = node === range.startContainer ? range.startOffset : 0;
      const e = node === range.endContainer ? range.endOffset : full.length;
      if (e <= s) return;
      const block = wnChunkBlockOf(node, blockCache);
      if (segs.length && block !== prevBlock) text += '\u0001';
      prevBlock = block;
      segs.push({ node, s, g: text.length, len: e - s });
      text += full.slice(s, e);
    });
    return { text, segs };
  }

  function wnChunkDomPos(segs, offset, isEnd) {
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i];
      if (offset < sg.g) continue;
      if (offset < sg.g + sg.len || (isEnd && offset === sg.g + sg.len)) {
        return { node: sg.node, offset: sg.s + (offset - sg.g) };
      }
    }
    return null;
  }

  function wnChunkTokenize(text) {
    const tokens = [];
    const re = /[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g;
    let m;
    let last = 0;
    while ((m = re.exec(text)) !== null) {
      const between = text.slice(last, m.index);
      tokens.push({
        w: m[0].replace(/\u2019/g, "'").toLowerCase(),
        raw: m[0],
        start: m.index,
        end: m.index + m[0].length,
        // 标点、换块处不能跨越
        b: tokens.length === 0 || /[.,;:!?()[\]{}"\u201c\u201d\u2014\u2013\u0001|/\\]/.test(between)
      });
      last = m.index + m[0].length;
    }
    tokens.forEach((t) => { t.l = wnChunkLemmas(t.w); });
    return tokens;
  }

  function wnFindChunks(tokens, trie) {
    const found = [];
    const n = tokens.length;
    const canUse = (i, start) => i < n && (i === start || !tokens[i].b);
    const walk = (node, i, start, used, exact) => {
      if (node.e && (used.length >= 2 || (used.length >= 1 && node.e.cat === 'slang'))) found.push({ entry: node.e, start, end: i - 1, used: used.slice(), exact });
      if (i > n) return;
      node.c.forEach((child, key) => {
        if (key === '~') {
          walk(child, i, start, used, exact);
          for (let g = 1; g <= 2; g++) {
            if (!canUse(i + g - 1, start)) break;
            walk(child, i + g, start, used, exact);
          }
        } else if (key === '*') {
          for (let g = 1; g <= 3; g++) {
            if (!canUse(i + g - 1, start)) break;
            walk(child, i + g, start, used, exact);
          }
        } else if (key === '%') {
          if (!canUse(i, start)) return;
          const t = tokens[i];
          if (WN_CHUNK_OBJ_PRON.has(t.w)) walk(child, i + 1, start, used, exact);
          if (WN_CHUNK_DET.has(t.w) && canUse(i + 1, start) && !WN_CHUNK_DET.has(tokens[i + 1].w)) {
            walk(child, i + 2, start, used, exact);
          }
        } else {
          if (!canUse(i, start)) return;
          const t = tokens[i];
          let hit = false;
          if (key === '#poss') hit = WN_CHUNK_POSS.has(t.w) || /'s$/.test(t.w);
          else if (key === '#refl') hit = WN_CHUNK_REFL.has(t.w);
          else hit = t.l.indexOf(key) >= 0;
          if (hit) {
            used.push(i);
            walk(child, i + 1, start, used, exact + (t.w === key ? 1 : 0));
            used.pop();
          }
        }
      });
    };
    for (let i = 0; i < n; i++) walk(trie.root, i, i, [], 0);
    // 最长优先、左起不重叠
    found.sort((a, b) => (b.used.length - a.used.length) || (a.start - b.start) || (b.exact - a.exact) || ((a.end - a.start) - (b.end - b.start)));
    const taken = new Uint8Array(n);
    const picked = [];
    const seen = new Set();
    found.forEach((f) => {
      // 结尾是空位的匹配（如 ~ 收尾）不要把空位算进跨度
      const last = f.used[f.used.length - 1];
      for (let i = f.start; i <= last; i++) if (taken[i]) return;
      const key = f.start + ':' + last;
      if (seen.has(key)) return;
      seen.add(key);
      for (let i = f.start; i <= last; i++) taken[i] = 1;
      picked.push(Object.assign({}, f, { end: last }));
    });
    picked.sort((a, b) => a.start - b.start);
    return picked;
  }

  function wnChunkTokenInMarker(segs, token) {
    const pos = wnChunkDomPos(segs, token.start, false);
    const el = pos && pos.node && pos.node.parentElement;
    return !!(el && el.closest && el.closest('.vocab-word-marker'));
  }

  // 语块里落在生词标记上的词单独成段（mark=true），用生词自己的颜色/线型重画下划线，避免被语块样式盖掉
  function wnChunkRanges(chunk, tokens, segs) {
    const ranges = [];
    let runStart = null;
    let prev = null;
    let runMark = false;
    const flush = (endOffset) => {
      if (runStart === null) return;
      const a = wnChunkDomPos(segs, tokens[runStart].start, false);
      const b = wnChunkDomPos(segs, endOffset != null ? endOffset : tokens[prev].end, true);
      if (a && b) {
        try {
          const r = document.createRange();
          r.setStart(a.node, a.offset);
          r.setEnd(b.node, b.offset);
          if (!r.collapsed) ranges.push({ range: r, mark: runMark });
        } catch (e) {}
      }
      runStart = null;
    };
    chunk.used.forEach((i) => {
      const mark = wnChunkTokenInMarker(segs, tokens[i]);
      if (runStart !== null && i !== prev + 1) flush();
      else if (runStart !== null && mark !== runMark) {
        // 相邻词：普通段延伸到下一个词前，空格也画上；生词段只画词本身
        flush(runMark ? null : tokens[i].start);
      }
      if (runStart === null) { runStart = i; runMark = mark; }
      prev = i;
    });
    flush();
    return ranges;
  }

  function wnChunkHighlightSupported() {
    try {
      return typeof Highlight === 'function' && typeof CSS !== 'undefined' && !!CSS.highlights;
    } catch (e) {
      return false;
    }
  }

  // ::highlight 规则不放进 content.css：放在那里会让每个页面的样式计算都变慢（大页面实测 +20ms 以上）。
  // 第一次用「语义块」时才挂到页面上（adoptedStyleSheets，不加节点；不支持时退回 <style>）。
  function wnChunkHighlightCss() {
    let markStyle = 'wavy';
    try { markStyle = document.documentElement.getAttribute('data-wn-mark') || 'wavy'; } catch (e) {}
    return WN_CHUNK_CAT_ORDER.map((cat) => {
      const hex = WN_CHUNK_CATS[cat].color;
      const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
      // 生词标记上的那一段：保留生词原来的线型和颜色（var 取自生词标记元素）
      const markDecor = markStyle === 'highlight'
        ? 'text-decoration: none;'
        : `text-decoration: underline ${markStyle} 2px var(--wn-mark-color, #FF6B35);`;
      return `::highlight(wn-chunk-${cat}) { background-color: rgba(${rgb}, 0.16); text-decoration: underline dotted 2px ${hex}; }\n` +
        `::highlight(wn-chunk-${cat}-m) { background-color: rgba(${rgb}, 0.22); ${markDecor} }`;
    }).join('\n');
  }
  let wnChunkSheet = null;
  let wnChunkStyleEl = null;

  function wnEnsureChunkHighlightStyle() {
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
        if (!wnChunkSheet) wnChunkSheet = new CSSStyleSheet();
        wnChunkSheet.replaceSync(wnChunkHighlightCss());
        const list = document.adoptedStyleSheets || [];
        if (list.indexOf(wnChunkSheet) < 0) document.adoptedStyleSheets = [...list, wnChunkSheet];
        if (document.adoptedStyleSheets.indexOf(wnChunkSheet) >= 0) return;
      }
    } catch (e) {}
    try {
      if (!wnChunkStyleEl || !wnChunkStyleEl.isConnected) {
        wnChunkStyleEl = document.createElement('style');
        wnChunkStyleEl.setAttribute('data-wordnest-chunk', '');
      }
      wnChunkStyleEl.textContent = wnChunkHighlightCss();
      if (wnChunkStyleEl.isConnected) return;
      (document.head || document.documentElement).appendChild(wnChunkStyleEl);
    } catch (e) {}
  }

  function wnClearChunkHighlights() {
    if (!wnChunkHighlightSupported()) return;
    try {
      WN_CHUNK_CAT_ORDER.forEach((cat) => {
        CSS.highlights.delete('wn-chunk-' + cat);
        CSS.highlights.delete('wn-chunk-' + cat + '-m');
      });
    } catch (e) {}
  }

  function wnApplyChunkHighlights(items) {
    wnClearChunkHighlights();
    if (!wnChunkHighlightSupported()) return false;
    wnEnsureChunkHighlightStyle();
    const byCat = {};
    items.forEach((it) => {
      it.ranges.forEach((x) => {
        const key = it.entry.cat + (x.mark ? '-m' : '');
        (byCat[key] || (byCat[key] = [])).push(x.range);
      });
    });
    try {
      Object.keys(byCat).forEach((cat) => {
        if (!byCat[cat].length) return;
        const hl = new Highlight(...byCat[cat]);
        CSS.highlights.set('wn-chunk-' + cat, hl);
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function wnNormalizeSelText(t) {
    return String(t || '').replace(/[\s\u0001]+/g, ' ').trim();
  }

  function wnCaptureSelectionRange(event, text) {
    const want = wnNormalizeSelText(text);
    const cands = [];
    const roots = collectSelectionRoots(event);
    const shadowRoots = roots.filter((r) => r && r.nodeType === 11);
    let sel = null;
    try { sel = window.getSelection(); } catch (e) {}
    try {
      if (sel && typeof sel.getComposedRanges === 'function' && shadowRoots.length) {
        let comp = null;
        try { comp = sel.getComposedRanges({ shadowRoots }); } catch (e) {
          try { comp = sel.getComposedRanges(...shadowRoots); } catch (e2) {}
        }
        if (comp && comp[0] && !comp[0].collapsed) {
          const r = document.createRange();
          r.setStart(comp[0].startContainer, comp[0].startOffset);
          r.setEnd(comp[0].endContainer, comp[0].endOffset);
          cands.push(r);
        }
      }
    } catch (e) {}
    try { if (sel && sel.rangeCount) cands.push(sel.getRangeAt(0).cloneRange()); } catch (e) {}
    shadowRoots.forEach((sr) => {
      try {
        const s = selectionOfRoot(sr);
        if (s && s.rangeCount) cands.push(s.getRangeAt(0).cloneRange());
      } catch (e) {}
    });
    let fallback = null;
    for (let i = 0; i < cands.length; i++) {
      const r = cands[i];
      if (!r || r.collapsed) continue;
      const got = wnNormalizeSelText(r.toString());
      if (!got) continue;
      if (got === want) return r;
      if (!fallback && want && (got.indexOf(want.slice(0, 24)) >= 0 || want.indexOf(got.slice(0, 24)) >= 0)) fallback = r;
    }
    return fallback;
  }

  function wnEscapeChunkHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function wnChunkSurface(chunk, tokens) {
    let out = '';
    let prev = null;
    chunk.used.forEach((i) => {
      if (prev !== null) out += i === prev + 1 ? ' ' : ' … ';
      out += tokens[i].raw;
      prev = i;
    });
    return out;
  }

  function wnLookupChunkGloss(phrase) {
    return new Promise((resolve) => {
      try {
        if (!isExtensionContextValid()) { resolve(''); return; }
        chrome.runtime.sendMessage({ action: 'queryOfflineDict', word: phrase }, (res) => {
          if (chrome.runtime.lastError || !res || !res.success || !res.translation) { resolve(''); return; }
          resolve(String(res.translation).split(/\r?\n|\\n/)[0].slice(0, 40));
        });
      } catch (e) {
        resolve('');
      }
    });
  }

  function removeChunkButton() {
    if (wnChunkButton && wnChunkButton.parentNode) wnChunkButton.parentNode.removeChild(wnChunkButton);
    wnChunkButton = null;
  }

  // 浮动按钮模式：「翻译」按钮左边加一个「语义块」按钮（「翻译」按钮位置与行为不变）
  function attachChunkButton(translateBtn, text, anchorRect) {
    removeChunkButton();
    if (!translateBtn || !translateBtn.isConnected) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vocab-chunk-btn';
    btn.textContent = '语义块';
    btn.title = '分析选中内容里的语义块（离线）';
    document.documentElement.appendChild(btn);
    wnChunkButton = btn;
    const bw = btn.offsetWidth || 64;
    let left = translateBtn.offsetLeft - bw - 6;
    if (left < 8) left = translateBtn.offsetLeft + (translateBtn.offsetWidth || 50) + 6;
    btn.style.left = `${Math.round(left)}px`;
    btn.style.top = translateBtn.style.top;
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeSentenceTranslateButton();
      showChunkPopup(text, anchorRect);
    });
  }

  function removeReadAloudButton() {
    if (wnReadAloudButton && wnReadAloudButton.parentNode) {
      wnReadAloudButton.parentNode.removeChild(wnReadAloudButton);
    }
    wnReadAloudButton = null;
  }

  // 浮动按钮模式：「翻译」右边加「朗读」（翻译 / 语义块的位置与行为不变）
  function attachReadAloudButton(translateBtn, text) {
    removeReadAloudButton();
    if (!translateBtn || !translateBtn.isConnected) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vocab-readaloud-btn';
    btn.textContent = '朗读';
    btn.title = '朗读选中内容（Edge 自然语音）';
    document.documentElement.appendChild(btn);
    wnReadAloudButton = btn;
    const bw = btn.offsetWidth || 56;
    const tw = translateBtn.offsetWidth || 50;
    const tLeft = translateBtn.offsetLeft;
    const margin = 8;
    const gap = 6;
    let left = tLeft + tw + gap;
    if (left + bw > window.innerWidth - margin) {
      const chunk = wnChunkButton;
      const chunkOnLeft = chunk && chunk.isConnected && chunk.offsetLeft + (chunk.offsetWidth || 0) <= tLeft + 1;
      if (chunkOnLeft) left = chunk.offsetLeft - bw - gap;
      else left = tLeft - bw - gap;
      if (left < margin) {
        const rightEdge = (chunk && chunk.isConnected && chunk.offsetLeft >= tLeft)
          ? chunk.offsetLeft + (chunk.offsetWidth || 0)
          : tLeft + tw;
        left = rightEdge + gap;
      }
    }
    btn.style.left = `${Math.round(left)}px`;
    btn.style.top = translateBtn.style.top;
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      speakWithEdgeVoice(text);
    });
  }

  async function showChunkPopup(rawText, anchorRect) {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return;
    removeSentenceTranslateButton();
    removeSentenceTranslatePopup();
    const token = ++wnChunkToken;
    const range = wnChunkLastRange;

    const popup = document.createElement('div');
    popup.className = 'vocab-sentence-popup vocab-chunk-popup';
    popup.innerHTML = `
      <div class="vocab-sentence-header">
        <span class="vocab-sentence-title">语义块</span>
        <span class="vocab-sentence-actions">
          <button type="button" class="vocab-sentence-mode" data-mode="translate" title="翻译这段内容">翻译</button>
          <button type="button" class="vocab-sentence-close" title="关闭">×</button>
        </span>
      </div>
      <div class="vocab-sentence-source">${wnEscapeChunkHtml(text)}</div>
      <div class="vocab-chunk-list"><div class="vocab-chunk-empty">正在识别语义块...</div></div>
      <div class="vocab-sentence-footer">离线语块库 · 不加入词库</div>
    `;
    document.documentElement.appendChild(popup);
    currentSentencePopup = popup;
    positionSentencePopup(popup, anchorRect);
    popup.querySelector('.vocab-sentence-close').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeSentenceTranslatePopup();
    });
    popup.querySelector('.vocab-sentence-mode').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showSentenceTranslatePopup(text, anchorRect);
    });

    const listEl = popup.querySelector('.vocab-chunk-list');
    const footEl = popup.querySelector('.vocab-sentence-footer');
    const stillMine = () => token === wnChunkToken && currentSentencePopup === popup && popup.isConnected;
    let trie;
    try {
      trie = await wnLoadChunkData();
    } catch (err) {
      if (!stillMine()) return;
      if (!isExtensionContextValid()) {
        notifyExtensionContextInvalid();
        listEl.innerHTML = `<div class="vocab-chunk-empty error">${wnEscapeChunkHtml(EXTENSION_RELOAD_HINT)}</div>`;
      } else {
        listEl.innerHTML = '<div class="vocab-chunk-empty error">语块词库加载失败</div>';
      }
      return;
    }
    if (!stillMine()) return;

    const t0 = performance.now();
    let collected = { text: '', segs: [] };
    if (range && range.startContainer && range.startContainer.isConnected) {
      try { collected = wnCollectRangeText(range); } catch (e) {}
    }
    const onPage = !!collected.segs.length;
    const srcText = onPage ? collected.text : text;
    const tokens = wnChunkTokenize(srcText);
    const chunks = wnFindChunks(tokens, trie);
    const items = chunks.map((c) => ({
      entry: c.entry,
      surface: wnChunkSurface(c, tokens),
      ranges: onPage ? wnChunkRanges(c, tokens, collected.segs) : []
    }));
    const highlighted = onPage && items.length ? wnApplyChunkHighlights(items) : false;
    // 选区的蓝底会盖住语块颜色：已经记下了选区，划线成功后取消页面选中
    if (highlighted) {
      try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (e) {}
    }
    const ms = Math.round(performance.now() - t0);
    popup.setAttribute('data-chunk-count', String(items.length));
    popup.setAttribute('data-chunk-ms', String(ms));

    if (!items.length) {
      listEl.innerHTML = '<div class="vocab-chunk-empty">未识别到语义块</div>';
    } else {
      listEl.innerHTML = items.map((it, idx) => {
        const cat = WN_CHUNK_CATS[it.entry.cat] || WN_CHUNK_CATS.col;
        const showBase = it.surface.toLowerCase().replace(/\s*…\s*/g, ' ') !== it.entry.phrase;
        return `<div class="vocab-chunk-item" data-cat="${it.entry.cat}" data-idx="${idx}" style="--wn-chunk-color:${cat.color}">` +
          `<div class="vocab-chunk-line"><span class="vocab-chunk-dot"></span>` +
          `<span class="vocab-chunk-text">${wnEscapeChunkHtml(it.surface)}</span>` +
          `<span class="vocab-chunk-cat">${cat.label}</span></div>` +
          (showBase ? `<div class="vocab-chunk-base">原型：${wnEscapeChunkHtml(it.entry.phrase)}</div>` : '') +
          `<div class="vocab-chunk-zh">${wnEscapeChunkHtml(it.entry.zh || '…')}</div>` +
          (it.entry.note ? `<div class="vocab-chunk-note">${wnEscapeChunkHtml(it.entry.note)}</div>` : '') +
          `</div>`;
      }).join('');
    }
    const cats = WN_CHUNK_CAT_ORDER.filter((c) => items.some((it) => it.entry.cat === c));
    footEl.innerHTML = (cats.length
      ? cats.map((c) => `<span class="vocab-chunk-legend" style="--wn-chunk-color:${WN_CHUNK_CATS[c].color}">${WN_CHUNK_CATS[c].label}</span>`).join('')
      : '') + `<span class="vocab-chunk-meta">离线语块库 · ${items.length} 个${onPage && items.length && !highlighted ? ' · 本页不支持划线' : ''}</span>`;
    positionSentencePopup(popup, anchorRect);

    // 少数没有中文的词条（如学术搭配），再查一次离线词典的整词条
    const missing = items.map((it, idx) => ({ it, idx })).filter((x) => !x.it.entry.zh).slice(0, 8);
    for (let k = 0; k < missing.length; k++) {
      const gloss = await wnLookupChunkGloss(missing[k].it.entry.phrase);
      if (!stillMine()) return;
      if (gloss) {
        missing[k].it.entry.zh = gloss;
        const el = listEl.querySelector(`.vocab-chunk-item[data-idx="${missing[k].idx}"] .vocab-chunk-zh`);
        if (el) el.textContent = gloss;
      }
    }
  }

  // 双击事件处理（双击选中的单词自动收藏；详情悬浮窗内由自身处理）
  document.addEventListener('dblclick', async (e) => {
    if (e.target && e.target.closest && e.target.closest('.vocab-word-detail-overlay, .vocab-popup-full, .vocab-translation-popup')) {
      return;
    }
    removeSentenceTranslateButton();
    removeSentenceTranslatePopup();
    await handleWordSelectionAndSave(e);
  });

  // 单击不划选时不应弹出划句图标：记录这次按下后鼠标是否真的拖动过
  let wnSelectGesture = { down: false, x: 0, y: 0, moved: false };
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    wnSelectGesture = { down: true, x: e.clientX, y: e.clientY, moved: false };
  }, true);
  document.addEventListener('mousemove', (e) => {
    if (!wnSelectGesture.down || wnSelectGesture.moved) return;
    if (Math.abs(e.clientX - wnSelectGesture.x) > 4 || Math.abs(e.clientY - wnSelectGesture.y) > 4) {
      wnSelectGesture.moved = true;
    }
  }, true);

  // 松开鼠标：
  // - Ctrl + 选词：仍按单词收藏
  // - 普通划选整句/短语：按设置自动翻译，或先显示浮动按钮
  document.addEventListener('mouseup', async (e) => {
    if (e.button !== 0) return;
    const gestureMoved = wnSelectGesture.moved;
    wnSelectGesture.down = false;
    if (e.target && e.target.closest && e.target.closest('.vocab-sentence-btn, .vocab-chunk-btn, .vocab-readaloud-btn')) return;

    const selectedText = getSelectedSentenceText(e);
    if (!selectedText) return;
    // 纯点击（含点在旧选区里）或折叠/失效选区不弹出；Shift 点选 / 三击整段仍允许
    const isSelectGesture = gestureMoved || e.shiftKey || e.detail >= 3;
    if (!isSelectGesture) return;


    if (e.ctrlKey) {
      removeSentenceTranslateButton();
      await handleWordSelectionAndSave(e);
      return;
    }

    if (isEditableOrOurUi(e.target)) return;
    if (!isSentenceSelection(selectedText)) {
      removeSentenceTranslateButton();
      return;
    }

    const anchorRect = getSelectionAnchorRect(e);
    try { wnChunkLastRange = wnCaptureSelectionRange(e, selectedText); } catch (err) { wnChunkLastRange = null; }
    const mode = sentenceTranslateMode;
    // 稍延迟，避免和页面自身的 mouseup 逻辑抢选区
    setTimeout(() => {
      if (mode === 'button') {
        showSentenceTranslateButton(selectedText, anchorRect);
      } else {
        removeSentenceTranslateButton();
        showSentenceTranslatePopup(selectedText, anchorRect);
      }
    }, 10);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      removeSentenceTranslateButton();
      removeSentenceTranslatePopup();
    }
  });

  document.addEventListener('mousedown', (e) => {
    const target = e.target;
    const inPopup = target && target.closest && target.closest('.vocab-sentence-popup');
    const inButton = target && target.closest && target.closest('.vocab-sentence-btn, .vocab-chunk-btn, .vocab-readaloud-btn');
    if (currentSentencePopup && !inPopup) removeSentenceTranslatePopup();
    if (currentSentenceButton && !inButton) removeSentenceTranslateButton();
  }, true);

  // 接收 background 发送的“右键菜单添加生词”消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === 'addSelectedWordToVocab') {
      const text = message.text || '';
      if (!text) {
        return;
      }

      // 临时替换当前 selection 处理（handleWordSelectionAndSave 依赖 window.getSelection）
      const selection = window.getSelection();
      if (!selection) {
        return;
      }

      // 保存原来的 selection 范围
      const ranges = [];
      for (let i = 0; i < selection.rangeCount; i++) {
        ranges.push(selection.getRangeAt(i));
      }

      // 创建一个临时的隐藏节点来承载这段文本，作为 selection 源
      const tempSpan = document.createElement('span');
      tempSpan.style.position = 'fixed';
      tempSpan.style.left = '-9999px';
      tempSpan.style.top = '-9999px';
      tempSpan.textContent = text;
      document.body.appendChild(tempSpan);

      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(tempSpan);
      selection.addRange(range);

      // 调用统一的保存逻辑
      handleWordSelectionAndSave(null).finally(() => {
        // 恢复原来的 selection，并移除临时节点
        selection.removeAllRanges();
        ranges.forEach(r => selection.addRange(r));
        document.body.removeChild(tempSpan);
      });
    }
  });

  // 鼠标悬停在标记单词上（直接从词库读取，不调用API）
  // 使用事件委托和防抖，避免频繁触发
  let hoveredElement = null;
  let hoverTimeout = null;
  let tooltipRemoveTimeout = null;
  const TOOLTIP_REMOVE_DELAY = 200; // 200ms 延迟，给用户时间移动到 tooltip

  // 同一事件可能先后到达 shadowRoot 和 document 上的监听器，只处理一次
  const handledHoverEvents = new WeakSet();
  const onVocabMouseOver = (e) => {
    if (handledHoverEvents.has(e)) return;
    handledHoverEvents.add(e);
    // 事件从 shadow DOM 冒出来时 e.target 被重定向为宿主元素，用 composedPath()[0] 取真实目标
    const path = e.composedPath ? e.composedPath() : null;
    let target = (path && path[0] && path[0].nodeType === 1) ? path[0] : e.target;
    // 真实 mouseover 落在视频/遮罩上时，不要当成「离开标记」把待显示的 tooltip 取消掉
    if (!(target && target.classList &&
          (target.classList.contains('vocab-word-marker') ||
           (target.closest && target.closest('.vocab-tooltip'))))) {
      const hx = (e && e.clientX != null) ? e.clientX : (lastOverlayMoveEvent && lastOverlayMoveEvent.clientX);
      const hy = (e && e.clientY != null) ? e.clientY : (lastOverlayMoveEvent && lastOverlayMoveEvent.clientY);
      if (typeof findMarkerAtPoint === 'function' && hx != null) {
        try {
          const under = findMarkerAtPoint(hx, hy);
          if (under) target = under;
        } catch (err) {}
      }
    }
    if (!target || !target.classList) return;
    
    // 如果鼠标移动到tooltip上或其子元素上，取消移除操作
    if (target.classList.contains('vocab-tooltip') || target.closest('.vocab-tooltip')) {
      // 清除移除超时
      if (tooltipRemoveTimeout) {
        clearTimeout(tooltipRemoveTimeout);
        tooltipRemoveTimeout = null;
      }
      return;
    }

    // 如果鼠标移动到标记的单词上
    if (target.classList.contains('vocab-word-marker')) {
      // 如果已经在同一个元素上，不重复处理（字幕节点被替换时也视为同一个）
      if (hoveredElement === target || isSameHoverMarker(hoveredElement, target)) {
        hoveredElement = target;
        return;
      }

      // 清除之前的超时和移除超时
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
      }
      if (tooltipRemoveTimeout) {
        clearTimeout(tooltipRemoveTimeout);
        tooltipRemoveTimeout = null;
      }

      // 如果切换到新元素，先移除旧的tooltip
      if (hoveredElement && hoveredElement !== target) {
        removeTooltip();
      }

      hoveredElement = target;
      const word = target.getAttribute('data-word');
      const lowerWord = word.toLowerCase();
      
      // 延迟显示tooltip，避免鼠标快速移动时频繁创建
      hoverTimeout = setTimeout(async () => {
        if (hoveredElement === target || isSameHoverMarker(hoveredElement, target)) {
          hoveredElement = target;
          let translation = target.getAttribute('data-translation');
          
          // 如果data-translation为空，尝试从本地存储读取
          if (!translation || translation.trim() === '') {
            const storedTranslation = wordTranslations.get(lowerWord);
            if (storedTranslation) {
              // 更新data属性以便下次使用
              target.setAttribute('data-translation', storedTranslation);
              translation = storedTranslation;
            } else {
              return; // 没有翻译，不显示tooltip
            }
          }

          // 显示tooltip（先显示，即使没有词典数据）
          // 传入真实目标：异步回调里 e.target 已是 shadow 宿主，定位会错
          showTooltip({ target: target, clientX: e.clientX, clientY: e.clientY }, word, translation).then(tooltip => {
            // tooltip 已创建
          });
          
          // 为 tooltip 添加鼠标事件，保持显示（使用事件委托，避免重复绑定）
          // 使用 currentTooltip 作为当前激活的提示框元素
          if (currentTooltip && !currentTooltip.hasAttribute('data-events-bound')) {
            currentTooltip.setAttribute('data-events-bound', 'true');
            
            currentTooltip.addEventListener('mouseenter', () => {
              // 鼠标进入 tooltip，取消移除
              if (tooltipRemoveTimeout) {
                clearTimeout(tooltipRemoveTimeout);
                tooltipRemoveTimeout = null;
              }
            });
            
            currentTooltip.addEventListener('mouseleave', () => {
              // 鼠标离开 tooltip，延迟移除
              if (tooltipRemoveTimeout) {
                clearTimeout(tooltipRemoveTimeout);
              }
              tooltipRemoveTimeout = setTimeout(() => {
                removeTooltip();
                tooltipRemoveTimeout = null;
              }, TOOLTIP_REMOVE_DELAY);
            });
          }
        }
      }, 150); // 150ms延迟，避免快速移动时闪烁

      // 添加mouseleave事件（只添加一次）
      if (!target.hasAttribute('data-tooltip-bound')) {
        target.setAttribute('data-tooltip-bound', 'true');
        target.addEventListener('mouseleave', () => {
          if (overlayHoverMarker) return;
          // 字幕重挂或 pointer-events:none 时，节点会收到 mouseleave，但指针可能还在同一个词上
          try {
            const ev = lastOverlayMoveEvent;
            const under = ev && typeof findMarkerAtPoint === 'function'
              ? findMarkerAtPoint(ev.clientX, ev.clientY) : null;
            if (under && isSameHoverMarker(under, target)) {
              hoveredElement = under;
              return;
            }
          } catch (err) {}
          // 延迟移除 tooltip，给用户时间移动到 tooltip 上
          if (tooltipRemoveTimeout) {
            clearTimeout(tooltipRemoveTimeout);
          }
          tooltipRemoveTimeout = setTimeout(() => {
            if (hoveredElement === target || isSameHoverMarker(hoveredElement, target)) {
              hoveredElement = null;
            }
            removeTooltip();
            tooltipRemoveTimeout = null;
          }, TOOLTIP_REMOVE_DELAY);
          
          if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            hoverTimeout = null;
          }
        }, { once: false }); // 不只用一次，因为元素可能被重新创建
      }
    } else {
      // 几何命中路径正在接管（字幕 pointer-events:none / 覆盖层）时不要拆掉 tooltip
      if (overlayHoverMarker) return;
      // 指针其实还在标记上
      const hx = (e && e.clientX != null) ? e.clientX : (lastOverlayMoveEvent && lastOverlayMoveEvent.clientX);
      const hy = (e && e.clientY != null) ? e.clientY : (lastOverlayMoveEvent && lastOverlayMoveEvent.clientY);
      if (typeof findMarkerAtPoint === 'function' && hx != null) {
        try {
          const under = findMarkerAtPoint(hx, hy);
          if (under) {
            onVocabMouseOver({
              target: under,
              composedPath: () => [under],
              clientX: hx,
              clientY: hy
            });
            return;
          }
        } catch (err) {}
      }
      // 仅在当前确实悬停标记/有 tooltip 时才清理，避免整页 mouseover 空转
      if (!hoveredElement && !currentTooltip && !hoverTimeout) {
        return;
      }
      if (hoveredElement) {
        hoveredElement = null;
      }
      if (tooltipRemoveTimeout) {
        clearTimeout(tooltipRemoveTimeout);
      }
      tooltipRemoveTimeout = setTimeout(() => {
        removeTooltip();
        tooltipRemoveTimeout = null;
      }, TOOLTIP_REMOVE_DELAY);
      
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
    }
  };
  document.addEventListener('mouseover', onVocabMouseOver);
  wnShadowHoverHandler = onVocabMouseOver;
  knownShadowRoots.forEach((sr) => sr.addEventListener('mouseover', onVocabMouseOver));

  // 通用命中兜底（不依赖站点结构）：
  // - 透明覆盖层（Google News 那种空 <a>）用 elementsFromPoint 往下找标记；
  // - pointer-events:none 的字幕/装饰层不会出现在 elementsFromPoint 里，再按矩形在已标记词里找；
  // - 在 document 捕获阶段听 mousemove，不依赖事件能否冒泡到标记节点。
  let overlayHoverMarker = null;
  let overlayMoveScheduled = false;
  let lastOverlayMoveEvent = null;
  let lastOverlayMoveTarget = null;
  let captionPointerUnlock = null;
  let markerRectCache = { at: 0, items: null };

  function isMediaLikeHit(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = String(el.tagName || '').toUpperCase();
    return tag === 'VIDEO' || tag === 'AUDIO' || tag === 'CANVAS';
  }

  function isMarkerVisiblyAtPoint(marker, x, y, mr, markerCs) {
    const cs = markerCs || getComputedStyle(marker);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
    let el = marker.parentElement;
    if (!el) {
      const rn = marker.getRootNode && marker.getRootNode();
      if (rn && rn.nodeType === 11) el = rn.host;
    }
    while (el && el.nodeType === 1) {
      const acs = getComputedStyle(el);
      if (acs.display === 'none' || parseFloat(acs.opacity) === 0 || acs.clip === 'rect(0px, 0px, 0px, 0px)') {
        return false;
      }
      if (el !== document.documentElement && el !== document.body) {
        const ox = acs.overflowX;
        const oy = acs.overflowY;
        const clipX = ox === 'hidden' || ox === 'clip' || ox === 'scroll' || ox === 'auto';
        const clipY = oy === 'hidden' || oy === 'clip' || oy === 'scroll' || oy === 'auto';
        if (clipX || clipY) {
          const ar = el.getBoundingClientRect();
          if (clipX && (ar.width <= 0 || x < ar.left || x > ar.right || mr.right <= ar.left || mr.left >= ar.right)) {
            return false;
          }
          if (clipY && (ar.height <= 0 || y < ar.top || y > ar.bottom || mr.bottom <= ar.top || mr.top >= ar.bottom)) {
            return false;
          }
        }
      }
      let next = el.parentElement;
      if (!next) {
        const rn = el.getRootNode && el.getRootNode();
        if (rn && rn.nodeType === 11) next = rn.host;
      }
      el = next;
    }
    return true;
  }

  function findMarkerByGeometry(x, y, preferRoot) {
    const now = performance.now();
    if (!markerRectCache.items || now - markerRectCache.at > 200) {
      const items = [];
      const collect = (scope) => {
        if (!scope || !scope.querySelectorAll) return;
        const inShadow = scope.nodeType === 11;
        let list;
        try { list = scope.querySelectorAll('.vocab-word-marker'); } catch (err) { return; }
        for (let i = 0; i < list.length; i++) {
          const el = list[i];
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
          items.push({ el, inShadow, left: r.left, right: r.right, top: r.top, bottom: r.bottom, area: r.width * r.height });
        }
      };
      if (preferRoot && preferRoot.nodeType === 11) collect(preferRoot);
      collect(document);
      knownShadowRoots.forEach((sr) => { if (sr !== preferRoot) collect(sr); });
      markerRectCache = { at: now, items };
    }
    let best = null, bestArea = Infinity;
    const items = markerRectCache.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (x < it.left || x > it.right || y < it.top || y > it.bottom) continue;
      if (!it.el.isConnected) continue;
      const cs = getComputedStyle(it.el);
      // 仅用于穿透 pointer-events:none 或 Shadow DOM；普通文档流里可见的标记已由 elementsFromPoint 命中
      if (!it.inShadow && cs.pointerEvents !== 'none') continue;
      if (!isMarkerVisiblyAtPoint(it.el, x, y, it, cs)) continue;
      if (it.area < bestArea) { best = it.el; bestArea = it.area; }
    }
    return best;
  }

  function findMarkerAtPoint(x, y) {
    let stack = [];
    try { stack = document.elementsFromPoint(x, y) || []; } catch (e) { stack = []; }
    for (let i = 0; i < stack.length && i < 32; i++) {
      const el = stack[i];
      if (!el || el.nodeType !== 1) continue;
      if (el.classList && el.classList.contains('vocab-word-marker')) return el;
      if (el.closest) {
        const via = el.closest('.vocab-word-marker');
        if (via) return via;
      }
      if (isOurVocabUiElement(el) || (el.closest && el.closest('.vocab-tooltip'))) return null;
    }
    const top = stack[0];
    const maybePeNone = !top || top === document.body || top === document.documentElement || isMediaLikeHit(top);
    let largeUnder = false;
    if (top && top.getBoundingClientRect) {
      const tr = top.getBoundingClientRect();
      largeUnder = tr.width >= 120 && tr.height >= 80;
    }
    // 播放器控件常与字幕重叠：命中的是小按钮时也要继续按矩形找 pointer-events:none 的标记
    const preferRoot = top && top.getRootNode ? top.getRootNode() : null;
    const inShadow = !!(preferRoot && preferRoot.nodeType === 11);
    if (!maybePeNone && !largeUnder && !inShadow) return null;
    const geom = findMarkerByGeometry(x, y, preferRoot);
    return geom || null;
  }

  function tightInteractiveBox(marker) {
    let best = marker;
    let el = marker;
    while (el && el.nodeType === 1) {
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none' || cs.userSelect === 'none' || cs.webkitUserSelect === 'none') {
        const r = el.getBoundingClientRect();
        const mr = marker.getBoundingClientRect();
        if (r.height <= Math.max(mr.height * 5, 96) && r.width <= Math.max(mr.width * 30, 900)) {
          best = el;
        } else {
          break;
        }
      }
      el = el.parentElement;
    }
    return best;
  }

  function restoreCaptionPointer() {
    const u = captionPointerUnlock;
    captionPointerUnlock = null;
    if (!u || !u.el) return;
    try {
      if (u.pe) u.el.style.setProperty('pointer-events', u.pe, u.pePri);
      else u.el.style.removeProperty('pointer-events');
      if (u.us) u.el.style.setProperty('user-select', u.us, u.usPri);
      else u.el.style.removeProperty('user-select');
      if (u.wes) u.el.style.setProperty('-webkit-user-select', u.wes, u.wesPri);
      else u.el.style.removeProperty('-webkit-user-select');
    } catch (e) {}
  }

  function unlockCaptionPointer(marker) {
    if (!marker || !marker.isConnected) { restoreCaptionPointer(); return; }
    const box = tightInteractiveBox(marker);
    const cs0 = box && getComputedStyle(box);
    const already = captionPointerUnlock && captionPointerUnlock.el === box;
    if (already && cs0 && cs0.pointerEvents !== 'none' && cs0.userSelect !== 'none' && cs0.webkitUserSelect !== 'none') return;
    restoreCaptionPointer();
    if (!box) return;
    const cs = getComputedStyle(box);
    const needPe = cs.pointerEvents === 'none';
    const needUs = cs.userSelect === 'none' || cs.webkitUserSelect === 'none';
    if (!needPe && !needUs) return;
    captionPointerUnlock = {
      el: box,
      pe: box.style.getPropertyValue('pointer-events'),
      pePri: box.style.getPropertyPriority('pointer-events'),
      us: box.style.getPropertyValue('user-select'),
      usPri: box.style.getPropertyPriority('user-select'),
      wes: box.style.getPropertyValue('-webkit-user-select'),
      wesPri: box.style.getPropertyPriority('-webkit-user-select')
    };
    if (needPe) box.style.setProperty('pointer-events', 'auto', 'important');
    if (needUs) {
      box.style.setProperty('user-select', 'text', 'important');
      box.style.setProperty('-webkit-user-select', 'text', 'important');
    }
  }

  function findMarkerUnderOverlay(x, y) {
    return findMarkerAtPoint(x, y);
  }

  // 字幕会反复换节点：同一个词在差不多的位置上重挂时，不要取消待显示的 tooltip
  function isSameHoverMarker(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const wa = (a.getAttribute && a.getAttribute('data-word') || a.textContent || '').trim().toLowerCase();
    const wb = (b.getAttribute && b.getAttribute('data-word') || b.textContent || '').trim().toLowerCase();
    if (!wa || wa !== wb) return false;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return Math.abs(ra.x - rb.x) < 16 && Math.abs(ra.y - rb.y) < 16;
  }

  function handleOverlayMouseMove() {
    overlayMoveScheduled = false;
    const e = lastOverlayMoveEvent;
    if (!e || !isLoaded || savedWords.size === 0) return;
    const realTarget = lastOverlayMoveTarget;
    // 直接在我们自己的弹窗上：保持现状
    if (realTarget && realTarget.closest && realTarget.closest('.vocab-tooltip')) {
      return;
    }
    // 直接点到可交互的标记：交给原 mouseover，同时结束「几何命中」拥有权
    if (realTarget && realTarget.classList && realTarget.classList.contains('vocab-word-marker')) {
      if (overlayHoverMarker && overlayHoverMarker !== realTarget) {
        restoreCaptionPointer();
        overlayHoverMarker = null;
      }
      return;
    }
    const marker = findMarkerUnderOverlay(e.clientX, e.clientY);
    if (marker) {
      unlockCaptionPointer(marker);
      if (isSameHoverMarker(marker, overlayHoverMarker)) {
        overlayHoverMarker = marker;
        hoveredElement = marker;
        return;
      }
      overlayHoverMarker = marker;
      hoveredElement = marker;
      if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
      if (tooltipRemoveTimeout) { clearTimeout(tooltipRemoveTimeout); tooltipRemoveTimeout = null; }
      const word = marker.getAttribute('data-word') || (marker.textContent || '').trim();
      const lower = (word || '').toLowerCase();
      let translation = marker.getAttribute('data-translation');
      if (!translation || !String(translation).trim()) {
        translation = (typeof wordTranslations !== 'undefined' && wordTranslations.get) ? wordTranslations.get(lower) : '';
      }
      if (translation) {
        showTooltip({ target: marker, clientX: e.clientX, clientY: e.clientY }, word, translation);
      }
      return;
    }
    // 在字幕上拖选时按住鼠标，先不要收回 pointer-events
    if (e.buttons) return;
    if (!overlayHoverMarker && !captionPointerUnlock) return;
    if (hoveredElement === overlayHoverMarker) hoveredElement = null;
    overlayHoverMarker = null;
    restoreCaptionPointer();
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
    if (tooltipRemoveTimeout) clearTimeout(tooltipRemoveTimeout);
    tooltipRemoveTimeout = setTimeout(() => {
      removeTooltip();
      tooltipRemoveTimeout = null;
    }, TOOLTIP_REMOVE_DELAY);
  }

  document.addEventListener('mousemove', (e) => {
    lastOverlayMoveEvent = e;
    // composedPath() 只在派发期间有效，先记下真实目标
    lastOverlayMoveTarget = (e.composedPath && e.composedPath()[0]) || e.target;
    if (overlayMoveScheduled) return;
    overlayMoveScheduled = true;
    requestAnimationFrame(handleOverlayMouseMove);
  }, { capture: true, passive: true });

  // 监听存储变化
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'local') {
      const currentUserId = await getCurrentUserId();
      const userKey = `user_${currentUserId}_`;
      
      // 如果当前用户的词库数据变化，重新加载
      if (changes[`${userKey}savedWords`] || changes[`${userKey}wordTranslations`] || changes[`${userKey}wordStatus`]) {
        // 本页刚写入引起的 onChanged：内存已更新，跳过重复整页扫描
        if (Date.now() < suppressStorageRemountUntil) {
          return;
        }
        loadWords().then(() => {
          debouncedMarkSavedWords();
        });
      }
      
      // 如果切换用户，重新加载并刷新标记
      if (changes.sentenceTranslateMode) {
        applySentenceTranslateMode(changes.sentenceTranslateMode.newValue);
        removeSentenceTranslateButton();
      }

      if (changes.wordMarkConfig) {
        applyWordMarkConfig(changes.wordMarkConfig.newValue);
      }

      if (changes.currentUserId) {
        // 先清除所有现有标记
        const existingMarkers = querySelectorAllDeep('.vocab-word-marker');
        existingMarkers.forEach(marker => {
          const parent = marker.parentNode;
          if (parent) {
            parent.replaceChild(document.createTextNode(marker.textContent), marker);
            parent.normalize();
          }
        });
        // 然后重新加载并标记
        loadWords().then(() => {
          setTimeout(() => {
            markSavedWords();
          }, 200);
        });
      }
    }
  });
  
  // 监听来自popup/main的消息（切换用户时）
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'reloadWords') {
      // 重新加载当前用户的词库并刷新标记
      loadWords().then(() => {
        // 先清除所有现有标记
        const existingMarkers = querySelectorAllDeep('.vocab-word-marker');
        existingMarkers.forEach(marker => {
          const parent = marker.parentNode;
          if (parent) {
            parent.replaceChild(document.createTextNode(marker.textContent), marker);
            parent.normalize();
          }
        });
        // 然后重新标记
        setTimeout(() => {
          markSavedWords();
          sendResponse({ success: true });
        }, 100);
      });
      return true; // 保持消息通道开放
    }
  });

  // 防抖函数
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  const debouncedMarkSavedWords = debounce(markSavedWords, 700);

  // 动态插入内容：只扫新增子树，避免 SPA/文档站每次 DOM 变动都整页 TreeWalker
  const pendingMarkRoots = new Set();
  const MAX_PENDING_MARK_ROOTS = 300;
  let pendingMarkFlushTimer = null;

  function queuePendingMarkRoot(node) {
    if (!node) return;
    // 队列过大时合并到祖先，避免输入期间无限堆积
    if (pendingMarkRoots.size >= MAX_PENDING_MARK_ROOTS) {
      pendingMarkRoots.clear();
      if (document.body) pendingMarkRoots.add(document.body);
      return;
    }
    pendingMarkRoots.add(node);
  }

  function flushPendingMarkRoots() {
    if (pendingMarkFlushTimer) {
      clearTimeout(pendingMarkFlushTimer);
      pendingMarkFlushTimer = null;
    }
    if (isMarking || !isLoaded || savedWords.size === 0) {
      pendingMarkRoots.clear();
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body && isInsideMarkSkipZone(active)) {
      // 仍在输入：离开输入区后再冲一次，避免队列永远不落盘
      if (!pendingMarkFlushTimer) {
        pendingMarkFlushTimer = setTimeout(() => {
          pendingMarkFlushTimer = null;
          flushPendingMarkRoots();
        }, 1200);
      }
      return;
    }
    const roots = Array.from(pendingMarkRoots);
    pendingMarkRoots.clear();
    if (!roots.length) return;

    // 若已积到整页，直接走完整扫描更划算
    if (roots.some((r) => r === document.body)) {
      markSavedWords();
      scheduleMarkRecheck([document.body]);
      return;
    }
    scheduleMarkRecheck(roots);

    isMarking = true;
    if (observer) observer.disconnect();
    try {
      const skipChecker = createSkipZoneChecker();
      const rootSet = new Set(roots);
      roots.forEach((root) => {
        if (!root || !root.isConnected) return;
        // 祖先已在队列里就不必重复扫
        for (let up = wnParentAcrossShadow(root); up; up = wnParentAcrossShadow(up)) {
          if (rootSet.has(up)) return;
        }
        markSavedWordsInRoot(root, { skipChecker, skipCleanup: true });
      });
    } catch (e) {
      console.error('局部标记出错:', e);
    } finally {
      isMarking = false;
      if (observer && document.body) {
        reconnectObserver();
      }
    }
  }

  // 快速标记后约 800ms 再补扫一次同样的区域（只补不删）：
  // 有的页面先插入空节点、稍后才填文字，原来 700ms 的慢节奏恰好能等到，这里保留这份兜底。补扫不再触发补扫。
  const markRecheckRoots = new Set();
  let markRecheckTimer = null;
  function scheduleMarkRecheck(roots) {
    roots.forEach((r) => {
      if (markRecheckRoots.size >= MAX_PENDING_MARK_ROOTS && document.body) {
        markRecheckRoots.clear();
        markRecheckRoots.add(document.body);
      }
      if (!markRecheckRoots.has(document.body)) markRecheckRoots.add(r);
    });
    if (markRecheckTimer) return;
    markRecheckTimer = setTimeout(runMarkRecheck, 800);
  }
  function runMarkRecheck() {
    markRecheckTimer = null;
    const roots = Array.from(markRecheckRoots);
    markRecheckRoots.clear();
    if (!roots.length || isMarking || !isLoaded || savedWords.size === 0) return;
    if (roots.some((r) => r === document.body)) {
      markSavedWords();
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body && isInsideMarkSkipZone(active) && !isInsideOurVocabUi(active)) return;
    isMarking = true;
    if (observer) observer.disconnect();
    try {
      const skipChecker = createSkipZoneChecker();
      roots.forEach((root) => {
        if (root && root.isConnected) markSavedWordsInRoot(root, { skipChecker, skipCleanup: true });
      });
    } catch (e) {
      console.error('补扫标记出错:', e);
    } finally {
      isMarking = false;
      reconnectObserver();
    }
  }

  // 新内容：静止 60ms 或最多等 200ms 就标记（原来固定 700ms 且每次变化都重新计时，SPA 上会一直拖延）。
  // 已积到整页扫描时放慢一些，避免持续变化的页面反复整页扫。
  let markPendingTimer = null;
  let markPendingFirstAt = 0;
  function debouncedMarkPendingRoots() {
    const now = Date.now();
    if (!markPendingTimer) markPendingFirstAt = now;
    else clearTimeout(markPendingTimer);
    const fullPage = !!document.body && pendingMarkRoots.has(document.body);
    const wait = fullPage ? 300 : 60;
    const maxWait = fullPage ? 1000 : 200;
    const delay = Math.max(0, Math.min(wait, markPendingFirstAt + maxWait - now));
    markPendingTimer = setTimeout(() => {
      markPendingTimer = null;
      flushPendingMarkRoots();
    }, delay);
  }

  document.addEventListener('focusout', () => {
    if (pendingMarkRoots.size) debouncedMarkPendingRoots();
  }, true);

  // 页面加载完成后标记单词
  function initMarking() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        loadWords().then(() => {
          markSavedWords();
          setTimeout(markSavedWords, 600); // 补一遍（原先只在 500ms 时扫一次）
        });
      });
    } else {
      loadWords().then(() => {
        markSavedWords();
        setTimeout(markSavedWords, 600); // 补一遍（原先只在 500ms 时扫一次）
      });
    }
    [2000, 5000, 10000].forEach((ms) => setTimeout(scanNewShadowRoots, ms));
  }

  // 监听动态内容变化
  const observer = new MutationObserver((mutations) => {
    // 如果正在标记中，忽略变化（避免循环）
    if (isMarking) {
      return;
    }

    // 输入中不因输入区自身的 DOM 变化去重扫整页
    const active = document.activeElement;
    if (active && isInsideMarkSkipZone(active)) {
      const onlyEditableMutations = mutations.every((mutation) => {
        return isInsideMarkSkipZone(mutation.target);
      });
      if (onlyEditableMutations) return;
    }
    
    // 注意：不能因为批次里有我们自己的标记/弹窗就整批忽略。
    // Gmail 等 SPA 会在同一批变化里既重绘含标记的文字（移除标记），又插入新正文，
    // 整批丢弃会让新正文永远不被标记。我们自己的节点在下面逐个跳过即可。

    let addedSomething = false;
    mutations.forEach((mutation) => {
      if (mutation.type !== 'childList') return;
      if (isInsideMarkSkipZone(mutation.target)) return;
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          if (isOurVocabUiElement(node)) return;
          if (node.classList && node.classList.contains('vocab-word-marker')) return;
          queuePendingMarkRoot(node);
          addedSomething = true;
        } else if (node.nodeType === 3 && node.parentElement) {
          if (isInsideMarkSkipZone(node.parentElement)) return;
          queuePendingMarkRoot(node.parentElement);
          addedSomething = true;
        } else if (node.nodeType === 3 && node.parentNode && node.parentNode.nodeType === 11) {
          // 文本直接挂在 shadowRoot 下
          queuePendingMarkRoot(node.parentNode);
          addedSomething = true;
        }
      });
    });
    
    if (addedSomething && isLoaded) {
      debouncedMarkPendingRoots();
    }
  });

  // 初始化
  initMarking();

  // 开始观察
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  } else {
    const bodyObserver = new MutationObserver((mutations, obs) => {
      if (document.body) {
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
        obs.disconnect();
      }
    });
    bodyObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
})();
