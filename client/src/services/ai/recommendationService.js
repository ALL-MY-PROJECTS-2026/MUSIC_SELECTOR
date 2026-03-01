/**
 * 추천 서비스
 * AI 기반 음악 추천 메인 로직
 */

import embeddingService from './embeddingService';
import SimilarityCalculator from './similarityCalculator';

class RecommendationService {
  constructor(socket) {
    this.socket = socket;
  }

  /**
   * 상위 하트 음악 선택
   * @param {Array} queue - 대기열
   * @param {Object} musicLikes - 좋아요 데이터 { videoId: count }
   * @param {number} topN - 상위 N개
   * @returns {Array} 상위 하트 음악 배열
   */
  getTopLikedSongs(queue, musicLikes, topN = 10) {
    if (!queue || queue.length === 0) {
      return [];
    }

    // 좋아요 개수 기준으로 정렬
    const songsWithLikes = queue.map(music => ({
      ...music,
      likeCount: musicLikes[music.videoId] || 0,
    }));

    // 좋아요 개수 내림차순 정렬, 같으면 최신순
    songsWithLikes.sort((a, b) => {
      if (b.likeCount !== a.likeCount) {
        return b.likeCount - a.likeCount;
      }
      return (b.timestamp || 0) - (a.timestamp || 0);
    });

    // 상위 N개 선택
    return songsWithLikes.slice(0, Math.min(topN, songsWithLikes.length));
  }

  /**
   * 인기도 점수 계산 (검색 결과 순서 기반)
   * @param {number} index - 검색 결과 순위 (0부터 시작)
   * @returns {number} 인기도 점수 (0~1)
   */
  calculatePopularityByIndex(index) {
    if (index < 3) return 1.0;
    if (index < 5) return 0.9;
    if (index < 10) return 0.7;
    if (index < 20) return 0.5;
    return 0.3;
  }

  /**
   * 인기도 점수 계산 (YouTube Data API 조회수 기반)
   * @param {number} viewCount - 조회수
   * @param {string} publishedAt - 발행일 (ISO 문자열)
   * @param {number} maxViewCount - 최대 조회수 (정규화용)
   * @returns {number} 인기도 점수 (0~1)
   */
  calculatePopularityByViewCount(viewCount, publishedAt, maxViewCount = 100000000) {
    // 조회수 정규화 (로그 스케일)
    const normalizedViewCount = Math.log(viewCount + 1) / Math.log(maxViewCount + 1);

    // 최신도 계산
    let recencyScore = 0.5; // 기본값
    if (publishedAt) {
      const publishedDate = new Date(publishedAt);
      const now = new Date();
      const daysSincePublished = (now - publishedDate) / (1000 * 60 * 60 * 24);
      // 2년 이내면 높은 점수
      recencyScore = Math.max(0, 1 - daysSincePublished / (365 * 2));
    }

    // 조회수 점수 × 0.8 + 최신도 점수 × 0.2 (조회수에 더 높은 가중치)
    return normalizedViewCount * 0.8 + recencyScore * 0.2;
  }

  /**
   * 아티스트 일치 점수 계산
   * @param {string} artist1 - 첫 번째 아티스트
   * @param {string} artist2 - 두 번째 아티스트
   * @returns {number} 일치 점수 (0 또는 1)
   */
  calculateArtistMatch(artist1, artist2) {
    if (!artist1 || !artist2) return 0;
    
    // 간단한 문자열 비교 (대소문자 무시)
    const normalize = (str) => str.toLowerCase().trim();
    return normalize(artist1) === normalize(artist2) ? 1.0 : 0.0;
  }

  /**
   * 최종 점수 계산
   * @param {number} similarity - 텍스트 유사도 (0~1)
   * @param {number} artistMatch - 아티스트 일치 (0 또는 1)
   * @param {number} popularityScore - 인기도 점수 (0~1)
   * @param {number} diversityBonus - 다양성 보너스 (0~1, 기본값 0)
   * @returns {number} 최종 점수
   */
  calculateFinalScore(similarity, artistMatch, popularityScore, diversityBonus = 0, genreMatch = 0) {
    // 우선순위: 1. 아티스트 일치, 2. 인기도, 3. 텍스트 유사도, 4. 아티스트 다양성, 5. 장르 일치
    // 같은 가수의 인기 있는 다른 노래 추천 + 다른 가수의 유사한 노래도 추천
    return (
      artistMatch * 0.40 + // 1순위: 아티스트 일치 (45% → 40%) - 최우선
      popularityScore * 0.30 + // 2순위: 인기도 (30% 유지)
      similarity * 0.15 + // 3순위: 텍스트 유사도 (15% 유지)
      diversityBonus * 0.10 + // 4순위: 아티스트 다양성 (5% → 10%) - 증가
      genreMatch * 0.05 // 5순위: 장르 일치 (5% 유지)
    );
  }

