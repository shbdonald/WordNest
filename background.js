// Background Service Worker
// 用于管理存储、词典查询和同步

// IndexedDB 数据库管理
const DB_NAME = 'vocab_dict_db';
const DB_VERSION = 2;  // 升级版本号以支持词形变化映射表
const STORE_NAME = 'dictionary';
const LEMMA_STORE_NAME = 'lemma_map';  // 词形变化映射表

let db = null;

// 初始化 IndexedDB
function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => {
      console.error('IndexedDB 打开失败:', request.error);
      reject(request.error);
    };
    
    request.onsuccess = () => {
      db = request.result;
      
      // 检查并创建缺失的 object store（兼容旧版本）
      if (!db.objectStoreNames.contains(STORE_NAME) || !db.objectStoreNames.contains(LEMMA_STORE_NAME)) {
        // 需要升级数据库
        db.close();
        const upgradeRequest = indexedDB.open(DB_NAME, DB_VERSION);
        upgradeRequest.onupgradeneeded = (event) => {
          const upgradeDb = event.target.result;
          if (!upgradeDb.objectStoreNames.contains(STORE_NAME)) {
            const objectStore = upgradeDb.createObjectStore(STORE_NAME, { keyPath: 'word' });
            objectStore.createIndex('word', 'word', { unique: true });
          }
          if (!upgradeDb.objectStoreNames.contains(LEMMA_STORE_NAME)) {
            const lemmaStore = upgradeDb.createObjectStore(LEMMA_STORE_NAME, { keyPath: 'variation' });
            lemmaStore.createIndex('variation', 'variation', { unique: true });
          }
        };
        upgradeRequest.onsuccess = () => {
          db = upgradeRequest.result;
          resolve(db);
        };
        upgradeRequest.onerror = () => {
          reject(upgradeRequest.error);
        };
      } else {
        resolve(db);
      }
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // 创建词典 store
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'word' });
        objectStore.createIndex('word', 'word', { unique: true });
      }
      // 创建词形变化映射表 store
      if (!db.objectStoreNames.contains(LEMMA_STORE_NAME)) {
        const lemmaStore = db.createObjectStore(LEMMA_STORE_NAME, { keyPath: 'variation' });
        lemmaStore.createIndex('variation', 'variation', { unique: true });
      }
    };
  });
}

// 将词典数据导入 IndexedDB（分批导入）
async function importDictionaryToIndexedDB(dictionary, lemmaMap = null) {
  if (!db) {
    await initIndexedDB();
  }
  
  // 检查 store 是否存在（兼容旧版本数据库）
  const hasLemmaStore = db.objectStoreNames.contains(LEMMA_STORE_NAME);
  const storeNames = (lemmaMap && hasLemmaStore) 
    ? [STORE_NAME, LEMMA_STORE_NAME]
    : [STORE_NAME];
  
  const words = Object.keys(dictionary);
  const batchSize = 1000;
  let processed = 0;
  let lemmaProcessed = 0;
  let errors = 0;
  
  // 处理词典单词（每次批处理都创建新的事务）
  async function processBatch(startIndex) {
    const endIndex = Math.min(startIndex + batchSize, words.length);
    const batch = words.slice(startIndex, endIndex);
    
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const wordStore = transaction.objectStore(STORE_NAME);
      
      transaction.onerror = () => {
        errors += batch.length;
        resolve();
      };
      
      transaction.oncomplete = () => {
        processed += batch.length;
        resolve();
      };
      
      batch.forEach(word => {
        const wordData = dictionary[word];
        let translation, phonetic;
        
        // 支持两种格式：
        // 1. 简单格式：{word: "translation"} （兼容旧格式）
        // 2. 完整格式：{word: {translation: "...", phonetic: "..."}} （新格式，包含音标）
        if (typeof wordData === 'string') {
          translation = wordData;
          phonetic = null;
        } else if (typeof wordData === 'object' && wordData !== null) {
          translation = wordData.translation || wordData;
          phonetic = wordData.phonetic || null;
        } else {
          translation = String(wordData);
          phonetic = null;
        }
        
        const request = wordStore.put({
          word: word.toLowerCase(),
          translation: translation,
          phonetic: phonetic // 音标字段（如果存在）
        });
        
        request.onerror = () => {
          errors++;
        };
      });
    });
  }
  
  // 处理词形变化映射表（每次批处理都创建新的事务）
  async function processLemmaBatch(startIdx, lemmaWords) {
    const endIdx = Math.min(startIdx + batchSize, lemmaWords.length);
    const lemmaBatch = lemmaWords.slice(startIdx, endIdx);
    
    return new Promise((resolve) => {
      const transaction = db.transaction([LEMMA_STORE_NAME], 'readwrite');
      const lemmaStore = transaction.objectStore(LEMMA_STORE_NAME);
      
      transaction.onerror = () => {
        errors += lemmaBatch.length;
        resolve();
      };
      
      transaction.oncomplete = () => {
        lemmaProcessed += lemmaBatch.length;
        resolve();
      };
      
      lemmaBatch.forEach(variation => {
        const request = lemmaStore.put({
          variation: variation.toLowerCase(),
          lemma: lemmaMap[variation].toLowerCase()
        });
        
        request.onerror = () => {
          errors++;
        };
      });
    });
  }
  
  // 主处理流程
  return new Promise(async (resolve, reject) => {
    try {
      // 处理所有词典单词
      for (let i = 0; i < words.length; i += batchSize) {
        await processBatch(i);
        // 每批处理后稍作延迟，避免阻塞
        if (i + batchSize < words.length) {
          await new Promise(r => setTimeout(r, 10));
        }
      }
      
      // 处理词形变化映射表
      if (lemmaMap && Object.keys(lemmaMap).length > 0 && hasLemmaStore) {
        const lemmaWords = Object.keys(lemmaMap);
        for (let i = 0; i < lemmaWords.length; i += batchSize) {
          await processLemmaBatch(i, lemmaWords);
          // 每批处理后稍作延迟，避免阻塞
          if (i + batchSize < lemmaWords.length) {
            await new Promise(r => setTimeout(r, 10));
          }
        }
      }
      
      resolve({
        processed,
        lemmaProcessed,
        errors,
        total: words.length,
        lemmaTotal: lemmaMap ? Object.keys(lemmaMap).length : 0
      });
    } catch (error) {
      reject(error);
    }
  });
}

