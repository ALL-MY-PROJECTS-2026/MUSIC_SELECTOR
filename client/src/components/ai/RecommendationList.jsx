/**
 * 추천 리스트 컴포넌트
 * 추천 결과를 리스트 형태로 표시
 */

import React from 'react';
import './RecommendationList.css';

const RecommendationList = ({ recommendations, onAddToQueue }) => {
  if (!recommendations || recommendations.length === 0) {
    return (
      <div className="recommendation-list-empty">
        <p>추천 결과가 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="recommendation-list">
      {recommendations.map((recommendation, index) => (
        <div key={recommendation.videoId || index} className="recommendation-item">
          <div className="recommendation-item-thumbnail">
            <img 
              src={recommendation.thumbnail || 'https://via.placeholder.com/120x90'} 
              alt={recommendation.title}
              onError={(e) => {
                e.target.src = 'https://via.placeholder.com/120x90';
              }}
            />
          </div>
          <div className="recommendation-item-info">
            <h4 className="recommendation-item-title">{recommendation.title}</h4>
            {recommendation.duration && (
              <p className="recommendation-item-duration">{recommendation.duration}</p>
            )}
            {recommendation.finalScore !== undefined && (
              <p className="recommendation-item-score">
                추천 점수: {(recommendation.finalScore * 100).toFixed(1)}%
              </p>
            )}
          </div>
          <div className="recommendation-item-actions">
            <button
              className="recommendation-add-button"
              onClick={() => onAddToQueue(recommendation)}
            >
              추가하기
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default RecommendationList;
