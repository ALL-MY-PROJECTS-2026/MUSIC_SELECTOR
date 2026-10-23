import React, { useState, useEffect } from 'react';
import './QueueList.css';

function QueueList({ queue, onRemove, onReorder, isAdmin = false, hasControl = false, mySessionId = null }) {
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  const handleDragStart = (e, index) => {
    if (!isAdmin || !hasControl) return;
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.target.outerHTML);
    e.currentTarget.style.opacity = '0.5';
  };

  const handleDragEnd = (e) => {
    e.currentTarget.style.opacity = '1';
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e, dropIndex) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== dropIndex && onReorder) {
      onReorder(draggedIndex, dropIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  // 페이징 계산
  const totalPages = Math.ceil(queue.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const pagedQueue = queue.slice(startIndex, endIndex);
  const globalStartIndex = startIndex; // 전체 대기열에서의 시작 인덱스

  // 페이지 변경 시 현재 페이지 유지 (데이터가 변경되어도)
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    }
  }, [queue.length, totalPages, currentPage]);

  if (queue.length === 0) {
    return (
      <div className="queue-list">
        <div className="queue-header">
          <h2>대기열</h2>
        </div>
        <div className="empty-queue">
          <p>대기 중인 음악이 없습니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="queue-list">
      <div className="queue-header">
        <h2>대기열 ({queue.length})</h2>
        {totalPages > 1 && (
          <div className="queue-pagination">
            <button
              className="queue-pagination-btn"
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              title="이전 페이지"
            >
              <span className="material-icons">chevron_left</span>
            </button>
            <span className="queue-pagination-info">
              {currentPage} / {totalPages}
            </span>
            <button
              className="queue-pagination-btn"
              onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              disabled={currentPage >= totalPages}
              title="다음 페이지"
            >
              <span className="material-icons">chevron_right</span>
            </button>
          </div>
        )}
      </div>
      <div className="queue-items">
        {pagedQueue.map((music, index) => {
          const globalIndex = globalStartIndex + index;
          return (
            <div 
              key={music.id} 
              className={`queue-item ${draggedIndex === globalIndex ? 'dragging' : ''} ${dragOverIndex === globalIndex ? 'drag-over' : ''}`}
              draggable={isAdmin && hasControl}
              onDragStart={(e) => handleDragStart(e, globalIndex)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, globalIndex)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, globalIndex)}
            >
              <div className="queue-number">{globalIndex + 1}</div>
              <div className="queue-thumbnail">
                <img src={music.thumbnail} alt={music.title} />
              </div>
              <div className="queue-info">
                <h4>{music.title}</h4>
                <div className="queue-meta">
                  {music.isAIRecommendation && (
                    <span className="queue-ai-badge">AI 추천</span>
                  )}
                  {music.isSubstitute && <span className="substitute-badge">대체 영상</span>}
                  <p className="queue-requested-by">{music.requesterSessionId && music.requesterSessionId === mySessionId ? "나" : music.requestedBy}</p>
                </div>
              </div>
              {isAdmin && hasControl && (
                <button 
                  onClick={() => onRemove(music.id)}
                  className="remove-btn"
                  title="대기열에서 제거"
                >
                  <span className="material-icons" aria-hidden="true">close</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default QueueList;