// 从 IndexedDB 查询词形变化映射表
async function queryLemmaFromIndexedDB(variation) {
  if (!db) {
    await initIndexedDB();
  }
  
  // 如果映射表 store 不存在，直接返回 null（兼容旧版本数据库）
  if (!db.objectStoreNames.contains(LEMMA_STORE_NAME)) {
    return Promise.resolve(null);
  }
  
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction([LEMMA_STORE_NAME], 'readonly');
      const store = transaction.objectStore(LEMMA_STORE_NAME);
      const request = store.get(variation.toLowerCase());
      
      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result.lemma);  // 返回原形词
        } else {
          resolve(null);
        }
      };
      
      request.onerror = () => {
        resolve(null);  // 出错时返回 null 而不是 reject
      };
    } catch (error) {
      // 如果 store 不存在或其他错误，返回 null
      resolve(null);
    }
  });
}

// 缓存词典 key，供随机抽词（导入/清空时失效）
let cachedOfflineDictKeys = null;

function invalidateOfflineDictKeyCache() {
  cachedOfflineDictKeys = null;
}

async function getOfflineDictKeys() {
  if (cachedOfflineDictKeys && cachedOfflineDictKeys.length) {
    return cachedOfflineDictKeys;
  }

  if (!db) {
    await initIndexedDB();
  }

  const idbKeys = await new Promise((resolve) => {
    try {
      if (!db || !db.objectStoreNames.contains(STORE_NAME)) {
        resolve([]);
        return;
      }
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        resolve((request.result || []).map((k) => String(k)));
      };
      request.onerror = () => resolve([]);
    } catch (e) {
      resolve([]);
    }
  });

  if (idbKeys.length) {
    cachedOfflineDictKeys = idbKeys;
    return cachedOfflineDictKeys;
  }

  // 回退：chrome.storage 小词库
  const storageKeys = await new Promise((resolve) => {
    try {
      chrome.storage.local.get(['offlineDictionary'], (result) => {
        const dict = result.offlineDictionary || {};
        resolve(Object.keys(dict || {}));
      });
    } catch (e) {
      resolve([]);
    }
  });
  cachedOfflineDictKeys = storageKeys;
  return cachedOfflineDictKeys;
}

async function sampleOfflineDictWords(count = 3, excludeList = []) {
  const need = Math.max(0, Number(count) || 0);
  if (need <= 0) return [];

  const exclude = new Set(
    (Array.isArray(excludeList) ? excludeList : [])
      .map((w) => String(w || '').toLowerCase())
      .filter(Boolean)
  );

  const keys = await getOfflineDictKeys();
  if (!keys.length) return [];

  const candidates = keys.filter((k) => !exclude.has(String(k).toLowerCase()));
  if (!candidates.length) return [];

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
  }

  const picked = [];
  const tryLimit = Math.min(candidates.length, Math.max(need * 8, need));
  for (let i = 0; i < tryLimit && picked.length < need; i++) {
    const word = candidates[i];
    let translation = null;
    try {
      translation = await queryOfflineDictionary(word);
    } catch (e) {
      translation = null;
    }
    const text = typeof translation === 'string'
      ? translation
      : (translation && translation.translation) || '';
    const trimmed = String(text || '').trim();
    if (!trimmed) continue;
    picked.push({
      word: String(word),
      translation: trimmed,
      source: 'ecd'
    });
  }
  return picked;
}

// 从 IndexedDB 查询单词（返回翻译字符串，兼容旧代码）
async function queryWordFromIndexedDB(word) {
  if (!db) {
    await initIndexedDB();
  }
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(word.toLowerCase());
    
    request.onsuccess = () => {
      if (request.result) {
        resolve(request.result.translation);
      } else {
        resolve(null);
      }
    };
    
    request.onerror = () => {
      reject(request.error);
    };
  });
}

// 从 IndexedDB 查询单词完整数据（包括音标等）
async function queryWordDataFromIndexedDB(word) {
  if (!db) {
    await initIndexedDB();
  }
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(word.toLowerCase());
    
    request.onsuccess = () => {
      if (request.result) {
        // 返回完整数据对象
        resolve({
          translation: request.result.translation,
          phonetic: request.result.phonetic || null, // 音标字段（如果存在）
          word: word
        });
      } else {
        resolve(null);
      }
    };
    
    request.onerror = () => {
      reject(request.error);
    };
  });
}

