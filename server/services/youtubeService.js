const YoutubeSearchApi = require('youtube-search-api');

class YoutubeService {
  constructor() {
    // 유튜브 검색 API는 API 키 없이도 사용 가능하지만 제한이 있을 수 있습니다
  }

  async search(query, maxResults = 5) {
    try {
      console.log(`유튜브 검색 중: ${query} (최대 ${maxResults}개)`);
      
      // 더 많은 결과를 검색하여 재생 불가능한 영상을 필터링한 후에도 충분한 결과 확보
      const searchMultiplier = 2; // 최대 2배까지 검색
      const results = await YoutubeSearchApi.GetListByKeyword(query, false, maxResults * searchMultiplier);
      
      if (!results || !results.items || results.items.length === 0) {
        console.log('검색 결과가 없습니다.');
        return [];
      }

      // 검색 결과를 배열로 변환 (재생 가능 여부 검증 포함)
      const rawResults = [];
      
      for (const item of results.items) {
        // 비디오 ID 추출 (여러 형식 지원)
        const videoId = item.id || item.videoId || 
                       (item.url ? this.extractVideoId(item.url) : null);
        
        if (!videoId) {
          continue; // 비디오 ID가 없으면 스킵
        }
        
        // 재생 시간 추출
        const duration = item.length?.simpleText || item.duration || null;
        
        // 재생 시간이 없거나 "알 수 없음"인 경우 제외
        if (!duration || duration === '알 수 없음') {
          continue;
        }
        
        // 제목과 썸네일 정보 추출
        const title = item.title || query;
        
        // 쇼츠 제외 (제목에 #shorts 또는 shorts 포함, 또는 재생 시간이 1분 이하)
        const titleLower = title.toLowerCase();
        const isShorts = titleLower.includes('#shorts') || 
                        titleLower.includes('shorts') ||
                        titleLower.includes('쇼츠');
        
        // 재생 시간이 1분 이하인지 확인 (쇼츠는 보통 1분 이하)
        let isShortDuration = false;
        if (duration) {
          const durationStr = duration.toString();
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
            // 1분 이하이면 쇼츠로 간주 (단, 1분 이상인 쇼츠도 있으므로 제목 확인 우선)
            if (minutes <= 1) {
              isShortDuration = true;
            }
          }
        }
        
        // 쇼츠 제외 (제목에 쇼츠 키워드가 있거나, 1분 이하이면서 제목에 쇼츠 관련 키워드가 있는 경우)
        if (isShorts || (isShortDuration && (titleLower.includes('short') || titleLower.includes('쇼츠')))) {
          console.log(`[YoutubeService] 쇼츠 제외: "${title}" (재생시간: ${duration})`);
          continue;
        }
        
        // 썸네일 URL 추출 (여러 형식 지원)
        let thumbnail = null;
        if (item.thumbnail) {
          if (typeof item.thumbnail === 'string') {
            thumbnail = item.thumbnail;
          } else if (item.thumbnail.thumbnails && item.thumbnail.thumbnails.length > 0) {
            thumbnail = item.thumbnail.thumbnails[0].url;
          } else if (item.thumbnail.url) {
            thumbnail = item.thumbnail.url;
          }
        }
        
        // 썸네일이 없으면 기본 썸네일 사용
        if (!thumbnail) {
          thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
        }

        rawResults.push({
          videoId,
          title,
          thumbnail,
          duration: duration
        });
      }

      // 재생 가능 여부 검증 (병렬 처리로 속도 개선)
      console.log(`검색 결과 ${rawResults.length}개에 대해 재생 가능 여부 검증 시작...`);
      const validationPromises = rawResults.map(async (item) => {
        try {
          // 타임아웃 설정 (5초로 증가 - 네트워크가 느린 경우 대비)
          const validationPromise = this.validateVideo(item.videoId, item.duration);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('검증 시간 초과')), 5000)
          );
          
          const validation = await Promise.race([validationPromise, timeoutPromise]);
          // 검증 결과가 false이면 재생 불가능한 것으로 간주
          return { item, validation, isValid: validation.valid === true };
        } catch (error) {
          // 타임아웃이나 오류 발생 시 재생 불가능한 것으로 간주 (안전하게 필터링)
          console.log(`영상 검증 타임아웃/오류 (재생 불가능으로 간주): ${item.title} (${item.videoId}) - ${error.message}`);
          return { item, validation: { valid: false, reason: '검증 시간 초과 또는 오류 발생' }, isValid: false };
        }
      });

      const validatedResults = await Promise.all(validationPromises);
      
      // 재생 가능한 것만 필터링 (oEmbed 검증 통과)
      let searchResults = validatedResults
        .filter(result => result.isValid)
        .map(result => result.item);

      // YouTube Data API를 사용한 추가 재생 가능 여부 확인 (더 강력한 검증)
      if (process.env.YOUTUBE_API_KEY && searchResults.length > 0) {
        try {
          const google = require('googleapis');
          const youtube = google.youtube('v3');
          
          // 배치로 videoId 수집
          const videoIds = searchResults.map(item => item.videoId).slice(0, 50); // 최대 50개
          
          // YouTube Data API로 status 확인
          const response = await youtube.videos.list({
            key: process.env.YOUTUBE_API_KEY,
            part: 'status',
            id: videoIds.join(',')
          });
          
          // 재생 가능한 videoId Set 생성
          const playableVideoIds = new Set();
          if (response.data.items) {
            response.data.items.forEach(item => {
              // 재생 가능 조건:
              // 1. embeddable이 true (또는 undefined - 기본값 true)
              // 2. privacyStatus가 'public'
              // 3. uploadStatus가 'processed'
              const isPlayable = item.status && 
                               item.status.embeddable !== false && 
                               item.status.privacyStatus === 'public' &&
                               item.status.uploadStatus === 'processed';
              
              if (isPlayable) {
                playableVideoIds.add(item.id);
              } else {
                console.log(`[YoutubeService] YouTube Data API로 재생 불가능 확인: ${item.id} (embeddable: ${item.status?.embeddable}, privacy: ${item.status?.privacyStatus}, upload: ${item.status?.uploadStatus})`);
              }
            });
          }
          
          // YouTube Data API 결과로 필터링
          const beforeApiFilterCount = searchResults.length;
          searchResults = searchResults.filter(item => {
            // API에서 확인된 경우에만 필터링, 확인되지 않은 경우는 oEmbed 검증 결과 유지
            if (playableVideoIds.has(item.videoId)) {
              return true; // 재생 가능
            } else if (playableVideoIds.size > 0) {
              // API 응답이 있었는데 이 videoId가 없으면 재생 불가능
              console.log(`[YoutubeService] YouTube Data API로 재생 불가능 필터링: ${item.title} (${item.videoId})`);
              return false;
            } else {
              // API 응답이 없으면 oEmbed 검증 결과 유지
              return true;
            }
          });
          
          const apiFilteredCount = beforeApiFilterCount - searchResults.length;
          if (apiFilteredCount > 0) {
            console.log(`[YoutubeService] YouTube Data API로 재생 불가능한 영상 ${apiFilteredCount}개 추가 필터링됨`);
          }
        } catch (apiError) {
          console.warn('[YoutubeService] YouTube Data API 검증 실패, oEmbed 검증 결과만 사용:', apiError.message);
          // API 호출 실패 시 oEmbed 검증 결과만 사용
        }
      }
      
      // 최종 결과 반환 (최대 개수만큼만)
      searchResults = searchResults.slice(0, maxResults);
      
      const totalFilteredCount = validatedResults.length - searchResults.length;
      if (totalFilteredCount > 0) {
        console.log(`[YoutubeService] 총 재생 불가능한 영상 ${totalFilteredCount}개 필터링됨`);
      }
      console.log(`[YoutubeService] 검색 결과 ${searchResults.length}개 반환 (재생 가능한 영상만)`);

      return searchResults;
    } catch (error) {
      console.error('유튜브 검색 오류:', error);
      throw error;
    }
  }

  // URL에서 비디오 ID 추출 헬퍼 함수
  extractVideoId(url) {
    if (!url) return null;
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/);
    return match ? match[1] : null;
  }

  // Embed URL 테스트 (embed 제한 여부 확인)
  async testEmbedUrl(videoId) {
    try {
      // YouTube embed 페이지 내용 확인
      // embed 제한이 있는 경우 특정 에러 메시지가 나타남
      const embedUrl = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      try {
        const response = await fetch(embedUrl, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        clearTimeout(timeoutId);
        
        // 응답 상태 확인
        if (!response.ok) {
          if (response.status === 403 || response.status === 404) {
            return { embeddable: false };
          }
          return { embeddable: true }; // 다른 오류는 일단 허용
        }
        
        // 응답 본문에서 embed 제한 관련 키워드 확인
        const html = await response.text();
        
        // embed 제한 관련 에러 메시지 패턴 확인
        const embedRestrictionPatterns = [
          /동영상 소유자가 다른 웹사이트에서 재생할 수 없도록 설정했습니다/i,
          /The video owner has set it so that it cannot be played on other websites/i,
          /동영상을 재생할 수 없음/i,
          /Cannot play video/i,
          /embedding disabled/i,
          /embedding not allowed/i,
          /playback on other websites has been disabled/i
        ];
        
        for (const pattern of embedRestrictionPatterns) {
          if (pattern.test(html)) {
            return { embeddable: false };
          }
        }
        
        // embed 제한 패턴이 없으면 embed 가능
        return { embeddable: true };
      } catch (error) {
        clearTimeout(timeoutId);
        // 네트워크 오류나 타임아웃은 일단 허용 (검증 실패를 막지 않음)
        if (error.name === 'AbortError') {
          return { embeddable: true, warning: 'Embed 검증 시간 초과' };
        }
        return { embeddable: true };
      }
    } catch (error) {
      // 오류 발생 시 일단 허용 (검증 실패를 막지 않음)
      return { embeddable: true };
    }
  }

  // 재생 시간 형식 검증 (예: "3:45", "1:23:45")
  validateDuration(duration) {
    if (!duration || typeof duration !== 'string') {
      return false;
    }

    // "MM:SS" 또는 "HH:MM:SS" 형식 확인
    const timePattern = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
    const match = duration.match(timePattern);
    
    if (!match) {
      return false;
    }

    // 시간 값이 유효한지 확인
    const hours = match[3] ? parseInt(match[1], 10) : 0;
    const minutes = match[3] ? parseInt(match[2], 10) : parseInt(match[1], 10);
    const seconds = match[3] ? parseInt(match[3], 10) : parseInt(match[2], 10);

    // 분과 초는 0-59 범위여야 함
    if (minutes >= 60 || seconds >= 60) {
      return false;
    }

    // 시간이 너무 길면 (24시간 이상) 비정상적일 수 있음
    if (hours >= 24) {
      return false;
    }

    return true;
  }

  // YouTube 영상 재생 가능 여부 검증
  async validateVideo(videoId, duration = null) {
    try {
      if (!videoId) {
        return { valid: false, reason: '비디오 ID가 없습니다.' };
      }

      // 재생 시간 형식 검증
      if (duration && !this.validateDuration(duration)) {
        return { valid: false, reason: '재생 시간 정보가 유효하지 않습니다.' };
      }

      // YouTube oEmbed API를 사용하여 영상 정보 확인
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      
      // 타임아웃 설정 (5초)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      let response;
      try {
        response = await fetch(oembedUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          throw new Error('영상 검증 시간 초과');
        }
        throw error;
      }

      // 404 또는 다른 오류는 영상이 존재하지 않거나 재생 불가능함을 의미
      if (!response.ok) {
        if (response.status === 404) {
          return { valid: false, reason: '영상을 찾을 수 없습니다. 영상이 삭제되었거나 비공개일 수 있습니다.' };
        } else if (response.status === 401 || response.status === 403) {
          return { valid: false, reason: '영상 재생이 제한되어 있습니다. 지역 제한 또는 저작권 문제일 수 있습니다.' };
        } else {
          return { valid: false, reason: '영상 정보를 확인할 수 없습니다.' };
        }
      }

      const data = await response.json();
      
      // oEmbed 응답이 있으면 영상이 존재함
      if (data && data.html) {
        // oEmbed의 html 필드에서 embed 제한 관련 패턴 확인
        const htmlContent = data.html.toLowerCase();
        const embedRestrictionInHtml = /embedding.*disabled|embedding.*not.*allowed|cannot.*play.*other.*websites/i.test(htmlContent);
        
        // oEmbed html에 제한 패턴이 있으면 바로 실패
        if (embedRestrictionInHtml) {
          return { 
            valid: false, 
            reason: '이 영상은 다른 웹사이트에서 재생할 수 없도록 설정되어 있습니다.' 
          };
        }
        
        // 추가로 embed URL 직접 테스트
        const embedTestResult = await this.testEmbedUrl(videoId);
        if (!embedTestResult.embeddable) {
          return { 
            valid: false, 
            reason: '이 영상은 다른 웹사이트에서 재생할 수 없도록 설정되어 있습니다.' 
          };
        }
        
        // 경고가 있으면 로그에 기록
        if (embedTestResult.warning) {
          console.warn(`Embed 검증 경고: ${videoId} - ${embedTestResult.warning}`);
        }
        
        return { valid: true, title: data.title || null };
      }

      return { valid: false, reason: '영상 정보를 확인할 수 없습니다.' };
    } catch (error) {
      console.error('영상 검증 오류:', error);
      
      // 타임아웃이나 네트워크 오류의 경우, 재생 불가능한 것으로 간주 (안전하게 필터링)
      if (error.message && error.message.includes('시간 초과')) {
        return { valid: false, reason: '영상 검증 시간이 초과되었습니다. 네트워크 연결을 확인해주세요.' };
      }
      
      // 기타 오류도 재생 불가능한 것으로 간주 (안전하게 필터링)
      return { valid: false, reason: '영상 검증 중 오류가 발생했습니다. 재생 불가능할 수 있습니다.' };
    }
  }
}

module.exports = YoutubeService;

