const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const QueueManager = require('./services/queueManager');
const YoutubeService = require('./services/youtubeService');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // 모든 origin 허용 (프로덕션에서는 특정 도메인으로 제한 권장)
    methods: ["GET", "POST"]
  }
});

app.use(cors({
  origin: "*" // 모든 origin 허용
}));
app.use(express.json());

// 서비스 초기화
const queueManager = new QueueManager();
const youtubeService = new YoutubeService();

// 현재 재생 중인 음악 상태
let currentPlaying = null;
let isPlaying = false;
let playStartTime = null; // 재생 시작 시간
let musicDuration = null; // 음악 재생 시간 (초)
let autoPlayTimer = null; // 자동 재생 타이머
let isProcessingNext = false; // 다음 곡 처리 중 플래그 (중복 방지)

// 연결된 클라이언트 관리
const connectedClients = new Map(); // socketId -> clientInfo

// Socket.io 연결 처리
io.on('connection', (socket) => {
  console.log('새 클라이언트 연결:', socket.id);
  
  // 클라이언트 IP 확인 (여러 방법 시도)
  const clientIP = socket.handshake.address || 
                   socket.request.connection?.remoteAddress ||
                   socket.request.socket?.remoteAddress ||
                   socket.conn?.remoteAddress;
  
  // Host 헤더 확인
  const hostHeader = socket.handshake.headers.host || '';
  const referer = socket.handshake.headers.referer || '';
  
  // localhost 여부 확인
  const isLocalhost = clientIP === '127.0.0.1' || 
                      clientIP === '::1' || 
                      clientIP === '::ffff:127.0.0.1' ||
                      clientIP?.includes('127.0.0.1') ||
                      hostHeader.includes('localhost') ||
                      hostHeader.includes('127.0.0.1') ||
                      referer.includes('localhost') ||
                      referer.includes('127.0.0.1');
  
  // 관리자 권한 확인 (localhost 접속만 관리자)
  const isAdmin = isLocalhost;
  
  console.log(`클라이언트 IP: ${clientIP}, Host: ${hostHeader}, 관리자: ${isAdmin}`);

  // 클라이언트 정보 저장
  const clientInfo = {
    socketId: socket.id,
    ip: clientIP,
    host: hostHeader,
    referer: referer,
    isAdmin: isAdmin,
    connectedAt: new Date().toISOString(),
    userAgent: socket.handshake.headers['user-agent'] || '알 수 없음'
  };
  connectedClients.set(socket.id, clientInfo);

  // 관리자에게 클라이언트 목록 업데이트 전송
  broadcastClientList();

  // 클라이언트에게 현재 상태 및 권한 전송
  socket.emit('currentState', {
    currentPlaying,
    queue: queueManager.getQueue(),
    isPlaying,
    isAdmin: isAdmin
  });

  // 음악 검색 이벤트 (검색 결과만 반환)
  socket.on('searchMusic', async (data) => {
    try {
      const { query } = data;
      console.log(`음악 검색: ${query}`);

      // 유튜브에서 검색 (여러 결과 반환)
      const searchResults = await youtubeService.search(query, 5);
      
      if (!searchResults || searchResults.length === 0) {
        socket.emit('searchResults', { results: [] });
        socket.emit('error', { message: '검색 결과가 없습니다.' });
        return;
      }

      // 검색 결과 전송
      socket.emit('searchResults', { results: searchResults });
      console.log(`검색 결과 ${searchResults.length}개 반환`);
    } catch (error) {
      console.error('음악 검색 오류:', error);
      socket.emit('searchResults', { results: [] });
      socket.emit('error', { message: '음악 검색 중 오류가 발생했습니다.' });
    }
  });

  // 음악 요청 이벤트 (선택한 음악을 대기열에 추가)
  socket.on('requestMusic', async (data) => {
    try {
      const { musicData, requestedBy } = data;
      console.log(`음악 요청: ${musicData.title} (요청자: ${requestedBy || socket.id})`);

      // 대기열에 추가
      const musicItem = {
        id: Date.now().toString(),
        title: musicData.title,
        thumbnail: musicData.thumbnail,
        videoId: musicData.videoId,
        requestedBy: requestedBy || socket.id,
        timestamp: Date.now(),
        duration: musicData.duration || null
      };

      queueManager.addToQueue(musicItem);

      // 모든 클라이언트에게 대기열 업데이트 전송
      io.emit('queueUpdated', queueManager.getQueue());

      // 현재 재생 중이 아니면 즉시 재생
      if (!isPlaying) {
        playNextMusic();
      }

      socket.emit('musicAdded', { message: '음악이 대기열에 추가되었습니다.' });
    } catch (error) {
      console.error('음악 요청 오류:', error);
      socket.emit('error', { message: '음악 요청 중 오류가 발생했습니다.' });
    }
  });

  // 재생 시작 요청
  socket.on('playMusic', (musicId) => {
    const music = queueManager.getMusicById(musicId);
    if (music) {
      startPlaying(music);
    }
  });

  // 재생 종료 알림 (클라이언트에서 감지)
  socket.on('musicEnded', () => {
    if (!isProcessingNext && isPlaying && currentPlaying) {
      console.log(`음악 재생 종료 감지 - 다음 곡 자동 재생 (클라이언트: ${socket.id.slice(0, 8)})`);
      isProcessingNext = true;
      
      // 타이머 정리
      if (autoPlayTimer) {
        clearTimeout(autoPlayTimer);
        autoPlayTimer = null;
      }
      
      // 다음 곡 재생
      setTimeout(() => {
        playNextMusic();
        isProcessingNext = false;
      }, 500); // 0.5초 후 재생 (부드러운 전환)
    } else {
      // 이미 처리 중이거나 재생 중이 아니면 무시
      console.log(`음악 재생 종료 알림 무시 (이미 처리 중 또는 재생 중 아님)`);
    }
  });

  // 재생 중지 요청 (관리자만 가능)
  socket.on('pauseMusic', () => {
    if (isAdmin) {
      isPlaying = false;
      io.emit('musicPaused');
      console.log('음악 일시정지 (관리자)');
    } else {
      socket.emit('error', { message: '권한이 없습니다. 서버에서만 재생 제어가 가능합니다.' });
    }
  });

  // 재생 시작 요청 (관리자만 가능)
  socket.on('resumeMusic', () => {
    if (isAdmin) {
      if (currentPlaying) {
        isPlaying = true;
        io.emit('musicResumed', currentPlaying);
        console.log('음악 재생 재개 (관리자)');
      }
    } else {
      socket.emit('error', { message: '권한이 없습니다. 서버에서만 재생 제어가 가능합니다.' });
    }
  });

  // 다음 음악 재생 요청 (관리자만 가능)
  socket.on('playNext', () => {
    if (isAdmin) {
      playNextMusic();
    } else {
      socket.emit('error', { message: '권한이 없습니다. 서버에서만 다음 음악 재생이 가능합니다.' });
    }
  });

  // 대기열에서 삭제 (관리자만 가능)
  socket.on('removeFromQueue', (musicId) => {
    if (isAdmin) {
      queueManager.removeFromQueue(musicId);
      io.emit('queueUpdated', queueManager.getQueue());
      console.log(`대기열에서 제거됨 (관리자): ${musicId}`);
    } else {
      socket.emit('error', { message: '권한이 없습니다. 서버에서만 대기열 삭제가 가능합니다.' });
    }
  });

  // 클라이언트 목록 조회 (관리자만 가능)
  socket.on('getClientList', () => {
    if (isAdmin) {
      const clientList = Array.from(connectedClients.values());
      socket.emit('clientList', clientList);
    } else {
      socket.emit('error', { message: '권한이 없습니다.' });
    }
  });

  // 클라이언트 강제 연결 해제 (관리자만 가능)
  socket.on('disconnectClient', (targetSocketId) => {
    if (isAdmin) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.disconnect(true);
        connectedClients.delete(targetSocketId);
        console.log(`클라이언트 강제 연결 해제: ${targetSocketId} (관리자)`);
        broadcastClientList();
        socket.emit('clientDisconnected', { socketId: targetSocketId });
      } else {
        socket.emit('error', { message: '해당 클라이언트를 찾을 수 없습니다.' });
      }
    } else {
      socket.emit('error', { message: '권한이 없습니다.' });
    }
  });

  // 연결 해제
  socket.on('disconnect', () => {
    console.log('클라이언트 연결 해제:', socket.id);
    connectedClients.delete(socket.id);
    broadcastClientList();
  });
});

