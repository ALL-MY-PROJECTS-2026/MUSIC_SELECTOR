class QueueManager {
  constructor() {
    this.queue = [];
  }

  // 대기열에 음악 추가
  addToQueue(musicItem) {
    this.queue.push(musicItem);
    console.log(`대기열에 추가됨: ${musicItem.title} (총 ${this.queue.length}개)`);
    return this.queue;
  }

  // 대기열에서 다음 음악 가져오기
  getNextMusic() {
    if (this.queue.length === 0) {
      return null;
    }
    return this.queue[0];
  }

  // ID로 음악 찾기
  getMusicById(id) {
    return this.queue.find(music => music.id === id);
  }

  // 대기열에서 음악 제거
  removeFromQueue(id) {
    const index = this.queue.findIndex(music => music.id === id);
    if (index !== -1) {
      const removed = this.queue.splice(index, 1)[0];
      console.log(`대기열에서 제거됨: ${removed.title} (남은 개수: ${this.queue.length})`);
      return removed;
    }
    return null;
  }

  // 전체 대기열 가져오기
  getQueue() {
    return this.queue;
  }

  // 대기열 초기화
  clearQueue() {
    this.queue = [];
    console.log('대기열이 초기화되었습니다.');
  }

  // 대기열 순서 변경
  reorderQueue(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.queue.length ||
        toIndex < 0 || toIndex >= this.queue.length) {
      return false;
    }
    
    const [removed] = this.queue.splice(fromIndex, 1);
    this.queue.splice(toIndex, 0, removed);
    return true;
  }
}

module.exports = QueueManager;

