/**
 * AI 자동추천 버튼 컴포넌트
 * 주기마다 자동으로 추천 음악을 대기열에 추가
 */

import React, { useState, useEffect, useRef } from 'react';
import RecommendationService from '../../services/ai/recommendationService';
import './AutoRecommendationButton.css';

const AutoRecommendationButton = ({ socket, hasControl = false }) => {
  const [isActive, setIsActive] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastAddedTitle, setLastAddedTitle] = useState(null);
  const [error, setError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [musicRegion, setMusicRegion] = useState('all'); // 'all', 'domestic', 'international'
  
  const intervalRef = useRef(null);
  const processingRef = useRef(false); // 중복 실행 방지
  const isActiveRef = useRef(false); // 최신 isActive 상태 참조용
  const hasControlRef = useRef(false); // 최신 hasControl 상태 참조용

  // isActive 상태가 변경될 때마다 ref 업데이트
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // hasControl 상태가 변경될 때마다 ref 업데이트
  useEffect(() => {
    hasControlRef.current = hasControl;
  }, [hasControl]);

  // 자동 추천 중지 함수 (먼저 정의)
  const handleStop = () => {
    setIsActive(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setLastAddedTitle(null);
    setError(null);
    console.log('[AutoRecommendation] 자동 추천 중지');
  };

  // 자동 추천 실행 함수
  const executeAutoRecommendation = async () => {
    // ref를 사용하여 최신 상태 확인
    if (processingRef.current || !socket || !isActiveRef.current || !hasControlRef.current) {
      console.log('[AutoRecommendation] 실행 조건 체크:', {
        processing: processingRef.current,
        socket: !!socket,
        isActive: isActiveRef.current,
        hasControl: hasControlRef.current
      });
      // 제어권이 없으면 자동 중지
      if (!hasControlRef.current && isActiveRef.current) {
        handleStop();
        setError('제어권이 없어 자동 추천이 중지되었습니다.');
      }
      return;
    }

    processingRef.current = true;
    setIsProcessing(true);
    setError(null);

    try {
      // 서버에서 대기열 + 하트 데이터 요청
      socket.emit('getQueueAndLikes');

      const queueAndLikesData = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('서버 응답 타임아웃'));
        }, 10000);

        socket.once('queueAndLikes', (data) => {
          clearTimeout(timeout);
          resolve(data);
        });

        socket.once('error', (error) => {
          clearTimeout(timeout);
          reject(new Error(error.message || '서버 오류'));
        });
      });

      const { queue: queueData, musicLikes } = queueAndLikesData;

      // 대기열이 비어있어도 기본 장르(발라드)로 조회순 추천 가능
      if (queueData.length === 0) {
        console.log('[AutoRecommendation] 대기열이 비어있어 기본 장르(발라드)로 조회순 추천을 시작합니다.');
      } else {
        console.log('[AutoRecommendation] 추천 생성 시작, 대기열:', queueData.length, '개');
      }

      // 추천 서비스 생성
      const recommendationService = new RecommendationService(socket);

      // 추천 생성 (1곡만 필요하므로 상위 1개만, 지역 필터 포함)
      const result = await recommendationService.generateRecommendations(
        queueData,
        musicLikes,
        null, // searchQuery
        musicRegion // musicRegion: 'all', 'domestic', 'international'
      );

      if (result.recommendations && result.recommendations.length > 0) {
        // 대기열에 없는 첫 번째 추천 음악 찾기
        const queueVideoIds = new Set(queueData.map(m => m.videoId));
        let recommendedMusic = null;

        // 추천 결과에서 대기열에 없는 첫 번째 노래 찾기
        for (const rec of result.recommendations) {
          if (!queueVideoIds.has(rec.videoId)) {
            recommendedMusic = rec;
            break;
          }
        }

        // 모든 추천 결과가 대기열에 있으면 건너뛰기
        if (!recommendedMusic) {
          console.log('[AutoRecommendation] 모든 추천 결과가 대기열에 있어 건너뜁니다.');
          console.log('[AutoRecommendation] 대기열 videoIds:', Array.from(queueVideoIds));
          console.log('[AutoRecommendation] 추천 결과 videoIds:', result.recommendations.map(r => r.videoId));
          setError('모든 추천 결과가 이미 대기열에 있습니다.');
          return;
        }

        console.log('[AutoRecommendation] 추천 음악 선택:', recommendedMusic.title);
        console.log('[AutoRecommendation] requestMusic 이벤트 전송:', {
          videoId: recommendedMusic.videoId,
          title: recommendedMusic.title,
          requestedBy: socket.id
        });

        socket.emit('requestMusic', {
          musicData: {
            videoId: recommendedMusic.videoId,
            title: recommendedMusic.title,
            thumbnail: recommendedMusic.thumbnail,
            duration: recommendedMusic.duration,
          },
          requestedBy: socket.id,
          isAIRecommendation: true, // AI 추천 플래그
        });

        // AI 추천 노래를 localStorage에 자동 저장
        try {
          const stored = localStorage.getItem('aiRecommendations');
          const aiRecommendations = stored ? JSON.parse(stored) : [];
          
          // 중복 체크
          const exists = aiRecommendations.some(item => item.videoId === recommendedMusic.videoId);
          if (!exists) {
            aiRecommendations.push({
              videoId: recommendedMusic.videoId,
              title: recommendedMusic.title,
              thumbnail: recommendedMusic.thumbnail,
              duration: recommendedMusic.duration,
              addedAt: new Date().toISOString(),
            });
            localStorage.setItem('aiRecommendations', JSON.stringify(aiRecommendations));
            console.log('[AutoRecommendation] AI 추천 노래가 localStorage에 저장되었습니다:', recommendedMusic.title);
          }
        } catch (error) {
          console.error('[AutoRecommendation] localStorage 저장 실패:', error);
        }

        setLastAddedTitle(recommendedMusic.title);
        console.log('[AutoRecommendation] 자동 추천 음악 추가 완료:', recommendedMusic.title);
      } else {
        const errorMsg = `추천 결과가 없습니다. (추천 개수: ${result.recommendations?.length || 0})`;
        console.log('[AutoRecommendation]', errorMsg);
        setError(errorMsg);
      }
    } catch (err) {
      console.error('[AutoRecommendation] 자동 추천 실패:', err);
      setError(err.message || '자동 추천에 실패했습니다.');
    } finally {
      setIsProcessing(false);
      processingRef.current = false;
    }
  };

  // 자동 추천 시작
  const handleStart = () => {
    if (!socket) {
      setError('서버 연결이 필요합니다.');
      return;
    }

    if (!hasControl) {
      setError('제어권을 가진 위치에서만 사용할 수 있습니다.');
      return;
    }

    // 기존 interval이 있으면 정리
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setIsActive(true);
    setShowSettings(false);
    setError(null);

    // 주기마다 실행 (즉시 실행을 위해 약간의 지연 후 첫 실행)
    const intervalMs = intervalMinutes * 60 * 1000;
    
    // 즉시 한 번 실행 (약간의 지연을 두어 상태 업데이트가 완료되도록)
    setTimeout(() => {
      if (isActiveRef.current && hasControlRef.current) {
        console.log('[AutoRecommendation] 즉시 실행 시작');
        executeAutoRecommendation();
      } else {
        console.log('[AutoRecommendation] 즉시 실행 취소: isActive=', isActiveRef.current, 'hasControl=', hasControlRef.current);
      }
    }, 500);

    // 주기마다 실행
    intervalRef.current = setInterval(() => {
      if (isActiveRef.current && hasControlRef.current) {
        console.log('[AutoRecommendation] 주기 실행 시작');
        executeAutoRecommendation();
      } else {
        console.log('[AutoRecommendation] 실행 중단:', {
          isActive: isActiveRef.current,
          hasControl: hasControlRef.current
        });
        if (!hasControlRef.current && isActiveRef.current) {
          handleStop();
          setError('제어권이 없어 자동 추천이 중지되었습니다.');
        }
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    }, intervalMs);

    console.log(`[AutoRecommendation] 자동 추천 시작: ${intervalMinutes}분마다 실행 (${intervalMs}ms)`);
  };


  // 컴포넌트 언마운트 시 정리
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  // 주기 옵션
  const intervalOptions = [
    { value: 1, label: '1분' },
    { value: 3, label: '3분' },
    { value: 5, label: '5분' },
    { value: 10, label: '10분' },
    { value: 15, label: '15분' },
    { value: 30, label: '30분' },
  ];

  // 제어권이 없으면 자동 중지
  useEffect(() => {
    if (!hasControl && isActive) {
      handleStop();
      setError('제어권이 없어 자동 추천이 중지되었습니다.');
    }
  }, [hasControl]);

  return (
    <div className="auto-recommendation-container">
      <div className="auto-recommendation-controls">
        {!isActive ? (
          <>
            <button
              className="auto-recommendation-button"
              onClick={() => {
                if (!hasControl) {
                  setError('제어권을 가진 위치에서만 사용할 수 있습니다.');
                  return;
                }
                setShowSettings(!showSettings);
              }}
              disabled={!hasControl}
              title={!hasControl ? '제어권을 가진 위치에서만 사용할 수 있습니다.' : ''}
            >
              AI 자동추천
            </button>
            {showSettings && (
              <div className="auto-recommendation-settings">
                <label>
                  주기 설정:
                  <select
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                    className="auto-recommendation-select"
                  >
                    {intervalOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  음악 기준:
                  <select
                    value={musicRegion}
                    onChange={(e) => setMusicRegion(e.target.value)}
                    className="auto-recommendation-select"
                  >
                    <option value="all">전체</option>
                    <option value="domestic">국내</option>
                    <option value="international">해외</option>
                  </select>
                </label>
                <button
                  className="auto-recommendation-confirm-btn"
                  onClick={handleStart}
                >
                  확인
                </button>
                <button
                  className="auto-recommendation-cancel-btn"
                  onClick={() => setShowSettings(false)}
                >
                  취소
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="auto-recommendation-active">
            <button
              className="auto-recommendation-stop-btn"
              onClick={handleStop}
            >
              자동추천 중지
            </button>
            <span className="auto-recommendation-status">
              {isProcessing ? '추천 중...' : `${intervalMinutes}분마다 자동 추가`}
            </span>
            {lastAddedTitle && (
              <span className="auto-recommendation-last-added">
                마지막 추가: {lastAddedTitle}
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="auto-recommendation-error">
          <p>{error}</p>
          <button onClick={() => setError(null)}>닫기</button>
        </div>
      )}
    </div>
  );
};

export default AutoRecommendationButton;
