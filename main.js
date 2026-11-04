// Main Page Script
document.addEventListener('DOMContentLoaded', () => {
  const totalCountEl = document.getElementById('totalCount');
  const masteredCountEl = document.getElementById('masteredCount');
  const newCountEl = document.getElementById('newCount');
  const wordListEl = document.getElementById('wordList');
  const wordsTab = document.getElementById('wordsTab');
  const testTab = document.getElementById('testTab');
  const settingsTab = document.getElementById('settingsTab');
  const logsTab = document.getElementById('logsTab');
  const tabs = document.querySelectorAll('.tab');

  const lazyScriptPromises = {};

  function loadLazyScript(src) {
    if (!lazyScriptPromises[src]) {
      lazyScriptPromises[src] = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-lazy-src="${src}"]`);
        if (existing) {
          if (existing.dataset.loaded === '1') {
            resolve();
            return;
          }
          existing.addEventListener('load', () => resolve(), { once: true });
          existing.addEventListener('error', () => reject(new Error('load failed: ' + src)), { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.dataset.lazySrc = src;
        script.onload = () => {
          script.dataset.loaded = '1';
          resolve();
        };
        script.onerror = () => reject(new Error('load failed: ' + src));
        document.body.appendChild(script);
      });
    }
    return lazyScriptPromises[src];
  }

  async function ensureSettingsPane() {
    await loadLazyScript('options.js');
    if (typeof window.initVocabSettings === 'function') {
      window.initVocabSettings();
    }
  }

  async function ensureLogsPane() {
    await loadLazyScript('api-log.js');
    if (typeof window.initVocabApiLogs === 'function') {
      window.initVocabApiLogs();
    } else if (typeof window.refreshApiLogs === 'function') {
      window.refreshApiLogs();
    }
  }

  function switchToTab(targetTab) {
    tabs.forEach(t => {
      t.classList.toggle('active', t.getAttribute('data-tab') === targetTab);
    });
    if (wordsTab) wordsTab.classList.toggle('hidden', targetTab !== 'words');
    if (testTab) testTab.classList.toggle('hidden', targetTab !== 'test');
    if (settingsTab) settingsTab.classList.toggle('hidden', targetTab !== 'settings');
    if (logsTab) logsTab.classList.toggle('hidden', targetTab !== 'logs');

    if (targetTab === 'settings') {
      ensureSettingsPane().catch((err) => console.warn('settings lazy load', err));
    }
    if (targetTab === 'logs') {
      ensureLogsPane().catch((err) => console.warn('logs lazy load', err));
    }
    // 每次进入单词记忆 tab：显示中间开始页，不自动开测
    if (targetTab === 'test' && window.VocabQuiz && typeof window.VocabQuiz.showStartScreen === 'function') {
      window.VocabQuiz.showStartScreen();
    }
  }

  window.switchVocabTab = switchToTab;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.getAttribute('data-tab');
      switchToTab(targetTab);
    });
  });

  // 支持 ?tab=settings / ?tab=logs / #settings / #test 直达（此时才懒加载对应脚本）
  try {
    const initialTab = new URLSearchParams(location.search).get('tab')
      || (location.hash ? String(location.hash).replace(/^#/, '') : '');
    if (initialTab === 'settings' || initialTab === 'logs' || initialTab === 'test' || initialTab === 'words') {
      switchToTab(initialTab);
    }
  } catch (e) {}

  const userSelect = document.getElementById('userSelect');
  const currentUserName = document.getElementById('currentUserName');
  const addUserBtn = document.getElementById('addUserBtn');

  // 获取当前用户ID
  function getCurrentUserId() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['currentUserId'], (result) => {
        resolve(result.currentUserId || 'default');
      });
    });
  }
  
  // 设置当前用户ID
  function setCurrentUserId(userId) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ currentUserId: userId }, () => {
        resolve();
      });
    });
  }
  
  // 获取所有用户
  function getAllUsers() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['users'], (result) => {
        const users = result.users || {};
        // 如果没有用户，创建默认用户
        if (Object.keys(users).length === 0) {
          users['default'] = { name: '默认用户', createdAt: Date.now() };
          chrome.storage.local.set({ users: users });
        }
        resolve(users);
      });
    });
  }
  
  // 加载用户列表
  async function loadUsers() {
    if (!userSelect || !currentUserName) return;
    
    const users = await getAllUsers();
    const currentUserId = await getCurrentUserId();
    
    userSelect.innerHTML = '<option value="">选择用户...</option>';
    
    Object.keys(users).forEach(userId => {
      const option = document.createElement('option');
      option.value = userId;
      option.textContent = users[userId].name;
      if (userId === currentUserId) {
        option.selected = true;
        currentUserName.textContent = users[userId].name;
      }
      userSelect.appendChild(option);
    });
  }
  
  // 切换用户
  if (userSelect) {
    userSelect.addEventListener('change', async (e) => {
      const userId = e.target.value;
      if (userId) {
        await setCurrentUserId(userId);
        await loadUsers();
        loadStats();
        loadWordList();
        // 通知所有标签页的content script重新加载
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { action: 'reloadWords' }).catch(() => {
              // 忽略无法发送消息的标签页（如chrome://页面）
            });
          });
        });
      }
    });
  }
  
  // —— 悬浮窗：alert / confirm / prompt ——
  const appDialogOverlay = document.getElementById('appDialogOverlay');
  const appDialogTitle = document.getElementById('appDialogTitle');
  const appDialogMessage = document.getElementById('appDialogMessage');
  const appDialogInput = document.getElementById('appDialogInput');
  const appDialogTextarea = document.getElementById('appDialogTextarea');
  const appDialogOk = document.getElementById('appDialogOk');
  const appDialogCancel = document.getElementById('appDialogCancel');
  let appDialogResolver = null;

  function closeAppDialog(result) {
    if (appDialogOverlay) appDialogOverlay.classList.remove('show');
    if (appDialogResolver) {
      const resolve = appDialogResolver;
      appDialogResolver = null;
      resolve(result);
    }
  }

  function openAppDialog({ title, message, mode, defaultValue }) {
    return new Promise((resolve) => {
      if (!appDialogOverlay) {
        resolve(mode === 'prompt' || mode === 'note' ? null : (mode === 'confirm' ? false : undefined));
        return;
      }
      appDialogResolver = resolve;
      if (appDialogTitle) appDialogTitle.textContent = title || '提示';
      if (appDialogMessage) appDialogMessage.textContent = message || '';
      if (appDialogInput) {
        appDialogInput.style.display = mode === 'prompt' ? 'block' : 'none';
        appDialogInput.value = mode === 'prompt' ? String(defaultValue || '') : '';
      }
      if (appDialogTextarea) {
        appDialogTextarea.style.display = mode === 'note' ? 'block' : 'none';
        appDialogTextarea.value = mode === 'note' ? String(defaultValue || '') : '';
      }
      if (appDialogCancel) {
        appDialogCancel.style.display = (mode === 'confirm' || mode === 'prompt' || mode === 'note') ? 'inline-block' : 'none';
      }
      appDialogOverlay.classList.add('show');
      setTimeout(() => {
        if (mode === 'prompt' && appDialogInput) appDialogInput.focus();
        if (mode === 'note' && appDialogTextarea) appDialogTextarea.focus();
        if (mode === 'alert' && appDialogOk) appDialogOk.focus();
      }, 0);
    });
  }

  window.showAppAlert = (message, title) => openAppDialog({ title: title || '提示', message, mode: 'alert' });
  window.showAppConfirm = (message, title) => openAppDialog({ title: title || '确认', message, mode: 'confirm' });
  window.showAppPrompt = (message, defaultValue, title) => openAppDialog({
    title: title || '输入',
    message,
    mode: 'prompt',
    defaultValue
  });
  window.showAppNotePrompt = (message, defaultValue, title) => openAppDialog({
    title: title || '备注',
    message,
    mode: 'note',
    defaultValue
  });

  if (appDialogOk) {
    appDialogOk.addEventListener('click', () => {
      if (appDialogInput && appDialogInput.style.display !== 'none') {
        closeAppDialog(appDialogInput.value);
        return;
      }
      if (appDialogTextarea && appDialogTextarea.style.display !== 'none') {
        closeAppDialog(appDialogTextarea.value);
        return;
      }
      // confirm → true; alert → undefined
      const isConfirm = appDialogCancel && appDialogCancel.style.display !== 'none'
        && (!appDialogInput || appDialogInput.style.display === 'none')
        && (!appDialogTextarea || appDialogTextarea.style.display === 'none');
      closeAppDialog(isConfirm ? true : undefined);
    });
  }
  if (appDialogCancel) {
    appDialogCancel.addEventListener('click', () => {
      const isPromptLike = (appDialogInput && appDialogInput.style.display !== 'none')
        || (appDialogTextarea && appDialogTextarea.style.display !== 'none');
      closeAppDialog(isPromptLike ? null : false);
    });
  }
  if (appDialogOverlay) {
    appDialogOverlay.addEventListener('click', (e) => {
      if (e.target === appDialogOverlay) {
        const isPromptLike = (appDialogInput && appDialogInput.style.display !== 'none')
          || (appDialogTextarea && appDialogTextarea.style.display !== 'none');
        const isConfirm = appDialogCancel && appDialogCancel.style.display !== 'none' && !isPromptLike;
        closeAppDialog(isPromptLike ? null : (isConfirm ? false : undefined));
      }
    });
  }

  // 添加用户
  if (addUserBtn) {
    addUserBtn.addEventListener('click', async () => {
      const userName = await window.showAppPrompt('请输入用户名：', '', '添加用户');
      if (userName && userName.trim()) {
        const users = await getAllUsers();
        const userId = 'user_' + Date.now();
        users[userId] = {
          name: userName.trim(),
          createdAt: Date.now()
        };
        chrome.storage.local.set({ users: users }, async () => {
          await setCurrentUserId(userId);
          await loadUsers();
          loadStats();
          loadWordList();
        });
      }
    });
  }

  // 加载单词统计
  async function loadStats() {
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    
    chrome.storage.local.get([`${userKey}savedWords`, `${userKey}wordStatus`], (result) => {
      const savedWords = result[`${userKey}savedWords`] || [];
      const statuses = new Map(result[`${userKey}wordStatus`] || []);
      
      const total = savedWords.length;
      const mastered = Array.from(statuses.values()).filter(s => s === 'mastered').length;
      const newCount = total - mastered;

      totalCountEl.textContent = total;
      masteredCountEl.textContent = mastered;
      newCountEl.textContent = newCount;
    });
  }

  const wordDetailOverlay = document.getElementById('wordDetailOverlay');
  const wordDetailTitle = document.getElementById('wordDetailTitle');
  const wordDetailBody = document.getElementById('wordDetailBody');
  const wordDetailClose = document.getElementById('wordDetailClose');

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

  // 是否已有英英释义（中文释义不算“详情已齐全”）
  function hasEnglishDefinitions(dictData) {
    if (!hasRichMeanings(dictData)) return false;
    return dictData.meanings.some((m) =>
      (m.definitions || []).some((d) => isEnglishDefText(d && d.definition))
    );
  }

  function extractZhMeanings(dictData) {
    if (!dictData) return [];
    if (Array.isArray(dictData.zhMeanings) && dictData.zhMeanings.length) {
      return dictData.zhMeanings;
    }
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
          bucket.definitions.push({
            definition: def,
            example: (d && d.example) || undefined
          });
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
      out.push({
        partOfSpeech: m.partOfSpeech || '',
        definitions: defs,
        synonyms: m.synonyms || []
      });
    });
    return out;
  }

  function isTransientDictError(err) {
    const e = String(err || '');
    return /^http_5\d\d$/.test(e) || /timeout|abort|Failed to fetch|NetworkError|network|empty_body/i.test(e);
  }

  function isLookupMiss(dictData) {
    return !!(dictData && dictData.lookupMiss === true);
  }

  function isDetailCached(dictData) {
    // 仅当已有英英释义并落盘时，才视为详情缓存完成
    if (!dictData || !hasEnglishDefinitions(dictData)) return false;
    if (dictData.detailCached === true) return true;
    const src = dictData.sourceAbbr;
    return src === 'deepseek' || src === 'wordsapi' || src === 'fd' || src === 'datamuse' || src === 'api';
  }

  // 有英英详情才算完成；旧版 miss（无英英 / 未跑完链路）允许自动重试
  function isLookupSettled(dictData) {
    if (!dictData) return false;
    if (hasEnglishDefinitions(dictData) && (dictData.detailCached === true || isDetailCached(dictData))) {
      return true;
    }
    if (isLookupMiss(dictData) && hasEnglishDefinitions(dictData)) return true;
    if (isLookupMiss(dictData) && dictData.lookupFullChainTried === true) return true;
    return false;
  }

  function mergeDictData(base, incoming) {
    if (!incoming) return base || null;
    if (!base) {
      const zh0 = extractZhMeanings(incoming);
      const en0 = hasEnglishDefinitions(incoming)
        ? englishOnlyMeanings(incoming.meanings)
        : (incoming.meanings || []);
      const zhSrc0 = incoming.translationSource || incoming.zhSourceAbbr ||
        (!hasEnglishDefinitions(incoming) ? (incoming.sourceAbbr || '') : '');
      return {
        ...incoming,
        meanings: en0.length ? en0 : (incoming.meanings || []),
        zhMeanings: zh0,
        translation: preferZhText(incoming.translation, zhMeaningsToTranslation(zh0)),
        translationSource: zhSrc0 || '',
        zhSourceAbbr: zhSrc0 || '',
        enSourceAbbr: hasEnglishDefinitions(incoming)
          ? (incoming.enSourceAbbr || incoming.sourceAbbr || '')
          : (incoming.enSourceAbbr || ''),
        sources: collectSourceCodes(incoming)
      };
    }
    const phonetics = (incoming.phonetics && incoming.phonetics.length)
      ? incoming.phonetics
      : ((base.phonetics && base.phonetics.length) ? base.phonetics : []);

    // 中文义项单独合并，避免被英英 meanings 覆盖
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

    const sources = collectSourceCodes(base);
    collectSourceCodes(incoming).forEach((c) => {
      if (c && !sources.includes(c)) sources.push(c);
    });

    const fromZh = zhMeaningsToTranslation(zhMeanings);
    let translation = preferZhText(base.translation, incoming.translation);
    translation = preferZhText(translation, fromZh);
    let translationSource = base.translationSource || base.zhSourceAbbr || '';
    if (translation && translation === String(incoming.translation || '').trim()) {
      const incomingZhSrc = incoming.translationSource || incoming.zhSourceAbbr ||
        (!hasEnglishDefinitions(incoming) ? (incoming.sourceAbbr || '') : '');
      translationSource = incomingZhSrc || translationSource;
    } else if (translation && translation === fromZh) {
      const incomingZhSrc = incoming.translationSource || incoming.zhSourceAbbr ||
        (!hasEnglishDefinitions(incoming) ? (incoming.sourceAbbr || '') : '');
      translationSource = translationSource || incomingZhSrc || '';
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

  // DeepSeek 仅手动按钮；打开详情时可用免费 Free Dictionary 自动补全并缓存
  const ENABLE_DEEPSEEK_API = true;

  function hasDeepseekCached(dictData) {
    return !!(dictData && dictData.sourceAbbr === 'deepseek' && hasRichMeanings(dictData));
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
    const nextSource = source || dictData.sourceAbbr || 'api';
    const prevSources = Array.isArray(dictData.sources)
      ? dictData.sources.slice()
      : (dictData.sourceAbbr ? [dictData.sourceAbbr] : []);
    if (nextSource && !prevSources.includes(nextSource)) {
      prevSources.push(nextSource);
    }
    return {
      ...dictData,
      detailCached: true,
      cachedAt: Date.now(),
      sourceAbbr: nextSource,
      sources: prevSources,
      lookupMiss: false,
      lookupMissReason: '',
      lookupMissAt: undefined
    };
  }

  function collectSourceCodes(dictData) {
    if (!dictData) return [];
    const codes = [];
    const push = (code) => {
      if (!code || codes.includes(code)) return;
      codes.push(code);
    };
    if (Array.isArray(dictData.sources)) {
      dictData.sources.forEach(push);
    }
    push(dictData.sourceAbbr);
    (dictData.phonetics || []).forEach((p) => push(p && p.source));
    return codes;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  const DETAIL_SOURCE_LABELS = {
    ...CHINESE_SOURCE_LABELS,
    fd: 'Free Dictionary',
    datamuse: 'Datamuse',
    wordsapi: 'WordsAPI',
    api: '在线词典',
    miss: '无结果'
  };

  function chineseSourceLabel(code) {
    if (!code) return '';
    return CHINESE_SOURCE_LABELS[code] || String(code);
  }

  function detailSourceLabel(code) {
    if (!code || code === 'miss') return '';
    return DETAIL_SOURCE_LABELS[code] || String(code);
  }

  function resolveZhSourceCode(dictData, chineseSourceCode) {
    if (!dictData && !chineseSourceCode) return '';
    const raw = (dictData && (dictData.translationSource || dictData.zhSourceAbbr)) ||
      chineseSourceCode ||
      '';
    if (raw && raw !== 'miss' && raw !== 'fd' && raw !== 'datamuse') return raw;
    // 从履历里找中文源
    const sources = collectSourceCodes(dictData || {});
    const zhHit = sources.find((c) =>
      c === 'ecd' || c === 'offline' || c === 'youdao_dict' || c === 'd3325' ||
      c === 'youdao' || c === 'deepseek' || c === 'gt' || c === 'bd' || c === 'mm' || c === 'bing'
    );
    return zhHit || raw || '';
  }

  function resolveEnSourceCode(dictData) {
    if (!dictData) return '';
    if (dictData.enSourceAbbr) return dictData.enSourceAbbr;
    const src = dictData.sourceAbbr || '';
    if (src === 'fd' || src === 'datamuse' || src === 'deepseek' || src === 'wordsapi' || src === 'api') {
      return src;
    }
    const sources = collectSourceCodes(dictData);
    return sources.find((c) => c === 'fd' || c === 'datamuse' || c === 'deepseek' || c === 'wordsapi') || '';
  }

  function formatChineseWithSource(text, sourceCode) {
    const body = String(text || '').trim();
    if (!body) return '';
    const label = chineseSourceLabel(sourceCode);
    if (!label) return body;
    return `${body}<span class="zh-source-tag"> · ${escapeHtml(label)}</span>`;
  }

  async function saveWordChineseSource(word, source) {
    const src = String(source || '').trim();
    const lower = String(word || '').toLowerCase();
    if (!lower || !src) return;
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const key = `${userKey}wordChineseSources`;
    const result = await new Promise((resolve) => {
      chrome.storage.local.get([key], resolve);
    });
    const map = new Map(result[key] || []);
    map.set(lower, src);
    if (word && word !== lower) map.set(word, src);
    await new Promise((resolve) => {
      chrome.storage.local.set({ [key]: Array.from(map.entries()) }, resolve);
    });
  }

  async function getWordChineseSource(word) {
    const lower = String(word || '').toLowerCase();
    if (!lower) return '';
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const key = `${userKey}wordChineseSources`;
    const result = await new Promise((resolve) => {
      chrome.storage.local.get([key], resolve);
    });
    const map = new Map(result[key] || []);
    return map.get(word) || map.get(lower) || '';
  }

  function renderDeepseekActionHtml(dictData) {
    if (hasDeepseekCached(dictData)) {
      return `<div class="deepseek-action-row done">已用 DeepSeek 补全并缓存</div>`;
    }
    return `<div class="deepseek-action-row">
      <button type="button" class="btn-deepseek-enrich" id="wordDetailDeepseekBtn">用 DeepSeek 补全用法/例句</button>
      <span class="deepseek-action-hint">付费 API，仅当前词；结果会缓存</span>
    </div>`;
  }

  function renderWordDetailHtml(word, dictData, fallbackTranslation, chineseSourceCode) {
    let html = '';

    if (!dictData) {
      html += `<div class="word-detail-phonetic" title="点击播放读音">`;
      html += `<span class="word-detail-phonetic-text muted">暂无音标</span>`;
      html += `<button type="button" class="word-detail-speak" data-word="${escapeHtml(word)}" data-type="1" title="英音">🔊 英</button>`;
      html += `<button type="button" class="word-detail-speak" data-word="${escapeHtml(word)}" data-type="2" title="美音">🔊 美</button>`;
      html += `</div>`;
      html += `
        <div class="word-detail-loading">
          <p>暂无详细信息</p>
          <p style="margin-top:8px;">翻译：${escapeHtml(fallbackTranslation || '暂无')}</p>
        </div>
      `;
      html += renderDeepseekActionHtml(dictData);
      return html;
    }

    if (!hasEnglishDefinitions(dictData) || !extractZhMeanings(dictData).length) {
      html += `<div class="word-detail-actions" style="margin:0 0 8px;">
        <button type="button" class="btn-detail-refresh" id="wordDetailRefreshBtn">重新获取释义</button>
      </div>`;
    }

    {
      const phonetic = (dictData.phonetics || []).find((p) => p && p.text) || null;
      const phoneticText = phonetic && phonetic.text ? String(phonetic.text).trim() : '';
      html += `<div class="word-detail-phonetic" title="点击播放读音">`;
      if (phoneticText) {
        html += `<span class="word-detail-phonetic-text">/${escapeHtml(phoneticText)}/</span>`;
      } else {
        html += `<span class="word-detail-phonetic-text muted">暂无音标</span>`;
      }
      html += `<button type="button" class="word-detail-speak" data-word="${escapeHtml(word)}" data-type="1" title="英音">🔊 英</button>`;
      html += `<button type="button" class="word-detail-speak" data-word="${escapeHtml(word)}" data-type="2" title="美音">🔊 美</button>`;
      html += `</div>`;
    }
    if (dictData.usage) {
      html += `<div class="word-detail-usage">用法：${escapeHtml(dictData.usage)}</div>`;
    }
    const zhMeanings = extractZhMeanings(dictData);
    const translation = dictData.translation || fallbackTranslation || '';
    const zhSrc = resolveZhSourceCode(dictData, chineseSourceCode);
    const zhLabel = detailSourceLabel(zhSrc);
    const enSrc = resolveEnSourceCode(dictData);
    const enLabel = detailSourceLabel(enSrc);

    html += `<div class="word-detail-section-title">中文释义`;
    if (zhLabel) {
      html += `<span class="word-detail-source-tag" title="中文来源">来源：${escapeHtml(zhLabel)}</span>`;
    }
    html += `</div>`;
    if (zhMeanings.length) {
      zhMeanings.forEach((meaning) => {
        html += `<div class="word-detail-pos">${escapeHtml(meaning.partOfSpeech || '')}</div>`;
        (meaning.definitions || []).slice(0, 8).forEach((def, index) => {
          html += `<div class="word-detail-def">`;
          html += `<div class="word-detail-def-text">${index + 1}. ${escapeHtml(def.definition || '')}</div>`;
          if (def.example) {
            html += `<div class="word-detail-example">${escapeHtml(def.example)}</div>`;
          }
          html += `</div>`;
        });
      });
    } else if (translation) {
      html += `<div class="word-detail-translation">${escapeHtml(translation)}</div>`;
    } else {
      html += `<div class="word-detail-loading">暂无中文释义</div>`;
    }

    const enMeanings = englishOnlyMeanings(dictData.meanings);
    html += `<div class="word-detail-section-title" style="margin-top:12px;">英英释义`;
    if (enLabel) {
      html += `<span class="word-detail-source-tag" title="英文来源">来源：${escapeHtml(enLabel)}</span>`;
    }
    html += `</div>`;
    if (enMeanings.length) {
      enMeanings.forEach((meaning) => {
        html += `<div class="word-detail-pos">${escapeHtml(meaning.partOfSpeech || '')}</div>`;
        (meaning.definitions || []).slice(0, 3).forEach((def, index) => {
          html += `<div class="word-detail-def">`;
          html += `<div class="word-detail-def-text">${index + 1}. ${escapeHtml(def.definition || '')}</div>`;
          if (def.example) {
            html += `<div class="word-detail-example">${escapeHtml(def.example)}</div>`;
          }
          html += `</div>`;
        });
      });
    } else {
      html += `<div class="word-detail-loading">暂无英文释义/例句</div>`;
    }

    // 底部：汇总来源 + DeepSeek 补全
    const srcMap = {
      deepseek: 'DeepSeek',
      wordsapi: 'WordsAPI',
      fd: 'Free Dictionary API',
      datamuse: 'Datamuse 词典',
      ecd: '离线英汉词典',
      api: '在线词典 API',
      miss: '在线词典无结果',
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
    const sourceParts = [];
    if (isLookupMiss(dictData) && !hasEnglishDefinitions(dictData)) {
      sourceParts.push(`暂未找到英英释义${dictData.lookupMissReason ? '（' + dictData.lookupMissReason + '）' : ''}`);
    } else if (dictData.sourceAbbr && dictData.sourceAbbr !== 'miss') {
      sourceParts.push(`当前释义：${srcMap[dictData.sourceAbbr] || dictData.sourceAbbr}`);
    }
    const allSources = collectSourceCodes(dictData)
      .filter((code) => code !== dictData.sourceAbbr && code !== 'miss')
      .map((code) => srcMap[code] || code);
    if (allSources.length) {
      sourceParts.push(`也曾使用：${allSources.join('、')}`);
    }
    const phoneticForSource = (dictData.phonetics || []).find((p) => p && p.text) || null;
    if (phoneticForSource && phoneticForSource.source) {
      sourceParts.push(`音标：${srcMap[phoneticForSource.source] || phoneticForSource.source}`);
    }
    if (dictData.detailCached && !isLookupMiss(dictData)) sourceParts.push('已缓存到本地');
    if (sourceParts.length) {
      html += `<div class="word-detail-meta" style="margin-top:14px;">来源：${escapeHtml(sourceParts.join(' · '))}</div>`;
    }
    html += renderDeepseekActionHtml(dictData);

    return html;
  }

  async function parseJsonResponseSafe(response) {
    const text = await response.text();
    if (!text || !String(text).trim()) {
      return { ok: false, error: 'empty_body', data: null };
    }
    try {
      return { ok: true, error: '', data: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: 'invalid_json', data: null };
    }
  }

  function buildMorphologyBases(lowerWord) {
    const lower = String(lowerWord || '').toLowerCase();
    if (!lower || lower.length < 3) return [];
    const bases = [];
    const push = (v) => {
      const s = String(v || '').toLowerCase();
      if (s && s !== lower && s.length >= 2) bases.push(s);
    };
    // thumbkins → thumbkin；cities → city
    if (lower.length > 4 && lower.endsWith('ies')) push(lower.slice(0, -3) + 'y');
    if (lower.length > 4 && lower.endsWith('ves')) {
      push(lower.slice(0, -3) + 'f');
      push(lower.slice(0, -3) + 'fe');
    }
    if (lower.length > 4 && /(ches|shes|sses|xes|zes)$/.test(lower)) push(lower.slice(0, -2));
    else if (lower.length > 3 && lower.endsWith('es')) push(lower.slice(0, -2));
    if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) push(lower.slice(0, -1));
    if (lower.length > 5 && lower.endsWith('ing')) {
      push(lower.slice(0, -3));
      push(lower.slice(0, -3) + 'e');
    }
    if (lower.length > 4 && lower.endsWith('ed')) {
      push(lower.slice(0, -2));
      push(lower.slice(0, -1));
    }
    return bases.filter((v, i) => bases.indexOf(v) === i);
  }

  function queryOfflineLemma(word) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'queryLemma', word }, (response) => {
          if (chrome.runtime.lastError) {
            resolve('');
            return;
          }
          resolve((response && response.lemma) || '');
        });
      } catch (e) {
        resolve('');
      }
    });
  }

  async function buildFreeDictionaryVariants(word) {
    const clean = String(word || '').trim();
    if (!clean) return [];
    const lower = clean.toLowerCase();
    const titled = lower.charAt(0).toUpperCase() + lower.slice(1);
    const variants = [clean, lower, titled];
    buildMorphologyBases(lower).forEach((base) => {
      variants.push(base);
      variants.push(base.charAt(0).toUpperCase() + base.slice(1));
    });
    const lemma = await queryOfflineLemma(lower);
    if (lemma) {
      const lemmaLower = String(lemma).toLowerCase();
      variants.push(lemmaLower);
      variants.push(lemmaLower.charAt(0).toUpperCase() + lemmaLower.slice(1));
    }
    return variants.filter((v, i) => v && variants.indexOf(v) === i);
  }

  function convertDatamuseToDictFormat(word, payload) {
    if (!payload || !Array.isArray(payload.defs) || !payload.defs.length) return null;
    const posMap = {
      n: 'noun',
      v: 'verb',
      adj: 'adjective',
      adv: 'adverb',
      u: 'unknown'
    };
    const byPos = new Map();
    payload.defs.forEach((raw) => {
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
    if (!meanings.length) return null;
    return {
      word,
      phonetics: [],
      meanings,
      translation: '',
      usage: '',
      sourceAbbr: 'datamuse'
    };
  }

  async function fetchDatamuseFallback(word) {
    const cleanWord = String(word || '').trim();
    if (!cleanWord) return null;
    const startedAt = Date.now();
    const queries = await buildFreeDictionaryVariants(cleanWord);
    let lastError = 'empty_result';

    for (let i = 0; i < queries.length; i++) {
      const query = String(queries[i] || '').toLowerCase();
      if (!query) continue;
      try {
        const url = `https://api.datamuse.com/words?sp=${encodeURIComponent(query)}&md=d&max=1`;
        const response = await fetch(url);
        if (!response.ok) {
          lastError = `http_${response.status}`;
          continue;
        }
        const parsed = await parseJsonResponseSafe(response);
        if (!parsed.ok || !Array.isArray(parsed.data) || !parsed.data[0]) {
          lastError = parsed.ok ? 'empty_result' : (parsed.error || 'invalid_json');
          continue;
        }
        const converted = convertDatamuseToDictFormat(cleanWord, parsed.data[0]);
        if (converted && hasRichMeanings(converted)) {
          appendDeepseekLog({
            word: cleanWord,
            success: true,
            api: 'datamuse',
            source: 'main-datamuse',
            durationMs: Date.now() - startedAt,
            detail: `meanings=${converted.meanings.length}; fallback_after_fd` +
              (query !== cleanWord.toLowerCase() ? `; query=${query}` : '')
          });
          return converted;
        }
        lastError = 'empty_result';
      } catch (e) {
        lastError = (e && e.message) || 'request_failed';
      }
    }

    appendDeepseekLog({
      word: cleanWord,
      success: false,
      error: lastError,
      api: 'datamuse',
      source: 'main-datamuse',
      durationMs: Date.now() - startedAt
    });
    return null;
  }

  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  function getApiRouteConfig() {
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

  async function fetchOfflineDictionaryData(word) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'queryOfflineDictData', word }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response && response.success ? (response.data || null) : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function normalizeOfflineDictHit(word, offline) {
    if (!offline) return null;
    const translation = offline.translation || offline.translation_zh || '';
    const meanings = offline.meanings || [];
    const phonetics = offline.phonetics || (offline.phonetic ? [{ text: offline.phonetic }] : []);
    if (!translation && !(meanings && meanings.length) && !(phonetics && phonetics.length)) {
      return null;
    }
    const zhMeanings = (meanings && meanings.length)
      ? meanings
      : (translation
        ? [{ partOfSpeech: '释义', definitions: [{ definition: translation }] }]
        : []);
    return {
      word: String(word || '').trim(),
      phonetics,
      meanings: zhMeanings,
      zhMeanings,
      translation,
      translationSource: 'ecd',
      usage: offline.usage || '',
      sourceAbbr: 'ecd'
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
        if (m) { pos = m[1]; def = m[2]; }
        let bucket = meanings.find((x) => x.partOfSpeech === pos);
        if (!bucket) {
          bucket = { partOfSpeech: pos || '释义', definitions: [] };
          meanings.push(bucket);
        }
        bucket.definitions.push({ definition: def });
      });
    });
    const pairs = data.blng_sents_part && Array.isArray(data.blng_sents_part['sentence-pair'])
      ? data.blng_sents_part['sentence-pair'] : [];
    if (meanings.length && pairs.length) {
      const eng = String((pairs[0] && (pairs[0]['sentence-eng'] || pairs[0].sentence)) || '').trim();
      if (eng && meanings[0].definitions[0] && !meanings[0].definitions[0].example) {
        meanings[0].definitions[0].example = eng;
      }
    }
    const translation = meanings
      .map((m) => {
        const defs = (m.definitions || []).map((d) => d.definition).filter(Boolean).join('，');
        if (!defs) return '';
        const pos = String(m.partOfSpeech || '').trim();
        return pos ? `${pos} ${defs}` : defs;
      })
      .filter(Boolean).join('；');
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
      const resp = await fetch(`https://dict.youdao.com/jsonapi?q=${encodeURIComponent(text)}`);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const data = await resp.json();
      const parsed = parseYoudaoJsonapiToDict(text, data);
      appendDeepseekLog({
        word: text, success: !!parsed, error: parsed ? '' : 'empty_result',
        api: 'youdao_dict', source: 'main-youdao-dict', durationMs: Date.now() - startedAt
      });
      return parsed;
    } catch (e) {
      appendDeepseekLog({
        word: text, success: false, error: (e && e.message) || 'failed',
        api: 'youdao_dict', source: 'main-youdao-dict', durationMs: Date.now() - startedAt
      });
      return null;
    }
  }

  async function fetch3325DictDetail(word) {
    const text = String(word || '').trim();
    if (!text) return null;
    const startedAt = Date.now();
    try {
      const resp = await fetch(`https://3325.cn/api/word/${encodeURIComponent(text)}`);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const json = await resp.json();
      const data = json && json.data;
      if (!(json && json.code === 200 && data)) throw new Error('empty_result');
      const phonetics = [];
      if (data.british) phonetics.push({ text: String(data.british).replace(/^\[|\]$/g, ''), source: '3325_uk' });
      if (data.american) phonetics.push({ text: String(data.american).replace(/^\[|\]$/g, ''), source: '3325_us' });
      const translation = String(data.jbjs || '').trim();
      const meanings = translation
        ? [{ partOfSpeech: String(data.cx || '释义').trim(), definitions: [{ definition: translation }] }]
        : [];
      if (!meanings.length && !phonetics.length) throw new Error('empty_result');
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
      appendDeepseekLog({
        word: text, success: true, api: 'd3325', source: 'main-3325', durationMs: Date.now() - startedAt
      });
      return parsed;
    } catch (e) {
      appendDeepseekLog({
        word: text, success: false, error: (e && e.message) || 'failed',
        api: 'd3325', source: 'main-3325', durationMs: Date.now() - startedAt
      });
      return null;
    }
  }

  async function fetchFreeDictionaryForWord(word) {
    const route = await getApiRouteConfig();
    const cleanWord = String(word || '').trim();
    const slots = resolveDetailSlots(route);
    let merged = null;
    let lastError = 'request_failed';
    let lastTransient = false;

    // 仅音标不算中文命中，否则会挡住备源补中文释义
    const hasChineseHit = (hit) => !!(hit && (
      String(hit.translation || '').trim() ||
      (hit.zhMeanings && hit.zhMeanings.length) ||
      extractZhMeanings(hit).length
    ));

    async function fetchZhById(id) {
      if (id === 'offline') {
        return normalizeOfflineDictHit(cleanWord, await fetchOfflineDictionaryData(cleanWord));
      }
      if (id === 'youdao_dict') return fetchYoudaoDictDetail(cleanWord);
      if (id === 'd3325') return fetch3325DictDetail(cleanWord);
      return null;
    }

    async function fetchFdHit() {
      const startedAt = Date.now();
      const variants = await buildFreeDictionaryVariants(cleanWord);
      let retried5xx = 0;
      for (let vi = 0; vi < variants.length; vi++) {
        const variant = variants[vi];
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(variant)}`;
            const response = await fetch(url);
            if (!response.ok) {
              lastError = `http_${response.status}`;
              if (response.status === 404) break;
              if (response.status >= 500 && attempt < 2) {
                retried5xx += 1;
                await sleepMs(350 * (attempt + 1));
                continue;
              }
              break;
            }
            const parsed = await parseJsonResponseSafe(response);
            if (!parsed.ok) {
              lastError = parsed.error || 'invalid_json';
              if (attempt < 2) {
                await sleepMs(250 * (attempt + 1));
                continue;
              }
              break;
            }
            const entry = parsed.data && parsed.data[0] ? parsed.data[0] : null;
            if (!entry || !hasRichMeanings(entry)) {
              lastError = 'empty_result';
              break;
            }
            appendDeepseekLog({
              word: cleanWord,
              success: true,
              api: 'freedictionary',
              source: 'main-fd',
              durationMs: Date.now() - startedAt,
              detail: `meanings=${(entry.meanings || []).length}` +
                (variant !== cleanWord ? `; query=${variant}` : '') +
                (retried5xx ? `; retried5xx=${retried5xx}` : '')
            });
            return {
              word: cleanWord,
              phonetics: entry.phonetics || [],
              meanings: entry.meanings || [],
              translation: entry.translation || '',
              usage: '',
              sourceAbbr: 'fd'
            };
          } catch (e) {
            const raw = (e && e.message) || 'request_failed';
            lastError = /Unexpected end of JSON input/i.test(raw) ? 'empty_body' : raw;
            if (attempt < 2) {
              await sleepMs(300 * (attempt + 1));
              continue;
            }
          }
        }
      }
      lastTransient = isTransientDictError(lastError);
      appendDeepseekLog({
        word: cleanWord,
        success: false,
        error: lastError,
        api: 'freedictionary',
        source: 'main-fd',
        durationMs: Date.now() - startedAt,
        detail: 'en_primary_or_backup_miss' + (retried5xx ? `; retried5xx=${retried5xx}` : '')
      });
      return null;
    }

    async function fetchEnById(id) {
      if (id === 'fd') return fetchFdHit();
      if (id === 'datamuse') return fetchDatamuseFallback(cleanWord);
      return null;
    }

    // 中文：主 →（失败才）备
    for (const id of [slots.zhPrimary, slots.zhBackup]) {
      if (!id) continue;
      const hit = await fetchZhById(id);
      if (!hasChineseHit(hit)) continue;
      merged = mergeDictData(merged, hit);
      appendDeepseekLog({
        word: cleanWord,
        success: true,
        api: id === 'offline' ? 'offline' : id,
        source: id === 'offline' ? 'main-ecd' : (id === 'youdao_dict' ? 'main-youdao-dict' : 'main-3325'),
        detail: id === slots.zhPrimary ? 'zh_primary_hit' : 'zh_backup_hit'
      });
      break;
    }

    // 英文：主 →（失败才）备
    for (const id of [slots.enPrimary, slots.enBackup]) {
      if (!id) continue;
      const hit = await fetchEnById(id);
      if (!(hit && (hasEnglishDefinitions(hit) || hasRichMeanings(hit)))) continue;
      merged = mergeDictData(merged, hit);
      if (hasEnglishDefinitions(merged)) break;
    }

    if (hasEnglishDefinitions(merged)) return merged;
    if (merged && (merged.translation || hasRichMeanings(merged) || (merged.phonetics && merged.phonetics.length))) {
      return { ...merged, __partialOnly: true };
    }

    return {
      __lookupFailed: true,
      __lookupError: lastError,
      __lookupTransient: lastTransient || isTransientDictError(lastError)
    };
  }

  async function saveWordDictionaryData(word, dictData) {
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const key = `${userKey}wordDictionaryData`;
    const result = await new Promise((resolve) => {
      chrome.storage.local.get([key], resolve);
    });
    const map = new Map(result[key] || []);
    const lower = word.toLowerCase();
    map.set(lower, dictData);
    if (map.has(word) && word !== lower) map.set(word, dictData);
    const payload = {};
    payload[key] = Array.from(map.entries());
    await new Promise((resolve) => chrome.storage.local.set(payload, resolve));
  }

  function sanitizeApiKey(key) {
    return String(key || '')
      .replace(/^\uFEFF/, '')
      .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
      .replace(/[“”‘’]/g, '')
      .trim()
      .replace(/[^\x21-\x7E]/g, '');
  }

  function extractJsonObject(text) {
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
    const translation = payload.translation || payload.chinese || '';
    return {
      word,
      phonetics,
      meanings,
      translation,
      translationSource: translation ? 'deepseek' : '',
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

  // 同一单词进行中的 DeepSeek 请求去重，避免连点/并发打两次
  const deepseekInflight = new Map();

  // 扩展页直接请求 DeepSeek，避免 MV3 service worker 长请求导致 message port closed
  async function fetchDeepseekForWord(word) {
    if (!ENABLE_DEEPSEEK_API) {
      return { ok: false, error: 'deepseek_disabled' };
    }
    const cleanWord = String(word || '').trim();
    if (!cleanWord) {
      return { ok: false, error: 'empty_word' };
    }
    const inflightKey = cleanWord.toLowerCase();
    if (deepseekInflight.has(inflightKey)) {
      return deepseekInflight.get(inflightKey);
    }

    const requestPromise = (async () => {
      const startedAt = Date.now();
      const keyResult = await new Promise((resolve) => {
        chrome.storage.local.get(['deepseekApiKey'], resolve);
      });
      const apiKey = sanitizeApiKey(keyResult.deepseekApiKey || '');
      if (!apiKey) {
        appendDeepseekLog({
          word: cleanWord,
          success: false,
          error: 'missing_deepseek_key',
          source: 'main-direct',
          durationMs: Date.now() - startedAt
        });
        return { ok: false, error: 'missing_deepseek_key' };
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
                  `For the English word "${cleanWord}", return JSON with this schema:\n` +
                  `{"word":"${cleanWord}","phonetic":"IPA without slashes","translation":"简体中文释义",` +
                  `"usage":"一句话说明常见用法（中文）","meanings":[{"partOfSpeech":"noun|verb|...",` +
                  `"definitions":[{"definition":"simple English definition","example":"one natural example sentence"}],` +
                  `"synonyms":["optional"]}]}\n` +
                  `Rules: focus on common senses (max 2); each sense 1 definition with example; CEFR A2-B1; JSON only.`
              }
            ]
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          const error = `http_${response.status}`;
          appendDeepseekLog({
            word: cleanWord,
            success: false,
            error,
            detail: errText.slice(0, 300),
            source: 'main-direct',
            durationMs: Date.now() - startedAt
          });
          return { ok: false, error, detail: errText.slice(0, 180) };
        }

        const raw = await response.json();
        const content = raw && raw.choices && raw.choices[0] && raw.choices[0].message
          ? raw.choices[0].message.content
          : '';
        const parsed = extractJsonObject(content);
        const data = convertDeepseekToDictFormat(cleanWord, parsed);
        if (!data || !hasRichMeanings(data)) {
          appendDeepseekLog({
            word: cleanWord,
            success: false,
            error: 'empty_result',
            source: 'main-direct',
            durationMs: Date.now() - startedAt
          });
          return { ok: false, error: 'empty_result' };
        }

        appendDeepseekLog({
          word: cleanWord,
          success: true,
          source: 'main-direct',
          durationMs: Date.now() - startedAt
        });
        return { ok: true, data };
      } catch (error) {
        const msg = error && error.name === 'AbortError' ? 'timeout' : ((error && error.message) || 'request_failed');
        appendDeepseekLog({
          word: cleanWord,
          success: false,
          error: msg,
          source: 'main-direct',
          durationMs: Date.now() - startedAt
        });
        return { ok: false, error: msg };
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    deepseekInflight.set(inflightKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      deepseekInflight.delete(inflightKey);
    }
  }

  function speakWord(word, type = 2) {
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
        source: 'main-tts',
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

  function bindWordDetailSpeakButtons(word) {
    if (!wordDetailBody) return;
    wordDetailBody.querySelectorAll('.word-detail-speak').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const w = btn.getAttribute('data-word') || word;
        const type = parseInt(btn.getAttribute('data-type'), 10) || 2;
        speakWord(w, type);
      });
    });
    const phoneticEl = wordDetailBody.querySelector('.word-detail-phonetic');
    if (phoneticEl) {
      phoneticEl.addEventListener('click', (e) => {
        if (e.target.closest('.word-detail-speak')) return;
        speakWord(word, 2);
      });
    }
  }

  function closeWordDetail() {
    if (wordDetailOverlay) wordDetailOverlay.classList.remove('show');
  }

  function bindWordDetailDeepseekButton(word, fallbackTranslation, requestId) {
    const btn = document.getElementById('wordDetailDeepseekBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'DeepSeek 请求中...';

      const onlineResult = await fetchDeepseekForWord(word);
      if (wordDetailOverlay.dataset.requestId !== requestId) return;

      if (onlineResult && onlineResult.ok && hasRichMeanings(onlineResult.data)) {
        const currentUserId = await getCurrentUserId();
        const userKey = `user_${currentUserId}_`;
        const result = await new Promise((resolve) => {
          chrome.storage.local.get([`${userKey}wordDictionaryData`], resolve);
        });
        const rawDict = result[`${userKey}wordDictionaryData`] || [];
        const dictMap = new Map(Array.isArray(rawDict) ? rawDict : Object.entries(rawDict || {}));
        const lower = word.toLowerCase();
        const existing = dictMap.get(word) || dictMap.get(lower) || null;
        const priorSources = Array.isArray(existing && existing.sources)
          ? existing.sources.slice()
          : ((existing && existing.sourceAbbr) ? [existing.sourceAbbr] : []);
        if (existing && existing.sourceAbbr && !priorSources.includes(existing.sourceAbbr)) {
          priorSources.push(existing.sourceAbbr);
        }
        if (!priorSources.includes('deepseek')) priorSources.push('deepseek');
        const dsTranslation = onlineResult.data.translation
          || (existing && existing.translation)
          || fallbackTranslation
          || '';
        const dictData = markDetailCached({
          ...(existing || {}),
          ...onlineResult.data,
          translation: dsTranslation,
          translationSource: onlineResult.data.translation ? 'deepseek' : ((existing && existing.translationSource) || ''),
          usage: onlineResult.data.usage || (existing && existing.usage) || '',
          phonetics: (onlineResult.data.phonetics && onlineResult.data.phonetics.length)
            ? onlineResult.data.phonetics
            : ((existing && existing.phonetics) || []),
          // meanings 以 DeepSeek 为准（含词性）；保留来源履历
          sources: priorSources
        }, 'deepseek');
        await saveWordDictionaryData(word, dictData);
        if (onlineResult.data.translation) {
          // 同步生词本中文与来源，避免测试选项与详情不一致
          const zhKey = `${userKey}wordTranslations`;
          const zhCnKey = `${userKey}wordChineseTranslations`;
          const zhStore = await new Promise((resolve) => {
            chrome.storage.local.get([zhKey, zhCnKey], resolve);
          });
          const tMap = new Map(zhStore[zhKey] || []);
          const cMap = new Map(zhStore[zhCnKey] || []);
          tMap.set(lower, onlineResult.data.translation);
          cMap.set(lower, onlineResult.data.translation);
          await new Promise((resolve) => {
            chrome.storage.local.set({
              [zhKey]: Array.from(tMap.entries()),
              [zhCnKey]: Array.from(cMap.entries())
            }, resolve);
          });
          await saveWordChineseSource(word, 'deepseek');
        }
        if (wordDetailOverlay.dataset.requestId !== requestId) return;
        wordDetailBody.innerHTML = renderWordDetailHtml(word, dictData, fallbackTranslation);
        bindWordDetailSpeakButtons(word);
        bindWordDetailDeepseekButton(word, fallbackTranslation, requestId);
        bindWordDetailRefreshButton(word, fallbackTranslation, requestId);
        loadWordList();
      } else {
        btn.disabled = false;
        btn.textContent = original;
        const err = (onlineResult && onlineResult.error) || '未知错误';
        if (typeof window.showAppAlert === 'function') {
          window.showAppAlert('DeepSeek 调用失败：' + err + '\n请到设置页检查 API Key。', 'DeepSeek');
        }
      }
    });
  }

  function normalizeLookupWord(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const match = text.match(/[A-Za-z][A-Za-z'-]*/);
    return match ? match[0].toLowerCase() : '';
  }

  function setLookupHint(message, type) {
    const hint = document.getElementById('wordLookupHint');
    if (!hint) return;
    hint.textContent = message || '';
    hint.classList.remove('error', 'ok');
    if (type) hint.classList.add(type);
  }

  async function fetchChineseTranslationForLookup(word) {
    const route = await getApiRouteConfig();

    const tryYoudao = async () => {
      try {
        const suggestUrl =
          `https://dict.youdao.com/suggest?q=${encodeURIComponent(word)}&num=1&doctype=json`;
        const resp = await fetch(suggestUrl);
        if (resp.ok) {
          const data = await resp.json();
          const explain = data && data.data && data.data.entries && data.data.entries[0]
            ? String(data.data.entries[0].explain || '').trim()
            : '';
          if (explain) return { text: explain, source: 'youdao' };
        }
      } catch (e) {}
      try {
        const fanyiUrl =
          `https://fanyi.youdao.com/translate?&doctype=json&type=EN2ZH_CN&i=${encodeURIComponent(word)}`;
        const resp = await fetch(fanyiUrl);
        if (!resp.ok) return null;
        const data = await resp.json();
        const parts = data && data.translateResult;
        if (!Array.isArray(parts)) return null;
        const joined = parts
          .map((row) => (Array.isArray(row) ? row.map((s) => (s && s.tgt) || '').join('') : ''))
          .join('')
          .trim();
        return joined ? { text: joined, source: 'youdao' } : null;
      } catch (e) {
        return null;
      }
    };

    const tryOffline = () => new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'queryOfflineDict', word }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          if (!(response && response.success && response.translation)) {
            resolve(null);
            return;
          }
          resolve({
            text: String(response.translation || '').trim(),
            source: response.source || 'ecd'
          });
        });
      } catch (e) {
        resolve(null);
      }
    });

    const tryGoogle = async () => {
      try {
        const url =
          `https://translate.googleapis.com/translate_a/single?client=gtx` +
          `&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(word)}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        if (data && Array.isArray(data[0])) {
          const joined = data[0]
            .map((seg) => (seg && seg[0] ? String(seg[0]) : ''))
            .join('')
            .trim();
          if (joined) return { text: joined, source: 'gt' };
        }
      } catch (e) {}
      return null;
    };

    const runners = {
      offline: tryOffline,
      youdao: tryYoudao,
      gt: tryGoogle,
      google: tryGoogle
    };

    const order = (route.translateOrder || DEFAULT_API_ROUTE.translateOrder).slice();
    for (let i = 0; i < order.length; i++) {
      const run = runners[order[i]];
      if (!run) continue;
      const got = await run();
      if (got && got.text) return got;
    }
    // 兜底
    return (await tryYoudao()) || (await tryOffline()) || (await tryGoogle());
  }

  async function addLookupWordToVocab(rawWord, options = {}) {
    const opts = options || {};
    const word = normalizeLookupWord(rawWord);
    if (!word) {
      if (!opts.silent) setLookupHint('请输入有效的英文单词', 'error');
      return null;
    }

    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const keys = [
      `${userKey}savedWords`,
      `${userKey}wordTranslations`,
      `${userKey}wordChineseTranslations`,
      `${userKey}wordChineseSources`,
      `${userKey}wordDictionaryData`,
      `${userKey}wordStatus`,
      `${userKey}wordNotes`
    ];
    const result = await new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });

    let savedWords = Array.isArray(result[`${userKey}savedWords`])
      ? result[`${userKey}savedWords`].slice()
      : [];
    const translations = new Map(result[`${userKey}wordTranslations`] || []);
    const chineseMap = new Map(result[`${userKey}wordChineseTranslations`] || []);
    const statuses = new Map(result[`${userKey}wordStatus`] || []);
    const notes = new Map(result[`${userKey}wordNotes`] || []);
    const chineseSources = new Map(result[`${userKey}wordChineseSources`] || []);
    const dictRaw = result[`${userKey}wordDictionaryData`] || [];
    const dictMap = new Map(Array.isArray(dictRaw) ? dictRaw : Object.entries(dictRaw || {}));

    const existingIndex = savedWords.findIndex((w) => String(w).toLowerCase() === word);
    const alreadySaved = existingIndex >= 0;
    if (alreadySaved) {
      const existing = savedWords[existingIndex];
      savedWords.splice(existingIndex, 1);
      savedWords.push(existing);
    } else {
      savedWords.push(word);
      if (!statuses.has(word)) statuses.set(word, 'new');
    }

    const storedKey = alreadySaved
      ? (savedWords[savedWords.length - 1] || word)
      : word;

    let translation =
      String(opts.translation || '').trim() ||
      translations.get(storedKey) ||
      translations.get(word) ||
      chineseMap.get(storedKey) ||
      chineseMap.get(word) ||
      '';
    let translationSource =
      opts.source ||
      chineseSources.get(storedKey) ||
      chineseSources.get(word) ||
      '';

    if (!translation) {
      const fetched = await fetchChineseTranslationForLookup(word);
      if (fetched && fetched.text) {
        translation = fetched.text;
        translationSource = fetched.source || '';
      }
    }
    if (translation) {
      translations.set(storedKey, translation);
      chineseMap.set(storedKey, translation);
      if (translationSource) {
        chineseSources.set(storedKey, translationSource);
        chineseSources.set(word, translationSource);
      }
    }

    const userData = {};
    userData[`${userKey}savedWords`] = savedWords;
    userData[`${userKey}wordTranslations`] = Array.from(translations.entries());
    userData[`${userKey}wordChineseTranslations`] = Array.from(chineseMap.entries());
    userData[`${userKey}wordChineseSources`] = Array.from(chineseSources.entries());
    userData[`${userKey}wordStatus`] = Array.from(statuses.entries());
    userData[`${userKey}wordNotes`] = Array.from(notes.entries());
    userData[`${userKey}wordDictionaryData`] = Array.from(dictMap.entries());

    await new Promise((resolve) => {
      chrome.storage.local.set(userData, resolve);
    });

    if (!opts.silent) {
      setLookupHint(
        alreadySaved ? `「${storedKey}」已在生词本，已打开详情` : `已加入生词本：${storedKey}`,
        'ok'
      );
    } else if (!alreadySaved) {
      loadStats();
      loadWordList();
    }

    return { word: storedKey, translation, alreadySaved };
  }

  window.addLookupWordToVocab = addLookupWordToVocab;

  async function handleWordLookup() {
    const input = document.getElementById('wordLookupInput');
    const btn = document.getElementById('wordLookupBtn');
    if (!input) return;
    const raw = input.value;
    if (btn) btn.disabled = true;
    setLookupHint('正在查词...', '');
    try {
      const added = await addLookupWordToVocab(raw);
      if (!added) return;
      loadStats();
      loadWordList();
      await openWordDetail(added.word, added.translation);
      input.value = '';
      input.focus();
    } catch (e) {
      setLookupHint((e && e.message) || '查词失败', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  (function bindWordLookup() {
    const input = document.getElementById('wordLookupInput');
    const btn = document.getElementById('wordLookupBtn');
    if (btn) btn.addEventListener('click', handleWordLookup);
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleWordLookup();
        }
      });
    }
  })();

  async function openWordDetail(word, fallbackTranslation, forceRefresh) {
    if (!wordDetailOverlay || !wordDetailBody || !wordDetailTitle) return;
    // 供单词记忆等模块复用同一浮窗
    const requestId = `${word}_${Date.now()}`;
    wordDetailOverlay.dataset.requestId = requestId;
    wordDetailTitle.textContent = word;
    wordDetailBody.innerHTML = `<div class="word-detail-loading">正在加载详情...</div>`;
    wordDetailOverlay.classList.add('show');

    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const result = await new Promise((resolve) => {
      chrome.storage.local.get([
        `${userKey}wordDictionaryData`,
        `${userKey}wordTranslations`,
        `${userKey}wordChineseSources`
      ], resolve);
    });

    const rawDict = result[`${userKey}wordDictionaryData`] || [];
    const dictMap = new Map(Array.isArray(rawDict) ? rawDict : Object.entries(rawDict || {}));
    const translations = new Map(result[`${userKey}wordTranslations`] || []);
    const chineseSources = new Map(result[`${userKey}wordChineseSources`] || []);
    const lower = word.toLowerCase();
    let dictData = dictMap.get(word) || dictMap.get(lower) || null;
    const translation = fallbackTranslation || translations.get(word) || translations.get(lower) || '';
    const chineseSourceCode = chineseSources.get(word) || chineseSources.get(lower) || '';

    // 旧 miss 且无英英：清标记后重试（修复被 offline 短路导致的错误缓存）
    if (dictData && isLookupMiss(dictData) && !hasEnglishDefinitions(dictData) &&
        dictData.lookupFullChainTried !== true) {
      dictData = {
        ...dictData,
        lookupMiss: false,
        lookupMissReason: '',
        lookupMissAt: undefined,
        detailCached: false
      };
    }
    if (forceRefresh && dictData) {
      dictData = {
        ...dictData,
        lookupMiss: false,
        lookupMissReason: '',
        lookupMissAt: undefined,
        lookupFullChainTried: false,
        zhLookupTried: false,
        detailCached: hasEnglishDefinitions(dictData) ? dictData.detailCached : false
      };
    }

    // 已有英英但缺中文（无义项且无短译）：自动再跑一轮补中文（只一次）
    const needZhFill = !!(dictData && hasEnglishDefinitions(dictData) &&
      !extractZhMeanings(dictData).length &&
      !String(dictData.translation || translation || '').trim() &&
      dictData.zhLookupTried !== true);

    // 本地无英英/缺中文时，按测速详情顺序补全（中英分栏保存）
    if (forceRefresh || !isLookupSettled(dictData) || needZhFill) {
      wordDetailBody.innerHTML = `<div class="word-detail-loading">正在按最优顺序获取详情...</div>`;
      const fdData = await fetchFreeDictionaryForWord(word);
      if (wordDetailOverlay.dataset.requestId !== requestId) return;
      if (fdData && !fdData.__lookupFailed) {
        const incoming = { ...fdData };
        delete incoming.__partialOnly;
        delete incoming.__lookupFailed;
        delete incoming.__lookupError;
        delete incoming.__lookupTransient;
        dictData = mergeDictData(dictData, incoming);
        dictData.translation = dictData.translation || translation || '';
        dictData.translationSource = dictData.translationSource || chineseSourceCode || '';
        if (hasEnglishDefinitions(dictData)) {
          dictData = markDetailCached(dictData, dictData.sourceAbbr || incoming.sourceAbbr || 'fd');
        } else {
          // 仅中文部分结果：保存但不标 miss，便于下次继续补英英
          dictData = {
            ...dictData,
            lookupMiss: false,
            lookupFullChainTried: false,
            detailCached: false,
            cachedAt: Date.now()
          };
        }
        dictData.zhLookupTried = true;
        await saveWordDictionaryData(word, dictData);
      } else if (!(fdData && fdData.__lookupTransient)) {
        // 全链路无结果：固化 miss（仍保留已有中文/音标）
        if (dictData && (dictData.translation || translation || hasRichMeanings(dictData))) {
          dictData = markLookupMiss(
            {
              ...dictData,
              translation: dictData.translation || translation || '',
              translationSource: dictData.translationSource || chineseSourceCode || ''
            },
            word,
            (fdData && fdData.__lookupError) || 'online_not_found'
          );
        } else {
          dictData = markLookupMiss(
            dictData,
            word,
            (fdData && fdData.__lookupError) || 'online_not_found'
          );
        }
        await saveWordDictionaryData(word, dictData);
      }
    }

    if (wordDetailOverlay.dataset.requestId !== requestId) return;
    wordDetailBody.innerHTML = renderWordDetailHtml(word, dictData, translation, chineseSourceCode);
    bindWordDetailSpeakButtons(word);
    bindWordDetailDeepseekButton(word, translation, requestId);
    bindWordDetailRefreshButton(word, translation, requestId);
  }

  function bindWordDetailRefreshButton(word, fallbackTranslation, requestId) {
    const btn = document.getElementById('wordDetailRefreshBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (wordDetailOverlay.dataset.requestId !== requestId) return;
      btn.disabled = true;
      btn.textContent = '正在重新获取...';
      await openWordDetail(word, fallbackTranslation, true);
    });
  }

  window.openWordDetail = openWordDetail;
  window.closeWordDetail = closeWordDetail;

  if (wordDetailClose) {
    wordDetailClose.addEventListener('click', closeWordDetail);
  }
  if (wordDetailOverlay) {
    wordDetailOverlay.addEventListener('click', (e) => {
      if (e.target === wordDetailOverlay) closeWordDetail();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeWordDetail();
  });

  const wordSortBtns = document.getElementById('wordSortBtns');
  const WORD_SORT_KEY = 'wordListSortMode';
  const WORD_SORT_MODES = ['recent', 'alpha', 'status', 'mastered'];

  function applyWordSortUi(mode) {
    if (!wordSortBtns) return;
    const safe = WORD_SORT_MODES.includes(mode) ? mode : 'recent';
    wordSortBtns.querySelectorAll('.word-sort-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-sort') === safe);
    });
  }

  function getStatusOf(statuses, word) {
    return statuses.get(word) || statuses.get(String(word).toLowerCase()) || 'new';
  }

  function sortWordList(words, statuses, mode) {
    const list = words.slice();
    const indexMap = new Map();
    words.forEach((w, i) => indexMap.set(w, i));

    if (mode === 'alpha') {
      list.sort((a, b) => String(a).localeCompare(String(b), 'en', { sensitivity: 'base' }));
      return list;
    }

    if (mode === 'status') {
      // 未记住优先；同状态内最近加入在前
      list.sort((a, b) => {
        const statusA = getStatusOf(statuses, a);
        const statusB = getStatusOf(statuses, b);
        if (statusA !== statusB) return statusA === 'new' ? -1 : 1;
        return (indexMap.get(b) || 0) - (indexMap.get(a) || 0);
      });
      return list;
    }

    if (mode === 'mastered') {
      // 已记住优先；同状态内最近加入在前
      list.sort((a, b) => {
        const statusA = getStatusOf(statuses, a);
        const statusB = getStatusOf(statuses, b);
        if (statusA !== statusB) return statusA === 'mastered' ? -1 : 1;
        return (indexMap.get(b) || 0) - (indexMap.get(a) || 0);
      });
      return list;
    }

    // recent：词库数组末尾通常是较新加入的 → 倒序
    list.reverse();
    return list;
  }

  async function getWordSortMode() {
    const result = await new Promise((resolve) => {
      chrome.storage.local.get([WORD_SORT_KEY], resolve);
    });
    const mode = result[WORD_SORT_KEY];
    return WORD_SORT_MODES.includes(mode) ? mode : 'recent';
  }

  async function setWordSortMode(mode) {
    const safe = WORD_SORT_MODES.includes(mode) ? mode : 'recent';
    await new Promise((resolve) => {
      chrome.storage.local.set({ [WORD_SORT_KEY]: safe }, resolve);
    });
    return safe;
  }

  if (wordSortBtns) {
    getWordSortMode().then((mode) => applyWordSortUi(mode));
    wordSortBtns.addEventListener('click', async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.word-sort-btn') : null;
      if (!btn) return;
      const mode = btn.getAttribute('data-sort');
      if (!WORD_SORT_MODES.includes(mode)) return;
      applyWordSortUi(mode);
      await setWordSortMode(mode);
      loadWordList();
    });
  }

  // 加载单词列表
  async function loadWordList() {
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const sortMode = await getWordSortMode();
    applyWordSortUi(sortMode);

    chrome.storage.local.get([
      `${userKey}savedWords`,
      `${userKey}wordTranslations`,
      `${userKey}wordChineseSources`,
      `${userKey}wordStatus`,
      `${userKey}wordNotes`
    ], (result) => {
      const words = result[`${userKey}savedWords`] || [];
      const translations = new Map(result[`${userKey}wordTranslations`] || []);
      const chineseSources = new Map(result[`${userKey}wordChineseSources`] || []);
      const statuses = new Map(result[`${userKey}wordStatus`] || []);
      const notes = new Map(result[`${userKey}wordNotes`] || []);

      wordListEl.innerHTML = '';

      if (words.length === 0) {
        wordListEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-text">暂无单词<br><small style="color: #999;">上方查词可直接加入，或双击网页中的英文单词收藏</small></div>
          </div>
        `;
        return;
      }

      const sortedWords = sortWordList(words, statuses, sortMode);

      sortedWords.forEach(word => {
        const translation = translations.get(word) || translations.get(String(word).toLowerCase()) || '';
        const zhSrc = chineseSources.get(word) || chineseSources.get(String(word).toLowerCase()) || '';
        const zhLabel = chineseSourceLabel(zhSrc);
        const status = statuses.get(word) || 'new';
        const note = notes.get(word) || '';
        const statusText = status === 'mastered' ? '已记住' : '未记住';
        const statusClass = status === 'mastered' ? 'badge-mastered' : 'badge-new';

        const wordItem = document.createElement('div');
        wordItem.className = 'word-item';
        wordItem.title = '点击查看详情';
        wordItem.innerHTML = `
          <div class="word-info">
            <div class="word-name">${escapeHtml(word)}</div>
            <div class="word-meaning">${escapeHtml(translation || '暂无翻译')}${zhLabel ? `<span class="zh-source-tag"> · ${escapeHtml(zhLabel)}</span>` : ''}</div>
            ${note ? `<div class="word-note">备注：${escapeHtml(note)}</div>` : ''}
          </div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span class="word-badge ${statusClass}">${statusText}</span>
            <button type="button" class="btn btn-primary btn-note" data-word="${escapeHtml(word)}" style="padding:4px 10px; font-size:12px;">备注</button>
            <button type="button" class="btn-remove" data-word="${escapeHtml(word)}">删除</button>
          </div>
        `;

        wordItem.addEventListener('click', () => {
          openWordDetail(word, translation);
        });

        const noteBtn = wordItem.querySelector('.btn-note');
        if (noteBtn) {
          noteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const next = await window.showAppNotePrompt(
              `编辑「${word}」的备注（留空删除）：`,
              note || '',
              '单词备注'
            );
            if (next === null) return;
            await saveWordNote(word, String(next).trim());
          });
        }

        const removeBtn = wordItem.querySelector('.btn-remove');
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const ok = await window.showAppConfirm(`确定要删除单词「${word}」吗？`, '删除单词');
          if (ok) removeWord(word);
        });

        wordListEl.appendChild(wordItem);
      });
    });
  }

  async function saveWordNote(word, noteText) {
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const key = `${userKey}wordNotes`;
    const result = await new Promise((resolve) => {
      chrome.storage.local.get([key], resolve);
    });
    const notes = new Map(result[key] || []);
    const lower = String(word || '').toLowerCase();
    const existingKey = [...notes.keys()].find((k) => String(k).toLowerCase() === lower) || word;
    if (noteText) {
      notes.set(existingKey, noteText);
    } else {
      notes.delete(existingKey);
      notes.delete(word);
      notes.delete(lower);
    }
    await new Promise((resolve) => {
      chrome.storage.local.set({ [key]: Array.from(notes.entries()) }, resolve);
    });
    loadWordList();
  }

  // 删除单词
  async function removeWord(word) {
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
      const savedWords = result[`${userKey}savedWords`] || [];
      const wordTranslations = result[`${userKey}wordTranslations`] || [];
      const wordDictionaryData = result[`${userKey}wordDictionaryData`] || [];
      const wordChineseTranslations = result[`${userKey}wordChineseTranslations`] || [];
      const wordChineseSources = result[`${userKey}wordChineseSources`] || [];
      const wordStatus = result[`${userKey}wordStatus`] || [];
      const wordNotes = result[`${userKey}wordNotes`] || [];
      
      const lowerWord = word.toLowerCase();
      
      const newSavedWords = savedWords.filter(w => w.toLowerCase() !== lowerWord);
      const newWordTranslations = wordTranslations.filter(([w]) => w.toLowerCase() !== lowerWord);
      const newWordDictionaryData = wordDictionaryData.filter(([w]) => w.toLowerCase() !== lowerWord);
      const newWordChineseTranslations = wordChineseTranslations.filter(([w]) => w.toLowerCase() !== lowerWord);
      const newWordChineseSources = wordChineseSources.filter(([w]) => w.toLowerCase() !== lowerWord);
      const newWordStatus = wordStatus.filter(([w]) => w.toLowerCase() !== lowerWord);
      const newWordNotes = wordNotes.filter(([w]) => w.toLowerCase() !== lowerWord);
      
      const userData = {};
      userData[`${userKey}savedWords`] = newSavedWords;
      userData[`${userKey}wordTranslations`] = newWordTranslations;
      userData[`${userKey}wordDictionaryData`] = newWordDictionaryData;
      userData[`${userKey}wordChineseTranslations`] = newWordChineseTranslations;
      userData[`${userKey}wordChineseSources`] = newWordChineseSources;
      userData[`${userKey}wordStatus`] = newWordStatus;
      userData[`${userKey}wordNotes`] = newWordNotes;
      
      chrome.storage.local.set(userData, () => {
        loadStats();
        loadWordList();
      });
    });
  }

  // 供测试模块刷新顶部统计
  window.refreshVocabStats = function() {
    loadStats();
    loadWordList();
  };

  // 监听存储变化
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'local') {
      const currentUserId = await getCurrentUserId();
      const userKey = `user_${currentUserId}_`;
      
      // 如果当前用户的词库数据变化，重新加载
      if (changes[`${userKey}savedWords`] || changes[`${userKey}wordStatus`]) {
        loadStats();
        loadWordList();
      }
      
      // 如果切换用户，重新加载
      if (changes.currentUserId) {
        loadStats();
        loadWordList();
        loadUsers();
      }

      // 用户更名 / 增删后刷新顶部用户列表
      if (changes.users) {
        loadUsers();
      }
    }
  });

  // 初始化
  loadUsers().then(() => {
    loadStats();
    loadWordList();

    // 支持从弹窗等入口带 #test 进入开始页
    if (location.hash === '#test') {
      switchToTab('test');
    }
  });

  window.addEventListener('hashchange', () => {
    if (location.hash === '#test') {
      switchToTab('test');
    }
  });
});