// 获取 IndexedDB 统计信息
async function getDictionaryStats() {
  try {
    if (!db) {
      await initIndexedDB();
    }
    
    // 确保数据库连接有效
    if (!db) {
      return {
        wordCount: 0,
        lemmaCount: 0,
        hasDictionary: false,
        hasLemmaMap: false,
        error: '数据库未初始化'
      };
    }
    
    return new Promise((resolve, reject) => {
      try {
        const stats = {
          wordCount: 0,
          lemmaCount: 0,
          hasDictionary: db.objectStoreNames.contains(STORE_NAME),
          hasLemmaMap: db.objectStoreNames.contains(LEMMA_STORE_NAME)
        };
        
        // 如果两个 store 都不存在，直接返回
        if (!stats.hasDictionary && !stats.hasLemmaMap) {
          resolve(stats);
          return;
        }
        
        let completed = 0;
        const total = (stats.hasDictionary ? 1 : 0) + (stats.hasLemmaMap ? 1 : 0);
        
        const checkComplete = () => {
          completed++;
          if (completed === total) {
            resolve(stats);
          }
        };
        
        // 统计词典单词数
        if (stats.hasDictionary) {
          try {
            const wordTransaction = db.transaction([STORE_NAME], 'readonly');
            const wordStore = wordTransaction.objectStore(STORE_NAME);
            const wordRequest = wordStore.count();
            
            wordRequest.onsuccess = () => {
              stats.wordCount = wordRequest.result;
              checkComplete();
            };
            
            wordRequest.onerror = () => {
              console.error('统计词典单词数失败:', wordRequest.error);
              checkComplete();
            };
          } catch (error) {
            console.error('统计词典单词数异常:', error);
            checkComplete();
          }
        }
        
        // 统计映射表条目数
        if (stats.hasLemmaMap) {
          try {
            const lemmaTransaction = db.transaction([LEMMA_STORE_NAME], 'readonly');
            const lemmaStore = lemmaTransaction.objectStore(LEMMA_STORE_NAME);
            const lemmaRequest = lemmaStore.count();
            
            lemmaRequest.onsuccess = () => {
              stats.lemmaCount = lemmaRequest.result;
              checkComplete();
            };
            
            lemmaRequest.onerror = () => {
              console.error('统计映射表条目数失败:', lemmaRequest.error);
              checkComplete();
            };
          } catch (error) {
            console.error('统计映射表条目数异常:', error);
            checkComplete();
          }
        }
        
        // 超时保护（5秒）
        setTimeout(() => {
          if (completed < total) {
            console.warn('统计信息查询超时');
            resolve(stats);
          }
        }, 5000);
      } catch (error) {
        console.error('获取统计信息异常:', error);
        reject(error);
      }
    });
  } catch (error) {
    console.error('getDictionaryStats 错误:', error);
    return {
      wordCount: 0,
      lemmaCount: 0,
      hasDictionary: false,
      hasLemmaMap: false,
      error: error.message
    };
  }
}

// 有道词典API（在background中调用，避免CORS问题）
async function translateWordToChineseYoudao(word) {
  try {
    const url = `http://dict.youdao.com/suggest?q=${encodeURIComponent(word)}&num=1&doctype=json`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    
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
      
      if (data && data.data && data.data.entries && data.data.entries.length > 0) {
        const entry = data.data.entries[0];
        if (entry.explain) {
          return entry.explain.trim();
        }
      }
      return null;
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        return null;
      }
      throw fetchError;
    }
  } catch (error) {
    console.error('有道词典API错误:', error);
    return null;
  }
}

// ================= 百度翻译API（在 background 中调用，避免 CORS） =================

// 简单 MD5 实现（只在 background 内部使用，用于百度签名）
function md5ForBaidu(str) {
  function rotateLeft(lValue, iShiftBits) {
    return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  }
  function addUnsigned(lX, lY) {
    let lX4, lY4, lX8, lY8, lResult;
    lX8 = lX & 0x80000000;
    lY8 = lY & 0x80000000;
    lX4 = lX & 0x40000000;
    lY4 = lY & 0x40000000;
    lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
      return lResult ^ 0x40000000 ^ lX8 ^ lY8;
    }
    return lResult ^ lX8 ^ lY8;
  }
  function F(x, y, z) { return (x & y) | (~x & z); }
  function G(x, y, z) { return (x & z) | (y & ~z); }
  function H(x, y, z) { return x ^ y ^ z; }
  function I(x, y, z) { return y ^ (x | ~z); }
  function FF(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, F(b, c, d)), addUnsigned(x, ac)), s), b); }
  function GG(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, G(b, c, d)), addUnsigned(x, ac)), s), b); }
  function HH(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, H(b, c, d)), addUnsigned(x, ac)), s), b); }
  function II(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, I(b, c, d)), addUnsigned(x, ac)), s), b); }

  function toWordArray(str) {
    const lMessageLength = str.length;
    const lNumberOfWordsTemp1 = lMessageLength + 8;
    const lNumberOfWordsTemp2 = (lNumberOfWordsTemp1 - (lNumberOfWordsTemp1 % 64)) / 64;
    const lNumberOfWords = (lNumberOfWordsTemp2 + 1) * 16;
    const lWordArray = new Array(lNumberOfWords - 1);
    let lBytePosition = 0;
    let lByteCount = 0;
    while (lByteCount < lMessageLength) {
      const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = (lWordArray[lWordCount] | (str.charCodeAt(lByteCount) << lBytePosition)) >>> 0;
      lByteCount++;
    }
    const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
    lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
    lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
    return lWordArray;
  }

  function wordToHex(lValue) {
    let wordToHexValue = '';
    for (let lCount = 0; lCount <= 3; lCount++) {
      const lByte = (lValue >>> (lCount * 8)) & 255;
      const wordToHexValueTemp = '0' + lByte.toString(16);
      wordToHexValue += wordToHexValueTemp.substr(wordToHexValueTemp.length - 2, 2);
    }
    return wordToHexValue;
  }

  function utf8Encode(str) {
    str = str.replace(/\r\n/g, '\n');
    let utftext = '';
    for (let n = 0; n < str.length; n++) {
      const c = str.charCodeAt(n);
      if (c < 128) utftext += String.fromCharCode(c);
      else if (c < 2048) {
        utftext += String.fromCharCode((c >> 6) | 192);
        utftext += String.fromCharCode((c & 63) | 128);
      } else {
        utftext += String.fromCharCode((c >> 12) | 224);
        utftext += String.fromCharCode(((c >> 6) & 63) | 128);
        utftext += String.fromCharCode((c & 63) | 128);
      }
    }
    return utftext;
  }

  let x = [];
  let a, b, c, d;
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

  str = utf8Encode(str);
  x = toWordArray(str);

  a = 0x67452301;
  b = 0xefcdab89;
  c = 0x98badcfe;
  d = 0x10325476;

  for (let k = 0; k < x.length; k += 16) {
    const AA = a;
    const BB = b;
    const CC = c;
    const DD = d;
    a = FF(a, b, c, d, x[k + 0], S11, 0xd76aa478);
    d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756);
    c = FF(c, d, a, b, x[k + 2], S13, 0x242070db);
    b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee);
    a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf);
    d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a);
    c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613);
    b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501);
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8);
    d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af);
    c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1);
    b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be);
    a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122);
    d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193);
    c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e);
    b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821);
    a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562);
    d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340);
    c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51);
    b = GG(b, c, d, a, x[k + 0], S24, 0xe9b6c7aa);
    a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d);
    d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
    c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681);
    b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8);
    a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6);
    d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6);
    c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87);
    b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed);
    a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905);
    d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8);
    c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9);
    b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a);
    a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942);
    d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681);
    c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122);
    b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c);
    a = HH(a, b, c, d, x[k + 1], S31, 0xa4beeaa4);
    d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9);
    c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60);
    b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70);
    a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6);
    d = HH(d, a, b, c, x[k + 0], S32, 0xeaa127fa);
    c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085);
    b = HH(b, c, d, a, x[k + 6], S34, 0x4881d05);
    a = II(a, b, c, d, x[k + 0], S41, 0xf4292244);
    d = II(d, a, b, c, x[k + 7], S42, 0x432aff97);
    c = II(c, d, a, b, x[k + 14], S43, 0xab9423a7);
    b = II(b, c, d, a, x[k + 5], S44, 0xfc93a039);
    a = II(a, b, c, d, x[k + 12], S41, 0x655b59c3);
    d = II(d, a, b, c, x[k + 3], S42, 0x8f0ccc92);
    c = II(c, d, a, b, x[k + 10], S43, 0xffeff47d);
    b = II(b, c, d, a, x[k + 1], S44, 0x85845dd1);
    a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f);
    d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0);
    c = II(c, d, a, b, x[k + 6], S43, 0xa3014314);
    b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1);
    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }

  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
}

