(function () {
  const THEMES = ['violet', 'ocean', 'forest', 'sunset', 'night'];

  function applyWnTheme(id) {
    const theme = THEMES.indexOf(id) >= 0 ? id : 'violet';
    document.documentElement.setAttribute('data-wn-theme', theme);
  }

  function loadWnTheme() {
    try {
      chrome.storage.local.get(['uiTheme'], (result) => {
        applyWnTheme(result && result.uiTheme);
      });
    } catch (e) {
      applyWnTheme('violet');
    }
  }

  loadWnTheme();

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.uiTheme) {
        applyWnTheme(changes.uiTheme.newValue);
      }
    });
  } catch (e) {}

  window.applyWnTheme = applyWnTheme;
})();
