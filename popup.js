// Popup Script (简化版，主要用于快速访问)
document.addEventListener('DOMContentLoaded', () => {
  const totalCountEl = document.getElementById('totalCount');
  const masteredCountEl = document.getElementById('masteredCount');
  const newCountEl = document.getElementById('newCount');
  const testBtn = document.getElementById('testBtn');
  const openMainBtn = document.getElementById('openMain');
  const openSettingsBtn = document.getElementById('openSettings');
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
  
  // 添加用户
  if (addUserBtn) {
    addUserBtn.addEventListener('click', async () => {
      const userName = prompt('请输入用户名：');
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
        });
      }
    });
  }

  // 打开主页面（优先复用已打开的主页标签，避免重复开页）
  // suffix 可为 '?tab=settings' / '#test' 等
  function openMainPage(suffix) {
    const targetUrl = chrome.runtime.getURL('main.html') + (suffix || '');
    chrome.tabs.query({}, (tabs) => {
      const mainPrefix = chrome.runtime.getURL('main.html');
      const existing = tabs.find(tab => tab.url && tab.url.startsWith(mainPrefix));
      if (existing) {
        chrome.tabs.update(existing.id, { active: true, url: targetUrl });
        if (existing.windowId != null) {
          chrome.windows.update(existing.windowId, { focused: true });
        }
      } else {
        chrome.tabs.create({ url: targetUrl });
      }
    });
  }

  if (openMainBtn) {
    openMainBtn.addEventListener('click', () => {
      openMainPage('');
    });
  }

  // 弹窗「开始测试」：打开主页并直接进入测试标签（不另开 test.html）
  if (testBtn) {
    testBtn.addEventListener('click', () => {
      openMainPage('?tab=test');
    });
  }

  // 打开设置：直接进主页设置 tab（不再走易失效的 openOptionsPage）
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', () => {
      openMainPage('?tab=settings');
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

      if (totalCountEl) totalCountEl.textContent = total;
      if (masteredCountEl) masteredCountEl.textContent = mastered;
      if (newCountEl) newCountEl.textContent = newCount;
    });
  }

  // 监听存储变化
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'local') {
      if (changes.currentUserId || changes.users) {
        await loadUsers();
      }
      const currentUserId = await getCurrentUserId();
      const userKey = `user_${currentUserId}_`;
      if (changes[`${userKey}savedWords`] || changes[`${userKey}wordStatus`]) {
        loadStats();
      }
    }
  });
  
  // 初始化
  loadUsers().then(() => {
    loadStats();
  });
});
