/**
 * IndexedDB 유틸리티
 * AI 모델 및 캐시 데이터를 IndexedDB에 저장/로드하는 유틸리티
 */

const DB_NAME = 'MusicSelectorAI';
const DB_VERSION = 1;
const STORE_MODELS = 'models';
const STORE_CACHE = 'cache';

let dbInstance = null;

/**
 * IndexedDB 초기화
 */
export async function initDB() {
  if (dbInstance) {
    return dbInstance;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('IndexedDB 초기화 실패'));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // 모델 저장소 생성
      if (!db.objectStoreNames.contains(STORE_MODELS)) {
        db.createObjectStore(STORE_MODELS);
      }

      // 캐시 저장소 생성
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        const cacheStore = db.createObjectStore(STORE_CACHE);
        cacheStore.createIndex('expiresAt', 'expiresAt', { unique: false });
      }
    };
  });
}

/**
 * 모델 저장
 * @param {string} modelName - 모델 이름
 * @param {ArrayBuffer} modelData - 모델 데이터
 */
export async function saveModel(modelName, modelData) {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_MODELS], 'readwrite');
    const store = transaction.objectStore(STORE_MODELS);
    const request = store.put(modelData, modelName);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('모델 저장 실패'));
  });
}

/**
 * 모델 로드
 * @param {string} modelName - 모델 이름
 * @returns {Promise<ArrayBuffer|null>} 모델 데이터
 */
export async function loadModel(modelName) {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_MODELS], 'readonly');
    const store = transaction.objectStore(STORE_MODELS);
    const request = store.get(modelName);

    request.onsuccess = () => {
      resolve(request.result || null);
    };
    request.onerror = () => reject(new Error('모델 로드 실패'));
  });
}

/**
 * 모델 삭제
 * @param {string} modelName - 모델 이름
 */
export async function deleteModel(modelName) {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_MODELS], 'readwrite');
    const store = transaction.objectStore(STORE_MODELS);
    const request = store.delete(modelName);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('모델 삭제 실패'));
  });
}

/**
 * 캐시 저장
 * @param {string} key - 캐시 키
 * @param {any} data - 캐시 데이터
 * @param {number} ttl - TTL (밀리초)
 */
export async function saveCache(key, data, ttl = 5 * 60 * 1000) {
  const db = await initDB();
  const expiresAt = Date.now() + ttl;
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_CACHE], 'readwrite');
    const store = transaction.objectStore(STORE_CACHE);
    const request = store.put({ data, expiresAt }, key);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('캐시 저장 실패'));
  });
}

/**
 * 캐시 로드
 * @param {string} key - 캐시 키
 * @returns {Promise<any|null>} 캐시 데이터 (만료되었으면 null)
 */
export async function getCache(key) {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_CACHE], 'readonly');
    const store = transaction.objectStore(STORE_CACHE);
    const request = store.get(key);

    request.onsuccess = () => {
      const result = request.result;
      if (!result) {
        resolve(null);
        return;
      }

      // 만료 확인
      if (result.expiresAt < Date.now()) {
        // 만료된 캐시 삭제
        deleteCache(key);
        resolve(null);
        return;
      }

      resolve(result.data);
    };
    request.onerror = () => reject(new Error('캐시 로드 실패'));
  });
}

/**
 * 캐시 삭제
 * @param {string} key - 캐시 키
 */
export async function deleteCache(key) {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_CACHE], 'readwrite');
    const store = transaction.objectStore(STORE_CACHE);
    const request = store.delete(key);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('캐시 삭제 실패'));
  });
}

/**
 * 만료된 캐시 정리
 */
export async function clearExpiredCache() {
  const db = await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_CACHE], 'readwrite');
    const store = transaction.objectStore(STORE_CACHE);
    const index = store.index('expiresAt');
    const range = IDBKeyRange.upperBound(Date.now());
    const request = index.openCursor(range);

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => reject(new Error('만료된 캐시 정리 실패'));
  });
}