  /**
   * 제목에서 장르 추출
   * @param {string} title - 제목
   * @returns {string|null} 장르 키워드
   */
  extractGenre(title) {
    if (!title) return null;

    const titleLower = title.toLowerCase();
    
    // 장르 키워드 패턴 (한국어 + 영어)
    const genrePatterns = {
      'k-pop': ['k-pop', 'kpop', '케이팝', '케이팝'],
      'pop': ['pop', '팝', '팝송'],
      'rock': ['rock', '록', '락', '로큰롤'],
      'hip-hop': ['hip-hop', 'hiphop', '힙합', '랩', 'rap'],
      'r&b': ['r&b', 'rnb', '알앤비', '소울', 'soul'],
      'jazz': ['jazz', '재즈'],
      'classical': ['classical', '클래식', '교향곡'],
      'electronic': ['electronic', '일렉트로닉', 'edm', '하우스', 'house', '트랜스', 'trance'],
      'ballad': ['ballad', '발라드'],
      'indie': ['indie', '인디'],
      'trot': ['trot', '트로트'],
      'country': ['country', '컨트리'],
      'reggae': ['reggae', '레게'],
      'metal': ['metal', '메탈'],
      'folk': ['folk', '포크'],
    };

    for (const [genre, keywords] of Object.entries(genrePatterns)) {
      for (const keyword of keywords) {
        if (titleLower.includes(keyword)) {
          return genre;
        }
      }
    }

    return null;
  }

  /**
   * 장르 일치 점수 계산
   * @param {string} genre1 - 첫 번째 장르
   * @param {string} genre2 - 두 번째 장르
   * @returns {number} 일치 점수 (0 또는 1)
   */
  calculateGenreMatch(genre1, genre2) {
    if (!genre1 || !genre2) return 0;
    
    const normalize = (str) => str.toLowerCase().trim();
    return normalize(genre1) === normalize(genre2) ? 1.0 : 0.0;
  }

  /**
   * 아티스트 추출 (제목에서)
   * @param {string} title - 제목
   * @returns {string|null} 아티스트 이름
   */
  extractArtist(title) {
    if (!title) return null;
    
    // 다양한 구분자로 아티스트 추출 시도
    const separators = [/[-–—]/, / by /i, / \| /, / \/ /];
    
    for (const sep of separators) {
      const parts = title.split(sep);
      if (parts.length > 1) {
        const artist = parts[parts.length - 1].trim();
        if (artist.length > 0 && artist.length < 50) { // 합리적인 길이
          return artist;
        }
      }
    }
    
    return null;
  }

  /**
   * 아티스트 다양성 보너스 계산
   * @param {string} currentArtist - 현재 추천 항목의 아티스트
   * @param {Array} previousArtists - 이전에 선택된 아티스트 배열
   * @returns {number} 다양성 보너스 (0~1)
   */
  calculateDiversityBonus(currentArtist, previousArtists) {
    if (!currentArtist || previousArtists.length === 0) {
      return 0.15; // 첫 번째 항목은 보너스 증가 (0.1 → 0.15)
    }

    // 이전에 선택된 아티스트와 다르면 보너스
    const isNewArtist = !previousArtists.some(prev => {
      const normalize = (str) => str.toLowerCase().trim();
      return normalize(prev) === normalize(currentArtist);
    });

    if (isNewArtist) {
      // 새로운 아티스트면 보너스 (이전 선택이 많을수록 더 큰 보너스)
      // 최대 보너스 증가: 0.2 → 0.35
      return Math.min(0.35, 0.1 + previousArtists.length * 0.02);
    } else {
      // 같은 아티스트면 패널티 (연속으로 나올수록 더 큰 패널티)
      // 패널티 강화: 최대 -0.1 → -0.2
      const consecutiveCount = previousArtists.filter(prev => {
        const normalize = (str) => str.toLowerCase().trim();
        return normalize(prev) === normalize(currentArtist);
      }).length;
      return -Math.min(0.2, 0.05 + consecutiveCount * 0.03);
    }
  }