// 后台调用百度翻译
async function translateWordWithBaiduInBackground(word) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['baiduAppId', 'baiduSecretKey'], async (result) => {
      const appId = result.baiduAppId;
      const secretKey = result.baiduSecretKey;

      if (!appId || !secretKey) {
        console.warn('[Baidu] 未配置 APP ID 或密钥');
        resolve({ success: false, error: 'missing_config' });
        return;
      }

      try {
        const salt = Date.now().toString();
        const from = 'en';
        const to = 'zh';
        const signStr = appId + word + salt + secretKey;
        const sign = md5ForBaidu(signStr);

        const url = 'https://fanyi-api.baidu.com/api/trans/vip/translate';
        const params = new URLSearchParams({
          q: word,
          from,
          to,
          appid: appId,
          salt,
          sign
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${url}?${params.toString()}`, {
          method: 'GET',
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (data.error_code) {
          console.error('[Baidu] API 错误:', data.error_code, data.error_msg);
          resolve({ success: false, error: `${data.error_code}:${data.error_msg}` });
          return;
        }

        if (data.trans_result && data.trans_result.length > 0) {
          resolve({ success: true, translation: data.trans_result[0].dst });
          return;
        }

        resolve({ success: false, error: 'invalid_response' });
      } catch (error) {
        console.error('[Baidu] 翻译请求失败:', error);
        resolve({ success: false, error: error.message || 'request_failed' });
      }
    });
  });
}

// 查询离线词典（优先使用 exchange 映射表，回退到算法匹配）
async function queryOfflineDictionary(word) {
  const lowerWord = word.toLowerCase().trim();
  
  // 调试日志
  console.log(`[离线词典查询] 查询单词: ${word} (${lowerWord})`);
  
  // 1. 先查 IndexedDB（直接查询）
  let translation = await queryWordFromIndexedDB(lowerWord);
  if (translation) {
    console.log(`[离线词典查询] 直接查询找到: ${word} -> ${translation.substring(0, 50)}...`);
    return { translation, source: 'ecd' };
  }
  console.log(`[离线词典查询] 直接查询未找到: ${word}`);
  
  // 2. 查询词形变化映射表（使用 ECDICT 的 exchange 字段）
  const lemma = await queryLemmaFromIndexedDB(lowerWord);
  if (lemma) {
    console.log(`[离线词典查询] 映射表找到原形词: ${word} -> ${lemma}`);
    // 找到原形词，查询原形词的翻译
    translation = await queryWordFromIndexedDB(lemma);
    if (translation) {
      console.log(`[离线词典查询] 通过映射表找到翻译: ${word} -> ${lemma} -> ${translation.substring(0, 50)}...`);
      return { translation, source: 'ecd' };
    } else {
      console.log(`[离线词典查询] 映射表找到原形词但未找到翻译: ${word} -> ${lemma}`);
    }
  } else {
    console.log(`[离线词典查询] 映射表中未找到: ${word}`);
  }
  
  // 3. 如果映射表中没有，尝试算法匹配（作为备用方案）
  const variations = [
    // 复数
    lowerWord.endsWith('s') ? lowerWord.slice(0, -1) : null,
    lowerWord.endsWith('es') ? lowerWord.slice(0, -2) : null,
    lowerWord.endsWith('ies') ? lowerWord.slice(0, -3) + 'y' : null,
    // 过去式
    lowerWord.endsWith('ed') ? lowerWord.slice(0, -2) : null,
    lowerWord.endsWith('ied') ? lowerWord.slice(0, -3) + 'y' : null,
    lowerWord.endsWith('d') ? lowerWord.slice(0, -1) : null,
    // 进行时
    lowerWord.endsWith('ing') ? lowerWord.slice(0, -3) : null,
    lowerWord.endsWith('ying') ? lowerWord.slice(0, -4) + 'y' : null,
    // 比较级
    lowerWord.endsWith('er') ? lowerWord.slice(0, -2) : null,
    lowerWord.endsWith('ier') ? lowerWord.slice(0, -3) + 'y' : null,
    // 最高级
    lowerWord.endsWith('est') ? lowerWord.slice(0, -3) : null,
    lowerWord.endsWith('iest') ? lowerWord.slice(0, -4) + 'y' : null,
  ].filter(v => v !== null);
  
  for (const baseWord of variations) {
    translation = await queryWordFromIndexedDB(baseWord);
    if (translation) {
      return { translation, source: 'ecd' };
    }
  }
  
  // 4. 如果IndexedDB中找不到，尝试有道词典API
  translation = await translateWordToChineseYoudao(word);
  if (translation) {
    return { translation, source: 'youdao' };
  }
  
  return null;
}

// 查询离线词典完整数据（包括音标）
async function queryOfflineDictionaryData(word) {
  const lowerWord = word.toLowerCase().trim();
  
  // 1. 先查 IndexedDB（直接查询）
  let wordData = await queryWordDataFromIndexedDB(lowerWord);
  if (wordData) {
    return wordData;
  }
  
  // 2. 查询词形变化映射表
  const lemma = await queryLemmaFromIndexedDB(lowerWord);
  if (lemma) {
    wordData = await queryWordDataFromIndexedDB(lemma);
    if (wordData) {
      return wordData;
    }
  }
  
  // 3. 尝试算法匹配
  const variations = [
    lowerWord.endsWith('ies') ? lowerWord.slice(0, -3) + 'y' : null,
    lowerWord.endsWith('es') ? lowerWord.slice(0, -2) : null,
    lowerWord.endsWith('s') ? lowerWord.slice(0, -1) : null,
  ].filter(v => v !== null && v.length >= 2);
  
  for (const baseWord of variations) {
    wordData = await queryWordDataFromIndexedDB(baseWord);
    if (wordData) {
      return wordData;
    }
  }
  
  return null;
}

// ================= DeepSeek（生成用法/例句；WordsAPI 暂搁置） =================

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
  } else {
    // 兼容扁平结构
    const defs = [];
    if (payload.definition || payload.meaning) {
      defs.push({
        definition: payload.definition || payload.meaning,
        example: Array.isArray(payload.examples) ? payload.examples[0] : payload.example
      });
    }
    if (Array.isArray(payload.examples)) {
      payload.examples.slice(0, 3).forEach((ex, idx) => {
        if (idx === 0 && defs[0] && !defs[0].example) {
          defs[0].example = ex;
        } else if (typeof ex === 'string' && ex.trim()) {
          defs.push({
            definition: payload.usage || 'Usage example',
            example: ex
          });
        }
      });
    }
    if (defs.length) {
      meanings = [{
        partOfSpeech: payload.partOfSpeech || 'unknown',
        definitions: defs.filter((d) => d.definition),
        synonyms: Array.isArray(payload.synonyms) ? payload.synonyms.slice(0, 8) : []
      }];
    }
  }

  if (!meanings.length) return null;

  return {
    word: word,
    phonetics,
    meanings,
    translation: payload.translation || payload.chinese || '',
    usage: payload.usage || '',
    sourceAbbr: 'deepseek'
  };
}

function sanitizeDeepseekApiKey(key) {
  return String(key || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/[“”‘’]/g, '')
    .trim()
    .replace(/[^\x21-\x7E]/g, '');
}

const DEEPSEEK_LOG_KEY = 'deepseekApiLogs';
const DEEPSEEK_LOG_LIMIT = 1000;

async function appendDeepseekApiLog(entry) {
  try {
    const result = await new Promise((resolve) => {
      chrome.storage.local.get([DEEPSEEK_LOG_KEY], resolve);
    });
    const logs = Array.isArray(result[DEEPSEEK_LOG_KEY]) ? result[DEEPSEEK_LOG_KEY] : [];
    logs.unshift({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      time: Date.now(),
      word: entry.word || '',
      success: !!entry.success,
      error: entry.error || '',
      source: entry.source || 'background',
      // deepseek | freedictionary | datamuse | google_tts | youdao_tts | webspeech
      api: entry.api || 'deepseek',
      durationMs: entry.durationMs || 0,
      detail: entry.detail || ''
    });
    const trimmed = logs.slice(0, DEEPSEEK_LOG_LIMIT);
    await new Promise((resolve) => {
      chrome.storage.local.set({ [DEEPSEEK_LOG_KEY]: trimmed }, resolve);
    });
  } catch (e) {
    console.warn('写入 API 调用日志失败:', e);
  }
}

async function getDeepseekApiLogs() {
  const result = await new Promise((resolve) => {
    chrome.storage.local.get([DEEPSEEK_LOG_KEY], resolve);
  });
  return Array.isArray(result[DEEPSEEK_LOG_KEY]) ? result[DEEPSEEK_LOG_KEY] : [];
}

async function clearDeepseekApiLogs() {
  await new Promise((resolve) => {
    chrome.storage.local.set({ [DEEPSEEK_LOG_KEY]: [] }, resolve);
  });
}

// 总开关：false = 任何路径都禁止调用 DeepSeek（避免后台批量/悬停偷偷计费）
const ENABLE_DEEPSEEK_API = false;

async function lookupWordWithDeepseek(word) {
  if (!ENABLE_DEEPSEEK_API) {
    return { success: false, error: 'deepseek_disabled' };
  }
  const keyResult = await new Promise((resolve) => {
    chrome.storage.local.get(['deepseekApiKey'], resolve);
  });
  const apiKey = sanitizeDeepseekApiKey(keyResult.deepseekApiKey || '');
  if (!apiKey) {
    return { success: false, error: 'missing_deepseek_key' };
  }

  const cleanWord = String(word || '').trim();
  if (!cleanWord) {
    return { success: false, error: 'empty_word' };
  }

  const systemPrompt =
    'You are an English learner dictionary assistant. Return ONLY valid JSON, no markdown.';
  const userPrompt =
    `For the English word "${cleanWord}", return JSON with this schema:\n` +
    `{\n` +
    `  "word": "${cleanWord}",\n` +
    `  "phonetic": "IPA without slashes",\n` +
    `  "translation": "简体中文释义",\n` +
    `  "usage": "一句话说明常见用法（中文）",\n` +
    `  "meanings": [\n` +
    `    {\n` +
    `      "partOfSpeech": "noun|verb|adjective|adverb|...",\n` +
    `      "definitions": [\n` +
    `        { "definition": "simple English definition", "example": "one natural example sentence" }\n` +
    `      ],\n` +
    `      "synonyms": ["optional", "synonyms"]\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `Rules: focus on common senses (max 2); each sense 1 definition with example; keep language CEFR A2-B1; reply JSON only.`;

  // MV3：长请求时保活，避免 service worker 被挂起导致 message port closed
  const keepAliveId = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch (e) {}
  }, 5000);

  const doRequest = async (withJsonFormat) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    const body = {
      model: 'deepseek-chat',
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };
    if (withJsonFormat) {
      body.response_format = { type: 'json_object' };
    }

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `auth_failed:${response.status}` };
      }
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return {
          success: false,
          error: `http_${response.status}`,
          detail: errText.slice(0, 300),
          retryWithoutJsonFormat: withJsonFormat && (response.status === 400 || response.status === 422)
        };
      }

      const raw = await response.json();
      const content = raw && raw.choices && raw.choices[0] && raw.choices[0].message
        ? raw.choices[0].message.content
        : '';
      const parsed = extractJsonObject(content);
      const data = convertDeepseekToDictFormat(cleanWord, parsed);
      if (!data || !data.meanings || data.meanings.length === 0) {
        return { success: false, error: 'empty_result', raw: content };
      }
      return { success: true, data, raw: parsed };
    } catch (error) {
      const msg = error && error.name === 'AbortError' ? 'timeout' : (error.message || 'request_failed');
      return { success: false, error: msg };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const startedAt = Date.now();
  try {
    let result = await doRequest(true);
    if (!result.success && result.retryWithoutJsonFormat) {
      result = await doRequest(false);
    }
    await appendDeepseekApiLog({
      word: cleanWord,
      success: !!(result && result.success),
      error: (result && result.error) || '',
      detail: (result && result.detail) || '',
      source: 'background',
      durationMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    await appendDeepseekApiLog({
      word: cleanWord,
      success: false,
      error: (error && error.message) || 'unknown_error',
      source: 'background',
      durationMs: Date.now() - startedAt
    });
    throw error;
  } finally {
    clearInterval(keepAliveId);
  }
}

// 内容脚本里的 fetch 会受网页 CSP 限制（Failed to fetch）。这些词典/翻译域名改由后台请求。
const PROXY_HTTP_HOSTS = new Set([
  'api.dictionaryapi.dev',
  'api.datamuse.com',
  'dict.youdao.com',
  'fanyi.youdao.com',
  'translate.googleapis.com',
  '3325.cn',
  'api.mymemory.translated.net'
]);

async function proxyHttpGet(url, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (e) {
    return { success: false, error: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:' || !PROXY_HTTP_HOSTS.has(parsed.hostname)) {
    return { success: false, error: 'host_not_allowed' };
  }
  const ms = Math.min(15000, Math.max(1000, Number(timeoutMs) || 8000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(parsed.toString(), {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store'
    });
    const text = await response.text();
    return { success: true, ok: response.ok, status: response.status, text };
  } catch (e) {
    const aborted = !!(e && (e.name === 'AbortError' || /abort/i.test(String(e.message || ''))));
    return { success: false, error: aborted ? 'timeout' : 'Failed to fetch' };
  } finally {
    clearTimeout(timer);
  }
}

// 跨用户查询缓存：清空生词本时保留，任意用户再查同一词直接复用。
const SHARED_LOOKUP_KEY = 'sharedLookupCache';
const SHARED_ONLINE_SOURCES = new Set([
  'fd', 'datamuse', 'youdao', 'youdao_dict', 'd3325', 'gt', 'bd', 'mm',
  'deepseek', 'google', 'api', 'wordsapi', 'bing'
]);

let sharedLookupWriteChain = Promise.resolve();

function withSharedLookupWrite(task) {
  const run = sharedLookupWriteChain.then(task, task);
  sharedLookupWriteChain = run.then(() => {}, () => {});
  return run;
}

function sharedIsMostlyChinese(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return (cjk / t.length) >= 0.35;
}

function sharedHasEnglish(dict) {
  if (!dict || !Array.isArray(dict.meanings)) return false;
  return dict.meanings.some((meaning) =>
    (meaning.definitions || []).some((def) => {
      const text = String(def && def.definition || '').trim();
      return text.length >= 6 && !sharedIsMostlyChinese(text);
    })
  );
}

function sharedIsOnlineSource(code) {
  return SHARED_ONLINE_SOURCES.has(String(code || '').toLowerCase());
}

function sharedCollectSources(dict) {
  if (!dict || typeof dict !== 'object') return [];
  const codes = [];
  ['sourceAbbr', 'translationSource', 'enSourceAbbr', 'zhSourceAbbr'].forEach((key) => {
    if (dict[key]) codes.push(dict[key]);
  });
  if (Array.isArray(dict.sources)) codes.push(...dict.sources);
  (dict.phonetics || []).forEach((item) => {
    if (item && item.source) codes.push(item.source);
  });
  return codes;
}

function sharedIsSettledDict(dict) {
  if (!dict) return false;
  if (sharedHasEnglish(dict) && (dict.detailCached === true || sharedIsOnlineSource(dict.sourceAbbr))) return true;
  if (dict.lookupMiss === true && sharedHasEnglish(dict)) return true;
  if (dict.lookupMiss === true && dict.lookupFullChainTried === true) return true;
  return false;
}

function sharedWorthKeeping(dict, translation, translationSource) {
  if (sharedCollectSources(dict).some(sharedIsOnlineSource)) return true;
  if (dict && dict.detailCached === true && sharedIsOnlineSource(dict.sourceAbbr)) return true;
  if (dict && dict.lookupFullChainTried === true) return true;
  if (sharedIsOnlineSource(translationSource) && String(translation || '').trim()) return true;
  return false;
}

function sharedPickDict(prev, next) {
  if (!next) return prev || null;
  if (!prev) return next;
  const prevGood = sharedHasEnglish(prev) && prev.lookupMiss !== true;
  const nextGood = sharedHasEnglish(next) && next.lookupMiss !== true;
  if (nextGood && !prevGood) return next;
  if (prevGood && !nextGood) return prev;
  if (next.lookupMiss === true && prev.lookupMiss !== true && (prev.translation || sharedHasEnglish(prev))) {
    return prev;
  }
  const prevCount = Array.isArray(prev.meanings) ? prev.meanings.length : 0;
  const nextCount = Array.isArray(next.meanings) ? next.meanings.length : 0;
  if (nextCount > prevCount) return next;
  if (prevCount > nextCount) return prev;
  return next;
}

function loadSharedLookupMap() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SHARED_LOOKUP_KEY], (result) => {
      const raw = result && result[SHARED_LOOKUP_KEY];
      resolve(new Map(Array.isArray(raw) ? raw : []));
    });
  });
}

