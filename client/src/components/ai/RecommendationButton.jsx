/**
 * AI 추천 버튼 컴포넌트
 */

import React, { useState } from 'react';
import RecommendationService from '../../services/ai/recommendationService';
import RecommendationModal from './RecommendationModal';
import './RecommendationButton.css';

const RecommendationButton = ({ socket, queue = [] }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [recommendations, setRecommendations] = useState(null);
  const [reasoning, setReasoning] = useState('');
  const [processingTime, setProcessingTime] = useState(0);
  const [error, setError] = useState(null);
  const [musicRegion, setMusicRegion] = useState('all'); // 'all', 'domestic', 'international'
  const [showSettings, setShowSettings] = useState(false);

  const handleRecommendation = async () => {
    if (!socket) {
      setError('서버 연결이 필요합니다.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // 서버에서 대기열 + 하트 데이터 요청
      socket.emit('getQueueAndLikes');

      // 응답 대기
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

      // 추천 서비스 생성
      const recommendationService = new RecommendationService(socket);

      // 추천 생성 (국내/해외 기준 포함)
      const result = await recommendationService.generateRecommendations(
        queueData,
        musicLikes,
        null, // searchQuery
        musicRegion // musicRegion: 'all', 'domestic', 'international'
      );

      setRecommendations(result.recommendations);
      setReasoning(result.reasoning);
      setProcessingTime(result.processingTime);
      setIsModalOpen(true);
    } catch (err) {
      console.error('[RecommendationButton] 추천 생성 실패:', err);
      setError(err.message || '추천 생성에 실패했습니다.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddToQueue = async (music) => {
    if (!socket) {
      setError('서버 연결이 필요합니다.');
      return;
    }

    // 현재 대기열 정보 가져오기 (최신 상태 확인)
    let currentQueue = [];
    try {
      socket.emit('getQueueAndLikes');
      const queueAndLikesData = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('서버 응답 타임아웃'));
        }, 5000);

        socket.once('queueAndLikes', (data) => {
          clearTimeout(timeout);
          resolve(data);
        });

        socket.once('error', (error) => {
          clearTimeout(timeout);
          reject(new Error(error.message || '서버 오류'));
        });
      });
      currentQueue = queueAndLikesData.queue || [];
    } catch (error) {
      console.warn('[RecommendationButton] 대기열 정보 가져오기 실패, queue prop 사용:', error);
      currentQueue = queue || [];
    }

    // 대기열에 이미 있는 노래인지 확인 (videoId 기준)
    const queueVideoIds = new Set(currentQueue.map(m => m.videoId));
    let selectedMusic = music;

    // 선택한 노래가 대기열에 있으면 차선의 노래 찾기
    if (queueVideoIds.has(music.videoId)) {
      console.log(`[RecommendationButton] 선택한 노래가 대기열에 있음: "${music.title}", 차선의 노래 찾는 중...`);
      
      // 추천 결과에서 대기열에 없는 첫 번째 노래 찾기
      const alternativeMusic = recommendations?.find(rec => 
        rec.videoId !== music.videoId && !queueVideoIds.has(rec.videoId)
      );

      if (alternativeMusic) {
        selectedMusic = alternativeMusic;
        console.log(`[RecommendationButton] 차선의 노래 선택: "${alternativeMusic.title}"`);
      } else {
        // 모든 추천 결과가 대기열에 있으면 에러
        setError('선택한 노래와 다른 모든 추천 노래가 이미 대기열에 있습니다. 다른 노래를 선택해주세요.');
        return;
      }
    }

    // 대기열에 추가 (AI 추천 플래그 추가)
    socket.emit('requestMusic', {
      musicData: {
        videoId: selectedMusic.videoId,
        title: selectedMusic.title,
        thumbnail: selectedMusic.thumbnail,
        duration: selectedMusic.duration,
      },
      requestedBy: socket.id,
      isAIRecommendation: true, // AI 추천 플래그
    });

    // AI 추천 노래를 localStorage에 자동 저장
    try {
      const stored = localStorage.getItem('aiRecommendations');
      const aiRecommendations = stored ? JSON.parse(stored) : [];
      
      // 중복 체크
      const exists = aiRecommendations.some(item => item.videoId === selectedMusic.videoId);
      if (!exists) {
        aiRecommendations.push({
          videoId: selectedMusic.videoId,
          title: selectedMusic.title,
          thumbnail: selectedMusic.thumbnail,
          duration: selectedMusic.duration,
          addedAt: new Date().toISOString(),
        });
        localStorage.setItem('aiRecommendations', JSON.stringify(aiRecommendations));
        console.log('[RecommendationButton] AI 추천 노래가 localStorage에 저장되었습니다:', selectedMusic.title);
      }
    } catch (error) {
      console.error('[RecommendationButton] localStorage 저장 실패:', error);
    }

    // 성공 메시지 (선택사항)
    if (selectedMusic.videoId !== music.videoId) {
      console.log(`[RecommendationButton] 원래 선택한 노래가 대기열에 있어 차선의 노래를 추가했습니다: "${selectedMusic.title}"`);
    } else {
      console.log('음악이 대기열에 추가되었습니다:', selectedMusic.title);
    }
  };

  return (
    <>
      <div className="recommendation-button-container">
        {!showSettings ? (
          <button
            className="recommendation-button"
            onClick={() => {
              if (!isLoading) {
                setShowSettings(true);
              }
            }}
            disabled={isLoading}
          >
            {isLoading ? 'AI 추천 중...' : 'AI 추천'}
          </button>
        ) : (
          <div className="recommendation-settings">
            <label>
              음악 기준:
              <select
                value={musicRegion}
                onChange={(e) => setMusicRegion(e.target.value)}
                className="recommendation-region-select"
              >
                <option value="all">전체</option>
                <option value="domestic">국내</option>
                <option value="international">해외</option>
              </select>
            </label>
            <button
              className="recommendation-confirm-btn"
              onClick={() => {
                setShowSettings(false);
                handleRecommendation();
              }}
              disabled={isLoading}
            >
              확인
            </button>
            <button
              className="recommendation-cancel-btn"
              onClick={() => setShowSettings(false)}
            >
              취소
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="recommendation-error">
          <p>{error}</p>
          <button onClick={() => setError(null)}>닫기</button>
        </div>
      )}

      <RecommendationModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        recommendations={recommendations}
        reasoning={reasoning}
        processingTime={processingTime}
        onAddToQueue={handleAddToQueue}
      />
    </>
  );
};

export default RecommendationButton;
