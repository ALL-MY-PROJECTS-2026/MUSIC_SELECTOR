import React, { useState, useEffect } from 'react';
import './PlaylistModal.css';

function PlaylistModal({ isOpen, onClose, queue, socket, onLoadPlaylist }) {
  const [savedPlaylists, setSavedPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [likedMusics, setLikedMusics] = useState([]);

  // 모달이 열릴 때마다 좋아요 목록 로드
  useEffect(() => {
    if (isOpen) {
      loadSavedPlaylists();
      loadLikedMusics();
    }
  }, [isOpen]);

  // 좋아요 업데이트 이벤트 수신 시 목록 갱신
  useEffect(() => {
    if (!socket) return;

    const handleLikeUpdated = () => {
      if (isOpen) {
        // 모달이 열려있을 때만 갱신
        loadLikedMusics();
      }
    };

    socket.on('likeUpdated', handleLikeUpdated);

    return () => {
      socket.off('likeUpdated', handleLikeUpdated);
    };
  }, [socket, isOpen]);

  const loadSavedPlaylists = () => {
    try {
      const stored = localStorage.getItem('savedPlaylists');
      if (stored) {
        const playlists = JSON.parse(stored);
        setSavedPlaylists(playlists);
      } else {
        setSavedPlaylists([]);
      }
    } catch (e) {
      console.error('플레이리스트 로드 오류:', e);
      setSavedPlaylists([]);
    }
  };

  const loadLikedMusics = () => {
    try {
      const stored = localStorage.getItem('musicLikes');
      if (stored) {
        const likesData = JSON.parse(stored);
        const likedList = [];
        
        if (likesData.likesByVideoId) {
          Object.keys(likesData.likesByVideoId).forEach(videoId => {
            const likeData = likesData.likesByVideoId[videoId];
            if (likeData && likeData.count > 0 && likeData.title) {
              likedList.push({
                videoId: videoId,
                title: likeData.title,
                count: likeData.count
              });
            }
          });
        }
        
        // 좋아요 개수 순으로 정렬 (내림차순)
        likedList.sort((a, b) => b.count - a.count);
        setLikedMusics(likedList);
      } else {
        setLikedMusics([]);
      }
    } catch (e) {
      console.error('좋아요 데이터 읽기 오류:', e);
      setLikedMusics([]);
    }
  };

  const handleSavePlaylist = () => {
    if (likedMusics.length === 0) {
      alert('저장할 좋아요한 노래가 없습니다.');
      return;
    }

    const playlistName = prompt('플레이리스트 이름을 입력하세요:', `플레이리스트 ${new Date().toLocaleDateString()}`);
    
    if (!playlistName || !playlistName.trim()) {
      return;
    }

    const newPlaylist = {
      id: Date.now().toString(),
      name: playlistName.trim(),
      musics: likedMusics,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      const stored = localStorage.getItem('savedPlaylists');
      const playlists = stored ? JSON.parse(stored) : [];
      playlists.push(newPlaylist);
      localStorage.setItem('savedPlaylists', JSON.stringify(playlists));
      loadSavedPlaylists();
      alert('플레이리스트가 저장되었습니다.');
    } catch (e) {
      console.error('플레이리스트 저장 오류:', e);
      alert('플레이리스트 저장에 실패했습니다.');
    }
  };

  const handleLoadPlaylist = (playlist) => {
    if (!playlist || !playlist.musics || playlist.musics.length === 0) {
      alert('플레이리스트가 비어있습니다.');
      return;
    }

    if (window.confirm(`"${playlist.name}" 플레이리스트를 불러오시겠습니까? 현재 대기열이 교체됩니다.`)) {
      // 플레이리스트의 음악들을 대기열에 추가
      playlist.musics.forEach((music, index) => {
        setTimeout(() => {
          if (socket) {
            socket.emit('requestMusic', {
              musicData: {
                id: music.videoId,
                videoId: music.videoId,
                title: music.title,
                thumbnail: `https://img.youtube.com/vi/${music.videoId}/mqdefault.jpg`
              },
              requestedBy: `플레이리스트: ${playlist.name}`
            });
          }
        }, index * 100); // 순차적으로 추가
      });
      
      if (onLoadPlaylist) {
        onLoadPlaylist(playlist);
      }
      onClose();
    }
  };

  const handleDeletePlaylist = (playlistId, e) => {
    e.stopPropagation();
    if (window.confirm('이 플레이리스트를 삭제하시겠습니까?')) {
      try {
        const stored = localStorage.getItem('savedPlaylists');
        const playlists = stored ? JSON.parse(stored) : [];
        const filtered = playlists.filter(p => p.id !== playlistId);
        localStorage.setItem('savedPlaylists', JSON.stringify(filtered));
        loadSavedPlaylists();
        if (selectedPlaylist && selectedPlaylist.id === playlistId) {
          setSelectedPlaylist(null);
        }
      } catch (e) {
        console.error('플레이리스트 삭제 오류:', e);
        alert('플레이리스트 삭제에 실패했습니다.');
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content playlist-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>플레이리스트 관리</h2>
          <button className="modal-close-btn" onClick={onClose}>
            <span className="material-icons">close</span>
          </button>
        </div>
        
        <div className="playlist-content">
          <div className="playlist-section">
            <div className="playlist-section-header">
              <h3>현재 좋아요한 노래 ({likedMusics.length}개)</h3>
              <button className="save-playlist-btn" onClick={handleSavePlaylist}>
                <span className="material-icons">save</span>
                저장하기
              </button>
            </div>
            <div className="liked-musics-list">
              {likedMusics.length === 0 ? (
                <p className="empty-message">좋아요한 노래가 없습니다.</p>
              ) : (
                likedMusics.map((music, index) => (
                  <div key={music.videoId} className="liked-music-item">
                    <div className="liked-music-rank">{index + 1}</div>
                    <div className="liked-music-info">
                      <div className="liked-music-title">{music.title}</div>
                      <div className="liked-music-count">
                        <span className="material-icons">favorite</span>
                        <span>{music.count}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="playlist-section">
            <div className="playlist-section-header">
              <h3>저장된 플레이리스트 ({savedPlaylists.length}개)</h3>
            </div>
            <div className="saved-playlists-list">
              {savedPlaylists.length === 0 ? (
                <p className="empty-message">저장된 플레이리스트가 없습니다.</p>
              ) : (
                savedPlaylists.map((playlist) => (
                  <div 
                    key={playlist.id} 
                    className={`saved-playlist-item ${selectedPlaylist?.id === playlist.id ? 'selected' : ''}`}
                    onClick={() => setSelectedPlaylist(playlist)}
                  >
                    <div className="playlist-item-info">
                      <div className="playlist-item-name">{playlist.name}</div>
                      <div className="playlist-item-meta">
                        <span>{playlist.musics.length}개 곡</span>
                        <span>•</span>
                        <span>{new Date(playlist.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="playlist-item-actions">
                      <button 
                        className="load-playlist-btn"
                        onClick={() => handleLoadPlaylist(playlist)}
                        title="불러오기"
                      >
                        <span className="material-icons">play_arrow</span>
                      </button>
                      <button 
                        className="delete-playlist-btn"
                        onClick={(e) => handleDeletePlaylist(playlist.id, e)}
                        title="삭제"
                      >
                        <span className="material-icons">delete</span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PlaylistModal;