  /**
   * 다양한 검색 쿼리 생성
   * @param {Array} topSongs - 상위 하트 음악 배열
   * @returns {Array<string>} 검색 쿼리 배열
   */
  generateDiverseSearchQueries(topSongs) {
    const queries = [];
    
    // 1. 제목 기반 검색 (기존 방식)
    const titleQuery = topSongs
      .slice(0, 3)
      .map(song => song.title)
      .join(' OR ');
    queries.push(titleQuery);

    // 2. 아티스트 기반 검색 (다양한 아티스트)
    const artists = topSongs
      .map(song => this.extractArtist(song.title))
      .filter(Boolean)
      .filter((artist, index, self) => self.indexOf(artist) === index) // 중복 제거
      .slice(0, 3);
    
    if (artists.length > 0) {
      // 아티스트 이름만으로 검색
      queries.push(artists.join(' OR '));
      
      // 아티스트 + "similar" 검색
      queries.push(`${artists[0]} similar music`);
    }

    // 3. 제목 키워드 추출 (특수문자 제거, 공통 단어 제외)
    const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
    const keywords = topSongs
      .flatMap(song => {
        const words = song.title
          .toLowerCase()
          .replace(/[^\w\s가-힣]/g, ' ')
          .split(/\s+/)
          .filter(word => word.length > 2 && !commonWords.has(word));
        return words;
      })
      .filter((word, index, self) => self.indexOf(word) === index) // 중복 제거
      .slice(0, 5);
    
    if (keywords.length > 0) {
      queries.push(keywords.join(' '));
    }

    // 4. 첫 번째 제목 + "similar" 검색
    if (topSongs.length > 0) {
      const firstTitle = topSongs[0].title.split(/[-–—]| by /i)[0].trim();
      queries.push(`${firstTitle} similar`);
    }

    return queries;
  }

  /**
   * 제목 정규화 (비교를 위해)
   * @param {string} title - 제목
   * @returns {string} 정규화된 제목
   */
  normalizeTitle(title) {
    if (!title) return '';
    return title
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ') // 여러 공백을 하나로
      .replace(/[^\w\s가-힣]/g, '') // 특수문자 제거 (한글, 영문, 숫자만 유지)
      .trim();
  }

  /**
   * 제목 문자열 유사도 계산 (간단한 방법)
   * @param {string} title1 - 첫 번째 제목
   * @param {string} title2 - 두 번째 제목
   * @returns {number} 유사도 (0~1)
   */
  calculateTitleSimilarity(title1, title2) {
    const normalized1 = this.normalizeTitle(title1);
    const normalized2 = this.normalizeTitle(title2);

    if (normalized1 === normalized2) return 1.0;
    if (normalized1.length === 0 || normalized2.length === 0) return 0.0;

    // 한 제목이 다른 제목을 포함하는지 확인
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
      const shorter = normalized1.length < normalized2.length ? normalized1 : normalized2;
      const longer = normalized1.length >= normalized2.length ? normalized1 : normalized2;
      return shorter.length / longer.length; // 포함 비율
    }

    // 공통 부분 계산 (간단한 방법)
    let commonChars = 0;
    const minLength = Math.min(normalized1.length, normalized2.length);
    for (let i = 0; i < minLength; i++) {
      if (normalized1[i] === normalized2[i]) {
        commonChars++;
      }
    }

    // Jaccard 유사도 (간단한 버전)
    const union = new Set([...normalized1, ...normalized2]);
    const intersection = new Set(
      [...normalized1].filter(char => normalized2.includes(char))
    );
    
