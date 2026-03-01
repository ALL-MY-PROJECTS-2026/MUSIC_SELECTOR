/**
 * 모델 로더 서비스
 * ML 모델을 로드하고 IndexedDB에 캐싱하는 싱글톤 서비스
 */

import { pipeline, env } from '@xenova/transformers';

// Transformers.js 환경 설정
// 브라우저에서 실행 시 필요한 설정
env.allowLocalModels = false;
env.allowRemoteModels = true;

// 브라우저 환경 확인
const isBrowser = typeof window !== 'undefined' && 'indexedDB' in window;

if (isBrowser) {
  // 브라우저 환경: Transformers.js가 자동으로 IndexedDB를 사용합니다
  // env.useBrowserCache는 기본값을 사용 (명시적으로 설정하지 않음)
  console.log('[ModelLoader] 브라우저 환경 감지됨. IndexedDB 캐시를 사용합니다.');
} else {
  // 서버 사이드 렌더링 등
  console.warn('[ModelLoader] 브라우저 환경이 아닙니다. 메모리 캐시를 사용합니다.');
  env.useBrowserCache = false;
  env.useCustomCache = false;
}

const MODEL_NAME = 'Xenova/multilingual-e5-small';

class ModelLoader {
  constructor() {
    this.model = null;
    this.loadingPromise = null;
  }

  /**
   * 모델 로드 (캐시 확인)
   * @returns {Promise<Object>} 모델 인스턴스
   */
  async loadModel() {
    // 이미 로드 중이면 기다림
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    // 이미 로드되어 있으면 반환
    if (this.model) {
      return this.model;
    }

    // 로딩 시작
    this.loadingPromise = this._loadModelInternal();
    
    try {
      this.model = await this.loadingPromise;
      return this.model;
    } finally {
      this.loadingPromise = null;
    }
  }

  /**
   * 내부 모델 로드 로직
   * @private
   */
  async _loadModelInternal() {
    try {
      console.log('[ModelLoader] 모델 로드 시작:', MODEL_NAME);
      console.log('[ModelLoader] Transformers.js 환경:', {
        allowLocalModels: env.allowLocalModels,
        allowRemoteModels: env.allowRemoteModels,
        useBrowserCache: env.useBrowserCache,
      });
      
      // Transformers.js는 자동으로 브라우저 캐시를 사용합니다
      // IndexedDB에 자동으로 캐싱됩니다
      this.model = await pipeline(
        'feature-extraction',
        MODEL_NAME,
        {
          // 기본 설정 사용
          quantized: true, // 양자화된 모델 사용 (더 작고 빠름)
          // 모델 다운로드 진행 상황 표시
          progress_callback: (progress) => {
            if (progress.status === 'downloading') {
              console.log(`[ModelLoader] 다운로드 진행: ${progress.file || '모델 파일'}`);
            }
          },
          // 캐시 디렉토리 명시 (브라우저에서는 자동으로 IndexedDB 사용)
          // cache_dir 옵션을 명시하지 않으면 자동으로 브라우저 캐시 사용
        }
      );
      
      console.log('[ModelLoader] 모델 로드 완료');
      return this.model;
    } catch (error) {
      console.error('[ModelLoader] 모델 로드 실패:', error);
      console.error('[ModelLoader] 에러 상세:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      
      // 더 자세한 에러 정보
      if (error.message && (error.message.includes('<!DOCTYPE') || error.message.includes('JSON'))) {
        const detailedError = new Error(
          '모델 다운로드 실패: 네트워크 문제 또는 CORS 오류가 발생했습니다.\n' +
          '해결 방법:\n' +
          '1. 브라우저 콘솔에서 CORS 오류를 확인하세요\n' +
          '2. 네트워크 연결을 확인하세요\n' +
          '3. 잠시 후 다시 시도해주세요\n' +
          '4. 개발자 도구 > Application > Storage에서 캐시를 삭제하고 다시 시도하세요'
        );
        detailedError.originalError = error;
        throw detailedError;
      }
      
      // 네트워크 오류
      if (error.message && (error.message.includes('fetch') || error.message.includes('network'))) {
        throw new Error(`모델 다운로드 실패: 네트워크 연결 문제입니다. 인터넷 연결을 확인하세요. (${error.message})`);
      }
      
      throw new Error(`모델 로드 실패: ${error.message}`);
    }
  }

  /**
   * 모델 인스턴스 반환
   * @returns {Object|null} 모델 인스턴스
   */
  getModel() {
    return this.model;
  }

  /**
   * 모델이 로드되었는지 확인
   * @returns {boolean}
   */
  isLoaded() {
    return this.model !== null;
  }

  /**
   * 모델 리셋 (테스트용)
   */
  reset() {
    this.model = null;
    this.loadingPromise = null;
  }
}

// 싱글톤 인스턴스
const modelLoader = new ModelLoader();

export default modelLoader;