// 재생 시작 함수
function startPlaying(music) {
  // 이전 타이머 정리
  if (autoPlayTimer) {
    clearTimeout(autoPlayTimer);
    autoPlayTimer = null;
  }
  
  currentPlaying = music;
  isPlaying = true;
  isProcessingNext = false;
  playStartTime = Date.now();
  
  // 재생 시간 파싱 (예: "3:45" -> 225초)
  if (music.duration && typeof music.duration === 'string') {
    const parts = music.duration.split(':');
    if (parts.length === 2) {
      musicDuration = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    } else if (parts.length === 3) {
      musicDuration = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    } else {
      musicDuration = null;
    }
  } else {
    musicDuration = null;
  }
  
  // 모든 클라이언트에 재생 신호 전송
  io.emit('musicPlaying', {
    ...currentPlaying,
    playStartTime: playStartTime
  });
  
  console.log(`재생 시작: ${currentPlaying.title} (재생 시간: ${musicDuration ? musicDuration + '초' : '알 수 없음'})`);
  
  // 재생 시간이 있으면 자동으로 다음 곡 재생 (백업용 - 클라이언트에서 감지 실패 시)
  if (musicDuration && musicDuration > 0) {
    autoPlayTimer = setTimeout(() => {
      if (currentPlaying && currentPlaying.id === music.id && isPlaying && !isProcessingNext) {
        console.log('자동 재생 시간 초과 - 다음 곡 재생 (백업)');
        isProcessingNext = true;
        playNextMusic();
        isProcessingNext = false;
      }
    }, (musicDuration + 3) * 1000); // 3초 여유 (클라이언트 감지보다 늦게)
  }
}

