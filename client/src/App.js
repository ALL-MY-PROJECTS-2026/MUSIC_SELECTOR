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
  const [hasControl, setHasControl] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    // localStorage에서 테마 설정 불러오기 (기본값: 다크모드)
    const savedTheme = localStorage.getItem('theme');
    return savedTheme ? savedTheme === 'dark' : true;
  });

  // 테마 변경 시 localStorage에 저장 및 body 클래스 업데이트
  useEffect(() => {
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    document.body.className = isDarkMode ? 'dark-mode' : 'light-mode';
  }, [isDarkMode]);

  // 초기 테마 적용
  useEffect(() => {
    document.body.className = isDarkMode ? 'dark-mode' : 'light-mode';
  }, []);

  const toggleTheme = () => {
    setIsDarkMode(prev => !prev);
  };

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
      setHasControl(data.hasControl || false);
    });

    // 제어권 상태 업데이트
    socket.on('controlStatus', (data) => {
      setHasControl(data.hasControl || false);
    });

    // 제어권 가져오기 성공
    socket.on('controlGranted', (data) => {
      setHasControl(true);
      if (data.message) {
        alert(data.message);
      }
    });

    // 제어권 빼앗김
    socket.on('controlTaken', (data) => {
      setHasControl(false);
      if (data.message) {
        alert(data.message);
      }
    });

    // 일괄 해제 완료
    socket.on('allClientsDisconnected', (data) => {
      if (data.count !== undefined) {
        alert(`${data.count}개의 클라이언트 연결이 해제되었습니다.`);
      }
    });

    // 음악 재생 중
    socket.on('musicPlaying', (music) => {
      console.log('musicPlaying 이벤트 수신:', music);
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

    // musicEnded 이벤트 수신 확인 (서버에서 전송)
    socket.on('musicEndedReceived', (data) => {
      console.log('[App] 서버에서 musicEnded 이벤트 수신 확인:', data);
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
      socket.off('musicEndedReceived');
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
    console.log('다음 음악 재생 버튼 클릭', { isAdmin, hasControl });
    if (isAdmin && hasControl) {
      socket.emit('playNext');
    } else {
      console.warn('제어권이 없어 다음 음악 재생 불가', { isAdmin, hasControl });
    }
  };

  const handlePauseMusic = () => {
    socket.emit('pauseMusic');
  };

  const handleResumeMusic = () => {
    socket.emit('resumeMusic');
  };

  const handleRemoveFromQueue = (musicId) => {
    socket.emit('removeFromQueue', musicId);
  };

  const handleReorderQueue = (fromIndex, toIndex) => {
    if (isAdmin && hasControl) {
      socket.emit('reorderQueue', { fromIndex, toIndex });
    }
  };

  const handleRequestControl = () => {
    if (window.confirm('제어권을 가져오시겠습니까? 현재 제어권을 가진 세션에서 제어권이 이전됩니다.')) {
      socket.emit('requestControl');
    }
  };

  return (
    <div className="App">
      <div className="container">
        <header className="header">
          <h1>Music Selector</h1>
          <div className="header-right">
            {isAdmin && (
              <>
                <div className={`control-status ${hasControl ? 'has-control' : 'no-control'}`}>
                  {hasControl ? '제어권 있음' : '제어권 없음'}
                </div>
                {!hasControl && (
                  <button onClick={handleRequestControl} className="request-control-btn">
                    제어권 가져오기
                  </button>
                )}
              </>
            )}
            <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
              {isConnected ? '연결됨' : '연결 끊김'}
            </div>
            <button 
              onClick={toggleTheme} 
              className="theme-toggle-btn"
              title={isDarkMode ? '라이트 모드로 전환' : '다크 모드로 전환'}
            >
              <span className="material-icons">{isDarkMode ? 'light_mode' : 'dark_mode'}</span>
            </button>
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
              onPause={handlePauseMusic}
              onResume={handleResumeMusic}
              isAdmin={isAdmin}
              hasControl={hasControl}
            />
          </div>

          <div className="right-panel">
            <QueueList 
              queue={queue} 
              onRemove={handleRemoveFromQueue}
              onReorder={handleReorderQueue}
              isAdmin={isAdmin}
              hasControl={hasControl}
            />
            <ClientList 
              socket={socket}
              isAdmin={isAdmin}
              hasControl={hasControl}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

