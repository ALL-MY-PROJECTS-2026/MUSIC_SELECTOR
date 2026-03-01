import React, { useState, useEffect } from 'react';
import './LikedMusicList.css';

function LikedMusicList({ socket }) {
  const [likedMusics, setLikedMusics] = useState([]);
  const [isExpanded, setIsExpanded] = useState(false);

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

  if (likedMusics.length === 0) {
    return (
      <div className="liked-music-list">
        <h2>좋아요한 노래</h2>
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
        <button 
          className="toggle-btn"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <span className="material-icons">{isExpanded ? 'expand_less' : 'expand_more'}</span>
        </button>
      </div>
      {isExpanded && (
        <div className="liked-music-items">
          {likedMusics.map((music, index) => (
            <div key={music.videoId} className="liked-music-item">
              <div className="liked-music-number">{index + 1}</div>
              <div className="liked-music-info">
                <h4>{music.title}</h4>
                <div className="liked-music-count">
                  <span className="material-icons">favorite</span>
                  <span>{music.count}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default LikedMusicList;