// 다음 음악 재생 함수
function playNextMusic() {
  // 타이머 정리
  if (autoPlayTimer) {
    clearTimeout(autoPlayTimer);
    autoPlayTimer = null;
  }
  
  const nextMusic = queueManager.getNextMusic();
  
  if (nextMusic) {
    queueManager.removeFromQueue(nextMusic.id);
    startPlaying(nextMusic);
    io.emit('queueUpdated', queueManager.getQueue());
    console.log(`다음 곡으로 전환: ${nextMusic.title}`);
  } else {
    currentPlaying = null;
    isPlaying = false;
    playStartTime = null;
    musicDuration = null;
    isProcessingNext = false;
    io.emit('musicStopped');
    io.emit('queueUpdated', queueManager.getQueue());
    console.log('재생할 음악이 없습니다.');
  }
}

// 관리자에게 클라이언트 목록 브로드캐스트
function broadcastClientList() {
  const clientList = Array.from(connectedClients.values());
  // 모든 관리자에게 클라이언트 목록 전송
  io.sockets.sockets.forEach((sock) => {
    const clientInfo = connectedClients.get(sock.id);
    if (clientInfo && clientInfo.isAdmin) {
      sock.emit('clientList', clientList);
    }
  });
}

// 서버 시작
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0'; // 모든 네트워크 인터페이스에서 접속 가능

server.listen(PORT, HOST, () => {
  console.log(`서버가 ${HOST}:${PORT}에서 실행 중입니다.`);
  console.log(`로컬 접속: http://localhost:${PORT}`);
  console.log(`네트워크 접속: http://[서버IP]:${PORT}`);
});

