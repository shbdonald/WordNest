// Options / Settings pane — 由主页首次打开「设置」tab 时调用 initVocabSettings
(function () {
  let settingsInited = false;

  window.initVocabSettings = function initVocabSettings() {
  if (settingsInited) return;
  const probeApiOrderBtn = document.getElementById('probeApiOrderBtn');
  if (!probeApiOrderBtn) return;
  settingsInited = true;

  const apiRouteSummary = document.getElementById('apiRouteSummary');
  const apiProbeStatus = document.getElementById('apiProbeStatus');
  const probeApiStatusBtn = document.getElementById('probeApiStatusBtn');
  const resetApiOrderBtn = document.getElementById('resetApiOrderBtn');
  const baiduAppId = document.getElementById('baiduAppId');
  const baiduSecretKey = document.getElementById('baiduSecretKey');
  const baiduStatus = document.getElementById('baiduStatus');
  const saveStatus = document.getElementById('saveStatus');
  const deepseekApiKey = document.getElementById('deepseekApiKey');
  const testDeepseekBtn = document.getElementById('testDeepseekBtn');
  const deepseekStatus = document.getElementById('deepseekStatus');
  const sentenceTranslateStatus = document.getElementById('sentenceTranslateStatus');
  const sentenceModeInputs = document.querySelectorAll('input[name="sentenceTranslateMode"]');
  const uiThemeStatus = document.getElementById('uiThemeStatus');
  const uiThemeInputs = document.querySelectorAll('input[name="uiTheme"]');
  const UI_THEMES = ['violet', 'ocean', 'forest', 'sunset', 'night'];
  const UI_THEME_LABELS = {
    violet: '暮紫',
    ocean: '海蓝',
    forest: '森绿',
    sunset: '暖阳',
    night: '夜色'
  };

  const DICT_ZH_IDS = ['offline', 'youdao_dict', 'd3325'];
  const DICT_EN_IDS = ['fd', 'datamuse'];

  const DEFAULT_API_ROUTE = {
    translateOrder: ['offline', 'youdao', 'baidu', 'gt', 'mm'],
    dictZhPrimary: 'offline',
    dictZhBackup: 'youdao_dict',
    dictEnPrimary: 'fd',
    dictEnBackup: 'datamuse',
    // 兼容旧逻辑：由主备展开
    dictOrder: ['offline', 'youdao_dict', 'fd', 'datamuse'],
    ttsOrder: ['youdao_tts', 'google_tts'],
    probedAt: 0,
    results: []
  };

  const ROUTE_LABELS = {
    offline: '离线词典',
    youdao: '有道翻译',
    youdao_dict: '有道词典',
    d3325: '3325词典',
    baidu: '百度',
    gt: 'Google 翻译',
    mm: 'MyMemory',
    fd: 'Free Dictionary',
    datamuse: 'Datamuse',
    youdao_tts: '有道发音',
    google_tts: 'Google 发音'
  };

  function pickAllowed(id, allowed, fallback) {
    return allowed.includes(id) ? id : fallback;
  }

  function buildDictOrderFromSlots(zhPrimary, zhBackup, enPrimary, enBackup) {
    const out = [];
    [zhPrimary, zhBackup, enPrimary, enBackup].forEach((id) => {
      if (id && !out.includes(id)) out.push(id);
    });
    return out;
  }

  function normalizeDetailSlots(src) {
    const raw = src && typeof src === 'object' ? src : {};
    let zhPrimary = pickAllowed(raw.dictZhPrimary, DICT_ZH_IDS, DEFAULT_API_ROUTE.dictZhPrimary);
    let zhBackup = pickAllowed(raw.dictZhBackup, DICT_ZH_IDS, DEFAULT_API_ROUTE.dictZhBackup);
    let enPrimary = pickAllowed(raw.dictEnPrimary, DICT_EN_IDS, DEFAULT_API_ROUTE.dictEnPrimary);
    let enBackup = pickAllowed(raw.dictEnBackup, DICT_EN_IDS, DEFAULT_API_ROUTE.dictEnBackup);

    // 旧配置仅有 dictOrder 时，按顺序拆成中英主备
    if (!raw.dictZhPrimary && !raw.dictEnPrimary && Array.isArray(raw.dictOrder)) {
      const zh = raw.dictOrder.filter((id) => DICT_ZH_IDS.includes(id));
      const en = raw.dictOrder.filter((id) => DICT_EN_IDS.includes(id));
      if (zh[0]) zhPrimary = zh[0];
      if (zh.find((id) => id !== zhPrimary)) zhBackup = zh.find((id) => id !== zhPrimary);
      if (en[0]) enPrimary = en[0];
      if (en.find((id) => id !== enPrimary)) enBackup = en.find((id) => id !== enPrimary);
    }
    if (zhBackup === zhPrimary) {
      zhBackup = DICT_ZH_IDS.find((id) => id !== zhPrimary) || zhPrimary;
    }
    if (enBackup === enPrimary) {
      enBackup = DICT_EN_IDS.find((id) => id !== enPrimary) || enPrimary;
    }
    return {
      dictZhPrimary: zhPrimary,
      dictZhBackup: zhBackup,
      dictEnPrimary: enPrimary,
      dictEnBackup: enBackup,
      dictOrder: buildDictOrderFromSlots(zhPrimary, zhBackup, enPrimary, enBackup)
    };
  }

  let currentRouteCfg = JSON.parse(JSON.stringify(DEFAULT_API_ROUTE));
  let baiduConfigured = false;

  // HTTP Header 只能是 ISO-8859-1；粘贴 Key 时常见全角/零宽字符，需清洗
  function sanitizeApiKey(key) {
    return String(key || '')
      .replace(/^\uFEFF/, '')
      .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
      .replace(/[“”‘’]/g, '')
      .trim()
      .replace(/[^\x21-\x7E]/g, ''); // 仅保留可见 ASCII（不含空格）
  }

  function showStatus(element, message, type) {
    if (!element) return;
    element.textContent = message;
    element.className = `status-message ${type}`;
    element.style.display = 'block';
  }

  function flashStatus(element, message, type, ms) {
    showStatus(element, message, type);
    setTimeout(() => {
      if (element) element.style.display = 'none';
    }, ms || 2500);
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      const ctx = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(ctx, args), wait);
    };
  }

  function normalizeOrder(order, defaults) {
    const base = Array.isArray(order) ? order.slice() : [];
    const out = [];
    base.forEach((id) => {
      if (defaults.includes(id) && !out.includes(id)) out.push(id);
    });
    defaults.forEach((id) => {
      if (!out.includes(id)) out.push(id);
    });
    return out;
  }

  function normalizeRouteCfg(cfg) {
    const src = cfg && typeof cfg === 'object' ? cfg : {};
    const slots = normalizeDetailSlots(src);
    return {
      translateOrder: normalizeOrder(src.translateOrder, DEFAULT_API_ROUTE.translateOrder),
      ...slots,
      ttsOrder: normalizeOrder(src.ttsOrder, DEFAULT_API_ROUTE.ttsOrder),
      probedAt: src.probedAt || 0,
      results: Array.isArray(src.results) ? src.results : []
    };
  }

  function statusForId(id, results) {
    if (id === 'baidu' && !baiduConfigured) {
      return { kind: 'skip', text: '未配置' };
    }
    const hit = (results || []).find((r) => r.id === id);
    if (!hit) return { kind: 'unknown', text: '未检测' };
    if (hit.ok) return { kind: 'ok', text: `${Math.round(hit.ms)} ms` };
    return { kind: 'fail', text: hit.error ? `失败·${hit.error}` : '失败' };
  }

  function renderOrderList(kind, title, order, results) {
    const rows = (order || []).map((id, index) => {
      const st = statusForId(id, results);
      const color = st.kind === 'ok' ? '#2e7d32' : (st.kind === 'fail' ? '#c62828' : '#64748b');
      const bg = st.kind === 'ok' ? '#e8f5e9' : (st.kind === 'fail' ? '#ffebee' : '#f1f5f9');
      return `
        <div class="api-route-row" data-kind="${kind}" data-id="${id}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:6px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;">
          <span style="width:22px;color:#94a3b8;font-size:12px;text-align:center;">${index + 1}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;color:#334155;">${ROUTE_LABELS[id] || id}</div>
          </div>
          <span style="font-size:12px;padding:2px 8px;border-radius:999px;background:${bg};color:${color};white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${st.text}">${st.text}</span>
          <button type="button" class="btn btn-primary api-route-up" data-kind="${kind}" data-index="${index}" style="padding:4px 8px;font-size:12px;line-height:1;" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn btn-primary api-route-down" data-kind="${kind}" data-index="${index}" style="padding:4px 8px;font-size:12px;line-height:1;" ${index >= order.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
      `;
    }).join('');

    return `
      <div style="margin-bottom:14px;">
        <div style="font-weight:600;color:#1e293b;margin-bottom:8px;">${title}</div>
        ${rows || '<div style="color:#94a3b8;font-size:12px;">暂无项目</div>'}
      </div>
    `;
  }

  function renderDetailSlotRow(slotKey, label, selectedId, allowedIds, results) {
    const st = statusForId(selectedId, results);
    const color = st.kind === 'ok' ? '#2e7d32' : (st.kind === 'fail' ? '#c62828' : '#64748b');
    const bg = st.kind === 'ok' ? '#e8f5e9' : (st.kind === 'fail' ? '#ffebee' : '#f1f5f9');
    const options = allowedIds.map((id) =>
      `<option value="${id}" ${id === selectedId ? 'selected' : ''}>${ROUTE_LABELS[id] || id}</option>`
    ).join('');
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:6px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;">
        <span style="width:36px;color:#64748b;font-size:12px;">${label}</span>
        <select class="api-detail-slot" data-slot="${slotKey}" style="flex:1;min-width:0;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;">
          ${options}
        </select>
        <span style="font-size:12px;padding:2px 8px;border-radius:999px;background:${bg};color:${color};white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;" title="${st.text}">${st.text}</span>
      </div>
    `;
  }

  function renderDetailSlots(cfg) {
    return `
      <div style="margin-bottom:14px;">
        <div style="font-weight:600;color:#1e293b;margin-bottom:8px;">详情 · 中文（一主一备）</div>
        ${renderDetailSlotRow('dictZhPrimary', '主', cfg.dictZhPrimary, DICT_ZH_IDS, cfg.results)}
        ${renderDetailSlotRow('dictZhBackup', '备', cfg.dictZhBackup, DICT_ZH_IDS, cfg.results)}
        <div style="font-weight:600;color:#1e293b;margin:12px 0 8px;">详情 · 英文（一主一备）</div>
        ${renderDetailSlotRow('dictEnPrimary', '主', cfg.dictEnPrimary, DICT_EN_IDS, cfg.results)}
        ${renderDetailSlotRow('dictEnBackup', '备', cfg.dictEnBackup, DICT_EN_IDS, cfg.results)}
        <div style="color:#94a3b8;font-size:12px;">主源成功即停；失败才自动改用备源。</div>
      </div>
    `;
  }

  function renderApiRouteSummary(cfg) {
    if (!apiRouteSummary) return;
    currentRouteCfg = normalizeRouteCfg(cfg);
    const when = currentRouteCfg.probedAt
      ? new Date(currentRouteCfg.probedAt).toLocaleString('zh-CN')
      : '';

    apiRouteSummary.innerHTML = `
      <div style="padding:12px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;line-height:1.5;color:#334155;">
        ${renderOrderList('translateOrder', '释义顺序', currentRouteCfg.translateOrder, currentRouteCfg.results)}
        ${renderDetailSlots(currentRouteCfg)}
        ${renderOrderList('ttsOrder', '发音顺序', currentRouteCfg.ttsOrder, currentRouteCfg.results)}
        <div style="color:#64748b;font-size:12px;border-top:1px dashed #e2e8f0;padding-top:8px;">
          ${when ? `最近检测：${when}` : '尚未检测状态；可点「仅刷新状态」或「自动测速并排序」。'}
          · 调整后立即生效
        </div>
      </div>
    `;

    apiRouteSummary.querySelectorAll('.api-route-up, .api-route-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.getAttribute('data-kind');
        const index = parseInt(btn.getAttribute('data-index'), 10);
        if (!kind || Number.isNaN(index)) return;
        const delta = btn.classList.contains('api-route-up') ? -1 : 1;
        moveRouteItem(kind, index, delta);
      });
    });

    apiRouteSummary.querySelectorAll('.api-detail-slot').forEach((sel) => {
      sel.addEventListener('change', () => {
        const slot = sel.getAttribute('data-slot');
        const value = sel.value;
        if (!slot) return;
        currentRouteCfg[slot] = value;
        // 主备相同则自动换一个不同备源
        if (slot === 'dictZhPrimary' && currentRouteCfg.dictZhBackup === value) {
          currentRouteCfg.dictZhBackup = DICT_ZH_IDS.find((id) => id !== value) || value;
        }
        if (slot === 'dictZhBackup' && currentRouteCfg.dictZhPrimary === value) {
          currentRouteCfg.dictZhPrimary = DICT_ZH_IDS.find((id) => id !== value) || value;
        }
        if (slot === 'dictEnPrimary' && currentRouteCfg.dictEnBackup === value) {
          currentRouteCfg.dictEnBackup = DICT_EN_IDS.find((id) => id !== value) || value;
        }
        if (slot === 'dictEnBackup' && currentRouteCfg.dictEnPrimary === value) {
          currentRouteCfg.dictEnPrimary = DICT_EN_IDS.find((id) => id !== value) || value;
        }
        const slots = normalizeDetailSlots(currentRouteCfg);
        Object.assign(currentRouteCfg, slots);
        persistCurrentRoute('详情主备已更新');
      });
    });
  }

  function persistCurrentRoute(message) {
    chrome.storage.local.set({ apiRouteConfig: currentRouteCfg }, () => {
      renderApiRouteSummary(currentRouteCfg);
      if (message) flashStatus(apiProbeStatus, message, 'success');
    });
  }

  function moveRouteItem(kind, index, delta) {
    const list = (currentRouteCfg[kind] || []).slice();
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    const tmp = list[index];
    list[index] = list[next];
    list[next] = tmp;
    currentRouteCfg[kind] = list;
    persistCurrentRoute('顺序已更新');
  }

  async function timedProbe(run, timeoutMs) {
    const started = Date.now();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), timeoutMs || 5000);
    });
    try {
      await Promise.race([Promise.resolve().then(run), timeoutPromise]);
      return { ok: true, ms: Date.now() - started, error: '' };
    } catch (e) {
      return {
        ok: false,
        ms: Date.now() - started,
        error: (e && e.message) || 'failed'
      };
    }
  }

  async function probeOnce(id, run, rounds, timeoutMs) {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      samples.push(await timedProbe(run, timeoutMs));
    }
    const okSamples = samples.filter((s) => s.ok);
    if (!okSamples.length) {
      return {
        id,
        ok: false,
        ms: samples.reduce((a, b) => a + b.ms, 0) / samples.length,
        error: samples[samples.length - 1].error || 'failed',
        score: Number.POSITIVE_INFINITY
      };
    }
    const avg = okSamples.reduce((a, b) => a + b.ms, 0) / okSamples.length;
    // 失败次数惩罚：稳定性差的排后
    const failPenalty = (samples.length - okSamples.length) * 800;
    return {
      id,
      ok: true,
      ms: avg,
      error: '',
      score: avg + failPenalty
    };
  }

  function sortByScore(results, preferredIds) {
    const map = new Map(results.map((r) => [r.id, r]));
    return preferredIds
      .filter((id) => map.has(id))
      .sort((a, b) => {
        const ra = map.get(a);
        const rb = map.get(b);
        const sa = ra.ok ? ra.score : Number.POSITIVE_INFINITY;
        const sb = rb.ok ? rb.score : Number.POSITIVE_INFINITY;
        if (sa !== sb) return sa - sb;
        return preferredIds.indexOf(a) - preferredIds.indexOf(b);
      });
  }

  async function collectProbeResults() {
    const probeWord = 'example';
    const storage = await new Promise((resolve) => {
      chrome.storage.local.get(['baiduAppId', 'baiduSecretKey'], resolve);
    });
    const hasBaidu = !!(storage.baiduAppId && storage.baiduSecretKey);
    baiduConfigured = hasBaidu;

    const probes = [];

    // 离线：本地，几乎总是优先
    probes.push(probeOnce('offline', async () => {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'queryOfflineDict', word: probeWord }, (r) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      });
      // 即使词库未导入也算“可用本地通道”，给极低耗时
      if (!(resp && resp.success)) {
        // 仍标记成功：离线通道本身可用（只是可能无该词）
        return true;
      }
      return true;
    }, 1, 2000));

    probes.push(probeOnce('youdao', async () => {
      const url = `https://dict.youdao.com/suggest?q=${encodeURIComponent(probeWord)}&num=1&doctype=json`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const data = await resp.json();
      const explain = data && data.data && data.data.entries && data.data.entries[0]
        ? data.data.entries[0].explain
        : '';
      if (!explain) throw new Error('empty');
      return true;
    }, 2, 4500));

    probes.push(probeOnce('gt', async () => {
      const url =
        `https://translate.googleapis.com/translate_a/single?client=gtx` +
        `&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(probeWord)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const data = await resp.json();
      const text = data && data[0] && data[0][0] && data[0][0][0];
      if (!text) throw new Error('empty');
      return true;
    }, 2, 4500));

    probes.push(probeOnce('mm', async () => {
      const url =
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(probeWord)}&langpair=en|zh-CN`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const data = await resp.json();
      const text = data && data.responseData && data.responseData.translatedText;
      if (!text) throw new Error('empty');
      return true;
    }, 1, 5000));

    if (hasBaidu) {
      probes.push(probeOnce('baidu', async () => {
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'baiduTranslate', word: probeWord }, (r) => {
            if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
            else resolve(r || { success: false });
          });
        });
        if (!(resp && resp.success && (resp.translation || resp.text))) {
          throw new Error((resp && resp.error) || 'baidu_failed');
        }
        return true;
      }, 1, 6000));
    }

    probes.push(probeOnce('youdao_dict', async () => {
      const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(probeWord)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const data = await resp.json();
      if (!(data && data.ec && data.ec.word)) throw new Error('empty');
      return true;
    }, 1, 4500));

    probes.push(probeOnce('d3325', async () => {
      const url = `https://3325.cn/api/word/${encodeURIComponent(probeWord)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const json = await resp.json();
      if (!(json && json.code === 200 && json.data && json.data.jbjs)) throw new Error('empty');
      return true;
    }, 1, 4500));

    probes.push(probeOnce('fd', async () => {
      const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(probeWord)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const data = await resp.json();
      if (!(data && data[0] && data[0].meanings && data[0].meanings.length)) throw new Error('empty');
      return true;
    }, 1, 5000));

    probes.push(probeOnce('datamuse', async () => {
      const url = `https://api.datamuse.com/words?sp=${encodeURIComponent(probeWord)}&md=d&max=1`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const data = await resp.json();
      if (!(Array.isArray(data) && data[0] && data[0].defs && data[0].defs.length)) throw new Error('empty');
      return true;
    }, 1, 5000));

    probes.push(probeOnce('youdao_tts', async () => {
      const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(probeWord)}&type=2`;
      const resp = await fetch(url, { method: 'GET' });
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (!buf || buf.byteLength < 200) throw new Error('empty_audio');
      return true;
    }, 1, 4500));

    probes.push(probeOnce('google_tts', async () => {
      const url =
        `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx` +
        `&tl=en-US&q=${encodeURIComponent(probeWord)}`;
      const resp = await fetch(url, { method: 'GET' });
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (!buf || buf.byteLength < 200) throw new Error('empty_audio');
      return true;
    }, 1, 4500));

    return Promise.all(probes);
  }

  async function runApiOrderProbe(options) {
    const opts = options || {};
    const statusOnly = !!opts.statusOnly;
    showStatus(
      apiProbeStatus,
      statusOnly ? '正在检测各接口状态…' : '正在测速并自动排序…',
      'success'
    );
    probeApiOrderBtn.disabled = true;
    if (probeApiStatusBtn) probeApiStatusBtn.disabled = true;

    try {
      const results = await collectProbeResults();
      const resultRows = results.map(({ id, ok, ms, error }) => ({ id, ok, ms, error }));

      let translateOrder = currentRouteCfg.translateOrder.slice();
      let dictZhPrimary = currentRouteCfg.dictZhPrimary;
      let dictZhBackup = currentRouteCfg.dictZhBackup;
      let dictEnPrimary = currentRouteCfg.dictEnPrimary;
      let dictEnBackup = currentRouteCfg.dictEnBackup;
      let ttsOrder = currentRouteCfg.ttsOrder.slice();

      if (!statusOnly) {
        const translateCandidates = ['youdao', 'baidu', 'gt', 'mm'].filter((id) =>
          results.some((r) => r.id === id)
        );
        const translateRest = sortByScore(results, translateCandidates);
        translateOrder = normalizeOrder(['offline', ...translateRest], DEFAULT_API_ROUTE.translateOrder);

        const zhSorted = sortByScore(results, DICT_ZH_IDS);
        const enSorted = sortByScore(results, DICT_EN_IDS);
        dictZhPrimary = zhSorted[0] || DEFAULT_API_ROUTE.dictZhPrimary;
        dictZhBackup = zhSorted.find((id) => id !== dictZhPrimary) || DEFAULT_API_ROUTE.dictZhBackup;
        dictEnPrimary = enSorted[0] || DEFAULT_API_ROUTE.dictEnPrimary;
        dictEnBackup = enSorted.find((id) => id !== dictEnPrimary) || DEFAULT_API_ROUTE.dictEnBackup;

        const ttsSorted = sortByScore(results, ['youdao_tts', 'google_tts']);
        ttsOrder = normalizeOrder(
          ttsSorted.length ? ttsSorted : DEFAULT_API_ROUTE.ttsOrder,
          DEFAULT_API_ROUTE.ttsOrder
        );
      }

      const apiRouteConfig = normalizeRouteCfg({
        translateOrder,
        dictZhPrimary,
        dictZhBackup,
        dictEnPrimary,
        dictEnBackup,
        ttsOrder,
        probedAt: Date.now(),
        results: resultRows
      });

      await new Promise((resolve) => {
        chrome.storage.local.set({ apiRouteConfig }, () => {
          chrome.storage.local.remove(['regionMode'], () => resolve());
        });
      });

      renderApiRouteSummary(apiRouteConfig);
      flashStatus(
        apiProbeStatus,
        statusOnly ? '接口状态已刷新（顺序未改）' : '已根据测速结果更新查询顺序',
        'success',
        3500
      );
    } finally {
      probeApiOrderBtn.disabled = false;
      if (probeApiStatusBtn) probeApiStatusBtn.disabled = false;
    }
  }

  // 加载所有设置
  function syncSentenceTranslateModeUI(mode) {
    const value = mode === 'button' ? 'button' : 'auto';
    sentenceModeInputs.forEach((input) => {
      const selected = input.value === value;
      input.checked = selected;
      const label = input.closest('.radio-option');
      if (label) label.classList.toggle('selected', selected);
    });
  }

  function persistSentenceTranslateMode(mode) {
    const value = mode === 'button' ? 'button' : 'auto';
    chrome.storage.local.set({ sentenceTranslateMode: value }, () => {
      syncSentenceTranslateModeUI(value);
      flashStatus(
        sentenceTranslateStatus,
        value === 'button' ? '划句翻译已改为：浮动按钮' : '划句翻译已改为：自动翻译',
        'success'
      );
    });
  }

  sentenceModeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) persistSentenceTranslateMode(input.value);
    });
  });

  function syncUiThemeUI(theme) {
    const value = UI_THEMES.indexOf(theme) >= 0 ? theme : 'violet';
    uiThemeInputs.forEach((input) => {
      const selected = input.value === value;
      input.checked = selected;
      const label = input.closest('.radio-option');
      if (label) label.classList.toggle('selected', selected);
    });
    if (typeof window.applyWnTheme === 'function') window.applyWnTheme(value);
  }

  function persistUiTheme(theme) {
    const value = UI_THEMES.indexOf(theme) >= 0 ? theme : 'violet';
    chrome.storage.local.set({ uiTheme: value }, () => {
      syncUiThemeUI(value);
      flashStatus(uiThemeStatus, '界面主题已改为：' + (UI_THEME_LABELS[value] || value), 'success');
    });
  }

  uiThemeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) persistUiTheme(input.value);
    });
  });

  function loadSettings() {
    chrome.storage.local.get(['apiRouteConfig', 'baiduAppId', 'baiduSecretKey', 'deepseekApiKey', 'sentenceTranslateMode', 'uiTheme'], (result) => {
      baiduConfigured = !!(result.baiduAppId && result.baiduSecretKey);
      renderApiRouteSummary(result.apiRouteConfig || DEFAULT_API_ROUTE);
      syncSentenceTranslateModeUI(result.sentenceTranslateMode);
      syncUiThemeUI(result.uiTheme);

      if (result.baiduAppId) {
        baiduAppId.value = result.baiduAppId;
      }
      if (result.baiduSecretKey) {
        baiduSecretKey.value = result.baiduSecretKey;
      }

      if (deepseekApiKey && result.deepseekApiKey) {
        deepseekApiKey.value = result.deepseekApiKey;
      }
    });
  }

  probeApiOrderBtn.addEventListener('click', () => {
    runApiOrderProbe({ statusOnly: false }).catch((err) => {
      probeApiOrderBtn.disabled = false;
      if (probeApiStatusBtn) probeApiStatusBtn.disabled = false;
      showStatus(apiProbeStatus, '测速失败：' + ((err && err.message) || 'unknown'), 'error');
    });
  });
  if (probeApiStatusBtn) {
    probeApiStatusBtn.addEventListener('click', () => {
      runApiOrderProbe({ statusOnly: true }).catch((err) => {
        probeApiOrderBtn.disabled = false;
        probeApiStatusBtn.disabled = false;
        showStatus(apiProbeStatus, '检测失败：' + ((err && err.message) || 'unknown'), 'error');
      });
    });
  }
  if (resetApiOrderBtn) {
    resetApiOrderBtn.addEventListener('click', () => {
      currentRouteCfg = normalizeRouteCfg({
        ...DEFAULT_API_ROUTE,
        probedAt: currentRouteCfg.probedAt || 0,
        results: currentRouteCfg.results || []
      });
      persistCurrentRoute('已恢复默认顺序');
    });
  }

  // 百度：输入后自动保存（两项齐全才写入；都空则清除）
  function persistBaiduConfig() {
    const appId = baiduAppId ? baiduAppId.value.trim() : '';
    const secretKey = baiduSecretKey ? baiduSecretKey.value.trim() : '';
    if (!appId && !secretKey) {
      chrome.storage.local.remove(['baiduAppId', 'baiduSecretKey'], () => {
        baiduConfigured = false;
        renderApiRouteSummary(currentRouteCfg);
        flashStatus(baiduStatus, '已清除百度翻译配置', 'success');
      });
      return;
    }
    if (!appId || !secretKey) {
      showStatus(baiduStatus, '请把 APP ID 和密钥都填完整（填完即自动保存）', 'error');
      return;
    }
    chrome.storage.local.set({ baiduAppId: appId, baiduSecretKey: secretKey }, () => {
      baiduConfigured = true;
      renderApiRouteSummary(currentRouteCfg);
      flashStatus(baiduStatus, '百度翻译配置已自动保存', 'success');
    });
  }
  const persistBaiduDebounced = debounce(persistBaiduConfig, 500);
  if (baiduAppId) {
    baiduAppId.addEventListener('input', persistBaiduDebounced);
    baiduAppId.addEventListener('change', persistBaiduConfig);
    baiduAppId.addEventListener('blur', persistBaiduConfig);
  }
  if (baiduSecretKey) {
    baiduSecretKey.addEventListener('input', persistBaiduDebounced);
    baiduSecretKey.addEventListener('change', persistBaiduConfig);
    baiduSecretKey.addEventListener('blur', persistBaiduConfig);
  }

  // DeepSeek：输入后自动保存
  function persistDeepseekConfig() {
    if (!deepseekApiKey) return;
    const raw = deepseekApiKey.value;
    const key = sanitizeApiKey(raw);
    if (!String(raw || '').trim()) {
      chrome.storage.local.remove(['deepseekApiKey'], () => {
        flashStatus(deepseekStatus, '已清除 DeepSeek API Key', 'success');
      });
      return;
    }
    if (!key) {
      showStatus(deepseekStatus, 'Key 无效：请去掉中文、空格或不可见字符', 'error');
      return;
    }
    if (deepseekApiKey.value !== key) deepseekApiKey.value = key;
    chrome.storage.local.set({ deepseekApiKey: key }, () => {
      flashStatus(deepseekStatus, 'DeepSeek API Key 已自动保存', 'success');
    });
  }
  const persistDeepseekDebounced = debounce(persistDeepseekConfig, 500);
  if (deepseekApiKey) {
    deepseekApiKey.addEventListener('input', persistDeepseekDebounced);
    deepseekApiKey.addEventListener('change', persistDeepseekConfig);
    deepseekApiKey.addEventListener('blur', persistDeepseekConfig);
  }

  // 设置页直接请求 DeepSeek，避免 service worker 长请求导致 message port closed
  async function testDeepseekDirect(apiKey, word) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0.2,
          max_tokens: 500,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Return ONLY valid JSON. No markdown.'
            },
            {
              role: 'user',
              content:
                `For English word "${word}", return JSON: ` +
                `{"word":"${word}","phonetic":"...","translation":"中文",` +
                `"usage":"用法","meanings":[{"partOfSpeech":"noun",` +
                `"definitions":[{"definition":"English def","example":"Example sentence"}]}]}`
            }
          ]
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return {
          success: false,
          error: `HTTP ${response.status}${errText ? ': ' + errText.slice(0, 180) : ''}`
        };
      }

      const raw = await response.json();
      const content = raw?.choices?.[0]?.message?.content || '';
      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        if (start >= 0 && end > start) {
          parsed = JSON.parse(content.slice(start, end + 1));
        }
      }
      if (!parsed || !parsed.meanings) {
        return { success: false, error: '返回内容无法解析为词典 JSON', raw: content.slice(0, 200) };
      }
      return { success: true, data: parsed };
    } catch (error) {
      const msg = error && error.name === 'AbortError' ? '请求超时（45s）' : (error.message || 'request_failed');
      return { success: false, error: msg };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // 测试 DeepSeek 连接
  if (testDeepseekBtn) {
    testDeepseekBtn.addEventListener('click', () => {
      const key = sanitizeApiKey(deepseekApiKey ? deepseekApiKey.value : '');
      if (!key) {
        showStatus(deepseekStatus, '请先填写有效的 DeepSeek API Key（不要含中文、空格或特殊不可见字符）', 'error');
        return;
      }
      if (deepseekApiKey) deepseekApiKey.value = key;

      chrome.storage.local.set({ deepseekApiKey: key }, async () => {
        showStatus(deepseekStatus, '正在测试 DeepSeek（约需几秒，请稍候）...', 'success');
        const startedAt = Date.now();
        const response = await testDeepseekDirect(key, 'example');
        const durationMs = Date.now() - startedAt;
        chrome.runtime.sendMessage({
          action: 'appendDeepseekApiLog',
          entry: {
            word: 'example',
            success: !!(response && response.success),
            error: (response && response.error) || '',
            source: 'options-test',
            durationMs
          }
        }, () => {
          loadDeepseekLogPreview();
        });

        if (response && response.success && response.data) {
          const meanings = response.data.meanings || [];
          const exampleCount = meanings.reduce((n, m) => {
            return n + (m.definitions || []).filter(d => d.example).length;
          }, 0);
          showStatus(
            deepseekStatus,
            `✅ 连接成功！释义组 ${meanings.length} 个，例句 ${exampleCount} 条。可在测试页暂停查看详情。`,
            'success'
          );
        } else {
          showStatus(
            deepseekStatus,
            '测试失败：' + (response?.error || '未知错误'),
            'error'
          );
        }
      });
    });
  }

  function formatLogTime(ts) {
    try {
      return new Date(ts).toLocaleString('zh-CN');
    } catch (e) {
      return '';
    }
  }

  function loadDeepseekLogPreview() {
    const preview = document.getElementById('deepseekLogPreview');
    if (!preview) return;
    chrome.runtime.sendMessage({ action: 'getDeepseekApiLogs' }, (response) => {
      if (chrome.runtime.lastError) {
        preview.textContent = '读取日志失败：' + chrome.runtime.lastError.message;
        return;
      }
      const logs = (response && response.logs) || [];
      if (!logs.length) {
        preview.textContent = '暂无调用记录。查词记 FD/Datamuse；发音记 Google/有道 TTS；手动 DeepSeek 也会显示。';
        return;
      }
      const recent = logs.slice(0, 20);
      preview.innerHTML = recent.map((item) => {
        const color = item.success ? '#2e7d32' : '#c62828';
        const status = item.success ? '成功' : '失败';
        const apiLabels = {
          freedictionary: 'FD',
          datamuse: 'Datamuse',
          deepseek: 'DeepSeek',
          offline: '离线',
          ecd: '离线',
          youdao: '有道',
          youdao_dict: '有道词典',
          d3325: '3325',
          google_tts: 'Google TTS',
          youdao_tts: 'Youdao TTS',
          webspeech: 'Web Speech'
        };
        const apiName = apiLabels[item.api] || item.api || 'DeepSeek';
        const err = item.success ? '' : ` · ${item.error || ''}`;
        const detail = item.success && item.detail ? ` · ${item.detail}` : '';
        return `<div style="padding:6px 0;border-bottom:1px dashed #e0e0e0;">
          <span style="color:${color};font-weight:600;">[${status}]</span>
          <span style="color:#555;">[${apiName}]</span>
          <strong>${item.word || ''}</strong>
          <span style="color:#999;"> · ${formatLogTime(item.time)} · ${item.durationMs || 0}ms · ${item.source || ''}${detail}${err}</span>
        </div>`;
      }).join('');
    });
  }

  const refreshDeepseekLogBtn = document.getElementById('refreshDeepseekLogBtn');
  const clearDeepseekLogBtn = document.getElementById('clearDeepseekLogBtn');
  const openDeepseekLogPageBtn = document.getElementById('openDeepseekLogPageBtn');
  if (refreshDeepseekLogBtn) refreshDeepseekLogBtn.addEventListener('click', loadDeepseekLogPreview);
  if (clearDeepseekLogBtn) {
    clearDeepseekLogBtn.addEventListener('click', () => {
      if (!confirm('确定清空 API 调用日志吗？')) return;
      chrome.runtime.sendMessage({ action: 'clearDeepseekApiLogs' }, () => loadDeepseekLogPreview());
    });
  }
  if (openDeepseekLogPageBtn) {
    openDeepseekLogPageBtn.addEventListener('click', () => {
      if (typeof window.switchVocabTab === 'function') {
        window.switchVocabTab('logs');
        return;
      }
      location.href = 'main.html?tab=logs';
    });
  }
  const backToMainBtn = document.getElementById('backToMainBtn');
  if (backToMainBtn) {
    backToMainBtn.addEventListener('click', () => {
      location.href = 'main.html';
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

  // 获取当前用户ID
  function getCurrentUserId() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['currentUserId'], (result) => {
        resolve(result.currentUserId || 'default');
      });
    });
  }

  const wordsDataStatus = document.getElementById('wordsDataStatus');

  function escapeHtmlText(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // 按指定用户导出生词本
  function exportWordsForUser(userId, userName) {
    const userKey = `user_${userId}_`;
    const safeName = String(userName || userId || 'user').replace(/[\\/:*?"<>|]/g, '_');

    chrome.storage.local.get([
      `${userKey}savedWords`,
      `${userKey}wordTranslations`,
      `${userKey}wordStatus`,
      `${userKey}wordNotes`
    ], (result) => {
      const words = result[`${userKey}savedWords`] || [];
      const translations = new Map(result[`${userKey}wordTranslations`] || []);
      const statuses = new Map(result[`${userKey}wordStatus`] || []);
      const notes = new Map(result[`${userKey}wordNotes`] || []);

      if (!words.length) {
        if (wordsDataStatus) showStatus(wordsDataStatus, `「${userName}」没有可导出的单词`, 'error');
        return;
      }

      const rowsHtml = words.map((word, index) => {
        const translation = translations.get(word) || '';
        const status = statuses.get(word) || 'new';
        const note = notes.get(word) || '';
        const statusText = status === 'mastered' ? '已记住' : '未记住';
        return `
          <tr>
            <td style="padding:6px 8px; border:1px solid #ccc; text-align:center;">${index + 1}</td>
            <td style="padding:6px 8px; border:1px solid #ccc;">${escapeHtmlText(word)}</td>
            <td style="padding:6px 8px; border:1px solid #ccc;">${escapeHtmlText(translation)}</td>
            <td style="padding:6px 8px; border:1px solid #ccc;">${statusText}</td>
            <td style="padding:6px 8px; border:1px solid #ccc;">${escapeHtmlText(note)}</td>
          </tr>
        `;
      }).join('');

      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>生词本导出 - ${escapeHtmlText(userName)}</title>
        </head>
        <body>
          <h2 style="text-align:center;">生词本导出 · ${escapeHtmlText(userName)}（${new Date().toLocaleDateString('zh-CN')}）</h2>
          <table style="border-collapse:collapse; width:100%; margin-top:12px; font-family:'Microsoft YaHei', Arial;">
            <thead>
              <tr>
                <th style="padding:6px 8px; border:1px solid #ccc; background:#f5f5f5;">序号</th>
                <th style="padding:6px 8px; border:1px solid #ccc; background:#f5f5f5;">单词</th>
                <th style="padding:6px 8px; border:1px solid #ccc; background:#f5f5f5;">释义</th>
                <th style="padding:6px 8px; border:1px solid #ccc; background:#f5f5f5;">状态</th>
                <th style="padding:6px 8px; border:1px solid #ccc; background:#f5f5f5;">备注</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </body>
        </html>
      `;

      const blob = new Blob([htmlContent], { type: 'application/msword' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `生词本_${safeName}_${new Date().toISOString().split('T')[0]}.doc`;
      a.click();
      URL.revokeObjectURL(url);
      if (wordsDataStatus) showStatus(wordsDataStatus, `已导出「${userName}」的 ${words.length} 个单词`, 'success');
    });
  }

  function archiveUserLookups(userId) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'archiveUserLookups', userId }, (res) => {
          if (chrome.runtime.lastError || !res || res.success === false) {
            resolve(null);
            return;
          }
          resolve(res.saved || 0);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // 按指定用户清空生词记录（保留用户账号，并留下网络查询缓存）
  async function clearWordsForUser(userId, userName) {
    if (!confirm(`确定清空用户「${userName}」的所有单词记录吗？生词、记住状态和备注会删除；已经通过网络查到的释义会保留，供所有用户直接使用。`)) return;

    const savedCount = await archiveUserLookups(userId);
    if (savedCount === null) {
      if (wordsDataStatus) showStatus(wordsDataStatus, '保存网络查询结果失败，未清空生词', 'error');
      return;
    }

    const currentUserId = await getCurrentUserId();
    const userKey = `user_${userId}_`;
    const userData = {};
    userData[`${userKey}savedWords`] = [];
    userData[`${userKey}wordTranslations`] = [];
    userData[`${userKey}wordDictionaryData`] = [];
    userData[`${userKey}wordChineseTranslations`] = [];
    userData[`${userKey}wordChineseSources`] = [];
    userData[`${userKey}wordStatus`] = [];
    userData[`${userKey}wordNotes`] = [];

    chrome.storage.local.set(userData, () => {
      if (wordsDataStatus) {
        showStatus(
          wordsDataStatus,
          `已清空「${userName}」的生词，并保留 ${savedCount} 条网络查询结果`,
          'success'
        );
      }
      if (userId === currentUserId && typeof window.refreshVocabStats === 'function') {
        window.refreshVocabStats();
      }
    });
  }

  // 加载用户列表
  async function loadUserList() {
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const userList = document.getElementById('userList');
    if (!userList) return;
    
    const users = await getAllUsers();
    const currentUserId = await getCurrentUserId();
    
    userList.innerHTML = '';
    
    if (Object.keys(users).length === 0) {
      userList.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">暂无用户</div>';
      return;
    }
    
    Object.keys(users).forEach(userId => {
      const user = users[userId];
      const userItem = document.createElement('div');
      userItem.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 12px; margin-bottom: 8px; background: white; border: 1px solid #e0e0e0; border-radius: 8px; transition: all 0.2s; min-height: 60px;';
      userItem.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.1)';
      
      const isCurrent = userId === currentUserId;
      
      userItem.innerHTML = `
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; color: #333; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
            <span>${escapeHtmlText(user.name)}</span>
            ${isCurrent ? '<span style="font-size: 11px; padding: 2px 8px; background: #667eea; color: white; border-radius: 12px;">当前用户</span>' : ''}
          </div>
          <div style="font-size: 11px; color: #999;">
            创建时间: ${new Date(user.createdAt).toLocaleString('zh-CN')}
          </div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <button type="button" class="btn btn-primary" data-action="export" style="padding: 8px 12px; font-size: 13px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; white-space: nowrap;">导出</button>
          <button type="button" class="btn btn-danger" data-action="clear" style="padding: 8px 12px; font-size: 13px; background: #FF9800; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; white-space: nowrap;">清空</button>
          <button type="button" class="btn btn-primary" data-action="rename" style="padding: 8px 12px; font-size: 13px; background: #2196F3; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; white-space: nowrap;">更名</button>
          <button type="button" class="btn btn-danger" data-action="delete" style="padding: 8px 12px; font-size: 13px; background: #f44336; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; white-space: nowrap;">删除</button>
        </div>
      `;
      
      // 悬停效果
      userItem.addEventListener('mouseenter', () => {
        userItem.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.15)';
        userItem.style.transform = 'translateY(-1px)';
      });
      userItem.addEventListener('mouseleave', () => {
        userItem.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.1)';
        userItem.style.transform = 'translateY(0)';
      });

      const exportBtn = userItem.querySelector('[data-action="export"]');
      if (exportBtn) {
        exportBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          exportWordsForUser(userId, user.name);
        });
      }

      const clearBtn = userItem.querySelector('[data-action="clear"]');
      if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          clearWordsForUser(userId, user.name);
        });
      }

      const renameBtn = userItem.querySelector('[data-action="rename"]');
      if (renameBtn) {
        renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          renameUser(userId, user.name);
        });
      }
      
      // 删除按钮事件
      const deleteBtn = userItem.querySelector('[data-action="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteUser(userId, user.name);
        });
        
        // 删除按钮悬停效果
        deleteBtn.addEventListener('mouseenter', () => {
          deleteBtn.style.background = '#d32f2f';
          deleteBtn.style.transform = 'scale(1.05)';
        });
        deleteBtn.addEventListener('mouseleave', () => {
          deleteBtn.style.background = '#f44336';
          deleteBtn.style.transform = 'scale(1)';
        });
      }
      
      userList.appendChild(userItem);
    });
  }

  // 更名用户
  async function renameUser(userId, oldName) {
    const nextName = typeof window.showAppPrompt === 'function'
      ? await window.showAppPrompt('请输入新的用户名：', oldName || '', '用户更名')
      : prompt('请输入新的用户名：', oldName || '');
    if (nextName == null) return;
    const trimmed = nextName.trim();
    if (!trimmed) {
      showStatus(saveStatus, '用户名不能为空', 'error');
      setTimeout(() => {
        if (saveStatus) saveStatus.style.display = 'none';
      }, 2500);
      return;
    }
    if (trimmed === oldName) return;

    const users = await getAllUsers();
    if (!users[userId]) {
      showStatus(saveStatus, '用户不存在', 'error');
      return;
    }

    const duplicated = Object.keys(users).some((id) => {
      return id !== userId && String(users[id].name || '').trim() === trimmed;
    });
    if (duplicated) {
      showStatus(saveStatus, '已存在同名用户，请换一个名字', 'error');
      setTimeout(() => {
        if (saveStatus) saveStatus.style.display = 'none';
      }, 2500);
      return;
    }

    users[userId] = {
      ...users[userId],
      name: trimmed
    };

    chrome.storage.local.set({ users }, () => {
      showStatus(saveStatus, `已更名为「${trimmed}」`, 'success');
      setTimeout(() => {
        if (saveStatus) saveStatus.style.display = 'none';
      }, 2500);
      loadUserList();
    });
  }

  // 删除用户
  async function deleteUser(userId, userName) {
    const currentUserId = await getCurrentUserId();
    
    // 不能删除当前用户
    if (userId === currentUserId) {
      showStatus(saveStatus, '不能删除当前正在使用的用户！请先切换到其他用户。', 'error');
      setTimeout(() => {
        saveStatus.style.display = 'none';
      }, 3000);
      return;
    }
    
    // 确认删除
    if (!confirm(`确定要删除用户 "${userName}" 吗？\n\n生词记录会删除。已经通过网络查到的释义会保留，供其他用户直接使用。`)) {
      return;
    }

    const savedCount = await archiveUserLookups(userId);
    if (savedCount === null) {
      showStatus(saveStatus, '保存网络查询结果失败，未删除用户', 'error');
      return;
    }
    
    // 删除用户数据
    const userKey = `user_${userId}_`;
    const keysToDelete = [
      `${userKey}savedWords`,
      `${userKey}wordTranslations`,
      `${userKey}wordDictionaryData`,
      `${userKey}wordChineseTranslations`,
      `${userKey}wordChineseSources`,
      `${userKey}wordStatus`,
      `${userKey}wordNotes`
    ];
    
    chrome.storage.local.remove(keysToDelete, () => {
      // 删除用户信息
      getAllUsers().then(users => {
        delete users[userId];
        chrome.storage.local.set({ users: users }, () => {
          showStatus(saveStatus, `用户 "${userName}" 已删除！`, 'success');
          setTimeout(() => {
            saveStatus.style.display = 'none';
          }, 3000);
          loadUserList();
        });
      });
    });
  }

  // 离线词典：一键下载 / 手动上传 CSV → 自动转 JSON → 自动装载
  const offlineCsvFile = document.getElementById('offlineCsvFile');
  const autoInstallDictBtn = document.getElementById('autoInstallDictBtn');
  const importCsvDictBtn = document.getElementById('importCsvDictBtn');
  const clearDictBtn = document.getElementById('clearDictBtn');
  const dictStatus = document.getElementById('dictStatus');

  const ECDICT_CSV_URLS = [
    'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv',
    'https://ghproxy.net/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv'
  ];

  function setDictActionBusy(busy) {
    [autoInstallDictBtn, importCsvDictBtn, clearDictBtn].forEach((btn) => {
      if (btn) btn.disabled = !!busy;
    });
  }

  function parseCsvRecords(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        continue;
      }
      if (ch === ',') {
        row.push(field);
        field = '';
        continue;
      }
      if (ch === '\n') {
        if (field.endsWith('\r')) field = field.slice(0, -1);
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        continue;
      }
      if (ch !== '\r') field += ch;
    }
    if (field.length || row.length) {
      if (field.endsWith('\r')) field = field.slice(0, -1);
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function parseExchangeField(exchangeStr) {
    if (!exchangeStr || !String(exchangeStr).trim()) return [];
    const variations = [];
    String(exchangeStr).split('/').forEach((part) => {
      const p = part.trim();
      if (!p.includes(':')) return;
      const word = p.split(':', 2)[1];
      if (word && word.trim()) variations.push(word.trim().toLowerCase());
    });
    return variations;
  }

  function isValidDictWord(word, minLen, maxLen) {
    if (!word) return false;
    if (word.length < minLen || word.length > maxLen) return false;
    return /^[a-zA-Z][a-zA-Z'-]*$/.test(word);
  }

  function convertEcdictRowsToDictionary(rows, onProgress) {
    const dictionary = {};
    const lemmaMap = {};
    let processed = 0;
    let duplicates = 0;
    let lemmaEntries = 0;
    // 跳过表头
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 4) continue;
      const word = String(row[0] || '').trim().toLowerCase();
      const phonetic = String(row[1] || '').trim();
      const translation = String(row[3] || '').trim();
      const exchange = row.length > 10 ? String(row[10] || '').trim() : '';
      if (!isValidDictWord(word, 2, 50) || !translation) continue;

      if (dictionary[word]) {
        const existing = dictionary[word];
        const prev = typeof existing === 'string' ? existing : (existing.translation || '');
        if (translation && !prev.includes(translation)) {
          dictionary[word] = {
            translation: prev ? (prev + '；' + translation) : translation,
            phonetic: (typeof existing === 'object' && existing.phonetic) || phonetic || null
          };
        } else if (typeof existing === 'object' && !existing.phonetic && phonetic) {
          existing.phonetic = phonetic;
        }
        duplicates += 1;
      } else {
        dictionary[word] = {
          translation,
          phonetic: phonetic || null
        };
        processed += 1;
      }

      if (exchange) {
        parseExchangeField(exchange).forEach((variation) => {
          if (!isValidDictWord(variation, 2, 50) || variation === word) return;
          if (!lemmaMap[variation]) {
            lemmaMap[variation] = word;
            lemmaEntries += 1;
          }
        });
      }

      if (onProgress && i % 20000 === 0) onProgress(i, rows.length, processed, lemmaEntries);
    }
    return { dictionary, lemmaMap, processed, duplicates, lemmaEntries, totalRows: rows.length };
  }

  async function convertCsvTextAndImport(text, sourceLabel) {
    showDictStatus(`正在解析 ${sourceLabel || 'CSV'}…`, 'info');
    await new Promise((r) => setTimeout(r, 30));
    const rows = parseCsvRecords(text);
    if (rows.length < 2) throw new Error('CSV 内容为空或格式不正确');
    const header = (rows[0] || []).map((x) => String(x || '').trim().toLowerCase());
    if (!(header.includes('word') && header.includes('translation'))) {
      throw new Error('不是 ECDICT 格式（需要含 word / translation 列）');
    }
    showDictStatus(`正在转换为词典（共 ${rows.length.toLocaleString()} 行）…`, 'info');
    const result = convertEcdictRowsToDictionary(rows, (i, total, processed, lemmaEntries) => {
      showDictStatus(
        `转换中… ${Math.min(100, Math.round((i / total) * 100))}%\n` +
        `已提取 ${processed.toLocaleString()} 词，词形映射 ${lemmaEntries.toLocaleString()} 条`,
        'info'
      );
    });
    showDictStatus(
      `转换完成：${result.processed.toLocaleString()} 词，` +
      `${result.lemmaEntries.toLocaleString()} 条词形映射，正在装载到插件…`,
      'info'
    );
    importDictionary(result.dictionary, result.lemmaMap, result.processed);
  }

  async function fetchTextWithProgress(url, onProgress) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`http_${resp.status}`);
    const total = Number(resp.headers.get('content-length') || 0);
    if (!resp.body || !resp.body.getReader) {
      const text = await resp.text();
      if (onProgress) onProgress(text.length, total || text.length);
      return text;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (onProgress) onProgress(received, total);
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    chunks.forEach((chunk) => {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    });
    return new TextDecoder('utf-8').decode(merged);
  }

  async function downloadAndInstallEcdict() {
    setDictActionBusy(true);
    let lastError = '';
    try {
      let text = null;
      for (let i = 0; i < ECDICT_CSV_URLS.length; i++) {
        const url = ECDICT_CSV_URLS[i];
        try {
          showDictStatus(
            `正在下载 ECDICT 词库（源 ${i + 1}/${ECDICT_CSV_URLS.length}）…\n约 63MB，请稍候`,
            'info'
          );
          text = await fetchTextWithProgress(url, (received, total) => {
            const mb = (received / 1024 / 1024).toFixed(1);
            if (total > 0) {
              const pct = Math.min(100, Math.round((received / total) * 100));
              showDictStatus(`正在下载 ECDICT… ${pct}%（${mb} MB）`, 'info');
            } else {
              showDictStatus(`正在下载 ECDICT… 已接收 ${mb} MB`, 'info');
            }
          });
          if (text && text.length > 1000) break;
          lastError = 'empty_body';
          text = null;
        } catch (e) {
          lastError = (e && e.message) || 'download_failed';
          text = null;
        }
      }
      if (!text) {
        throw new Error(
          `自动下载失败（${lastError || 'unknown'}）。\n请改用「手动上传 CSV」，或检查网络后重试。`
        );
      }
      await convertCsvTextAndImport(text, 'ECDICT 下载文件');
    } catch (error) {
      setDictActionBusy(false);
      showDictStatus('一键安装失败：' + ((error && error.message) || error), 'error');
    }
  }

  async function convertCsvFileAndImport(file) {
    setDictActionBusy(true);
    try {
      showDictStatus(`正在读取 ${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）…`, 'info');
      const text = await file.text();
      await convertCsvTextAndImport(text, file.name);
    } catch (error) {
      setDictActionBusy(false);
      showDictStatus('CSV 转换失败：' + ((error && error.message) || error), 'error');
    }
  }

  if (autoInstallDictBtn) {
    autoInstallDictBtn.addEventListener('click', () => {
      downloadAndInstallEcdict();
    });
  }

  if (importCsvDictBtn && offlineCsvFile) {
    importCsvDictBtn.addEventListener('click', () => offlineCsvFile.click());
    offlineCsvFile.addEventListener('change', () => {
      const file = offlineCsvFile.files && offlineCsvFile.files[0];
      offlineCsvFile.value = '';
      if (!file) return;
      convertCsvFileAndImport(file);
    });
  }
  
  // 导入词典的辅助函数
  function importDictionary(dictionary, lemmaMap, wordCount) {
    setDictActionBusy(true);
    // 如果词典太大（超过5MB），使用IndexedDB存储
    const jsonSize = JSON.stringify(dictionary).length;
    const sizeMB = jsonSize / 1024 / 1024;
    
    if (sizeMB > 5) {
      // 使用IndexedDB存储（通过background worker）
      const lemmaCount = lemmaMap ? Object.keys(lemmaMap).length : 0;
      const statusMsg = lemmaCount > 0 
        ? `正在导入 ${wordCount.toLocaleString()} 个单词和 ${lemmaCount.toLocaleString()} 条词形映射到 IndexedDB，请稍候…\n请勿关闭本页。`
        : `正在导入 ${wordCount.toLocaleString()} 个单词到 IndexedDB，请稍候…\n请勿关闭本页。`;
      showDictStatus(statusMsg, 'info');
      
      let progressCounter = 0;
      const progressInterval = setInterval(() => {
        progressCounter++;
        const elapsed = Math.floor(progressCounter * 30 / 60);
        const currentStatus = dictStatus.textContent;
        if (currentStatus.includes('正在导入')) {
          showDictStatus(
            currentStatus.split('\n')[0] + 
            `\n（已处理约 ${elapsed} 分钟，仍在进行中…）`,
            'info'
          );
        }
      }, 30000);
      
      const timeout = setTimeout(() => {
        clearInterval(progressInterval);
        setDictActionBusy(false);
        showDictStatus(
          '导入超时（超过10分钟）。\n' +
          '可尝试：重新加载扩展后重试，或关闭其他标签页后再导入。',
          'error'
        );
      }, 600000);
      
      chrome.runtime.sendMessage(
        { 
          action: 'importDictionary', 
          dictionary: dictionary,
          lemmaMap: lemmaMap || null
        },
        (response) => {
          clearInterval(progressInterval);
          clearTimeout(timeout);
          setDictActionBusy(false);
          
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message;
            showDictStatus(
              '导入失败：' + errorMsg + 
              '\n\n可尝试重新加载扩展，或改用较小词典。',
              'error'
            );
          } else if (response && response.success) {
            const result = response.result;
            let successMsg = `✅ 已自动装载完成！\n`;
            successMsg += `• 词典单词：${result.processed.toLocaleString()} 个（共 ${result.total.toLocaleString()} 个）\n`;
            if (result.lemmaProcessed > 0) {
              successMsg += `• 词形映射：${result.lemmaProcessed.toLocaleString()} 条（共 ${(result.lemmaTotal || 0).toLocaleString()} 条）\n`;
            } else if (lemmaMap) {
              successMsg += `• ⚠️ 映射表未写入，词形还原可能不完整\n`;
            }
            if (result.errors > 0) {
              successMsg += `• ⚠️ 导入错误：${result.errors} 条\n`;
            }
            successMsg += `\n可立即查询使用，一般无需重载扩展。`;
            showDictStatus(successMsg, 'success');
            setTimeout(() => loadDictionaryStats(), 500);
          } else {
            showDictStatus('导入失败：' + (response?.error || '未知错误'), 'error');
          }
        }
      );
    } else {
      chrome.storage.local.set({ offlineDictionary: dictionary }, () => {
        setDictActionBusy(false);
        if (chrome.runtime.lastError) {
          showDictStatus('保存失败：' + chrome.runtime.lastError.message, 'error');
        } else {
          showDictStatus(`成功导入 ${wordCount.toLocaleString()} 个单词！`, 'success');
          setTimeout(() => loadDictionaryStats(), 300);
        }
      });
    }
  }

  if (clearDictBtn) {
    clearDictBtn.addEventListener('click', () => {
      if (confirm('确定要清除自定义词典吗？清除后将恢复使用内置的精简词典。')) {
        // 清除chrome.storage.local中的词典
        chrome.storage.local.remove(['offlineDictionary'], () => {
          // 清除IndexedDB中的词典
          chrome.runtime.sendMessage(
            { action: 'clearDictionary' },
            (response) => {
              if (chrome.runtime.lastError) {
                showDictStatus('清除失败：' + chrome.runtime.lastError.message, 'error');
              } else {
                showDictStatus('已清除自定义词典，将使用内置词典。请重新加载扩展以生效。', 'success');
                // 刷新统计信息
                setTimeout(() => {
                  loadDictionaryStats();
                }, 500);
              }
            }
          );
        });
      }
    });
  }

  function showDictStatus(message, type) {
    if (!dictStatus) return;
    dictStatus.textContent = message;
    dictStatus.style.display = 'block';
    dictStatus.style.background = type === 'success' ? '#d4edda' : type === 'info' ? '#d1ecf1' : '#f8d7da';
    dictStatus.style.color = type === 'success' ? '#155724' : type === 'info' ? '#0c5460' : '#721c24';
    dictStatus.style.border = `1px solid ${type === 'success' ? '#c3e6cb' : type === 'info' ? '#bee5eb' : '#f5c6cb'}`;
    dictStatus.style.whiteSpace = 'pre-line'; // 支持换行
    
    if (type !== 'info') {
      setTimeout(() => {
        dictStatus.style.display = 'none';
      }, 8000);
    }
  }
  
  // 加载并显示词库统计信息
  function loadDictionaryStats(retryCount = 0) {
    const dictStatsContent = document.getElementById('dictStatsContent');
    if (!dictStatsContent) return;
    
    // 限制重试次数，避免无限循环
    if (retryCount >= 3) {
      dictStatsContent.innerHTML = `<span style="color: #f44336;">多次重试失败，请重新加载扩展后重试</span>`;
      return;
    }
    
    dictStatsContent.textContent = retryCount > 0 ? `正在重试（${retryCount}/3）...` : '正在加载...';
    
    // 先测试 service worker 是否可用
    chrome.runtime.sendMessage({ action: 'ping' }, (pingResponse) => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message;
        console.error('Service Worker ping 失败:', errorMsg);
        
        // 如果是端口关闭错误，等待后重试
        if (errorMsg.includes('port closed') || errorMsg.includes('message port')) {
          if (retryCount < 3) {
            dictStatsContent.innerHTML = `<span style="color: #ff9800;">服务重启中，${3 - retryCount}秒后自动重试...</span>`;
            setTimeout(() => {
              loadDictionaryStats(retryCount + 1);
            }, 3000);
          } else {
            dictStatsContent.innerHTML = `<span style="color: #f44336;">Service Worker 无法连接，请重新加载扩展</span>`;
          }
          return;
        } else {
          dictStatsContent.innerHTML = `<span style="color: #f44336;">连接失败：${errorMsg}</span>`;
          return;
        }
      }
      
      // Service Worker 可用，继续查询统计信息
      const timeout = setTimeout(() => {
        dictStatsContent.innerHTML = `<span style="color: #ff9800;">查询超时，请点击"刷新统计"重试</span>`;
      }, 10000); // 10秒超时
      
      chrome.runtime.sendMessage({ action: 'getDictionaryStats' }, (response) => {
        clearTimeout(timeout);
        
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message;
          console.error('获取统计信息失败:', errorMsg);
          dictStatsContent.innerHTML = `<span style="color: #f44336;">加载失败：${errorMsg}</span>`;
          return;
        }
        
        if (response && response.success && response.stats) {
          const stats = response.stats;
          let html = '';
          
          if (stats.hasDictionary) {
            html += `<div style="margin-bottom: 4px;">✅ <strong>词典单词数：</strong> <span style="color: #1976d2; font-weight: 600;">${stats.wordCount.toLocaleString()}</span> 个</div>`;
          } else {
            html += `<div style="margin-bottom: 4px; color: #999;">❌ 未导入词典</div>`;
          }
          
          if (stats.hasLemmaMap) {
            html += `<div style="margin-bottom: 4px;">✅ <strong>词形映射数：</strong> <span style="color: #1976d2; font-weight: 600;">${stats.lemmaCount.toLocaleString()}</span> 条</div>`;
          } else {
            html += `<div style="margin-bottom: 4px; color: #ff9800;">⚠️ 未导入词形映射表（词形变化功能可能不完整）</div>`;
          }
          
          if (!stats.hasDictionary && !stats.hasLemmaMap) {
            html = '<div style="color: #999;">暂无数据，请导入词典文件</div>';
          }
          
          dictStatsContent.innerHTML = html;
        } else {
          const errorMsg = response?.error || '未知错误';
          dictStatsContent.innerHTML = `<span style="color: #f44336;">加载失败：${errorMsg}</span>`;
        }
      });
    });
  }
  
  // 刷新统计按钮
  const refreshStatsBtn = document.getElementById('refreshStatsBtn');
  if (refreshStatsBtn) {
    refreshStatsBtn.addEventListener('click', () => {
      loadDictionaryStats();
    });
  }

  // 检查当前词典状态（兼容旧的小词典）
  chrome.storage.local.get(['offlineDictionary'], (result) => {
    if (result.offlineDictionary && dictStatus) {
      const wordCount = Object.keys(result.offlineDictionary).length;
      showDictStatus(`当前使用自定义词典（chrome.storage），包含 ${wordCount} 个单词`, 'info');
    }
  });

  // 首次进入设置 tab 时再加载
  loadSettings();
  loadUserList();
  loadDictionaryStats();
  loadDeepseekLogPreview();
  };

})();
