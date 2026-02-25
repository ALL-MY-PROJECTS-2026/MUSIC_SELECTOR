import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';
import MusicRequestForm from './components/MusicRequestForm';
import CurrentPlaying from './components/CurrentPlaying';
import QueueList from './components/QueueList';
import ClientList from './components/ClientList';

// 서버 주소 설정 (환경 변수 또는 현재 호스트 기반)
const getServerUrl = () => {
  // 환경 변수가 있으면 사용
  if (process.env.REACT_APP_SERVER_URL) {
    return process.env.REACT_APP_SERVER_URL;
  }
  
  // 현재 브라우저의 호스트와 포트를 사용하여 서버 주소 자동 감지
  const hostname = window.location.hostname;
  const protocol = window.location.protocol;
  
  // 개발 환경에서는 localhost:5000, 프로덕션에서는 같은 호스트의 5000 포트
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:5000';
  } else {
    // 다른 컴퓨터에서 접속하는 경우, 같은 호스트의 5000 포트 사용
    return `${protocol}//${hostname}:5000`;
  }
};

const socket = io(getServerUrl(), {
  transports: ['websocket', 'polling'], // 연결 방식
  reconnection: true, // 자동 재연결
  reconnectionDelay: 1000,
  reconnectionAttempts: 5
});

// 전역에서 socket 접근 가능하도록 설정 (YouTube API에서 사용)
window.socket = socket;

function App() {
  const [currentPlaying, setCurrentPlaying] = useState(null);
  const [queue, setQueue] = useState([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    // 연결 상태
    socket.on('connect', () => {
      console.log('서버에 연결되었습니다.');
      setIsConnected(true);
    });

    socket.on('disconnect', () => {
      console.log('서버 연결이 끊어졌습니다.');
      setIsConnected(false);
    });

    // 초기 상태 수신
    socket.on('currentState', (data) => {
      setCurrentPlaying(data.currentPlaying);
      setQueue(data.queue);
      setIsPlaying(data.isPlaying);
      setIsAdmin(data.isAdmin || false);
    });

    // 음악 재생 중
    socket.on('musicPlaying', (music) => {
      setCurrentPlaying(music);
      setIsPlaying(true);
    });

    // 음악 중지
    socket.on('musicStopped', () => {
      setCurrentPlaying(null);
      setIsPlaying(false);
    });

    // 음악 일시정지 (서버에서만 가능)
    socket.on('musicPaused', () => {
      setIsPlaying(false);
    });

    // 음악 재생 재개 (서버에서만 가능)
    socket.on('musicResumed', (music) => {
      setCurrentPlaying(music);
      setIsPlaying(true);
    });

    // 대기열 업데이트
    socket.on('queueUpdated', (updatedQueue) => {
      setQueue(updatedQueue);
    });

    // 에러 처리
    socket.on('error', (error) => {
      alert(error.message);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('currentState');
      socket.off('musicPlaying');
      socket.off('musicStopped');
      socket.off('queueUpdated');
      socket.off('error');
    };
  }, []);

  const handleSearchMusic = (query) => {
    socket.emit('searchMusic', {
      query
    });
  };

  const handleRequestMusic = (musicData) => {
    socket.emit('requestMusic', {
      musicData,
      requestedBy: `사용자 ${socket.id.slice(0, 6)}`
    });
  };

  const handlePlayNext = () => {
    socket.emit('playNext');
  };

  const handleRemoveFromQueue = (musicId) => {
    socket.emit('removeFromQueue', musicId);
  };

  return (
    <div className="App">
      <div className="container">
        <header className="header">
          <h1>음악 선곡기</h1>
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '연결됨' : '연결 끊김'}
          </div>
        </header>

        <div className="main-content">
          <div className="left-panel">
            <MusicRequestForm 
              onSearchMusic={handleSearchMusic}
              onRequestMusic={handleRequestMusic}
              socket={socket}
            />
            <CurrentPlaying 
              music={currentPlaying} 
              isPlaying={isPlaying}
              onPlayNext={handlePlayNext}
              isAdmin={isAdmin}
            />
          </div>

          <div className="right-panel">
            <QueueList 
              queue={queue} 
              onRemove={handleRemoveFromQueue}
              isAdmin={isAdmin}
            />
            <ClientList 
              socket={socket}
              isAdmin={isAdmin}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

