const YoutubeSearchApi = require('youtube-search-api');

class YoutubeService {
  constructor() {
    // 유튜브 검색 API는 API 키 없이도 사용 가능하지만 제한이 있을 수 있습니다
  }

  async search(query, maxResults = 5) {
    try {
      console.log(`유튜브 검색 중: ${query} (최대 ${maxResults}개)`);
      
      // youtube-search-api를 사용하여 검색
      const results = await YoutubeSearchApi.GetListByKeyword(query, false, maxResults);
      
      if (!results || !results.items || results.items.length === 0) {
        console.log('검색 결과가 없습니다.');
        return [];
      }

      // 검색 결과를 배열로 변환
      const searchResults = [];
      
      for (const item of results.items) {
        // 비디오 ID 추출 (여러 형식 지원)
        const videoId = item.id || item.videoId || 
                       (item.url ? this.extractVideoId(item.url) : null);
        
        if (!videoId) {
          continue; // 비디오 ID가 없으면 스킵
        }
        
        // 제목과 썸네일 정보 추출
        const title = item.title || query;
        
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

        searchResults.push({
          videoId,
          title,
          thumbnail,
          duration: item.length?.simpleText || item.duration || '알 수 없음'
        });
      }

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
}

module.exports = YoutubeService;

