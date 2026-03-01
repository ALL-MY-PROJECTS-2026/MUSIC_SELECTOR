import React, { useState } from 'react';
import './QueueList.css';

function QueueList({ queue, onRemove, onReorder, isAdmin = false, hasControl = false }) {
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

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

  if (queue.length === 0) {
    return (
      <div className="queue-list">
        <h2>대기열</h2>
        <div className="empty-queue">
          <p>대기 중인 음악이 없습니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="queue-list">
      <h2>대기열 ({queue.length})</h2>
      <div className="queue-items">
        {queue.map((music, index) => (
          <div 
            key={music.id} 
            className={`queue-item ${draggedIndex === index ? 'dragging' : ''} ${dragOverIndex === index ? 'drag-over' : ''}`}
            draggable={isAdmin && hasControl}
            onDragStart={(e) => handleDragStart(e, index)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, index)}
          >
            <div className="queue-number">{index + 1}</div>
            <div className="queue-thumbnail">
              <img src={music.thumbnail} alt={music.title} />
            </div>
            <div className="queue-info">
              <h4>{music.title}</h4>
              <div className="queue-meta">
                {music.isAIRecommendation && (
                  <span className="queue-ai-badge">AI 추천</span>
                )}
                <p className="queue-requested-by">{music.requestedBy}</p>
              </div>
            </div>
            {isAdmin && hasControl && (
              <button 
                onClick={() => onRemove(music.id)}
                className="remove-btn"
                title="대기열에서 제거"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default QueueList;

