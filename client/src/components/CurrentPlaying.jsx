import React, { useEffect, useRef, useState } from 'react';
import './CurrentPlaying.css';

function CurrentPlaying({ music, isPlaying, onPlayNext, onPause, onResume, isAdmin = false, hasControl = false, localPlayMode = false, setLocalPlayMode, mySessionId = null }) {
  const playerRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const [localIsPlaying, setLocalIsPlaying] = useState(false); // 로컬 재생 상태
  const [isLiked, setIsLiked] = useState(false); // 좋아요 상태
  const [likeCount, setLikeCount] = useState(0); // 좋아요 개수
  // 플레이어 이벤트 핸들러는 플레이어 생성 시점에 고정되므로 최신 값은 ref로 읽음
  const hasControlRef = useRef(hasControl);
  const isPlayingRef = useRef(isPlaying);
  const localPlayModeRef = useRef(localPlayMode);
  const musicRef = useRef(music);
  musicRef.current = music;

  // musicEnded에 어떤 영상이 끝났는지 함께 보냄 (서버가 다른 곡에 대한 늦은 신호를 무시할 수 있도록)
  const getEndedPayload = () => {
    let videoId = null;
    try {
      videoId = youtubePlayerRef.current?.getVideoData?.()?.video_id || null;
    } catch (e) {
      // 무시
    }
    return { videoId: videoId || musicRef.current?.videoId || null };
  };
  hasControlRef.current = hasControl;
  isPlayingRef.current = isPlaying;
  localPlayModeRef.current = localPlayMode;
  const [serverPlaybackPosition, setServerPlaybackPosition] = useState(null); // 서버 재생 위치
  const [volume, setVolume] = useState(() => {
    // localStorage에서 볼륨 설정 불러오기 (기본값: 100)
    const savedVolume = localStorage.getItem('musicVolume');
    return savedVolume ? parseInt(savedVolume, 10) : 100;
  });
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const endedSentRef = useRef(false); // 재생 종료 알림 중복 방지
  const pauseTimeRef = useRef(null); // 일시정지 시점 저장
  const manualNextRef = useRef(false); // 수동 다음 곡 전환 플래그
  const previousHasControlRef = useRef(false); // 이전 제어권 상태 추적 (제어권 획득 시점 감지용)
  const previousVideoIdRef = useRef(null); // 이전 videoId 추적 (새 음악 시작 감지용)
  const previousMusicRef = useRef(null); // 이전 music 추적 (music null에서 새 music으로 변경 감지용)
  const lastSyncTimeRef = useRef(0); // 마지막 동기화 시간 (5초에 1회 제한)
  const playbackPositionIntervalRef = useRef(null); // 재생 위치 전송 인터벌
  const cleanupTimeoutRef = useRef(null); // cleanup timeout 추적
  const lastSentPositionRef = useRef(null); // 제어권 있는 클라이언트가 마지막으로 전송한 재생 위치
  const lastSentTimeRef = useRef(0); // 제어권 있는 클라이언트가 마지막으로 전송한 시간
  const lastSyncTimeForControlRef = useRef(0); // 제어권 있는 클라이언트의 마지막 동기화 시간 (10초에 1회 제한)
  const serverPlaybackPositionRef = useRef(null); // 서버 재생 위치 ref (onReady에서 접근용)
  const previousPositionRef = useRef(null); // 이전 재생 위치 (seek 감지용)
  const seekCheckIntervalRef = useRef(null); // seek 감지 인터벌
  const lastPlayAttemptRef = useRef(null); // 마지막 재생 시도 시간 (중복 재생 방지)
  const isResumingRef = useRef(false); // 재생 재개 시도 중 플래그 (handleResume에서 재생을 시도하는 중임을 표시)
  const resumeStartTimeRef = useRef(null); // 재생 재개 시도 시작 시간 (타임아웃 계산용)

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
                window.socket.emit('musicEnded', getEndedPayload());
              }
            }
          } catch (e) {
            console.log('제어권 획득 시 플레이어 상태 확인 오류:', e);
          }
        }
      }, 1000); // 플레이어가 준비될 시간을 주기 위해 약간의 지연
    }
  }, [hasControl, playerReady, music, isPlaying]);

  // 제어권 획득 시 즉시 서버 재생 위치로 동기화
  useEffect(() => {
    const wasControlAcquired = !previousHasControlRef.current && hasControl;
    
    // 제어권을 새로 획득했고, 재생 중이며, 서버 재생 위치가 있을 때 즉시 동기화
    if (wasControlAcquired && hasControl && playerReady && youtubePlayerRef.current && isPlaying && 
        serverPlaybackPosition && music && serverPlaybackPosition.videoId === music.videoId) {
      try {
        const myPosition = youtubePlayerRef.current.getCurrentTime();
        const serverPosition = serverPlaybackPosition.position;
        
        // 네트워크 지연 보정
        const delay = (Date.now() - serverPlaybackPosition.timestamp) / 1000;
        const adjustedServerPosition = serverPosition + delay;
        
        const difference = Math.abs(myPosition - adjustedServerPosition);
        
        // 차이가 0.5초 이상이면 동기화 (제어권 획득 시에는 더 엄격하게)
        if (difference >= 0.5) {
          console.log('[제어권 획득] 즉시 재생 위치 동기화:', {
            내위치: myPosition,
            서버위치: adjustedServerPosition,
            차이: difference
          });
          
          if (typeof youtubePlayerRef.current.seekTo === 'function') {
            youtubePlayerRef.current.seekTo(adjustedServerPosition, true);
            lastSyncTimeForControlRef.current = Date.now();
            // 동기화 후 전송 위치도 업데이트
            lastSentPositionRef.current = adjustedServerPosition;
            lastSentTimeRef.current = Date.now();
          }
        }
      } catch (e) {
        console.log('[제어권 획득] 재생 위치 동기화 오류:', e);
      }
    }
  }, [hasControl, playerReady, isPlaying, serverPlaybackPosition, music]);

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
    
    // 플레이어 생성 조건: apiReady, music, videoId, playerRef가 필요
    // 제어권이 있거나 localPlayMode가 true일 때 생성
    // 제어권이 없어도 서버의 일시정지 상태를 반영하기 위해 플레이어 생성 (숨김 처리)
    const shouldCreatePlayer = apiReady && music && music.videoId && playerRef.current;
    
    if (!shouldCreatePlayer) {
      // 플레이어 생성 조건 불만족
      console.log('[플레이어 생성 useEffect] 조건 불만족 - 종료:', {
        apiReady,
        hasMusic: !!music,
        videoId: music?.videoId,
        hasPlayerRef: !!playerRef.current,
        hasControl,
        localPlayMode,
        missing: !apiReady ? 'apiReady' : !music ? 'music' : !music?.videoId ? 'videoId' : !playerRef.current ? 'playerRef' : (!hasControl && !localPlayMode) ? 'hasControl or localPlayMode' : 'unknown'
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
      
      // music이 null에서 새 music으로 변경되었으면 플레이어를 완전히 재생성 (loadVideoById 대신)
      if (isNewMusicFromNull) {
        console.log('[플레이어 생성 useEffect] music null에서 새 music으로 변경 - 플레이어 재생성 필요');
        // 기존 플레이어 제거
        if (youtubePlayerRef.current) {
          try {
            // 플레이어가 실제로 DOM에 존재하는지 확인
            const playerElement = playerRef.current;
            if (playerElement && playerElement.parentNode) {
              youtubePlayerRef.current.destroy();
              console.log('[플레이어 생성 useEffect] 기존 플레이어 제거 완료');
            } else {
              console.log('[플레이어 생성 useEffect] 플레이어가 이미 DOM에서 제거됨');
            }
          } catch (e) {
            console.log('[플레이어 생성 useEffect] 플레이어 제거 오류 (무시):', e);
          }
          youtubePlayerRef.current = null;
        }
        setPlayerReady(false);
        endedSentRef.current = false;
        pauseTimeRef.current = null;
        manualNextRef.current = false; // 수동 다음 곡 전환 플래그 리셋
        // 플레이어 재생성 로직으로 진행 (아래 needsRecreate 로직 사용)
      }
      // videoId가 다르거나, getVideoData가 실패했거나, 플레이어가 ENDED 상태이면 새 비디오 로드
      else if (currentVideoId !== music.videoId || currentVideoId === null || playerState === window.YT.PlayerState.ENDED) {
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
        manualNextRef.current = false; // 수동 다음 곡 전환 플래그 리셋
        lastPlayAttemptRef.current = null; // 재생 시도 시간 리셋
        try {
          // 기존 플레이어가 있으면 완전히 정리 (새 비디오 로드 전)
          if (youtubePlayerRef.current) {
            try {
              const beforeState = youtubePlayerRef.current.getPlayerState();
              console.log('[loadVideoById] 기존 플레이어 정리 시작, 현재 상태:', beforeState);
              
              // 먼저 일시정지
              try {
              youtubePlayerRef.current.pauseVideo();
                console.log('[loadVideoById] 플레이어 일시정지 완료');
            } catch (e) {
              console.log('[loadVideoById] 일시정지 오류 (무시):', e);
            }
              
              // stopVideo로 완전히 정리 (재생 중이거나 버퍼링 중일 때)
              try {
                if (beforeState === window.YT.PlayerState.PLAYING || 
                    beforeState === window.YT.PlayerState.BUFFERING ||
                    beforeState === window.YT.PlayerState.CUED) {
                  youtubePlayerRef.current.stopVideo();
                  console.log('[loadVideoById] 플레이어 stopVideo 완료');
                }
              } catch (e) {
                console.log('[loadVideoById] stopVideo 오류 (무시):', e);
              }
            } catch (e) {
              console.log('[loadVideoById] 플레이어 정리 오류 (무시):', e);
            }
          }
          
          // 플레이어 정리 후 약간의 지연 (플레이어가 완전히 정리될 시간 확보)
          const targetVideoId = music.videoId; // 클로저로 videoId 저장
          setTimeout(() => {
            if (!youtubePlayerRef.current || !music) {
              console.log('[loadVideoById] 지연 후 상태 확인 - 플레이어 없음 또는 music 없음');
              return;
            }
            
            // music이 변경되었는지 확인
            if (music.videoId !== targetVideoId) {
              console.log('[loadVideoById] 지연 후 music 변경됨 - 로드 취소', {
                targetVideoId,
                currentVideoId: music.videoId
              });
              return;
          }
          
          console.log('[loadVideoById] loadVideoById 호출 직전 상태:', {
            hasPlayer: !!youtubePlayerRef.current,
            playerReady,
            videoId: music.videoId,
            isPlaying,
            hasControl,
            playStartTime: music.playStartTime
          });
          
          // playStartTime이 있으면 현재 재생 위치 계산 (모든 클라이언트)
          let startSeconds = 0;
          if (music.playStartTime) {
            const playStartTime = new Date(music.playStartTime).getTime();
            const currentTime = Date.now();
            const elapsedSeconds = Math.floor((currentTime - playStartTime) / 1000);
            startSeconds = Math.max(0, elapsedSeconds);
            console.log('[loadVideoById] 현재 재생 위치 계산:', {
              playStartTime: music.playStartTime,
              currentTime: currentTime,
              elapsedSeconds: startSeconds,
              hasControl
            });
          }
          
            try {
          youtubePlayerRef.current.loadVideoById(music.videoId, startSeconds); // startSeconds = 시작 위치
          const loadCallTime = Date.now();
          console.log('[loadVideoById] 비디오 로드 호출 완료:', {
            videoId: music.videoId,
            isPlaying,
            hasControl,
            loadCallTime,
            elapsedSinceStart: loadCallTime - loadStartTime
          });
          
          // 제어권이 있거나 로컬 재생 모드이면 재생 시도
          if (hasControl || localPlayMode) {
            // 모바일에서 비디오 로딩이 완료될 때까지 충분한 시간을 주기 위해 재생 시도를 여러 번 시도
            // loadVideoById 직후에는 플레이어가 UNSTARTED 상태일 수 있으므로 약간의 지연 후 시작
            const attemptPlay = (attemptCount = 0) => {
              if (!youtubePlayerRef.current || (!hasControl && !localPlayMode)) {
                console.log('[loadVideoById] 재생 시도 중단: 플레이어 없음, 또는 제어권/로컬 재생 모드 없음');
                return;
              }
              
              const maxAttempts = 30; // 최대 30번 시도 (약 15초) - 20에서 30으로 증가
              const initialDelay = attemptCount === 0 ? 500 : 300; // 첫 시도는 500ms 후, 이후는 300ms마다 (더 빠른 재시도)
              
              setTimeout(() => {
                if (!youtubePlayerRef.current || (!hasControl && !localPlayMode)) {
                  console.log('[loadVideoById] 재생 시도 중단: 플레이어 없음, 또는 제어권/로컬 재생 모드 없음');
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
                  
                  // PLAYING 상태가 아니면 재생 시도 (단, 최근 500ms 이내 재생 시도가 없을 때만)
                  // 단, BUFFERING 상태일 때는 재생 시도하지 않음 (버퍼링 중에는 재생 시도하면 스피너가 계속 나타날 수 있음)
                  const now = Date.now();
                  const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                  
                  if (playerState !== window.YT.PlayerState.PLAYING && playerState !== window.YT.PlayerState.BUFFERING && timeSinceLastAttempt > 500) {
                    if (typeof youtubePlayerRef.current.playVideo === 'function') {
                      const playCallTime = Date.now();
                      console.log('[loadVideoById] playVideo() 호출 시작, 호출 전 상태:', playerState);
                      lastPlayAttemptRef.current = playCallTime; // 재생 시도 시간 기록
                      youtubePlayerRef.current.playVideo();
                      console.log('[loadVideoById] playVideo() 호출 완료', {
                        호출전상태: playerState,
                        호출시간: playCallTime,
                        경과시간: playCallTime - loadStartTime
                      });
                    } else {
                      console.error('[loadVideoById] playVideo 함수가 없음!');
                    }
                  } else if (playerState === window.YT.PlayerState.PLAYING) {
                    console.log('[loadVideoById] 이미 PLAYING 상태 - 재생 시도 불필요');
                  } else if (playerState === window.YT.PlayerState.BUFFERING) {
                    console.log('[loadVideoById] BUFFERING 상태 - 재생 시도하지 않음 (정상 상태)');
                  } else if (timeSinceLastAttempt <= 500) {
                    console.log('[loadVideoById] 최근 재생 시도가 있어서 중복 호출 방지 (경과:', timeSinceLastAttempt, 'ms)');
                  }
                  
                  // PLAYING 상태가 아니고 BUFFERING도 아니며 아직 시도 횟수가 남아있으면 계속 시도
                  if (playerState !== window.YT.PlayerState.PLAYING && playerState !== window.YT.PlayerState.BUFFERING && attemptCount < maxAttempts - 1) {
                    attemptPlay(attemptCount + 1);
                  } else if (playerState === window.YT.PlayerState.PLAYING) {
                    console.log('[loadVideoById] 재생 성공! PLAYING 상태');
                  } else if (playerState === window.YT.PlayerState.BUFFERING) {
                    console.log('[loadVideoById] BUFFERING 상태 - 재생 대기 중 (정상 상태)');
                  } else if (playerState === window.YT.PlayerState.UNSTARTED && attemptCount >= maxAttempts - 1) {
                    // 최대 시도 횟수에 도달했는데도 UNSTARTED 상태면 재생 불가능한 동영상
                    console.log('[loadVideoById] 동영상 재생 불가능 감지 - 다음 곡으로 이동');
                    if (window.socket && hasControl && !endedSentRef.current) {
                      endedSentRef.current = true;
                      window.socket.emit('musicEnded', getEndedPayload());
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
                      window.socket.emit('musicEnded', getEndedPayload());
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
            
                // 첫 번째 재생 시도 시작 (500ms 후)
            attemptPlay(0);
          }
        } catch (e) {
              console.log('[loadVideoById] loadVideoById 호출 오류:', e);
          // 로드 실패 시 다음 곡으로 이동
          if (window.socket && hasControl && !endedSentRef.current) {
            endedSentRef.current = true;
            window.socket.emit('musicEnded', getEndedPayload());
              }
            }
          }, 200); // 플레이어 정리 후 200ms 지연
        } catch (e) {
          console.log('[loadVideoById] 플레이어 정리 오류:', e);
          // 오류 발생 시에도 비디오 로드 시도
          if (youtubePlayerRef.current && music) {
            try {
              let startSeconds = 0;
              if (music.playStartTime) {
                const playStartTime = new Date(music.playStartTime).getTime();
                const currentTime = Date.now();
                const elapsedSeconds = Math.floor((currentTime - playStartTime) / 1000);
                startSeconds = Math.max(0, elapsedSeconds);
              }
              youtubePlayerRef.current.loadVideoById(music.videoId, startSeconds);
            } catch (loadError) {
              console.log('[loadVideoById] 비디오 로드 재시도 오류:', loadError);
              if (window.socket && hasControl && !endedSentRef.current) {
                endedSentRef.current = true;
                window.socket.emit('musicEnded', getEndedPayload());
              }
            }
          }
        }
        return;
      }
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
          // 플레이어가 실제로 DOM에 존재하는지 확인
          const playerElement = playerRef.current;
          if (playerElement && playerElement.parentNode) {
            youtubePlayerRef.current.destroy();
          } else {
            console.log('[플레이어 생성] 플레이어가 이미 DOM에서 제거됨');
          }
        } catch (e) {
          console.log('[플레이어 생성] 플레이어 제거 중 오류:', e);
        }
        youtubePlayerRef.current = null;
      }

      setPlayerReady(false);
      endedSentRef.current = false; // 새 음악 재생 시 플래그 리셋
      pauseTimeRef.current = null; // 새 음악 재생 시 일시정지 위치 초기화
      manualNextRef.current = false; // 수동 다음 곡 전환 플래그 리셋
      lastPlayAttemptRef.current = null; // 재생 시도 시간 리셋

      console.log('[플레이어 생성 useEffect] 새 플레이어 생성 시작:', music.videoId, 'isPlaying:', isPlaying);

      // 새 플레이어 생성
      try {
      // 제어권이 없고 로컬 재생 모드일 때는 오디오만 재생 (영상 숨김)
      const isAudioOnly = !hasControl && localPlayMode;
      
      // playStartTime이 있으면 현재 재생 위치 계산 (모든 클라이언트)
      let initialStartSeconds = 0;
      if (music.playStartTime) {
        const playStartTime = new Date(music.playStartTime).getTime();
        const currentTime = Date.now();
        const elapsedSeconds = Math.floor((currentTime - playStartTime) / 1000);
        initialStartSeconds = Math.max(0, elapsedSeconds);
        console.log('[플레이어 생성] 현재 재생 위치 계산:', {
          playStartTime: music.playStartTime,
          currentTime: currentTime,
          elapsedSeconds: initialStartSeconds,
          hasControl,
          localPlayMode
        });
      }
      
      youtubePlayerRef.current = new window.YT.Player(playerRef.current, {
        height: isAudioOnly ? '1' : '200', // 오디오만 재생할 때는 높이를 1px로 설정
        width: '100%',
        videoId: music.videoId,
        playerVars: {
          autoplay: 0, // 항상 0으로 설정하고 onReady에서 위치 확인 후 재생
          start: initialStartSeconds, // 시작 위치 지정 (제어권이 없거나 로컬 재생 모드일 때)
          controls: hasControl ? 1 : 0, // 제어권이 있을 때만 YouTube 컨트롤 표시 (로컬 재생 모드에서는 오디오만이므로 컨트롤 숨김)
          modestbranding: 1,
          rel: 0,
          disablekb: hasControl ? 0 : 1, // 제어권이 있을 때만 키보드 단축키 활성화
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
            
            // 볼륨 설정 (저장된 볼륨 값 적용)
            if (youtubePlayerRef.current && typeof youtubePlayerRef.current.setVolume === 'function') {
              try {
                youtubePlayerRef.current.setVolume(volume);
                console.log('[onReady] 볼륨 설정:', volume);
              } catch (e) {
                console.log('[onReady] 볼륨 설정 오류:', e);
              }
            }
            
            // isPlaying이 true이고 제어권이 있으면 재생
            // 또는 localPlayMode가 true이고 localIsPlaying이 true이면 로컬 재생
            // 제어권 획득 시 ENDED 체크는 별도의 useEffect에서 처리
            // 단, 이미 PLAYING 상태이거나 최근 재생 시도가 있으면 중복 호출 방지
            const now = Date.now();
            const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
            
            if (((isPlaying && hasControl) || (localPlayMode && localIsPlaying)) && 
                initialState !== window.YT.PlayerState.PLAYING && 
                timeSinceLastAttempt > 500) {
              try {
                const playCallTime = Date.now();
                console.log('[onReady] playVideo() 호출 시작', {
                  videoId: music.videoId,
                  hasControl,
                  localPlayMode,
                  호출전상태: initialState,
                  timestamp: playCallTime
                });
                lastPlayAttemptRef.current = playCallTime; // 재생 시도 시간 기록
                
                // 서버 재생 위치를 우선 사용, 없으면 playStartTime 사용 (모든 클라이언트)
                let seekPosition = 0;
                let positionSource = 'none';
                
                // 서버 재생 위치 확인 (우선 사용)
                if (serverPlaybackPositionRef.current && 
                    serverPlaybackPositionRef.current.videoId === music.videoId &&
                    typeof serverPlaybackPositionRef.current.position === 'number') {
                  const serverPos = serverPlaybackPositionRef.current;
                  // 네트워크 지연 보정
                  const delay = (Date.now() - serverPos.timestamp) / 1000;
                  seekPosition = serverPos.position + delay;
                  positionSource = 'server';
                  
                  console.log('[onReady] 서버 재생 위치 사용:', {
                    서버위치: serverPos.position,
                    지연보정: delay,
                    최종위치: seekPosition,
                    hasControl,
                    localPlayMode
                  });
                } else if (music.playStartTime) {
                  // 서버 재생 위치가 없으면 playStartTime 사용
                  const playStartTime = new Date(music.playStartTime).getTime();
                  const currentTime = Date.now();
                  const elapsedSeconds = Math.floor((currentTime - playStartTime) / 1000);
                  seekPosition = Math.max(0, elapsedSeconds);
                  positionSource = 'playStartTime';
                  
                  console.log('[onReady] playStartTime 사용:', {
                    playStartTime: music.playStartTime,
                    currentTime: currentTime,
                    elapsedSeconds: seekPosition,
                    hasControl,
                    localPlayMode
                  });
                }
                
                console.log('[onReady] 최종 재생 위치 결정:', {
                  위치: seekPosition,
                  출처: positionSource,
                  hasControl,
                  localPlayMode
                });
                
                // 제어권이 없거나 로컬 재생 모드이면 현재 위치부터 재생
                if ((!hasControl || localPlayMode) && seekPosition > 0) {
                  // 현재 위치로 이동 후 재생
                  if (typeof event.target.seekTo === 'function') {
                    event.target.seekTo(seekPosition, true);
                    console.log('[onReady] seekTo 호출:', seekPosition, '초');
                    // seekTo 후 약간의 지연 후 재생
                    setTimeout(() => {
                      if (youtubePlayerRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
                        const currentState = youtubePlayerRef.current.getPlayerState();
                        if (currentState !== window.YT.PlayerState.PLAYING) {
                          const attemptNow = Date.now();
                          const timeSinceLastAttempt = lastPlayAttemptRef.current ? attemptNow - lastPlayAttemptRef.current : Infinity;
                          if (timeSinceLastAttempt > 500) {
                            lastPlayAttemptRef.current = attemptNow;
                        youtubePlayerRef.current.playVideo();
                        console.log('[onReady] 재생 시작 (현재 위치부터):', seekPosition, '초');
                          }
                        }
                      }
                    }, 500); // 충분한 지연
                  } else {
                    // seekTo가 없으면 바로 재생
                    const currentState = event.target.getPlayerState();
                    if (currentState !== window.YT.PlayerState.PLAYING) {
                    event.target.playVideo();
                    console.log('[onReady] playVideo() 호출 완료 (seekTo 없음)');
                    }
                  }
                } else if (hasControl && !localPlayMode) {
                  // 제어권이 있고 로컬 재생 모드가 아니면 현재 위치부터 재생 (서버 재생 위치 동기화)
                  if (seekPosition > 0) {
                    // 현재 위치로 이동 후 재생
                    if (typeof event.target.seekTo === 'function') {
                      event.target.seekTo(seekPosition, true);
                      console.log('[onReady] 제어권 있음 - seekTo 호출:', seekPosition, '초');
                      // seekTo 후 약간의 지연 후 재생
                      setTimeout(() => {
                        if (youtubePlayerRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
                          const currentState = youtubePlayerRef.current.getPlayerState();
                          if (currentState !== window.YT.PlayerState.PLAYING) {
                            const attemptNow = Date.now();
                            const timeSinceLastAttempt = lastPlayAttemptRef.current ? attemptNow - lastPlayAttemptRef.current : Infinity;
                            if (timeSinceLastAttempt > 500) {
                              lastPlayAttemptRef.current = attemptNow;
                          youtubePlayerRef.current.playVideo();
                          console.log('[onReady] 제어권 있음 - 재생 시작 (현재 위치부터):', seekPosition, '초');
                            }
                          }
                        }
                      }, 500); // 충분한 지연
                    } else {
                      const currentState = event.target.getPlayerState();
                      if (currentState !== window.YT.PlayerState.PLAYING) {
                      event.target.playVideo();
                      console.log('[onReady] 제어권 있음 - playVideo() 호출 완료 (seekTo 없음)');
                      }
                    }
                  } else {
                    // 위치가 0이면 처음부터 재생
                    const currentState = event.target.getPlayerState();
                    if (currentState !== window.YT.PlayerState.PLAYING) {
                    event.target.playVideo();
                    console.log('[onReady] 제어권 있음 - playVideo() 호출 완료 (처음부터)', {
                      videoId: music.videoId,
                      호출시간: playCallTime,
                      seekPosition,
                      playStartTime: music.playStartTime
                    });
                    }
                  }
                } else {
                  // 위치가 0이면 처음부터 재생
                  const currentState = event.target.getPlayerState();
                  if (currentState !== window.YT.PlayerState.PLAYING) {
                  event.target.playVideo();
                  console.log('[onReady] playVideo() 호출 완료', {
                    videoId: music.videoId,
                    호출시간: playCallTime,
                    hasControl,
                    localPlayMode,
                    seekPosition,
                    playStartTime: music.playStartTime
                  });
                  }
                }
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
                            if (state === window.YT.PlayerState.UNSTARTED && window.socket && hasControlRef.current) {
                              console.log('[onReady] 동영상 재생 불가능 감지 (UNSTARTED 상태 유지) - 다음 곡으로 이동');
                              if (!endedSentRef.current) {
                                endedSentRef.current = true;
                                window.socket.emit('musicEnded', getEndedPayload());
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
                          if (youtubePlayerRef.current && isPlayingRef.current) {
                            const state = youtubePlayerRef.current.getPlayerState();
                            // CUED, BUFFERING, PAUSED 상태는 정상이므로 다음 곡으로 넘어가지 않음
                            if (state === window.YT.PlayerState.CUED || 
                                state === window.YT.PlayerState.BUFFERING || 
                                state === window.YT.PlayerState.PAUSED) {
                              console.log('[onReady] 정상 상태 유지 - 재생 대기 중 (정상 상태):', state);
                              return;
                            }
                            // UNSTARTED 상태만 재생 불가능으로 간주
                            if (state === window.YT.PlayerState.UNSTARTED && window.socket && hasControlRef.current) {
                              console.log('[onReady] 재생 실패 감지 (UNSTARTED 상태 유지) - 다음 곡으로 이동');
                              if (!endedSentRef.current) {
                                endedSentRef.current = true;
                                window.socket.emit('musicEnded', getEndedPayload());
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
            // 로컬 재생 모드에서는 서버에 알림하지 않음
            if (event.data === window.YT.PlayerState.ENDED) {
              // 로컬 재생 모드에서 재생 종료 시 다음 곡으로 자동 전환
              if (localPlayMode && !hasControl && music) {
                console.log('[onStateChange] 로컬 재생 종료 - 다음 곡 대기');
                setLocalIsPlaying(false);
                // musicPlaying 이벤트를 기다려서 자동으로 새 곡 재생
              }
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
              // 단, 정지 상태(isPlaying === false)에서는 다음 곡으로 넘어가지 않음
              // 단, 수동 다음 곡 전환(manualNextRef.current === true)인 경우는 허용
              if (!endedSentRef.current && window.socket && hasControl && (isPlaying || manualNextRef.current)) {
                endedSentRef.current = true;
                console.log('[onStateChange] musicEnded 이벤트 전송 시작 (제어권 보유)', {
                  videoId: music?.videoId,
                  title: music?.title,
                  socketConnected: window.socket?.connected,
                  timestamp: endedTime,
                  elapsedSinceMusicStart: elapsedSinceMusicStart,
                  elapsedSeconds: elapsedSinceMusicStart ? (elapsedSinceMusicStart / 1000).toFixed(2) : null
                });
                window.socket.emit('musicEnded', getEndedPayload());
                manualNextRef.current = false; // musicEnded 전송 후 수동 다음 곡 전환 플래그 리셋
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
            // 재생이 시작되면 일시정지 시간 확인 및 위치 동기화
            // handleResume에서 재생 재개 시 정지된 위치를 정확히 유지하도록 함
            if (pauseTimeRef.current !== null) {
              const pausedPosition = pauseTimeRef.current;
              
              // 재생 재개 시도 중이면 정지된 위치를 확인하여 정확히 그 위치에서 재생되도록 함
              if (isResumingRef.current) {
                try {
                  const currentPosition = youtubePlayerRef.current.getCurrentTime();
                  const positionDiff = Math.abs(currentPosition - pausedPosition);
                  
                  // 위치가 1초 이상 차이나면 다시 seekTo 시도
                  if (positionDiff > 1.0) {
                    console.log('[onStateChange] 재생 시작 시 위치 불일치 감지, 다시 seekTo:', {
                      저장된위치: pausedPosition,
                      현재위치: currentPosition,
                      차이: positionDiff
                    });
                    youtubePlayerRef.current.seekTo(pausedPosition, true);
                    // seekTo 후 pauseTimeRef는 유지 (재생 위치 동기화 완료 후 초기화)
                    return; // 위치 조정 중이므로 나머지 로직은 건너뜀
                  } else {
                    console.log('[onStateChange] 재생 시작 - 정지된 위치에서 정확히 재생됨:', {
                      저장된위치: pausedPosition,
                      현재위치: currentPosition,
                      차이: positionDiff
                    });
                  }
                } catch (e) {
                  console.log('[onStateChange] 재생 위치 확인 오류:', e);
                }
              }
              
              // 재생 재개 시도 중이 아니거나 위치가 정확하면 pauseTimeRef 초기화
              // YouTube controls로 재생 버튼을 눌렀을 때 pauseTimeRef를 초기화하여 재생 가능하게 함
              pauseTimeRef.current = null;
              console.log('[onStateChange] 재생 시작 - 일시정지 위치 초기화:', pausedPosition, '초');
            }
            
            // 재생이 시작되면 재생 재개 시도 플래그 해제
            if (isResumingRef.current) {
              isResumingRef.current = false;
              resumeStartTimeRef.current = null;
              console.log('[onStateChange] 재생 시작 - 재생 재개 시도 플래그 해제');
            }
              
              // YouTube 컨트롤로 재생한 경우 처리 (pauseTimeRef 초기화 후)
              // '내 장치로 듣기' 모드: 로컬만 처리, 서버 전송 없음
              if (localPlayMode && !hasControl) {
                setLocalIsPlaying(true);
                lastPlayAttemptRef.current = Date.now(); // 재생 시도 시간 업데이트 (재생 상태 동기화 useEffect가 정지하지 않도록)
                console.log('[onStateChange] YouTube 컨트롤로 재생 - 내 장치로 듣기 모드 (로컬만 처리)');
              }
              // '서버 장치로 듣기' 모드: 서버에 재생 요청 전송
              else if (!localPlayMode && hasControl && !isPlaying && window.socket && music) {
                // 재생 시도 시간 업데이트 (재생 상태 동기화 useEffect가 정지하지 않도록)
                lastPlayAttemptRef.current = Date.now();
                
                // 재생 위치를 서버에 전송
                try {
                  const currentTime = youtubePlayerRef.current.getCurrentTime();
                  if (currentTime > 0) {
                    window.socket.emit('updatePlaybackPosition', {
                      position: currentTime,
                      videoId: music.videoId
                    });
                    console.log('[onStateChange] YouTube 컨트롤로 재생 - 재생 위치 서버 전송:', currentTime, '초');
                  }
                } catch (e) {
                  console.log('[onStateChange] 재생 위치 가져오기 오류:', e);
                }
                
                // 서버에 재생 요청 전송
                setTimeout(() => {
                  if (window.socket && hasControl && !localPlayMode) {
                    window.socket.emit('resumeMusic');
                    console.log('[onStateChange] YouTube 컨트롤로 재생 - 서버에 재생 요청 전송');
                  }
                }, 100);
              }
            }
            // 일시정지 시 현재 재생 위치 저장 (백업 - handlePause에서 저장하지 못한 경우 대비)
            if (event.data === window.YT.PlayerState.PAUSED) {
              if (youtubePlayerRef.current) {
                try {
                  const currentTime = youtubePlayerRef.current.getCurrentTime();
                  
                  // 재생 재개 시도 중이거나 최근 재생 시도가 있었으면 (handleResume에서 재생을 시도한 경우) pauseTimeRef를 설정하지 않음
                  const now = Date.now();
                  const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                  const timeSinceResumeStart = resumeStartTimeRef.current ? now - resumeStartTimeRef.current : Infinity;
                  
                  // 위치가 저장되지 않았거나 0보다 크면 저장
                  // 서버가 재생 중인데 일시정지된 경우에만 저장 (사용자가 의도적으로 일시정지한 경우)
                  // 서버가 일시정지 상태인데 플레이어가 일시정지된 경우도 저장 (서버 일시정지 상태 반영)
                  // 단, 재생 재개 시도 중이거나 최근 5초 이내에 재생 시도가 있었으면 pauseTimeRef를 설정하지 않음 (handleResume에서 재생을 시도한 경우)
                  if (currentTime > 0 && (pauseTimeRef.current === null || pauseTimeRef.current === 0)) {
                    // 재생 재개 시도 중이거나 최근 재생 시도가 있었으면 pauseTimeRef를 설정하지 않음 (handleResume에서 재생을 시도한 경우)
                    // 재생 재개 시도 시작 후 5초 이내에는 pauseTimeRef를 설정하지 않음
                    if (isResumingRef.current || timeSinceResumeStart < 5000 || timeSinceLastAttempt < 2000) {
                      console.log('[onStateChange] 재생 재개 시도 중 또는 최근 재생 시도 감지 (handleResume) - pauseTimeRef 설정하지 않음:', {
                        isResuming: isResumingRef.current,
                        timeSinceResumeStart: (timeSinceResumeStart / 1000).toFixed(2) + '초',
                        timeSinceLastAttempt: (timeSinceLastAttempt / 1000).toFixed(2) + '초',
                        currentTime
                      });
                      // pauseTimeRef는 설정하지 않음 (재생 상태 동기화 useEffect가 정지하지 않도록)
                      // lastPlayAttemptRef는 리셋하지 않음 (재생 재개 시도 중이므로)
                      return; // pauseTimeRef 설정하지 않고 종료
                    }
                    
                    // '내 장치로 듣기' 모드: 로컬만 처리, 서버 전송 없음
                    if (localPlayMode && !hasControl) {
                      pauseTimeRef.current = currentTime;
                      setLocalIsPlaying(false);
                      lastPlayAttemptRef.current = null; // 일시정지 시 재생 시도 시간 리셋
                      console.log('[onStateChange] 일시정지 상태 감지 - 내 장치로 듣기 모드 (로컬만 처리):', currentTime, '초');
                    }
                    // '서버 장치로 듣기' 모드: 서버에 정지 요청 전송
                    else if (!localPlayMode && isPlaying && hasControl) {
                      // 서버가 재생 중인데 플레이어가 일시정지된 경우 (YouTube 컨트롤로 일시정지한 경우 포함)
                      pauseTimeRef.current = currentTime;
                      lastPlayAttemptRef.current = null; // 일시정지 시 재생 시도 시간 리셋
                      console.log('[onStateChange] 일시정지 상태 감지 - 위치 저장 (YouTube 컨트롤):', currentTime, '초, 서버는 재생 중');
                      // YouTube 컨트롤로 정지한 경우 서버에 정지 요청 전송
                      if (window.socket && hasControl) {
                        // 재생 위치를 서버에 전송하여 정지 시점 저장
                        window.socket.emit('updatePlaybackPosition', {
                          position: currentTime,
                          videoId: music?.videoId
                        });
                        // 서버에 정지 요청 전송
                        window.socket.emit('pauseMusic');
                        console.log('[onStateChange] YouTube 컨트롤로 정지 - 서버에 정지 요청 전송');
                      }
                    } else if (!isPlaying) {
                      // 서버가 일시정지 상태인데 플레이어가 일시정지된 경우 (서버 일시정지 상태 반영, 로컬 재생 모드여도 정지)
                      pauseTimeRef.current = currentTime;
                      lastPlayAttemptRef.current = null; // 일시정지 시 재생 시도 시간 리셋
                      console.log('[onStateChange] 일시정지 상태 감지 - 위치 저장 (서버 일시정지 상태 반영, 로컬 재생 모드여도 정지):', currentTime, '초');
                    }
                  } else if (currentTime > 0 && pauseTimeRef.current === null && !isPlaying) {
                    // pauseTimeRef가 null이고 서버가 일시정지 상태이면 설정 (로컬 재생 모드여도 정지)
                    // 단, 재생 재개 시도 중이거나 최근 재생 시도가 있었으면 설정하지 않음
                    const timeSinceResumeStart = resumeStartTimeRef.current ? now - resumeStartTimeRef.current : Infinity;
                    if (!isResumingRef.current && timeSinceResumeStart >= 5000 && timeSinceLastAttempt >= 2000) {
                      pauseTimeRef.current = currentTime;
                      lastPlayAttemptRef.current = null; // 일시정지 시 재생 시도 시간 리셋
                      console.log('[onStateChange] 일시정지 상태 감지 - 위치 저장 (서버 일시정지 상태 반영, 재시도, 로컬 재생 모드여도 정지):', currentTime, '초');
                    }
                  } else if (pauseTimeRef.current === null && !isPlaying) {
                    // 재생 위치를 가져올 수 없어도 서버가 일시정지 상태이면 pauseTimeRef를 설정하여 자동 재생을 막음 (로컬 재생 모드여도 정지)
                    // 단, 재생 재개 시도 중이거나 최근 재생 시도가 있었으면 설정하지 않음
                    const timeSinceResumeStart = resumeStartTimeRef.current ? now - resumeStartTimeRef.current : Infinity;
                    if (!isResumingRef.current && timeSinceResumeStart >= 5000 && timeSinceLastAttempt >= 2000) {
                      pauseTimeRef.current = 0;
                      lastPlayAttemptRef.current = null; // 일시정지 시 재생 시도 시간 리셋
                      console.log('[onStateChange] 일시정지 상태 감지 - 일시정지 위치를 가져올 수 없어 0으로 설정 (서버 일시정지 상태 반영, 로컬 재생 모드여도 정지)');
                    }
                  }
                } catch (e) {
                  // 재생 위치를 가져올 수 없어도 서버가 일시정지 상태이면 pauseTimeRef를 설정하여 자동 재생을 막음 (로컬 재생 모드여도 정지)
                  // 단, 재생 재개 시도 중이거나 최근 재생 시도가 있었으면 설정하지 않음
                  const now = Date.now();
                  const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                  const timeSinceResumeStart = resumeStartTimeRef.current ? now - resumeStartTimeRef.current : Infinity;
                  if (pauseTimeRef.current === null && !isPlaying && !isResumingRef.current && timeSinceResumeStart >= 5000 && timeSinceLastAttempt >= 2000) {
                    pauseTimeRef.current = 0;
                    lastPlayAttemptRef.current = null; // 일시정지 시 재생 시도 시간 리셋
                    console.log('[onStateChange] 일시정지 상태 감지 - 재생 위치 가져오기 오류, 0으로 설정 (서버 일시정지 상태 반영, 로컬 재생 모드여도 정지):', e);
                  } else {
                    console.log('재생 위치 가져오기 오류:', e);
                  }
                }
              } else {
                // 플레이어가 없어도 재생 재개 시도 중이 아니고 최근 재생 시도가 없으면 리셋
                if (!isResumingRef.current) {
                  const now = Date.now();
                  const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                  if (timeSinceLastAttempt >= 2000) {
                    lastPlayAttemptRef.current = null; // 일시정지 시 재생 시도 시간 리셋
                  }
                }
              }
              // 일시정지 위치가 저장되어 있으면 사용자가 의도적으로 일시정지한 것이므로 자동 재생하지 않음
              // pauseTimeRef가 설정되어 있으면 자동 재생하지 않음 (YouTube 컨트롤로 정지한 경우도 포함)
              // '서버 장치로 듣기' 모드에서만 자동 재생 (로컬 재생 모드에서는 자동 재생하지 않음)
              // 단, 최근 재생 시도가 없을 때만 재생
              if (isPlaying && hasControl && !localPlayMode && youtubePlayerRef.current && pauseTimeRef.current === null) {
                const now = Date.now();
                const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                if (timeSinceLastAttempt > 500) {
                console.log('[onStateChange] 서버는 재생 중인데 플레이어는 일시정지 - 자동 재생 시도 (서버 장치로 듣기 모드)');
                try {
                    lastPlayAttemptRef.current = now;
                  youtubePlayerRef.current.playVideo();
                } catch (e) {
                  console.log('[onStateChange] 자동 재생 오류:', e);
                    lastPlayAttemptRef.current = null; // 오류 발생 시 리셋
                  }
                }
              }
            }
            // 버퍼링 중이거나 준비 중일 때도 서버 제어 유지
            // CUED 상태는 비디오가 로드되어 재생 준비가 된 상태
            // 제어권이 있거나 로컬 재생 모드이면 재생 시도
            // 단, 서버가 일시정지 상태이거나 일시정지 위치가 저장되어 있으면 재생하지 않음
            // 단, BUFFERING 상태가 아닐 때만 재생 (BUFFERING 중에는 재생 시도하지 않음)
            if (event.data === window.YT.PlayerState.CUED && (hasControl || localPlayMode) && pauseTimeRef.current === null && (isPlaying || localPlayMode)) {
              console.log('[onStateChange] CUED 상태 감지 - 재생 시도');
              // CUED 상태에서 재생 시도 (모바일에서 지연될 수 있으므로)
              // 단, 최근 재생 시도가 없을 때만 재생
              if (youtubePlayerRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
                const now = Date.now();
                const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                if (timeSinceLastAttempt > 1000) { // 500ms에서 1000ms로 증가 (재생 시도 빈도 감소)
                try {
                    lastPlayAttemptRef.current = now;
                  youtubePlayerRef.current.playVideo();
                  console.log('[onStateChange] CUED 상태에서 재생 시도 완료');
                  
                  // 재생이 시작되었는지 확인 (더 긴 간격으로 제한된 횟수만 시도)
                  let retryCount = 0;
                  const maxRetries = 3; // 5에서 3으로 감소
                  const checkAndRetry = () => {
                    setTimeout(() => {
                        if (youtubePlayerRef.current && (hasControl || localPlayMode) && pauseTimeRef.current === null && (isPlaying || localPlayMode)) {
                        const state = youtubePlayerRef.current.getPlayerState();
                          // PLAYING이거나 BUFFERING이면 재시도 중단 (BUFFERING은 정상 상태)
                          if (state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.BUFFERING) {
                            console.log('[onStateChange] 재생 시작됨 또는 버퍼링 중:', state === window.YT.PlayerState.PLAYING ? 'PLAYING' : 'BUFFERING');
                            return; // 재시도 중단
                          }
                          
                          const attemptNow = Date.now();
                          const timeSinceLastAttempt = lastPlayAttemptRef.current ? attemptNow - lastPlayAttemptRef.current : Infinity;
                          if (state !== window.YT.PlayerState.PLAYING && state !== window.YT.PlayerState.BUFFERING && retryCount < maxRetries && timeSinceLastAttempt > 1000) {
                          // 재생이 시작되지 않았고 BUFFERING도 아니면 다시 시도
                          console.log(`[onStateChange] CUED 상태에서 재생이 시작되지 않음, 재시도 ${retryCount + 1}/${maxRetries}, 현재 상태:`, state);
                          if (typeof youtubePlayerRef.current.playVideo === 'function') {
                              lastPlayAttemptRef.current = attemptNow;
                            youtubePlayerRef.current.playVideo();
                          }
                          retryCount++;
                          checkAndRetry();
                        }
                      }
                    }, 1000); // 300ms에서 1000ms로 증가 (재시도 간격 증가)
                  };
                  checkAndRetry();
                } catch (e) {
                  console.log('[onStateChange] CUED 상태에서 재생 시도 오류:', e);
                  }
                }
              }
            }
            // UNSTARTED 상태도 재생 시도 (loadVideoById 직후 발생할 수 있음)
            // 단, 서버가 일시정지 상태이거나 일시정지 위치가 저장되어 있으면 재생하지 않음
            // 단, 최근 재생 시도가 없을 때만 재생
            // 단, BUFFERING 상태가 아닐 때만 재생 (BUFFERING 중에는 재생 시도하지 않음)
            if (event.data === window.YT.PlayerState.UNSTARTED && (hasControl || localPlayMode) && pauseTimeRef.current === null && (isPlaying || localPlayMode)) {
              const now = Date.now();
              const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
              if (timeSinceLastAttempt > 1000) { // 500ms에서 1000ms로 증가 (재생 시도 빈도 감소)
              console.log('[onStateChange] UNSTARTED 상태 감지 - 재생 시도');
              if (youtubePlayerRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
                try {
                    lastPlayAttemptRef.current = now;
                  youtubePlayerRef.current.playVideo();
                  console.log('[onStateChange] UNSTARTED 상태에서 재생 시도 완료');
                  
                  // UNSTARTED 상태에서도 재생 확인 및 재시도 (단, BUFFERING이면 중단)
                  setTimeout(() => {
                      if (youtubePlayerRef.current && (hasControl || localPlayMode) && pauseTimeRef.current === null && (isPlaying || localPlayMode)) {
                      const state = youtubePlayerRef.current.getPlayerState();
                        // BUFFERING이면 재시도 중단 (정상 상태)
                        if (state === window.YT.PlayerState.BUFFERING) {
                          console.log('[onStateChange] BUFFERING 상태 감지 - 재시도 중단');
                          return;
                        }
                        const attemptNow = Date.now();
                        const timeSinceLastAttempt = lastPlayAttemptRef.current ? attemptNow - lastPlayAttemptRef.current : Infinity;
                        if (state === window.YT.PlayerState.UNSTARTED && typeof youtubePlayerRef.current.playVideo === 'function' && timeSinceLastAttempt > 1000) {
                        console.log('[onStateChange] UNSTARTED 상태 유지 - 재시도');
                          lastPlayAttemptRef.current = attemptNow;
                        youtubePlayerRef.current.playVideo();
                      }
                    }
                  }, 1000); // 500ms에서 1000ms로 증가
                } catch (e) {
                  console.log('[onStateChange] UNSTARTED 상태에서 재생 시도 오류:', e);
                  }
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
            // 152, 153은 영상이 아니라 브라우저 설정(Referrer 차단 등) 문제일 수 있으므로 제외
            // (포함하면 한 클라이언트 때문에 모든 곡이 건너뛰어지고 차단 목록에 저장될 수 있음)
            const unplayableErrorCodes = [100, 101, 150]; // 확실히 재생 불가능한 오류만
            const retryableErrorCodes = [2, 5]; // 재시도 가능한 오류

            if (unplayableErrorCodes.includes(event.data)) {
              // 제어권 여부와 관계없이 서버에 보고 (서버가 현재 곡인지 확인 후 한 번만 다음 곡으로 이동)
              console.log('[onError] 재생 불가능한 동영상 감지 (에러 코드:', event.data, ') - 서버에 보고');
              // 플레이어는 곡이 바뀌어도 재사용되므로(생성 시점의 music이 고정됨) 플레이어에 실제로 로드된 영상 ID를 보고
              let failedVideoId = null;
              try {
                failedVideoId = event.target?.getVideoData?.()?.video_id || null;
              } catch (e) {
                // 무시
              }
              failedVideoId = failedVideoId || musicRef.current?.videoId;
              // 이 영상은 서버가 대체/건너뛰기를 처리하므로, 재생 실패 감지 타이머가 musicEnded를 따로 보내지 않게 막음
              endedSentRef.current = true;
              if (window.socket && failedVideoId) {
                window.socket.emit('musicUnplayable', { videoId: failedVideoId, code: event.data });
              }
              return;
            }

            if (window.socket && hasControlRef.current && !localPlayModeRef.current) {
              if (retryableErrorCodes.includes(event.data)) {
                // 재시도 가능한 오류는 재생 시도
                console.log('[onError] 일시적 오류 감지 (에러 코드:', event.data, ') - 재생 재시도');
                setTimeout(() => {
                  if (youtubePlayerRef.current && isPlayingRef.current && typeof youtubePlayerRef.current.playVideo === 'function') {
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
      // 제어권 변경만으로는 플레이어를 제거하지 않음 (플레이어 컨테이너는 항상 렌더링됨)
      // music이 변경되거나 컴포넌트가 언마운트될 때만 플레이어 제거
      
      // 이전 cleanup timeout이 있으면 정리
      if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
        cleanupTimeoutRef.current = null;
      }
      
      // 제어권 변경만으로는 플레이어를 제거하지 않음
      // music이 null이 되거나 videoId가 변경될 때만 플레이어 제거
      // 이는 별도의 useEffect에서 처리되므로 여기서는 제거하지 않음
      // 단, 컴포넌트가 언마운트될 때는 플레이어를 제거해야 함
      // 하지만 현재 의존성 배열에 hasControl이 포함되어 있어서 제어권 변경 시에도 실행됨
      // 따라서 제어권 변경 시에는 플레이어를 제거하지 않도록 함
      console.log('[cleanup] useEffect cleanup 실행 (제어권 변경 시 플레이어 유지)');
    };
  }, [apiReady, music, hasControl, isPlaying, localPlayMode, localIsPlaying]); // music 객체 전체를 의존성에 추가하여 music 변경 시 플레이어 재생성

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
          // 플레이어가 실제로 DOM에 존재하는지 확인
          const playerElement = playerRef.current;
          if (playerElement && playerElement.parentNode) {
            youtubePlayerRef.current.destroy();
            console.log('[music null 감지] 플레이어 제거 완료');
          } else {
            // 이미 DOM에서 제거된 경우 ref만 정리
            console.log('[music null 감지] 플레이어가 이미 DOM에서 제거됨');
          }
        } catch (e) {
          console.log('[music null 감지] 플레이어 제거 오류 (무시):', e);
        }
        youtubePlayerRef.current = null;
      }
      setPlayerReady(false);
      endedSentRef.current = false;
      pauseTimeRef.current = null;
      manualNextRef.current = false; // 수동 다음 곡 전환 플래그 리셋
    }
  }, [music]);

  // music이 변경될 때 endedSentRef 리셋 및 좋아요 상태 확인 (새 음악 재생 시)
  useEffect(() => {
    if (music && music.videoId) {
      const isNewMusic = previousVideoIdRef.current !== music.videoId;
      previousVideoIdRef.current = music.videoId;
      if (isNewMusic) {
        endedSentRef.current = false;
        manualNextRef.current = false; // 수동 다음 곡 전환 플래그 리셋
        lastPlayAttemptRef.current = null; // 새 음악 시작 시 재생 시도 시간 리셋
        // 새 음악 시작 시 동기화 시간 리셋 (즉시 동기화 가능하도록)
        lastSyncTimeForControlRef.current = 0;
        lastSentPositionRef.current = null;
        lastSentTimeRef.current = 0;
        setIsLiked(false); // 새 음악 재생 시 좋아요 상태 초기화
        setLikeCount(0); // 좋아요 개수 초기화
        
        // 서버에 좋아요 개수 조회
        if (window.socket) {
          window.socket.emit('getLikeCount', music.videoId);
          window.socket.emit('checkLiked', music.videoId);
        }
        
        // localStorage에서 좋아요 개수 확인
        try {
          const stored = localStorage.getItem('musicLikes');
          if (stored) {
            const likesData = JSON.parse(stored);
            if (likesData.likesByVideoId && likesData.likesByVideoId[music.videoId]) {
              setLikeCount(likesData.likesByVideoId[music.videoId].count || 0);
            }
          }
        } catch (e) {
          console.error('localStorage 읽기 오류:', e);
        }
        
        console.log('새 음악 감지 - endedSentRef 리셋:', music.videoId);
      }
    }
  }, [music?.videoId]);
  
  // 좋아요 업데이트 이벤트 수신
  useEffect(() => {
    if (!window.socket) return;
    
    const handleLikeUpdated = (data) => {
      if (music && music.videoId === data.videoId) {
        setLikeCount(data.count);
      }
    };
    
    const handleLikeCount = (data) => {
      if (music && music.videoId === data.videoId) {
        setLikeCount(data.count);
      }
    };
    
    const handleLikedStatus = (data) => {
      if (music && music.videoId === data.videoId) {
        setIsLiked(data.isLiked);
        if (data.count !== undefined) {
          setLikeCount(data.count);
        }
      }
    };
    
    window.socket.on('likeUpdated', handleLikeUpdated);
    window.socket.on('likeCount', handleLikeCount);
    window.socket.on('likedStatus', handleLikedStatus);
    
    return () => {
      window.socket.off('likeUpdated', handleLikeUpdated);
      window.socket.off('likeCount', handleLikeCount);
      window.socket.off('likedStatus', handleLikedStatus);
    };
  }, [music?.videoId]);
  
  // 하트 클릭 핸들러
  const handleLikeClick = () => {
    if (!music || !music.videoId || !window.socket) return;
    
    if (isLiked) {
      // 좋아요 취소
      window.socket.emit('unlikeMusic', {
        videoId: music.videoId,
        title: music.title,
        socketId: window.socket.id
      });
      setIsLiked(false);
    } else {
      // 좋아요 추가
      window.socket.emit('likeMusic', {
        videoId: music.videoId,
        title: music.title,
        socketId: window.socket.id
      });
      setIsLiked(true);
    }
  };

  // 일시정지 버튼 핸들러 (하단 버튼 숨김 처리로 사용되지 않지만, 예방적 수정)
  const handlePause = () => {
    if (!isPlaying) return; // 이미 일시정지 상태면 무시
    
    // 재생 재개 시도 플래그 해제 (정지 버튼을 누르면 재생 재개 시도 취소)
    isResumingRef.current = false;
    resumeStartTimeRef.current = null;
    
    if (youtubePlayerRef.current && hasControl) {
      try {
        // 현재 재생 위치 저장 (일시정지 전에 위치 저장)
        // pauseTimeRef를 확실히 설정하여 자동 재생을 막음
        const currentTime = youtubePlayerRef.current.getCurrentTime();
        if (currentTime > 0) {
          pauseTimeRef.current = currentTime;
          console.log('일시정지 버튼 클릭 - 현재 위치 저장:', currentTime, '초');
          // '서버 장치로 듣기' 모드에서만 서버에 재생 위치 전송
          if (!localPlayMode && window.socket && music) {
            window.socket.emit('updatePlaybackPosition', {
              position: currentTime,
              videoId: music.videoId
            });
            console.log('[handlePause] 정지 시점 재생 위치 서버 전송:', currentTime, '초');
          }
          // '내 장치로 듣기' 모드: 로컬 상태만 업데이트
          if (localPlayMode && !hasControl) {
            setLocalIsPlaying(false);
            console.log('[handlePause] 내 장치로 듣기 모드 - 로컬 상태만 업데이트');
          }
        } else {
          // 재생 위치를 가져올 수 없어도 pauseTimeRef를 설정하여 자동 재생을 막음
          pauseTimeRef.current = 0;
          console.log('일시정지 버튼 클릭 - 재생 위치를 가져올 수 없어 0으로 설정');
        }
        // 재생 시도 시간을 null로 설정하여 재생 시도 방지
        lastPlayAttemptRef.current = null;
        // 즉시 플레이어 일시정지
        if (typeof youtubePlayerRef.current.pauseVideo === 'function') {
          youtubePlayerRef.current.pauseVideo();
          console.log('플레이어 일시정지 실행');
        }
      } catch (e) {
        // 오류가 발생해도 pauseTimeRef를 설정하여 자동 재생을 막음
        if (pauseTimeRef.current === null) {
          pauseTimeRef.current = 0;
          console.log('일시정지 오류 - pauseTimeRef를 0으로 설정:', e);
        } else {
        console.log('일시정지 오류:', e);
      }
        lastPlayAttemptRef.current = null;
      }
    } else {
      // 플레이어가 없거나 제어권이 없어도 pauseTimeRef를 설정하여 자동 재생을 막음
      if (pauseTimeRef.current === null) {
        pauseTimeRef.current = 0;
        console.log('일시정지 버튼 클릭 - 플레이어가 없거나 제어권이 없어 pauseTimeRef를 0으로 설정');
      }
      lastPlayAttemptRef.current = null;
    }
    // '서버 장치로 듣기' 모드에서만 서버에 일시정지 요청
    if (!localPlayMode) {
      onPause();
    }
  };

  // 볼륨 조절 핸들러
  const handleVolumeChange = (e) => {
    const newVolume = parseInt(e.target.value, 10);
    setVolume(newVolume);
    // localStorage에 저장
    localStorage.setItem('musicVolume', newVolume.toString());
    
    // YouTube 플레이어에 볼륨 적용
    if (youtubePlayerRef.current && typeof youtubePlayerRef.current.setVolume === 'function') {
      try {
        youtubePlayerRef.current.setVolume(newVolume);
        console.log('[볼륨 조절] 볼륨 설정:', newVolume);
      } catch (e) {
        console.log('[볼륨 조절] 볼륨 설정 오류:', e);
      }
    }
  };

  // 플레이어가 준비되었을 때 볼륨 적용 (볼륨 상태 변경 시)
  useEffect(() => {
    if (youtubePlayerRef.current && playerReady && typeof youtubePlayerRef.current.setVolume === 'function') {
      try {
        youtubePlayerRef.current.setVolume(volume);
        console.log('[useEffect] 볼륨 적용:', volume);
      } catch (e) {
        console.log('[useEffect] 볼륨 적용 오류:', e);
      }
    }
  }, [volume, playerReady]);

  // 외부 클릭 시 볼륨 슬라이더 닫기
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showVolumeSlider && !event.target.closest('.volume-control-compact')) {
        setShowVolumeSlider(false);
      }
    };

    if (showVolumeSlider) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showVolumeSlider]);

  // 다시시작 버튼 핸들러 (하단 버튼 숨김 처리로 사용되지 않지만, 예방적 수정)
  const handleResume = () => {
    console.log('[handleResume] 다시시작 버튼 클릭:', {
      isPlaying,
      hasPlayer: !!youtubePlayerRef.current,
      hasControl,
      localPlayMode,
      pauseTime: pauseTimeRef.current,
      playerReady
    });
    
    if (isPlaying) {
      console.log('[handleResume] 이미 재생 중이므로 무시');
      return; // 이미 재생 중이면 무시
    }
    
    // 플레이어가 없거나 제어권이 없으면 서버에만 재생 요청 ('서버 장치로 듣기' 모드에서만)
    if (!youtubePlayerRef.current || !hasControl) {
      console.log('[handleResume] 플레이어 또는 제어권 없음 - 서버에만 재생 요청');
      if (!localPlayMode) {
        onResume();
      }
      return;
    }
    
    // 플레이어가 준비되지 않았으면 서버에만 재생 요청 ('서버 장치로 듣기' 모드에서만)
    if (!playerReady) {
      console.log('[handleResume] 플레이어가 준비되지 않음 - 서버에만 재생 요청');
      if (!localPlayMode) {
        onResume();
      }
      return;
    }
    
    // 일시정지 위치를 먼저 저장 (재생 상태 동기화 useEffect가 재생을 막지 않도록)
    const savedPauseTime = pauseTimeRef.current;
    console.log('[handleResume] 저장된 정지 위치 확인:', {
      savedPauseTime,
      pauseTimeRef: pauseTimeRef.current,
      플레이어현재위치: youtubePlayerRef.current ? youtubePlayerRef.current.getCurrentTime() : null
    });
    
    // pauseTimeRef를 null로 초기화 (재생 상태 동기화 useEffect가 재생을 막지 않도록)
    pauseTimeRef.current = null;
    
    // 재생 재개 시도 플래그 설정 (onStateChange와 재생 상태 동기화 useEffect가 pauseTimeRef를 설정하지 않도록)
    const resumeStartTime = Date.now();
    isResumingRef.current = true;
    resumeStartTimeRef.current = resumeStartTime;
    
    // 재생 시도 시간을 먼저 설정하여 재생 상태 동기화 useEffect가 재생을 막지 않도록 함
    lastPlayAttemptRef.current = resumeStartTime;
    
    // 재생 재개 시 재생 위치를 서버에 전송 (재생 시간 동기화를 위해)
    // 정지된 위치(savedPauseTime)를 우선적으로 사용
    const getCurrentPosition = () => {
      try {
        if (savedPauseTime !== null && savedPauseTime > 0) {
          console.log('[handleResume] 정지된 위치 사용:', savedPauseTime, '초');
          return savedPauseTime;
        } else if (youtubePlayerRef.current) {
          const currentTime = youtubePlayerRef.current.getCurrentTime();
          console.log('[handleResume] 플레이어 현재 위치 사용:', currentTime, '초');
          return currentTime;
        }
      } catch (e) {
        console.log('[handleResume] 재생 위치 가져오기 오류:', e);
      }
      console.log('[handleResume] 재생 위치를 가져올 수 없어 0 사용');
      return 0;
    };
    
    const resumePosition = getCurrentPosition();
    console.log('[handleResume] 최종 재생 재개 위치:', {
      resumePosition,
      savedPauseTime,
      사용된위치: savedPauseTime !== null && savedPauseTime > 0 ? '정지된위치' : '플레이어현재위치'
    });
    
    // '서버 장치로 듣기' 모드에서만 서버에 재생 위치 전송 및 재생 재개 요청
    if (!localPlayMode && window.socket && music && resumePosition > 0) {
      // 먼저 재생 위치를 서버에 전송 (서버에서 playStartTime 계산을 위해)
      window.socket.emit('updatePlaybackPosition', {
        position: resumePosition,
        videoId: music.videoId
      });
      console.log('[handleResume] 재생 재개 시점 재생 위치 서버 전송:', resumePosition, '초');
      
      // 재생 위치가 서버에서 처리될 시간을 주기 위해 약간의 지연 후 재생 재개 요청
      // 서버에서 updatePlaybackPosition을 처리하고 currentPlaybackPosition을 업데이트한 후
      // resumeMusic에서 playStartTime을 계산할 수 있도록 충분한 지연 필요
      setTimeout(() => {
        if (!localPlayMode && window.socket) {
          console.log('[handleResume] 재생 재개 요청 전송 (서버에서 playStartTime 재설정, 전송된 위치:', resumePosition, '초)');
          onResume();
        }
      }, 200); // 200ms 지연으로 서버에서 updatePlaybackPosition 처리 시간 확보
    } else if (!localPlayMode) {
      // 재생 위치가 0이거나 없어도 재생 재개 요청
      onResume();
      console.log('[handleResume] 재생 재개 요청 전송 (재생 위치 없음)');
    }
    
    // '내 장치로 듣기' 모드: 로컬 상태만 업데이트
    if (localPlayMode && !hasControl) {
      setLocalIsPlaying(true);
      console.log('[handleResume] 내 장치로 듣기 모드 - 로컬 상태만 업데이트');
    }
    
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
              // seekTo 후 현재 위치 확인 (정확히 정지된 위치인지 확인)
              const currentPosition = youtubePlayerRef.current.getCurrentTime();
              const positionDiff = Math.abs(currentPosition - savedPauseTime);
              
              // 위치가 0.5초 이상 차이나면 다시 seekTo 시도
              if (positionDiff > 0.5) {
                console.log('[handleResume] 위치 불일치 감지, 다시 seekTo:', {
                  저장된위치: savedPauseTime,
                  현재위치: currentPosition,
                  차이: positionDiff
                });
                youtubePlayerRef.current.seekTo(savedPauseTime, true);
                // 다시 seekTo 후 약간의 지연
                setTimeout(() => {
                  const currentState = youtubePlayerRef.current.getPlayerState();
                  if (currentState !== window.YT.PlayerState.PLAYING) {
                    lastPlayAttemptRef.current = Date.now();
                    youtubePlayerRef.current.playVideo();
                    console.log('[handleResume] 재생 시도 완료 (위치 재조정 후)');
                  }
                }, 100);
              } else {
                const currentState = youtubePlayerRef.current.getPlayerState();
                if (currentState !== window.YT.PlayerState.PLAYING) {
                  // 재생 시도 시간 업데이트
                  lastPlayAttemptRef.current = Date.now();
                  youtubePlayerRef.current.playVideo();
                  console.log('[handleResume] 재생 시도 완료');
                }
              }
              
              // 재생이 시작되었는지 확인 (약간의 지연 후)
              setTimeout(() => {
                if (youtubePlayerRef.current) {
                  const stateAfterPlay = youtubePlayerRef.current.getPlayerState();
                  // 재생 시작 후에도 정지된 위치를 확인하여 정확히 그 위치에서 재생되도록 함
                  if (stateAfterPlay === window.YT.PlayerState.PLAYING) {
                    const actualPosition = youtubePlayerRef.current.getCurrentTime();
                    const positionDiffAfterPlay = Math.abs(actualPosition - savedPauseTime);
                    
                    // 위치가 1초 이상 차이나면 다시 seekTo 시도
                    if (positionDiffAfterPlay > 1.0) {
                      console.log('[handleResume] 재생 후 위치 불일치 감지, 다시 seekTo:', {
                        저장된위치: savedPauseTime,
                        실제위치: actualPosition,
                        차이: positionDiffAfterPlay
                      });
                      youtubePlayerRef.current.seekTo(savedPauseTime, true);
                    } else {
                      console.log('[handleResume] 재생 성공 확인, 위치 정확:', {
                        저장된위치: savedPauseTime,
                        실제위치: actualPosition,
                        차이: positionDiffAfterPlay
                      });
                    }
                    // 재생 성공 시 플래그 해제
                    isResumingRef.current = false;
                    resumeStartTimeRef.current = null;
                  } else if (stateAfterPlay === window.YT.PlayerState.PAUSED) {
                      // 여전히 일시정지 상태이면 다시 재생 시도
                      const retryNow = Date.now();
                      const timeSinceLastAttempt = lastPlayAttemptRef.current ? retryNow - lastPlayAttemptRef.current : Infinity;
                      if (timeSinceLastAttempt > 500) {
                        console.log('[handleResume] 재생이 시작되지 않음, 재시도');
                        lastPlayAttemptRef.current = retryNow;
                        youtubePlayerRef.current.playVideo();
                        
                        // 재시도 후에도 확인
                        setTimeout(() => {
                          if (youtubePlayerRef.current) {
                            const stateAfterRetry = youtubePlayerRef.current.getPlayerState();
                            if (stateAfterRetry === window.YT.PlayerState.PLAYING) {
                              console.log('[handleResume] 재시도 후 재생 성공');
                              isResumingRef.current = false;
                            } else {
                              // 재시도 실패 시에도 플래그 해제 (최대 5초 후)
                              setTimeout(() => {
                                isResumingRef.current = false;
                                resumeStartTimeRef.current = null;
                                console.log('[handleResume] 재생 재개 시도 플래그 해제 (타임아웃)');
                              }, 5000);
                            }
                          }
                        }, 500);
                      } else {
                        // 재시도 불가 시 플래그 해제 (최대 5초 후)
                        setTimeout(() => {
                          isResumingRef.current = false;
                          resumeStartTimeRef.current = null;
                          console.log('[handleResume] 재생 재개 시도 플래그 해제 (재시도 불가)');
                        }, 5000);
                      }
                    }
                  }
                }, 500);
            } catch (e) {
              console.log('[handleResume] 재생 시도 오류:', e);
              lastPlayAttemptRef.current = null; // 오류 발생 시 리셋
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
          const currentState = youtubePlayerRef.current.getPlayerState();
          if (currentState !== window.YT.PlayerState.PLAYING) {
            // 재생 시도 시간 업데이트
            lastPlayAttemptRef.current = Date.now();
            youtubePlayerRef.current.playVideo();
            console.log('[handleResume] 재생 시도 완료');
            
            // 재생이 시작되었는지 확인 (약간의 지연 후)
            setTimeout(() => {
              if (youtubePlayerRef.current) {
                const stateAfterPlay = youtubePlayerRef.current.getPlayerState();
                if (stateAfterPlay === window.YT.PlayerState.PLAYING) {
                  console.log('[handleResume] 재생 성공 확인');
                  // 재생 성공 시 플래그 해제
                  isResumingRef.current = false;
                  resumeStartTimeRef.current = null;
                } else if (stateAfterPlay === window.YT.PlayerState.PAUSED) {
                  // 여전히 일시정지 상태이면 다시 재생 시도
                  const retryNow = Date.now();
                  const timeSinceLastAttempt = lastPlayAttemptRef.current ? retryNow - lastPlayAttemptRef.current : Infinity;
                  if (timeSinceLastAttempt > 500) {
                    console.log('[handleResume] 재생이 시작되지 않음, 재시도');
                    lastPlayAttemptRef.current = retryNow;
                    youtubePlayerRef.current.playVideo();
                    
                    // 재시도 후에도 확인
                    setTimeout(() => {
                      if (youtubePlayerRef.current) {
                        const stateAfterRetry = youtubePlayerRef.current.getPlayerState();
                        if (stateAfterRetry === window.YT.PlayerState.PLAYING) {
                          console.log('[handleResume] 재시도 후 재생 성공');
                          isResumingRef.current = false;
                        } else {
                          // 재시도 실패 시에도 플래그 해제 (최대 5초 후)
                          setTimeout(() => {
                            isResumingRef.current = false;
                            resumeStartTimeRef.current = null;
                            console.log('[handleResume] 재생 재개 시도 플래그 해제 (타임아웃)');
                          }, 5000);
                        }
                      }
                    }, 500);
                  } else {
                    // 재시도 불가 시 플래그 해제 (최대 5초 후)
                    setTimeout(() => {
                      isResumingRef.current = false;
                      resumeStartTimeRef.current = null;
                      console.log('[handleResume] 재생 재개 시도 플래그 해제 (재시도 불가)');
                    }, 5000);
                  }
                }
              }
            }, 500);
          }
        }
      } catch (e) {
        console.log('[handleResume] 재생 오류:', e);
        lastPlayAttemptRef.current = null; // 오류 발생 시 리셋
      }
    }
    
    // '서버 장치로 듣기' 모드에서만 서버에 재생 요청 (재생 위치 전송 후 약간의 지연을 두어 서버에서 위치를 받을 수 있도록)
    if (!localPlayMode) {
      setTimeout(() => {
        console.log('[handleResume] 서버에 재생 요청 전송');
        onResume();
        // 서버 상태 업데이트 후 플래그 해제 (최대 5초 후 안전장치)
        setTimeout(() => {
          if (isResumingRef.current) {
            isResumingRef.current = false;
            resumeStartTimeRef.current = null;
            console.log('[handleResume] 재생 재개 시도 플래그 해제 (서버 요청 후 타임아웃)');
          }
        }, 5000);
      }, 100); // 100ms 지연으로 재생 위치가 서버에 먼저 전달되도록 함
    } else {
      // 로컬 모드에서도 플래그 해제 (최대 5초 후 안전장치)
      setTimeout(() => {
        if (isResumingRef.current) {
          isResumingRef.current = false;
          resumeStartTimeRef.current = null;
          console.log('[handleResume] 재생 재개 시도 플래그 해제 (로컬 모드 타임아웃)');
        }
      }, 5000);
    }
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
    
    // 플레이어가 준비되지 않았거나 음악이 없으면 종료
    // 제어권이 없어도 서버의 일시정지 상태는 반영해야 함
    // 서버에서 정지할 때는 로컬 재생 모드여도 정지되어야 함
    if (!playerReady || !youtubePlayerRef.current || !music) {
      console.log('[재생 상태 동기화 useEffect] 조건 불만족 - 종료');
      return;
    }
    
    // 로컬 재생 모드이고 제어권이 없고 서버가 재생 중이면 서버 상태와 무관하게 동작
    // 단, 서버가 일시정지 상태(!isPlaying)일 때는 로컬 재생 모드여도 정지되어야 함
    if (localPlayMode && !hasControl && isPlaying) {
      console.log('[재생 상태 동기화 useEffect] 로컬 재생 모드 - 서버 재생 상태 무시 (서버 일시정지 시에는 정지)');
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
            // 기존 플레이어가 있으면 완전히 정리 (새 비디오 로드 전)
            if (youtubePlayerRef.current) {
              try {
                const beforeState = youtubePlayerRef.current.getPlayerState();
                console.log('[재생 상태 동기화] 기존 플레이어 정리 시작, 현재 상태:', beforeState);
                
                // 먼저 일시정지
            try {
              youtubePlayerRef.current.pauseVideo();
                  console.log('[재생 상태 동기화] 플레이어 일시정지 완료');
            } catch (e) {
              console.log('[재생 상태 동기화] 일시정지 오류 (무시):', e);
            }
            
                // stopVideo로 완전히 정리 (재생 중이거나 버퍼링 중일 때)
                try {
                  if (beforeState === window.YT.PlayerState.PLAYING || 
                      beforeState === window.YT.PlayerState.BUFFERING ||
                      beforeState === window.YT.PlayerState.CUED) {
                    youtubePlayerRef.current.stopVideo();
                    console.log('[재생 상태 동기화] 플레이어 stopVideo 완료');
                  }
                  } catch (e) {
                  console.log('[재생 상태 동기화] stopVideo 오류 (무시):', e);
                    }
                  } catch (e) {
                console.log('[재생 상태 동기화] 플레이어 정리 오류 (무시):', e);
                  }
                }
              
            // 플레이어 정리 후 약간의 지연 (플레이어가 완전히 정리될 시간 확보)
            const targetVideoId = music.videoId; // 클로저로 videoId 저장
              setTimeout(() => {
              if (!youtubePlayerRef.current || !music || music.videoId !== targetVideoId) {
                console.log('[재생 상태 동기화] 지연 후 상태 확인 - 플레이어 없음 또는 music 변경됨');
                return;
              }
              
              lastPlayAttemptRef.current = null; // 새 비디오 로드 시 재생 시도 시간 리셋
              try {
                youtubePlayerRef.current.loadVideoById(music.videoId, true); // true = 즉시 재생 시작
                console.log('[재생 상태 동기화] 새 비디오 로드 완료:', music.videoId, 'hasControl:', hasControl);
                // loadVideoById 호출 시 onStateChange에서 자동으로 재생이 시작되므로 여기서는 추가 재생 시도 불필요
                  } catch (e) {
                console.log('[재생 상태 동기화] loadVideoById 오류:', e);
                if (window.socket && hasControl && !endedSentRef.current) {
                  endedSentRef.current = true;
                  window.socket.emit('musicEnded', getEndedPayload());
                  }
                }
            }, 200); // 플레이어 정리 후 200ms 지연
          } catch (e) {
            console.log('[재생 상태 동기화] 새 비디오 로드 오류:', e);
          }
          return; // 비디오 로드 후 재생은 loadVideoById의 onStateChange에서 처리됨
        }
        
        // 서버가 재생 중이라고 하면 재생 (제어권 있는 경우)
        // 또는 로컬 재생 모드이고 localIsPlaying이 true이면 재생
        // 단, 일시정지 위치가 저장되어 있으면 사용자가 의도적으로 일시정지한 것이므로 자동 재생하지 않음
        // 단, 서버가 재생 중이면 pauseTimeRef를 초기화하여 재생 가능하게 함
        // 단, 재생 재개 시도 중이거나 최근 재생 시도가 있었으면 pauseTimeRef를 초기화하여 재생 가능하게 함 (handleResume 또는 YouTube controls로 재생한 경우)
        if ((isPlaying && hasControl) || (localPlayMode && localIsPlaying)) {
          // 재생 재개 시도 중이거나 최근 재생 시도가 있었으면 pauseTimeRef 초기화 (handleResume 또는 YouTube controls로 재생한 경우)
          // 이는 handleResume에서 재생을 시도한 경우를 명시적으로 처리하기 위함
          const now = Date.now();
          const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
          const timeSinceResumeStart = resumeStartTimeRef.current ? now - resumeStartTimeRef.current : Infinity;
          
          // 재생 재개 시도 중이거나 재생 재개 시작 후 5초 이내이거나 최근 재생 시도가 있었으면 pauseTimeRef 초기화
          if (isResumingRef.current || timeSinceResumeStart < 5000 || (timeSinceLastAttempt < 2000 && pauseTimeRef.current !== null)) {
            console.log('[재생 상태 동기화] 재생 재개 시도 중 또는 최근 재생 시도 감지 - pauseTimeRef 초기화 (handleResume 또는 YouTube controls):', {
              isResuming: isResumingRef.current,
              timeSinceResumeStart: (timeSinceResumeStart / 1000).toFixed(2) + '초',
              pauseTimeRef: pauseTimeRef.current,
              timeSinceLastAttempt: (timeSinceLastAttempt / 1000).toFixed(2) + '초'
            });
            pauseTimeRef.current = null;
          }
          
          // 서버가 재생 중이면 pauseTimeRef 초기화 (재생 재개 시)
          if (isPlaying && pauseTimeRef.current !== null) {
            console.log('[재생 상태 동기화] 서버 재생 재개 - pauseTimeRef 초기화:', pauseTimeRef.current);
            pauseTimeRef.current = null;
          }
          
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
            // 단, 최근 재생 시도가 없을 때만 재생
            const now = Date.now();
            const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
            
            if (playerState !== window.YT.PlayerState.PLAYING && timeSinceLastAttempt > 500) {
              console.log('[재생 상태 동기화] 재생 시도, 현재 상태:', playerState);
              try {
                lastPlayAttemptRef.current = now;
                youtubePlayerRef.current.playVideo();
                
                // 재생이 시작되었는지 확인 (약간의 지연 후)
                setTimeout(() => {
                  if (youtubePlayerRef.current && isPlaying && pauseTimeRef.current === null) {
                    const state = youtubePlayerRef.current.getPlayerState();
                    const attemptNow = Date.now();
                    const timeSinceLastAttempt = lastPlayAttemptRef.current ? attemptNow - lastPlayAttemptRef.current : Infinity;
                    if (state !== window.YT.PlayerState.PLAYING && timeSinceLastAttempt > 500) {
                      // 재생이 시작되지 않았으면 다시 시도
                      console.log('[재생 상태 동기화] 재생이 시작되지 않음, 재시도, 현재 상태:', state);
                      if (typeof youtubePlayerRef.current.playVideo === 'function') {
                        lastPlayAttemptRef.current = attemptNow;
                        youtubePlayerRef.current.playVideo();
                      }
                    } else if (state === window.YT.PlayerState.PLAYING) {
                      console.log('[재생 상태 동기화] 재생 성공!');
                    }
                  } else if (pauseTimeRef.current !== null) {
                    console.log('[재생 상태 동기화] 일시정지 위치가 저장되어 있어서 재시도하지 않음:', pauseTimeRef.current);
                  }
                }, 500);
              } catch (e) {
                console.log('[재생 상태 동기화] 재생 시도 오류:', e);
                lastPlayAttemptRef.current = null; // 오류 발생 시 리셋
              }
            }
          }
        } else {
        // 서버가 중지했으면 일시정지 (모든 클라이언트에서 반영, 로컬 재생 모드여도 정지)
        if (!isPlaying) {
          // 서버가 일시정지 상태이면 모든 클라이언트에서 일시정지 (로컬 재생 모드여도 정지)
          // 단, YouTube controls로 최근에 재생 시도가 있었으면 정지하지 않음 (서버 상태 변경 대기)
          const now = Date.now();
          const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
          const playerState = youtubePlayerRef.current.getPlayerState();
          
          // 최근 2초 이내에 재생 시도가 있었고 플레이어가 재생 중이면 정지하지 않음 (서버 상태 변경 대기)
          if (timeSinceLastAttempt < 2000 && playerState === window.YT.PlayerState.PLAYING) {
            console.log('[재생 상태 동기화] YouTube controls로 최근 재생 시도 감지 - 정지하지 않음 (서버 상태 변경 대기)', {
              timeSinceLastAttempt: (timeSinceLastAttempt / 1000).toFixed(2) + '초',
              playerState
            });
            return; // 정지하지 않고 종료
          }
          
          if (typeof youtubePlayerRef.current.pauseVideo === 'function') {
            // 이미 일시정지 상태가 아니면 일시정지
            // 단, YouTube controls로 최근에 재생 시도가 있었으면 정지하지 않음 (서버 상태 변경 대기)
            if (playerState !== window.YT.PlayerState.PAUSED && playerState !== window.YT.PlayerState.ENDED) {
              // 최근 재생 시도가 있었으면 정지하지 않음 (서버 상태 변경 대기)
              if (timeSinceLastAttempt < 2000) {
                console.log('[재생 상태 동기화] YouTube controls로 최근 재생 시도 감지 - 정지하지 않음 (서버 상태 변경 대기)', {
                  timeSinceLastAttempt: (timeSinceLastAttempt / 1000).toFixed(2) + '초',
                  playerState
                });
                return; // 정지하지 않고 종료
              }
              
              youtubePlayerRef.current.pauseVideo();
              // 서버에서 일시정지할 때 pauseTimeRef를 설정하여 자동 재생을 막음
              // 단, 재생 재개 시도 중이거나 최근 재생 시도가 있었으면 pauseTimeRef를 설정하지 않음 (서버 상태 변경 대기)
              const timeSinceResumeStart = resumeStartTimeRef.current ? now - resumeStartTimeRef.current : Infinity;
              if (!isResumingRef.current && timeSinceResumeStart >= 5000 && timeSinceLastAttempt >= 2000) {
                try {
                  const currentTime = youtubePlayerRef.current.getCurrentTime();
                  if (currentTime > 0 && pauseTimeRef.current === null) {
                    pauseTimeRef.current = currentTime;
                    console.log('[재생 상태 동기화] 서버 일시정지 상태 반영 - 일시정지 위치 저장:', currentTime, '초');
                  }
                } catch (e) {
                  // 재생 위치를 가져올 수 없으면 최소한 pauseTimeRef를 설정하여 자동 재생을 막음
                  if (pauseTimeRef.current === null && !isResumingRef.current && timeSinceResumeStart >= 5000 && timeSinceLastAttempt >= 2000) {
                    pauseTimeRef.current = 0; // 0으로 설정하여 자동 재생을 막음
                    console.log('[재생 상태 동기화] 서버 일시정지 상태 반영 - 일시정지 위치를 가져올 수 없어 0으로 설정');
                  }
                }
              }
              console.log('[재생 상태 동기화] 서버 일시정지 상태 반영 - 플레이어 일시정지 실행', {
                hasControl,
                playerState,
                timeSinceLastAttempt: (timeSinceLastAttempt / 1000).toFixed(2) + '초'
              });
            } else if (playerState === window.YT.PlayerState.PAUSED && pauseTimeRef.current === null) {
              // 이미 일시정지 상태인데 pauseTimeRef가 설정되지 않았으면 설정
              // 단, 재생 재개 시도 중이거나 최근 재생 시도가 있었으면 pauseTimeRef를 설정하지 않음 (서버 상태 변경 대기)
              const timeSinceResumeStart = resumeStartTimeRef.current ? now - resumeStartTimeRef.current : Infinity;
              if (!isResumingRef.current && timeSinceResumeStart >= 5000 && timeSinceLastAttempt >= 2000) {
                try {
                  const currentTime = youtubePlayerRef.current.getCurrentTime();
                  if (currentTime > 0) {
                    pauseTimeRef.current = currentTime;
                    console.log('[재생 상태 동기화] 서버 일시정지 상태 반영 - 일시정지 위치 저장 (이미 일시정지 상태):', currentTime, '초');
                  } else {
                    pauseTimeRef.current = 0; // 0으로 설정하여 자동 재생을 막음
                    console.log('[재생 상태 동기화] 서버 일시정지 상태 반영 - 일시정지 위치를 가져올 수 없어 0으로 설정 (이미 일시정지 상태)');
                  }
                } catch (e) {
                  if (pauseTimeRef.current === null && !isResumingRef.current && timeSinceResumeStart >= 5000) {
                    pauseTimeRef.current = 0; // 0으로 설정하여 자동 재생을 막음
                    console.log('[재생 상태 동기화] 서버 일시정지 상태 반영 - 일시정지 위치를 가져올 수 없어 0으로 설정 (이미 일시정지 상태):', e);
                  }
                }
              }
            }
          }
        } else if (localPlayMode && !localIsPlaying && !hasControl) {
          // 로컬 재생 모드이고 로컬 재생이 중지되었으면 일시정지
          if (typeof youtubePlayerRef.current.pauseVideo === 'function') {
            const playerState = youtubePlayerRef.current.getPlayerState();
            if (playerState !== window.YT.PlayerState.PAUSED && playerState !== window.YT.PlayerState.ENDED) {
              youtubePlayerRef.current.pauseVideo();
              // 로컬 재생 중지 시에도 pauseTimeRef를 설정하여 자동 재생을 막음
              try {
                const currentTime = youtubePlayerRef.current.getCurrentTime();
                if (currentTime > 0 && pauseTimeRef.current === null) {
                  pauseTimeRef.current = currentTime;
                  console.log('[재생 상태 동기화] 로컬 재생 중지 - 일시정지 위치 저장:', currentTime, '초');
                }
              } catch (e) {
                if (pauseTimeRef.current === null) {
                  pauseTimeRef.current = 0;
                  console.log('[재생 상태 동기화] 로컬 재생 중지 - 일시정지 위치를 가져올 수 없어 0으로 설정');
                }
              }
              console.log('[재생 상태 동기화] 로컬 재생 중지 - 플레이어 일시정지 실행');
            } else if (playerState === window.YT.PlayerState.PAUSED && pauseTimeRef.current === null) {
              // 이미 일시정지 상태인데 pauseTimeRef가 설정되지 않았으면 설정
              try {
                const currentTime = youtubePlayerRef.current.getCurrentTime();
                if (currentTime > 0) {
                  pauseTimeRef.current = currentTime;
                  console.log('[재생 상태 동기화] 로컬 재생 중지 - 일시정지 위치 저장 (이미 일시정지 상태):', currentTime, '초');
                } else {
                  pauseTimeRef.current = 0;
                  console.log('[재생 상태 동기화] 로컬 재생 중지 - 일시정지 위치를 가져올 수 없어 0으로 설정 (이미 일시정지 상태)');
                }
              } catch (e) {
                if (pauseTimeRef.current === null) {
                  pauseTimeRef.current = 0;
                  console.log('[재생 상태 동기화] 로컬 재생 중지 - 일시정지 위치를 가져올 수 없어 0으로 설정 (이미 일시정지 상태)');
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('[재생 상태 동기화] 재생 제어 오류:', error);
    }
  }, [playerReady, music, hasControl, isPlaying, localPlayMode, localIsPlaying]); // 의존성 배열에 music, playerReady 추가
  
  // 주기적으로 재생 상태 확인 및 동기화
  // 모바일에서 백그라운드로 가거나 화면이 꺼질 때 onStateChange 이벤트가 발생하지 않을 수 있으므로
  // 주기적으로 플레이어 상태를 확인하여 ENDED 상태를 감지
  // 제어권이 없어도 서버의 일시정지 상태는 반영해야 함 (로컬 재생 모드가 아닐 때)
  useEffect(() => {
    if (!playerReady || !youtubePlayerRef.current || !music) {
      return;
    }
    
    // 로컬 재생 모드이고 제어권이 없으면 서버 상태와 무관하게 동작
    if (localPlayMode && !hasControl) {
      return;
    }
    
    const syncInterval = setInterval(() => {
      // 로컬 재생 모드이고 제어권이 없으면 서버 상태와 무관하게 동작
      if (localPlayMode && !hasControl) {
        return;
      }
      
      if (playerReady && youtubePlayerRef.current && music) {
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
            // 단, 로컬 재생 모드에서는 서버에 알림하지 않음
            // 단, 정지 상태(isPlaying === false)에서는 다음 곡으로 넘어가지 않음
            // 단, 수동 다음 곡 전환(manualNextRef.current === true)인 경우는 허용
            if (!endedSentRef.current && window.socket && hasControl && !localPlayMode && (isPlaying || manualNextRef.current)) {
              endedSentRef.current = true;
              console.log('[주기적 상태 확인] 재생 종료 상태 감지 - 다음 곡으로 이동 (모바일 백업 로직)', {
                videoId: music?.videoId,
                title: music?.title,
                socketConnected: window.socket?.connected,
                isPlaying,
                manualNext: manualNextRef.current
              });
              window.socket.emit('musicEnded', getEndedPayload());
              manualNextRef.current = false; // musicEnded 전송 후 수동 다음 곡 전환 플래그 리셋
            } else {
              // 정지 상태이거나 다른 이유로 musicEnded를 전송하지 않는 경우
              if (!isPlaying && !manualNextRef.current) {
                console.log('[주기적 상태 확인] 정지 상태 - musicEnded 전송하지 않음', {
                  videoId: music?.videoId,
                  title: music?.title,
                  isPlaying,
                  hasControl,
                  localPlayMode,
                  endedSent: endedSentRef.current
                });
              } else if (localPlayMode && !hasControl) {
                // 로컬 재생 모드에서 재생 종료 시 다음 곡 대기
                console.log('[주기적 상태 확인] 로컬 재생 종료 - 다음 곡 대기');
                setLocalIsPlaying(false);
              }
            }
            return; // ENDED 상태면 다른 동기화 로직 실행하지 않음
          }
          
          // 서버가 일시정지 상태이면 일시정지 위치 저장 (로컬 재생 모드여도 정지)
          if (!isPlaying && playerState === window.YT.PlayerState.PAUSED && pauseTimeRef.current === null) {
            // 서버가 일시정지 상태인데 pauseTimeRef가 설정되지 않았으면 설정 (로컬 재생 모드여도 정지)
            try {
              const currentTime = youtubePlayerRef.current.getCurrentTime();
              if (currentTime > 0) {
                pauseTimeRef.current = currentTime;
                console.log('[주기적 상태 확인] 서버 일시정지 상태 - 일시정지 위치 저장:', currentTime, '초');
              } else {
                pauseTimeRef.current = 0; // 0으로 설정하여 자동 재생을 막음
                console.log('[주기적 상태 확인] 서버 일시정지 상태 - 일시정지 위치를 가져올 수 없어 0으로 설정');
              }
            } catch (e) {
              if (pauseTimeRef.current === null) {
                pauseTimeRef.current = 0; // 0으로 설정하여 자동 재생을 막음
                console.log('[주기적 상태 확인] 서버 일시정지 상태 - 일시정지 위치를 가져올 수 없어 0으로 설정');
              }
            }
          }
          
          // 서버가 재생 중이거나 로컬 재생 중인데 플레이어가 일시정지 상태면 재생
          // 단, 일시정지 위치가 저장되어 있으면 사용자가 의도적으로 일시정지한 것이므로 자동 재생하지 않음
          // 단, 최근 재생 시도가 없을 때만 재생
          // 브라우저가 백그라운드에 있을 때도 자동으로 재생 (백그라운드에서 일시정지된 경우)
          if ((isPlaying && hasControl) || (localPlayMode && localIsPlaying)) {
            // 서버가 재생 중이면 pauseTimeRef 초기화 (재생 재개 시)
            if (isPlaying && pauseTimeRef.current !== null) {
              console.log('[주기적 상태 확인] 서버 재생 재개 - pauseTimeRef 초기화:', pauseTimeRef.current);
              pauseTimeRef.current = null;
              lastPlayAttemptRef.current = null; // 재생 시도 시간도 리셋
            }
            
            if (playerState === window.YT.PlayerState.PAUSED && pauseTimeRef.current === null) {
              const now = Date.now();
              const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
              if (timeSinceLastAttempt > 500) {
                // 일시정지 위치가 없으면 YouTube 컨트롤로 일시정지한 경우이거나 백그라운드에서 일시정지된 경우이므로 자동 재생
                console.log('[주기적 상태 확인] 일시정지 상태 감지 - 자동 재생 시도 (백그라운드에서 일시정지된 경우 포함)');
                lastPlayAttemptRef.current = now;
              youtubePlayerRef.current.playVideo();
              }
            }
          }
          
          // 플레이어가 CUED 상태면 재생 시도
          // 모바일에서 loadVideoById 후 CUED 상태에서 재생이 시작되지 않을 수 있음
          // 단, 서버가 일시정지 상태가 아니고, 일시정지 위치가 저장되어 있지 않을 때만 재생
          // 단, 최근 재생 시도가 없을 때만 재생
          // 단, BUFFERING 상태가 아닐 때만 재생 (BUFFERING 중에는 재생 시도하지 않음)
          if ((hasControl || localPlayMode) && playerState === window.YT.PlayerState.CUED && pauseTimeRef.current === null && (isPlaying || localPlayMode) && playerState !== window.YT.PlayerState.BUFFERING) {
            const now = Date.now();
            const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
            if (timeSinceLastAttempt > 2000) { // 1000ms에서 2000ms로 증가 (재생 시도 빈도 더 감소)
            console.log('[주기적 상태 확인] CUED 상태 감지 - 재생 시도');
            try {
              if (typeof youtubePlayerRef.current.playVideo === 'function') {
                  lastPlayAttemptRef.current = now;
                youtubePlayerRef.current.playVideo();
                console.log('[주기적 상태 확인] CUED 상태에서 재생 시도 완료');
              }
            } catch (e) {
              console.log('[주기적 상태 확인] CUED 상태에서 재생 시도 오류:', e);
                lastPlayAttemptRef.current = null; // 오류 발생 시 리셋
              }
            }
          }
          
          // 플레이어가 UNSTARTED 상태면 재생 시도
          // loadVideoById 후 UNSTARTED 상태에서 재생이 시작되지 않을 수 있음
          // 단, 서버가 일시정지 상태가 아니고, 일시정지 위치가 저장되어 있지 않을 때만 재생
          // 단, 최근 재생 시도가 없을 때만 재생
          // 단, BUFFERING 상태가 아닐 때만 재생 (BUFFERING 중에는 재생 시도하지 않음)
          if ((hasControl || localPlayMode) && playerState === window.YT.PlayerState.UNSTARTED && pauseTimeRef.current === null && (isPlaying || localPlayMode) && playerState !== window.YT.PlayerState.BUFFERING) {
            const now = Date.now();
            const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
            if (timeSinceLastAttempt > 2000) { // 1000ms에서 2000ms로 증가 (재생 시도 빈도 더 감소)
            console.log('[주기적 상태 확인] UNSTARTED 상태 감지 - 재생 시도');
            try {
              if (typeof youtubePlayerRef.current.playVideo === 'function') {
                  lastPlayAttemptRef.current = now;
                youtubePlayerRef.current.playVideo();
                console.log('[주기적 상태 확인] UNSTARTED 상태에서 재생 시도 완료');
              }
            } catch (e) {
              console.log('[주기적 상태 확인] UNSTARTED 상태에서 재생 시도 오류:', e);
                lastPlayAttemptRef.current = null; // 오류 발생 시 리셋
              }
            }
          }
          
          // 서버가 재생 중인데 플레이어가 버퍼링 중이면 재생하지 않음 (정상 상태)
          
          // 서버가 중지했으면 일시정지 (모든 클라이언트에서 반영)
          // 단, 로컬 재생 모드이고 제어권이 없으면 서버 상태와 무관하게 동작
          if (!isPlaying && !localPlayMode) {
            // 서버가 일시정지 상태이고 로컬 재생 모드가 아니면 모든 클라이언트에서 일시정지
            if (playerState === window.YT.PlayerState.PLAYING || playerState === window.YT.PlayerState.BUFFERING) {
              youtubePlayerRef.current.pauseVideo();
              console.log('[주기적 상태 확인] 서버 일시정지 상태 반영 - 플레이어 일시정지 실행', {
                hasControl,
                playerState
              });
            }
          } else if (localPlayMode && !localIsPlaying && !hasControl) {
            // 로컬 재생 모드이고 로컬 재생이 중지되었으면 일시정지
            if (playerState === window.YT.PlayerState.PLAYING || playerState === window.YT.PlayerState.BUFFERING) {
              youtubePlayerRef.current.pauseVideo();
              console.log('[주기적 상태 확인] 로컬 재생 중지 - 플레이어 일시정지 실행');
            }
          }
        } catch (e) {
          // 무시
        }
      }
    }, 1000); // 1초마다 확인

    return () => {
      clearInterval(syncInterval);
    };
  }, [isPlaying, playerReady, music, hasControl, localPlayMode, localIsPlaying]);

  // 제어권 있는 클라이언트: 재생 위치를 서버에 주기적으로 전송 및 seek 감지
  useEffect(() => {
    if (hasControl && playerReady && youtubePlayerRef.current && isPlaying) {
      // 기존 인터벌 정리
      if (playbackPositionIntervalRef.current) {
        clearInterval(playbackPositionIntervalRef.current);
        playbackPositionIntervalRef.current = null;
      }
      if (seekCheckIntervalRef.current) {
        clearInterval(seekCheckIntervalRef.current);
        seekCheckIntervalRef.current = null;
      }
      
      // 1단계: seek 감지를 위한 위치 추적 (0.5초마다 확인)
      seekCheckIntervalRef.current = setInterval(() => {
        if (youtubePlayerRef.current && window.socket && hasControl && isPlaying) {
          try {
            const currentTime = youtubePlayerRef.current.getCurrentTime();
            if (typeof currentTime === 'number' && currentTime >= 0) {
              // 이전 위치와 비교하여 seek 감지 (1초 이상 급격한 변화)
              if (previousPositionRef.current !== null) {
                const timeDiff = Date.now() - lastSentTimeRef.current;
                const expectedPosition = lastSentPositionRef.current + (timeDiff / 1000);
                const actualDiff = Math.abs(currentTime - expectedPosition);
                
                // 1초 이상 차이나면 seek로 판단
                if (actualDiff >= 1.0) {
                  console.log('[Seek 감지] 즉시 서버로 전송:', {
                    이전위치: previousPositionRef.current,
                    현재위치: currentTime,
                    예상위치: expectedPosition,
                    차이: actualDiff
                  });
                  
                  // 즉시 서버로 전송 (seek 이벤트)
                  lastSentPositionRef.current = currentTime;
                  lastSentTimeRef.current = Date.now();
                  
                  window.socket.emit('seekPlaybackPosition', {
                    position: currentTime,
                    videoId: music?.videoId,
                    timestamp: Date.now()
                  });
                }
              }
              
              // 이전 위치 업데이트
              previousPositionRef.current = currentTime;
            }
          } catch (e) {
            console.log('[Seek 감지] 오류:', e);
          }
        }
      }, 500); // 0.5초마다 확인
      
      // 2단계: 3초마다 재생 위치 전송 (정기 업데이트)
      playbackPositionIntervalRef.current = setInterval(() => {
        if (youtubePlayerRef.current && window.socket && hasControl && isPlaying) {
          try {
            const playerState = youtubePlayerRef.current.getPlayerState();
            
            // 브라우저가 백그라운드에 있을 때 플레이어가 일시정지되었으면 자동으로 재생
            if (playerState === window.YT.PlayerState.PAUSED && pauseTimeRef.current === null) {
              // 서버가 재생 중인데 플레이어가 일시정지되었으면 자동으로 재생 (백그라운드에서 일시정지된 경우)
              const now = Date.now();
              const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
              if (timeSinceLastAttempt > 500) {
                console.log('[재생 위치 전송] 백그라운드에서 일시정지 감지 - 자동 재생 시도');
                lastPlayAttemptRef.current = now;
                youtubePlayerRef.current.playVideo();
              }
            }
            
            const currentTime = youtubePlayerRef.current.getCurrentTime();
            if (typeof currentTime === 'number' && currentTime >= 0) {
              // 자신이 전송한 위치 추적
              lastSentPositionRef.current = currentTime;
              lastSentTimeRef.current = Date.now();
              
              window.socket.emit('updatePlaybackPosition', {
                position: currentTime,
                videoId: music?.videoId
              });
            }
          } catch (e) {
            console.log('[재생 위치 전송] 오류:', e);
          }
        }
      }, 3000); // 3초마다 전송
      
      return () => {
        if (playbackPositionIntervalRef.current) {
          clearInterval(playbackPositionIntervalRef.current);
          playbackPositionIntervalRef.current = null;
        }
        if (seekCheckIntervalRef.current) {
          clearInterval(seekCheckIntervalRef.current);
          seekCheckIntervalRef.current = null;
        }
      };
    } else {
      // 재생 중이 아니거나 제어권이 없으면 인터벌 정리
      if (playbackPositionIntervalRef.current) {
        clearInterval(playbackPositionIntervalRef.current);
        playbackPositionIntervalRef.current = null;
      }
      if (seekCheckIntervalRef.current) {
        clearInterval(seekCheckIntervalRef.current);
        seekCheckIntervalRef.current = null;
      }
      previousPositionRef.current = null;
    }
  }, [hasControl, playerReady, isPlaying, music?.videoId]);

  // 서버 재생 위치 업데이트 이벤트 수신
  useEffect(() => {
    if (!window.socket) return;
    
    const handlePlaybackPositionUpdate = (data) => {
      if (data && data.videoId && typeof data.position === 'number') {
        const positionData = {
          videoId: data.videoId,
          position: data.position,
          timestamp: data.timestamp || Date.now()
        };
        setServerPlaybackPosition(positionData);
        // ref에도 저장 (onReady에서 접근용)
        serverPlaybackPositionRef.current = positionData;
      }
    };
    
    // 4단계: seek 이벤트 수신 시 즉시 동기화 (주기 제한 없이)
    const handlePlaybackPositionSeek = (data) => {
      if (data && data.videoId && typeof data.position === 'number') {
        const positionData = {
          videoId: data.videoId,
          position: data.position,
          timestamp: data.timestamp || Date.now()
        };
        setServerPlaybackPosition(positionData);
        // ref에도 저장
        serverPlaybackPositionRef.current = positionData;
        
        // '내 장치로 듣기' 모드이고 재생 중이면 즉시 동기화
        if (localPlayMode && !hasControl && playerReady && youtubePlayerRef.current && localIsPlaying &&
            music && positionData.videoId === music.videoId) {
          try {
            const myPosition = youtubePlayerRef.current.getCurrentTime();
            const serverPosition = positionData.position;
            
            // 네트워크 지연 보정
            const delay = (Date.now() - positionData.timestamp) / 1000;
            const adjustedServerPosition = serverPosition + delay;
            
            const difference = Math.abs(myPosition - adjustedServerPosition);
            
            // seek 이벤트는 차이가 0.5초 이상이면 즉시 동기화 (주기 제한 없이)
            if (difference >= 0.5) {
              console.log('[내 장치로 듣기 - Seek 동기화] 즉시 동기화:', {
                내위치: myPosition,
                서버위치: adjustedServerPosition,
                차이: difference
              });
              
              // 플레이어 상태 확인
              const playerState = youtubePlayerRef.current.getPlayerState();
              
              if (typeof youtubePlayerRef.current.seekTo === 'function') {
                // seekTo 호출 전에 pauseTimeRef를 초기화하여 재생을 허용
                pauseTimeRef.current = null;
                // 재생 시도 시간을 설정하여 재생 상태 동기화 useEffect가 재생을 막지 않도록 함
                lastPlayAttemptRef.current = Date.now();
                
                // seekTo 호출
                youtubePlayerRef.current.seekTo(adjustedServerPosition, true);
                lastSyncTimeRef.current = Date.now(); // 동기화 시간 업데이트
                
                // seekTo 호출 후 자동 재생 보장
                // 플레이어가 일시정지 상태이고 재생 중이어야 하면 재생 시작
                setTimeout(() => {
                  if (youtubePlayerRef.current && localIsPlaying && pauseTimeRef.current === null) {
                    const stateAfterSeek = youtubePlayerRef.current.getPlayerState();
                    if (stateAfterSeek === window.YT.PlayerState.PAUSED) {
                      const now = Date.now();
                      const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                      if (timeSinceLastAttempt > 500) {
                        lastPlayAttemptRef.current = now;
                        youtubePlayerRef.current.playVideo();
                        console.log('[내 장치로 듣기 - Seek 동기화] 일시정지 상태에서 재생 시작');
                        
                        // 재생이 시작되었는지 확인
                        setTimeout(() => {
                          if (youtubePlayerRef.current) {
                            const stateAfterPlay = youtubePlayerRef.current.getPlayerState();
                            if (stateAfterPlay === window.YT.PlayerState.PLAYING) {
                              console.log('[내 장치로 듣기 - Seek 동기화] 재생 성공 확인');
                            } else if (stateAfterPlay === window.YT.PlayerState.PAUSED) {
                              // 여전히 일시정지 상태이면 다시 재생 시도
                              const retryNow = Date.now();
                              const timeSinceLastAttempt = lastPlayAttemptRef.current ? retryNow - lastPlayAttemptRef.current : Infinity;
                              if (timeSinceLastAttempt > 500) {
                                console.log('[내 장치로 듣기 - Seek 동기화] 재생이 시작되지 않음, 재시도');
                                lastPlayAttemptRef.current = retryNow;
                                youtubePlayerRef.current.playVideo();
                              }
                            }
                          }
                        }, 500);
                      }
                    }
                  }
                }, 300);
              }
            }
          } catch (e) {
            console.log('[내 장치로 듣기 - Seek 동기화] 오류:', e);
          }
        }
        
        // 제어권 있는 클라이언트: seek 이벤트 수신 시 즉시 동기화
        if (hasControl && !localPlayMode && playerReady && youtubePlayerRef.current && isPlaying &&
            music && positionData.videoId === music.videoId) {
          try {
            const myPosition = youtubePlayerRef.current.getCurrentTime();
            const serverPosition = positionData.position;
            
            // 네트워크 지연 보정
            const delay = (Date.now() - positionData.timestamp) / 1000;
            const adjustedServerPosition = serverPosition + delay;
            
            const difference = Math.abs(myPosition - adjustedServerPosition);
            
            // seek 이벤트는 차이가 0.5초 이상이면 즉시 동기화 (주기 제한 없이)
            if (difference >= 0.5) {
              console.log('[제어권 있음 - Seek 동기화] 즉시 동기화:', {
                내위치: myPosition,
                서버위치: adjustedServerPosition,
                차이: difference
              });
              
              // 플레이어 상태 확인
              const playerState = youtubePlayerRef.current.getPlayerState();
              
              if (typeof youtubePlayerRef.current.seekTo === 'function') {
                // seekTo 호출 전에 pauseTimeRef를 초기화하여 재생을 허용
                pauseTimeRef.current = null;
                // 재생 시도 시간을 설정하여 재생 상태 동기화 useEffect가 재생을 막지 않도록 함
                lastPlayAttemptRef.current = Date.now();
                
                // seekTo 호출
                youtubePlayerRef.current.seekTo(adjustedServerPosition, true);
                lastSyncTimeForControlRef.current = Date.now();
                // 동기화 후 전송 위치도 업데이트
                lastSentPositionRef.current = adjustedServerPosition;
                lastSentTimeRef.current = Date.now();
                
                // seekTo 호출 후 자동 재생 보장
                // 플레이어가 일시정지 상태이면 재생 시작
                setTimeout(() => {
                  if (youtubePlayerRef.current && isPlaying && pauseTimeRef.current === null) {
                    const stateAfterSeek = youtubePlayerRef.current.getPlayerState();
                    if (stateAfterSeek === window.YT.PlayerState.PAUSED) {
                      const now = Date.now();
                      const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                      if (timeSinceLastAttempt > 500) {
                        lastPlayAttemptRef.current = now;
                        youtubePlayerRef.current.playVideo();
                        console.log('[제어권 있음 - Seek 동기화] 일시정지 상태에서 재생 시작');
                        
                        // 재생이 시작되었는지 확인
                        setTimeout(() => {
                          if (youtubePlayerRef.current) {
                            const stateAfterPlay = youtubePlayerRef.current.getPlayerState();
                            if (stateAfterPlay === window.YT.PlayerState.PLAYING) {
                              console.log('[제어권 있음 - Seek 동기화] 재생 성공 확인');
                            } else if (stateAfterPlay === window.YT.PlayerState.PAUSED) {
                              // 여전히 일시정지 상태이면 다시 재생 시도
                              const retryNow = Date.now();
                              const timeSinceLastAttempt = lastPlayAttemptRef.current ? retryNow - lastPlayAttemptRef.current : Infinity;
                              if (timeSinceLastAttempt > 500) {
                                console.log('[제어권 있음 - Seek 동기화] 재생이 시작되지 않음, 재시도');
                                lastPlayAttemptRef.current = retryNow;
                                youtubePlayerRef.current.playVideo();
                              }
                            }
                          }
                        }, 500);
                      }
                    }
                  }
                }, 300);
              }
            }
          } catch (e) {
            console.log('[제어권 있음 - Seek 동기화] 오류:', e);
          }
        }
      }
    };
    
    window.socket.on('playbackPositionUpdate', handlePlaybackPositionUpdate);
    window.socket.on('playbackPositionSeek', handlePlaybackPositionSeek);
    
    return () => {
      window.socket.off('playbackPositionUpdate', handlePlaybackPositionUpdate);
      window.socket.off('playbackPositionSeek', handlePlaybackPositionSeek);
    };
  }, [localPlayMode, hasControl, playerReady, localIsPlaying, music]);

  // 제어권 있는 클라이언트: 플레이어 준비 후 서버 재생 위치로 즉시 동기화 (최초 1회)
  useEffect(() => {
    if (!hasControl || localPlayMode || !playerReady || !youtubePlayerRef.current || !isPlaying) {
      return;
    }
    
    if (!serverPlaybackPosition || !music || serverPlaybackPosition.videoId !== music.videoId) {
      return;
    }
    
    // 플레이어가 준비된 직후 최초 동기화 (제한 없이 실행)
    // 단, 이미 동기화를 시도한 경우는 스킵 (lastSyncTimeForControlRef가 0이 아닌 경우)
    if (lastSyncTimeForControlRef.current > 0) {
      return; // 이미 동기화를 시도했으면 스킵
    }
    
    try {
      const myPosition = youtubePlayerRef.current.getCurrentTime();
      const serverPosition = serverPlaybackPosition.position;
      
      // 네트워크 지연 보정
      const delay = (Date.now() - serverPlaybackPosition.timestamp) / 1000;
      const adjustedServerPosition = serverPosition + delay;
      
      const difference = Math.abs(myPosition - adjustedServerPosition);
      
      // 차이가 0.5초 이상이면 동기화
      if (difference >= 0.5) {
        console.log('[제어권 있음 - 플레이어 준비 후 즉시 동기화]:', {
          내위치: myPosition,
          서버위치: adjustedServerPosition,
          차이: difference
        });
        
        if (typeof youtubePlayerRef.current.seekTo === 'function') {
          youtubePlayerRef.current.seekTo(adjustedServerPosition, true);
          lastSyncTimeForControlRef.current = Date.now();
          // 동기화 후 전송 위치도 업데이트
          lastSentPositionRef.current = adjustedServerPosition;
          lastSentTimeRef.current = Date.now();
        }
      } else {
        // 차이가 작아도 동기화 시간 기록 (다음 주기 동기화 방지)
        lastSyncTimeForControlRef.current = Date.now();
        lastSentPositionRef.current = myPosition;
        lastSentTimeRef.current = Date.now();
      }
    } catch (e) {
      console.log('[제어권 있음 - 플레이어 준비 후 동기화] 오류:', e);
    }
  }, [hasControl, localPlayMode, playerReady, isPlaying, serverPlaybackPosition, music]);

  // 제어권 있는 클라이언트: 서버 재생 위치와 주기적 동기화
  useEffect(() => {
    if (!hasControl || localPlayMode || !playerReady || !youtubePlayerRef.current || !isPlaying) {
      return;
    }
    
    if (!serverPlaybackPosition || !music || serverPlaybackPosition.videoId !== music.videoId) {
      return;
    }
    
    // 10초에 1회만 동기화 (너무 자주 호출 방지)
    const now = Date.now();
    if (now - lastSyncTimeForControlRef.current < 10000) {
      return;
    }
    
    try {
      const myPosition = youtubePlayerRef.current.getCurrentTime();
      const serverPosition = serverPlaybackPosition.position;
      
      // 자신이 전송한 위치와 비교 (0.5초 이하면 스킵)
      if (lastSentPositionRef.current !== null) {
        const timeSinceSent = (now - lastSentTimeRef.current) / 1000;
        const expectedMyPosition = lastSentPositionRef.current + timeSinceSent;
        const sentPositionDiff = Math.abs(serverPosition - expectedMyPosition);
        
        if (sentPositionDiff < 0.5) {
          // 자신이 전송한 위치와 거의 동일하면 동기화 스킵
          return;
        }
      }
      
      // 네트워크 지연 보정
      const delay = (Date.now() - serverPlaybackPosition.timestamp) / 1000;
      const adjustedServerPosition = serverPosition + delay;
      
      const difference = Math.abs(myPosition - adjustedServerPosition);
      
      // 차이가 2초 이상이면 동기화
      if (difference >= 2) {
        console.log('[재생 위치 동기화 - 제어권 있음] 동기화 실행:', {
          내위치: myPosition,
          서버위치: adjustedServerPosition,
          차이: difference,
          전송한위치: lastSentPositionRef.current
        });
        
        if (typeof youtubePlayerRef.current.seekTo === 'function') {
          youtubePlayerRef.current.seekTo(adjustedServerPosition, true);
          lastSyncTimeForControlRef.current = now;
          // 동기화 후 전송 위치도 업데이트
          lastSentPositionRef.current = adjustedServerPosition;
          lastSentTimeRef.current = now;
        }
      }
    } catch (e) {
      console.log('[재생 위치 동기화 - 제어권 있음] 오류:', e);
    }
  }, [serverPlaybackPosition, hasControl, localPlayMode, playerReady, isPlaying, music?.videoId]);

  // 로컬 재생 모드: 서버 재생 위치와 동기화 (제어권 없는 클라이언트)
  useEffect(() => {
    if (!localPlayMode || hasControl || !playerReady || !youtubePlayerRef.current || !localIsPlaying) {
      return;
    }
    
    if (!serverPlaybackPosition || !music || serverPlaybackPosition.videoId !== music.videoId) {
      return;
    }
    
    // 서버가 재생 중이면 pauseTimeRef 초기화 (재생 재개 시)
    if (isPlaying && pauseTimeRef.current !== null) {
      console.log('[재생 위치 동기화] 서버 재생 재개 - pauseTimeRef 초기화:', pauseTimeRef.current);
      pauseTimeRef.current = null;
      lastPlayAttemptRef.current = null; // 재생 시도 시간도 리셋
    }
    
    // pauseTimeRef가 설정되어 있으면 동기화하지 않음 (일시정지 상태)
    if (pauseTimeRef.current !== null) {
      return;
    }
    
    // 5초에 1회만 동기화 (너무 자주 호출 방지)
    const now = Date.now();
    if (now - lastSyncTimeRef.current < 5000) {
      return;
    }
    
    try {
      const myPosition = youtubePlayerRef.current.getCurrentTime();
      const serverPosition = serverPlaybackPosition.position;
      
      // 네트워크 지연 보정
      const delay = (Date.now() - serverPlaybackPosition.timestamp) / 1000;
      const adjustedServerPosition = serverPosition + delay;
      
      const difference = Math.abs(myPosition - adjustedServerPosition);
      
      // 차이가 3초 이상이면 동기화
      if (difference >= 3) {
        console.log('[재생 위치 동기화] 동기화 실행:', {
          내위치: myPosition,
          서버위치: adjustedServerPosition,
          차이: difference
        });
        
        // 플레이어 상태 확인
        const playerState = youtubePlayerRef.current.getPlayerState();
        
        if (typeof youtubePlayerRef.current.seekTo === 'function') {
          // seekTo만 호출 (자동 재생 방지)
          youtubePlayerRef.current.seekTo(adjustedServerPosition, true);
          lastSyncTimeRef.current = now;
          
          // 플레이어가 일시정지 상태이고 재생 중이어야 하면 재생 시작
          // 단, pauseTimeRef가 설정되어 있으면 재생하지 않음
          if (playerState === window.YT.PlayerState.PAUSED && pauseTimeRef.current === null) {
            setTimeout(() => {
              if (youtubePlayerRef.current && localIsPlaying && pauseTimeRef.current === null) {
                const stateAfterSeek = youtubePlayerRef.current.getPlayerState();
                if (stateAfterSeek === window.YT.PlayerState.PAUSED) {
                  const attemptNow = Date.now();
                  const timeSinceLastAttempt = lastPlayAttemptRef.current ? attemptNow - lastPlayAttemptRef.current : Infinity;
                  if (timeSinceLastAttempt > 500) {
                    lastPlayAttemptRef.current = attemptNow;
                    youtubePlayerRef.current.playVideo();
                    console.log('[재생 위치 동기화] 일시정지 상태에서 재생 시작');
                  }
                }
              }
            }, 300);
          }
        }
      }
    } catch (e) {
      console.log('[재생 위치 동기화] 오류:', e);
    }
  }, [serverPlaybackPosition, localPlayMode, hasControl, playerReady, localIsPlaying, music?.videoId, isPlaying]);

  // 서버에서 정지할 때 로컬 재생 모드여도 정지
  useEffect(() => {
    if (!isPlaying && localPlayMode) {
      console.log('[서버 정지] 서버에서 정지 - 로컬 재생 모드여도 정지');
      setLocalIsPlaying(false);
      // 플레이어 일시정지
      if (youtubePlayerRef.current && typeof youtubePlayerRef.current.pauseVideo === 'function') {
        try {
          const playerState = youtubePlayerRef.current.getPlayerState();
          if (playerState !== window.YT.PlayerState.PAUSED && playerState !== window.YT.PlayerState.ENDED) {
            youtubePlayerRef.current.pauseVideo();
            // pauseTimeRef 설정하여 자동 재생 방지
            try {
              const currentTime = youtubePlayerRef.current.getCurrentTime();
              if (currentTime > 0 && pauseTimeRef.current === null) {
                pauseTimeRef.current = currentTime;
                console.log('[서버 정지] 일시정지 위치 저장:', currentTime, '초');
              } else if (pauseTimeRef.current === null) {
                pauseTimeRef.current = 0;
                console.log('[서버 정지] 일시정지 위치를 가져올 수 없어 0으로 설정');
              }
            } catch (e) {
              if (pauseTimeRef.current === null) {
                pauseTimeRef.current = 0;
                console.log('[서버 정지] 일시정지 위치를 가져올 수 없어 0으로 설정:', e);
              }
            }
            console.log('[서버 정지] 플레이어 일시정지 실행');
          }
        } catch (e) {
          console.log('[서버 정지] 일시정지 오류:', e);
        }
      }
    } else if (isPlaying && pauseTimeRef.current !== null) {
      // 서버에서 재생 재개할 때 pauseTimeRef 초기화 (모든 클라이언트에서)
      console.log('[서버 재생 재개] pauseTimeRef 초기화:', pauseTimeRef.current);
      pauseTimeRef.current = null;
      lastPlayAttemptRef.current = null; // 재생 시도 시간도 리셋
    }
  }, [isPlaying, localPlayMode]);

  // localPlayMode가 false로 변경될 때 로컬 재생 완전히 중지
  useEffect(() => {
    if (!localPlayMode && youtubePlayerRef.current && playerReady) {
      console.log('[로컬 재생 모드 해제] 로컬 재생 완전히 중지');
      setLocalIsPlaying(false);
      try {
        // 플레이어 일시정지
        if (typeof youtubePlayerRef.current.pauseVideo === 'function') {
          youtubePlayerRef.current.pauseVideo();
        }
        // 제어권이 없으면 플레이어를 완전히 제거하지 않고 일시정지만 (제어권이 있으면 서버 제어를 위해 유지)
        if (!hasControl) {
          // 제어권이 없고 로컬 재생 모드도 아니면 플레이어를 숨기기만 함 (이미 display: none 처리됨)
          console.log('[로컬 재생 모드 해제] 제어권 없음 - 플레이어 일시정지 완료');
        }
      } catch (e) {
        console.log('[로컬 재생 모드 해제] 일시정지 오류:', e);
      }
    }
  }, [localPlayMode, hasControl, playerReady]);

  // musicPlaying 이벤트 수신 시 로컬 재생 모드에서만 자동으로 새 곡 재생 (현재 재생 위치부터)
  useEffect(() => {
    if (localPlayMode && music && music.videoId && playerReady && youtubePlayerRef.current) {
      console.log('[로컬 재생] 새 곡 감지 - 자동 재생 시작 (현재 위치부터)');
      setLocalIsPlaying(true);
      try {
        // 현재 재생 중인 곡이 다르면 새 곡으로 전환
        const currentVideoId = youtubePlayerRef.current.getVideoData()?.video_id;
        if (currentVideoId !== music.videoId) {
          // 현재 재생 위치 계산 (playStartTime 기준)
          const calculateCurrentPosition = () => {
            if (music.playStartTime) {
              const playStartTime = new Date(music.playStartTime).getTime();
              const currentTime = Date.now();
              const elapsedSeconds = Math.floor((currentTime - playStartTime) / 1000);
              return Math.max(0, elapsedSeconds); // 음수 방지
            }
            return 0;
          };
          
          const seekPosition = calculateCurrentPosition();
          console.log('[로컬 재생] 현재 재생 위치 계산:', {
            playStartTime: music.playStartTime,
            currentTime: Date.now(),
            elapsedSeconds: seekPosition
          });
          
          // 새 곡 로드 (자동 재생 방지: false)
          lastPlayAttemptRef.current = null; // 새 곡 로드 시 재생 시도 시간 리셋
          youtubePlayerRef.current.loadVideoById(music.videoId, seekPosition);
          
          // 비디오 로드 후 해당 위치로 이동하여 재생
          setTimeout(() => {
            if (youtubePlayerRef.current && localPlayMode && pauseTimeRef.current === null) {
              try {
                // 먼저 해당 위치로 이동 (이미 loadVideoById에서 위치 지정했지만 확실히 하기 위해)
                if (seekPosition > 0 && typeof youtubePlayerRef.current.seekTo === 'function') {
                  youtubePlayerRef.current.seekTo(seekPosition, true); // true = 정확한 위치로 이동
                  console.log('[로컬 재생] seekTo 호출:', seekPosition, '초');
                }
                // 재생 시작
                if (typeof youtubePlayerRef.current.playVideo === 'function') {
                  setTimeout(() => {
                    if (youtubePlayerRef.current && localPlayMode && pauseTimeRef.current === null) {
                      const currentState = youtubePlayerRef.current.getPlayerState();
                      if (currentState !== window.YT.PlayerState.PLAYING) {
                        const now = Date.now();
                        const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                        if (timeSinceLastAttempt > 500) {
                          lastPlayAttemptRef.current = now;
                      youtubePlayerRef.current.playVideo();
                      console.log('[로컬 재생] 재생 시작 (현재 위치부터)');
                        }
                      }
                    }
                  }, 500); // seekTo 후 충분한 지연
                }
              } catch (e) {
                console.log('[로컬 재생] 위치 이동 및 재생 오류:', e);
                lastPlayAttemptRef.current = null; // 오류 발생 시 리셋
              }
            }
          }, 800);
        } else {
          // 같은 곡이면 현재 위치에서 재생 (현재 재생 위치 계산)
          const calculateCurrentPosition = () => {
            if (music.playStartTime) {
              const playStartTime = new Date(music.playStartTime).getTime();
              const currentTime = Date.now();
              const elapsedSeconds = Math.floor((currentTime - playStartTime) / 1000);
              return Math.max(0, elapsedSeconds);
            }
            return 0;
          };
          
          const seekPosition = calculateCurrentPosition();
          console.log('[로컬 재생] 같은 곡 - 현재 위치로 이동:', seekPosition, '초');
          
          if (localPlayMode && typeof youtubePlayerRef.current.seekTo === 'function' && typeof youtubePlayerRef.current.playVideo === 'function' && pauseTimeRef.current === null) {
            try {
              // 현재 위치로 이동
              if (seekPosition > 0) {
                youtubePlayerRef.current.seekTo(seekPosition, true);
              }
              // 재생 시작
              setTimeout(() => {
                if (youtubePlayerRef.current && localPlayMode && pauseTimeRef.current === null) {
                  const currentState = youtubePlayerRef.current.getPlayerState();
                  if (currentState !== window.YT.PlayerState.PLAYING) {
                    const now = Date.now();
                    const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                    if (timeSinceLastAttempt > 500) {
                      lastPlayAttemptRef.current = now;
                  youtubePlayerRef.current.playVideo();
                  console.log('[로컬 재생] 재생 시작 (현재 위치부터)');
                    }
                  }
                }
              }, 300);
            } catch (e) {
              console.log('[로컬 재생] 위치 이동 및 재생 오류:', e);
              lastPlayAttemptRef.current = null; // 오류 발생 시 리셋
            }
          }
        }
      } catch (e) {
        console.log('[로컬 재생] 새 곡 재생 오류:', e);
      }
    } else if (!localPlayMode && youtubePlayerRef.current && playerReady) {
      // 로컬 재생 모드가 아니면 재생하지 않음
      console.log('[로컬 재생] 로컬 재생 모드 아님 - 재생하지 않음');
      setLocalIsPlaying(false);
    }
  }, [music?.videoId, music?.playStartTime, localPlayMode, playerReady]);

  // 컴포넌트 언마운트 시 플레이어 정리
  useEffect(() => {
    return () => {
      // 컴포넌트가 언마운트될 때만 플레이어 제거
      console.log('[언마운트 cleanup] 플레이어 정리 시작');
      if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
        cleanupTimeoutRef.current = null;
      }
      
      if (youtubePlayerRef.current) {
        try {
          // 플레이어가 실제로 DOM에 존재하는지 확인
          const playerElement = playerRef.current;
          if (playerElement && playerElement.parentNode) {
            youtubePlayerRef.current.destroy();
            console.log('[언마운트 cleanup] 플레이어 제거 완료');
          } else {
            console.log('[언마운트 cleanup] 플레이어가 이미 DOM에서 제거됨');
          }
        } catch (e) {
          console.log('[언마운트 cleanup] 플레이어 제거 오류 (무시):', e);
        }
        youtubePlayerRef.current = null;
      }
      setPlayerReady(false);
    };
  }, []); // 빈 의존성 배열: 컴포넌트 언마운트 시에만 실행

  // 토글 버튼 핸들러
  const handleTogglePlayMode = () => {
    if (!setLocalPlayMode) return;
    const newMode = !localPlayMode;
    setLocalPlayMode(newMode);
    
    if (newMode) {
      // "내 장치로 듣기" 모드로 전환
      console.log('[토글] 내 장치로 듣기 모드 활성화');
      if (music && music.videoId) {
        setLocalIsPlaying(true);
        // 플레이어가 있으면 현재 재생 위치부터 재생 시도
        if (youtubePlayerRef.current && playerReady) {
          try {
            // 현재 재생 위치 계산 (playStartTime 기준)
            const calculateCurrentPosition = () => {
              if (music.playStartTime) {
                const playStartTime = new Date(music.playStartTime).getTime();
                const currentTime = Date.now();
                const elapsedSeconds = Math.floor((currentTime - playStartTime) / 1000);
                return Math.max(0, elapsedSeconds); // 음수 방지
              }
              return 0;
            };
            
            const seekPosition = calculateCurrentPosition();
            console.log('[토글] 현재 재생 위치 계산:', {
              playStartTime: music.playStartTime,
              currentTime: Date.now(),
              elapsedSeconds: seekPosition
            });
            
            // 현재 재생 중인 곡이 다르면 새 곡으로 전환
            const currentVideoId = youtubePlayerRef.current.getVideoData()?.video_id;
            if (currentVideoId !== music.videoId) {
              // 새 곡 로드 (자동 재생 방지: seekPosition을 두 번째 파라미터로 전달)
              lastPlayAttemptRef.current = null; // 새 곡 로드 시 재생 시도 시간 리셋
              youtubePlayerRef.current.loadVideoById(music.videoId, seekPosition);
              // 비디오 로드 후 해당 위치로 이동하여 재생
              setTimeout(() => {
                if (youtubePlayerRef.current && typeof youtubePlayerRef.current.seekTo === 'function' && typeof youtubePlayerRef.current.playVideo === 'function') {
                  // 이미 loadVideoById에서 위치 지정했지만 확실히 하기 위해 seekTo 호출
                  if (seekPosition > 0) {
                    youtubePlayerRef.current.seekTo(seekPosition, true);
                    console.log('[토글] seekTo 호출:', seekPosition, '초');
                  }
                  setTimeout(() => {
                    if (youtubePlayerRef.current) {
                      const currentState = youtubePlayerRef.current.getPlayerState();
                      if (currentState !== window.YT.PlayerState.PLAYING) {
                        const now = Date.now();
                        const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                        if (timeSinceLastAttempt > 500) {
                          lastPlayAttemptRef.current = now;
                      youtubePlayerRef.current.playVideo();
                      console.log('[토글] 재생 시작 (현재 위치부터)');
                        }
                      }
                    }
                  }, 500); // 충분한 지연
                }
              }, 800);
            } else {
              // 같은 곡이면 현재 위치로 이동하여 재생
              if (typeof youtubePlayerRef.current.seekTo === 'function' && typeof youtubePlayerRef.current.playVideo === 'function') {
                if (seekPosition > 0) {
                  youtubePlayerRef.current.seekTo(seekPosition, true);
                  console.log('[토글] seekTo 호출:', seekPosition, '초');
                }
                setTimeout(() => {
                  if (youtubePlayerRef.current) {
                    const currentState = youtubePlayerRef.current.getPlayerState();
                    if (currentState !== window.YT.PlayerState.PLAYING) {
                      const now = Date.now();
                      const timeSinceLastAttempt = lastPlayAttemptRef.current ? now - lastPlayAttemptRef.current : Infinity;
                      if (timeSinceLastAttempt > 500) {
                        lastPlayAttemptRef.current = now;
                    youtubePlayerRef.current.playVideo();
                    console.log('[토글] 재생 시작 (현재 위치부터)');
                      }
                    }
                  }
                }, 300);
              }
            }
          } catch (e) {
            console.log('[토글] 재생 시도 오류:', e);
          }
        }
      }
    } else {
      // "서버 장치로 듣기" 모드로 전환
      console.log('[토글] 서버 장치로 듣기 모드 활성화');
      setLocalIsPlaying(false);
      // 로컬 재생 중지
      if (youtubePlayerRef.current && typeof youtubePlayerRef.current.pauseVideo === 'function') {
        try {
          youtubePlayerRef.current.pauseVideo();
        } catch (e) {
          console.log('[토글] 일시정지 오류:', e);
        }
      }
    }
  };

  // 음악이 없으면 "재생 중인 음악이 없습니다" 표시
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

  // 단일 JSX 구조로 통합하여 제어권 이동 시 DOM 충돌 방지
  // 플레이어 컨테이너는 항상 렌더링하되, 조건부로 표시/숨김 처리
  return (
    <div className="current-playing">
      <div className="current-playing-header">
        <h2>현재 재생 중</h2>
        <div className="header-controls">
          {/* 볼륨 조절 컨트롤 (제어권 있는 세션에서만) */}
          {hasControl && music && (
            <div className="volume-control-compact">
              <button
                className="volume-icon-btn"
                onClick={() => setShowVolumeSlider(!showVolumeSlider)}
                title={`볼륨: ${volume}%`}
              >
                <span className="material-icons">
                  {volume === 0 ? 'volume_off' : volume < 50 ? 'volume_down' : 'volume_up'}
                </span>
              </button>
              {showVolumeSlider && (
                <div className="volume-slider-popup">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={handleVolumeChange}
                    className="volume-slider-vertical"
                    title={`볼륨: ${volume}%`}
                    orient="vertical"
                  />
                  <span className="volume-value-compact">{volume}%</span>
                </div>
              )}
            </div>
          )}
          
          {/* 다음 음악 재생 버튼 */}
          {isAdmin && (
            hasControl ? (
              <button 
                onClick={() => {
                  manualNextRef.current = true; // 수동 다음 곡 전환 플래그 설정
                  onPlayNext();
                }} 
                className="next-btn-compact"
                title="다음 음악 재생"
              >
                <span className="material-icons">skip_next</span>
              </button>
            ) : (
              <button 
                disabled 
                className="next-btn-compact disabled"
                title="다음 음악 재생 (제어권 없음)"
              >
                <span className="material-icons">skip_next</span>
              </button>
            )
          )}
        </div>
      </div>
      <div className="music-card">
        <div className="thumbnail-container">
          <img src={music.thumbnail} alt={music.title} />
          <span 
            className="like-icon" 
            onClick={handleLikeClick}
          >
            <span className="material-icons">{isLiked ? 'favorite' : 'favorite_border'}</span>
            {likeCount > 0 && (
              <span className="like-count-badge">{likeCount}</span>
            )}
          </span>
          {(isPlaying || (localPlayMode && localIsPlaying)) && (
            <div className="playing-indicator">재생 중</div>
          )}
        </div>
        <div className="music-info">
          <h3>{music.title}</h3>
          <p className="requested-by">
            요청자: {music.requesterSessionId && music.requesterSessionId === mySessionId ? "나" : music.requestedBy}
            {music.isSubstitute && <span className="substitute-badge">대체 영상</span>}
          </p>
          
          {/* 플레이어 컨테이너는 항상 렌더링 (제어권 이동 시 DOM 충돌 방지) */}
          {/* 제어권이 없고 로컬 재생 모드가 아니면 숨김, 제어권이 있거나 로컬 재생 모드면 표시 */}
          <div 
            className={`player-container ${localPlayMode ? 'audio-only' : ''}`} 
            style={{ 
              display: (hasControl || localPlayMode) ? 'block' : 'none' 
            }}
          >
            <div ref={playerRef}></div>
            {/* YouTube 컨트롤 버튼 영역 클릭 방지 오버레이 (재생 위치 이동은 허용) */}
            {!localPlayMode && (
              <div className="player-controls-overlay"></div>
            )}
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
          
        </div>
      </div>
    </div>
  );
}

export default CurrentPlaying;

