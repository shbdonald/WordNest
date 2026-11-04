// 内嵌测试逻辑（在 main.html 的「测试」标签中运行）
(function() {
  'use strict';

  // DeepSeek 仅手动按钮；Free Dictionary 自动补全并缓存
  const ENABLE_DEEPSEEK_API = true;
  const AUTO_API_ENRICH = true;

  let words = [];
  let optionPool = []; // 干扰项来源：整份生词本（大词库），保证选项能反查英文词
  let currentIndex = 0;
  let sessionTotal = 0;   // 本轮开始时的总题数（固定，用于进度）
  let completedCount = 0; // 本轮已完成题数
  let isAnswerShown = false;
  let isSubmitting = false; // 防止连点重复提交/跳题
  let selectedOption = -1;
  let correctOptionIndex = -1;
  let currentOptions = [];
  let currentOptionWords = []; // 各选项对应的英文单词（供答后点选查看详情）
  let currentOptionSources = []; // vocab | dict
  let dictionaryData = null;
  let eventsBound = false;
  let isActive = false;
  let questionToken = 0; // 每题唯一标记，过期的延时回调直接丢弃
  let masteredTimer = null;
  const CORRECT_COUNTDOWN_MS = 2000; // 答对后倒计时时长
  let countdownRaf = null;
  let countdownToken = 0;
  let countdownRemainingMs = 0;
  let countdownPaused = false;
  let countdownLastTs = 0;

  function $(id) {
    return document.getElementById(id);
  }

  const SESSION_COUNT_KEY = 'vocabMemorySessionCount';

  function getEls() {
    return {
      startScreen: $('testStartScreen'),
      sessionArea: $('testSessionArea'),
      sessionCount: $('testSessionCount'),
      availableCount: $('testAvailableCount'),
      startBtn: $('startTestBtn'),
      wordCard: $('testWordCard'),
      emptyState: $('testEmptyState'),
      finishState: $('testFinishState'),
      finishMessage: $('testFinishMessage'),
      testActions: $('testActions'),
      wordText: $('testWordText'),
      wordPhonetic: $('testWordPhonetic'),
      wordStatus: $('testWordStatus'),
      optionBtns: document.querySelectorAll('#testOptionsSection .option-btn'),
      answerFeedback: $('testAnswerFeedback'),
      retryBtn: $('testRetryBtn'),
      dontKnowBtn: $('testDontKnowBtn'),
      nextBtn: $('testNextBtn'),
      finishBtn: $('testFinishBtn'),
      currentIndexEl: $('testCurrentIndex'),
      totalWordsEl: $('testTotalWords'),
      progressFill: $('testProgressFill'),
      dictionaryCard: $('testDictionaryCard'),
      dictWord: $('testDictWord'),
      dictContent: $('testDictContent'),
      dictClose: $('testDictClose'),
      testTab: $('testTab'),
      countdownBtn: $('correctCountdownBtn'),
      countdownFill: $('correctCountdownFill'),
      countdownText: $('correctCountdownText'),
      countdownState: $('correctCountdownState'),
      countdownHint: $('correctCountdownHint')
    };
  }

  function formatCountdown(ms) {
    const sec = Math.max(0, ms) / 1000;
    return sec.toFixed(2) + 's';
  }

  function stopCorrectCountdown() {
    if (countdownRaf) {
      cancelAnimationFrame(countdownRaf);
      countdownRaf = null;
    }
    countdownToken += 1;
    countdownPaused = false;
    countdownRemainingMs = 0;
    countdownLastTs = 0;
    if (masteredTimer) {
      clearTimeout(masteredTimer);
      masteredTimer = null;
    }

    const els = getEls();
    if (els.countdownBtn) {
      els.countdownBtn.style.display = 'none';
      els.countdownBtn.classList.remove('paused');
    }
    if (els.countdownHint) els.countdownHint.style.display = 'none';
    if (els.countdownFill) els.countdownFill.style.width = '0%';
  }

  function renderCountdownUI() {
    const els = getEls();
    if (!els.countdownBtn) return;

    // 进度从左往右填满（已过去时间），倒计时数字仍显示剩余秒数
    const ratio = CORRECT_COUNTDOWN_MS > 0
      ? Math.max(0, Math.min(1, 1 - (countdownRemainingMs / CORRECT_COUNTDOWN_MS)))
      : 1;

    if (els.countdownFill) els.countdownFill.style.width = (ratio * 100) + '%';
    if (els.countdownText) els.countdownText.textContent = formatCountdown(countdownRemainingMs);
    if (els.countdownState) {
      els.countdownState.textContent = countdownPaused ? '已暂停，点击进入下一题' : '后进入下一题';
    }
    els.countdownBtn.classList.toggle('paused', countdownPaused);
  }

  function finishCountdownAndNext(token) {
    if (typeof window.closeWordDetail === 'function') {
      window.closeWordDetail();
    }
    stopCorrectCountdown();
    if (token != null && token !== questionToken) return;
    markAsMastered(token);
  }

  function tickCountdown(token, questionTok) {
    if (token !== countdownToken || questionTok !== questionToken) return;

    if (countdownPaused) {
      countdownRaf = null;
      return;
    }

    const now = performance.now();
    const delta = countdownLastTs ? (now - countdownLastTs) : 0;
    countdownLastTs = now;
    countdownRemainingMs -= delta;

    if (countdownRemainingMs <= 0) {
      countdownRemainingMs = 0;
      renderCountdownUI();
      finishCountdownAndNext(questionTok);
      return;
    }

    renderCountdownUI();
    countdownRaf = requestAnimationFrame(() => tickCountdown(token, questionTok));
  }

  function startCorrectCountdown(questionTok) {
    stopCorrectCountdown();
    const els = getEls();
    if (!els.countdownBtn) {
      // 无 UI 时回退到短延时
      masteredTimer = setTimeout(() => {
        masteredTimer = null;
        if (questionTok !== questionToken) return;
        markAsMastered(questionTok);
      }, CORRECT_COUNTDOWN_MS);
      return;
    }

    const token = ++countdownToken;
    countdownRemainingMs = CORRECT_COUNTDOWN_MS;
    countdownPaused = false;
    countdownLastTs = performance.now();

    els.countdownBtn.style.display = 'block';
    if (els.countdownHint) els.countdownHint.style.display = 'block';
    renderCountdownUI();
    countdownRaf = requestAnimationFrame(() => tickCountdown(token, questionTok));
  }

  function onCountdownButtonClick() {
    if (!isActive || !isAnswerShown) return;
    const els = getEls();
    if (!els.countdownBtn || els.countdownBtn.style.display === 'none') return;

    // 第一次点击：暂停并展示详细信息（不算答错）；再次点击：进入下一题
    if (!countdownPaused) {
      countdownPaused = true;
      countdownLastTs = 0;
      if (countdownRaf) {
        cancelAnimationFrame(countdownRaf);
        countdownRaf = null;
      }
      renderCountdownUI();
      showWordDetails({ countAsWrong: false });
      return;
    }

    const token = questionToken;
    finishCountdownAndNext(token);
  }

  function getCurrentUserId() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['currentUserId'], (result) => {
        resolve(result.currentUserId || 'default');
      });
    });
  }

  function extractPhonetic(dictData) {
    if (!dictData) return '';
    if (typeof dictData.phonetic === 'string' && dictData.phonetic.trim()) {
      return dictData.phonetic.trim();
    }
    if (Array.isArray(dictData.phonetics) && dictData.phonetics.length > 0) {
      const phonetic = dictData.phonetics.find(p => p && p.text && String(p.text).trim()) || dictData.phonetics[0];
      if (phonetic && phonetic.text) {
        return String(phonetic.text).trim();
      }
    }
    return '';
  }

  function formatPhonetic(phonetic) {
    if (!phonetic) return '';
    const text = phonetic.trim();
    if (!text) return '';
    if (text.startsWith('/') || text.startsWith('[')) return text;
    return `/${text}/`;
  }

  function escapeHtmlAttr(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeHtmlText(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderTestWordPhonetic(container, word, phonetic) {
    if (!container) return;
    const phoneticText = formatPhonetic(phonetic);
    const wordAttr = escapeHtmlAttr(word);
    const textHtml = phoneticText
      ? `<span class="dict-phonetic-text">${escapeHtmlText(phoneticText)}</span>`
      : `<span class="dict-phonetic-text muted">暂无音标</span>`;
    container.innerHTML =
      textHtml +
      `<button type="button" class="dict-speak-btn" data-word="${wordAttr}" data-type="1" title="英音">🔊 英</button>` +
      `<button type="button" class="dict-speak-btn" data-word="${wordAttr}" data-type="2" title="美音">🔊 美</button>`;

    container.querySelectorAll('.dict-speak-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const w = btn.getAttribute('data-word') || word;
        const type = parseInt(btn.getAttribute('data-type'), 10) || 2;
        speakWord(w, type);
      });
    });
    container.onclick = (e) => {
      if (e.target.closest('.dict-speak-btn')) return;
      speakWord(word, 2);
    };
  }

  function updateTestWordPhoneticText(container, phonetic) {
    if (!container) return;
    const textEl = container.querySelector('.dict-phonetic-text');
    const phoneticText = formatPhonetic(phonetic);
    if (!textEl) return;
    if (phoneticText) {
      textEl.textContent = phoneticText;
      textEl.classList.remove('muted');
    } else {
      textEl.textContent = '暂无音标';
      textEl.classList.add('muted');
    }
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

  const CHINESE_SOURCE_LABELS = {
    deepseek: 'DeepSeek',
    ecd: '离线英汉词典',
    gt: 'Google 翻译',
    bd: '百度翻译',
    mm: 'MyMemory 翻译',
    youdao: '有道翻译',
    bing: 'Bing 翻译',
    offline: '离线词典'
  };

  function chineseSourceLabel(code) {
    if (!code) return '';
    return CHINESE_SOURCE_LABELS[code] || String(code);
  }

  async function getStoredChineseSource(word) {
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

  async function saveStoredChineseSource(word, source) {
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
    await new Promise((resolve) => {
      chrome.storage.local.set({ [key]: Array.from(map.entries()) }, resolve);
    });
  }

  function appendDeepseekLog(entry) {
    try {
      chrome.runtime.sendMessage({ action: 'appendDeepseekApiLog', entry }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  // 同一单词进行中的请求去重，避免并发打两次
  const deepseekInflight = new Map();

  // 扩展页直接请求，避免 service worker message port closed
  async function fetchDeepseekInfo(word) {
    if (!ENABLE_DEEPSEEK_API) return null;
    const cleanWord = String(word || '').trim();
    if (!cleanWord) return null;
    const inflightKey = cleanWord.toLowerCase();
    if (deepseekInflight.has(inflightKey)) {
      return deepseekInflight.get(inflightKey);
    }

    const requestPromise = (async () => {
      const startedAt = Date.now();
      try {
        const keyResult = await new Promise((resolve) => {
          chrome.storage.local.get(['deepseekApiKey'], resolve);
        });
        const apiKey = sanitizeApiKey(keyResult.deepseekApiKey || '');
        if (!apiKey) {
          appendDeepseekLog({
            word: cleanWord,
            success: false,
            error: 'missing_deepseek_key',
            source: 'test-direct',
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
              source: 'test-direct',
              durationMs: Date.now() - startedAt
            });
            return null;
          }

          const raw = await response.json();
          const content = raw?.choices?.[0]?.message?.content || '';
          const parsed = extractJsonObject(content);
          const data = convertDeepseekToDictFormat(cleanWord, parsed);
          appendDeepseekLog({
            word: cleanWord,
            success: !!(data && data.meanings && data.meanings.length),
            error: data ? '' : 'empty_result',
            source: 'test-direct',
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
          source: 'test-direct',
          durationMs: Date.now() - startedAt
        });
        return null;
      }
    })();

    deepseekInflight.set(inflightKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      deepseekInflight.delete(inflightKey);
    }
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
    const posMap = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'unknown' };
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
        const row = parsed.ok && Array.isArray(parsed.data) ? parsed.data[0] : null;
        const converted = convertDatamuseToDictFormat(cleanWord, row);
        if (converted && converted.meanings && converted.meanings.length) {
          appendDeepseekLog({
            word: cleanWord,
            success: true,
            api: 'datamuse',
            source: 'test-datamuse',
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
      source: 'test-datamuse',
      durationMs: Date.now() - startedAt
    });
    return null;
  }

  const DICT_ZH_IDS = ['offline', 'youdao_dict', 'd3325'];
  const DICT_EN_IDS = ['fd', 'datamuse'];

  const DEFAULT_API_ROUTE = {
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
    const hasPhonetic = !!(offline.phonetic || (offline.phonetics && offline.phonetics.length));
    if (!translation && !(meanings && meanings.length) && !hasPhonetic) return null;
    const hit = {
      word: String(word || '').trim(),
      phonetics: offline.phonetics || (offline.phonetic ? [{ text: offline.phonetic }] : []),
      meanings,
      translation,
      usage: offline.usage || '',
      sourceAbbr: 'ecd'
    };
    return hit;
  }

  async function fetchYoudaoDictDetail(word) {
    const text = String(word || '').trim();
    if (!text) return null;
    const startedAt = Date.now();
    try {
      const resp = await fetch(`https://dict.youdao.com/jsonapi?q=${encodeURIComponent(text)}`);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const data = await resp.json();
      const ecWordRaw = data && data.ec && data.ec.word;
      const ecWord = Array.isArray(ecWordRaw) ? ecWordRaw[0] : ecWordRaw;
      const phonetics = [];
      if (ecWord && ecWord.ukphone) phonetics.push({ text: String(ecWord.ukphone), source: 'youdao_uk' });
      if (ecWord && ecWord.usphone) phonetics.push({ text: String(ecWord.usphone), source: 'youdao_us' });
      const meanings = [];
      const trs = ecWord && Array.isArray(ecWord.trs) ? ecWord.trs : [];
      trs.forEach((item) => {
        const lines = ((((item || {}).tr || [])[0] || {}).l || {}).i || [];
        (Array.isArray(lines) ? lines : [lines]).forEach((raw) => {
          const t = String(raw || '').trim();
          if (!t) return;
          const m = t.match(/^([a-z]+\.)\s*(.+)$/i);
          const pos = m ? m[1] : '释义';
          const def = m ? m[2] : t;
          let bucket = meanings.find((x) => x.partOfSpeech === pos);
          if (!bucket) {
            bucket = { partOfSpeech: pos, definitions: [] };
            meanings.push(bucket);
          }
          bucket.definitions.push({ definition: def });
        });
      });
      const translation = meanings.map((m) => m.definitions.map((d) => d.definition).join('；')).join('；');
      if (!meanings.length && !phonetics.length) throw new Error('empty_result');
      const parsed = { word: text, phonetics, meanings, translation, sourceAbbr: 'youdao_dict' };
      appendDeepseekLog({ word: text, success: true, api: 'youdao_dict', source: 'test-youdao-dict', durationMs: Date.now() - startedAt });
      return parsed;
    } catch (e) {
      appendDeepseekLog({ word: text, success: false, error: (e && e.message) || 'failed', api: 'youdao_dict', source: 'test-youdao-dict', durationMs: Date.now() - startedAt });
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
      const meanings = translation ? [{ partOfSpeech: String(data.cx || '释义'), definitions: [{ definition: translation }] }] : [];
      if (!meanings.length && !phonetics.length) throw new Error('empty_result');
      const parsed = { word: String(data.word || text), phonetics, meanings, translation, sourceAbbr: 'd3325' };
      appendDeepseekLog({ word: text, success: true, api: 'd3325', source: 'test-3325', durationMs: Date.now() - startedAt });
      return parsed;
    } catch (e) {
      appendDeepseekLog({ word: text, success: false, error: (e && e.message) || 'failed', api: 'd3325', source: 'test-3325', durationMs: Date.now() - startedAt });
      return null;
    }
  }

  async function fetchFreeDictionaryInfo(word) {
    const route = await getApiRouteConfig();
    const cleanWord = String(word || '').trim();
    const dictOrder = route.dictOrder || DEFAULT_API_ROUTE.dictOrder;
    const fdIdx = dictOrder.indexOf('fd');
    const dmIdx = dictOrder.indexOf('datamuse');
    const firstWesternIdx = [fdIdx, dmIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0];

    for (let i = 0; i < dictOrder.length; i++) {
      const id = dictOrder[i];
      if (typeof firstWesternIdx === 'number' && i >= firstWesternIdx) break;
      let hit = null;
      if (id === 'offline') {
        hit = normalizeOfflineDictHit(cleanWord, await fetchOfflineDictionaryData(cleanWord));
        if (hit && (hit.translation || hasRichMeanings(hit))) {
          appendDeepseekLog({ word: cleanWord, success: true, api: 'offline', source: 'test-ecd', detail: 'dict_order_priority_offline' });
          return hit;
        }
        continue;
      }
      if (id === 'youdao_dict') hit = await fetchYoudaoDictDetail(cleanWord);
      else if (id === 'd3325') hit = await fetch3325DictDetail(cleanWord);
      if (hit && (hasRichMeanings(hit) || hit.translation)) return hit;
    }

    const startedAt = Date.now();
    const variants = await buildFreeDictionaryVariants(cleanWord);
    let lastError = 'request_failed';

    const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let retried5xx = 0;

    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i];
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
          if (!entry || !entry.meanings || !entry.meanings.length) {
            lastError = 'empty_result';
            break;
          }
          appendDeepseekLog({
            word: cleanWord,
            success: true,
            api: 'freedictionary',
            source: 'test-fd',
            durationMs: Date.now() - startedAt,
            detail: `meanings=${entry.meanings.length}` +
              (variant !== cleanWord ? `; query=${variant}` : '') +
              (retried5xx ? `; retried5xx=${retried5xx}` : '')
          });
          return entry;
        } catch (error) {
          console.error('获取词典信息失败:', error);
          const raw = (error && error.message) || 'request_failed';
          lastError = /Unexpected end of JSON input/i.test(raw) ? 'empty_body' : raw;
          if (attempt < 2) {
            await sleepMs(300 * (attempt + 1));
            continue;
          }
        }
      }
    }

    appendDeepseekLog({
      word: cleanWord,
      success: false,
      error: lastError,
      api: 'freedictionary',
      source: 'test-fd',
      durationMs: Date.now() - startedAt,
      detail: 'will_try_datamuse' + (retried5xx ? `; retried5xx=${retried5xx}` : '')
    });
    const fallback = await fetchDatamuseFallback(cleanWord);
    if (fallback && hasRichMeanings(fallback)) return fallback;

    for (const id of ['youdao_dict', 'd3325', 'offline']) {
      if (dictOrder.indexOf(id) >= 0 && dictOrder.indexOf(id) < (firstWesternIdx ?? 999)) continue;
      let hit = null;
      if (id === 'offline') hit = normalizeOfflineDictHit(cleanWord, await fetchOfflineDictionaryData(cleanWord));
      else if (id === 'youdao_dict') hit = await fetchYoudaoDictDetail(cleanWord);
      else if (id === 'd3325') hit = await fetch3325DictDetail(cleanWord);
      if (hit && (hit.translation || hasRichMeanings(hit))) return hit;
    }

    return {
      __lookupFailed: true,
      __lookupError: lastError,
      __lookupTransient: isTransientDictError(lastError)
    };
  }

  function hasRichMeanings(dictData) {
    return !!(dictData && Array.isArray(dictData.meanings) && dictData.meanings.length > 0);
  }

  function isTransientDictError(err) {
    const e = String(err || '');
    return /^http_5\d\d$/.test(e) || /timeout|abort|Failed to fetch|NetworkError|network|empty_body/i.test(e);
  }

  function isLookupMiss(dictData) {
    return !!(dictData && dictData.lookupMiss === true);
  }

  // 已成功从 API 拉取并落盘的详情（以后直接用本地，不再打 API）
  function isDetailCached(dictData) {
    if (!dictData || !hasRichMeanings(dictData)) return false;
    if (dictData.detailCached === true) return true;
    const src = dictData.sourceAbbr;
    return src === 'deepseek' || src === 'wordsapi' || src === 'fd' || src === 'datamuse' ||
      src === 'api' || src === 'youdao_dict' || src === 'd3325' || src === 'ecd';
  }

  function isLookupSettled(dictData) {
    return isLookupMiss(dictData) || isDetailCached(dictData);
  }

  function markLookupMiss(dictData, word, reason) {
    return {
      ...(dictData || {}),
      word: word || (dictData && dictData.word) || '',
      meanings: (dictData && Array.isArray(dictData.meanings)) ? dictData.meanings : [],
      lookupMiss: true,
      lookupMissAt: Date.now(),
      lookupMissReason: reason || 'not_found',
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
    if (Array.isArray(dictData.sources)) dictData.sources.forEach(push);
    push(dictData.sourceAbbr);
    (dictData.phonetics || []).forEach((p) => push(p && p.source));
    return codes;
  }

  function mergeDictionaryData(existing, online) {
    if (!online) return existing || null;
    const mergedSources = [];
    const pushSrc = (code) => {
      if (!code || mergedSources.includes(code)) return;
      mergedSources.push(code);
    };
    if (existing) {
      if (Array.isArray(existing.sources)) existing.sources.forEach(pushSrc);
      pushSrc(existing.sourceAbbr);
    }
    if (Array.isArray(online.sources)) online.sources.forEach(pushSrc);
    pushSrc(online.sourceAbbr);
    return {
      ...(existing || {}),
      ...online,
      translation: online.translation || (existing && existing.translation) || '',
      translationSource: online.translation
        ? (online.translationSource || online.sourceAbbr || '')
        : ((existing && existing.translationSource) || ''),
      usage: online.usage || (existing && existing.usage) || '',
      phonetics: (online.phonetics && online.phonetics.length)
        ? online.phonetics
        : ((existing && existing.phonetics) || []),
      meanings: (online.meanings && online.meanings.length)
        ? online.meanings
        : ((existing && existing.meanings) || []),
      sourceAbbr: online.sourceAbbr || (hasRichMeanings(online) ? 'api' : ((existing && existing.sourceAbbr) || 'api')),
      sources: mergedSources,
      detailCached: online.detailCached || (existing && existing.detailCached) || false,
      cachedAt: online.cachedAt || (existing && existing.cachedAt) || undefined
    };
  }

  async function getStoredDictData(word) {
    const lower = String(word || '').toLowerCase();
    if (!lower) return null;

    const sessionItem = words.find(w => w.word.toLowerCase() === lower);
    if (sessionItem && sessionItem.dictData) {
      return sessionItem.dictData;
    }

    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const key = `${userKey}wordDictionaryData`;
    const result = await new Promise((resolve) => {
      chrome.storage.local.get([key], resolve);
    });
    const dictionaryMap = new Map(result[key] || []);
    return dictionaryMap.get(word) || dictionaryMap.get(lower) || null;
  }

  function hasDeepseekCached(dictData) {
    return !!(dictData && dictData.sourceAbbr === 'deepseek' && hasRichMeanings(dictData));
  }

  // 优先本地缓存；未缓存时按测速详情顺序补全
  async function fetchDictionaryInfo(word, options = {}) {
    const force = options.force === true;
    const existing = await getStoredDictData(word);
    if (!force && isLookupSettled(existing)) {
      return existing;
    }
    if (!AUTO_API_ENRICH) {
      return existing || null;
    }

    const freeData = await fetchFreeDictionaryInfo(word);
    if (hasRichMeanings(freeData)) {
      if (!freeData.sourceAbbr) freeData.sourceAbbr = 'fd';
      const marked = markDetailCached(mergeDictionaryData(existing, freeData), freeData.sourceAbbr || 'fd');
      await saveOneWordDictionary(word, marked);
      applyDictToSessionWord(word, marked);
      return marked;
    }

    // 临时故障不固化 miss，避免 dawn 类 502 后永远不再请求
    if (freeData && freeData.__lookupTransient) {
      return existing || null;
    }

    const missed = markLookupMiss(
      existing,
      word,
      (freeData && freeData.__lookupError) || 'online_not_found'
    );
    await saveOneWordDictionary(word, missed);
    applyDictToSessionWord(word, missed);
    return missed;
  }

  function applyDictToSessionWord(word, dictData) {
    if (!dictData) return;
    const lower = word.toLowerCase();
    const item = words.find(w => w.word.toLowerCase() === lower);
    if (item) {
      item.dictData = dictData;
      const phonetic = extractPhonetic(dictData);
      if (phonetic) item.phonetic = phonetic;
    }
  }

  async function saveDictionaryMap(dictionaryMap) {
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const userData = {};
    userData[`${userKey}wordDictionaryData`] = Array.from(dictionaryMap.entries());
    await new Promise((resolve) => {
      chrome.storage.local.set(userData, resolve);
    });
  }

  async function saveOneWordDictionary(word, dictData) {
    if (!word || !dictData) return;
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const key = `${userKey}wordDictionaryData`;
    const result = await new Promise((resolve) => {
      chrome.storage.local.get([key], resolve);
    });
    const dictionaryMap = new Map(result[key] || []);
    const lower = word.toLowerCase();
    dictionaryMap.set(lower, dictData);
    if (dictionaryMap.has(word) && word !== lower) {
      dictionaryMap.set(word, dictData);
    }
    const userData = {};
    userData[key] = Array.from(dictionaryMap.entries());
    await new Promise((resolve) => {
      chrome.storage.local.set(userData, resolve);
    });
  }

  // 禁止开测时批量刷词库（1600+ 词会爆费用）；按需单词查询即可
  async function refreshUserDictionaryBank() {
    return;
  }

  async function resolvePhonetic(wordObj) {
    if (!wordObj) return '';
    if (wordObj.phonetic) return wordObj.phonetic;

    const word = wordObj.word;

    try {
      const offlineData = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { action: 'queryOfflineDictData', word },
            (response) => {
              if (chrome.runtime.lastError) {
                resolve(null);
                return;
              }
              resolve(response && response.success ? response.data : null);
            }
          );
        } catch (e) {
          resolve(null);
        }
      });
      const offlinePhonetic = extractPhonetic(offlineData);
      if (offlinePhonetic) {
        wordObj.phonetic = offlinePhonetic;
        return offlinePhonetic;
      }
    } catch (e) {
      // ignore
    }

    try {
      const onlineData = await fetchDictionaryInfo(word);
      const onlinePhonetic = extractPhonetic(onlineData);
      if (onlinePhonetic) {
        wordObj.phonetic = onlinePhonetic;
        wordObj.dictData = onlineData;
        return onlinePhonetic;
      }
    } catch (e) {
      // ignore
    }

    return '';
  }

  function shuffleInPlace(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  async function fetchSavedWordEntries(filterFn) {
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;

    return new Promise((resolve) => {
      chrome.storage.local.get([
        `${userKey}savedWords`,
        `${userKey}wordTranslations`,
        `${userKey}wordDictionaryData`,
        `${userKey}wordStatus`,
        `${userKey}wordChineseTranslations`
      ], (result) => {
        const savedWords = result[`${userKey}savedWords`] || [];
        const translations = new Map(result[`${userKey}wordTranslations`] || []);
        const chineseOnly = new Map(result[`${userKey}wordChineseTranslations`] || []);
        const dictionaryMap = new Map(result[`${userKey}wordDictionaryData`] || []);
        const statuses = new Map(result[`${userKey}wordStatus`] || []);

        let list = savedWords.map((word) => {
          const lower = word.toLowerCase();
          const dictData = dictionaryMap.get(word) || dictionaryMap.get(lower) || null;
          const translation =
            translations.get(word) ||
            translations.get(lower) ||
            chineseOnly.get(word) ||
            chineseOnly.get(lower) ||
            (dictData && dictData.translation) ||
            '';
          return {
            word: word,
            translation: String(translation || '').trim(),
            status: statuses.get(word) || statuses.get(lower) || 'new',
            phonetic: extractPhonetic(dictData),
            dictData: dictData
          };
        });

        if (typeof filterFn === 'function') {
          list = list.filter(filterFn);
        }

        resolve(shuffleInPlace(list));
      });
    });
  }

  async function fetchUnmasteredWords() {
    return fetchSavedWordEntries((w) => w.status === 'new');
  }

  async function loadWords(limit) {
    // 题目只从未记住里抽；干扰项用整份生词本，避免小会话落到无单词绑定的占位选项
    const allUnmastered = await fetchUnmasteredWords();
    optionPool = await fetchSavedWordEntries((w) => !!(w.word && w.translation));
    if (!optionPool.length) {
      optionPool = allUnmastered.filter((w) => w.word && w.translation);
    }

    const n = Number(limit);
    if (!n || n <= 0 || n >= allUnmastered.length) {
      words = allUnmastered;
    } else {
      words = allUnmastered.slice(0, n);
    }
  }

  function getSelectedSessionCount() {
    const els = getEls();
    if (!els.sessionCount) return 10;
    const n = parseInt(els.sessionCount.value, 10);
    return Number.isFinite(n) ? n : 10;
  }

  function restoreSessionCountSelect() {
    const els = getEls();
    if (!els.sessionCount) return;
    chrome.storage.local.get([SESSION_COUNT_KEY], (result) => {
      const saved = result[SESSION_COUNT_KEY];
      if (saved == null) return;
      const value = String(saved);
      if ([...els.sessionCount.options].some((opt) => opt.value === value)) {
        els.sessionCount.value = value;
      }
    });
  }

  function persistSessionCount() {
    chrome.storage.local.set({ [SESSION_COUNT_KEY]: getSelectedSessionCount() });
  }

  async function refreshAvailableCount() {
    const els = getEls();
    if (!els.availableCount) return;
    const all = await fetchUnmasteredWords();
    const selected = getSelectedSessionCount();
    const take = (!selected || selected <= 0) ? all.length : Math.min(selected, all.length);
    if (!all.length) {
      els.availableCount.textContent = '待记单词：0 个（请先把单词标为「未记住」）';
      return;
    }
    const tip = all.length < 4
      ? ' · 生词不足 4 个时，干扰项从离线词典抽取；点词典选项会加入生词本'
      : '';
    els.availableCount.textContent = `待记单词：${all.length} 个 · 本轮将抽取 ${take} 个${tip}`;
  }

  function showStartScreen() {
    bindEvents();
    stopCorrectCountdown();
    isActive = false;
    isAnswerShown = false;
    isSubmitting = false;
    selectedOption = -1;
    words = [];
    optionPool = [];
    currentIndex = 0;
    completedCount = 0;
    sessionTotal = 0;
    questionToken += 1;

    if (typeof window.closeWordDetail === 'function') {
      window.closeWordDetail();
    }

    const els = getEls();
    if (els.startScreen) els.startScreen.style.display = 'flex';
    if (els.sessionArea) els.sessionArea.style.display = 'none';
    if (els.wordCard) els.wordCard.style.display = 'none';
    if (els.testActions) els.testActions.style.display = 'none';
    if (els.emptyState) els.emptyState.style.display = 'none';
    if (els.finishState) els.finishState.style.display = 'none';
    restoreSessionCountSelect();
    refreshAvailableCount();
  }

  function refreshMainStats() {
    if (typeof window.refreshVocabStats === 'function') {
      window.refreshVocabStats();
    }
  }

  function updateProgressUI() {
    const els = getEls();
    if (!els.currentIndexEl || !els.totalWordsEl || !els.progressFill) return;

    const total = sessionTotal || 0;
    const done = Math.min(completedCount, total);
    const showing = total === 0 ? 0 : Math.min(done + (words.length > 0 ? 1 : 0), total);

    els.currentIndexEl.textContent = String(words.length === 0 ? done : showing);
    els.totalWordsEl.textContent = String(total);
    const percent = total > 0 ? (done / total) * 100 : 0;
    els.progressFill.style.width = percent + '%';
  }

  function shortenOptionLabel(text) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    // 大词库释义很长：选项里只展示前两段/前 36 字，完整文本仍用于反查
    const parts = raw.split(/[；;。]/).map((p) => p.trim()).filter(Boolean);
    let label = parts.slice(0, 2).join('；') || raw;
    if (label.length > 36) label = label.slice(0, 36) + '…';
    return label;
  }

  function sampleOfflineDictWords(count, excludeWords) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            action: 'sampleOfflineDictWords',
            count,
            exclude: excludeWords || []
          },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve([]);
              return;
            }
            resolve((response && response.words) || []);
          }
        );
      } catch (e) {
        resolve([]);
      }
    });
  }

  async function generateOptions(correctWordObj, poolWords) {
    const correctWord = correctWordObj.word || '';
    const rawTranslation = String(correctWordObj.translation || '').trim();
    const correctAnswer = rawTranslation || `（暂无释义：${correctWord}）`;
    const entries = [{ text: correctAnswer, word: correctWord, source: 'vocab' }];

    const seenText = new Set([correctAnswer, rawTranslation].filter(Boolean));
    const seenWords = new Set([String(correctWord).toLowerCase()]);
    const distractors = (poolWords || [])
      .filter((w) => {
        if (!w || !w.word) return false;
        const lower = String(w.word).toLowerCase();
        if (seenWords.has(lower)) return false;
        const t = String(w.translation || '').trim();
        if (!t || seenText.has(t)) return false;
        return true;
      })
      .map((w) => {
        const t = String(w.translation || '').trim();
        seenText.add(t);
        seenWords.add(String(w.word).toLowerCase());
        return { text: t, word: w.word, source: 'vocab' };
      })
      .sort(() => Math.random() - 0.5);

    while (entries.length < 4 && distractors.length > 0) {
      entries.push(distractors.shift());
    }

    // 生词本不足 4 个选项：从离线词典抽词补齐
    if (entries.length < 4) {
      const need = 4 - entries.length;
      const exclude = Array.from(seenWords);
      const samples = await sampleOfflineDictWords(need, exclude);
      samples.forEach((sample) => {
        if (entries.length >= 4) return;
        const w = String(sample.word || '').trim();
        const t = String(sample.translation || '').trim();
        if (!w || !t) return;
        const lower = w.toLowerCase();
        if (seenWords.has(lower) || seenText.has(t)) return;
        seenWords.add(lower);
        seenText.add(t);
        entries.push({ text: t, word: w, source: 'dict' });
      });
    }

    const shuffled = entries.slice(0, 4).sort(() => Math.random() - 0.5);

    correctOptionIndex = shuffled.findIndex((opt) => {
      if (opt.word && String(opt.word).toLowerCase() === String(correctWord).toLowerCase()) return true;
      if (opt.text && opt.text === correctAnswer) return true;
      return false;
    });
    if (correctOptionIndex < 0) correctOptionIndex = 0;

    currentOptionWords = shuffled.map((opt) => opt.word || '');
    currentOptionSources = shuffled.map((opt) => opt.source || 'vocab');
    return shuffled.map((opt) => opt.text);
  }

  async function openOptionWordDetail(index) {
    const text = currentOptions[index] || '';
    const word = currentOptionWords[index] || '';
    const source = currentOptionSources[index] || 'vocab';
    if (!word || typeof window.openWordDetail !== 'function') return;

    // 非生词本（词典抽来的）选项：点开详情时加入生词本；生词本内选项不重复加入
    if (source === 'dict' && typeof window.addLookupWordToVocab === 'function') {
      try {
        await window.addLookupWordToVocab(word, {
          translation: text,
          source: 'ecd',
          silent: true
        });
      } catch (e) {}
    }

    await window.openWordDetail(word, text);
  }

  async function showCurrentWord() {
    const els = getEls();
    if (!els.wordCard) return;

    if (els.finishState) els.finishState.style.display = 'none';

    if (words.length === 0) {
      els.wordCard.style.display = 'none';
      if (els.testActions) els.testActions.style.display = 'none';
      if (els.emptyState) els.emptyState.style.display = 'block';
      resetDictionaryPanel();
      updateProgressUI();
      return;
    }

    if (els.emptyState) els.emptyState.style.display = 'none';
    els.wordCard.style.display = 'flex';
    if (els.testActions) els.testActions.style.display = 'flex';
    resetDictionaryPanel();

    const currentWord = words[currentIndex];
    const showingIndex = currentIndex;
    els.wordText.textContent = currentWord.word;
    renderTestWordPhonetic(els.wordPhonetic, currentWord.word, currentWord.phonetic);
    els.wordStatus.textContent = currentWord.status === 'mastered' ? '✓ 已记住' : '未记住';

    if (!currentWord.phonetic) {
      resolvePhonetic(currentWord).then((phonetic) => {
        if (showingIndex === currentIndex && phonetic) {
          updateTestWordPhoneticText(els.wordPhonetic, phonetic);
        }
      });
    }

    const pool = optionPool.length ? optionPool : words;
    currentOptions = await generateOptions(currentWord, pool);
    if (showingIndex !== currentIndex) return;

    els.optionBtns.forEach((btn, index) => {
      const optionText = btn.querySelector('.option-text');
      const raw = currentOptions[index];
      if (raw != null && String(raw).length > 0) {
        optionText.textContent = shortenOptionLabel(raw);
        btn.style.display = 'flex';
        const fromDict = currentOptionSources[index] === 'dict';
        btn.title = currentOptionWords[index]
          ? (fromDict
            ? `词典词：${currentOptionWords[index]}（点击加入生词本并查看）`
            : `查看单词：${currentOptionWords[index]}`)
          : '';
      } else {
        btn.style.display = 'none';
        btn.title = '';
      }
    });

    stopCorrectCountdown();
    questionToken += 1;
    isAnswerShown = false;
    isSubmitting = false;
    selectedOption = -1;
    els.wordCard.classList.remove('wrong-answer');
    els.answerFeedback.textContent = '';
    els.answerFeedback.classList.remove('show', 'correct', 'wrong');

    els.optionBtns.forEach(btn => {
      btn.classList.remove('selected', 'correct', 'wrong', 'disabled');
    });

    els.retryBtn.style.display = 'none';
    els.dontKnowBtn.style.display = 'none';
    els.nextBtn.style.display = 'none';
    if (els.finishBtn) els.finishBtn.style.display = 'none';

    updateProgressUI();

    // 题目出现时自动读美音
    speakWord(currentWord.word, 2);
  }

  function selectOption(index) {
    if (isAnswerShown || isSubmitting) return;
    selectedOption = index;
    const els = getEls();
    els.optionBtns.forEach((btn, i) => {
      btn.classList.toggle('selected', i === index);
    });
  }

  async function submitAnswer() {
    // 同一题只允许提交一次，避免连点跳过多个单词
    if (isAnswerShown || isSubmitting || selectedOption === -1) {
      return;
    }
    isSubmitting = true;
    isAnswerShown = true;

    const els = getEls();
    const token = questionToken;
    const isCorrect = selectedOption === correctOptionIndex;

    els.optionBtns.forEach(btn => btn.classList.add('disabled'));
    els.optionBtns.forEach((btn, index) => {
      if (index === correctOptionIndex) {
        btn.classList.add('correct');
      } else if (index === selectedOption && !isCorrect) {
        btn.classList.add('wrong');
      }
    });

    if (isCorrect) {
      els.answerFeedback.textContent = '✓ 回答正确！';
      els.answerFeedback.classList.add('show', 'correct');
      startCorrectCountdown(token);
    } else {
      els.answerFeedback.textContent = `✗ 回答错误，正确答案是：${currentOptions[correctOptionIndex]}`;
      els.answerFeedback.classList.add('show', 'wrong');
      els.wordCard.classList.add('wrong-answer');
      if (els.retryBtn) els.retryBtn.style.display = 'none';
      if (els.dontKnowBtn) els.dontKnowBtn.style.display = 'none';
      if (els.nextBtn) els.nextBtn.style.display = 'inline-block';
      isSubmitting = false;
      showWordDetails({ countAsWrong: false });
    }
  }

  function retryAnswer() {
    if (typeof window.closeWordDetail === 'function') {
      window.closeWordDetail();
    }
    showCurrentWord();
  }

  function resetDictionaryPanel() {
    // 详情改用主页浮窗，右侧面板已移除
  }

  function showDictionaryInfo(wordData, word) {
    const els = getEls();
    if (els.dictionaryCard) els.dictionaryCard.style.display = '';
    els.dictWord.textContent = word;

    let html = '';
    if (!hasDeepseekCached(wordData)) {
      html += `<div class="deepseek-action-row">
        <button type="button" class="btn-deepseek-enrich" data-word="${String(word || '').replace(/"/g, '&quot;')}">
          用 DeepSeek 补全用法/例句
        </button>
        <span class="deepseek-action-hint">付费 API，仅当前词；结果会缓存</span>
      </div>`;
    } else {
      html += `<div class="deepseek-action-row done">已用 DeepSeek 补全并缓存</div>`;
    }

    if (!wordData) {
      html += `<div class="dict-phonetic" title="点击播放读音">`;
      html += `<span class="dict-phonetic-text muted">暂无音标</span>`;
      html += `<button type="button" class="dict-speak-btn" data-word="${String(word || '').replace(/"/g, '&quot;')}" data-type="1" title="英音">🔊 英</button>`;
      html += `<button type="button" class="dict-speak-btn" data-word="${String(word || '').replace(/"/g, '&quot;')}" data-type="2" title="美音">🔊 美</button>`;
      html += `</div>`;
      html += `
        <div class="loading-dict">
          <p>无法获取词典信息</p>
          <p style="margin-top: 10px; font-size: 14px;">单词：${word}</p>
          <p style="margin-top: 5px; font-size: 14px;">翻译：${words[currentIndex] ? words[currentIndex].translation : ''}</p>
        </div>
      `;
      els.dictContent.innerHTML = html;
      bindDictSpeakButtons(els.dictContent, word);
      bindDeepseekEnrichButton(els.dictContent, word);
      return;
    }

    {
      const phonetic = (wordData.phonetics || []).find((p) => p && p.text) || null;
      const phoneticText = phonetic && phonetic.text ? String(phonetic.text).trim() : '';
      html += `<div class="dict-phonetic" title="点击播放读音">`;
      if (phoneticText) {
        html += `<span class="dict-phonetic-text">/${phoneticText.replace(/</g, '&lt;')}/</span>`;
      } else {
        html += `<span class="dict-phonetic-text muted">暂无音标</span>`;
      }
      html += `<button type="button" class="dict-speak-btn" data-word="${String(word || '').replace(/"/g, '&quot;')}" data-type="1" title="英音">🔊 英</button>`;
      html += `<button type="button" class="dict-speak-btn" data-word="${String(word || '').replace(/"/g, '&quot;')}" data-type="2" title="美音">🔊 美</button>`;
      html += `</div>`;
    }
    {
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
      if (isLookupMiss(wordData)) {
        sourceParts.push(`在线查询无结果（已标记，不再自动请求${wordData.lookupMissReason ? ' · ' + wordData.lookupMissReason : ''}）`);
      } else if (wordData.sourceAbbr) {
        sourceParts.push(`当前释义：${srcMap[wordData.sourceAbbr] || wordData.sourceAbbr}`);
      }
      const allSources = collectSourceCodes(wordData)
        .filter((code) => code !== wordData.sourceAbbr)
        .map((code) => srcMap[code] || code);
      if (allSources.length) {
        sourceParts.push(`也曾使用：${allSources.join('、')}`);
      }
      const phoneticForSource = (wordData.phonetics || []).find((p) => p && p.text) || null;
      if (phoneticForSource && phoneticForSource.source) {
        sourceParts.push(`音标：${srcMap[phoneticForSource.source] || phoneticForSource.source}`);
      }
      if (wordData.detailCached) sourceParts.push('已缓存到本地');
      if (sourceParts.length) {
        html += `<div style="font-size:12px;color:#888;margin-bottom:12px;">来源：${sourceParts.join(' · ')}</div>`;
      }
    }
    if (wordData.usage) {
      html += `<div style="font-size:14px;color:#555;margin-bottom:14px;line-height:1.5;">用法：${wordData.usage}</div>`;
    }
    if (wordData.translation) {
      const zhSrc = wordData.translationSource
        || wordData._chineseSource
        || (wordData.sourceAbbr === 'deepseek' ? 'deepseek' : '')
        || '';
      const zhLabel = chineseSourceLabel(zhSrc);
      html += `<div style="font-size:14px;color:#333;margin-bottom:14px;">中文${zhLabel ? `（${zhLabel}）` : ''}：${wordData.translation}</div>`;
    }

    if (wordData.meanings && wordData.meanings.length > 0) {
      wordData.meanings.forEach(meaning => {
        html += `<div class="dict-meaning">`;
        html += `<div class="dict-part-of-speech">${meaning.partOfSpeech}</div>`;
        if (meaning.definitions && meaning.definitions.length > 0) {
          meaning.definitions.slice(0, 3).forEach((def, index) => {
            html += `<div class="dict-definition">`;
            html += `<div class="dict-def-text">${index + 1}. ${def.definition}</div>`;
            if (def.example) {
              html += `<div class="dict-example">${def.example}</div>`;
            }
            html += `</div>`;
          });
        }
        if (meaning.synonyms && meaning.synonyms.length > 0) {
          html += `<div class="dict-synonyms">`;
          html += `<div class="dict-synonyms-title">同义词：</div>`;
          html += `<div class="dict-synonyms-list">`;
          meaning.synonyms.slice(0, 5).forEach(syn => {
            html += `<span class="dict-synonym">${syn}</span>`;
          });
          html += `</div></div>`;
        }
        html += `</div>`;
      });
    }

    els.dictContent.innerHTML = html || '<div class="loading-dict">暂无详细信息</div>';
    bindDictSpeakButtons(els.dictContent, word);
    bindDeepseekEnrichButton(els.dictContent, word);
    els.dictionaryCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
        source: 'test-tts',
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

  function bindDictSpeakButtons(container, word) {
    if (!container) return;
    container.querySelectorAll('.dict-speak-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const w = btn.getAttribute('data-word') || word;
        const type = parseInt(btn.getAttribute('data-type'), 10) || 2;
        speakWord(w, type);
      });
    });
    const phoneticEl = container.querySelector('.dict-phonetic');
    if (phoneticEl) {
      phoneticEl.addEventListener('click', (e) => {
        if (e.target.closest('.dict-speak-btn')) return;
        speakWord(word, 2);
      });
    }
  }

  function bindDeepseekEnrichButton(container, word) {
    const btn = container && container.querySelector('.btn-deepseek-enrich');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'DeepSeek 请求中...';
      const existing = dictionaryData || (words[currentIndex] && words[currentIndex].dictData) || null;
      const deepseekData = await fetchDeepseekInfo(word);
      if (hasRichMeanings(deepseekData)) {
        const marked = markDetailCached(mergeDictionaryData(existing, deepseekData), 'deepseek');
        if (deepseekData.translation) {
          marked.translationSource = 'deepseek';
          await saveStoredChineseSource(word, 'deepseek');
          const currentUserId = await getCurrentUserId();
          const userKey = `user_${currentUserId}_`;
          const zhKey = `${userKey}wordTranslations`;
          const zhCnKey = `${userKey}wordChineseTranslations`;
          const zhStore = await new Promise((resolve) => {
            chrome.storage.local.get([zhKey, zhCnKey], resolve);
          });
          const tMap = new Map(zhStore[zhKey] || []);
          const cMap = new Map(zhStore[zhCnKey] || []);
          const lower = String(word).toLowerCase();
          tMap.set(lower, deepseekData.translation);
          cMap.set(lower, deepseekData.translation);
          await new Promise((resolve) => {
            chrome.storage.local.set({
              [zhKey]: Array.from(tMap.entries()),
              [zhCnKey]: Array.from(cMap.entries())
            }, resolve);
          });
          const sessionItem = words.find((w) => w.word.toLowerCase() === lower);
          if (sessionItem) sessionItem.translation = deepseekData.translation;
          if (typeof window.refreshVocabStats === 'function') {
            window.refreshVocabStats();
          }
        }
        await saveOneWordDictionary(word, marked);
        applyDictToSessionWord(word, marked);
        dictionaryData = marked;
        if (!words[currentIndex] || words[currentIndex].word !== word) return;
        showDictionaryInfo(marked, word);
      } else {
        btn.disabled = false;
        btn.textContent = original;
        if (typeof window.showAppAlert === 'function') {
          window.showAppAlert('DeepSeek 调用失败或未配置 Key，请到设置页检查。', 'DeepSeek');
        }
      }
    });
  }

  // 展示当前单词详细信息（复用单词列表浮窗）；countAsWrong 仅影响按钮
  async function showWordDetails(options = {}) {
    const countAsWrong = options.countAsWrong === true;
    const els = getEls();
    const currentWord = words[currentIndex];
    if (!currentWord) return;

    if (typeof window.openWordDetail === 'function') {
      await window.openWordDetail(currentWord.word, currentWord.translation || '');
    }

    if (countAsWrong) {
      if (els.retryBtn) els.retryBtn.style.display = 'none';
      if (els.dontKnowBtn) els.dontKnowBtn.style.display = 'none';
      if (els.nextBtn) els.nextBtn.style.display = 'inline-block';
    }
  }

  async function showDontKnow() {
    await showWordDetails({ countAsWrong: true });
  }

  async function markAsMastered(token) {
    if (token != null && token !== questionToken) return;
    if (!words[currentIndex]) {
      finishTest();
      return;
    }

    const currentWord = words[currentIndex];
    const lowerWord = currentWord.word.toLowerCase();
    const currentUserId = await getCurrentUserId();
    const userKey = `user_${currentUserId}_`;
    const tokenAtStart = questionToken;

    chrome.storage.local.get([`${userKey}wordStatus`], (result) => {
      if (tokenAtStart !== questionToken) return;

      const statuses = new Map(result[`${userKey}wordStatus`] || []);
      statuses.set(lowerWord, 'mastered');

      const userData = {};
      userData[`${userKey}wordStatus`] = Array.from(statuses.entries());

      chrome.storage.local.set(userData, () => {
        if (tokenAtStart !== questionToken) return;

        completedCount += 1;
        words.splice(currentIndex, 1);
        if (currentIndex >= words.length && words.length > 0) {
          currentIndex = words.length - 1;
        }
        refreshMainStats();
        updateProgressUI();
        if (words.length === 0) {
          finishTest();
        } else {
          showCurrentWord();
        }
      });
    });
  }

  function nextWord() {
    if (typeof window.closeWordDetail === 'function') {
      window.closeWordDetail();
    }
    // 跳过当前题也计入进度，并从本轮队列移除，避免进度回退
    if (words.length === 0) {
      finishTest();
      return;
    }
    completedCount += 1;
    words.splice(currentIndex, 1);
    if (currentIndex >= words.length && words.length > 0) {
      currentIndex = words.length - 1;
    }
    updateProgressUI();
    if (words.length === 0) {
      finishTest();
    } else {
      showCurrentWord();
    }
  }

  function finishTest() {
    const els = getEls();
    if (typeof window.closeWordDetail === 'function') {
      window.closeWordDetail();
    }
    if (els.wordCard) els.wordCard.style.display = 'none';
    if (els.testActions) els.testActions.style.display = 'none';
    resetDictionaryPanel();
    if (els.emptyState) els.emptyState.style.display = 'none';
    completedCount = Math.max(completedCount, sessionTotal);
    updateProgressUI();
    isActive = false;
    refreshMainStats();

    const total = sessionTotal || 0;
    const msg = total > 0
      ? `本轮记忆完成！共 ${total} 个单词。`
      : '本轮没有可测单词。';
    if (els.finishMessage) els.finishMessage.textContent = msg;
    if (els.finishState) els.finishState.style.display = 'block';
    if (els.sessionArea) els.sessionArea.style.display = 'block';
    if (els.startScreen) els.startScreen.style.display = 'none';

    if (typeof window.showAppAlert === 'function') {
      window.showAppAlert(msg, '本轮完成');
    }
  }

  function isTestTabVisible() {
    const testTab = $('testTab');
    return testTab && !testTab.classList.contains('hidden');
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;

    const els = getEls();

    els.optionBtns.forEach((btn, index) => {
      btn.addEventListener('click', () => {
        if (!isActive) return;
        // 答对倒计时 / 暂停 / 答错等待时：点不同选项查看对应单词详情
        if (isAnswerShown) {
          openOptionWordDetail(index);
          return;
        }
        if (isSubmitting) return;
        selectOption(index);
        submitAnswer();
      });
    });

    if (els.retryBtn) els.retryBtn.addEventListener('click', retryAnswer);
    if (els.dontKnowBtn) els.dontKnowBtn.addEventListener('click', showDontKnow);
    if (els.nextBtn) els.nextBtn.addEventListener('click', nextWord);
    if (els.finishBtn) els.finishBtn.addEventListener('click', finishTest);
    if (els.countdownBtn) els.countdownBtn.addEventListener('click', onCountdownButtonClick);
    if (els.dictClose) {
      els.dictClose.addEventListener('click', () => {
        resetDictionaryPanel();
      });
    }

    const restartBtn = $('restartTestBtn');
    if (restartBtn) {
      restartBtn.addEventListener('click', () => showStartScreen());
    }

    if (els.startBtn) {
      els.startBtn.addEventListener('click', () => {
        persistSessionCount();
        startTest(getSelectedSessionCount());
      });
    }
    if (els.sessionCount) {
      els.sessionCount.addEventListener('change', () => {
        persistSessionCount();
        refreshAvailableCount();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (!isActive || !isTestTabVisible()) return;

      if (e.key === 'ArrowRight' && isAnswerShown) {
        nextWord();
        return;
      }

      if (isAnswerShown || isSubmitting) return;

      if (e.key >= '1' && e.key <= '4') {
        const index = parseInt(e.key, 10) - 1;
        const elsNow = getEls();
        if (index < elsNow.optionBtns.length && elsNow.optionBtns[index].style.display !== 'none') {
          selectOption(index);
          submitAnswer();
        }
      }
    });
  }

  async function startTest(limit) {
    bindEvents();
    isActive = true;
    currentIndex = 0;
    completedCount = 0;
    sessionTotal = 0;
    isAnswerShown = false;
    isSubmitting = false;
    selectedOption = -1;
    stopCorrectCountdown();
    questionToken += 1;

    const els = getEls();
    if (els.startScreen) els.startScreen.style.display = 'none';
    if (els.sessionArea) els.sessionArea.style.display = 'block';
    if (els.finishState) els.finishState.style.display = 'none';
    if (els.emptyState) els.emptyState.style.display = 'none';
    resetDictionaryPanel();

    const count = limit == null ? getSelectedSessionCount() : limit;
    await loadWords(count);
    sessionTotal = words.length;
    completedCount = 0;
    updateProgressUI();

    if (words.length === 0) {
      isActive = false;
      if (typeof window.showAppAlert === 'function') {
        window.showAppAlert('当前没有未记住的单词，请先收藏或把单词标为「未记住」。', '无法开始');
      }
      showStartScreen();
      return;
    }

    // 生词不足 4 个时，干扰项从离线词典抽取
    await showCurrentWord();
    refreshMainStats();
  }

  window.VocabQuiz = {
    start: startTest,
    showStartScreen,
    isActive: () => isActive
  };
})();
