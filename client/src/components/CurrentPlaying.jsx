import React, { useEffect, useRef, useState } from 'react';
import './CurrentPlaying.css';

function CurrentPlaying({ music, isPlaying, onPlayNext, onPause, onResume, isAdmin = false, hasControl = false }) {
  const playerRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const endedSentRef = useRef(false); // 재생 종료 알림 중복 방지
  const pauseTimeRef = useRef(null); // 일시정지 시점 저장
  const previousHasControlRef = useRef(false); // 이전 제어권 상태 추적 (제어권 획득 시점 감지용)
  const previousVideoIdRef = useRef(null); // 이전 videoId 추적 (새 음악 시작 감지용)
  const previousMusicRef = useRef(null); // 이전 music 추적 (music null에서 새 music으로 변경 감지용)

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

  // 제어권 상태 추적 및 제어권 획득 시 ENDED 상태 확인
  useEffect(() => {
    const wasControlAcquired = !previousHasControlRef.current && hasControl;
    previousHasControlRef.current = hasControl;
    
    // 제어권을 새로 가져온 경우, 이미 재생 중인 음악이 끝난 상태인지 확인
    // 모바일에서 제어권을 가져올 때 이미 ENDED 상태일 수 있음
    if (wasControlAcquired && playerReady && youtubePlayerRef.current && music && !isPlaying) {
      setTimeout(() => {
        if (youtubePlayerRef.current && window.socket && hasControl) {
          try {
            const playerState = youtubePlayerRef.current.getPlayerState();
            console.log('[제어권 획득] 플레이어 상태 확인:', {
              state: playerState,
              ENDED: window.YT.PlayerState.ENDED,
              isPlaying,
              videoId: music.videoId
            });
            
            // 이미 재생이 끝난 상태(ENDED)이면 즉시 다음 곡으로 이동
            if (playerState === window.YT.PlayerState.ENDED) {
              console.log('[제어권 획득] 이미 재생 종료된 상태 감지 - 다음 곡으로 이동');
              if (!endedSentRef.current) {
                endedSentRef.current = true;
                window.socket.emit('musicEnded');
              }
            }
          } catch (e) {
            console.log('제어권 획득 시 플레이어 상태 확인 오류:', e);
          }
        }
      }, 1000); // 플레이어가 준비될 시간을 주기 위해 약간의 지연
    }
  }, [hasControl, playerReady, music, isPlaying]);

  // 제어권이 없을 때 플레이어는 유지하되 재생 제어만 하지 않음
  // 제어권이 없는 클라이언트에서도 플레이어를 생성하여 영상을 표시할 수 있도록 함
  // 단, 재생 제어는 제어권이 있는 클라이언트에서만 수행

  // 플레이어 생성 (모든 클라이언트에서 생성, 재생은 제어권 있는 곳에서만)
  useEffect(() => {
    const effectStartTime = Date.now();
    
    // 이전 music 상태 확인 (music null에서 새 music으로 변경 감지)
    const wasMusicNull = previousMusicRef.current === null;
    const isNewMusicFromNull = wasMusicNull && music !== null;
    
    // previousMusicRef 업데이트
    previousMusicRef.current = music;
    
    console.log('[플레이어 생성 useEffect] 실행:', {
      apiReady,
      hasMusic: !!music,
      videoId: music?.videoId,
      hasPlayerRef: !!playerRef.current,
      hasControl,
      hasPlayer: !!youtubePlayerRef.current,
      playerReady,
      isPlaying,
      wasMusicNull,
      isNewMusicFromNull,
      timestamp: effectStartTime
    });
    
    if (!apiReady || !music || !music.videoId || !playerRef.current) {
      // 플레이어 생성 조건 불만족
      console.log('[플레이어 생성 useEffect] 조건 불만족 - 종료:', {
        apiReady,
        hasMusic: !!music,
        videoId: music?.videoId,
        hasPlayerRef: !!playerRef.current,
        missing: !apiReady ? 'apiReady' : !music ? 'music' : !music?.videoId ? 'videoId' : !playerRef.current ? 'playerRef' : 'unknown'
      });
      return;
    }
    
    // musicPlaying 이벤트 수신 후 즉시 플레이어 생성 보장
    // 플레이어가 없거나 준비되지 않았으면 즉시 생성
    if (!youtubePlayerRef.current || !playerReady) {
      console.log('[플레이어 생성 useEffect] 플레이어 없음 또는 준비 안됨 - 즉시 생성 필요:', {
        hasPlayer: !!youtubePlayerRef.current,
        playerReady,
        videoId: music.videoId
      });
    }

    // 기존 플레이어가 있고 videoId가 다르면 새 비디오 로드
    // 또는 music이 null에서 새 music으로 변경되었으면 무조건 새 비디오 로드
    if (youtubePlayerRef.current && playerReady) {
      let currentVideoId = null;
      let playerState = null;
      try {
        const videoData = youtubePlayerRef.current.getVideoData();
        currentVideoId = videoData?.video_id;
        playerState = youtubePlayerRef.current.getPlayerState();
      } catch (e) {
        console.log('[플레이어 생성 useEffect] 현재 비디오 ID 가져오기 오류:', e);
        // 오류 발생 시 무조건 새 비디오 로드
        currentVideoId = null;
      }
      
      console.log('[플레이어 생성 useEffect] 기존 플레이어 확인:', {
        currentVideoId,
        newVideoId: music.videoId,
        isDifferent: currentVideoId !== music.videoId,
        playerState: playerState,
        playerStateName: playerState !== null ? {
          '-1': 'ENDED',
          '0': 'UNSTARTED',
          '1': 'ENDED',
          '2': 'PLAYING',
          '3': 'PAUSED',
          '5': 'CUED',
          '3': 'BUFFERING'
        }[playerState] || 'UNKNOWN' : 'UNKNOWN',
        isNewMusicFromNull: isNewMusicFromNull
      });
      
      // videoId가 다르거나, getVideoData가 실패했거나, 플레이어가 ENDED 상태이면 새 비디오 로드
      // 또는 music이 null에서 새 music으로 변경되었으면 무조건 새 비디오 로드
      if (isNewMusicFromNull || currentVideoId !== music.videoId || currentVideoId === null || playerState === window.YT.PlayerState.ENDED) {
        const loadStartTime = Date.now();
        console.log('[플레이어 생성 useEffect] 새 비디오 로드 시작:', {
          videoId: music.videoId,
          isPlaying,
          hasControl,
          currentVideoId,
          timestamp: loadStartTime
        });
        endedSentRef.current = false; // 새 음악 재생 시 플래그 리셋
        pauseTimeRef.current = null; // 새 음악 재생 시 일시정지 위치 초기화
        try {
          // 기존 플레이어가 있으면 먼저 일시정지 (새 비디오 로드 전 정리)
          if (youtubePlayerRef.current) {
            try {
              const beforePauseState = youtubePlayerRef.current.getPlayerState();
              console.log('[loadVideoById] 기존 플레이어 일시정지 시도, 현재 상태:', beforePauseState);
              youtubePlayerRef.current.pauseVideo();
              console.log('[loadVideoById] 기존 플레이어 일시정지 완료');
            } catch (e) {
              console.log('[loadVideoById] 일시정지 오류 (무시):', e);
            }
          }
          
          console.log('[loadVideoById] loadVideoById 호출 직전 상태:', {
            hasPlayer: !!youtubePlayerRef.current,
            playerReady,
            videoId: music.videoId,
            isPlaying,
            hasControl
          });
          youtubePlayerRef.current.loadVideoById(music.videoId, true); // true = 즉시 재생 시작
          const loadCallTime = Date.now();
          console.log('[loadVideoById] 비디오 로드 호출 완료:', {
            videoId: music.videoId,
            isPlaying,
            hasControl,
            loadCallTime,
            elapsedSinceStart: loadCallTime - loadStartTime
          });
          
          // 제어권이 있으면 재생 시도 (music prop 변경을 재생 트리거로 사용, isPlaying 무관)
          if (hasControl) {
            // 모바일에서 비디오 로딩이 완료될 때까지 충분한 시간을 주기 위해 재생 시도를 여러 번 시도
            // loadVideoById 직후에는 플레이어가 UNSTARTED 상태일 수 있으므로 약간의 지연 후 시작
            const attemptPlay = (attemptCount = 0) => {
              if (!youtubePlayerRef.current || !hasControl) {
                console.log('[loadVideoById] 재생 시도 중단: 플레이어 없음, 또는 제어권 없음');
                return;
              }
              
              const maxAttempts = 20; // 최대 20번 시도 (약 10초) - 15에서 20으로 증가
              const initialDelay = attemptCount === 0 ? 800 : 500; // 첫 시도는 800ms 후, 이후는 500ms마다
              
              setTimeout(() => {
                if (!youtubePlayerRef.current || !hasControl) {
                  console.log('[loadVideoById] 재생 시도 중단: 플레이어 없음, 또는 제어권 없음');
                  return;
                }
                
                try {
                  const checkTime = Date.now();
                  const playerState = youtubePlayerRef.current.getPlayerState();
                  let currentTime = 0;
                  let duration = 0;
                  try {
                    currentTime = youtubePlayerRef.current.getCurrentTime();
                    duration = youtubePlayerRef.current.getDuration();
                  } catch (e) {
                    console.log('[loadVideoById] 재생 시간 정보 가져오기 오류:', e);
                  }
                  
                  console.log(`[loadVideoById] 재생 시도 ${attemptCount + 1}/${maxAttempts}`, {
                    상태: playerState,
                    상태명: {
                      '-1': 'ENDED',
                      '0': 'UNSTARTED',
                      '1': 'ENDED',
                      '2': 'PLAYING',
                      '3': 'PAUSED',
                      '5': 'CUED',
                      '3': 'BUFFERING'
                    }[playerState] || 'UNKNOWN',
                    현재시간: currentTime,
                    전체시간: duration,
                    진행률: duration > 0 ? `${(currentTime / duration * 100).toFixed(2)}%` : 'N/A',
                    경과시간: checkTime - loadStartTime,
                    hasControl,
                    timestamp: checkTime
                  });
                  
                  // PLAYING 상태가 아니면 모든 상태에서 재생 시도
                  // 모바일에서는 CUED, UNSTARTED, PAUSED, BUFFERING 등 모든 상태에서 재생을 시도해야 함
                  if (playerState !== window.YT.PlayerState.PLAYING) {
                    if (typeof youtubePlayerRef.current.playVideo === 'function') {
                      const playCallTime = Date.now();
                      console.log('[loadVideoById] playVideo() 호출 시작, 호출 전 상태:', playerState);
                      youtubePlayerRef.current.playVideo();
                      console.log('[loadVideoById] playVideo() 호출 완료', {
                        호출전상태: playerState,
                        호출시간: playCallTime,
                        경과시간: playCallTime - loadStartTime
                      });
                    } else {
                      console.error('[loadVideoById] playVideo 함수가 없음!');
                    }
                  } else {
                    console.log('[loadVideoById] 이미 PLAYING 상태 - 재생 시도 불필요');
                  }
                  
                  // PLAYING 상태가 아니고 아직 시도 횟수가 남아있으면 계속 시도
                  if (playerState !== window.YT.PlayerState.PLAYING && attemptCount < maxAttempts - 1) {
                    attemptPlay(attemptCount + 1);
                  } else if (playerState === window.YT.PlayerState.PLAYING) {
                    console.log('[loadVideoById] 재생 성공! PLAYING 상태');
                  } else if (playerState === window.YT.PlayerState.UNSTARTED && attemptCount >= maxAttempts - 1) {
                    // 최대 시도 횟수에 도달했는데도 UNSTARTED 상태면 재생 불가능한 동영상
                    console.log('[loadVideoById] 동영상 재생 불가능 감지 - 다음 곡으로 이동');
                    if (window.socket && hasControl && !endedSentRef.current) {
                      endedSentRef.current = true;
                      window.socket.emit('musicEnded');
                    }
                  } else if (playerState !== window.YT.PlayerState.PLAYING && attemptCount >= maxAttempts - 1) {
                    // 최대 시도 횟수에 도달했는데도 PLAYING 상태가 아니면 재생 실패로 간주
                    // 단, CUED 상태는 정상 상태이므로 재생 실패로 간주하지 않음 (재생이 곧 시작될 수 있음)
                    if (playerState === window.YT.PlayerState.CUED || playerState === window.YT.PlayerState.BUFFERING) {
                      console.log('[loadVideoById] CUED/BUFFERING 상태 유지 - 재생 대기 중 (재생 실패로 간주하지 않음)');
                      // CUED나 BUFFERING 상태는 정상이므로 다음 곡으로 넘어가지 않음
                      return;
                    }
                    // UNSTARTED나 다른 비정상 상태만 재생 실패로 간주
                    console.log('[loadVideoById] 재생 실패 감지 (최대 시도 횟수 도달) - 다음 곡으로 이동, 최종 상태:', playerState);
                    if (window.socket && hasControl && !endedSentRef.current) {
                      endedSentRef.current = true;
                      window.socket.emit('musicEnded');
                    }
                  }
                } catch (e) {
                  console.log('[loadVideoById] 재생 시도 오류:', e);
                  // 오류가 발생해도 계속 시도
                  if (attemptCount < maxAttempts - 1) {
                    attemptPlay(attemptCount + 1);
                  }
                }
              }, initialDelay);
            };
            
            // 첫 번째 재생 시도 시작 (800ms 후)
            attemptPlay(0);
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

    // 플레이어가 없거나 playerReady가 false이면 새 플레이어 생성
    // 또는 기존 플레이어가 있지만 videoId가 다르면 플레이어 재생성
    const needsNewPlayer = !youtubePlayerRef.current || !playerReady;
    let needsRecreate = false;
    
    if (youtubePlayerRef.current && playerReady) {
      let currentVideoId = null;
      let playerState = null;
      try {
        const videoData = youtubePlayerRef.current.getVideoData();
        currentVideoId = videoData?.video_id;
        playerState = youtubePlayerRef.current.getPlayerState();
      } catch (e) {
        console.log('[플레이어 생성 useEffect] 현재 비디오 ID 가져오기 오류:', e);
        needsRecreate = true;
      }
      
      // videoId가 다르거나, getVideoData가 실패했거나, 플레이어가 ENDED 상태이면 플레이어 재생성
      // 또는 music이 null에서 새 music으로 변경되었으면 무조건 플레이어 재생성
      if (isNewMusicFromNull || currentVideoId !== music.videoId || currentVideoId === null || playerState === window.YT.PlayerState.ENDED) {
        console.log('[플레이어 생성 useEffect] 플레이어 재생성 필요:', {
          currentVideoId,
          newVideoId: music.videoId,
          playerState: playerState,
          isNewMusicFromNull: isNewMusicFromNull,
          reason: isNewMusicFromNull ? 'music null에서 새 music으로 변경' : currentVideoId === null ? 'getVideoData 실패' : currentVideoId !== music.videoId ? 'videoId 불일치' : '플레이어 ENDED 상태'
        });
        needsRecreate = true;
      }
    }
    
    if (needsNewPlayer || needsRecreate) {
      console.log('[플레이어 생성 useEffect] 새 플레이어 생성 필요:', {
        needsNewPlayer,
        needsRecreate,
        videoId: music.videoId,
        isPlaying
      });
      
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

      console.log('[플레이어 생성 useEffect] 새 플레이어 생성 시작:', music.videoId, 'isPlaying:', isPlaying);

      // 새 플레이어 생성
      try {
      youtubePlayerRef.current = new window.YT.Player(playerRef.current, {
        height: '200',
        width: '100%',
        videoId: music.videoId,
        playerVars: {
          autoplay: isPlaying && hasControl ? 1 : 0, // 제어권이 있을 때만 자동 재생
          controls: hasControl ? 1 : 0, // 제어권이 있을 때만 YouTube 컨트롤 표시
          modestbranding: 1,
          rel: 0,
          disablekb: hasControl ? 0 : 1, // 제어권이 없을 때 키보드 단축키 비활성화
          iv_load_policy: 3, // 주석 비활성화
          fs: hasControl ? 1 : 0, // 제어권이 있을 때만 전체화면 버튼 표시
          playsinline: 1, // 인라인 재생
          enablejsapi: 1 // JavaScript API 활성화 (서버 제어용)
        },
        events: {
          onReady: (event) => {
            const readyTime = Date.now();
            let initialState = null;
            try {
              initialState = event.target.getPlayerState();
            } catch (e) {
              console.log('[onReady] 초기 상태 가져오기 오류:', e);
            }
            
            console.log('[onReady] 플레이어 준비 완료:', {
              videoId: music.videoId,
              hasControl,
              initialState,
              initialStateName: {
                '-1': 'ENDED',
                '0': 'UNSTARTED',
                '1': 'ENDED',
                '2': 'PLAYING',
                '3': 'PAUSED',
                '5': 'CUED',
                '3': 'BUFFERING'
              }[initialState] || 'UNKNOWN',
              isPlaying,
              timestamp: readyTime
            });
            setPlayerReady(true);
            
            // isPlaying이 true이고 제어권이 있으면 재생 (제어권이 없으면 재생하지 않음)
            // 제어권 획득 시 ENDED 체크는 별도의 useEffect에서 처리
            if (isPlaying && hasControl) {
              try {
                const playCallTime = Date.now();
                console.log('[onReady] playVideo() 호출 시작', {
                  videoId: music.videoId,
                  hasControl,
                  호출전상태: initialState,
                  timestamp: playCallTime
                });
                event.target.playVideo();
                console.log('[onReady] playVideo() 호출 완료', {
                  videoId: music.videoId,
                  호출시간: playCallTime
                });
                // 재생 가능 여부 확인 (약간의 지연 후)
                setTimeout(() => {
                  if (youtubePlayerRef.current) {
                    try {
                      const playerState = youtubePlayerRef.current.getPlayerState();
                      console.log('[onReady] 재생 시도 후 상태 확인:', playerState);
                      
                      // 플레이어가 에러 상태이거나 재생할 수 없는 상태인지 확인
                      if (playerState === window.YT.PlayerState.UNSTARTED) {
                        // UNSTARTED 상태가 계속 유지되면 재생 불가능한 동영상일 수 있음
                        setTimeout(() => {
                          if (youtubePlayerRef.current) {
                            const state = youtubePlayerRef.current.getPlayerState();
                            if (state === window.YT.PlayerState.UNSTARTED && window.socket && hasControl) {
                              console.log('[onReady] 동영상 재생 불가능 감지 (UNSTARTED 상태 유지) - 다음 곡으로 이동');
                              if (!endedSentRef.current) {
                                endedSentRef.current = true;
                                window.socket.emit('musicEnded');
                              }
                            }
                          }
                        }, 2000); // 2초 후에도 UNSTARTED면 재생 불가능
                      } else if (playerState !== window.YT.PlayerState.PLAYING && playerState !== window.YT.PlayerState.CUED && playerState !== window.YT.PlayerState.BUFFERING) {
                        // PLAYING, CUED, BUFFERING이 아닌 다른 상태면 재생 실패 가능성
                        // 단, PAUSED 상태는 사용자가 일시정지한 것일 수 있으므로 재생 실패로 간주하지 않음
                        if (playerState === window.YT.PlayerState.PAUSED) {
                          console.log('[onReady] PAUSED 상태 - 재생 실패로 간주하지 않음');
                          return;
                        }
                        // UNSTARTED 상태는 비디오가 아직 로드 중일 수 있으므로 더 긴 시간 대기
                        // 추가 확인을 위해 5초 후 상태 재확인 (시간 증가)
                        setTimeout(() => {
                          if (youtubePlayerRef.current && isPlaying) {
                            const state = youtubePlayerRef.current.getPlayerState();
                            // CUED, BUFFERING, PAUSED 상태는 정상이므로 다음 곡으로 넘어가지 않음
                            if (state === window.YT.PlayerState.CUED || 
                                state === window.YT.PlayerState.BUFFERING || 
                                state === window.YT.PlayerState.PAUSED) {
                              console.log('[onReady] 정상 상태 유지 - 재생 대기 중 (정상 상태):', state);
                              return;
                            }
                            // UNSTARTED 상태만 재생 불가능으로 간주
                            if (state === window.YT.PlayerState.UNSTARTED && window.socket && hasControl) {
                              console.log('[onReady] 재생 실패 감지 (UNSTARTED 상태 유지) - 다음 곡으로 이동');
                              if (!endedSentRef.current) {
                                endedSentRef.current = true;
                                window.socket.emit('musicEnded');
                              }
                            }
                          }
                        }, 5000); // 5초 후에도 UNSTARTED면 재생 불가능
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
            const stateChangeTime = Date.now();
            const stateName = {
              '-1': 'ENDED',
              '0': 'UNSTARTED',
              '1': 'ENDED',
              '2': 'PLAYING',
              '3': 'PAUSED',
              '5': 'CUED',
              '3': 'BUFFERING'
            }[event.data] || 'UNKNOWN';
            
            let currentTime = 0;
            let duration = 0;
            try {
              if (youtubePlayerRef.current) {
                currentTime = youtubePlayerRef.current.getCurrentTime();
                duration = youtubePlayerRef.current.getDuration();
              }
            } catch (e) {
              // 무시
            }
            
            console.log('[onStateChange] 플레이어 상태 변경:', {
              상태: event.data,
              상태명: stateName,
              videoId: music?.videoId,
              현재시간: currentTime,
              전체시간: duration,
              진행률: duration > 0 ? `${(currentTime / duration * 100).toFixed(2)}%` : 'N/A',
              isPlaying,
              hasControl,
              endedSent: endedSentRef.current,
              timestamp: stateChangeTime
            });
            
            // 재생 종료 감지 (ENDED = -1) - 제어권 있는 세션에서만 서버에 알림
            if (event.data === window.YT.PlayerState.ENDED) {
              const endedTime = Date.now();
              // musicPlaying 이벤트 수신 시간 확인 (플레이어 초기화 중 오탐 방지)
              const musicStartTime = music?.playStartTime ? new Date(music.playStartTime).getTime() : null;
              const elapsedSinceMusicStart = musicStartTime ? endedTime - musicStartTime : null;
              const IGNORE_DURATION = 5000; // 5초 이내는 무시
              
              console.log('[onStateChange] ENDED 상태 감지:', {
                videoId: music?.videoId,
                title: music?.title,
                현재시간: currentTime,
                전체시간: duration,
                진행률: duration > 0 ? `${(currentTime / duration * 100).toFixed(2)}%` : 'N/A',
                endedSent: endedSentRef.current,
                hasSocket: !!window.socket,
                hasControl: hasControl,
                socketConnected: window.socket?.connected,
                timestamp: endedTime,
                musicStartTime: musicStartTime,
                elapsedSinceMusicStart: elapsedSinceMusicStart,
                elapsedSeconds: elapsedSinceMusicStart ? (elapsedSinceMusicStart / 1000).toFixed(2) : null
              });
              
              // 플레이어 초기화 중 오탐 방지: 재생 시작 후 5초 이내 ENDED는 무시
              if (elapsedSinceMusicStart !== null && elapsedSinceMusicStart < IGNORE_DURATION) {
                console.log(`[onStateChange] ⚠️ 초기 ENDED 상태 무시 (재생 시작 후 ${(elapsedSinceMusicStart / 1000).toFixed(2)}초 경과, ${IGNORE_DURATION / 1000}초 이내)`, {
                  videoId: music?.videoId,
                  title: music?.title,
                  elapsedSinceMusicStart,
                  elapsedSeconds: (elapsedSinceMusicStart / 1000).toFixed(2),
                  reason: '플레이어 초기화 중 오탐 가능성 - 플레이어가 준비되는 시간 필요'
                });
                return; // 무시하고 종료
              }
              
              // 중복 전송 방지 및 제어권 확인
              if (!endedSentRef.current && window.socket && hasControl) {
                endedSentRef.current = true;
                console.log('[onStateChange] musicEnded 이벤트 전송 시작 (제어권 보유)', {
                  videoId: music?.videoId,
                  title: music?.title,
                  socketConnected: window.socket?.connected,
                  timestamp: endedTime,
                  elapsedSinceMusicStart: elapsedSinceMusicStart,
                  elapsedSeconds: elapsedSinceMusicStart ? (elapsedSinceMusicStart / 1000).toFixed(2) : null
                });
                window.socket.emit('musicEnded');
                const sentTime = Date.now();
                console.log('[onStateChange] musicEnded 이벤트 전송 완료', {
                  전송시간: sentTime,
                  경과시간: sentTime - endedTime
                });
              } else {
                console.log('[onStateChange] musicEnded 이벤트 전송 건너뜀', {
                  endedSent: endedSentRef.current,
                  hasSocket: !!window.socket,
                  hasControl: hasControl,
                  이유: !endedSentRef.current ? 'endedSent가 true' : !window.socket ? 'socket 없음' : !hasControl ? '제어권 없음' : '알 수 없음'
                });
              }
            }
            // 재생 중이면 플래그 리셋 (일시정지 시간은 재생 시작 후 초기화)
            if (event.data === window.YT.PlayerState.PLAYING) {
              endedSentRef.current = false;
              // 재생이 시작되면 일시정지 시간 즉시 초기화 (handleResume에서 이미 초기화했을 수 있음)
              // seekTo가 완료된 후 초기화하되, 이미 null이면 무시
              if (pauseTimeRef.current !== null) {
                setTimeout(() => {
                  pauseTimeRef.current = null;
                }, 500);
              }
            }
            // 일시정지 시 현재 재생 위치 저장 (백업 - handlePause에서 저장하지 못한 경우 대비)
            if (event.data === window.YT.PlayerState.PAUSED) {
              if (youtubePlayerRef.current && hasControl) {
                try {
                  const currentTime = youtubePlayerRef.current.getCurrentTime();
                  // 위치가 저장되지 않았거나 0보다 크면 저장
                  // 단, 서버가 재생 중인데 일시정지된 경우에만 저장 (사용자가 의도적으로 일시정지한 경우)
                  // 서버가 일시정지 상태인데 플레이어가 일시정지된 경우는 저장하지 않음 (이미 일시정지 상태)
                  if (currentTime > 0 && (pauseTimeRef.current === null || pauseTimeRef.current === 0)) {
                    // 서버가 재생 중인데 플레이어가 일시정지된 경우에만 저장
                    // 이는 사용자가 YouTube 플레이어 컨트롤로 일시정지한 경우
                    if (isPlaying) {
                      pauseTimeRef.current = currentTime;
                      console.log('[onStateChange] 일시정지 상태 감지 - 위치 저장 (백업):', currentTime, '초, 서버는 재생 중');
                    } else {
                      console.log('[onStateChange] 일시정지 상태 감지 - 서버도 일시정지 상태이므로 위치 저장하지 않음');
                    }
                  }
                } catch (e) {
                  console.log('재생 위치 가져오기 오류:', e);
                }
              }
              // 일시정지 위치가 저장되어 있으면 사용자가 의도적으로 일시정지한 것이므로 자동 재생하지 않음
              // 일시정지 위치가 없고 서버가 재생 중이라고 하면 자동 재생 (YouTube 컨트롤로 일시정지한 경우)
              // 단, pauseTimeRef가 방금 저장된 경우는 사용자가 의도적으로 일시정지한 것이므로 재생하지 않음
              // 제어권이 있을 때만 자동 재생
              if (isPlaying && hasControl && youtubePlayerRef.current && pauseTimeRef.current === null) {
                console.log('[onStateChange] 서버는 재생 중인데 플레이어는 일시정지 - 자동 재생 시도');
                try {
                  youtubePlayerRef.current.playVideo();
                } catch (e) {
                  console.log('[onStateChange] 자동 재생 오류:', e);
                }
              }
            }
            // 버퍼링 중이거나 준비 중일 때도 서버 제어 유지
            // CUED 상태는 비디오가 로드되어 재생 준비가 된 상태
            // 제어권이 있으면 재생 시도 (music prop 변경을 재생 트리거로 사용, isPlaying 무관)
            if (event.data === window.YT.PlayerState.CUED && hasControl) {
              console.log('[onStateChange] CUED 상태 감지 - 즉시 재생 시도');
              // CUED 상태에서 즉시 재생 시도 (모바일에서 지연될 수 있으므로)
              if (youtubePlayerRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
                try {
                  youtubePlayerRef.current.playVideo();
                  console.log('[onStateChange] CUED 상태에서 재생 시도 완료');
                  
                  // 재생이 시작되었는지 확인 (약간의 지연 후)
                  setTimeout(() => {
                    if (youtubePlayerRef.current && hasControl) {
                      const state = youtubePlayerRef.current.getPlayerState();
                      if (state !== window.YT.PlayerState.PLAYING) {
                        // 재생이 시작되지 않았으면 다시 시도
                        console.log('[onStateChange] CUED 상태에서 재생이 시작되지 않음, 재시도, 현재 상태:', state);
                        if (typeof youtubePlayerRef.current.playVideo === 'function') {
                          youtubePlayerRef.current.playVideo();
                        }
                      } else {
                        console.log('[onStateChange] CUED 상태에서 재생 성공!');
                      }
                    }
                  }, 500);
                } catch (e) {
                  console.log('[onStateChange] CUED 상태에서 재생 시도 오류:', e);
                }
              }
            }
            // UNSTARTED 상태도 재생 시도 (loadVideoById 직후 발생할 수 있음)
            if (event.data === window.YT.PlayerState.UNSTARTED && hasControl) {
              console.log('[onStateChange] UNSTARTED 상태 감지 - 재생 시도');
              if (youtubePlayerRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
                try {
                  youtubePlayerRef.current.playVideo();
                  console.log('[onStateChange] UNSTARTED 상태에서 재생 시도 완료');
                } catch (e) {
                  console.log('[onStateChange] UNSTARTED 상태에서 재생 시도 오류:', e);
                }
              }
            }
          },
          onError: (event) => {
            console.error('YouTube 플레이어 오류:', event.data);
            // 재생 불가능한 동영상 에러 코드
            // 100: 동영상을 찾을 수 없음
            // 101: 동영상 소유자가 다른 웹사이트에서 재생할 수 없도록 설정함
            // 150: 동영상 소유자가 다른 웹사이트에서 재생할 수 없도록 설정함
            // 2: 요청에 잘못된 매개변수 값이 포함됨 (일시적 오류일 수 있음 - 재시도)
            // 5: HTML5 플레이어 오류 (일시적 오류일 수 있음 - 재시도)
            const unplayableErrorCodes = [100, 101, 150]; // 확실히 재생 불가능한 오류만
            const retryableErrorCodes = [2, 5]; // 재시도 가능한 오류
            
            if (window.socket && hasControl) {
              if (unplayableErrorCodes.includes(event.data)) {
                // 확실히 재생 불가능한 오류만 다음 곡으로 이동
                console.log('[onError] 재생 불가능한 동영상 감지 (에러 코드:', event.data, ') - 다음 곡으로 이동');
                if (!endedSentRef.current) {
                  endedSentRef.current = true;
                  window.socket.emit('musicEnded');
                }
              } else if (retryableErrorCodes.includes(event.data)) {
                // 재시도 가능한 오류는 재생 시도
                console.log('[onError] 일시적 오류 감지 (에러 코드:', event.data, ') - 재생 재시도');
                setTimeout(() => {
                  if (youtubePlayerRef.current && isPlaying && typeof youtubePlayerRef.current.playVideo === 'function') {
                    try {
                      youtubePlayerRef.current.playVideo();
                      console.log('[onError] 재생 재시도 완료');
                    } catch (e) {
                      console.log('[onError] 재생 재시도 오류:', e);
                    }
                  }
                }, 1000);
              } else {
                // 알 수 없는 오류는 로그만 남기고 계속 재생 시도
                console.log('[onError] 알 수 없는 오류 (에러 코드:', event.data, ') - 재생 계속 시도');
              }
            }
          }
        }
      });
      } catch (error) {
        console.error('플레이어 생성 오류:', error);
      }
    }

    return () => {
      // cleanup 함수: 컴포넌트 언마운트 또는 의존성 변경 시 실행
      // React의 DOM 조작이 완료된 후 플레이어 제거
      let timeoutId = null;
      
      timeoutId = setTimeout(() => {
        if (youtubePlayerRef.current) {
          try {
            // 플레이어 제거 (오류 발생 시 무시)
            youtubePlayerRef.current.destroy();
          } catch (e) {
            // 이미 제거되었거나 오류가 발생해도 무시
            console.log('플레이어 정리 중 오류 (무시):', e);
          }
          youtubePlayerRef.current = null;
        }
        setPlayerReady(false);
      }, 0);
      
      // cleanup에서 timeout 정리
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [apiReady, music, hasControl, isPlaying]); // music 객체 전체를 의존성에 추가하여 music 변경 시 플레이어 재생성

  // music이 null이 되었을 때 플레이어 정리
  useEffect(() => {
    const wasMusicNull = previousMusicRef.current === null;
    const isMusicNull = music === null;
    previousMusicRef.current = music;
    
    // music이 null이 되었을 때 플레이어 정리
    if (!wasMusicNull && isMusicNull) {
      console.log('[music null 감지] 플레이어 정리 시작');
      if (youtubePlayerRef.current) {
        try {
          youtubePlayerRef.current.destroy();
          console.log('[music null 감지] 플레이어 제거 완료');
        } catch (e) {
          console.log('[music null 감지] 플레이어 제거 오류 (무시):', e);
        }
        youtubePlayerRef.current = null;
      }
      setPlayerReady(false);
      endedSentRef.current = false;
      pauseTimeRef.current = null;
    }
  }, [music]);

  // music이 변경될 때 endedSentRef 리셋 (새 음악 재생 시)
  useEffect(() => {
    if (music && music.videoId) {
      const isNewMusic = previousVideoIdRef.current !== music.videoId;
      previousVideoIdRef.current = music.videoId;
      if (isNewMusic) {
        endedSentRef.current = false;
        console.log('새 음악 감지 - endedSentRef 리셋:', music.videoId);
      }
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
    console.log('[handleResume] 다시시작 버튼 클릭:', {
      isPlaying,
      hasPlayer: !!youtubePlayerRef.current,
      hasControl,
      pauseTime: pauseTimeRef.current,
      playerReady
    });
    
    if (isPlaying) {
      console.log('[handleResume] 이미 재생 중이므로 무시');
      return; // 이미 재생 중이면 무시
    }
    
    // 플레이어가 없거나 제어권이 없으면 서버에만 재생 요청
    if (!youtubePlayerRef.current || !hasControl) {
      console.log('[handleResume] 플레이어 또는 제어권 없음 - 서버에만 재생 요청');
      onResume();
      return;
    }
    
    // 플레이어가 준비되지 않았으면 서버에만 재생 요청
    if (!playerReady) {
      console.log('[handleResume] 플레이어가 준비되지 않음 - 서버에만 재생 요청');
      onResume();
      return;
    }
    
    // 일시정지 위치를 먼저 초기화 (재생 상태 동기화 useEffect가 재생을 막지 않도록)
    const savedPauseTime = pauseTimeRef.current;
    pauseTimeRef.current = null;
    
    // 일시정지된 위치가 있으면 그 위치에서 재생
    if (savedPauseTime !== null) {
      try {
        console.log('[handleResume] 저장된 위치에서 재생:', savedPauseTime);
        
        // 먼저 위치로 이동
        youtubePlayerRef.current.seekTo(savedPauseTime, true);
        console.log('[handleResume] seekTo 완료:', savedPauseTime);
        
        // 위치 이동 후 재생
        setTimeout(() => {
          if (youtubePlayerRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
            try {
              youtubePlayerRef.current.playVideo();
              console.log('[handleResume] 재생 시도 완료');
            } catch (e) {
              console.log('[handleResume] 재생 시도 오류:', e);
            }
          }
        }, 200);
      } catch (e) {
        console.log('[handleResume] 재생 위치 설정 오류:', e);
        // 오류 발생 시에도 일시정지 위치는 이미 초기화됨
      }
    } else {
      // 일시정지 위치가 없으면 현재 위치에서 재생
      console.log('[handleResume] 현재 위치에서 재생');
      try {
        if (typeof youtubePlayerRef.current.playVideo === 'function') {
          youtubePlayerRef.current.playVideo();
          console.log('[handleResume] 재생 시도 완료');
        }
      } catch (e) {
        console.log('[handleResume] 재생 오류:', e);
      }
    }
    
    // 서버에 재생 요청
    console.log('[handleResume] 서버에 재생 요청 전송');
    onResume();
  };

  // 재생 상태 동기화 (서버 제어에 따라 - 강제 동기화, 제어권 있는 곳에서만)
  useEffect(() => {
    console.log('[재생 상태 동기화 useEffect] 실행:', {
      playerReady,
      hasPlayer: !!youtubePlayerRef.current,
      hasMusic: !!music,
      videoId: music?.videoId,
      hasControl,
      isPlaying
    });
    
    if (!playerReady || !youtubePlayerRef.current || !music || !hasControl) {
      console.log('[재생 상태 동기화 useEffect] 조건 불만족 - 종료');
      return;
    }

    try {
      // 현재 플레이어의 비디오 ID 확인
      let currentVideoId = null;
      let playerState = null;
      try {
        const videoData = youtubePlayerRef.current.getVideoData();
        currentVideoId = videoData?.video_id;
        playerState = youtubePlayerRef.current.getPlayerState();
      } catch (e) {
        console.log('[재생 상태 동기화] 현재 비디오 ID 가져오기 오류:', e);
      }
      
      // 비디오 ID가 다르거나, getVideoData가 실패했거나, 플레이어가 ENDED 상태이면 새 비디오 로드
      // music prop 변경을 재생 트리거로 사용 (isPlaying 무관)
      if (currentVideoId !== music.videoId || currentVideoId === null || playerState === window.YT.PlayerState.ENDED) {
          console.log('[재생 상태 동기화] 새 비디오 로드 필요:', {
            currentVideoId,
            newVideoId: music.videoId,
            playerState: playerState,
            reason: currentVideoId === null ? 'getVideoData 실패' : currentVideoId !== music.videoId ? 'videoId 불일치' : '플레이어 ENDED 상태'
          });
          try {
            // 기존 플레이어가 있으면 먼저 일시정지 (새 비디오 로드 전 정리)
            try {
              youtubePlayerRef.current.pauseVideo();
            } catch (e) {
              console.log('[재생 상태 동기화] 일시정지 오류 (무시):', e);
            }
            
            youtubePlayerRef.current.loadVideoById(music.videoId, true); // true = 즉시 재생 시작
            console.log('[재생 상태 동기화] 새 비디오 로드 완료:', music.videoId, 'hasControl:', hasControl);
            
            // loadVideoById 후 재생 시도 (약간의 지연 후)
            // 제어권이 있으면 재생 시도 (music prop 변경을 재생 트리거로 사용, isPlaying 무관)
            if (hasControl) {
              setTimeout(() => {
                if (youtubePlayerRef.current && hasControl && typeof youtubePlayerRef.current.playVideo === 'function') {
                  try {
                    youtubePlayerRef.current.playVideo();
                    console.log('[재생 상태 동기화] 새 비디오 로드 후 재생 시도 완료');
                  } catch (e) {
                    console.log('[재생 상태 동기화] 새 비디오 로드 후 재생 시도 오류:', e);
                  }
                }
              }, 800);
            }
          } catch (e) {
            console.log('[재생 상태 동기화] 새 비디오 로드 오류:', e);
          }
          return; // 비디오 로드 후 재생은 loadVideoById의 onStateChange에서 처리됨
        }
        
        // 서버가 재생 중이라고 하면 재생
        // 단, 일시정지 위치가 저장되어 있으면 사용자가 의도적으로 일시정지한 것이므로 자동 재생하지 않음
        if (isPlaying) {
          if (pauseTimeRef.current !== null) {
            console.log('[재생 상태 동기화] 일시정지 위치가 저장되어 있어서 자동 재생하지 않음:', pauseTimeRef.current);
            return; // 일시정지 상태 유지
          }
          
          if (typeof youtubePlayerRef.current.playVideo === 'function') {
            const playerState = youtubePlayerRef.current.getPlayerState();
            console.log('[재생 상태 동기화] 서버는 재생 중, 플레이어 상태:', playerState, '비디오 ID:', currentVideoId);
            
            // 이미 재생 중이 아니면 재생
            // CUED, UNSTARTED, PAUSED, BUFFERING 등 모든 상태에서 재생 시도
            // 모바일에서 CUED 상태에서 재생이 시작되지 않을 수 있음
            if (playerState !== window.YT.PlayerState.PLAYING) {
              console.log('[재생 상태 동기화] 재생 시도, 현재 상태:', playerState);
              try {
                youtubePlayerRef.current.playVideo();
                
                // 재생이 시작되었는지 확인 (약간의 지연 후)
                setTimeout(() => {
                  if (youtubePlayerRef.current && isPlaying) {
                    const state = youtubePlayerRef.current.getPlayerState();
                    if (state !== window.YT.PlayerState.PLAYING) {
                      // 재생이 시작되지 않았으면 다시 시도
                      console.log('[재생 상태 동기화] 재생이 시작되지 않음, 재시도, 현재 상태:', state);
                      if (typeof youtubePlayerRef.current.playVideo === 'function') {
                        youtubePlayerRef.current.playVideo();
                      }
                    } else {
                      console.log('[재생 상태 동기화] 재생 성공!');
                    }
                  }
                }, 500);
              } catch (e) {
                console.log('[재생 상태 동기화] 재생 시도 오류:', e);
              }
            }
          }
        } else {
        // 서버가 중지했다고 하면 일시정지
        if (typeof youtubePlayerRef.current.pauseVideo === 'function') {
          const playerState = youtubePlayerRef.current.getPlayerState();
          // 이미 일시정지 상태가 아니면 일시정지
          if (playerState !== window.YT.PlayerState.PAUSED) {
            youtubePlayerRef.current.pauseVideo();
            console.log('[재생 상태 동기화] 플레이어 일시정지 실행');
          }
        }
      }
    } catch (error) {
      console.error('[재생 상태 동기화] 재생 제어 오류:', error);
    }
  }, [playerReady, music, hasControl, isPlaying]); // 의존성 배열에 music, playerReady 추가
  
  // 주기적으로 재생 상태 확인 및 동기화
  // 모바일에서 백그라운드로 가거나 화면이 꺼질 때 onStateChange 이벤트가 발생하지 않을 수 있으므로
  // 주기적으로 플레이어 상태를 확인하여 ENDED 상태를 감지
  // 제어권이 있는 곳에서만 재생 제어
  useEffect(() => {
    if (!playerReady || !youtubePlayerRef.current || !music) {
      return;
    }
    
    // 제어권이 없으면 재생 제어하지 않음
    if (!hasControl) {
      return;
    }
    
    const syncInterval = setInterval(() => {
      if (playerReady && youtubePlayerRef.current && music && hasControl) {
        try {
          const playerState = youtubePlayerRef.current.getPlayerState();
          
          // 모바일에서 백그라운드로 가거나 화면이 꺼질 때 ENDED 상태를 감지하지 못할 수 있으므로
          // 주기적으로 ENDED 상태를 확인하여 다음 곡으로 이동
          // 단, 서버가 재생 중이라고 하면 ENDED 상태가 아니어야 하므로, 서버 상태와 플레이어 상태를 모두 확인
          if (playerState === window.YT.PlayerState.ENDED) {
            // 플레이어 초기화 중 오탐 방지: 재생 시작 후 5초 이내 ENDED는 무시
            const musicStartTime = music?.playStartTime ? new Date(music.playStartTime).getTime() : null;
            const elapsedSinceMusicStart = musicStartTime ? Date.now() - musicStartTime : null;
            const IGNORE_DURATION = 5000; // 5초 이내는 무시
            
            if (elapsedSinceMusicStart !== null && elapsedSinceMusicStart < IGNORE_DURATION) {
              console.log(`[주기적 상태 확인] ⚠️ 초기 ENDED 상태 무시 (재생 시작 후 ${(elapsedSinceMusicStart / 1000).toFixed(2)}초 경과, ${IGNORE_DURATION / 1000}초 이내)`, {
                videoId: music?.videoId,
                title: music?.title,
                elapsedSinceMusicStart,
                elapsedSeconds: (elapsedSinceMusicStart / 1000).toFixed(2),
                reason: '플레이어 초기화 중 오탐 가능성'
              });
              return; // 무시하고 종료
            }
            
            // 서버가 재생 중이라고 하면 ENDED 상태가 아니어야 함
            // 서버 상태와 플레이어 상태가 불일치하면 재생 시간을 확인하여 실제로 끝났는지 확인
            if (isPlaying) {
              // 서버는 재생 중인데 플레이어는 ENDED 상태
              // 이는 실제 재생 종료가 아닐 수 있으므로, 재생 시간을 확인
              try {
                const currentTime = youtubePlayerRef.current.getCurrentTime();
                const duration = youtubePlayerRef.current.getDuration();
                console.log('[주기적 상태 확인] ENDED 상태 감지 (서버는 재생 중), 재생 시간 확인:', {
                  currentTime,
                  duration,
                  videoId: music?.videoId
                });
                
                // 재생 시간이 duration에 근접하지 않으면 실제 종료가 아닐 수 있음
                // duration의 95% 이상 재생되었을 때만 실제 종료로 간주
                if (duration && currentTime > 0 && currentTime < duration * 0.95) {
                  console.log('[주기적 상태 확인] ENDED 상태이지만 재생 시간이 부족 - 실제 종료가 아님, 재생 재시도');
                  // 실제 종료가 아니므로 재생 재시도
                  if (typeof youtubePlayerRef.current.playVideo === 'function') {
                    youtubePlayerRef.current.playVideo();
                  }
                  return; // 다음 곡으로 넘어가지 않음
                }
              } catch (e) {
                console.log('[주기적 상태 확인] 재생 시간 확인 오류:', e);
                // 오류 발생 시 재생 재시도
                if (typeof youtubePlayerRef.current.playVideo === 'function') {
                  youtubePlayerRef.current.playVideo();
                }
                return; // 다음 곡으로 넘어가지 않음
              }
            }
            
            // 서버도 재생 중이 아니거나, 실제로 재생이 끝났으면 다음 곡으로 이동
            if (!endedSentRef.current && window.socket) {
              endedSentRef.current = true;
              console.log('[주기적 상태 확인] 재생 종료 상태 감지 - 다음 곡으로 이동 (모바일 백업 로직)', {
                videoId: music?.videoId,
                title: music?.title,
                socketConnected: window.socket?.connected,
                isPlaying
              });
              window.socket.emit('musicEnded');
            }
            return; // ENDED 상태면 다른 동기화 로직 실행하지 않음
          }
          
          // 서버가 재생 중인데 플레이어가 일시정지 상태면 재생
          // 단, 일시정지 위치가 저장되어 있으면 사용자가 의도적으로 일시정지한 것이므로 자동 재생하지 않음
          if (isPlaying && playerState === window.YT.PlayerState.PAUSED && pauseTimeRef.current === null) {
            // 일시정지 위치가 없으면 YouTube 컨트롤로 일시정지한 경우이므로 자동 재생
            youtubePlayerRef.current.playVideo();
          }
          
          // 플레이어가 CUED 상태면 재생 시도 (music prop 변경을 재생 트리거로 사용, isPlaying 무관)
          // 모바일에서 loadVideoById 후 CUED 상태에서 재생이 시작되지 않을 수 있음
          if (hasControl && playerState === window.YT.PlayerState.CUED && pauseTimeRef.current === null) {
            console.log('[주기적 상태 확인] CUED 상태 감지 - 재생 시도');
            try {
              if (typeof youtubePlayerRef.current.playVideo === 'function') {
                youtubePlayerRef.current.playVideo();
                console.log('[주기적 상태 확인] CUED 상태에서 재생 시도 완료');
              }
            } catch (e) {
              console.log('[주기적 상태 확인] CUED 상태에서 재생 시도 오류:', e);
            }
          }
          
          // 플레이어가 UNSTARTED 상태면 재생 시도 (music prop 변경을 재생 트리거로 사용, isPlaying 무관)
          // loadVideoById 후 UNSTARTED 상태에서 재생이 시작되지 않을 수 있음
          if (hasControl && playerState === window.YT.PlayerState.UNSTARTED && pauseTimeRef.current === null) {
            console.log('[주기적 상태 확인] UNSTARTED 상태 감지 - 재생 시도');
            try {
              if (typeof youtubePlayerRef.current.playVideo === 'function') {
                youtubePlayerRef.current.playVideo();
                console.log('[주기적 상태 확인] UNSTARTED 상태에서 재생 시도 완료');
              }
            } catch (e) {
              console.log('[주기적 상태 확인] UNSTARTED 상태에서 재생 시도 오류:', e);
            }
          }
          
          // 서버가 재생 중인데 플레이어가 버퍼링 중이면 재생하지 않음 (정상 상태)
          
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
  }, [isPlaying, playerReady, music, hasControl]);

  // 제어권이 없고 음악이 없으면 "재생 중인 음악이 없습니다" 표시
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

  // 제어권이 없으면 썸네일만 표시
  if (!hasControl) {
    return (
      <div className="current-playing">
        <h2>현재 재생 중</h2>
        <div className="music-card">
          <div className="thumbnail-container">
            <img src={music.thumbnail} alt={music.title} />
            {isPlaying && <div className="playing-indicator">재생 중</div>}
          </div>
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
          {/* 플레이어 컨테이너는 항상 렌더링 (제어권 상실 시 DOM 충돌 방지) */}
          <div className="player-container">
            <div ref={playerRef}></div>
          </div>
          
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

