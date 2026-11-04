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

  // 初始化加载
  loadWords().then(() => {
    markSavedWords();
  });

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
      
      if (chineseTranslation && chineseTranslation !== '翻译失败，请检查网络' && chineseTranslation !== '翻译失败') {
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
      
      chrome.storage.local.set(userData, () => {
        setTimeout(() => {
          markSavedWords();
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
        const eng = String((p && (p['sentence-eng'] || p.sentence)) || '').trim();
        const zh = String((p && p['sentence-translation']) || '').trim();
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);
      const resp = await fetch(url, { method: 'GET', mode: 'cors', signal: controller.signal });
      clearTimeout(timeoutId);
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);
      const resp = await fetch(url, { method: 'GET', mode: 'cors', signal: controller.signal });
      clearTimeout(timeoutId);
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

  async function persistWordDictionaryData(word, dictData) {
    if (!word || !dictData) return;
    const lowerWord = word.toLowerCase();
    wordDictionaryData.set(lowerWord, dictData);
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

  async function fetchDictionaryInfo(word) {
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
        const dmResp = await fetch(dmUrl, { method: 'GET', mode: 'cors' });
        if (dmResp.ok) {
          const dmText = await dmResp.text();
          const dmJson = dmText && dmText.trim() ? JSON.parse(dmText) : null;
          const row = Array.isArray(dmJson) ? dmJson[0] : null;
          if (row && Array.isArray(row.defs) && row.defs.length) {
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
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);

          try {
            const response = await fetch(url, {
              method: 'GET',
              mode: 'cors',
              headers: {
                'User-Agent': 'Mozilla/5.0'
              },
              signal: controller.signal
            });

            clearTimeout(timeoutId);

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
            clearTimeout(timeoutId);
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
        const dmResp = await fetch(dmUrl, { method: 'GET', mode: 'cors' });
        if (!dmResp.ok) continue;
        const dmText = await dmResp.text();
        const dmJson = dmText && dmText.trim() ? JSON.parse(dmText) : null;
        const row = Array.isArray(dmJson) ? dmJson[0] : null;
        if (!(row && Array.isArray(row.defs) && row.defs.length)) continue;
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
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // 2秒超时
      
      try {
        const response = await fetch(url, {
          method: 'GET',
          mode: 'cors',
          headers: {
            'User-Agent': 'Mozilla/5.0'
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
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
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          return null;
        }
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
            if (defTranslation && defTranslation !== '翻译失败，请检查网络' && defTranslation !== '翻译失败') {
              defText = defTranslation;
            }
          }
          html += `<div class="dict-def-text">${defText}</div>`;

          if (def.example) {
            html += `<div class="dict-example-display">"${def.example}"</div>`;
          }

          html += `</div></div>`;
        }

        html += `</div>`;
      }
    }
    
    return html || '<div class="vocab-popup-simple-translation">暂无详细信息</div>';
  }

  // 绑定弹窗事件
  function bindPopupEvents(popup, word, translation, isSaved, status) {
    // 关闭按钮
    const closeBtn = popup.querySelector('.vocab-popup-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        popup.remove();
        currentPopup = null;
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
        popup.remove();
        currentPopup = null;
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

    // 点击外部关闭
    setTimeout(() => {
      document.addEventListener('click', function closePopup(e) {
        if (!popup.contains(e.target) && e.target !== popup) {
          popup.remove();
          currentPopup = null;
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

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'GET',
          mode: 'cors',
          headers: {
            'User-Agent': 'Mozilla/5.0'
          },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

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
        clearTimeout(timeoutId);
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
      
      // 添加超时机制（3秒）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      try {
        const response = await fetch(url, {
          method: 'GET',
          mode: 'cors',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data && data.responseData && data.responseData.translatedText) {
          return data.responseData.translatedText;
        }
        throw new Error('Invalid response format');
      } catch (fetchError) {
        clearTimeout(timeoutId);
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'GET',
          mode: 'cors',
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`http_${response.status}`);
        return await response.json();
      } finally {
        clearTimeout(timeoutId);
      }
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
    const lowerWord = String(word || '').toLowerCase();
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
        if (text && text !== '翻译失败' && text !== '翻译失败，请检查网络') {
          const sourceAbbr = got.source || attempts[i].name;
          wordSourceMap.set(lowerWord, sourceAbbr);
          setChineseSource(lowerWord, sourceAbbr);
          return text;
        }
      } catch (error) {
        if (i === attempts.length - 1) {
          return '翻译失败，请检查网络';
        }
      }
    }

    return '翻译失败，请检查网络';
  }

  // 获取单词中文翻译（按地区引擎链）
  async function translateWord(word) {
    try {
      return await translateWordToChinese(word);
    } catch (error) {
      console.error('翻译过程出错:', error);
      return '翻译失败，请检查网络';
    }
  }

  // 创建翻译弹窗（显示完整词典信息）
  async function createTranslationPopup(word, translation, isSaved, status, dictData = null, chineseTranslation = null) {
    // 移除现有弹窗
    if (currentPopup) {
      currentPopup.remove();
    }

    const lowerWord = word.toLowerCase();
    const isMastered = status === 'mastered';
    
    // 获取保存的数据（始终以中文释义为主）
    const savedDictData = dictData || wordDictionaryData.get(lowerWord);
    const savedChineseTranslation = chineseTranslation || wordChineseTranslations.get(lowerWord);
    
    let displayContent = '';
    if (savedDictData || savedChineseTranslation) {
      displayContent = await formatFullDictionaryInfo(savedDictData, null, savedChineseTranslation);
    } else {
      displayContent = `<div class="vocab-popup-simple-translation">${translation}</div>`;
    }

    // 获取音标和音频
    let phoneticText = '';
    let phoneticAudio = '';
    if (savedDictData && savedDictData.phonetics && savedDictData.phonetics.length > 0) {
      const phoneticWithAudio = savedDictData.phonetics.find(p => p.audio);
      const phonetic = phoneticWithAudio || savedDictData.phonetics.find(p => p.text) || savedDictData.phonetics[0];
      if (phonetic) {
        if (phonetic.text) phoneticText = phonetic.text;
        if (phonetic.audio) phoneticAudio = phonetic.audio;
      }
    }

    const popup = document.createElement('div');
    popup.className = 'vocab-translation-popup vocab-popup-full';
    popup.innerHTML = `
      <div class="vocab-popup-header">
        <div class="vocab-popup-word-section">
          <span class="vocab-popup-word">${word}</span>
          ${phoneticText ? `<span class="vocab-popup-phonetic">/${phoneticText}/</span>` : ''}
        </div>
        <div class="vocab-popup-header-actions">
          <div class="vocab-popup-pronounce-buttons">
            <button class="vocab-popup-pronounce" title="英音发音" data-word="${word}" data-type="1">🔊</button>
            <button class="vocab-popup-pronounce" title="美音发音" data-word="${word}" data-type="2">🔊</button>
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
          <button class="vocab-btn vocab-btn-remove" data-word="${word}">移除收藏</button>
          ${!isMastered ? `<button class="vocab-btn vocab-btn-master" data-word="${word}">✓ 已记住</button>` : ''}
        </div>
      </div>
    `;

    document.body.appendChild(popup);
    currentPopup = popup;

    // 绑定事件
    bindPopupEvents(popup, word, translation, isSaved, status);

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
            
            // 离线无音标时，用 Free Dictionary 补（已缓存则不会重复请求）
            if (!offlineData.phonetic || !offlineData.phonetic.trim()) {
              fetchDictionaryInfo(word).then((onlineData) => {
                if (onlineData && onlineData.phonetics && onlineData.phonetics.length > 0) {
                  dictData.phonetics = onlineData.phonetics;
                  wordDictionaryData.set(lowerWord, dictData);
                  if (currentTooltip && currentTooltipWord === word) {
                    const translation = currentTooltip.querySelector('.vocab-tooltip-translation')?.textContent || '';
                    removeTooltip();
                    showTooltip({ target: document.querySelector(`[data-word="${word}"]`) }, word, translation);
                  }
                }
              }).catch(() => {});
            }

            // 缓存到本地
            wordDictionaryData.set(lowerWord, dictData);
          }
        } catch (error) {
          console.warn('查询离线词典数据失败:', error);
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
        if (!dictData) {
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
    
    // 调试日志：如果词典数据存在但没有音标，记录日志
    if (dictData && (!dictData.phonetics || dictData.phonetics.length === 0 || !phoneticText)) {
      console.log(`[Tooltip] Word "${word}" 没有音标数据:`, {
        hasDictData: !!dictData,
        phoneticsArray: dictData.phonetics,
        phoneticText: phoneticText || '(无)'
      });
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
    if (isSavedWord) {
      tooltipHTML += `<button class="vocab-tooltip-note-btn" title="添加/编辑备注" data-word="${word}">✎</button>`;
      tooltipHTML += `<button class="vocab-tooltip-delete" title="删除生词" data-word="${word}">×</button>`;
    }
    tooltipHTML += `</div></div>`;

    tooltipHTML += `<div class="vocab-tooltip-body">`;
    if (phoneticText) {
      tooltipHTML += `<div class="vocab-tooltip-phonetic">/${phoneticText}/</div>`;
    }
    tooltipHTML += `<div class="vocab-tooltip-translation">${translation || '暂无翻译'}</div>`;
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

    tooltip.innerHTML = tooltipHTML;
    
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
    
    document.body.appendChild(tooltip);
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
      document.body.appendChild(overlay);
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

  // 标记已保存的单词
  function markSavedWords() {
    if (isMarking || !isLoaded || savedWords.size === 0) {
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

      // 先移除已存在的标记（但保留已正确标记的元素，如果它们没有变化）
      const existingMarkers = document.querySelectorAll('.vocab-word-marker');
      const markersToKeep = new Set(); // 使用Set存储需要保留的标记元素
      
      existingMarkers.forEach(marker => {
        const word = marker.getAttribute('data-word');
        const translation = marker.getAttribute('data-translation');
        const status = marker.getAttribute('data-status');
        const lowerWord = word ? word.toLowerCase() : '';
        
        // 检查这个标记是否仍然有效（单词仍在词库中，且状态和翻译一致）
        if (savedWords.has(lowerWord)) {
          const storedTranslation = wordTranslations.get(lowerWord) || '';
          const storedStatus = wordStatus.get(lowerWord) || 'new';
          
          // 如果标记的内容没有变化，保留这个标记元素（但不阻止标记其他相同的单词）
          if (translation === storedTranslation && status === storedStatus) {
            markersToKeep.add(marker); // 保留这个具体的标记元素
            return; // 不删除这个标记
          }
        }
        
        // 需要更新的标记，移除它（因为翻译或状态改变了）
        const parent = marker.parentNode;
        if (parent) {
          parent.replaceChild(document.createTextNode(marker.textContent), marker);
          parent.normalize();
        }
      });

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            if (!node.parentElement) {
              return NodeFilter.FILTER_REJECT;
            }
            
            // 跳过script和style标签
            if (node.parentElement.tagName === 'SCRIPT' || 
                node.parentElement.tagName === 'STYLE') {
              return NodeFilter.FILTER_REJECT;
            }
            
            // 跳过已经被标记包裹的文本节点
            if (node.parentElement.classList && 
                node.parentElement.classList.contains('vocab-word-marker')) {
              return NodeFilter.FILTER_REJECT;
            }
            
            // 检查父节点链中是否有标记元素，或扩展自身 UI（避免悬浮窗里再被划线）
            let parent = node.parentElement;
            while (parent && parent !== document.body) {
              if (parent.classList) {
                if (parent.classList.contains('vocab-word-marker')) {
                  return NodeFilter.FILTER_REJECT;
                }
                if (
                  parent.classList.contains('vocab-tooltip') ||
                  parent.classList.contains('vocab-sentence-popup') ||
                  parent.classList.contains('vocab-popup-full') ||
                  parent.classList.contains('vocab-translation-popup')
                ) {
                  return NodeFilter.FILTER_REJECT;
                }
              }
              parent = parent.parentElement;
            }
            
            return NodeFilter.FILTER_ACCEPT;
          }
        },
        false
      );

      const textNodes = [];
      let node;
      while (node = walker.nextNode()) {
        textNodes.push(node);
      }

      textNodes.forEach(textNode => {
        // 检查文本节点是否仍然有效
        if (!textNode.parentNode) {
          return;
        }
        
        const text = textNode.textContent;
        if (!text || text.trim().length === 0) return;
        
        // 检查这个文本节点是否已经被标记包裹（避免重复处理）
        if (textNode.parentElement && textNode.parentElement.classList.contains('vocab-word-marker')) {
          return;
        }
        
        // 检查文本中是否已经包含HTML标签（避免处理已经被处理过的文本）
        if (text.includes('<') && text.includes('>')) {
          return;
        }
        
        // 提取普通单词和带连字符的组合单词（例如 then-destroyed）
        const words = text.match(/[a-zA-Z-]{2,}/g);
        
        if (words) {
          let newHTML = text;
          let hasChange = false;
          
          words.forEach(word => {
            const lowerWord = word.toLowerCase();
            if (savedWords.has(lowerWord)) {
              const translation = wordTranslations.get(lowerWord) || '';
              const status = wordStatus.get(lowerWord) || 'new';
              const statusClass = status === 'mastered' ? 'vocab-word-mastered' : 'vocab-word-new';
              const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              
              // 匹配单词边界，确保标记所有相同的单词
              const regex = new RegExp(`\\b${escapedWord}\\b`, 'g');
              
              // 替换所有匹配的单词（但跳过已经在span标签中的单词）
              newHTML = newHTML.replace(regex, (match, offset) => {
                // 检查这个位置是否已经在HTML标签中（避免重复标记）
                // 检查offset前后的字符，看是否已经在span标签内
                const beforeMatch = newHTML.substring(Math.max(0, offset - 200), offset);
                const afterMatch = newHTML.substring(offset + match.length, Math.min(newHTML.length, offset + match.length + 200));
                
                // 如果前后已经有vocab-word-marker相关的HTML，跳过（避免重复标记）
                // 更精确的检查：查找最近的 <span 和 </span>
                const lastSpanOpen = beforeMatch.lastIndexOf('<span');
                const lastSpanClose = beforeMatch.lastIndexOf('</span>');
                
                // 如果有一个未闭合的span标签（<span 在 </span> 之后，或者没有 </span>），说明可能在span内
                if (lastSpanOpen > lastSpanClose) {
                  // 检查这个span是否包含vocab-word-marker
                  const spanContent = beforeMatch.substring(lastSpanOpen);
                  if (spanContent.includes('vocab-word-marker')) {
                    // 已经在标记的span内，跳过
                    return match;
                  }
                }
                
                // 检查是否在HTML标签内（比如在属性值中）
                const contextBefore = newHTML.substring(Math.max(0, offset - 100), offset);
                const lastOpenTag = contextBefore.lastIndexOf('<');
                const lastCloseTag = contextBefore.lastIndexOf('>');
                
                // 如果有一个未闭合的标签（< 在 > 之后），说明可能在标签内
                if (lastOpenTag > lastCloseTag) {
                  const tagContent = contextBefore.substring(lastOpenTag);
                  // 如果这个标签是span且包含vocab-word-marker，跳过
                  if (tagContent.includes('span') && tagContent.includes('vocab-word-marker') && !tagContent.includes('>')) {
                    return match;
                  }
                }
                
                // 检查这个位置是否已经有正确的标记
                // 由于我们在文本节点级别处理，这里应该标记所有匹配
                hasChange = true;
                // 转义翻译文本中的特殊字符，防止HTML注入和解析错误
                const safeTranslation = translation
                  .replace(/&/g, '&amp;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#39;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;');
                // 转义单词本身（虽然通常是安全的，但为了保险）
                const safeWord = match
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;');
                return `<span class="vocab-word-marker ${statusClass}" data-word="${safeWord}" data-translation="${safeTranslation}" data-status="${status}">${safeWord}</span>`;
              });
            }
          });
          
          if (hasChange && newHTML !== text) {
            try {
              // 再次检查文本节点是否仍然有效
              if (!textNode.parentNode) {
                return;
              }
              
              // 创建一个临时容器来解析HTML
              const tempContainer = document.createElement('div');
              tempContainer.innerHTML = newHTML;
              
              // 验证解析结果 - 检查是否有vocab-word-marker元素被正确创建
              const markers = tempContainer.querySelectorAll('.vocab-word-marker');
              const expectedMarkers = (newHTML.match(/vocab-word-marker/g) || []).length / 2; // 每个标记出现2次（class和可能其他地方）
              
              // 如果应该创建标记但没有创建，说明HTML解析失败
              if (markers.length === 0 && expectedMarkers > 0) {
                console.warn('HTML解析失败，标记元素未创建。原始文本:', text.substring(0, 50), 'HTML:', newHTML.substring(0, 150));
                return;
              }
              
              // 检查是否有HTML标签未正确闭合
              const openTags = (newHTML.match(/<[^/>]+>/g) || []).length;
              const closeTags = (newHTML.match(/<\/[^>]+>/g) || []).length;
              const selfClosingTags = (newHTML.match(/<[^>]+\/>/g) || []).length;
              
              // 如果标签数量严重不匹配，可能是HTML格式错误
              if (openTags > closeTags + selfClosingTags + 2) {
                console.warn('HTML标签可能未闭合，跳过替换。原始文本:', text.substring(0, 50));
                return;
              }
              
              // 获取所有子节点（包括文本节点和标记元素）
              const fragment = document.createDocumentFragment();
              while (tempContainer.firstChild) {
                fragment.appendChild(tempContainer.firstChild);
              }
              
              // 替换文本节点
              if (textNode.parentNode && fragment.childNodes.length > 0) {
                // 如果只有一个子节点，直接替换
                if (fragment.childNodes.length === 1) {
                  textNode.parentNode.replaceChild(fragment.firstChild, textNode);
                } else {
                  // 如果有多个子节点，用fragment替换
                  textNode.parentNode.replaceChild(fragment, textNode);
                }
              }
            } catch (error) {
              console.error('替换文本节点时出错:', error, 'HTML:', newHTML.substring(0, 100));
              // 如果出错，不进行替换，避免破坏页面
            }
          }
        }
      });
    } catch (error) {
      console.error('标记单词时出错:', error);
    } finally {
      isMarking = false;
      
      // 重新连接 MutationObserver
      if (observer && document.body) {
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
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

  // 将“双击选词并保存”的逻辑抽成函数，方便复用（双击 / Ctrl+划词）
  async function handleWordSelectionAndSave(triggerEvent) {
    // 确保数据已加载
    if (!isLoaded) {
      await loadWords();
    }

    const selection = window.getSelection();
    let rawText = selection.toString();
    if (!rawText) {
      return;
    }

    // 规范化长横线为普通连字符
    rawText = rawText.replace(/[–—]/g, '-');

    // 在选中的文本中，提取所有由字母和连字符组成的片段
    const candidates = rawText.match(/[A-Za-z-]{2,}/g);
    if (!candidates || candidates.length === 0) {
      return;
    }

    // 优先选择包含连字符的片段（例如 then-destroyed），否则退回到第一个片段
    let selectedText = candidates.find(w => w.includes('-')) || candidates[0];

    const lowerWord = selectedText.toLowerCase();
    
    // 如果已经保存，不重复处理
    if (savedWords.has(lowerWord)) {
      return;
    }
    
    // 先快速保存单词，使用用户选择的翻译API（快速响应）
    // 然后后台获取完整信息
    const quickTranslation = await translateWordToChinese(selectedText).catch(() => '翻译中...');
    
    // 先保存快速翻译，让用户立即看到效果
    getCurrentUserId().then(async (currentUserId) => {
      const userKey = `user_${currentUserId}_`;
      const lowerWord2 = selectedText.toLowerCase();
      savedWords.add(lowerWord2);
      wordTranslations.set(lowerWord2, quickTranslation || '翻译中...');
      wordChineseTranslations.set(lowerWord2, quickTranslation || '翻译中...');
      // translateWordToChinese 已写入 wordChineseSources
      if (!wordStatus.has(lowerWord2)) {
        wordStatus.set(lowerWord2, 'new');
      }
      
      // 立即保存并标记，让用户看到效果（使用用户ID）
      const userData = {};
      userData[`${userKey}savedWords`] = Array.from(savedWords);
      userData[`${userKey}wordTranslations`] = Array.from(wordTranslations.entries());
      userData[`${userKey}wordDictionaryData`] = Array.from(wordDictionaryData.entries());
      userData[`${userKey}wordChineseTranslations`] = Array.from(wordChineseTranslations.entries());
      appendChineseSourcesToPayload(userData, userKey);
      userData[`${userKey}wordStatus`] = Array.from(wordStatus.entries());
      userData[`${userKey}wordNotes`] = Array.from(wordNotes.entries());
      
      chrome.storage.local.set(userData, () => {
        // 立即标记页面
        setTimeout(() => {
          markSavedWords();
        }, 50);
      });
      
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
              chineseTranslation !== '翻译失败，请检查网络' &&
              chineseTranslation !== '翻译失败' &&
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
          
          chrome.storage.local.set(userData2, () => {
            // 更新标记
            setTimeout(() => {
              markSavedWords();
            }, 100);
          });
        }).catch(error => {
          // 静默失败，不影响用户体验
          if (error.message !== 'Background API timeout') {
            console.error('后台获取完整信息失败:', error);
          }
        });
      }
    });
  }

  // ================= 划句翻译（按地区选引擎 → 自有悬浮窗，不写入词库） =================
  let currentSentencePopup = null;
  let sentenceTranslateToken = 0;

  function isEditableOrOurUi(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], ' +
      '.vocab-sentence-popup, .vocab-popup-full, .vocab-tooltip'
    );
  }

  function isSentenceSelection(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 4 || t.length > 800) return false;
    const words = t.split(' ').filter(Boolean);
    // 至少两个词，才当作「划句」；单词仍走双击/Ctrl 收藏
    return words.length >= 2;
  }

  function getSelectionAnchorRect() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return rect;
  }

  function removeSentenceTranslatePopup() {
    sentenceTranslateToken += 1;
    if (currentSentencePopup && currentSentencePopup.parentNode) {
      currentSentencePopup.parentNode.removeChild(currentSentencePopup);
    }
    currentSentencePopup = null;
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

    removeSentenceTranslatePopup();
    const token = ++sentenceTranslateToken;

    const popup = document.createElement('div');
    popup.className = 'vocab-sentence-popup';
    popup.innerHTML = `
      <div class="vocab-sentence-header">
        <span class="vocab-sentence-title">划句翻译</span>
        <button type="button" class="vocab-sentence-close" title="关闭">×</button>
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

    const resultEl = popup.querySelector('.vocab-sentence-result');
    try {
      const translated = await translateWordToChinese(text);
      if (token !== sentenceTranslateToken || !resultEl) return;
      resultEl.textContent = translated || '（无译文）';
      positionSentencePopup(popup, anchorRect);
    } catch (err) {
      if (token !== sentenceTranslateToken || !resultEl) return;
      resultEl.textContent = '翻译失败，请稍后重试';
      resultEl.classList.add('error');
    }
  }

  // 双击事件处理（双击选中的单词自动收藏，不显示弹窗）
  document.addEventListener('dblclick', async (e) => {
    removeSentenceTranslatePopup();
    await handleWordSelectionAndSave(e);
  });

  // 松开鼠标：
  // - Ctrl + 选词：仍按单词收藏
  // - 普通划选整句/短语：Google 翻译悬浮窗（不收藏）
  document.addEventListener('mouseup', async (e) => {
    if (e.button !== 0) return;

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';
    if (!selectedText) return;

    if (e.ctrlKey) {
      await handleWordSelectionAndSave(e);
      return;
    }

    if (isEditableOrOurUi(e.target)) return;
    if (!isSentenceSelection(selectedText)) return;

    const anchorRect = getSelectionAnchorRect();
    // 稍延迟，避免和页面自身的 mouseup 逻辑抢选区
    setTimeout(() => {
      showSentenceTranslatePopup(selectedText, anchorRect);
    }, 10);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') removeSentenceTranslatePopup();
  });

  document.addEventListener('mousedown', (e) => {
    if (!currentSentencePopup) return;
    if (e.target && e.target.closest && e.target.closest('.vocab-sentence-popup')) return;
    removeSentenceTranslatePopup();
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

  document.addEventListener('mouseover', (e) => {
    const target = e.target;
    
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
      // 如果已经在同一个元素上，不重复处理
      if (hoveredElement === target) {
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
        if (hoveredElement === target) {
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
          showTooltip(e, word, translation).then(tooltip => {
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
          // 延迟移除 tooltip，给用户时间移动到 tooltip 上
          if (tooltipRemoveTimeout) {
            clearTimeout(tooltipRemoveTimeout);
          }
          tooltipRemoveTimeout = setTimeout(() => {
            if (hoveredElement === target) {
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
      // 鼠标移出标记单词区域
      if (hoveredElement) {
        hoveredElement = null;
      }
      // 延迟移除 tooltip
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
  });

  // 监听存储变化
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'local') {
      const currentUserId = await getCurrentUserId();
      const userKey = `user_${currentUserId}_`;
      
      // 如果当前用户的词库数据变化，重新加载
      if (changes[`${userKey}savedWords`] || changes[`${userKey}wordTranslations`] || changes[`${userKey}wordStatus`]) {
        loadWords().then(() => {
          setTimeout(() => {
            markSavedWords();
          }, 200);
        });
      }
      
      // 如果切换用户，重新加载并刷新标记
      if (changes.currentUserId) {
        // 先清除所有现有标记
        const existingMarkers = document.querySelectorAll('.vocab-word-marker');
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
        const existingMarkers = document.querySelectorAll('.vocab-word-marker');
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

  const debouncedMarkSavedWords = debounce(markSavedWords, 500);

  // 页面加载完成后标记单词
  function initMarking() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        loadWords().then(() => {
          setTimeout(markSavedWords, 500);
        });
      });
    } else {
      loadWords().then(() => {
        setTimeout(markSavedWords, 500);
      });
    }
  }

  // 监听动态内容变化
  const observer = new MutationObserver((mutations) => {
    // 如果正在标记中，忽略变化（避免循环）
    if (isMarking) {
      return;
    }
    
    // 检查是否有我们自己的标记元素变化，如果有则忽略
    const hasOurMarkers = mutations.some(mutation => {
      for (let node of mutation.addedNodes) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('vocab-word-marker')) {
          return true;
        }
      }
      for (let node of mutation.removedNodes) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('vocab-word-marker')) {
          return true;
        }
      }
      return false;
    });
    
    // 如果是我们自己的标记变化，不重新标记
    if (hasOurMarkers) {
      return;
    }
    
    const hasRelevantChanges = mutations.some(mutation => {
      return mutation.type === 'childList' && 
             (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0);
    });
    
    if (hasRelevantChanges && isLoaded) {
      debouncedMarkSavedWords();
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
