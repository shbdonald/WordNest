// API 日志 pane — 由主页首次打开「API 日志」tab 时调用 initVocabApiLogs
(function () {
  let logsBound = false;

  window.initVocabApiLogs = function initVocabApiLogs() {
    const logList = document.getElementById('apiLogList') || document.getElementById('logList');
    const totalCount = document.getElementById('apiLogTotalCount') || document.getElementById('totalCount');
    const successCount = document.getElementById('apiLogSuccessCount') || document.getElementById('successCount');
    const failCount = document.getElementById('apiLogFailCount') || document.getElementById('failCount');
    const refreshBtn = document.getElementById('apiLogRefreshBtn') || document.getElementById('refreshBtn');
    const clearBtn = document.getElementById('apiLogClearBtn') || document.getElementById('clearBtn');
    const backBtn = document.getElementById('backBtn');
    const settingsBtn = document.getElementById('settingsBtn');

    if (!logList || !totalCount || !successCount || !failCount) return;

    function formatTime(ts) {
      try {
        return new Date(ts).toLocaleString('zh-CN');
      } catch (e) {
        return String(ts || '');
      }
    }

    function escapeHtml(text) {
      return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderLogs(logs) {
      const list = Array.isArray(logs) ? logs : [];
      const ok = list.filter((x) => x.success).length;
      const bad = list.length - ok;
      totalCount.textContent = String(list.length);
      successCount.textContent = String(ok);
      failCount.textContent = String(bad);

      if (!list.length) {
        logList.innerHTML = '<div class="empty">暂无日志。查词会记 Free Dictionary / Datamuse；点音标发音会记 Google/有道 TTS；手动 DeepSeek 也会记入。</div>';
        return;
      }

      logList.innerHTML = list.map((item) => {
        const statusClass = item.success ? 'success' : 'fail';
        const badge = item.success
          ? '<span class="badge ok">成功</span>'
          : '<span class="badge bad">失败</span>';
        const apiLabels = {
          freedictionary: 'Free Dictionary',
          offline: '离线词典',
          ecd: '离线词典',
          youdao: '有道翻译',
          youdao_dict: '有道词典',
          d3325: '3325词典',
          datamuse: 'Datamuse',
          deepseek: 'DeepSeek',
          google_tts: 'Google TTS',
          youdao_tts: 'Youdao TTS',
          webspeech: 'Web Speech'
        };
        const apiName = apiLabels[item.api] || item.api || 'DeepSeek';
        const detailHtml = item.success && item.detail
          ? `<div class="meta" style="margin-top:4px;">详情：${escapeHtml(item.detail)}</div>`
          : '';
        const errorHtml = item.success
          ? ''
          : `<div class="error">错误：${escapeHtml(item.error || 'unknown')}${item.detail ? ' · ' + escapeHtml(item.detail) : ''}</div>`;
        return `
          <div class="item ${statusClass}">
            <div class="row">
              <div class="word">${escapeHtml(item.word || '(空)')}</div>
              ${badge}
            </div>
            <div class="meta">
              ${formatTime(item.time)}
              · API：${escapeHtml(apiName)}
              · 来源：${escapeHtml(item.source || '-')}
              · 耗时：${Number(item.durationMs || 0)} ms
            </div>
            ${detailHtml}
            ${errorHtml}
          </div>
        `;
      }).join('');
    }

    function loadLogs() {
      chrome.runtime.sendMessage({ action: 'getDeepseekApiLogs' }, (response) => {
        if (chrome.runtime.lastError) {
          logList.innerHTML = `<div class="empty">读取失败：${escapeHtml(chrome.runtime.lastError.message)}</div>`;
          return;
        }
        renderLogs(response && response.logs ? response.logs : []);
      });
    }

    window.refreshApiLogs = loadLogs;

    if (!logsBound) {
      logsBound = true;

      if (refreshBtn) refreshBtn.addEventListener('click', loadLogs);
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          if (!confirm('确定清空全部 API 调用日志吗？')) return;
          chrome.runtime.sendMessage({ action: 'clearDeepseekApiLogs' }, () => loadLogs());
        });
      }
      if (backBtn) {
        backBtn.addEventListener('click', () => {
          location.href = 'main.html';
        });
      }
      if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
          if (typeof window.switchVocabTab === 'function') {
            window.switchVocabTab('settings');
            return;
          }
          location.href = 'main.html?tab=settings';
        });
      }

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.deepseekApiLogs) {
          loadLogs();
        }
      });
    }

    loadLogs();
  };
})();