function saveSharedLookupMap(map) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SHARED_LOOKUP_KEY]: Array.from(map.entries()) }, () => resolve());
  });
}

async function mergeSharedLookup(word, patch) {
  const lower = String(word || '').trim().toLowerCase();
  if (!lower || !patch) return false;
  const dict = patch.dict || null;
  const translation = String(patch.translation || (dict && dict.translation) || '').trim();
  const translationSource = String(
    patch.translationSource || (dict && dict.translationSource) || ''
  ).trim();
  if (!sharedWorthKeeping(dict, translation, translationSource)) return false;

  const map = await loadSharedLookupMap();
  const prev = map.get(lower) || null;
  const nextDict = sharedPickDict(prev && prev.dict, dict);
  const prevTranslation = String((prev && prev.translation) || '').trim();
  const nextTranslation = translation || String((nextDict && nextDict.translation) || '').trim() || prevTranslation;
  let nextSource = translationSource;
  if (!nextSource && nextDict && nextDict.translationSource) nextSource = nextDict.translationSource;
  if (!nextTranslation) nextSource = (prev && prev.translationSource) || '';
  else if (!nextSource) nextSource = (prev && prev.translationSource) || '';
  map.set(lower, {
    dict: nextDict,
    translation: nextTranslation,
    translationSource: nextSource,
    cachedAt: Date.now()
  });
  await saveSharedLookupMap(map);
  return true;
}

