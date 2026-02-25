import React, { useEffect, useRef, useState } from 'react';
import './CurrentPlaying.css';

function CurrentPlaying({ music, isPlaying, onPlayNext, isAdmin = false }) {
  const playerRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const endedSentRef = useRef(false); // 재생 종료 알림 중복 방지

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

  // 플레이어 생성
  useEffect(() => {
    if (!apiReady || !music || !music.videoId || !playerRef.current) {
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

    // 새 플레이어 생성
    try {
      youtubePlayerRef.current = new window.YT.Player(playerRef.current, {
        height: '200',
        width: '100%',
        videoId: music.videoId,
        playerVars: {
          autoplay: isPlaying ? 1 : 0,
          controls: 0, // 컨트롤 완전히 숨김 (서버에서만 제어)
          modestbranding: 1,
          rel: 0,
          disablekb: 1, // 키보드 단축키 비활성화
          iv_load_policy: 3, // 주석 비활성화
          fs: 0, // 전체화면 버튼 숨김
          playsinline: 1, // 인라인 재생
          enablejsapi: 1 // JavaScript API 활성화 (서버 제어용)
        },
        events: {
          onReady: (event) => {
            setPlayerReady(true);
            if (isPlaying) {
              try {
                event.target.playVideo();
              } catch (e) {
                console.log('재생 시작 오류:', e);
              }
            }
          },
          onStateChange: (event) => {
            // 재생 종료 감지 (ENDED = -1) - 서버에만 알림
            if (event.data === window.YT.PlayerState.ENDED) {
              // 중복 전송 방지
              if (!endedSentRef.current && window.socket) {
                endedSentRef.current = true;
                console.log('음악 재생 종료 감지 - 서버에 알림');
                window.socket.emit('musicEnded');
                
                // 플래그는 새 음악이 재생될 때 리셋됨 (플레이어 재생성 시)
              }
            }
            // 재생 중이면 플래그 리셋 (새 음악 재생 시작)
            if (event.data === window.YT.PlayerState.PLAYING) {
              endedSentRef.current = false;
            }
            // 사용자가 일시정지/정지 시도 시 즉시 자동 재생 (서버 제어 강제)
            if (event.data === window.YT.PlayerState.PAUSED && isPlaying) {
              // 서버가 재생 중이라고 하면 즉시 재생 (사용자 제어 불가)
              if (youtubePlayerRef.current && isPlaying) {
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
  }, [apiReady, music?.videoId]); // videoId가 변경될 때만 재생성

  // 재생 상태 동기화 (서버 제어에 따라 - 강제 동기화)
  useEffect(() => {
    if (!playerReady || !youtubePlayerRef.current || !music) {
      return;
    }

    try {
      if (isPlaying) {
        // 서버가 재생 중이라고 하면 항상 재생 (사용자가 정지해도 강제 재생)
        if (typeof youtubePlayerRef.current.playVideo === 'function') {
          youtubePlayerRef.current.playVideo();
        }
      } else {
        // 서버가 중지했다고 하면만 일시정지
        if (typeof youtubePlayerRef.current.pauseVideo === 'function') {
          youtubePlayerRef.current.pauseVideo();
        }
      }
    } catch (error) {
      console.error('재생 제어 오류:', error);
    }
    
    // 주기적으로 재생 상태 확인 및 강제 동기화 (사용자가 정지해도 자동 재생)
    const syncInterval = setInterval(() => {
      if (playerReady && youtubePlayerRef.current && music) {
        try {
          const playerState = youtubePlayerRef.current.getPlayerState();
          
          // 서버가 재생 중인데 플레이어가 일시정지 상태면 강제 재생
          if (isPlaying && (playerState === window.YT.PlayerState.PAUSED || 
                            playerState === window.YT.PlayerState.CUED ||
                            playerState === window.YT.PlayerState.BUFFERING)) {
            youtubePlayerRef.current.playVideo();
          }
          
          // 서버가 중지했는데 플레이어가 재생 중이면 일시정지
          if (!isPlaying && playerState === window.YT.PlayerState.PLAYING) {
            youtubePlayerRef.current.pauseVideo();
          }
        } catch (e) {
          // 무시
        }
      }
    }, 500); // 0.5초마다 확인 (더 빠른 동기화)

    return () => {
      clearInterval(syncInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, playerReady, music]);

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
          <div className="player-container">
            <div ref={playerRef}></div>
          </div>
          {isAdmin ? (
            <button onClick={onPlayNext} className="next-btn">
              다음 음악 재생
            </button>
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

