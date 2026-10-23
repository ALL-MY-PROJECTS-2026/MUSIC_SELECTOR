/**
 * 추천 결과 모달 컴포넌트
 */

import React, { useState } from 'react';
import RecommendationList from './RecommendationList';
import './RecommendationModal.css';

const RecommendationModal = ({ 
  isOpen, 
  onClose, 
  recommendations, 
  reasoning,
  processingTime,
  onAddToQueue 
}) => {
  const [showInfo, setShowInfo] = useState(false);

  if (!isOpen) return null;

  return (
    <div className="recommendation-modal-overlay" onClick={onClose}>
      <div className="recommendation-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="recommendation-modal-header">
          <h2>AI 추천 결과</h2>
          <div className="recommendation-modal-header-actions">
            <button 
              className="recommendation-modal-info-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowInfo(!showInfo);
              }}
              title="추천 기준 및 모델 정보"
            >
              <span className="material-icons" aria-hidden="true">info</span>
            </button>
            <button className="recommendation-modal-close" onClick={onClose} aria-label="닫기">
              <span className="material-icons" aria-hidden="true">close</span>
            </button>
          </div>
        </div>

        {showInfo && (
          <div className="recommendation-modal-info-panel">
            <div className="recommendation-info-section">
              <h3>추천 기준</h3>
              <div className="recommendation-info-content">
                <div className="recommendation-info-item">
                  <strong>아티스트 일치 (45%) - 1순위</strong>
                  <p>대기열에 있는 가수들의 다른 노래를 최우선으로 추천합니다. 대기열에 없는 노래만 추천됩니다.</p>
                </div>
                <div className="recommendation-info-item">
                  <strong>텍스트 유사도 (35%) - 2순위</strong>
                  <p>대기열의 인기 음악 제목을 분석하여 유사한 스타일의 음악을 추천합니다.</p>
                </div>
                <div className="recommendation-info-item">
                  <strong>인기도 (15%) - 3순위</strong>
                  <p>YouTube 조회수와 최신도를 기반으로 인기도를 계산합니다. 인기 있는 노래를 우선 추천합니다.</p>
                </div>
                <div className="recommendation-info-item">
                  <strong>아티스트 다양성 (5%) - 4순위</strong>
                  <p>다양한 아티스트의 유사한 노래도 추천하여 반복을 방지하고 새로운 발견을 돕습니다.</p>
                </div>
                <div className="recommendation-info-item">
                  <strong>모음집 필터링</strong>
                  <p>개별 노래만 추천하며, 모음집/플레이리스트는 자동으로 제외합니다.</p>
                </div>
              </div>
            </div>
            <div className="recommendation-info-section">
              <h3>모델 정보</h3>
              <div className="recommendation-info-content">
                <div className="recommendation-info-item">
                  <strong>모델명</strong>
                  <p>Xenova/multilingual-e5-small</p>
                </div>
                <div className="recommendation-info-item">
                  <strong>모델 타입</strong>
                  <p>Multilingual Sentence Transformer (Feature Extraction)</p>
                </div>
                <div className="recommendation-info-item">
                  <strong>실행 환경</strong>
                  <p>브라우저 기반 (Transformers.js)</p>
                </div>
                <div className="recommendation-info-item">
                  <strong>언어 지원</strong>
                  <p>다국어 (한국어, 영어 등 100개 이상 언어)</p>
                </div>
                <div className="recommendation-info-item">
                  <strong>임베딩 차원</strong>
                  <p>384차원 벡터</p>
                </div>
                <div className="recommendation-info-item">
                  <strong>유사도 계산</strong>
                  <p>코사인 유사도 (Cosine Similarity)</p>
                </div>
              </div>
            </div>
            <div className="recommendation-info-section">
              <h3>추천 과정</h3>
              <div className="recommendation-info-content">
                <ol className="recommendation-process-list">
                  <li>대기열에서 하트가 높은 상위 10개 음악 선택</li>
                  <li>각 음악 제목을 임베딩 벡터로 변환</li>
                  <li>하트 개수에 따라 가중 평균 임베딩 계산</li>
                  <li>다양한 검색 쿼리로 YouTube 검색 (제목, 아티스트, 키워드)</li>
                  <li>검색 결과와 가중 평균 임베딩의 유사도 계산</li>
                  <li>인기도, 아티스트 일치, 다양성 점수 결합</li>
                  <li>중복 제거 (대기열에 이미 있는 음악 제외)</li>
                  <li>최종 점수 기준으로 상위 20개 추천</li>
                </ol>
              </div>
            </div>
          </div>
        )}
        
        {reasoning && (
          <div className="recommendation-modal-reasoning">
            <p>{reasoning}</p>
          </div>
        )}
        
        {processingTime && (
          <div className="recommendation-modal-info">
            <p>처리 시간: {(processingTime / 1000).toFixed(2)}초</p>
          </div>
        )}
        
        <div className="recommendation-modal-body">
          <RecommendationList 
            recommendations={recommendations}
            onAddToQueue={onAddToQueue}
          />
        </div>
      </div>
    </div>
  );
};

export default RecommendationModal;