async function getSharedLookup(word) {
  const lower = String(word || '').trim().toLowerCase();
  if (!lower || /\s/.test(lower)) return null;
  const map = await loadSharedLookupMap();
  return map.get(lower) || null;
}

async function archiveUserLookups(userId) {
  const userKey = `user_${String(userId || 'default')}_`;
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get([
      `${userKey}wordDictionaryData`,
      `${userKey}wordChineseTranslations`,
      `${userKey}wordChineseSources`,
      `${userKey}wordTranslations`
    ], resolve);
  });
  const dicts = new Map(stored[`${userKey}wordDictionaryData`] || []);
  const chinese = new Map(stored[`${userKey}wordChineseTranslations`] || []);
  const sources = new Map(stored[`${userKey}wordChineseSources`] || []);
  const translations = new Map(stored[`${userKey}wordTranslations`] || []);
  const words = new Set();
  [dicts, chinese, sources, translations].forEach((map) => {
    map.forEach((_value, key) => words.add(String(key || '').toLowerCase()));
  });
  const valueFor = (map, lower) => {
    if (map.has(lower)) return map.get(lower);
    for (const [key, value] of map) {
      if (String(key || '').toLowerCase() === lower) return value;
    }
    return null;
  };
  let saved = 0;
  for (const lower of words) {
    if (!lower) continue;
    const dict = valueFor(dicts, lower);
    const translation = String(
      valueFor(chinese, lower) || valueFor(translations, lower) || (dict && dict.translation) || ''
    ).trim();
    const translationSource = String(
      valueFor(sources, lower) || (dict && dict.translationSource) || ''
    ).trim();
    const kept = await mergeSharedLookup(lower, { dict, translation, translationSource });
    if (kept) saved += 1;
  }
  return saved;
}

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 所有异步操作都需要返回 true 以保持消息通道开放
  let responseSent = false;
  
  const safeSendResponse = (response) => {
    if (!responseSent) {
      responseSent = true;
      try {
        sendResponse(response);
      } catch (error) {
        console.error('发送响应失败:', error);
      }
    }
  };
  
  if (request.action === 'sampleOfflineDictWords') {
    sampleOfflineDictWords(request.count || 3, request.exclude || [])
      .then((words) => safeSendResponse({ success: true, words: words || [] }))
      .catch((error) => safeSendResponse({ success: false, error: error.message, words: [] }));
    return true;
  }

  if (request.action === 'queryOfflineDict') {
    queryOfflineDictionary(request.word).then((result) => {
      if (!result) {
        safeSendResponse({ success: true, translation: null, source: '' });
        return;
      }
      if (typeof result === 'string') {
        safeSendResponse({ success: true, translation: result, source: 'ecd' });
        return;
      }
      safeSendResponse({
        success: true,
        translation: result.translation || null,
        source: result.source || 'ecd'
      });
    }).catch(error => {
      safeSendResponse({ success: false, error: error.message });
    });
    return true; // 保持消息通道开放
  }
  
  if (request.action === 'queryOfflineDictData') {
    // 查询离线词典完整数据（包括音标）
    queryOfflineDictionaryData(request.word).then(data => {
      safeSendResponse({ success: true, data });
    }).catch(error => {
      safeSendResponse({ success: false, error: error.message });
    });
    return true; // 保持消息通道开放
  }
  
  if (request.action === 'queryLemma') {
    queryLemmaFromIndexedDB(request.word).then(lemma => {
      safeSendResponse({ success: true, lemma });
    }).catch(error => {
      safeSendResponse({ success: false, error: error.message });
    });
    return true; // 保持消息通道开放
  }
  
  if (request.action === 'importDictionary') {
    // 添加超时保护
    const timeout = setTimeout(() => {
      safeSendResponse({ success: false, error: '导入超时，请检查文件大小或重试' });
    }, 300000); // 5分钟超时
    
    importDictionaryToIndexedDB(request.dictionary, request.lemmaMap || null)
      .then(async result => {
        clearTimeout(timeout);
        invalidateOfflineDictKeyCache();
        try {
          // 导入后获取最新统计信息（添加超时）
          const statsPromise = getDictionaryStats();
          const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 5000));
          const stats = await Promise.race([statsPromise, timeoutPromise]) || {
            wordCount: result.processed,
            lemmaCount: result.lemmaProcessed || 0,
            hasDictionary: true,
            hasLemmaMap: result.lemmaProcessed > 0
          };
          
          safeSendResponse({ success: true, result: { ...result, stats } });
        } catch (error) {
          console.error('获取统计信息失败:', error);
          safeSendResponse({ success: true, result });
        }
      })
      .catch(error => {
        clearTimeout(timeout);
        safeSendResponse({ success: false, error: error.message });
      });
    return true;
  }
  
  if (request.action === 'getDictionaryStats') {
    getDictionaryStats()
      .then(stats => {
        safeSendResponse({ success: true, stats });
      })
      .catch(error => {
        safeSendResponse({ success: false, error: error.message, stats: {
          wordCount: 0,
          lemmaCount: 0,
          hasDictionary: false,
          hasLemmaMap: false
        }});
      });
    return true;
  }

  // 百度翻译（在 background 中执行，避免 CORS）
  if (request.action === 'baiduTranslate') {
    translateWordWithBaiduInBackground(request.word)
      .then(result => {
        safeSendResponse(result);
      })
      .catch(error => {
        safeSendResponse({ success: false, error: error.message || 'unknown_error' });
      });
    return true;
  }

  // DeepSeek 生成释义/用法/例句（WordsAPI 暂搁置）
  if (request.action === 'deepseekLookup') {
    (async () => {
      try {
        const result = await lookupWordWithDeepseek(request.word);
        safeSendResponse(result || { success: false, error: 'empty_response' });
      } catch (error) {
        safeSendResponse({ success: false, error: (error && error.message) || 'unknown_error' });
      }
    })();
    return true;
  }

  if (request.action === 'getDeepseekApiLogs') {
    getDeepseekApiLogs()
      .then((logs) => safeSendResponse({ success: true, logs }))
      .catch((error) => safeSendResponse({ success: false, error: error.message, logs: [] }));
    return true;
  }

  if (request.action === 'clearDeepseekApiLogs') {
    clearDeepseekApiLogs()
      .then(() => safeSendResponse({ success: true }))
      .catch((error) => safeSendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'appendDeepseekApiLog') {
    appendDeepseekApiLog(request.entry || {})
      .then(() => safeSendResponse({ success: true }))
      .catch((error) => safeSendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getSharedLookup') {
    getSharedLookup(request.word)
      .then((entry) => safeSendResponse({ success: true, entry: entry || null }))
      .catch((error) => safeSendResponse({ success: false, error: (error && error.message) || 'failed', entry: null }));
    return true;
  }

  if (request.action === 'putSharedLookup') {
    withSharedLookupWrite(() => mergeSharedLookup(request.word, {
      dict: request.dict || null,
      translation: request.translation || '',
      translationSource: request.translationSource || ''
    }))
      .then((saved) => safeSendResponse({ success: true, saved: !!saved }))
      .catch((error) => safeSendResponse({ success: false, error: (error && error.message) || 'failed' }));
    return true;
  }

  if (request.action === 'archiveUserLookups') {
    withSharedLookupWrite(() => archiveUserLookups(request.userId))
      .then((saved) => safeSendResponse({ success: true, saved: saved || 0 }))
      .catch((error) => safeSendResponse({ success: false, error: (error && error.message) || 'failed' }));
    return true;
  }

  if (request.action === 'proxyHttpGet') {
    proxyHttpGet(request.url, request.timeoutMs)
      .then((result) => safeSendResponse(result))
      .catch((error) => safeSendResponse({ success: false, error: (error && error.message) || 'Failed to fetch' }));
    return true;
  }

  // Ping 测试消息
  if (request.action === 'ping') {
    safeSendResponse({ success: true, message: 'pong', timestamp: Date.now() });
    return true;
  }
  
  if (request.action === 'clearDictionary') {
    invalidateOfflineDictKeyCache();
    if (!db) {
      initIndexedDB().then(() => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.clear().onsuccess = () => {
          sendResponse({ success: true });
        };
      });
    } else {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.clear().onsuccess = () => {
        sendResponse({ success: true });
      };
    }
    return true;
  }
});

