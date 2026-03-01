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

      // 추천 생성
      const result = await recommendationService.generateRecommendations(
        queueData,
        musicLikes
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

  const handleAddToQueue = (music) => {
    if (!socket) {
      setError('서버 연결이 필요합니다.');
      return;
    }

    // 대기열에 추가 (AI 추천 플래그 추가)
    socket.emit('requestMusic', {
      musicData: {
        videoId: music.videoId,
        title: music.title,
        thumbnail: music.thumbnail,
        duration: music.duration,
      },
      requestedBy: socket.id,
      isAIRecommendation: true, // AI 추천 플래그
    });

    // AI 추천 노래를 localStorage에 자동 저장
    try {
      const stored = localStorage.getItem('aiRecommendations');
      const aiRecommendations = stored ? JSON.parse(stored) : [];
      
      // 중복 체크
      const exists = aiRecommendations.some(item => item.videoId === music.videoId);
      if (!exists) {
        aiRecommendations.push({
          videoId: music.videoId,
          title: music.title,
          thumbnail: music.thumbnail,
          duration: music.duration,
          addedAt: new Date().toISOString(),
        });
        localStorage.setItem('aiRecommendations', JSON.stringify(aiRecommendations));
        console.log('[RecommendationButton] AI 추천 노래가 localStorage에 저장되었습니다:', music.title);
      }
    } catch (error) {
      console.error('[RecommendationButton] localStorage 저장 실패:', error);
    }

    // 성공 메시지 (선택사항)
    console.log('음악이 대기열에 추가되었습니다:', music.title);
  };

  return (
    <>
      <button
        className="recommendation-button"
        onClick={handleRecommendation}
        disabled={isLoading}
      >
        {isLoading ? 'AI 추천 중...' : 'AI 추천'}
      </button>

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
