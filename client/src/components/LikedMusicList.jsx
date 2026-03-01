import React, { useState, useEffect } from 'react';
import './LikedMusicList.css';

function LikedMusicList({ socket }) {
  const [likedMusics, setLikedMusics] = useState([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => {
    // localStorage에서 좋아요한 노래 목록 로드
    const loadLikedMusics = () => {
      try {
        const stored = localStorage.getItem('musicLikes');
        if (stored) {
          const likesData = JSON.parse(stored);
          const likedList = [];
          
          if (likesData.likesByVideoId) {
            Object.keys(likesData.likesByVideoId).forEach(videoId => {
              const likeData = likesData.likesByVideoId[videoId];
              if (likeData && likeData.count > 0) {
                likedList.push({
                  videoId: videoId,
                  title: likeData.title || `Video ID: ${videoId}`,
                  count: likeData.count
                });
              }
            });
          }
          
          // 좋아요 개수 순으로 정렬
          likedList.sort((a, b) => b.count - a.count);
          setLikedMusics(likedList);
        }
      } catch (e) {
        console.error('localStorage 읽기 오류:', e);
      }
    };

    loadLikedMusics();

    // 좋아요 업데이트 이벤트 수신 시 목록 갱신
    if (socket) {
      const handleLikeUpdated = () => {
        loadLikedMusics();
      };

      socket.on('likeUpdated', handleLikeUpdated);

      return () => {
        socket.off('likeUpdated', handleLikeUpdated);
      };
    }
  }, [socket]);

  // 페이징 계산
  const totalPages = Math.ceil(likedMusics.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const pagedLikedMusics = likedMusics.slice(startIndex, endIndex);
  const globalStartIndex = startIndex;

  // 페이지 변경 시 현재 페이지 유지 (데이터가 변경되어도)
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    }
  }, [likedMusics.length, totalPages, currentPage]);

  // 확장 상태가 변경되면 첫 페이지로 리셋
  useEffect(() => {
    if (!isExpanded) {
      setCurrentPage(1);
    }
  }, [isExpanded]);

  if (likedMusics.length === 0) {
    return (
      <div className="liked-music-list">
        <div className="liked-music-header">
          <h2>좋아요한 노래</h2>
        </div>
        <div className="empty-liked">
          <p>좋아요한 노래가 없습니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="liked-music-list">
      <div className="liked-music-header">
        <h2>좋아요한 노래 ({likedMusics.length})</h2>
        <div className="liked-music-header-controls">
          {isExpanded && totalPages > 1 && (
            <div className="liked-music-pagination">
              <button
                className="liked-music-pagination-btn"
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                title="이전 페이지"
              >
                <span className="material-icons">chevron_left</span>
              </button>
              <span className="liked-music-pagination-info">
                {currentPage} / {totalPages}
              </span>
              <button
                className="liked-music-pagination-btn"
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage >= totalPages}
                title="다음 페이지"
              >
                <span className="material-icons">chevron_right</span>
              </button>
            </div>
          )}
          <button 
            className="toggle-btn"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <span className="material-icons">{isExpanded ? 'expand_less' : 'expand_more'}</span>
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="liked-music-items">
          {pagedLikedMusics.map((music, index) => {
            const globalIndex = globalStartIndex + index;
            return (
              <div key={music.videoId} className="liked-music-item">
                <div className="liked-music-number">{globalIndex + 1}</div>
                <div className="liked-music-info">
                  <h4>{music.title}</h4>
                  <div className="liked-music-count">
                    <span className="material-icons">favorite</span>
                    <span>{music.count}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default LikedMusicList;