// 初始化
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Background] Extension installed/updated');
  
  // 初始化用户数据
  chrome.storage.local.get(['users', 'currentUserId'], (result) => {
    if (!result.users || Object.keys(result.users).length === 0) {
      chrome.storage.local.set({
        users: { 'default': { name: '默认用户', createdAt: Date.now() } },
        currentUserId: 'default'
      });
    }
  });
  
  // 初始化 IndexedDB（不阻塞）
  initIndexedDB().then(() => {
    console.log('[Background] IndexedDB 初始化成功');
  }).catch(error => {
    console.error('[Background] IndexedDB 初始化失败:', error);
  });

  // 创建右键菜单：添加到生词本（仅对选中文本）
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'vocab_add_selected_word',
        title: '添加到生词本',
        contexts: ['selection']
      });
    });
  } catch (e) {
    console.error('创建 contextMenus 失败:', e);
  }
});

// 启动时初始化 IndexedDB（确保 service worker 保持活跃）
initIndexedDB().then(() => {
  console.log('[Background] Service Worker 启动，IndexedDB 已就绪');
}).catch(error => {
  console.error('[Background] Service Worker 启动时 IndexedDB 初始化失败:', error);
});

// 保持 service worker 活跃
chrome.runtime.onStartup.addListener(() => {
  console.log('[Background] Extension startup');
});

// 监听右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'vocab_add_selected_word' && info.selectionText && tab && tab.id !== undefined) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'addSelectedWordToVocab',
      text: info.selectionText || ''
    });
  }
});
