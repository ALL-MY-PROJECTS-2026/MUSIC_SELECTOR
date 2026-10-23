import React, { useState, useEffect, useRef } from 'react';
import './MusicRequestForm.css';
import RecommendationButton from './ai/RecommendationButton';
import AutoRecommendationButton from './ai/AutoRecommendationButton';

function MusicRequestForm({ onSearchMusic, onRequestMusic, socket, hasControl = false }) {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;
  const resultsListRef = useRef(null);
  const searchResultsRef = useRef(null);

  useEffect(() => {
    if (!socket) return;

    // 검색 결과 수신
    const handleSearchResults = (data) => {
      // AI 추천 등 내부 검색(requestId 있음) 결과는 검색 목록에 표시하지 않음
      if (data.requestId) return;
      setIsLoading(false);
      setSearchResults(data.results || []);
      setCurrentPage(1); // 검색 시 첫 페이지로 리셋
      // 검색 결과가 나오면 스크롤을 맨 위로 이동
      setTimeout(() => {
        if (resultsListRef.current) {
          resultsListRef.current.scrollTop = 0;
        }
        // 검색 결과 영역으로 부드럽게 스크롤
        if (searchResultsRef.current) {
          searchResultsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    };

    // 에러 처리
    const handleError = (error) => {
      setIsLoading(false);
      if (error.message) {
        alert(error.message);
      }
    };

    // 음악 추가 성공 처리
    const handleMusicAdded = (data) => {
      setIsLoading(false);
      setSearchResults([]); // 검증 성공 시 검색 결과 숨김
      setQuery(''); // 검색어 초기화
      setCurrentPage(1); // 페이지 리셋
      if (data.message) {
        // 성공 메시지는 선택적으로 표시 (너무 많은 알림 방지)
        // console.log(data.message);
      }
    };

    socket.on('searchResults', handleSearchResults);
    socket.on('error', handleError);
    socket.on('musicAdded', handleMusicAdded);

    return () => {
      socket.off('searchResults', handleSearchResults);
      socket.off('error', handleError);
      socket.off('musicAdded', handleMusicAdded);
    };
  }, [socket]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim() && !isLoading) {
      setIsLoading(true);
      setSearchResults([]);
      onSearchMusic(query.trim());
      // 검색어는 유지 (결과 확인 후 선택)
    }
  };

  const handleSelectMusic = async (music) => {
    // 선택 시 로딩 상태 표시
    setIsLoading(true);
    
    // 음악 요청 (서버에서 검증 후 대기열에 추가)
    onRequestMusic(music);
    
    // 검색 결과는 유지 (검증 실패 시 다시 선택할 수 있도록)
    // 검증 성공 시 서버에서 musicAdded 이벤트를 받으면 처리
  };

  // 페이징 계산
  const totalPages = Math.ceil(searchResults.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const currentResults = searchResults.slice(startIndex, endIndex);

  const handlePrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
      if (resultsListRef.current) {
        resultsListRef.current.scrollTop = 0;
      }
    }
  };

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1);
      if (resultsListRef.current) {
        resultsListRef.current.scrollTop = 0;
      }
    }
  };

  return (
    <div className="music-request-form">
      <h2>음악 요청</h2>
      {socket && (
        <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <RecommendationButton socket={socket} />
          <AutoRecommendationButton socket={socket} hasControl={hasControl} />
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div className="input-group">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="음악 제목 또는 아티스트 이름을 입력하세요..."
            disabled={isLoading}
            className="music-input"
          />
          <button 
            type="submit" 
            disabled={!query.trim() || isLoading}
            className="submit-btn"
          >
            {isLoading ? '검색 중...' : '검색'}
          </button>
        </div>
      </form>

      {searchResults.length > 0 && (
        <div className="search-results" ref={searchResultsRef}>
          <h3>검색 결과 ({searchResults.length}개)</h3>
          <div className="results-list" ref={resultsListRef}>
            {currentResults.map((music, index) => (
              <div 
                key={music.videoId} 
                className="result-item"
              >
                <div className="result-thumbnail">
                  <img src={music.thumbnail} alt={music.title} />
                </div>
                <div className="result-info">
                  <h4>{music.title}</h4>
                  <p className="result-duration">재생 시간: {music.duration}</p>
                </div>
                <button 
                  className="select-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectMusic(music);
                  }}
                >
                  선택
                </button>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="pagination">
              <button 
                className="page-btn"
                onClick={handlePrevPage}
                disabled={currentPage === 1}
              >
                이전
              </button>
              <span className="page-info">
                {currentPage} / {totalPages}
              </span>
              <button 
                className="page-btn"
                onClick={handleNextPage}
                disabled={currentPage === totalPages}
              >
                다음
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default MusicRequestForm;

