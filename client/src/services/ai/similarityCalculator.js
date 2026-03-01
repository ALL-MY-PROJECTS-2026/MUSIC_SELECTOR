/**
 * 유사도 계산 서비스
 * 벡터 간 유사도를 계산하는 순수 함수 유틸리티
 */

class SimilarityCalculator {
  /**
   * 코사인 유사도 계산
   * @param {Float32Array|number[]} vec1 - 첫 번째 벡터
   * @param {Float32Array|number[]} vec2 - 두 번째 벡터
   * @returns {number} 코사인 유사도 (0~1)
   */
  static cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2) {
      throw new Error('두 벡터가 필요합니다');
    }

    if (vec1.length !== vec2.length) {
      throw new Error('벡터의 차원이 일치해야 합니다');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    if (norm1 === 0 || norm2 === 0) {
      return 0;
    }

    return dotProduct / (norm1 * norm2);
  }

  /**
   * 가중 평균 임베딩 계산
   * @param {Float32Array[]} embeddings - 임베딩 배열
   * @param {number[]} weights - 가중치 배열
   * @returns {Float32Array} 가중 평균 임베딩
   */
  static calculateWeightedAverage(embeddings, weights) {
    if (!embeddings || embeddings.length === 0) {
      throw new Error('임베딩 배열이 필요합니다');
    }

    if (!weights || weights.length !== embeddings.length) {
      throw new Error('가중치 배열의 길이가 임베딩 배열과 일치해야 합니다');
    }

    const dimension = embeddings[0].length;
    const weightedSum = new Float32Array(dimension);
    let totalWeight = 0;

    // 가중 합 계산
    for (let i = 0; i < embeddings.length; i++) {
      const embedding = embeddings[i];
      const weight = weights[i];

      if (embedding.length !== dimension) {
        throw new Error('모든 임베딩의 차원이 일치해야 합니다');
      }

      for (let j = 0; j < dimension; j++) {
        weightedSum[j] += embedding[j] * weight;
      }

      totalWeight += weight;
    }

    // 가중 평균 계산
    if (totalWeight === 0) {
      throw new Error('총 가중치가 0이 될 수 없습니다');
    }

    const weightedAverage = new Float32Array(dimension);
    for (let i = 0; i < dimension; i++) {
      weightedAverage[i] = weightedSum[i] / totalWeight;
    }

    return weightedAverage;
  }

  /**
   * 타겟 임베딩과 여러 후보 임베딩의 유사도 계산
   * @param {Float32Array} targetEmbedding - 타겟 임베딩
   * @param {Float32Array[]} candidateEmbeddings - 후보 임베딩 배열
   * @returns {number[]} 유사도 점수 배열
   */
  static calculateSimilarityScores(targetEmbedding, candidateEmbeddings) {
    if (!targetEmbedding) {
      throw new Error('타겟 임베딩이 필요합니다');
    }

    if (!candidateEmbeddings || candidateEmbeddings.length === 0) {
      return [];
    }

    return candidateEmbeddings.map(candidate => 
      this.cosineSimilarity(targetEmbedding, candidate)
    );
  }

  /**
   * 유클리드 거리 계산
   * @param {Float32Array|number[]} vec1 - 첫 번째 벡터
   * @param {Float32Array|number[]} vec2 - 두 번째 벡터
   * @returns {number} 유클리드 거리
   */
  static euclideanDistance(vec1, vec2) {
    if (!vec1 || !vec2) {
      throw new Error('두 벡터가 필요합니다');
    }

    if (vec1.length !== vec2.length) {
      throw new Error('벡터의 차원이 일치해야 합니다');
    }

    let sum = 0;
    for (let i = 0; i < vec1.length; i++) {
      const diff = vec1[i] - vec2[i];
      sum += diff * diff;
    }

    return Math.sqrt(sum);
  }
}

export default SimilarityCalculator;
