import React, { useState, useEffect } from 'react';
import './PlaylistModal.css';

function PlaylistModal({ isOpen, onClose, queue, socket, onLoadPlaylist, hasControl = false }) {
  const [savedPlaylists, setSavedPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [likedMusics, setLikedMusics] = useState([]);
  const [aiRecommendations, setAiRecommendations] = useState([]);
  const [likedPage, setLikedPage] = useState(1);
  const [aiPage, setAiPage] = useState(1);
  const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
  const [selectedMusic, setSelectedMusic] = useState(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const itemsPerPage = 5;

  // 모달이 열릴 때마다 좋아요 목록 및 AI 추천 노래 로드
  useEffect(() => {
    if (isOpen) {
      loadSavedPlaylists();
      loadLikedMusics();
      loadAIRecommendations();
      // 페이징 초기화
      setLikedPage(1);
      setAiPage(1);
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

  const loadAIRecommendations = () => {
    try {
      const stored = localStorage.getItem('aiRecommendations');
      if (stored) {
        const recommendations = JSON.parse(stored);
        // 최신순으로 정렬 (최근 추가된 것부터)
        const sorted = [...recommendations].sort((a, b) => 
          new Date(b.addedAt) - new Date(a.addedAt)
        );
        setAiRecommendations(sorted);
      } else {
        setAiRecommendations([]);
      }
    } catch (e) {
      console.error('AI 추천 데이터 읽기 오류:', e);
      setAiRecommendations([]);
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

  const handleSaveAIRecommendationsPlaylist = () => {
    if (aiRecommendations.length === 0) {
      alert('저장할 AI 추천 노래가 없습니다.');
      return;
    }

    const playlistName = prompt('플레이리스트 이름을 입력하세요:', `AI 추천노래 ${new Date().toLocaleDateString()}`);
    
    if (!playlistName || !playlistName.trim()) {
      return;
    }

    // AI 추천 노래를 플레이리스트 형식으로 변환 (count는 0으로 설정)
    const aiMusics = aiRecommendations.map(music => ({
      videoId: music.videoId,
      title: music.title,
      count: 0 // AI 추천은 하트 개수가 없으므로 0
    }));

    const newPlaylist = {
      id: Date.now().toString(),
      name: playlistName.trim(),
      musics: aiMusics,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      const stored = localStorage.getItem('savedPlaylists');
      const playlists = stored ? JSON.parse(stored) : [];
      playlists.push(newPlaylist);
      localStorage.setItem('savedPlaylists', JSON.stringify(playlists));
      loadSavedPlaylists();
      alert('AI 추천 노래 플레이리스트가 저장되었습니다.');
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

    if (window.confirm(`"${playlist.name}" 플레이리스트를 불러오시겠습니까? 가장 높은 하트 노래가 먼저 재생되고 나머지는 대기열에 추가됩니다.`)) {
      // 하트 개수 순으로 정렬 (내림차순 - 이미 정렬되어 있을 수 있지만 확실히 하기 위해)
      const sortedMusics = [...playlist.musics].sort((a, b) => (b.count || 0) - (a.count || 0));
      
      if (sortedMusics.length === 0) {
        alert('플레이리스트에 노래가 없습니다.');
        return;
      }

      // 첫 번째 노래(가장 높은 하트)를 먼저 대기열에 추가 - 이것이 자동 재생될 것
      const firstMusic = sortedMusics[0];
      if (socket) {
        socket.emit('requestMusic', {
          musicData: {
            id: firstMusic.videoId,
            videoId: firstMusic.videoId,
            title: firstMusic.title,
            thumbnail: `https://img.youtube.com/vi/${firstMusic.videoId}/mqdefault.jpg`
          },
          requestedBy: `플레이리스트: ${playlist.name} (즉시 재생)`,
          fromPlaylist: true,
          isFirstInPlaylist: true
        });
      }

      // 나머지 노래들을 대기열에 추가 (첫 번째 노래가 재생 시작되고 상태가 업데이트될 시간을 충분히 주기 위해 2초 지연)
      if (sortedMusics.length > 1) {
        setTimeout(() => {
          sortedMusics.slice(1).forEach((music, index) => {
            setTimeout(() => {
              if (socket) {
                socket.emit('requestMusic', {
                  musicData: {
                    id: music.videoId,
                    videoId: music.videoId,
                    title: music.title,
                    thumbnail: `https://img.youtube.com/vi/${music.videoId}/mqdefault.jpg`
                  },
                  requestedBy: `플레이리스트: ${playlist.name}`,
                  fromPlaylist: true,
                  isFirstInPlaylist: false
                });
              }
            }, index * 150); // 순차적으로 추가 (간격 증가)
          });
        }, 2000); // 첫 번째 노래 재생 시작 후 2초 지연 (재생 상태 업데이트 시간 확보)
      }
      
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

  // AI 추천 노래 개별 삭제
  const handleDeleteAIRecommendation = (videoId, e) => {
    e.stopPropagation();
    if (window.confirm('이 AI 추천 노래를 삭제하시겠습니까?')) {
      try {
        const stored = localStorage.getItem('aiRecommendations');
        if (stored) {
          const recommendations = JSON.parse(stored);
          const filtered = recommendations.filter(rec => rec.videoId !== videoId);
          localStorage.setItem('aiRecommendations', JSON.stringify(filtered));
          loadAIRecommendations();
        }
      } catch (e) {
        console.error('AI 추천 노래 삭제 오류:', e);
        alert('AI 추천 노래 삭제에 실패했습니다.');
      }
    }
  };

  // AI 추천 노래 전체 삭제
  const handleDeleteAllAIRecommendations = () => {
    if (window.confirm('모든 AI 추천 노래를 삭제하시겠습니까?')) {
      try {
        localStorage.removeItem('aiRecommendations');
        loadAIRecommendations();
        alert('모든 AI 추천 노래가 삭제되었습니다.');
      } catch (e) {
        console.error('AI 추천 노래 전체 삭제 오류:', e);
        alert('AI 추천 노래 전체 삭제에 실패했습니다.');
      }
    }
  };

  // 개별 노래를 플레이리스트에 저장 (플레이리스트 선택 모달 표시)
  const handleSaveSingleMusic = (music, isAI = false) => {
    setSelectedMusic({ ...music, isAI });
    setNewPlaylistName(`${isAI ? 'AI 추천' : '좋아요'} 노래 ${new Date().toLocaleDateString()}`);
    setShowPlaylistSelector(true);
  };

  // 플레이리스트 선택 및 노래 추가
  const handleAddToPlaylist = (playlistId = null) => {
    if (!selectedMusic) return;

    const musicData = {
      videoId: selectedMusic.videoId,
      title: selectedMusic.title,
      count: selectedMusic.isAI ? 0 : selectedMusic.count
    };

    try {
      const stored = localStorage.getItem('savedPlaylists');
      let playlists = stored ? JSON.parse(stored) : [];

      if (playlistId) {
        // 기존 플레이리스트에 추가
        const playlistIndex = playlists.findIndex(p => p.id === playlistId);
        if (playlistIndex !== -1) {
          // 중복 체크
          const existingIndex = playlists[playlistIndex].musics.findIndex(
            m => m.videoId === musicData.videoId
          );
          if (existingIndex === -1) {
            playlists[playlistIndex].musics.push(musicData);
            playlists[playlistIndex].updatedAt = new Date().toISOString();
            localStorage.setItem('savedPlaylists', JSON.stringify(playlists));
            loadSavedPlaylists();
            alert('플레이리스트에 노래가 추가되었습니다.');
          } else {
            alert('이미 플레이리스트에 있는 노래입니다.');
          }
        }
      } else {
        // 새 플레이리스트 생성
        if (!newPlaylistName || !newPlaylistName.trim()) {
          alert('플레이리스트 이름을 입력해주세요.');
          return;
        }

        const newPlaylist = {
          id: Date.now().toString(),
          name: newPlaylistName.trim(),
          musics: [musicData],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        playlists.push(newPlaylist);
        localStorage.setItem('savedPlaylists', JSON.stringify(playlists));
        loadSavedPlaylists();
        alert('새 플레이리스트가 생성되고 노래가 추가되었습니다.');
      }

      setShowPlaylistSelector(false);
      setSelectedMusic(null);
      setNewPlaylistName('');
    } catch (e) {
      console.error('플레이리스트 저장 오류:', e);
      alert('플레이리스트 저장에 실패했습니다.');
    }
  };

  // 페이징 계산 함수
  const getPagedData = (data, page) => {
    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return data.slice(startIndex, endIndex);
  };

  const getTotalPages = (data) => {
    return Math.ceil(data.length / itemsPerPage);
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
              <div className="playlist-header-actions">
                {likedMusics.length > 0 && (
                  <div className="pagination-controls">
                    <button 
                      className="pagination-btn"
                      onClick={() => setLikedPage(prev => Math.max(1, prev - 1))}
                      disabled={likedPage === 1}
                    >
                      <span className="material-icons">chevron_left</span>
                    </button>
                    <span className="pagination-info">
                      {likedPage} / {getTotalPages(likedMusics)}
                    </span>
                    <button 
                      className="pagination-btn"
                      onClick={() => setLikedPage(prev => Math.min(getTotalPages(likedMusics), prev + 1))}
                      disabled={likedPage >= getTotalPages(likedMusics)}
                    >
                      <span className="material-icons">chevron_right</span>
                    </button>
                  </div>
                )}
                <button 
                  className="save-playlist-btn icon-only" 
                  onClick={handleSavePlaylist}
                  title="저장하기"
                >
                  <span className="material-icons">save</span>
                </button>
              </div>
            </div>
            <div className="liked-musics-list">
              {likedMusics.length === 0 ? (
                <p className="empty-message">좋아요한 노래가 없습니다.</p>
              ) : (
                getPagedData(likedMusics, likedPage).map((music, index) => {
                  const globalIndex = (likedPage - 1) * itemsPerPage + index;
                  return (
                    <div key={music.videoId} className="liked-music-item">
                      <button 
                        className="save-single-music-btn"
                        onClick={() => handleSaveSingleMusic(music, false)}
                        title="플레이리스트에 저장"
                      >
                        <span className="material-icons">playlist_add</span>
                      </button>
                      <div className="liked-music-rank">{globalIndex + 1}</div>
                      <div className="liked-music-info">
                        <div className="liked-music-title">{music.title}</div>
                        <div className="liked-music-count">
                          <span className="material-icons">favorite</span>
                          <span>{music.count}</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* 제어권 있는 위치에서만 AI 추천 노래 섹션 표시 */}
          {hasControl && (
            <div className="playlist-section">
              <div className="playlist-section-header">
                <h3>AI 추천노래 ({aiRecommendations.length}개)</h3>
                <div className="playlist-header-actions">
                  {aiRecommendations.length > 0 && (
                    <>
                      <div className="pagination-controls">
                        <button 
                          className="pagination-btn"
                          onClick={() => setAiPage(prev => Math.max(1, prev - 1))}
                          disabled={aiPage === 1}
                        >
                          <span className="material-icons">chevron_left</span>
                        </button>
                        <span className="pagination-info">
                          {aiPage} / {getTotalPages(aiRecommendations)}
                        </span>
                        <button 
                          className="pagination-btn"
                          onClick={() => setAiPage(prev => Math.min(getTotalPages(aiRecommendations), prev + 1))}
                          disabled={aiPage >= getTotalPages(aiRecommendations)}
                        >
                          <span className="material-icons">chevron_right</span>
                        </button>
                      </div>
                      <button 
                        className="delete-all-btn icon-only" 
                        onClick={handleDeleteAllAIRecommendations}
                        title="전체 삭제"
                      >
                        <span className="material-icons">delete_sweep</span>
                      </button>
                    </>
                  )}
                  <button 
                    className="save-playlist-btn icon-only" 
                    onClick={handleSaveAIRecommendationsPlaylist}
                    title="저장하기"
                  >
                    <span className="material-icons">save</span>
                  </button>
                </div>
              </div>
              <div className="liked-musics-list">
                {aiRecommendations.length === 0 ? (
                  <p className="empty-message">AI 추천 노래가 없습니다.</p>
                ) : (
                  getPagedData(aiRecommendations, aiPage).map((music, index) => {
                    const globalIndex = (aiPage - 1) * itemsPerPage + index;
                    return (
                      <div key={music.videoId} className="liked-music-item ai-recommendation-item">
                        <div className="ai-recommendation-label">
                          <span className="material-icons">auto_awesome</span>
                          <span>AI 추천</span>
                        </div>
                        <div className="liked-music-info">
                          <div className="liked-music-title">{music.title}</div>
                        </div>
                        <div className="ai-recommendation-actions">
                          <button 
                            className="save-single-music-btn icon-only"
                            onClick={() => handleSaveSingleMusic(music, true)}
                            title="플레이리스트에 저장"
                          >
                            <span className="material-icons">add</span>
                          </button>
                          {hasControl && (
                            <button 
                              className="delete-single-music-btn icon-only"
                              onClick={(e) => handleDeleteAIRecommendation(music.videoId, e)}
                              title="삭제"
                            >
                              <span className="material-icons">close</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

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

      {/* 플레이리스트 선택 모달 */}
      {showPlaylistSelector && (
        <div className="playlist-selector-overlay" onClick={() => {
          setShowPlaylistSelector(false);
          setSelectedMusic(null);
          setNewPlaylistName('');
        }}>
          <div className="playlist-selector-modal" onClick={(e) => e.stopPropagation()}>
            <div className="playlist-selector-header">
              <h3>플레이리스트 선택</h3>
              <button 
                className="playlist-selector-close"
                onClick={() => {
                  setShowPlaylistSelector(false);
                  setSelectedMusic(null);
                  setNewPlaylistName('');
                }}
              >
                <span className="material-icons">close</span>
              </button>
            </div>
            <div className="playlist-selector-content">
              <div className="playlist-selector-info">
                <p>추가할 노래: <strong>{selectedMusic?.title}</strong></p>
              </div>
              
              {savedPlaylists.length > 0 && (
                <div className="playlist-selector-list">
                  <h4>기존 플레이리스트</h4>
                  <div className="playlist-selector-items">
                    {savedPlaylists.map(playlist => (
                      <div
                        key={playlist.id}
                        className="playlist-selector-item"
                        onClick={() => handleAddToPlaylist(playlist.id)}
                      >
                        <span className="material-icons">queue_music</span>
                        <div className="playlist-selector-item-info">
                          <div className="playlist-selector-item-name">{playlist.name}</div>
                          <div className="playlist-selector-item-meta">
                            {playlist.musics.length}개 곡
                          </div>
                        </div>
                        <span className="material-icons">chevron_right</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="playlist-selector-new">
                <h4>새 플레이리스트 만들기</h4>
                <div className="playlist-selector-new-input">
                  <input
                    type="text"
                    value={newPlaylistName}
                    onChange={(e) => setNewPlaylistName(e.target.value)}
                    placeholder="플레이리스트 이름을 입력하세요"
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        handleAddToPlaylist(null);
                      }
                    }}
                  />
                  <button
                    className="playlist-selector-create-btn"
                    onClick={() => handleAddToPlaylist(null)}
                    disabled={!newPlaylistName || !newPlaylistName.trim()}
                  >
                    <span className="material-icons">add</span>
                    만들기
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PlaylistModal;
