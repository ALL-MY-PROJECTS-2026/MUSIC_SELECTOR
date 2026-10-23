/**
 * 추천 서비스
 * AI 기반 음악 추천 메인 로직
 */

import embeddingService from './embeddingService';
import SimilarityCalculator from './similarityCalculator';

// 임베딩 제목 중복 판단 기준: multilingual-e5는 서로 다른 노래 제목끼리도 0.8~0.9가 나와서
// 0.85로는 대부분의 후보가 중복으로 제외됨 (예: "Blueming" vs "좋은 날" 0.87). 다른 버전은 문자열 비교가 따로 걸러냄
const EMBEDDING_DUPLICATE_THRESHOLD = 0.95;

// 같은 가수 곡이 연달아 추천되지 않도록, 가수당 이 개수를 넘는 곡부터 곡마다 점수에 ARTIST_REPEAT_DECAY를 곱함
const MAX_PER_ARTIST_IN_TOP = 3;
const ARTIST_REPEAT_DECAY = 0.85;

// 자주 쓰이는 가수의 한글·영문 표기 (정규화된 이름끼리 연결)
const ARTIST_ALIAS_PAIRS = [
  ['아이유', 'iu'], ['방탄소년단', 'bts'], ['뉴진스', 'newjeans'], ['트와이스', 'twice'], ['블랙핑크', 'blackpink'],
  ['세븐틴', 'seventeen'], ['르세라핌', 'lesserafim'], ['아이브', 'ive'], ['에스파', 'aespa'], ['빅뱅', 'bigbang'],
  ['악뮤', 'akmu'], ['악동뮤지션', 'akmu'], ['볼빨간사춘기', 'bol4'], ['임영웅', 'limyoungwoong'], ['이무진', 'leemujin'],
  ['정키', 'jungkey'], ['요아소비', 'yoasobi'], ['테일러스위프트', 'taylorswift'], ['에드시런', 'edsheeran'],
  ['브루노마스', 'brunomars'], ['아델', 'adele'], ['이매진드래곤스', 'imaginedragons'], ['마이클잭슨', 'michaeljackson'], ['퀸', 'queen'],
];
const ARTIST_ALIASES = ARTIST_ALIAS_PAIRS.reduce((map, [a, b]) => {
  map[a] = b;
  map[b] = a;
  return map;
}, {});

const normalizeName = (name) => name.toLowerCase().replace(/[\s.\-_'’·]/g, '');

// "TWICE (트와이스)" → {twice, 트와이스}, "IU" → {iu, 아이유}
function getArtistNames(artist) {
  const names = new Set();
  names.add(normalizeName(artist.replace(/[([（][^)\]）]*[)\]）]/g, ' ')));
  (artist.match(/[([（][^)\]）]+[)\]）]/g) || []).forEach((part) => names.add(normalizeName(part.slice(1, -1))));
  [...names].forEach((name) => {
    if (ARTIST_ALIASES[name]) names.add(ARTIST_ALIASES[name]);
  });
  names.delete('');
  return names;
}

// 키워드가 단어로 들어 있는지 확인 (영문은 단어 경계, 한글은 standalone=true일 때 앞뒤가 공백·괄호인 경우만)
function hasKeyword(text, keyword, standalone = false) {
  const escaped = keyword.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&');
  if (/^[a-z0-9&\- ]+$/.test(keyword)) {
    return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)').test(text);
  }
  if (standalone) {
    return new RegExp('(^|[\\s\\[\\]()【】#,/])' + escaped + '($|[\\s\\[\\]()【】#,/])').test(text);
  }
  return text.includes(keyword);
}

class RecommendationService {
  constructor(socket) {
    this.socket = socket;
  }

  /**
   * 상위 하트 음악 선택 (하트가 없으면 대기열 순서 기준)
   * @param {Array} queue - 대기열
   * @param {Object} musicLikes - 좋아요 데이터 { videoId: count }
   * @param {number} topN - 상위 N개
   * @returns {Array} 상위 하트 음악 배열 (하트가 없으면 대기열 순서 기준)
   */
  getTopLikedSongs(queue, musicLikes, topN = 10) {
    if (!queue || queue.length === 0) {
      return [];
    }

    // 좋아요 개수 기준으로 정렬
    const songsWithLikes = queue.map((music, index) => ({
      ...music,
      likeCount: musicLikes[music.videoId] || 0,
      queueIndex: index, // 대기열 순서 저장
    }));

    // 전체 좋아요 개수 확인
    const totalLikes = songsWithLikes.reduce((sum, song) => sum + song.likeCount, 0);
    const hasLikes = totalLikes > 0;

    if (hasLikes) {
      // 하트가 있는 경우: 좋아요 개수 기준으로 정렬
      songsWithLikes.sort((a, b) => {
        if (b.likeCount !== a.likeCount) {
          return b.likeCount - a.likeCount;
        }
        return (b.timestamp || 0) - (a.timestamp || 0);
      });
    } else {
      // 하트가 없는 경우: 대기열 순서 기준으로 정렬 (앞에 있는 곡 우선)
      songsWithLikes.sort((a, b) => {
        return a.queueIndex - b.queueIndex;
      });
      console.log('[RecommendationService] 하트가 없어 대기열 순서 기준으로 추천합니다.');
    }

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

    // 조회수 점수 × 0.9 + 최신도 점수 × 0.1 (조회수에 더 높은 가중치 강화)
    return normalizedViewCount * 0.9 + recencyScore * 0.1;
  }

  /**
   * 아티스트 일치 점수 계산 (유사도 포함)
   * @param {string} artist1 - 첫 번째 아티스트
   * @param {string} artist2 - 두 번째 아티스트
   * @returns {number} 일치 점수 (0~1, 1.0=완전 일치, 0.8 이상=유사)
   */
  calculateArtistMatch(artist1, artist2) {
    if (!artist1 || !artist2) return 0;
    const names1 = getArtistNames(artist1);
    const names2 = getArtistNames(artist2);

    // 본명·괄호 안 다른 표기·별칭 중 하나라도 같으면 같은 가수
    for (const name of names1) {
      if (names2.has(name)) return 1.0;
    }

    // 띄어쓰기·표기 차이 수준만 유사로 인정 (짧은 이름이 긴 이름의 앞부분이고 길이 80% 이상)
    // 글자 구성만 비교하던 방식은 "아이유"와 "유아이"처럼 다른 가수를 같다고 판단해서 사용하지 않음
    for (const a of names1) {
      for (const b of names2) {
        const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
        if (shorter.length >= 3 && longer.startsWith(shorter) && shorter.length / longer.length >= 0.8) {
          return 0.8;
        }
      }
    }
    return 0.0;
  }

  /**
   * 최종 점수 계산
   * @param {number} similarity - 텍스트 유사도 (0~1)
   * @param {number} artistMatch - 아티스트 일치 (0 또는 1)
   * @param {number} popularityScore - 인기도 점수 (0~1)
   * @param {number} diversityBonus - 다양성 보너스 (0~1, 기본값 0)
   * @param {number} genreMatch - 장르 일치 (0 또는 1, 기본값 0)
   * @param {string} musicRegion - 음악 지역 기준 ('all', 'domestic', 'international')
   * @returns {number} 최종 점수
   */
  /**
   * 음질 보너스 계산 (스튜디오 버전, 공식 버전 등 우선)
   * @param {string} title - 제목
   * @returns {number} 음질 보너스 (0~1)
   */
  calculateQualityBonus(title) {
    if (!title) return 0;
    const titleLower = title.toLowerCase();

    // 음질 좋은 버전 키워드 (높은 점수)
    const highQualityKeywords = [
      'studio', 'studio version', 'studio recording', '스튜디오',
      'official', 'official audio', 'official video', '공식',
      'original', 'original version', 'original recording', '오리지널', '원곡',
      'album version', 'album track', '앨범 버전',
      'cd version', 'cd quality', 'hq', 'high quality', 'hq audio', '고음질', '고품질',
      'mastered', 'remastered', '마스터링',
    ];

    // 음질 낮은 버전 키워드 (점수 감소) - "Official Live"처럼 함께 있으면 낮은 쪽을 우선
    const lowQualityKeywords = [
      'live', 'concert', 'performance', 'stage', 'fancam', 'fan cam',
      'competition', 'contest', 'audition', 'phone recording', 'audience recording',
      '라이브', '공연', '무대', '콘서트', '직캠', '팬캠', '대회', '경연', '오디션', '열창',
      // 방송 출연 영상 (음원이 아닌 방송 클립)
      'tvpp', '인기가요', '뮤직뱅크', '음악중심', '엠카운트다운', '쇼챔피언', '불후의 명곡', '복면가왕',
      '스케치북', '열린음악회', '미스터트롯', '미스트롯', '사랑의콜센타', '사랑의 콜센타',
    ];

    if (lowQualityKeywords.some((keyword) => hasKeyword(titleLower, keyword))) {
      return 0.0;
    }
    if (highQualityKeywords.some((keyword) => hasKeyword(titleLower, keyword))) {
      return 1.0;
    }
    // 키워드가 없으면 기본값 (0.5 - 중간 점수)
    return 0.5;
  }

