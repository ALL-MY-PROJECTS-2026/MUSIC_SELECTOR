import React, { useState, useEffect } from 'react';
import './MusicRequestForm.css';

function MusicRequestForm({ onSearchMusic, onRequestMusic, socket }) {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [searchResults, setSearchResults] = useState([]);

  useEffect(() => {
    if (!socket) return;

    // 검색 결과 수신
    const handleSearchResults = (data) => {
      setIsLoading(false);
      setSearchResults(data.results || []);
    };

    // 에러 처리
    const handleError = (error) => {
      setIsLoading(false);
      if (error.message) {
        alert(error.message);
      }
    };

    socket.on('searchResults', handleSearchResults);
    socket.on('error', handleError);

    return () => {
      socket.off('searchResults', handleSearchResults);
      socket.off('error', handleError);
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

  const handleSelectMusic = (music) => {
    onRequestMusic(music);
    setSearchResults([]); // 선택 후 검색 결과 숨김
    setQuery(''); // 검색어 초기화
  };

  return (
    <div className="music-request-form">
      <h2>음악 요청</h2>
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
        <div className="search-results">
          <h3>검색 결과 ({searchResults.length}개)</h3>
          <div className="results-list">
            {searchResults.map((music, index) => (
              <div 
                key={music.videoId} 
                className="result-item"
                onClick={() => handleSelectMusic(music)}
              >
                <div className="result-thumbnail">
                  <img src={music.thumbnail} alt={music.title} />
                </div>
                <div className="result-info">
                  <h4>{music.title}</h4>
                  <p className="result-duration">재생 시간: {music.duration}</p>
                </div>
                <button className="select-btn">선택</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default MusicRequestForm;

