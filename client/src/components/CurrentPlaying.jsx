import React, { useEffect, useRef, useState } from 'react';
import './CurrentPlaying.css';

function CurrentPlaying({ music, isPlaying, onPlayNext, onPause, onResume, isAdmin = false, hasControl = false }) {
  const playerRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const endedSentRef = useRef(false); // 재생 종료 알림 중복 방지
  const pauseTimeRef = useRef(null); // 일시정지 시점 저장

  // YouTube IFrame API 로드
  useEffect(() => {
    // 이미 로드되어 있는지 확인
    if (window.YT && window.YT.Player) {
      setApiReady(true);
      return;
    }

    // API가 로드 중인지 확인
    if (window.YT && window.YT.loaded) {
      setApiReady(true);
      return;
    }

    // API 로드
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    // API 준비 완료 콜백
    window.onYouTubeIframeAPIReady = () => {
      setApiReady(true);
    };
  }, []);

  // 플레이어 생성 (제어권이 있는 곳에서만)
  useEffect(() => {
    if (!apiReady || !music || !music.videoId || !playerRef.current || !hasControl) {
      return;
    }

    // 기존 플레이어가 있고 videoId가 다르면 새 비디오 로드
    if (youtubePlayerRef.current && playerReady) {
      const currentVideoId = youtubePlayerRef.current.getVideoData()?.video_id;
      if (currentVideoId !== music.videoId) {
        console.log('새 비디오 로드:', music.videoId);
        endedSentRef.current = false; // 새 음악 재생 시 플래그 리셋
        pauseTimeRef.current = null; // 새 음악 재생 시 일시정지 위치 초기화
        try {
          youtubePlayerRef.current.loadVideoById(music.videoId);
          if (isPlaying) {
            setTimeout(() => {
              if (youtubePlayerRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
                youtubePlayerRef.current.playVideo();
                // 재생 가능 여부 확인 (약간의 지연 후)
                setTimeout(() => {
                  if (youtubePlayerRef.current) {
                    try {
                      const playerState = youtubePlayerRef.current.getPlayerState();
                      // 플레이어가 에러 상태이거나 재생할 수 없는 상태인지 확인
                      if (playerState === window.YT.PlayerState.UNSTARTED) {
                        // UNSTARTED 상태가 계속 유지되면 재생 불가능한 동영상일 수 있음
                        setTimeout(() => {
                          if (youtubePlayerRef.current) {
                            const state = youtubePlayerRef.current.getPlayerState();
                            if (state === window.YT.PlayerState.UNSTARTED && window.socket && hasControl) {
                              console.log('동영상 재생 불가능 감지 (loadVideoById) - 다음 곡으로 이동');
                              if (!endedSentRef.current) {
                                endedSentRef.current = true;
                                window.socket.emit('musicEnded');
                              }
                            }
                          }
                        }, 2000); // 2초 후에도 UNSTARTED면 재생 불가능
                      }
                    } catch (e) {
                      console.log('플레이어 상태 확인 오류:', e);
                    }
                  }
                }, 1000);
              }
            }, 100);
          }
        } catch (e) {
          console.log('비디오 로드 오류:', e);
          // 로드 실패 시 다음 곡으로 이동
          if (window.socket && hasControl && !endedSentRef.current) {
            endedSentRef.current = true;
            window.socket.emit('musicEnded');
          }
        }
      }
      return;
    }

    // 기존 플레이어가 있으면 제거
    if (youtubePlayerRef.current) {
      try {
        youtubePlayerRef.current.destroy();
      } catch (e) {
        console.log('플레이어 제거 중 오류:', e);
      }
      youtubePlayerRef.current = null;
    }

    setPlayerReady(false);
    endedSentRef.current = false; // 새 음악 재생 시 플래그 리셋
    pauseTimeRef.current = null; // 새 음악 재생 시 일시정지 위치 초기화

    // 새 플레이어 생성
    try {
      youtubePlayerRef.current = new window.YT.Player(playerRef.current, {
        height: '200',
        width: '100%',
        videoId: music.videoId,
        playerVars: {
          autoplay: isPlaying ? 1 : 0,
          controls: 1, // YouTube 컨트롤 표시
          modestbranding: 1,
          rel: 0,
          disablekb: 0, // 키보드 단축키 활성화
          iv_load_policy: 3, // 주석 비활성화
          fs: 1, // 전체화면 버튼 표시
          playsinline: 1, // 인라인 재생
          enablejsapi: 1 // JavaScript API 활성화 (서버 제어용)
        },
        events: {
          onReady: (event) => {
            console.log('플레이어 준비 완료:', music.videoId);
            setPlayerReady(true);
            if (isPlaying) {
              try {
                event.target.playVideo();
                // 재생 가능 여부 확인 (약간의 지연 후)
                setTimeout(() => {
                  if (youtubePlayerRef.current) {
                    try {
                      const playerState = youtubePlayerRef.current.getPlayerState();
                      // 플레이어가 에러 상태이거나 재생할 수 없는 상태인지 확인
                      if (playerState === window.YT.PlayerState.UNSTARTED) {
                        // UNSTARTED 상태가 계속 유지되면 재생 불가능한 동영상일 수 있음
                        setTimeout(() => {
                          if (youtubePlayerRef.current) {
                            const state = youtubePlayerRef.current.getPlayerState();
                            if (state === window.YT.PlayerState.UNSTARTED && window.socket && hasControl) {
                              console.log('동영상 재생 불가능 감지 - 다음 곡으로 이동');
                              window.socket.emit('musicEnded');
                            }
                          }
                        }, 2000); // 2초 후에도 UNSTARTED면 재생 불가능
                      }
                    } catch (e) {
                      console.log('플레이어 상태 확인 오류:', e);
                    }
                  }
                }, 1000);
              } catch (e) {
                console.log('재생 시작 오류:', e);
              }
            }
          },
          onStateChange: (event) => {
            // 재생 종료 감지 (ENDED = -1) - 제어권 있는 세션에서만 서버에 알림
            if (event.data === window.YT.PlayerState.ENDED) {
              // 중복 전송 방지 및 제어권 확인
              if (!endedSentRef.current && window.socket && hasControl) {
                endedSentRef.current = true;
                console.log('음악 재생 종료 감지 - 서버에 알림 (제어권 보유)', {
                  videoId: music?.videoId,
                  title: music?.title,
                  socketConnected: window.socket?.connected
                });
                window.socket.emit('musicEnded');
                console.log('musicEnded 이벤트 전송 완료');
              } else {
                console.log('musicEnded 이벤트 전송 건너뜀', {
                  endedSent: endedSentRef.current,
                  hasSocket: !!window.socket,
                  hasControl: hasControl
                });
              }
            }
            // 재생 중이면 플래그 리셋 (일시정지 시간은 재생 시작 후 초기화)
            if (event.data === window.YT.PlayerState.PLAYING) {
              endedSentRef.current = false;
              // 재생이 시작되면 일시정지 시간 초기화 (약간의 지연을 두어 seekTo가 완료된 후 초기화)
              setTimeout(() => {
                pauseTimeRef.current = null;
              }, 500);
            }
            // 일시정지 시 현재 재생 위치 저장 (백업 - handlePause에서 저장하지 못한 경우 대비)
            if (event.data === window.YT.PlayerState.PAUSED) {
              if (youtubePlayerRef.current && hasControl) {
                try {
                  const currentTime = youtubePlayerRef.current.getCurrentTime();
                  // 위치가 저장되지 않았거나 0보다 크면 저장
                  if (currentTime > 0 && (pauseTimeRef.current === null || pauseTimeRef.current === 0)) {
                    pauseTimeRef.current = currentTime;
                    console.log('일시정지 상태 감지 - 위치 저장 (백업):', currentTime, '초');
                  }
                } catch (e) {
                  console.log('재생 위치 가져오기 오류:', e);
                }
              }
              // 일시정지 위치가 저장되어 있으면 사용자가 의도적으로 일시정지한 것이므로 자동 재생하지 않음
              // 일시정지 위치가 없고 서버가 재생 중이라고 하면 자동 재생 (YouTube 컨트롤로 일시정지한 경우)
              if (isPlaying && youtubePlayerRef.current && pauseTimeRef.current === null) {
                try {
                  youtubePlayerRef.current.playVideo();
                } catch (e) {
                  console.log('자동 재생 오류:', e);
                }
              }
            }
            // 버퍼링 중이거나 준비 중일 때도 서버 제어 유지
            if (event.data === window.YT.PlayerState.CUED && isPlaying) {
              setTimeout(() => {
                if (youtubePlayerRef.current && isPlaying) {
                  try {
                    youtubePlayerRef.current.playVideo();
                  } catch (e) {
                    // 무시
                  }
                }
              }, 500);
            }
          },
          onError: (event) => {
            console.error('YouTube 플레이어 오류:', event.data);
            // 재생 불가능한 동영상 에러 코드
            // 100: 동영상을 찾을 수 없음
            // 101: 동영상 소유자가 다른 웹사이트에서 재생할 수 없도록 설정함
            // 150: 동영상 소유자가 다른 웹사이트에서 재생할 수 없도록 설정함
            const unplayableErrorCodes = [100, 101, 150];
            
            if (unplayableErrorCodes.includes(event.data) && window.socket && hasControl) {
              console.log('재생 불가능한 동영상 감지 (에러 코드:', event.data, ') - 다음 곡으로 이동');
              // 중복 전송 방지
              if (!endedSentRef.current) {
                endedSentRef.current = true;
                window.socket.emit('musicEnded');
              }
            }
          }
        }
      });
    } catch (error) {
      console.error('플레이어 생성 오류:', error);
    }

    return () => {
      if (youtubePlayerRef.current) {
        try {
          youtubePlayerRef.current.destroy();
        } catch (e) {
          console.log('플레이어 정리 중 오류:', e);
        }
        youtubePlayerRef.current = null;
      }
      setPlayerReady(false);
    };
  }, [apiReady, music?.videoId, hasControl, isPlaying]); // videoId, hasControl, isPlaying 변경 시 업데이트

  // music이 변경될 때 endedSentRef 리셋 (새 음악 재생 시)
  useEffect(() => {
    if (music && music.videoId) {
      endedSentRef.current = false;
      console.log('새 음악 감지 - endedSentRef 리셋:', music.videoId);
    }
  }, [music?.videoId]);

  // 일시정지 버튼 핸들러
  const handlePause = () => {
    if (!isPlaying) return; // 이미 일시정지 상태면 무시
    
    if (youtubePlayerRef.current && hasControl) {
      try {
        // 현재 재생 위치 저장 (일시정지 전에 위치 저장)
        const currentTime = youtubePlayerRef.current.getCurrentTime();
        if (currentTime > 0) {
          pauseTimeRef.current = currentTime;
          console.log('일시정지 버튼 클릭 - 현재 위치 저장:', currentTime, '초');
        } else {
          console.log('일시정지 버튼 클릭 - 재생 위치를 가져올 수 없음');
        }
        // 즉시 플레이어 일시정지
        if (typeof youtubePlayerRef.current.pauseVideo === 'function') {
          youtubePlayerRef.current.pauseVideo();
          console.log('플레이어 일시정지 실행');
        }
      } catch (e) {
        console.log('일시정지 오류:', e);
      }
    }
    // 서버에 일시정지 요청
    onPause();
  };

  // 다시시작 버튼 핸들러
  const handleResume = () => {
    if (isPlaying) return; // 이미 재생 중이면 무시
    
    if (youtubePlayerRef.current && hasControl) {
      // 일시정지된 위치가 있으면 그 위치에서 재생
      if (pauseTimeRef.current !== null) {
        try {
          const seekTime = pauseTimeRef.current;
          console.log('다시시작 버튼 클릭 - 저장된 위치에서 재생:', seekTime);
          // 먼저 위치로 이동
          youtubePlayerRef.current.seekTo(seekTime, true);
          // 위치 이동 후 재생
          setTimeout(() => {
            if (youtubePlayerRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
              youtubePlayerRef.current.playVideo();
              // 재생 시작 후 일시정지 위치 초기화
              setTimeout(() => {
                pauseTimeRef.current = null;
              }, 500);
            }
          }, 200);
        } catch (e) {
          console.log('재생 위치 설정 오류:', e);
        }
      } else {
        // 일시정지 위치가 없으면 현재 위치에서 재생
        try {
          if (typeof youtubePlayerRef.current.playVideo === 'function') {
            youtubePlayerRef.current.playVideo();
          }
        } catch (e) {
          console.log('재생 오류:', e);
        }
      }
    }
    // 서버에 재생 요청
    onResume();
  };

  // 재생 상태 동기화 (서버 제어에 따라 - 강제 동기화, 제어권 있는 곳에서만)
  useEffect(() => {
    if (!playerReady || !youtubePlayerRef.current || !music || !hasControl) {
      return;
    }

    try {
      if (isPlaying) {
        // 서버가 재생 중이라고 하면 재생
        // 단, 일시정지 위치가 저장되어 있으면 사용자가 의도적으로 일시정지한 것이므로 자동 재생하지 않음
        if (pauseTimeRef.current !== null) {
          console.log('useEffect: 일시정지 위치가 저장되어 있어서 자동 재생하지 않음:', pauseTimeRef.current);
          return; // 일시정지 상태 유지
        }
        
        if (typeof youtubePlayerRef.current.playVideo === 'function') {
          const playerState = youtubePlayerRef.current.getPlayerState();
          // 이미 재생 중이 아니면 재생
          if (playerState !== window.YT.PlayerState.PLAYING) {
            youtubePlayerRef.current.playVideo();
          }
        }
      } else {
        // 서버가 중지했다고 하면 일시정지
        if (typeof youtubePlayerRef.current.pauseVideo === 'function') {
          const playerState = youtubePlayerRef.current.getPlayerState();
          // 이미 일시정지 상태가 아니면 일시정지
          if (playerState !== window.YT.PlayerState.PAUSED) {
            youtubePlayerRef.current.pauseVideo();
            console.log('useEffect: 플레이어 일시정지 실행');
          }
        }
      }
    } catch (error) {
      console.error('재생 제어 오류:', error);
    }
    
    // 주기적으로 재생 상태 확인 및 동기화
    const syncInterval = setInterval(() => {
      if (playerReady && youtubePlayerRef.current && music && hasControl) {
        try {
          const playerState = youtubePlayerRef.current.getPlayerState();
          
          // 서버가 재생 중인데 플레이어가 일시정지 상태면 재생
          // 단, 일시정지 위치가 저장되어 있으면 사용자가 의도적으로 일시정지한 것이므로 자동 재생하지 않음
          if (isPlaying && playerState === window.YT.PlayerState.PAUSED && pauseTimeRef.current === null) {
            // 일시정지 위치가 없으면 YouTube 컨트롤로 일시정지한 경우이므로 자동 재생
            youtubePlayerRef.current.playVideo();
          }
          
          // 서버가 재생 중인데 플레이어가 버퍼링 중이면 재생하지 않음 (정상 상태)
          // 서버가 재생 중인데 플레이어가 CUED 상태면 재생하지 않음 (정상 상태)
          
          // 서버가 중지했는데 플레이어가 재생 중이면 일시정지
          if (!isPlaying && playerState === window.YT.PlayerState.PLAYING) {
            youtubePlayerRef.current.pauseVideo();
          }
        } catch (e) {
          // 무시
        }
      }
    }, 1000); // 1초마다 확인

    return () => {
      clearInterval(syncInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, playerReady, music, hasControl]);

  if (!music) {
    return (
      <div className="current-playing">
        <h2>현재 재생 중</h2>
        <div className="no-music">
          <p>재생 중인 음악이 없습니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="current-playing">
      <h2>현재 재생 중</h2>
      <div className="music-card">
        <div className="thumbnail-container">
          <img src={music.thumbnail} alt={music.title} />
          {isPlaying && <div className="playing-indicator">재생 중</div>}
        </div>
        <div className="music-info">
          <h3>{music.title}</h3>
          <p className="requested-by">요청자: {music.requestedBy}</p>
          {/* 제어권이 있는 곳에서만 플레이어 표시 */}
          {hasControl ? (
            <div className="player-container">
              <div ref={playerRef}></div>
            </div>
          ) : (
            <div className="player-placeholder">
              <p>제어권이 있는 세션에서만 재생됩니다.</p>
            </div>
          )}
          
          {/* 제어 버튼들 (제어권 있는 세션에서만) */}
          {hasControl && music && (
            <div className="control-buttons">
              {isPlaying ? (
                <button 
                  onClick={handlePause} 
                  className="control-btn pause-btn"
                >
                  정지
                </button>
              ) : (
                <button 
                  onClick={handleResume} 
                  className="control-btn play-btn"
                >
                  다시시작
                </button>
              )}
            </div>
          )}
          
          {isAdmin ? (
            hasControl ? (
              <button onClick={onPlayNext} className="next-btn">
                다음 음악 재생
              </button>
            ) : (
              <button disabled className="next-btn disabled">
                다음 음악 재생 (제어권 없음)
              </button>
            )
          ) : (
            <button disabled className="next-btn disabled">
              다음 음악 재생 (서버에서만 가능)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default CurrentPlaying;