    if (union.size === 0) return 0.0;
    return intersection.size / union.size;
  }

  /**
   * 제목 임베딩 기반 유사도 계산 (더 정확함)
   * @param {string} title1 - 첫 번째 제목
   * @param {string} title2 - 두 번째 제목
   * @returns {Promise<number>} 유사도 (0~1)
   */
  async calculateTitleSimilarityByEmbedding(title1, title2) {
    try {
      const embedding1 = await embeddingService.generateEmbedding(title1);
      const embedding2 = await embeddingService.generateEmbedding(title2);
      return SimilarityCalculator.cosineSimilarity(embedding1, embedding2);
    } catch (error) {
      console.error('[RecommendationService] 임베딩 기반 유사도 계산 실패:', error);
      // 폴백: 문자열 기반 유사도 사용
      return this.calculateTitleSimilarity(title1, title2);
    }
  }

  /**
   * 모음집/플레이리스트 필터링
   * @param {Object} music - 음악 객체
   * @returns {boolean} 모음집이면 true, 개별 노래면 false
   */
  isCompilation(music) {
    if (!music || !music.title) return false;

    const title = music.title.toLowerCase();
    
    // 모음집 키워드 패턴
    const compilationKeywords = [
      '모음', '베스트', 'best of', 'greatest hits', 'collection',
      'playlist', 'mix', 'compilation', 'album', 'full album',
      '전곡', '모든곡', '모든 곡', '전체', '모든', 'all songs',
      'hits', 'greatest', 'anthology', 'the best', 'top hits',
      'nonstop', '연속재생', '연속 재생', '연속듣기', '연속 듣기'
    ];

    // 제목에 모음집 키워드가 포함되어 있는지 확인
    for (const keyword of compilationKeywords) {
      if (title.includes(keyword)) {
        console.log(`[RecommendationService] 모음집으로 판단: "${music.title}" (키워드: ${keyword})`);
        return true;
      }
    }

    // 재생 시간이 10분 이상이면 모음집 가능성 높음
    if (music.duration) {
      const durationStr = music.duration;
      const parts = durationStr.split(':');
      if (parts.length >= 2) {
        let minutes = 0;
        if (parts.length === 3) {
          // HH:MM:SS 형식
          minutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        } else if (parts.length === 2) {
          // MM:SS 형식
          minutes = parseInt(parts[0], 10);
        }
        if (minutes >= 10) {
          console.log(`[RecommendationService] 긴 재생시간으로 모음집 가능성: "${music.title}" (${durationStr})`);
          return true;
        }
      }
    }

    // 제목이 과도하게 긴 경우 (특수문자/구분자 다수)
    const specialCharCount = (music.title.match(/[-–—|/]/g) || []).length;
    if (specialCharCount >= 3) {
      console.log(`[RecommendationService] 과도한 특수문자로 모음집 가능성: "${music.title}"`);
      return true;
    }

    return false;
  }

  /**
   * 중복 제거 (대기열에 이미 있는 음악 및 유사한 제목 제외)
   * @param {Array} recommendations - 추천 결과
   * @param {Array} queue - 현재 대기열
   * @param {number} titleSimilarityThreshold - 제목 유사도 임계값 (기본 0.85)
   * @returns {Promise<Array>} 중복 제거된 추천 결과
   */
  async filterDuplicates(recommendations, queue, titleSimilarityThreshold = 0.85) {
    if (!recommendations || recommendations.length === 0) {
      return [];
    }

    const queueVideoIds = new Set(queue.map(music => music.videoId));
    const queueTitles = queue.map(music => music.title);
    
    // 대기열 제목들의 임베딩 생성 (한 번만, 배치 처리)
    const queueTitleEmbeddings = await embeddingService.generateEmbeddings(queueTitles);

    // 추천 결과 제목들의 임베딩 생성 (배치 처리로 성능 최적화)
    const recTitles = recommendations.map(rec => rec.title);
    const recEmbeddings = await embeddingService.generateEmbeddings(recTitles);

    const filtered = [];

    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      const recEmbedding = recEmbeddings[i];

      // 1. videoId 중복 확인
      if (queueVideoIds.has(rec.videoId)) {
        continue; // videoId가 같으면 제외
      }

      // 2. 제목 유사도 확인
      let isDuplicate = false;
      
      // 빠른 문자열 기반 유사도 확인 (먼저 체크)
      for (const queueTitle of queueTitles) {
        const stringSimilarity = this.calculateTitleSimilarity(rec.title, queueTitle);
        if (stringSimilarity >= 0.90) {
          // 문자열 유사도가 매우 높으면 (90% 이상) 제외 (95% → 90%로 강화)
          isDuplicate = true;
          console.log(`[RecommendationService] 유사한 제목 제외 (문자열): "${rec.title}" vs "${queueTitle}" (유사도: ${(stringSimilarity * 100).toFixed(1)}%)`);
          break;
        }
      }

      // 3. 문자열 유사도가 높지 않으면 임베딩 기반 유사도 확인
      if (!isDuplicate) {
        for (let j = 0; j < queueTitleEmbeddings.length; j++) {
          const similarity = SimilarityCalculator.cosineSimilarity(
            recEmbedding,
            queueTitleEmbeddings[j]
          );
          
          if (similarity >= titleSimilarityThreshold) {
            // 임베딩 유사도가 임계값 이상이면 제외
            isDuplicate = true;
            console.log(`[RecommendationService] 유사한 제목 제외 (임베딩): "${rec.title}" vs "${queueTitles[j]}" (유사도: ${(similarity * 100).toFixed(1)}%)`);
            break;
          }
        }
      }

      if (!isDuplicate) {
        filtered.push(rec);
      }
    }

    console.log(`[RecommendationService] 중복 제거: ${recommendations.length}개 → ${filtered.length}개`);
    return filtered;
  }

  /**
   * YouTube 검색 실행 (서버에 요청)
   * @param {string} query - 검색어
   * @param {number} maxResults - 최대 결과 수
   * @returns {Promise<Array>} 검색 결과
   */
  async searchYouTube(query, maxResults = 50) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket 연결이 필요합니다'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('YouTube 검색 타임아웃'));
      }, 30000); // 30초 타임아웃

      this.socket.emit('searchMusic', { query });
      
      this.socket.once('searchResults', (data) => {
        clearTimeout(timeout);
        if (data.results && data.results.length > 0) {
          resolve(data.results.slice(0, maxResults));
        } else {
          resolve([]);
        }
      });

      this.socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(error.message || 'YouTube 검색 실패'));
      });
    });
  }

  /**
   * 추천 생성 (메인 메서드)
   * @param {Array} queue - 현재 대기열
   * @param {Object} musicLikes - 좋아요 데이터 { videoId: count }
   * @param {string} searchQuery - 선택적 검색어
   * @returns {Promise<Object>} 추천 결과
   */
  async generateRecommendations(queue, musicLikes, searchQuery = null) {
    const startTime = Date.now();

    try {
      // 1. 상위 하트 음악 선택
      const topSongs = this.getTopLikedSongs(queue, musicLikes, 10);
      
      if (topSongs.length === 0) {
        return {
          recommendations: [],
          topSongs: [],
          reasoning: '대기열에 음악이 없습니다.',
          processingTime: Date.now() - startTime,
        };
      }

      // 2. 각 음악 제목 임베딩 생성
      const titles = topSongs.map(song => song.title);
      const embeddings = await embeddingService.generateEmbeddings(titles);

      // 3. 가중 평균 임베딩 계산
      const weights = topSongs.map(song => song.likeCount || 0.1); // 0인 경우 0.1로 설정
      const weightedEmbedding = SimilarityCalculator.calculateWeightedAverage(
        embeddings,
        weights
      );

      // 4. YouTube 검색 실행 (다양한 검색 쿼리 사용)
      let searchResults = [];
      
      if (searchQuery) {
        // 사용자 지정 검색어가 있으면 그것만 사용
        searchResults = await this.searchYouTube(searchQuery, 50);
      } else {
        // 다양한 검색 쿼리 생성 및 병합
        const searchQueries = this.generateDiverseSearchQueries(topSongs);
        console.log('[RecommendationService] 생성된 검색 쿼리:', searchQueries);
        
        // 여러 검색 쿼리로 검색 결과 수집
        const allSearchResults = [];
        for (const query of searchQueries.slice(0, 3)) { // 최대 3개 쿼리만 사용
          try {
            const results = await this.searchYouTube(query, 30);
            allSearchResults.push(...results);
          } catch (error) {
            console.warn(`[RecommendationService] 검색 쿼리 실패: ${query}`, error);
          }
        }
        
        // videoId 기준으로 중복 제거
        const uniqueResultsMap = new Map();
        for (const result of allSearchResults) {
          if (!uniqueResultsMap.has(result.videoId)) {
            uniqueResultsMap.set(result.videoId, result);
          }
        }
        
        searchResults = Array.from(uniqueResultsMap.values());
        console.log(`[RecommendationService] 병합된 검색 결과: ${searchResults.length}개`);
      }

      // 모음집/플레이리스트 필터링
      const filteredSearchResults = searchResults.filter(result => !this.isCompilation(result));
      const compilationCount = searchResults.length - filteredSearchResults.length;
      if (compilationCount > 0) {
        console.log(`[RecommendationService] 모음집 제외: ${compilationCount}개`);
      }
      searchResults = filteredSearchResults;

      if (searchResults.length === 0) {
        return {
          recommendations: [],
          topSongs,
          reasoning: '검색 결과가 없습니다.',
          processingTime: Date.now() - startTime,
        };
      }

      // 5. 검색 결과 임베딩 생성
      const searchTitles = searchResults.map(result => result.title);
      const searchEmbeddings = await embeddingService.generateEmbeddings(searchTitles);

      // 6. 유사도 계산
      const similarities = SimilarityCalculator.calculateSimilarityScores(
        weightedEmbedding,
        searchEmbeddings
      );

      // 7. 인기도 점수 계산 (검색 결과 순서 기반)
      const popularityScores = searchResults.map((result, index) =>
        this.calculatePopularityByIndex(index)
      );

      // 8. 아티스트 일치 점수 계산 및 추출
      const topSongArtists = topSongs
        .map(song => this.extractArtist(song.title))
        .filter(Boolean);
      
      const artistMatches = searchResults.map((result) => {
        const resultArtist = this.extractArtist(result.title);
        
        if (!resultArtist || topSongArtists.length === 0) {
          return 0;
        }

        // 아티스트 일치 확인
        const match = topSongArtists.some(artist =>
          this.calculateArtistMatch(artist, resultArtist) > 0
        );

        return match ? 1.0 : 0.0;
      });

      // 8-1. 장르 일치 점수 계산
      const topSongGenres = topSongs
        .map(song => this.extractGenre(song.title))
        .filter(Boolean);
      
      const genreMatches = searchResults.map((result) => {
        const resultGenre = this.extractGenre(result.title);
        
        if (!resultGenre || topSongGenres.length === 0) {
          return 0;
        }

        // 장르 일치 확인
        const match = topSongGenres.some(genre =>
          this.calculateGenreMatch(genre, resultGenre) > 0
        );

        return match ? 1.0 : 0.0;
      });
      
      // 아티스트 및 장르 정보를 결과에 저장 (다양성 계산용)
      const searchResultsWithArtists = searchResults.map((result, index) => ({
        ...result,
        extractedArtist: this.extractArtist(result.title),
        extractedGenre: this.extractGenre(result.title),
        artistMatch: artistMatches[index],
        genreMatch: genreMatches[index],
      }));

      // 9. 최종 점수 계산 (다양성 보너스 포함)
      const scoredResults = [];
      const selectedArtists = []; // 다양성 계산을 위한 선택된 아티스트 추적
      
      // 먼저 점수 계산 (다양성 보너스 없이)
      const initialScoredResults = searchResultsWithArtists.map((result, index) => ({
        ...result,
        similarity: similarities[index],
        popularityScore: popularityScores[index],
        initialScore: this.calculateFinalScore(
          similarities[index],
          result.artistMatch,
          popularityScores[index],
          0, // 다양성 보너스는 나중에 추가
          result.genreMatch // 장르 일치 점수 포함
        ),
      }));
      
      // 점수 기준으로 정렬 (다양성 보너스 적용 전)
      initialScoredResults.sort((a, b) => b.initialScore - a.initialScore);
      
      // 다양성 보너스를 적용하여 최종 점수 계산
      for (const result of initialScoredResults) {
        const diversityBonus = this.calculateDiversityBonus(
          result.extractedArtist,
          selectedArtists
        );
        
        // 최종 점수 = initialScore + (diversityBonus * 가중치 0.10)
        const finalScore = result.initialScore + (diversityBonus * 0.10);
        
        scoredResults.push({
          ...result,
          diversityBonus,
          finalScore,
        });
        
        // 선택된 아티스트 추적 (최대 10개만 유지)
        if (result.extractedArtist) {
          selectedArtists.push(result.extractedArtist);
          if (selectedArtists.length > 10) {
            selectedArtists.shift();
          }
        }
      }

      // 10. 최종 점수 기준으로 다시 정렬
      scoredResults.sort((a, b) => b.finalScore - a.finalScore);

      // 11. 중복 제거 (videoId + 제목 유사도 확인, 임계값 강화: 0.9 → 0.85)
      const uniqueResults = await this.filterDuplicates(scoredResults, queue, 0.85);

      // 12. 상위 20개 선택
      const recommendations = uniqueResults.slice(0, 20);

      // 13. 추천 이유 생성
      const topSongTitles = topSongs.slice(0, 3).map(song => song.title);
      const reasoning = `인기 음악 기반 추천: ${topSongTitles.join(', ')} 등 ${topSongs.length}개 음악 분석`;

      return {
        recommendations,
        topSongs,
        reasoning,
        processingTime: Date.now() - startTime,
      };
    } catch (error) {
      console.error('[RecommendationService] 추천 생성 실패:', error);
      throw new Error(`추천 생성 실패: ${error.message}`);
    }
  }
}

export default RecommendationService;
