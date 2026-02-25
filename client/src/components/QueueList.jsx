import React from 'react';
import './QueueList.css';

function QueueList({ queue, onRemove, isAdmin = false }) {
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
          <div key={music.id} className="queue-item">
            <div className="queue-number">{index + 1}</div>
            <div className="queue-thumbnail">
              <img src={music.thumbnail} alt={music.title} />
            </div>
            <div className="queue-info">
              <h4>{music.title}</h4>
              <p className="queue-requested-by">{music.requestedBy}</p>
            </div>
            {isAdmin && (
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