  calculateFinalScore(similarity, artistMatch, popularityScore, diversityBonus = 0, genreMatch = 0, musicRegion = 'all', qualityBonus = 0, channelPriority = 0.5) {
    // 같은 가수 비중을 낮추고(60% → 35%) AI 임베딩 유사도를 높임(1~4% → 25~30%)
    // 아티스트 다양성은 추천 목록을 고를 때 별도로 반영 (generateRecommendations의 diversityWeight)
    if (musicRegion === 'domestic') {
      return (
        artistMatch * 0.35 +
        similarity * 0.28 +
        qualityBonus * 0.12 +
        channelPriority * 0.10 +
        popularityScore * 0.12 +
        genreMatch * 0.03
      );
    } else if (musicRegion === 'international') {
      return (
        artistMatch * 0.35 +
        similarity * 0.25 +
        qualityBonus * 0.15 +
        channelPriority * 0.10 +
        popularityScore * 0.12 +
        genreMatch * 0.03
      );
    }
    return (
      artistMatch * 0.35 +
      similarity * 0.30 +
      qualityBonus * 0.12 +
      channelPriority * 0.10 +
      popularityScore * 0.10 +
      genreMatch * 0.03
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

    // 장르 키워드 패턴 (한국어 + 영어) - 단어 단위로만 비교 ("기록"→록, "Wrap"→랩 오탐 방지)
    const genrePatterns = {
      'k-pop': ['k-pop', 'kpop', '케이팝'],
      'pop': ['pop', '팝', '팝송'],
      'rock': ['rock', '록', '락', '로큰롤'],
      'hip-hop': ['hip-hop', 'hiphop', 'hip hop', '힙합', '랩', 'rap', 'trap'],
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
      if (keywords.some((keyword) => hasKeyword(titleLower, keyword, true))) {
        return genre;
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
    // 앞쪽의 [MV], 【TVPP】, 날짜(220918) 등 제거
    const cleanedTitle = title.replace(/^(\s*(\[[^\]]*\]|【[^】]*】|\d{6,8})\s*)+/, '').trim();

    const pickArtist = (part) => {
      // "갈 길은 내가 만들어내 : Taylor Swift" 처럼 앞에 설명 문구가 붙은 경우 ':' 뒤만 사용
      let artist = part.split(/\s?[:：]\s/).pop();
      // 괄호 안 다른 표기는 유지 (같은 가수 판단에 사용), 따옴표·낫표부터는 곡명이므로 제거
      artist = artist.replace(/['"‘’“”「『].*$/, '').trim();
      return artist.length > 0 && artist.length < 40 ? artist : null;
    };

    // '가수 - 제목', '가수 _ 제목', '제목 by 가수' 등
    const separators = [/\s[-–—]\s|[-–—]\s/, /\s_\s/, / by /i, / \| /, / \/ /];
    for (const sep of separators) {
      const parts = cleanedTitle.split(sep);
      if (parts.length > 1) {
        const artist = pickArtist(parts[0]);
        if (artist) return artist;
      }
    }

    // 구분자 없이 곡명을 따옴표·낫표로 감싼 형식: "BTS (방탄소년단) 'Dynamite' Official MV", "YOASOBI「夜に駆ける」"
    const quoted = cleanedTitle.match(/^([^'"‘’“”「『]+?)\s*['"‘’“”「『]/);
    if (quoted) {
      const artist = pickArtist(quoted[1]);
      if (artist) return artist;
    }
    return null;
  }
  
  /**
   * 가수명 정규화 (비교용)
   * 괄호, 대괄호, 공백 제거하고 핵심 가수명만 추출
   * @param {string} artist - 가수명
   * @returns {string} 정규화된 가수명
   */
  normalizeArtistName(artist) {
    if (!artist) return '';
    
    // 소문자 변환
    let normalized = artist.toLowerCase().trim();
    
    // 괄호, 대괄호 제거
    normalized = normalized.replace(/[()\[\]]/g, '');
    
    // 공백 제거
    normalized = normalized.replace(/\s+/g, '');
    
    // 특수 문자 제거 (하이픈, 슬래시 등)
    normalized = normalized.replace(/[-–—\/\|]/g, '');
    
    return normalized;
  }

  /**
   * 제목에서 노래 제목만 추출 (가수명 제외)
   * @param {string} title - 전체 제목 (예: "가수명 - 제목")
   * @returns {string} 노래 제목만 (가수명 제외)
   */
  extractSongTitle(title) {
    if (!title) return '';
    
    // '가수명 - 제목' 형식에서 제목만 추출
    const separators = [/[-–—]\s*/, / by /i, / \| /, / \/ /];
    
    for (const sep of separators) {
      const parts = title.split(sep);
      if (parts.length > 1) {
        // 두 번째 부분부터가 제목 (나머지 부분 합치기)
        const songTitle = parts.slice(1).join(' ').trim();
        if (songTitle.length > 0) {
          return songTitle;
        }
      }
    }
    
    // 구분자가 없으면 전체를 제목으로 간주
    return title.trim();
  }

  /**
   * 아티스트 다양성 보너스 계산
   * @param {string} currentArtist - 현재 추천 항목의 아티스트
   * @param {Array} previousArtists - 이전에 선택된 아티스트 배열
   * @returns {number} 다양성 보너스 (0~1)
   */
  // 같은 가수의 곡은 점수 순으로 maxPerArtist개까지는 그대로 두고, 그 뒤부터는 곡마다 점수를 조금씩 낮춰
  // 다른 가수 곡과 섞이게 함 (표시 점수와 순서가 어긋나지 않도록 finalScore도 함께 갱신)
  limitPerArtist(recommendations, maxPerArtist) {
    const counts = [];
    const adjusted = recommendations.map((rec) => {
      const artist = rec.extractedArtist || this.extractArtist(rec.title);
      if (!artist) return rec;
      let entry = counts.find((c) => this.calculateArtistMatch(c.artist, artist) >= 1.0);
      if (!entry) {
        entry = { artist, count: 0 };
        counts.push(entry);
      }
      entry.count += 1;
      const overflow = entry.count - maxPerArtist;
      if (overflow <= 0 || typeof rec.finalScore !== 'number') return rec;
      return { ...rec, finalScore: rec.finalScore * Math.pow(ARTIST_REPEAT_DECAY, overflow) };
    });
    return adjusted.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
  }

  calculateDiversityBonus(currentArtist, previousArtists) {
    if (!currentArtist || previousArtists.length === 0) {
      return 0.15; // 첫 번째 항목은 보너스 증가 (0.1 → 0.15)
    }

    // 이전에 선택된 아티스트와 다르면 보너스
    const isNewArtist = !previousArtists.some(prev => {
      const normalize = (str) => str.toLowerCase().trim();
      return this.calculateArtistMatch(prev, currentArtist) >= 1.0 || normalize(prev) === normalize(currentArtist);
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
        return this.calculateArtistMatch(prev, currentArtist) >= 1.0 || normalize(prev) === normalize(currentArtist);
      }).length;
      return -Math.min(0.2, 0.05 + consecutiveCount * 0.03);
    }
  }

  /**
   * 제목 차별화 보너스 계산 (같은 가수지만 다른 제목이면 보너스)
   * @param {string} recTitle - 추천 노래 제목
   * @param {Array} queueTitles - 대기열의 노래 제목 배열
   * @returns {number} 제목 차별화 보너스 (0~1)
   */
  calculateTitleDiversityBonus(recTitle, queueTitles) {
    if (!recTitle || !queueTitles || queueTitles.length === 0) {
      return 0.2; // 대기열이 없으면 기본 보너스
    }

    const recSongTitle = this.extractSongTitle(recTitle);
    const recNormalizedSongTitle = this.normalizeTitle(recSongTitle);
    
    if (recNormalizedSongTitle.length === 0) {
      return 0; // 제목 추출 실패 시 보너스 없음
    }

    // 대기열의 모든 노래 제목과 비교
    let maxSimilarity = 0;
    for (const queueTitle of queueTitles) {
      const queueSongTitle = this.extractSongTitle(queueTitle);
      const queueNormalizedSongTitle = this.normalizeTitle(queueSongTitle);
      
      if (queueNormalizedSongTitle.length === 0) continue;
      
      // 제목 유사도 계산 (가수명 제외)
      const similarity = this.calculateTitleSimilarity(recTitle, queueTitle);
      maxSimilarity = Math.max(maxSimilarity, similarity);
    }

    // 제목 유사도가 낮을수록 (다른 제목일수록) 높은 보너스
    if (maxSimilarity < 0.3) {
      // 매우 다른 제목 (유사도 < 30%) → 최대 보너스
      return 1.0;
    } else if (maxSimilarity < 0.5) {
      // 다른 제목 (유사도 < 50%) → 높은 보너스
      return 0.8;
    } else if (maxSimilarity < 0.7) {
      // 약간 다른 제목 (유사도 < 70%) → 중간 보너스
      return 0.5;
    } else if (maxSimilarity < 0.85) {
      // 유사한 제목 (유사도 < 85%) → 낮은 보너스
      return 0.2;
    } else {
      // 매우 유사한 제목 (유사도 >= 85%) → 페널티 (같은 노래의 다른 버전)
      return -0.3;
    }
  }

  /**
   * 국내 음악인지 판단 (한국 가수 기준)
   * @param {string} title - 제목
   * @param {string} artist - 아티스트 이름 (선택적)
   * @param {Object} channelInfo - 채널 정보 (선택적)
   * @returns {boolean} 국내 음악이면 true
   */
  isDomesticMusic(title, artist = null, channelInfo = null) {
    if (!title) return false;
    
    const koreanRegex = /[가-힣]/;
    
    // 채널 정보가 있으면 채널 정보 우선 확인
    if (channelInfo) {
      const channelTitle = channelInfo.channelTitle || '';
      const channelTitleLower = channelTitle.toLowerCase();
      
      // 채널 제목에 한국어가 있으면 한국 채널로 판단
      if (koreanRegex.test(channelTitle)) {
        // 한국어가 있지만 외국 가수 채널일 수 있으므로 추가 확인
        // 외국 가수 채널 키워드 확인
        const foreignChannelKeywords = [
          'vevo', 'vevo official', 'official vevo',
          'warner', 'sony', 'universal', 'emi',
          'atlantic', 'republic', 'interscope',
          'capitol', 'def jam', 'island', 'motown'
        ];
        
        // 외국 가수 채널 키워드가 있으면 제외
        const hasForeignKeyword = foreignChannelKeywords.some(keyword => 
          channelTitleLower.includes(keyword)
        );
        
        if (hasForeignKeyword) {
          return false; // 외국 가수 채널
        }
        
        // 한국어가 있고 외국 키워드가 없으면 한국 채널로 판단
        return true;
      }
    }
    
    // 아티스트 이름이 있으면 아티스트 기준으로 판단 (우선순위)
    if (artist) {
      const artistHasKorean = koreanRegex.test(artist);
      
      // 아티스트 이름에 한글이 있으면 한국 가수로 판단
      if (artistHasKorean) {
        return true;
      }
      
      // 아티스트 이름에 한글이 없으면 외국 가수로 판단
      // 제목에 한글이 있어도 외국 가수가 부른 한국 노래일 수 있으므로 false
      return false;
    }
    
    // 아티스트 정보가 없으면 제목에서 아티스트 추출 시도
    const extractedArtist = this.extractArtist(title);
    if (extractedArtist) {
      const extractedHasKorean = koreanRegex.test(extractedArtist);
      
      // 추출된 아티스트에 한글이 있으면 한국 가수로 판단
      if (extractedHasKorean) {
        return true;
      }
      
      // 추출된 아티스트에 한글이 없으면 외국 가수로 판단
      return false;
    }
    
    // 아티스트를 추출할 수 없으면 제목 기준으로 판단 (폴백)
    // 단, 이 경우는 정확도가 낮을 수 있으므로 엄격하게 판단
    const hasKorean = koreanRegex.test(title);
    
    // K-pop, Korean 등의 키워드가 있으면 국내
    const koreanKeywords = ['k-pop', 'kpop', 'korean', '케이팝'];
    const hasKoreanKeyword = koreanKeywords.some(keyword => 
      title.toLowerCase().includes(keyword)
    );
    
    // 한글이 있거나 한국 키워드가 있으면 국내로 판단
    // 하지만 아티스트 정보가 없으면 신뢰도가 낮으므로 false 반환 (더 엄격하게)
    return false; // 아티스트 정보가 없으면 판단 불가로 간주
  }

  /**
   * 다양한 검색 쿼리 생성
   * @param {Array} topSongs - 상위 하트 음악 배열
   * @param {string} musicRegion - 음악 지역 기준 ('all', 'domestic', 'international')
   * @param {Set} previousArtists - 이전 추천 가수명 (정규화된 버전, 제외할 가수명)
   * @returns {Array<string>} 검색 쿼리 배열
   */
  generateDiverseSearchQueries(topSongs, musicRegion = 'all', previousArtists = new Set()) {
    const queries = [];
    
    // 1. 아티스트 기반 검색 (우선순위: 대기열에 있는 가수들의 노래 우선)
    // 단, 이전 추천 가수명과 일치하는 가수는 제외
    let artists = topSongs
      .map(song => {
        const artist = this.extractArtist(song.title);
        if (!artist) return null;
        
        // 이전 추천 가수명과 일치하는지 확인
        const normalizedArtist = this.normalizeArtistName(artist);
        if (normalizedArtist && previousArtists.has(normalizedArtist)) {
          console.log(`[RecommendationService] 검색 쿼리에서 제외할 가수: "${artist}" (정규화: "${normalizedArtist}")`);
          return null; // 이전 추천 가수명과 일치하면 제외
        }
        
        return artist;
      })
      .filter(Boolean)
      .filter((artist, index, self) => self.indexOf(artist) === index) // 중복 제거
      .slice(0, 5); // 더 많은 아티스트 포함
    
    // 이전 추천 가수명으로 인해 모든 아티스트가 제외된 경우, 장르 기반 검색 추가
    if (artists.length === 0 && previousArtists.size > 0) {
      console.log('[RecommendationService] 모든 대기열 가수가 이전 추천 가수명과 일치하여 장르 기반 검색 쿼리 추가');
      if (musicRegion === 'domestic') {
        queries.push('korean ballad 발라드');
        queries.push('korean ballad songs');
        queries.push('k-pop ballad 발라드');
        queries.push('한국 발라드');
        queries.push('국내 발라드');
      } else if (musicRegion === 'international') {
        queries.push('ballad songs');
        queries.push('popular ballad');
        queries.push('best ballad');
        queries.push('ballad music');
        queries.push('ballad hits');
      } else {
        queries.push('ballad 발라드');
        queries.push('ballad songs');
        queries.push('popular ballad');
        queries.push('best ballad');
        queries.push('korean ballad');
        queries.push('ballad music');
      }
    }
    
    if (artists.length > 0) {
      // 우선순위 1: 아티스트 + "songs" 또는 "music" (다른 노래 찾기)
      for (const artist of artists.slice(0, 3)) {
        let songsQuery = `${artist} songs`;
        if (musicRegion === 'domestic') {
          songsQuery += ' korean k-pop';
        } else if (musicRegion === 'international') {
          songsQuery += ' -korean -k-pop';
        }
        queries.push(songsQuery);
        
        let musicQuery = `${artist} music`;
        if (musicRegion === 'domestic') {
          musicQuery += ' korean k-pop';
        } else if (musicRegion === 'international') {
          musicQuery += ' -korean -k-pop';
        }
        queries.push(musicQuery);
      }
      
      // 우선순위 2: 아티스트 + "best songs" 또는 "popular songs" (인기 다른 노래)
      for (const artist of artists.slice(0, 2)) {
        let bestSongsQuery = `${artist} best songs`;
        if (musicRegion === 'domestic') {
          bestSongsQuery += ' korean k-pop';
        } else if (musicRegion === 'international') {
          bestSongsQuery += ' -korean -k-pop';
        }
        queries.push(bestSongsQuery);
      }
      
      // 우선순위 3: 아티스트 이름만으로 검색 (다양한 노래 찾기)
      for (const artist of artists.slice(0, 3)) {
        let individualQuery = artist;
        if (musicRegion === 'domestic') {
          individualQuery += ' korean k-pop';
        } else if (musicRegion === 'international') {
          individualQuery += ' -korean -k-pop';
        }
        queries.push(individualQuery);
      }
      
      // 우선순위 4: 아티스트 + "studio version" 또는 "official audio" (음질 좋은 버전, 다른 노래)
      for (const artist of artists.slice(0, 2)) {
        let studioQuery = `${artist} studio version`;
        if (musicRegion === 'domestic') {
          studioQuery += ' korean k-pop';
        } else if (musicRegion === 'international') {
          studioQuery += ' -korean -k-pop';
        }
        queries.push(studioQuery);
      }
    }

    // 2. 제목 기반 검색 (보조)
    let titleQuery = topSongs
      .slice(0, 3)
      .map(song => song.title)
      .join(' OR ');
    
    // 지역 필터 적용
    if (musicRegion === 'domestic') {
      titleQuery += ' korean k-pop';
    } else if (musicRegion === 'international') {
      // 해외 음악은 한글 제목이 아닌 것 위주로 검색
      // 검색 쿼리 자체는 그대로 두고, 결과 필터링으로 처리
    }
    
    queries.push(titleQuery);

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
      .replace(/\s*\[.*?\]\s*/g, '') // 대괄호 내용 제거 (예: [가사/Lyrics], [EMOTION])
      .replace(/\s*\(.*?\)\s*/g, '') // 괄호 내용 제거 (예: (Color Coded Lyrics), (Feat. 양다일))
      .replace(/\s*\/\s*/g, ' ') // 슬래시를 공백으로
      .replace(/\s+/g, ' ') // 여러 공백을 하나로
      .replace(/[^\w\s가-힣]/g, '') // 특수문자 제거 (한글, 영문, 숫자만 유지)
      .replace(/\s*(official|audio|video|mv|music|song|track|version|ver|studio|live|remix|cover|feat|ft|featuring|lyrics|lyric|가사|color|coded|eng|rom|han|emotion|audio|lyrics)\s*/gi, '') // 공통 키워드 제거 (더 많은 키워드 추가)
      .replace(/\s+/g, ' ') // 다시 공백 정리
      .trim();
  }

  /**
   * 제목 문자열 유사도 계산 (가수명 제외하고 노래 제목만 비교)
   * @param {string} title1 - 첫 번째 제목
   * @param {string} title2 - 두 번째 제목
   * @returns {number} 유사도 (0~1)
   */
  calculateTitleSimilarity(title1, title2) {
    // 가수명을 제외하고 노래 제목만 추출
    const songTitle1 = this.extractSongTitle(title1);
    const songTitle2 = this.extractSongTitle(title2);
    
    // 노래 제목 정규화
    const normalized1 = this.normalizeTitle(songTitle1);
    const normalized2 = this.normalizeTitle(songTitle2);

    if (normalized1 === normalized2) return 1.0;
    if (normalized1.length === 0 || normalized2.length === 0) return 0.0;

    // 한 제목이 다른 제목을 포함하는지 확인 (더 엄격하게)
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
      const shorter = normalized1.length < normalized2.length ? normalized1 : normalized2;
      const longer = normalized1.length >= normalized2.length ? normalized1 : normalized2;
      const ratio = shorter.length / longer.length;
      // 포함 비율이 80% 이상이면 높은 유사도로 간주
      if (ratio >= 0.8) {
        return 0.9; // 높은 유사도
      }
      return ratio;
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
   * 재생 가능한 음악인지 검증
   * @param {Object} music - 음악 객체
   * @returns {boolean} 재생 가능하면 true, 아니면 false
   */
  isPlayableMusic(music) {
    if (!music) return false;
    
    // 필수 필드 확인
    if (!music.videoId || !music.title) {
      console.log(`[RecommendationService] 필수 필드 누락: videoId=${!!music.videoId}, title=${!!music.title}`);
      return false;
    }
    
    // videoId가 유효한 형식인지 확인 (11자리 문자열)
    if (typeof music.videoId !== 'string' || music.videoId.length !== 11) {
      console.log(`[RecommendationService] 유효하지 않은 videoId: "${music.videoId}"`);
      return false;
    }
    
    // thumbnail이 있는지 확인
    if (!music.thumbnail || !music.thumbnail.startsWith('http')) {
      console.log(`[RecommendationService] 유효하지 않은 thumbnail: "${music.title}"`);
      return false;
    }
    
    return true;
  }

  /**
   * 쇼츠인지 확인
   * @param {Object} music - 음악 객체
   * @returns {boolean} 쇼츠이면 true, 아니면 false
   */
  isShorts(music) {
    if (!music || !music.title) return false;
    
    const title = music.title.toLowerCase();
    
    // 제목에 쇼츠 키워드가 있는지 확인
    const shortsKeywords = ['#shorts', 'shorts', '쇼츠', 'short'];
    const hasShortsKeyword = shortsKeywords.some(keyword => title.includes(keyword));
    
    if (hasShortsKeyword) {
      console.log(`[RecommendationService] 쇼츠 제외 (키워드): "${music.title}"`);
      return true;
    }
    
    // 재생 시간이 1분 이하인지 확인 (쇼츠는 보통 1분 이하)
    if (music.duration) {
      const durationStr = music.duration;
      const parts = durationStr.split(':');
      if (parts.length >= 2) {
        let totalSeconds = 0;
        if (parts.length === 3) {
          // HH:MM:SS 형식
          totalSeconds = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
        } else if (parts.length === 2) {
          // MM:SS 형식
          totalSeconds = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }
        const minutes = totalSeconds / 60;
        
        // 1분 이하이면서 제목에 short 관련 키워드가 있으면 쇼츠로 간주
        if (minutes <= 1 && (title.includes('short') || title.includes('쇼츠'))) {
          console.log(`[RecommendationService] 쇼츠 제외 (재생시간 + 키워드): "${music.title}" (${durationStr})`);
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * 단일 곡인지 검증 (라이브, 커버, 리믹스, 뮤직비디오 등 제외)
   * @param {Object} music - 음악 객체
   * @returns {boolean} 유효한 단일 곡이면 true, 아니면 false
   */
  isValidSingleTrack(music) {
    if (!music || !music.title) return false;

    // 쇼츠 제외
    if (this.isShorts(music)) {
      return false;
    }

    const title = music.title.toLowerCase();
    
    // 제외할 키워드 패턴 (라이브, 커버, 리믹스, 공연장, 대회 등)
    // 주의: MV는 제외하지 않음 (MV는 실제 재생 가능한 음악임)
    const excludeKeywords = [
      // 라이브/공연 관련 (강화) - 단, 버스킹, 직캠 등은 제외
      'concert', 'performance', 'stage', 'show', 'tour', 'busking', '직캠', '버스킹',
      '공연', '무대', '콘서트', '퍼포먼스', '라이브 공연', 'live concert', 'live performance',
      // 공연장/대회 관련 (추가)
      'venue', 'arena', 'stadium', 'hall', 'theater', 'theatre',
      '공연장', '경기장', '체육관', '홀', '극장',
      'competition', 'contest', 'competition', 'audition', 'talent show',
      '대회', '경연', '오디션', '선발', '경기',
      'festival', 'fest', 'music festival', 'rock festival',
      '페스티벌', '축제', '음악제',
      'award', 'ceremony', 'grammy', 'billboard',
      '시상식', '수상', '그래미', '빌보드',
      'broadcast', 'tv', 'television', 'kbs', 'mbc', 'sbs',
      '방송', '텔레비전', '티비',
      'fan cam', 'fancam', 'phone recording', 'phone cam',
      '팬캠', '팬 캠', '핸드폰 녹음', '핸드폰 영상',
      'audience', 'crowd', 'crowd recording',
      '관중', '청중', '관객', '군중',
      // 커버/리믹스 관련
      'cover', 'remix', 'mashup', 'mash-up', 'edit', 'version',
      '커버', '리믹스', '리메이크', '어레인지',
      // 뮤직비디오/비디오 관련 - 제외하지 않음 (MV는 실제 재생 가능한 음악임)
      // 'mv', 'music video', 'official video', 'video', 'visual',
      // '뮤직비디오', '뮤비', '비디오', '영상',
      // 기타 제외 키워드
      'reaction', 'review', 'reaction video', 'reaction video',
      '리액션', '반응', '리뷰',
      'behind', 'making', 'making of', 'behind the scenes',
      '메이킹', '비하인드',
      'interview', '인터뷰',
      'teaser', 'trailer', '티저', '트레일러',
      'preview', 'snippet', '프리뷰', '스니펫',
      'extended', 'extended version', 'extended mix',
      'acoustic', 'unplugged', 'acoustic version',
      '어쿠스틱', '언플러그드',
      'karaoke', 'instrumental', 'karaoke version',
      '카라오케', '반주', 'MR',
      'dance', 'choreography', 'dance practice',
      '댄스', '안무', '댄스 연습',
      'rehearsal', '리허설',
      'parody', '패러디',
      'tutorial', '튜토리얼',
      'lesson', '레슨',
      'explained', '설명',
      'analysis', '분석',
      'breakdown', '브레이크다운',
      'comparison', '비교',
      'vs', 'versus',
      'medley', '메들리',
      'mashup', '매시업',
      'mash up', '매시 업',
      'mix', '믹스',
      'dj', '디제이',
      'set', '세트',
      'session', '세션',
      'episode', '에피소드',
      'part', '파트',
      'chapter', '챕터',
      'series', '시리즈',
      'season', '시즌',
      'ep', 'EP',
      'hits collection', '히츠 컬렉션',
      'best collection', '베스트 컬렉션',
      'greatest collection', '그레이트스트 컬렉션',
      'hits mix', '히츠 믹스',
      'best mix', '베스트 믹스',
      'greatest mix', '그레이트스트 믹스',
      'hits playlist', '히츠 플레이리스트',
      'best playlist', '베스트 플레이리스트',
      'greatest playlist', '그레이트스트 플레이리스트',
      'hits nonstop', '히츠 논스톱',
      'best nonstop', '베스트 논스톱',
      'greatest nonstop', '그레이트스트 논스톱',
      'hits continuous', '히츠 연속',
      'best continuous', '베스트 연속',
      'greatest continuous', '그레이트스트 연속',
      'hits full', '히츠 풀',
      'best full', '베스트 풀',
      'greatest full', '그레이트스트 풀',
      'hits complete', '히츠 완전판',
      'best complete', '베스트 완전판',
      'greatest complete', '그레이트스트 완전판',
      'hits all', '히츠 올',
      'best all', '베스트 올',
      'greatest all', '그레이트스트 올',
      'hits anthology', '히츠 앤솔로지',
      'best anthology', '베스트 앤솔로지',
      'greatest anthology', '그레이트스트 앤솔로지',
      'hits the best', '히츠 더 베스트',
      'best the best', '베스트 더 베스트',
      'greatest the best', '그레이트스트 더 베스트',
      'hits top', '히츠 탑',
      'best top', '베스트 탑',
      'greatest top', '그레이트스트 탑',
      'hits chart', '히츠 차트',
      'best chart', '베스트 차트',
      'greatest chart', '그레이트스트 차트',
      'hits ranking', '히츠 랭킹',
      'best ranking', '베스트 랭킹',
      'greatest ranking', '그레이트스트 랭킹',
      'hits countdown', '히츠 카운트다운',
      'best countdown', '베스트 카운트다운',
      'greatest countdown', '그레이트스트 카운트다운',
      'hits top 10', '히츠 탑 10',
      'best top 10', '베스트 탑 10',
      'greatest top 10', '그레이트스트 탑 10',
      'hits top 20', '히츠 탑 20',
      'best top 20', '베스트 탑 20',
      'greatest top 20', '그레이트스트 탑 20',
      'hits top 50', '히츠 탑 50',
      'best top 50', '베스트 탑 50',
      'greatest top 50', '그레이트스트 탑 50',
      'hits top 100', '히츠 탑 100',
      'best top 100', '베스트 탑 100',
      'greatest top 100', '그레이트스트 탑 100',
      'hits playlist', '히츠 플레이리스트',
      'best playlist', '베스트 플레이리스트',
      'greatest playlist', '그레이트스트 플레이리스트',
      'hits mix', '히츠 믹스',
      'best mix', '베스트 믹스',
      'greatest mix', '그레이트스트 믹스',
      'hits nonstop', '히츠 논스톱',
      'best nonstop', '베스트 논스톱',
      'greatest nonstop', '그레이트스트 논스톱',
      'hits continuous', '히츠 연속',
      'best continuous', '베스트 연속',
      'greatest continuous', '그레이트스트 연속',
      'hits full', '히츠 풀',
      'best full', '베스트 풀',
      'greatest full', '그레이트스트 풀',
      'hits complete', '히츠 완전판',
      'best complete', '베스트 완전판',
      'greatest complete', '그레이트스트 완전판',
      'hits all', '히츠 올',
      'best all', '베스트 올',
      'greatest all', '그레이트스트 올',
      'hits anthology', '히츠 앤솔로지',
      'best anthology', '베스트 앤솔로지',
      'greatest anthology', '그레이트스트 앤솔로지',
      'hits the best', '히츠 더 베스트',
      'best the best', '베스트 더 베스트',
      'greatest the best', '그레이트스트 더 베스트',
      'hits top', '히츠 탑',
      'best top', '베스트 탑',
      'greatest top', '그레이트스트 탑',
      'hits chart', '히츠 차트',
      'best chart', '베스트 차트',
      'greatest chart', '그레이트스트 차트',
      'hits ranking', '히츠 랭킹',
      'best ranking', '베스트 랭킹',
      'greatest ranking', '그레이트스트 랭킹',
      'hits countdown', '히츠 카운트다운',
      'best countdown', '베스트 카운트다운',
      'greatest countdown', '그레이트스트 카운트다운',
      'hits top 10', '히츠 탑 10',
      'best top 10', '베스트 탑 10',
      'greatest top 10', '그레이트스트 탑 10',
      'hits top 20', '히츠 탑 20',
      'best top 20', '베스트 탑 20',
      'greatest top 20', '그레이트스트 탑 20',
      'hits top 50', '히츠 탑 50',
      'best top 50', '베스트 탑 50',
      'greatest top 50', '그레이트스트 탑 50',
      'hits top 100', '히츠 탑 100',
      'best top 100', '베스트 탑 100',
      'greatest top 100', '그레이트스트 탑 100',
    ];

    // 제외 키워드가 포함되어 있으면 제외
    for (const keyword of excludeKeywords) {
      if (title.includes(keyword)) {
        console.log(`[RecommendationService] 단일 곡이 아님 (제외 키워드): "${music.title}" (키워드: ${keyword})`);
        return false;
      }
    }

    // 재생 시간 검증 (1분 미만 또는 8분 이상이면 제외)
    if (music.duration) {
      const durationStr = music.duration;
      const parts = durationStr.split(':');
      if (parts.length >= 2) {
        let totalSeconds = 0;
        if (parts.length === 3) {
          // HH:MM:SS 형식
          totalSeconds = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
        } else if (parts.length === 2) {
          // MM:SS 형식
          totalSeconds = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }
        const minutes = totalSeconds / 60;
        
        // 1분 미만이면 너무 짧음 (인트로, 티저 등)
        if (minutes < 1) {
          console.log(`[RecommendationService] 재생시간이 너무 짧음: "${music.title}" (${durationStr})`);
          return false;
        }
        
        // 8분 이상이면 너무 김 (모음집, 라이브 세트 등)
        if (minutes >= 8) {
          console.log(`[RecommendationService] 재생시간이 너무 김: "${music.title}" (${durationStr})`);
          return false;
        }
      }
    }

    // 제목이 너무 짧으면 제외 (3자 미만)
    if (music.title.trim().length < 3) {
      console.log(`[RecommendationService] 제목이 너무 짧음: "${music.title}"`);
      return false;
    }

    // 제목이 너무 길면 제외 (100자 초과)
    if (music.title.trim().length > 100) {
      console.log(`[RecommendationService] 제목이 너무 김: "${music.title}"`);
      return false;
    }

    return true;
  }

  /**
   * 이전 추천 기록 가져오기 (localStorage에서)
   * @returns {Array} 이전 추천 기록 [{ videoId, title, timestamp }]
   */
  getPreviousRecommendations() {
    try {
      const stored = localStorage.getItem('aiRecommendations');
      if (stored) {
        const recommendations = JSON.parse(stored);
        // 최근 100개만 유지 (메모리 절약)
        return recommendations.slice(-100).map(rec => ({
          videoId: rec.videoId,
          title: rec.title,
          timestamp: rec.timestamp || Date.now()
        }));
      }
    } catch (error) {
      console.warn('[RecommendationService] 이전 추천 기록 로드 실패:', error);
    }
    return [];
  }

  /**
   * 중복 제거 (제한된 이전 추천 기록 사용 - 폴백용)
   * @param {Array} recommendations - 추천 결과
   * @param {Array} queue - 현재 대기열
   * @param {number} titleSimilarityThreshold - 제목 유사도 임계값
   * @param {Array} limitedPreviousRecommendations - 제한된 이전 추천 기록
   * @returns {Promise<Array>} 중복 제거된 추천 결과
   */
  async filterDuplicatesWithLimitedHistory(recommendations, queue, titleSimilarityThreshold = 0.80, limitedPreviousRecommendations = []) {
    if (!recommendations || recommendations.length === 0) {
      return [];
    }

    console.log(`[RecommendationService] 제한된 이전 추천 기록으로 중복 제거: ${limitedPreviousRecommendations.length}개`);

    const queueVideoIds = new Set(queue.map(music => music.videoId));
    const queueTitles = queue.map(music => music.title);
    
    // 제한된 이전 추천 기록만 사용
    const previousVideoIds = new Set(limitedPreviousRecommendations.map(rec => rec.videoId));
    const previousTitles = limitedPreviousRecommendations.map(rec => rec.title);
    
    // 모든 제목 통합 (대기열 + 제한된 이전 추천)
    const allTitles = [...queueTitles, ...previousTitles];
    
    // 추천 결과 제목들의 임베딩 생성
    const recTitles = recommendations.map(rec => rec.title);
    const recEmbeddings = await embeddingService.generateEmbeddings(recTitles);

    const filtered = [];
    const seenVideoIds = new Set();

    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      const recEmbedding = recEmbeddings[i];

      // videoId 중복 확인 (대기열 + 제한된 이전 추천만)
      if (queueVideoIds.has(rec.videoId) || previousVideoIds.has(rec.videoId) || seenVideoIds.has(rec.videoId)) {
        continue;
      }

      // 가수명 추출 및 유사도 확인 (완화된 버전)
      const recArtist = this.extractArtist(rec.title);
      const recSongTitle = this.extractSongTitle(rec.title);
      
      let hasSimilarArtist = false;
      if (recArtist && queue.length > 0) {
        for (const queueMusic of queue) {
          const queueArtist = this.extractArtist(queueMusic.title);
          if (queueArtist) {
            const artistMatch = this.calculateArtistMatch(recArtist, queueArtist);
            if (artistMatch >= 0.8) {
              hasSimilarArtist = true;
              break;
            }
          }
        }
      } else {
        // 가수명 추출 실패하거나 대기열이 비어있으면 통과
        hasSimilarArtist = true;
      }
      
      if (!hasSimilarArtist && queue.length > 0 && recArtist) {
        continue;
      }

      // 제목 중복 확인 (완화된 임계값 사용: 0.85)
      let isDuplicate = false;
      for (let j = 0; j < allTitles.length; j++) {
        const queueSongTitle = this.extractSongTitle(allTitles[j]);
        const recNormalizedSongTitle = this.normalizeTitle(recSongTitle);
        const queueNormalizedSongTitle = this.normalizeTitle(queueSongTitle);
        
        if (recNormalizedSongTitle === queueNormalizedSongTitle && recNormalizedSongTitle.length > 0) {
          isDuplicate = true;
          break;
        }
        
        // 제목 유사도 확인 (임계값 완화: 0.85)
        const stringSimilarity = this.calculateTitleSimilarity(rec.title, allTitles[j]);
        if (stringSimilarity >= 0.85) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        filtered.push(rec);
        seenVideoIds.add(rec.videoId);
      }
    }

    console.log(`[RecommendationService] 제한된 이전 추천 기록으로 중복 제거: ${recommendations.length}개 → ${filtered.length}개`);
    return filtered;
  }

  /**
   * 중복 제거 (대기열 + 이전 추천 기록에 이미 있는 음악 및 유사한 제목 제외)
   * @param {Array} recommendations - 추천 결과
   * @param {Array} queue - 현재 대기열
   * @param {number} titleSimilarityThreshold - 제목 유사도 임계값 (기본 0.80)
   * @returns {Promise<Array>} 중복 제거된 추천 결과
   */
  async filterDuplicates(recommendations, queue, titleSimilarityThreshold = 0.80) {
    if (!recommendations || recommendations.length === 0) {
      return [];
    }

    // 이전 추천 기록 가져오기
    const previousRecommendations = this.getPreviousRecommendations();
    console.log(`[RecommendationService] 이전 추천 기록: ${previousRecommendations.length}개`);

    // 대기열에 현재 재생 중인 음악도 포함되어 있음 (서버에서 extendedQueue로 전송)
    // queue의 첫 번째 항목이 현재 재생 중인 음악일 가능성이 높음
    const queueVideoIds = new Set(queue.map(music => music.videoId));
    const queueTitles = queue.map(music => music.title);
    const queueNormalizedTitles = queueTitles.map(title => this.normalizeTitle(title));
    
    // 디버깅: 대기열 정보 로그 (현재 재생 중인 음악 포함)
    console.log(`[RecommendationService] 중복 체크 대상: 대기열 ${queue.length}개 (현재 재생 중인 음악 포함), 이전 추천 ${previousRecommendations.length}개`);
    if (queue.length > 0) {
      console.log(`[RecommendationService] 대기열 첫 번째 항목 (현재 재생 중일 가능성): "${queue[0].title}" (videoId: ${queue[0].videoId})`);
    }
    
    // 이전 추천 기록의 videoId와 제목도 포함
    const previousVideoIds = new Set(previousRecommendations.map(rec => rec.videoId));
    const previousTitles = previousRecommendations.map(rec => rec.title);
    const previousNormalizedTitles = previousTitles.map(title => this.normalizeTitle(title));
    
    // 이전 추천 기록의 가수명 추출 (새로고침 후 다른 가수 추천을 위해)
    const previousArtists = new Set();
    const previousArtistsOriginal = new Set(); // 원본 가수명도 저장 (디버깅용)
    previousRecommendations.forEach(rec => {
      const artist = this.extractArtist(rec.title);
      if (artist) {
        // 정규화된 가수명 사용 (괄호, 대괄호, 공백 제거)
        const normalizedArtist = this.normalizeArtistName(artist);
        if (normalizedArtist) {
          previousArtists.add(normalizedArtist);
          previousArtistsOriginal.add(artist); // 원본도 저장
          console.log(`[RecommendationService] 이전 추천 가수명 추출: "${rec.title}" → "${artist}" (정규화: "${normalizedArtist}")`);
        } else {
          console.warn(`[RecommendationService] 이전 추천 가수명 정규화 실패: "${rec.title}" → "${artist}"`);
        }
      } else {
        console.warn(`[RecommendationService] 이전 추천 가수명 추출 실패: "${rec.title}"`);
      }
    });
    console.log(`[RecommendationService] 이전 추천 기록의 가수명 (정규화): ${previousArtists.size}개`, Array.from(previousArtists));
    console.log(`[RecommendationService] 이전 추천 기록의 가수명 (원본):`, Array.from(previousArtistsOriginal));
    
    // 모든 제목 통합 (대기열 + 이전 추천)
    const allTitles = [...queueTitles, ...previousTitles];
    const allNormalizedTitles = [...queueNormalizedTitles, ...previousNormalizedTitles];
    
    // 대기열 제목들의 임베딩 생성 (한 번만, 배치 처리)
    // 빈 배열이면 임베딩 생성하지 않음
    let queueTitleEmbeddings = [];
    if (queueTitles.length > 0) {
      try {
        queueTitleEmbeddings = await embeddingService.generateEmbeddings(queueTitles);
      } catch (error) {
        console.warn('[RecommendationService] 대기열 제목 임베딩 생성 실패:', error);
        queueTitleEmbeddings = [];
      }
    }
    
    // 이전 추천 기록 제목들의 임베딩 생성
    let previousTitleEmbeddings = [];
    if (previousTitles.length > 0) {
      try {
        previousTitleEmbeddings = await embeddingService.generateEmbeddings(previousTitles);
      } catch (error) {
        console.warn('[RecommendationService] 이전 추천 제목 임베딩 생성 실패:', error);
        previousTitleEmbeddings = [];
      }
    }
    
    // 모든 임베딩 통합
    const allTitleEmbeddings = [...queueTitleEmbeddings, ...previousTitleEmbeddings];

    // 추천 결과 제목들의 임베딩 생성 (배치 처리로 성능 최적화)
    const recTitles = recommendations.map(rec => rec.title);
    let recEmbeddings = [];
    if (recTitles.length > 0) {
      try {
        recEmbeddings = await embeddingService.generateEmbeddings(recTitles);
      } catch (error) {
        console.error('[RecommendationService] 추천 결과 제목 임베딩 생성 실패:', error);
        // 임베딩 생성 실패 시 빈 배열로 처리 (임베딩 기반 중복 체크는 건너뜀)
        recEmbeddings = [];
      }
    }

    const filtered = [];
    const seenVideoIds = new Set(); // 추천 결과 내에서도 중복 제거
    const seenNormalizedTitles = new Set(); // 추천 결과 내에서도 정규화된 제목 중복 제거
    const seenEmbeddings = []; // 추천 결과 내에서도 임베딩 중복 제거

    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      const recEmbedding = recEmbeddings[i];
      const recNormalizedTitle = this.normalizeTitle(rec.title);

      // 1. videoId 중복 확인 (대기열 + 현재 재생 중인 음악 포함)
      if (queueVideoIds.has(rec.videoId)) {
        const isCurrentPlaying = queue.length > 0 && queue[0].videoId === rec.videoId;
        const source = isCurrentPlaying ? '현재 재생 중인 음악' : '대기열';
        console.log(`[RecommendationService] 동일 videoId 제외 (${source}): "${rec.title}" (${rec.videoId})`);
        continue;
      }

      // 1-1. videoId 중복 확인 (이전 추천 기록)
      if (previousVideoIds.has(rec.videoId)) {
        console.log(`[RecommendationService] 동일 videoId 제외 (이전 추천): "${rec.title}" (${rec.videoId})`);
        continue;
      }

      // 1-2. 추천 결과 내에서도 videoId 중복 제거
      if (seenVideoIds.has(rec.videoId)) {
        console.log(`[RecommendationService] 추천 결과 내 중복 videoId 제외: "${rec.title}" (${rec.videoId})`);
        continue;
      }

      // 1-3. 추천 결과 내에서도 정규화된 제목 중복 제거
      if (seenNormalizedTitles.has(recNormalizedTitle)) {
        console.log(`[RecommendationService] 추천 결과 내 중복 제목 제외 (정규화): "${rec.title}"`);
        continue;
      }

      // 1-4. 추천 결과 내에서도 제목 유사도 확인 (문자열 기반)
      let isDuplicateInResults = false;
      for (const filteredTitle of filtered.map(f => f.title)) {
        const stringSimilarity = this.calculateTitleSimilarity(rec.title, filteredTitle);
        if (stringSimilarity >= 0.85) {
          // 추천 결과 내에서도 문자열 유사도가 높으면 제외 (85% 이상) - 같은 노래의 다른 버전 제외
          isDuplicateInResults = true;
          console.log(`[RecommendationService] 추천 결과 내 유사한 제목 제외 (문자열): "${rec.title}" vs "${filteredTitle}" (유사도: ${(stringSimilarity * 100).toFixed(1)}%)`);
          break;
        }
      }
      
      // 1-5. 추천 결과 내에서도 임베딩 유사도 확인 (임베딩이 있는 경우만)
      if (!isDuplicateInResults && recEmbedding) {
        for (let k = 0; k < seenEmbeddings.length; k++) {
          if (seenEmbeddings[k]) {
            const similarity = SimilarityCalculator.cosineSimilarity(recEmbedding, seenEmbeddings[k]);
            if (similarity >= EMBEDDING_DUPLICATE_THRESHOLD) {
              // 추천 결과 내에서도 유사도가 높으면 제외 (0.85 이상) - 같은 노래의 다른 버전 제외
              isDuplicateInResults = true;
              console.log(`[RecommendationService] 추천 결과 내 유사한 제목 제외 (임베딩): "${rec.title}" (유사도: ${(similarity * 100).toFixed(1)}%)`);
              break;
            }
          }
        }
      }
      
      if (isDuplicateInResults) {
        continue;
      }

      // 2. 가수명 추출 및 유사도 확인
      const recArtist = this.extractArtist(rec.title);
      const recSongTitle = this.extractSongTitle(rec.title);
      const recNormalizedSongTitle = this.normalizeTitle(recSongTitle);
      
      // 2-0. 이전 추천 기록의 가수명과 비교 (새로고침 후 다른 가수 추천을 위해)
      // 대기열이 비어있을 때는 이전 추천 가수명 제외가 더 중요함
      if (recArtist && previousArtists.size > 0) {
        // 정규화된 가수명 사용 (괄호, 대괄호, 공백 제거)
        const recArtistNormalized = this.normalizeArtistName(recArtist);
        
        if (!recArtistNormalized) {
          console.warn(`[RecommendationService] 가수명 정규화 실패: "${rec.title}" → "${recArtist}"`);
        } else {
          console.log(`[RecommendationService] [가수명 체크] "${rec.title}" → 가수: "${recArtist}" → 정규화: "${recArtistNormalized}"`);
          console.log(`[RecommendationService] [가수명 체크] 이전 추천 가수명 목록:`, Array.from(previousArtists));
          
          // 이전 추천 기록의 가수명과 정확히 일치하는지 확인 (정규화된 버전으로)
          if (previousArtists.has(recArtistNormalized)) {
            console.log(`[RecommendationService] ❌ [이전 추천 가수명 제외] 정규화 후 일치: "${rec.title}" (가수: "${recArtist}" → "${recArtistNormalized}")`);
            continue;
          }
          
          // 이전 추천 기록의 가수명과 유사한지 확인 (정규화된 버전으로 비교)
          let isSimilarToPreviousArtist = false;
          let matchedPreviousArtist = null;
          let matchReason = '';
          
          for (const previousArtistNormalized of previousArtists) {
            // 정규화된 가수명끼리 비교
            if (recArtistNormalized === previousArtistNormalized) {
              isSimilarToPreviousArtist = true;
              matchedPreviousArtist = previousArtistNormalized;
              matchReason = '정규화 후 완전 일치';
              break;
            }
            
            // 한 가수명이 다른 가수명을 포함하는지 확인
            if (recArtistNormalized.includes(previousArtistNormalized) || previousArtistNormalized.includes(recArtistNormalized)) {
              const shorter = recArtistNormalized.length < previousArtistNormalized.length ? recArtistNormalized : previousArtistNormalized;
              const longer = recArtistNormalized.length >= previousArtistNormalized.length ? recArtistNormalized : previousArtistNormalized;
              const ratio = shorter.length / longer.length;
              if (ratio >= 0.5) { // 50% 이상 포함되면 유사한 가수로 간주
                isSimilarToPreviousArtist = true;
                matchedPreviousArtist = previousArtistNormalized;
                matchReason = `포함 관계 (${(ratio * 100).toFixed(1)}%)`;
                console.log(`[RecommendationService] ❌ [이전 추천 가수명 제외] 포함 관계: "${rec.title}" (가수: "${recArtist}" → "${recArtistNormalized}") vs "${previousArtistNormalized}" (포함 비율: ${(ratio * 100).toFixed(1)}%)`);
                break;
              }
            }
            
            // 유사도 체크 (원본 가수명으로)
            const artistMatch = this.calculateArtistMatch(recArtist, previousArtistNormalized);
            if (artistMatch >= 0.7) { // 유사도 임계값을 0.8에서 0.7로 낮춤
              isSimilarToPreviousArtist = true;
              matchedPreviousArtist = previousArtistNormalized;
              matchReason = `유사도 높음 (${(artistMatch * 100).toFixed(1)}%)`;
              console.log(`[RecommendationService] ❌ [이전 추천 가수명 제외] 유사도 높음: "${rec.title}" (가수: "${recArtist}" → "${recArtistNormalized}") vs "${previousArtistNormalized}" (유사도: ${(artistMatch * 100).toFixed(1)}%)`);
              break;
            }
          }
          
          if (isSimilarToPreviousArtist) {
            if (!matchReason) {
              console.log(`[RecommendationService] ❌ [이전 추천 가수명 제외] "${rec.title}" (가수: "${recArtist}" → "${recArtistNormalized}") vs "${matchedPreviousArtist}"`);
            }
            continue;
          } else {
            console.log(`[RecommendationService] ✅ [이전 추천 가수명과 다름] "${rec.title}" (가수: "${recArtist}" → "${recArtistNormalized}") - 통과`);
          }
        }
      } else if (!recArtist && previousArtists.size > 0) {
        // 가수명 추출 실패한 경우에도 경고 로그
        console.warn(`[RecommendationService] ⚠️ 가수명 추출 실패 (이전 추천 가수명 제외 체크 불가): "${rec.title}"`);
      } else if (recArtist && previousArtists.size === 0) {
        console.log(`[RecommendationService] ✅ [이전 추천 기록 없음] "${rec.title}" (가수: "${recArtist}") - 통과`);
      }
      
      // 2-1. 가수명이 유사하거나 동일한지 확인 (대기열의 가수들과 비교)
      let hasSimilarArtist = false;
      if (recArtist) {
        for (const queueMusic of queue) {
          const queueArtist = this.extractArtist(queueMusic.title);
          if (queueArtist) {
            const artistMatch = this.calculateArtistMatch(recArtist, queueArtist);
            if (artistMatch >= 0.8) { // 유사하거나 동일한 가수
              hasSimilarArtist = true;
              break;
            }
          }
        }
      }
      
      // 가수명이 유사하거나 동일하지 않으면 제외 (요구사항: 가수명은 유사하거나 동일해야 함)
      // 단, 가수명 추출이 실패한 경우(recArtist가 null)는 제외하지 않음 (다양한 형식 지원)
      if (!hasSimilarArtist && queue.length > 0 && recArtist) {
        console.log(`[RecommendationService] 가수명이 유사하지 않아 제외: "${rec.title}" (가수: ${recArtist})`);
        continue;
      }
      
      // 가수명 추출 실패한 경우 경고만 출력하고 계속 진행
      if (!recArtist && queue.length > 0) {
        console.warn(`[RecommendationService] 가수명 추출 실패 (계속 진행): "${rec.title}"`);
      }

      // 3. 정확히 같은 제목 확인 (가수명 제외, 노래 제목만 비교) - 대기열 + 현재 재생 중인 음악 + 이전 추천 기록 모두 확인
      let isDuplicate = false;
      for (let j = 0; j < allTitles.length; j++) {
        const queueSongTitle = this.extractSongTitle(allTitles[j]);
        const queueNormalizedSongTitle = this.normalizeTitle(queueSongTitle);
        
        if (recNormalizedSongTitle === queueNormalizedSongTitle && recNormalizedSongTitle.length > 0) {
          isDuplicate = true;
          // j < queueTitles.length이면 대기열 또는 현재 재생 중인 음악
          const isCurrentPlaying = j === 0 && queue.length > 0; // 첫 번째 항목이 현재 재생 중인 음악일 가능성
          const source = j < queueTitles.length 
            ? (isCurrentPlaying ? '현재 재생 중인 음악' : '대기열') 
            : '이전 추천';
          console.log(`[RecommendationService] 동일 제목 제외 (가수명 제외, ${source}): "${rec.title}" (제목: "${recSongTitle}") vs "${allTitles[j]}" (제목: "${queueSongTitle}")`);
          break;
        }
      }

      // 4. 제목 유사도 확인 (가수명 제외, 노래 제목만 비교) - 대기열 + 현재 재생 중인 음악 + 이전 추천 기록 모두 확인
      if (!isDuplicate) {
        for (let j = 0; j < allTitles.length; j++) {
          const stringSimilarity = this.calculateTitleSimilarity(rec.title, allTitles[j]);
          if (stringSimilarity >= 0.85) {
            // 문자열 유사도가 높으면 (85% 이상) 제외 (가수명 제외하고 제목만 비교) - 같은 노래의 다른 버전 제외
            isDuplicate = true;
            // j < queueTitles.length이면 대기열 또는 현재 재생 중인 음악
            const isCurrentPlaying = j === 0 && queue.length > 0; // 첫 번째 항목이 현재 재생 중인 음악일 가능성
            const source = j < queueTitles.length 
              ? (isCurrentPlaying ? '현재 재생 중인 음악' : '대기열') 
              : '이전 추천';
            const queueSongTitle = this.extractSongTitle(allTitles[j]);
            console.log(`[RecommendationService] 유사한 제목 제외 (가수명 제외, ${source}): "${rec.title}" (제목: "${recSongTitle}") vs "${allTitles[j]}" (제목: "${queueSongTitle}") (유사도: ${(stringSimilarity * 100).toFixed(1)}%)`);
            break;
          }
        }
      }

      // 5. 임베딩 기반 유사도 확인 (가수명 제외, 노래 제목만 비교) - 대기열 + 이전 추천 기록 모두 확인
      if (!isDuplicate) {
        // 노래 제목만 임베딩 생성하여 비교 (성능 최적화: 배치 처리)
        try {
          // 대기열과 이전 추천의 노래 제목만 추출
          const allSongTitles = allTitles.map(title => this.extractSongTitle(title));
          
          // 노래 제목 임베딩 생성 (배치 처리)
          const allSongTitleEmbeddings = await embeddingService.generateEmbeddings(allSongTitles);
          const recSongTitleEmbedding = await embeddingService.generateEmbedding(recSongTitle);
          
          for (let j = 0; j < allSongTitleEmbeddings.length; j++) {
            const similarity = SimilarityCalculator.cosineSimilarity(
              recSongTitleEmbedding,
              allSongTitleEmbeddings[j]
            );
            
            // 임계값을 더 엄격하게 (0.70 → 0.85) - 같은 노래의 다른 버전 제외
            const effectiveThreshold = Math.max(titleSimilarityThreshold, EMBEDDING_DUPLICATE_THRESHOLD);
            if (similarity >= effectiveThreshold) {
              // 임베딩 유사도가 임계값 이상이면 제외 (가수명 제외하고 제목만 비교)
              isDuplicate = true;
              // j < queueTitleEmbeddings.length이면 대기열 또는 현재 재생 중인 음악
              const isCurrentPlaying = j === 0 && queue.length > 0; // 첫 번째 항목이 현재 재생 중인 음악일 가능성
              const source = j < queueTitleEmbeddings.length 
                ? (isCurrentPlaying ? '현재 재생 중인 음악' : '대기열') 
                : '이전 추천';
              const queueSongTitle = allSongTitles[j];
              console.log(`[RecommendationService] 유사한 제목 제외 (임베딩, 가수명 제외, ${source}): "${rec.title}" (제목: "${recSongTitle}") vs "${allTitles[j]}" (제목: "${queueSongTitle}") (유사도: ${(similarity * 100).toFixed(1)}%)`);
              break;
            }
          }
        } catch (embeddingError) {
          // 임베딩 생성 실패 시 기존 방식 사용 (전체 제목 비교)
          console.warn('[RecommendationService] 노래 제목 임베딩 생성 실패, 전체 제목 비교로 폴백:', embeddingError.message);
          for (let j = 0; j < allTitleEmbeddings.length; j++) {
            const similarity = SimilarityCalculator.cosineSimilarity(
              recEmbedding,
              allTitleEmbeddings[j]
            );
            
            const effectiveThreshold = Math.max(titleSimilarityThreshold, EMBEDDING_DUPLICATE_THRESHOLD);
            if (similarity >= effectiveThreshold) {
              isDuplicate = true;
              const source = j < queueTitleEmbeddings.length ? '대기열' : '이전 추천';
              console.log(`[RecommendationService] 유사한 제목 제외 (임베딩, ${source}): "${rec.title}" vs "${allTitles[j]}" (유사도: ${(similarity * 100).toFixed(1)}%)`);
              break;
            }
          }
        }
      }

      if (!isDuplicate) {
        filtered.push(rec);
        seenVideoIds.add(rec.videoId);
        seenNormalizedTitles.add(recNormalizedTitle);
        // 임베딩이 있는 경우에만 추가
        if (recEmbedding) {
          seenEmbeddings.push(recEmbedding);
        }
      }
    }

    console.log(`[RecommendationService] 중복 제거: ${recommendations.length}개 → ${filtered.length}개 (대기열: ${queue.length}개, 이전 추천: ${previousRecommendations.length}개)`);
    
    // 디버깅: 이전 추천 기록 상세 로그
    if (previousRecommendations.length > 0) {
      console.log('[RecommendationService] 이전 추천 기록 상세:', previousRecommendations.slice(-5).map(rec => ({
        title: rec.title,
        videoId: rec.videoId
      })));
    }
    
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
        this.socket.off('searchResults', resultsHandler);
        reject(new Error('YouTube 검색 타임아웃'));
      }, 30000); // 30초 타임아웃

      // error 이벤트 핸들러는 타임아웃 후에만 처리 (검색 결과가 없는 경우는 에러가 아님)
      let errorHandler = null;
      
      // 여러 검색을 동시에 보내도 결과가 섞이지 않도록 요청마다 id를 붙이고 같은 id의 결과만 받음
      // (id가 있는 결과는 음악 요청 검색 목록에도 표시되지 않음)
      const requestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const resultsHandler = (data) => {
        if (data.requestId !== requestId) return;
        this.socket.off('searchResults', resultsHandler);
        clearTimeout(timeout);
        // error 이벤트 핸들러 제거 (검색 결과를 받았으므로 에러 핸들러 불필요)
        if (errorHandler) {
          this.socket.off('error', errorHandler);
        }
        
        // 검색 결과가 없어도 빈 배열로 resolve (에러가 아님)
        if (data.results && data.results.length > 0) {
          resolve(data.results.slice(0, maxResults));
        } else {
          resolve([]);
        }
      };
      this.socket.on('searchResults', resultsHandler);
      this.socket.emit('searchMusic', { query, requestId });

      // error 이벤트는 실제 네트워크 오류나 서버 오류일 때만 처리
      // 단순히 검색 결과가 없는 경우는 무시
      errorHandler = (error) => {
        // 검색 결과가 없다는 메시지는 무시 (빈 배열로 처리)
        if (error.message && error.message.includes('검색 결과가 없습니다')) {
          clearTimeout(timeout);
          if (errorHandler) {
            this.socket.off('error', errorHandler);
          }
          resolve([]);
          return;
        }
        // 실제 오류인 경우에만 reject
        clearTimeout(timeout);
        if (errorHandler) {
          this.socket.off('error', errorHandler);
        }
        reject(new Error(error.message || 'YouTube 검색 실패'));
      };
      
      this.socket.once('error', errorHandler);
    });
  }

  /**
   * YouTube Data API로 비디오 상세 정보 가져오기 (서버에 요청)
   * @param {string[]} videoIds - 비디오 ID 배열
   * @returns {Promise<Object[]>} 비디오 상세 정보 배열
   */
  async getYouTubeVideoDetails(videoIds) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket 연결이 필요합니다'));
        return;
      }
      if (videoIds.length === 0) {
        resolve([]);
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('YouTube 비디오 상세 정보 조회 타임아웃'));
      }, 15000); // 15초 타임아웃

      this.socket.emit('getVideoDetails', videoIds);

      this.socket.once('videoDetails', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });

      this.socket.once('videoDetailsError', (error) => {
        clearTimeout(timeout);
        reject(new Error(error.message || 'YouTube 비디오 상세 정보 조회 실패'));
      });
    });
  }

  /**
   * YouTube API를 통한 재생 가능 여부 확인 (서버에 요청)
   * @param {string[]} videoIds - 비디오 ID 배열
   * @returns {Promise<Object>} 재생 가능 여부 결과 { videoId: { isPlayable, reason } }
   */
  async checkVideoPlayability(videoIds) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket 연결이 필요합니다'));
        return;
      }
      if (videoIds.length === 0) {
        resolve({});
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('재생 가능 여부 확인 타임아웃'));
      }, 20000); // 20초 타임아웃

      this.socket.emit('checkVideoPlayability', videoIds);

      this.socket.once('playabilityCheckResults', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });

      this.socket.once('playabilityCheckError', (error) => {
        clearTimeout(timeout);
        reject(new Error(error.message || '재생 가능 여부 확인 실패'));
      });
    });
  }

  /**
   * 채널 정보 확인 (공식 채널 우선순위 확인용)
   * @param {string[]} videoIds - 비디오 ID 배열
   * @returns {Promise<Object>} 채널 정보 결과 { videoId: { channelId, channelTitle, channelType, isOfficial, isMusicLabel } }
   */
  async getChannelInfo(videoIds) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket 연결이 필요합니다'));
        return;
      }
      if (videoIds.length === 0) {
        resolve({});
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('채널 정보 확인 타임아웃'));
      }, 15000); // 15초 타임아웃

      this.socket.emit('getChannelInfo', videoIds);

      this.socket.once('channelInfoResults', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });

      this.socket.once('channelInfoError', (error) => {
        clearTimeout(timeout);
        reject(new Error(error.message || '채널 정보 확인 실패'));
      });
    });
  }

  /**
   * 채널 우선순위 점수 계산
   * @param {Object} channelInfo - 채널 정보
   * @returns {number} 채널 우선순위 점수 (0~1)
   */
  calculateChannelPriority(channelInfo) {
    if (!channelInfo) return 0.5; // 기본값
    
    if (channelInfo.isOfficial) {
      return 1.0; // 공식 채널: 최고 점수
    } else if (channelInfo.isMusicLabel) {
      return 0.8; // 음악 레이블: 높은 점수
    } else if (channelInfo.channelType === 'user') {
      return 0.5; // 사용자 업로드: 중간 점수
    }
    
    return 0.5; // 기본값
  }

  /**
   * 추천 생성 (메인 메서드)
   * @param {Array} queue - 현재 대기열
   * @param {Object} musicLikes - 좋아요 데이터 { videoId: count }
   * @param {string} searchQuery - 선택적 검색어
   * @param {string} musicRegion - 음악 지역 기준 ('all', 'domestic', 'international')
   * @returns {Promise<Object>} 추천 결과
   */
  async generateRecommendations(queue, musicLikes, searchQuery = null, musicRegion = 'all') {
    const startTime = Date.now();

    try {
      // 1. 상위 하트 음악 선택
      const topSongs = this.getTopLikedSongs(queue, musicLikes, 10);
      
      // 대기열이 비어있으면 기본 장르(발라드)로 조회순 추천
      if (topSongs.length === 0) {
        console.log('[RecommendationService] 대기열이 비어있어 기본 장르(발라드)로 조회순 추천을 시작합니다.');
        
        // 기본 장르(발라드) 검색 쿼리 생성
        let defaultQueries = [];
        if (musicRegion === 'domestic') {
          // 국내 발라드
          defaultQueries = [
            'korean ballad 발라드',
            'korean ballad songs',
            'k-pop ballad 발라드',
            '한국 발라드',
            '국내 발라드'
          ];
        } else if (musicRegion === 'international') {
          // 해외 발라드
          defaultQueries = [
            'ballad songs',
            'popular ballad',
            'best ballad',
            'ballad music',
            'ballad hits'
          ];
        } else {
          // 전체 (국내 + 해외)
          defaultQueries = [
            'ballad 발라드',
            'ballad songs',
            'popular ballad',
            'best ballad',
            'korean ballad',
            'ballad music'
          ];
        }
        
        // 검색 실행
        let allSearchResults = [];
        for (const query of defaultQueries.slice(0, 5)) {
          try {
            const results = await this.searchYouTube(query, 30);
            allSearchResults.push(...results);
            console.log(`[RecommendationService] 기본 장르 검색 쿼리 "${query}" 결과: ${results.length}개`);
          } catch (error) {
            console.warn(`[RecommendationService] 기본 장르 검색 쿼리 실패: ${query}`, error);
          }
        }
        
        // videoId 기준으로 중복 제거
        const uniqueResultsMap = new Map();
        for (const result of allSearchResults) {
          if (!uniqueResultsMap.has(result.videoId)) {
            uniqueResultsMap.set(result.videoId, result);
          }
        }
        
        let searchResults = Array.from(uniqueResultsMap.values());
        console.log(`[RecommendationService] 기본 장르 검색 결과: ${searchResults.length}개`);
        
        if (searchResults.length === 0) {
          return {
            recommendations: [],
            topSongs: [],
            reasoning: '기본 장르(발라드) 검색 결과가 없습니다.',
            processingTime: Date.now() - startTime,
          };
        }
        
        // 필터링: 모음집, 쇼츠, 재생 불가능한 음악 제외
        searchResults = searchResults.filter(result => 
          !this.isCompilation(result) && 
          !this.isShorts(result) && 
          this.isPlayableMusic(result)
        );
        
        // 국내/해외 필터링 적용
        if (musicRegion === 'domestic') {
          const beforeCount = searchResults.length;
          searchResults = searchResults.filter(result => {
            const extractedArtist = this.extractArtist(result.title);
            return this.isDomesticMusic(result.title, extractedArtist);
          });
          const filteredCount = beforeCount - searchResults.length;
          if (filteredCount > 0) {
            console.log(`[RecommendationService] 국내 음악만 필터링: ${filteredCount}개 제외`);
          }
        } else if (musicRegion === 'international') {
          const beforeCount = searchResults.length;
          searchResults = searchResults.filter(result => {
            const extractedArtist = this.extractArtist(result.title);
            return !this.isDomesticMusic(result.title, extractedArtist);
          });
          const filteredCount = beforeCount - searchResults.length;
          if (filteredCount > 0) {
            console.log(`[RecommendationService] 해외 음악만 필터링: ${filteredCount}개 제외`);
          }
        }
        
        // YouTube API를 통한 재생 가능 여부 확인
        if (searchResults.length > 0) {
          try {
            const videoIds = searchResults.map(result => result.videoId);
            const playabilityResults = await this.checkVideoPlayability(videoIds);
            
            searchResults = searchResults.filter(result => {
              const checkResult = playabilityResults[result.videoId];
              if (checkResult && !checkResult.isPlayable) {
                return false;
              }
              return true;
            });
          } catch (error) {
            console.warn('[RecommendationService] 재생 가능 여부 확인 실패:', error);
          }
        }
        
        // YouTube Data API로 조회수 정보 가져오기 (조회순 정렬용)
        let videoDetailsMap = new Map();
        try {
          const videoIds = searchResults.map(res => res.videoId);
          const details = await this.getYouTubeVideoDetails(videoIds);
          details.forEach(d => {
            videoDetailsMap.set(d.videoId, d);
          });
          console.log('[RecommendationService] YouTube Data API로 조회수 정보 가져옴.');
        } catch (apiError) {
          console.warn('[RecommendationService] YouTube Data API 호출 실패:', apiError.message);
        }
        
        // 조회수 기준으로 정렬 (조회순)
        searchResults.sort((a, b) => {
          const detailA = videoDetailsMap.get(a.videoId);
          const detailB = videoDetailsMap.get(b.videoId);
          
          // 조회수 정보가 있으면 조회수 기준 정렬
          if (detailA && detailB && detailA.viewCount !== undefined && detailB.viewCount !== undefined) {
            return detailB.viewCount - detailA.viewCount; // 내림차순 (조회수 높은 순)
          }
          
          // 조회수 정보가 없으면 검색 결과 순서 유지
          return 0;
        });
        
        // 이전 추천 가수명 제외 필터링 (대기열이 비어있을 때)
        // filterDuplicates를 호출하여 이전 추천 기록의 가수명을 제외
        console.log(`[RecommendationService] ========== 대기열이 비어있어 이전 추천 가수명 제외 필터링 시작 ==========`);
        console.log(`[RecommendationService] 검색 결과: ${searchResults.length}개`);
        
        // 검색 결과의 가수명 미리 확인 (디버깅용)
        const searchResultArtists = searchResults.slice(0, 10).map(rec => {
          const artist = this.extractArtist(rec.title);
          const normalized = artist ? this.normalizeArtistName(artist) : null;
          return { title: rec.title, artist: artist || '추출 실패', normalized: normalized || '정규화 실패' };
        });
        console.log(`[RecommendationService] 검색 결과 상위 10개 가수명:`, searchResultArtists);
        
        const filteredRecommendations = await this.filterDuplicates(searchResults, queue, 0.70);
        console.log(`[RecommendationService] 이전 추천 가수명 제외 필터링 완료: ${searchResults.length}개 → ${filteredRecommendations.length}개`);
        
        // 필터링된 결과의 가수명 확인 (디버깅용)
        if (filteredRecommendations.length > 0) {
          const filteredArtists = filteredRecommendations.slice(0, 10).map(rec => {
            const artist = this.extractArtist(rec.title);
            const normalized = artist ? this.normalizeArtistName(artist) : null;
            return { title: rec.title, artist: artist || '추출 실패', normalized: normalized || '정규화 실패' };
          });
          console.log(`[RecommendationService] 필터링 후 상위 10개 가수명:`, filteredArtists);
        }
        
        // 필터링 후에도 결과가 없으면 필터링 없이 상위 20개 선택 (폴백)
        let recommendations;
        if (filteredRecommendations.length > 0) {
          // 대기열에 있는 노래를 확실히 제거
          const queueVideoIdsSet = new Set(queue.map(m => m.videoId || m.id).filter(id => id != null));
          const recommendationsBeforeQueueFilter = filteredRecommendations.slice(0, 20);
          recommendations = recommendationsBeforeQueueFilter.filter(rec => {
            const recVideoId = rec.videoId || rec.id;
            if (!recVideoId) return false;
            if (queueVideoIdsSet.has(recVideoId)) {
              console.log(`[RecommendationService] 기본 장르 추천: 대기열에 있는 노래 제외 "${rec.title}" (${recVideoId})`);
              return false;
            }
            return true;
          });
          console.log(`[RecommendationService] 기본 장르(발라드) 조회순 추천 결과 (이전 추천 가수명 제외, 대기열 필터링): ${recommendations.length}개 (필터링 전: ${recommendationsBeforeQueueFilter.length}개)`);
          
          // 추천된 가수명 로그 출력 (디버깅용)
          const recommendedArtists = recommendations.map(rec => {
            const artist = this.extractArtist(rec.title);
            const normalized = artist ? this.normalizeArtistName(artist) : null;
            return { title: rec.title, artist: artist || '추출 실패', normalized: normalized || '정규화 실패' };
          });
          console.log(`[RecommendationService] ========== 최종 추천된 가수명 목록 (이전 추천 가수명 제외됨) ==========`, recommendedArtists);
        } else {
          // 필터링 결과가 없으면 필터링 없이 상위 20개 선택 (하지만 대기열은 제외)
          const queueVideoIdsSet = new Set(queue.map(m => m.videoId || m.id).filter(id => id != null));
          const recommendationsBeforeQueueFilter = searchResults.slice(0, 20);
          recommendations = recommendationsBeforeQueueFilter.filter(rec => {
            const recVideoId = rec.videoId || rec.id;
            if (!recVideoId) return false;
            if (queueVideoIdsSet.has(recVideoId)) {
              console.log(`[RecommendationService] 기본 장르 추천 (폴백): 대기열에 있는 노래 제외 "${rec.title}" (${recVideoId})`);
              return false;
            }
            return true;
          });
          console.warn(`[RecommendationService] ⚠️ 이전 추천 가수명 제외 필터링 후 결과가 없어 필터링 없이 추천합니다 (대기열 제외): ${recommendations.length}개 (필터링 전: ${recommendationsBeforeQueueFilter.length}개)`);
          
          // 필터링 없이 추천된 가수명 로그 출력 (디버깅용)
          const recommendedArtists = recommendations.map(rec => {
            const artist = this.extractArtist(rec.title);
            const normalized = artist ? this.normalizeArtistName(artist) : null;
            return { title: rec.title, artist: artist || '추출 실패', normalized: normalized || '정규화 실패' };
          });
          console.warn(`[RecommendationService] ⚠️ 필터링 없이 추천된 가수명 목록:`, recommendedArtists);
        }
        
        // 최종적으로 대기열에 있는 노래가 있는지 한 번 더 확인
        const queueVideoIdsSet = new Set(queue.map(m => m.videoId || m.id).filter(id => id != null));
        const recommendationsBeforeFinalCheck = recommendations;
        const finalRecommendations = recommendationsBeforeFinalCheck.filter(rec => {
          const recVideoId = rec.videoId || rec.id;
          if (!recVideoId) return false;
          if (queueVideoIdsSet.has(recVideoId)) {
            console.log(`[RecommendationService] 기본 장르 최종 확인: 대기열에 있는 노래 제외 "${rec.title}" (${recVideoId})`);
            return false;
          }
          return true;
        });
        
        console.log(`[RecommendationService] 기본 장르(발라드) 조회순 추천 결과: ${finalRecommendations.length}개 (최종 확인: ${recommendationsBeforeFinalCheck.length}개 → ${finalRecommendations.length}개)`);
        
        return {
          recommendations: finalRecommendations,
          topSongs: [],
          reasoning: `대기열이 비어있어 기본 장르(발라드)로 조회순 추천했습니다. (${musicRegion === 'domestic' ? '국내' : musicRegion === 'international' ? '해외' : '전체'})`,
          processingTime: Date.now() - startTime,
        };
      }

      // 2. 각 음악 제목 임베딩 생성
      const titles = topSongs.map(song => song.title);
      const embeddings = await embeddingService.generateEmbeddings(titles);

      // 3. 가중 평균 임베딩 계산
      // 하트가 있는 경우: 하트 개수 사용
      // 하트가 없는 경우: 대기열 순서에 따른 가중치 사용 (앞에 있는 곡일수록 높은 가중치)
      const totalLikes = topSongs.reduce((sum, song) => sum + (song.likeCount || 0), 0);
      const hasLikes = totalLikes > 0;
      
      const weights = topSongs.map((song, index) => {
        if (hasLikes) {
          // 하트가 있는 경우: 하트 개수 사용 (0인 경우 0.1로 설정)
          return song.likeCount || 0.1;
        } else {
          // 하트가 없는 경우: 대기열 순서에 따른 가중치 (앞에 있는 곡일수록 높은 가중치)
          // 첫 번째 곡: 1.0, 두 번째 곡: 0.9, 세 번째 곡: 0.8, ... (0.1씩 감소, 최소 0.1)
          const queueWeight = Math.max(0.1, 1.0 - (index * 0.1));
          return queueWeight;
        }
      });
      
      if (!hasLikes) {
        console.log('[RecommendationService] 하트가 없어 대기열 순서 가중치를 사용합니다:', weights);
      }
      
      const weightedEmbedding = SimilarityCalculator.calculateWeightedAverage(
        embeddings,
        weights
      );

      // 4. YouTube 검색 실행 (다양한 검색 쿼리 사용)
      let searchResults = [];
      let allSearchResults = []; // 폴백을 위해 스코프 밖에서도 접근 가능하도록
      
      if (searchQuery) {
        // 사용자 지정 검색어가 있으면 그것만 사용
        searchResults = await this.searchYouTube(searchQuery, 50);
        allSearchResults = searchResults; // 폴백용
      } else {
        // 이전 추천 가수명 가져오기 (검색 쿼리 생성 시 제외하기 위해)
        const previousRecommendations = this.getPreviousRecommendations();
        const previousArtists = new Set();
        previousRecommendations.forEach(rec => {
          const artist = this.extractArtist(rec.title);
          if (artist) {
            const normalizedArtist = this.normalizeArtistName(artist);
            if (normalizedArtist) {
              previousArtists.add(normalizedArtist);
            }
          }
        });
        console.log('[RecommendationService] 검색 쿼리 생성 시 제외할 이전 추천 가수명:', Array.from(previousArtists));
        
        // 다양한 검색 쿼리 생성 및 병합 (지역 필터 포함, 이전 추천 가수명 제외)
        const searchQueries = this.generateDiverseSearchQueries(topSongs, musicRegion, previousArtists);
        console.log('[RecommendationService] 생성된 검색 쿼리:', searchQueries, `(지역: ${musicRegion})`);
        
        // 여러 검색 쿼리로 검색 결과 수집 (아티스트 기반 검색 우선)
        allSearchResults = [];
        // 아티스트 기반 검색 쿼리를 우선적으로 더 많이 사용 (최대 8개로 증가)
        for (const query of searchQueries.slice(0, 8)) {
          try {
            const results = await this.searchYouTube(query, 30);
            allSearchResults.push(...results);
            console.log(`[RecommendationService] 검색 쿼리 "${query}" 결과: ${results.length}개`);
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
        console.log(`[RecommendationService] 병합된 검색 결과: ${searchResults.length}개 (원본: ${allSearchResults.length}개)`);
        
        // 검색 결과가 없으면 에러
        if (searchResults.length === 0) {
          console.error('[RecommendationService] 검색 결과가 없습니다.');
          return {
            recommendations: [],
            topSongs,
            reasoning: '검색 결과가 없습니다. 다른 검색어를 시도해주세요.',
            processingTime: Date.now() - startTime,
          };
        }
      }

      // 모음집/플레이리스트 필터링
      let filteredSearchResults = searchResults.filter(result => !this.isCompilation(result));
      const compilationCount = searchResults.length - filteredSearchResults.length;
      if (compilationCount > 0) {
        console.log(`[RecommendationService] 모음집 제외: ${compilationCount}개`);
      }

      // 쇼츠 필터링
      const beforeShortsCount = filteredSearchResults.length;
      filteredSearchResults = filteredSearchResults.filter(result => !this.isShorts(result));
      const shortsFilteredCount = beforeShortsCount - filteredSearchResults.length;
      if (shortsFilteredCount > 0) {
        console.log(`[RecommendationService] 쇼츠 제외: ${shortsFilteredCount}개`);
      }

      // 재생 가능한 음악만 필터링 (기본 필드 검증)
      const beforePlayableCount = filteredSearchResults.length;
      filteredSearchResults = filteredSearchResults.filter(result => this.isPlayableMusic(result));
      const playableFilteredCount = beforePlayableCount - filteredSearchResults.length;
      if (playableFilteredCount > 0) {
        console.log(`[RecommendationService] 기본 필드 검증으로 제외: ${playableFilteredCount}개`);
      }

      // YouTube API를 통한 실제 재생 가능 여부 확인 (배치 처리)
      // API 확인 실패 시에도 기본 검증 결과는 유지하도록 수정
      if (filteredSearchResults.length > 0) {
        try {
          const videoIds = filteredSearchResults.map(result => result.videoId);
          const playabilityResults = await this.checkVideoPlayability(videoIds);
          
          const beforeApiCheckCount = filteredSearchResults.length;
          filteredSearchResults = filteredSearchResults.filter(result => {
            const checkResult = playabilityResults[result.videoId];
            // checkResult가 없으면 재생 가능한 것으로 간주 (API 응답에 없어도 기본 검증 통과)
            if (checkResult && !checkResult.isPlayable) {
              console.log(`[RecommendationService] 재생 불가능한 영상 제외: "${result.title}" (${checkResult.reason})`);
              return false;
            }
            // checkResult가 없거나 isPlayable이 true면 포함
            return true;
          });
          
          const apiFilteredCount = beforeApiCheckCount - filteredSearchResults.length;
          if (apiFilteredCount > 0) {
            console.log(`[RecommendationService] YouTube API 재생 가능 여부 확인으로 제외: ${apiFilteredCount}개`);
          }
          
          // 필터링 후 결과가 없으면 경고
          if (filteredSearchResults.length === 0 && beforeApiCheckCount > 0) {
            console.warn(`[RecommendationService] 재생 가능 여부 확인 후 모든 결과가 제외됨. 기본 검증 결과로 폴백합니다.`);
            // 기본 검증 결과로 폴백 (API 확인 전 상태로 복원)
            filteredSearchResults = searchResults.filter(result => 
              this.isPlayableMusic(result) && 
              !this.isCompilation(result) && 
              !this.isShorts(result)
            );
          }
        } catch (apiError) {
          console.warn('[RecommendationService] 재생 가능 여부 확인 실패, 기본 검증만 사용:', apiError.message);
          // API 확인 실패 시 기본 검증 결과만 사용 (이미 filteredSearchResults에 있음)
        }
      }
      
      // 필터링 후 결과 확인
      if (filteredSearchResults.length === 0) {
        console.warn('[RecommendationService] 필터링 후 검색 결과가 없습니다. 필터링 조건을 완화합니다.');
        // 필터링 조건 완화: 기본 필드 검증만 통과한 결과 사용
        filteredSearchResults = searchResults.filter(result => this.isPlayableMusic(result));
        console.log(`[RecommendationService] 완화된 필터링 후 결과: ${filteredSearchResults.length}개`);
      }

      // 단일 곡 검증 필터링 (라이브, 커버, 리믹스, 뮤직비디오 등 제외)
      // 단, 결과가 너무 적으면 필터링 완화
      const beforeSingleTrackCount = filteredSearchResults.length;
      const singleTrackFiltered = filteredSearchResults.filter(result => this.isValidSingleTrack(result));
      const singleTrackFilteredCount = beforeSingleTrackCount - singleTrackFiltered.length;
      
      // 필터링 후 결과가 충분하면(5개 이상) 적용, 아니면 완화
      if (singleTrackFiltered.length >= 5 || beforeSingleTrackCount < 15) {
        filteredSearchResults = singleTrackFiltered;
        if (singleTrackFilteredCount > 0) {
          console.log(`[RecommendationService] 단일 곡이 아닌 항목 제외: ${singleTrackFilteredCount}개`);
        }
      } else {
        console.warn(`[RecommendationService] 단일 곡 필터링 후 결과가 부족(${singleTrackFiltered.length}개). 필터링을 완화합니다.`);
        // 필터링 완화: 가장 명확한 제외 키워드만 체크 (MV는 제외하지 않음)
        filteredSearchResults = filteredSearchResults.filter(result => {
          if (!result || !result.title) return false;
          const title = result.title.toLowerCase();
          // 가장 명확한 제외 키워드만 체크 (모음집, 버스킹, 직캠 등)
          const strictExcludeKeywords = [
            'playlist', '모음', 'collection', 'anthology', 'compilation',
            'busking', '직캠', '버스킹', 'live concert', 'live performance',
            'cover', 'remix', '커버', '리믹스'
          ];
          return !strictExcludeKeywords.some(keyword => title.includes(keyword));
        });
        console.log(`[RecommendationService] 완화된 단일 곡 필터링 후 결과: ${filteredSearchResults.length}개`);
      }

      // 지역 필터 적용 (모음집 및 단일 곡 필터링 후)
      // 채널 정보는 나중에 가져오므로, 먼저 제목/아티스트 기준으로 필터링
      if (musicRegion === 'domestic') {
        // 국내 음악만 필터링 (한국 가수 기준)
        const beforeCount = filteredSearchResults.length;
        filteredSearchResults = filteredSearchResults.filter(result => {
          const extractedArtist = this.extractArtist(result.title);
          return this.isDomesticMusic(result.title, extractedArtist);
        });
        const filteredCount = beforeCount - filteredSearchResults.length;
        if (filteredCount > 0) {
          console.log(`[RecommendationService] 국내 음악만 필터링 (한국 가수 기준, 1차): ${filteredCount}개 제외`);
        }
      } else if (musicRegion === 'international') {
        // 해외 음악만 필터링 (외국 가수 기준)
        const beforeCount = filteredSearchResults.length;
        filteredSearchResults = filteredSearchResults.filter(result => {
          const extractedArtist = this.extractArtist(result.title);
          return !this.isDomesticMusic(result.title, extractedArtist);
        });
        const filteredCount = beforeCount - filteredSearchResults.length;
        if (filteredCount > 0) {
          console.log(`[RecommendationService] 해외 음악만 필터링 (외국 가수 기준, 1차): ${filteredCount}개 제외`);
        }
      }

      searchResults = filteredSearchResults;

      if (searchResults.length === 0) {
        console.error('[RecommendationService] 모든 필터링 단계를 통과한 검색 결과가 없습니다.');
        // 원본 검색 결과로 폴백 시도
        if (allSearchResults && allSearchResults.length > 0) {
          console.warn('[RecommendationService] 필터링 전 검색 결과로 폴백합니다.');
          // videoId 기준으로 중복 제거
          const uniqueResultsMap = new Map();
          for (const result of allSearchResults) {
            if (!uniqueResultsMap.has(result.videoId)) {
              uniqueResultsMap.set(result.videoId, result);
            }
          }
          // 대기열에 있는 노래는 제외
          const queueVideoIdsSet = new Set(queue.map(m => m.videoId || m.id).filter(id => id != null));
          const fallbackResults = Array.from(uniqueResultsMap.values()).filter(result => {
            const recVideoId = result.videoId || result.id;
            return recVideoId && !queueVideoIdsSet.has(recVideoId);
          });
          searchResults = fallbackResults.slice(0, 50); // 원본 검색 결과 사용 (대기열 제외)
          console.log(`[RecommendationService] 폴백 검색 결과: ${searchResults.length}개 (대기열 제외 후)`);
        } else {
          console.error('[RecommendationService] 원본 검색 결과도 없습니다.');
          return {
            recommendations: [],
            topSongs,
            reasoning: '검색 결과가 없습니다. 필터링 조건을 완화하거나 다른 검색어를 시도해주세요.',
            processingTime: Date.now() - startTime,
          };
        }
      }
      
      console.log(`[RecommendationService] 필터링 완료, 최종 검색 결과: ${searchResults.length}개`);
      
      console.log(`[RecommendationService] 필터링 완료, 최종 검색 결과: ${searchResults.length}개`);

      // 5. 검색 결과 임베딩 생성
      const searchTitles = searchResults.map(result => result.title);
      const searchEmbeddings = await embeddingService.generateEmbeddings(searchTitles);

      // 6. 유사도 계산
      const similarities = SimilarityCalculator.calculateSimilarityScores(
        weightedEmbedding,
        searchEmbeddings
      );

      // 7. 인기도 점수 계산 (YouTube Data API 또는 검색 결과 순서)
      let videoDetailsMap = new Map();
      try {
        const videoIds = searchResults.map(res => res.videoId);
        const details = await this.getYouTubeVideoDetails(videoIds);
        details.forEach(d => {
          videoDetailsMap.set(d.videoId, d);
          // 재생 가능 여부 정보도 함께 저장
          if (d.isPlayable !== undefined) {
            if (!d.isPlayable) {
              console.log(`[RecommendationService] 재생 불가능한 영상 발견 (인기도 조회 중): ${d.videoId}`);
            }
          }
        });
        console.log('[RecommendationService] YouTube Data API로 인기도 정보 가져옴.');
      } catch (apiError) {
        console.warn('[RecommendationService] YouTube Data API 호출 실패, 검색 결과 순서로 폴백:', apiError.message);
      }

      const popularityScores = searchResults.map((result, index) => {
        const detail = videoDetailsMap.get(result.videoId);
        if (detail && detail.viewCount !== undefined && detail.publishedAt) {
          // 방법 1: YouTube Data API 기반 (조회수 우선)
          return this.calculatePopularityByViewCount(
            detail.viewCount,
            detail.publishedAt
          );
        } else {
          // 방법 2: 검색 결과 순서 기반 (폴백)
          return this.calculatePopularityByIndex(index);
        }
      });

      // 8. 아티스트 일치 점수 계산 및 추출 (하트 수 가중치 적용)
      // 아티스트별 하트 수 집계
      const artistLikeCounts = new Map();
      topSongs.forEach(song => {
        const artist = this.extractArtist(song.title);
        if (artist) {
          const currentCount = artistLikeCounts.get(artist) || 0;
          artistLikeCounts.set(artist, currentCount + (song.likeCount || 0));
        }
      });
      
      // 하트 수 기준으로 정렬된 아티스트 목록 (하트가 많은 순)
      const sortedArtists = Array.from(artistLikeCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([artist]) => artist);
      
      // 최대 하트 수 계산 (정규화용)
      const maxLikeCount = Math.max(...Array.from(artistLikeCounts.values()), 1);
      
      const artistMatches = searchResults.map((result) => {
        const resultArtist = this.extractArtist(result.title);
        
        if (!resultArtist || sortedArtists.length === 0) {
          return 0;
        }

        // 아티스트 일치 확인 및 하트 수 기반 가중치 적용
        let maxMatchScore = 0;
        for (const artist of sortedArtists) {
          if (this.calculateArtistMatch(artist, resultArtist) > 0) {
            // 하트 수에 비례한 점수 계산 (0.5 ~ 1.0)
            const artistLikeCount = artistLikeCounts.get(artist) || 0;
            const normalizedLikeCount = artistLikeCount / maxLikeCount;
            // 하트가 많을수록 높은 점수 (최소 0.5, 최대 1.0)
            const matchScore = 0.5 + (normalizedLikeCount * 0.5);
            maxMatchScore = Math.max(maxMatchScore, matchScore);
          }
        }

        return maxMatchScore;
      });
      
      console.log('[RecommendationService] 아티스트별 하트 수:', Array.from(artistLikeCounts.entries()).slice(0, 5));

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

      // 8-2. 채널 정보 확인 (공식 채널 우선순위 확인용 및 국내/해외 재확인)
      let channelInfoMap = new Map();
      try {
        const videoIds = searchResults.map(res => res.videoId);
        const channelInfos = await this.getChannelInfo(videoIds);
        Object.entries(channelInfos).forEach(([videoId, info]) => {
          channelInfoMap.set(videoId, info);
        });
        console.log('[RecommendationService] YouTube Data API로 채널 정보 가져옴.');
        
        // 채널 정보를 활용한 국내/해외 재필터링 (더 정확한 판단)
        if (musicRegion === 'domestic') {
          const beforeChannelFilterCount = searchResults.length;
          searchResults = searchResults.filter(result => {
            const channelInfo = channelInfoMap.get(result.videoId);
            const extractedArtist = this.extractArtist(result.title);
            // 채널 정보를 포함하여 재확인
            return this.isDomesticMusic(result.title, extractedArtist, channelInfo);
          });
          const channelFilteredCount = beforeChannelFilterCount - searchResults.length;
          if (channelFilteredCount > 0) {
            console.log(`[RecommendationService] 국내 음악만 필터링 (채널 정보 기준, 2차): ${channelFilteredCount}개 제외`);
          }
        } else if (musicRegion === 'international') {
          const beforeChannelFilterCount = searchResults.length;
          searchResults = searchResults.filter(result => {
            const channelInfo = channelInfoMap.get(result.videoId);
            const extractedArtist = this.extractArtist(result.title);
            // 채널 정보를 포함하여 재확인
            return !this.isDomesticMusic(result.title, extractedArtist, channelInfo);
          });
          const channelFilteredCount = beforeChannelFilterCount - searchResults.length;
          if (channelFilteredCount > 0) {
            console.log(`[RecommendationService] 해외 음악만 필터링 (채널 정보 기준, 2차): ${channelFilteredCount}개 제외`);
          }
        }
      } catch (channelError) {
        console.warn('[RecommendationService] 채널 정보 확인 실패, 기본값 사용:', channelError.message);
        // 채널 정보 확인 실패 시 기본값 사용
      }

      // 아티스트 및 장르 정보를 결과에 저장 (다양성 계산용)
      const searchResultsWithArtists = searchResults.map((result, index) => {
        const channelInfo = channelInfoMap.get(result.videoId);
        const channelPriority = this.calculateChannelPriority(channelInfo);
        
        return {
          ...result,
          extractedArtist: this.extractArtist(result.title),
          artistMatch: artistMatches[index],
          genreMatch: genreMatches[index],
          qualityBonus: this.calculateQualityBonus(result.title), // 음질 보너스 계산
          channelInfo: channelInfo, // 채널 정보 저장
          channelPriority: channelPriority, // 채널 우선순위 점수
        };
      });

      // 9. 최종 점수 계산 (다양성 보너스 및 제목 차별화 보너스 포함)
      const scoredResults = [];
      const selectedArtists = []; // 다양성 계산을 위한 선택된 아티스트 추적
      
      // 대기열 제목 배열 생성 (제목 차별화 보너스 계산용)
      const queueTitles = queue.map(music => music.title);
      
      // 먼저 점수 계산 (다양성 보너스 및 제목 차별화 보너스 없이)
      const initialScoredResults = searchResultsWithArtists.map((result, index) => {
        // 제목 차별화 보너스 계산 (같은 가수지만 다른 제목이면 보너스)
        const titleDiversityBonus = this.calculateTitleDiversityBonus(result.title, queueTitles);
        
        return {
          ...result,
          similarity: similarities[index],
          popularityScore: popularityScores[index],
          titleDiversityBonus: titleDiversityBonus, // 제목 차별화 보너스 저장
          initialScore: this.calculateFinalScore(
            similarities[index],
            result.artistMatch,
            popularityScores[index],
            0, // 다양성 보너스는 나중에 추가
            result.genreMatch, // 장르 일치 점수 포함
            musicRegion, // 지역 기준 전달
            result.qualityBonus, // 음질 보너스 포함
            result.channelPriority // 채널 우선순위 포함
          ),
        };
      });
      
      // 점수 기준으로 정렬 (다양성 보너스 및 제목 차별화 보너스 적용 전)
      initialScoredResults.sort((a, b) => b.initialScore - a.initialScore);
      
      // 다양성 보너스 및 제목 차별화 보너스를 적용하여 최종 점수 계산
      for (const result of initialScoredResults) {
        const diversityBonus = this.calculateDiversityBonus(
          result.extractedArtist,
          selectedArtists
        );
        
        // 제목 차별화 보너스 가중치 (같은 가수지만 다른 제목이면 높은 점수)
        const titleDiversityWeight = 0.15; // 15% 가중치
        
        // 최종 점수 = initialScore + (diversityBonus * 가중치) + (titleDiversityBonus * 가중치)
        const diversityWeight = 0.08; // 같은 가수만 반복 추천되지 않도록 다양성 비중 상향 (기존 2~5%)
        // 보너스를 더해도 100%를 넘지 않도록 0~1로 제한
        const finalScore = Math.max(0, Math.min(1, result.initialScore
          + (diversityBonus * diversityWeight)
          + (result.titleDiversityBonus * titleDiversityWeight)));
        
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

      // 11. 중복 제거 (videoId + 제목 유사도 확인, 임계값 강화: 0.85) - 같은 노래의 다른 버전 제외
      // 이전 추천 기록도 포함하여 중복 제거
      const uniqueResults = await this.filterDuplicates(scoredResults, queue, 0.85);
      console.log(`[RecommendationService] 중복 제거 완료: ${scoredResults.length}개 → ${uniqueResults.length}개`);

      // 11-1. 최종 재생 가능 여부 확인 (상위 추천 결과에 대해)
      // 단, 결과가 부족하면 필터링 완화
      let finalRecommendations = uniqueResults.slice(0, 30); // 상위 30개에 대해 재생 가능 여부 확인
      if (finalRecommendations.length > 0) {
        try {
          const finalVideoIds = finalRecommendations.map(rec => rec.videoId);
          const finalPlayabilityResults = await this.checkVideoPlayability(finalVideoIds);
          
          const beforeFinalCheckCount = finalRecommendations.length;
          const playableFiltered = finalRecommendations.filter(rec => {
            const checkResult = finalPlayabilityResults[rec.videoId];
            if (checkResult && !checkResult.isPlayable) {
              console.log(`[RecommendationService] 최종 재생 불가능한 영상 제외: "${rec.title}" (${checkResult.reason})`);
              return false;
            }
            // checkResult가 없으면 기본 검증만 통과한 것으로 간주 (API 실패 시 포함)
            return true;
          });
          
          const finalFilteredCount = beforeFinalCheckCount - playableFiltered.length;
          
          // 필터링 후 결과가 충분하면(5개 이상) 적용, 아니면 완화
          if (playableFiltered.length >= 5 || beforeFinalCheckCount < 10) {
            finalRecommendations = playableFiltered;
            if (finalFilteredCount > 0) {
              console.log(`[RecommendationService] 최종 재생 가능 여부 확인으로 제외: ${finalFilteredCount}개`);
            }
          } else {
            console.warn(`[RecommendationService] 최종 재생 가능 여부 확인 후 결과가 부족(${playableFiltered.length}개). 필터링을 완화합니다.`);
            // 필터링 완화: checkResult가 없거나 isPlayable이 true면 포함
            finalRecommendations = finalRecommendations.filter(rec => {
              const checkResult = finalPlayabilityResults[rec.videoId];
              // checkResult가 없거나 isPlayable이 true면 포함
              return !checkResult || checkResult.isPlayable !== false;
            });
            console.log(`[RecommendationService] 완화된 최종 필터링 후 결과: ${finalRecommendations.length}개`);
          }
        } catch (finalApiError) {
          console.warn('[RecommendationService] 최종 재생 가능 여부 확인 실패, 기본 검증 결과만 사용:', finalApiError.message);
          // API 확인 실패 시 기본 검증 결과만 사용
        }
      }
      
      // 최종 결과 확인 및 폴백 로직
      console.log(`[RecommendationService] 최종 필터링 전 상태: uniqueResults=${uniqueResults.length}개, finalRecommendations=${finalRecommendations.length}개`);
      
      if (finalRecommendations.length === 0) {
        if (uniqueResults.length === 0) {
          console.warn('[RecommendationService] 모든 추천 결과가 대기열이나 이전 추천에 있어 추천할 수 없습니다.');
          console.warn('[RecommendationService] 이전 추천 기록 일부를 무시하고 재시도합니다.');
          
          // 이전 추천 기록을 일부 무시하고 재시도 (최근 10개만 체크)
          const previousRecommendations = this.getPreviousRecommendations();
          const recentRecommendations = previousRecommendations.slice(-10); // 최근 10개만
          
          // 이전 추천 기록을 줄여서 다시 중복 제거 시도
          const relaxedUniqueResults = await this.filterDuplicatesWithLimitedHistory(
            scoredResults, 
            queue, 
            0.70,
            recentRecommendations // 최근 10개만 체크
          );
          
          if (relaxedUniqueResults.length > 0) {
            console.log(`[RecommendationService] 이전 추천 기록 완화 후 결과: ${relaxedUniqueResults.length}개`);
            finalRecommendations = relaxedUniqueResults.slice(0, 20);
          } else {
            // 그래도 없으면 scoredResults에서 상위 결과 사용 (중복 체크 완화)
            console.warn('[RecommendationService] 완화된 중복 제거 후에도 결과가 없습니다. 점수 기준 상위 결과를 사용합니다.');
            finalRecommendations = scoredResults.slice(0, 20);
          }
          
          console.warn('[RecommendationService] 디버그 정보:', {
            topSongsCount: topSongs.length,
            searchResultsCount: searchResults.length,
            scoredResultsCount: scoredResults.length,
            uniqueResultsCount: uniqueResults.length,
            relaxedUniqueResultsCount: relaxedUniqueResults?.length || 0,
            finalRecommendationsCount: finalRecommendations.length
          });
        } else {
          console.warn('[RecommendationService] 최종 필터링 후 결과가 없습니다. 중복 제거 결과를 사용합니다.');
          finalRecommendations = uniqueResults.slice(0, 20);
        }
      }

      // 12. 상위 20개 선택 및 대기열에 있는 노래 확실히 제거
      const queueVideoIdsSet = new Set(queue.map(m => m.videoId || m.id).filter(id => id != null));
      const recommendationsBeforeQueueFilter = finalRecommendations.slice(0, 20);
      const recommendations = this.limitPerArtist(recommendationsBeforeQueueFilter.filter(rec => {
        const recVideoId = rec.videoId || rec.id;
        if (!recVideoId) {
          console.warn('[RecommendationService] 추천 결과에 videoId가 없음:', rec);
          return false;
        }
        if (queueVideoIdsSet.has(recVideoId)) {
          console.log(`[RecommendationService] 최종 필터링: 대기열에 있는 노래 제외 "${rec.title}" (${recVideoId})`);
          return false;
        }
        return true;
      }), MAX_PER_ARTIST_IN_TOP);

      // 최종 결과 확인
      if (recommendations.length === 0) {
        console.error('[RecommendationService] 최종 추천 결과가 없습니다. (대기열 필터링 후)');
        console.error('[RecommendationService] 디버그 정보:', {
          topSongsCount: topSongs.length,
          searchResultsCount: searchResults.length,
          scoredResultsCount: scoredResults.length,
          uniqueResultsCount: uniqueResults.length,
          finalRecommendationsCount: finalRecommendations.length,
          recommendationsBeforeQueueFilterCount: recommendationsBeforeQueueFilter.length,
          recommendationsCount: recommendations.length,
          queueVideoIds: Array.from(queueVideoIdsSet),
          recommendationsBeforeQueueFilterVideoIds: recommendationsBeforeQueueFilter.map(r => r.videoId || r.id)
        });
      } else {
        console.log(`[RecommendationService] 최종 추천 결과: ${recommendations.length}개 (대기열 필터링: ${recommendationsBeforeQueueFilter.length}개 → ${recommendations.length}개)`);
        // 디버깅: 추천 결과의 videoId와 제목 출력
        console.log('[RecommendationService] 추천 결과 상세:', recommendations.map(r => ({
          videoId: r.videoId,
          title: r.title
        })));
      }

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
