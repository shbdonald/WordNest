(function () {
  try {
    location.replace(chrome.runtime.getURL('main.html') + '?tab=settings');
  } catch (e) {
    location.replace('main.html?tab=settings');
  }
})();
document.addEventListener('DOMContentLoaded', function () {
  try {
    var a = document.getElementById('fallbackLink');
    if (a) a.href = chrome.runtime.getURL('main.html') + '?tab=settings';
  } catch (e) {}
});
