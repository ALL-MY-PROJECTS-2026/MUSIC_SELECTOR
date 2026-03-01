/**
 * 임베딩 서비스
 * 텍스트를 임베딩 벡터로 변환하는 서비스
 */

import modelLoader from './modelLoader';

class EmbeddingService {
  constructor() {
    this.embeddingCache = new Map(); // 메모리 캐시
  }

  /**
   * 단일 텍스트 임베딩 생성
   * @param {string} text - 임베딩할 텍스트
   * @returns {Promise<Float32Array>} 임베딩 벡터
   */
  async generateEmbedding(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('유효한 텍스트가 필요합니다');
    }

    // 캐시 확인
    if (this.embeddingCache.has(text)) {
      return this.embeddingCache.get(text);
    }

    // 모델 로드
    const model = await modelLoader.loadModel();

    try {
      // 임베딩 생성
      const output = await model(text, {
        pooling: 'mean',
        normalize: true,
      });

      // Float32Array로 변환
      const embedding = output.data;

      // 캐시에 저장
      this.embeddingCache.set(text, embedding);

      return embedding;
    } catch (error) {
      console.error('[EmbeddingService] 임베딩 생성 실패:', error);
      throw new Error(`임베딩 생성 실패: ${error.message}`);
    }
  }

  /**
   * 여러 텍스트의 임베딩 생성 (배치)
   * @param {string[]} texts - 임베딩할 텍스트 배열
   * @returns {Promise<Float32Array[]>} 임베딩 벡터 배열
   */
  async generateEmbeddings(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('유효한 텍스트 배열이 필요합니다');
    }

    // 모델 로드
    const model = await modelLoader.loadModel();

    try {
      // 배치 처리
      const promises = texts.map(text => this.generateEmbedding(text));
      const embeddings = await Promise.all(promises);

      return embeddings;
    } catch (error) {
      console.error('[EmbeddingService] 배치 임베딩 생성 실패:', error);
      throw new Error(`배치 임베딩 생성 실패: ${error.message}`);
    }
  }

  /**
   * 캐시 초기화
   */
  clearCache() {
    this.embeddingCache.clear();
  }

  /**
   * 캐시 크기 확인
   * @returns {number} 캐시된 임베딩 개수
   */
  getCacheSize() {
    return this.embeddingCache.size;
  }
}

// 싱글톤 인스턴스
const embeddingService = new EmbeddingService();

export default embeddingService;
