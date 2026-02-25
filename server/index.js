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

// 제어권 관리 (하나의 세션만 제어권 보유)
let controlSessionId = null; // 제어권을 가진 세션 ID

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
  
  // 제어권 확인 (관리자 중 첫 번째 접속자에게 제어권 부여)
  let hasControl = false;
  if (isAdmin) {
    if (!controlSessionId) {
      // 제어권이 없으면 이 세션에 부여
      controlSessionId = socket.id;
      hasControl = true;
      console.log(`제어권 부여: ${socket.id}`);
    } else if (controlSessionId === socket.id) {
      // 이미 제어권을 가진 세션이면 유지
      hasControl = true;
    } else {
      // 다른 세션이 제어권을 가지고 있으면 제어권 없음
      hasControl = false;
      console.log(`제어권 없음 (다른 세션이 제어 중): ${socket.id}`);
    }
  }
  
  console.log(`클라이언트 IP: ${clientIP}, Host: ${hostHeader}, 관리자: ${isAdmin}, 제어권: ${hasControl}`);

  // 클라이언트 정보 저장
  const clientInfo = {
    socketId: socket.id,
    ip: clientIP,
    host: hostHeader,
    referer: referer,
    isAdmin: isAdmin,
    hasControl: hasControl,
    connectedAt: new Date().toISOString(),
    userAgent: socket.handshake.headers['user-agent'] || '알 수 없음'
  };
  connectedClients.set(socket.id, clientInfo);

  // 관리자에게 클라이언트 목록 업데이트 전송
  broadcastClientList();

  // 모든 관리자에게 제어권 정보 브로드캐스트
  broadcastControlStatus();

  // 클라이언트에게 현재 상태 및 권한 전송
  socket.emit('currentState', {
    currentPlaying,
    queue: queueManager.getQueue(),
    isPlaying,
    isAdmin: isAdmin,
    hasControl: hasControl
  });

  // 음악 검색 이벤트 (검색 결과만 반환)
  socket.on('searchMusic', async (data) => {
    try {
      const { query } = data;
      console.log(`음악 검색: ${query}`);

      // 유튜브에서 검색 (페이징을 위해 더 많은 결과 반환)
      const searchResults = await youtubeService.search(query, 50);
      
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

      // 영상 재생 가능 여부 검증 (재생 시간도 함께 검증)
      const validation = await youtubeService.validateVideo(musicData.videoId, musicData.duration);
      
      if (!validation.valid) {
        console.log(`영상 검증 실패: ${musicData.videoId} - ${validation.reason}`);
        socket.emit('error', { 
          message: `영상을 추가할 수 없습니다: ${validation.reason}` 
        });
        return;
      }

      // 경고가 있으면 로그만 남기고 계속 진행
      if (validation.warning) {
        console.warn(`영상 검증 경고: ${musicData.videoId} - ${validation.warning}`);
      }

      // 검증된 제목 사용 (oEmbed에서 가져온 제목이 더 정확할 수 있음)
      const finalTitle = validation.title || musicData.title;

      // 대기열에 추가
      const musicItem = {
        id: Date.now().toString(),
        title: finalTitle,
        thumbnail: musicData.thumbnail,
        videoId: musicData.videoId,
        requestedBy: requestedBy || socket.id,
        timestamp: Date.now(),
        duration: musicData.duration || null
      };

      queueManager.addToQueue(musicItem);

      // 모든 클라이언트에게 대기열 업데이트 전송
      io.emit('queueUpdated', queueManager.getQueue());

      // 현재 재생 중이 아니면 자동으로 재생 시작
      if (!isPlaying) {
        console.log('현재 재생 중이 아니므로 대기열의 첫 번째 곡 자동 재생 시작');
        // playNextMusic을 호출하여 대기열의 첫 번째 곡 재생
        setTimeout(() => {
          playNextMusic();
        }, 100);
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
    console.log(`음악 재생 종료 감지 (클라이언트: ${socket.id.slice(0, 8)})`, { 
      isProcessingNext, 
      isPlaying, 
      currentPlaying: currentPlaying?.title,
      queueLength: queueManager.getQueue().length 
    });
    
    // 중복 처리 방지: 이미 처리 중이면 무시
    if (isProcessingNext) {
      console.log('이미 다음 곡 처리 중 - 무시');
      return;
    }
    
    // 대기열이 비어있으면 상태만 초기화
    const queue = queueManager.getQueue();
    if (queue.length === 0) {
      console.log('대기열이 비어있음 - 상태 초기화');
      isProcessingNext = false;
      currentPlaying = null;
      isPlaying = false;
      playStartTime = null;
      musicDuration = null;
      io.emit('musicStopped');
      io.emit('queueUpdated', queue);
      return;
    }
    
    // 대기열이 있으면 다음 곡 재생
    console.log(`다음 곡 자동 재생 시작 (대기열: ${queue.length}개)`);
    isProcessingNext = true;
    
    // 타이머 정리 (백업 타이머 취소)
    if (autoPlayTimer) {
      clearTimeout(autoPlayTimer);
      autoPlayTimer = null;
    }
    
    // 다음 곡 재생 (playNextMusic 내부에서 isProcessingNext 리셋)
    setTimeout(() => {
      playNextMusic();
    }, 500); // 0.5초 후 재생 (부드러운 전환)
  });

  // 재생 중지 요청 (제어권 있는 관리자만 가능)
  socket.on('pauseMusic', () => {
    if (isAdmin && controlSessionId === socket.id) {
      isPlaying = false;
      io.emit('musicPaused');
      console.log('음악 일시정지 (제어권 보유자)');
    } else {
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 재생 제어가 가능합니다.' });
    }
  });

  // 재생 시작 요청 (제어권 있는 관리자만 가능)
  socket.on('resumeMusic', () => {
    if (isAdmin && controlSessionId === socket.id) {
      if (currentPlaying) {
        isPlaying = true;
        io.emit('musicResumed', currentPlaying);
        console.log('음악 재생 재개 (제어권 보유자)');
      }
    } else {
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 재생 제어가 가능합니다.' });
    }
  });

  // 다음 음악 재생 요청 (제어권 있는 관리자만 가능)
  socket.on('playNext', () => {
    console.log(`다음 음악 재생 요청 받음`, { 
      socketId: socket.id.slice(0, 8), 
      isAdmin, 
      hasControl: controlSessionId === socket.id,
      controlSessionId: controlSessionId?.slice(0, 8)
    });
    
    if (isAdmin && controlSessionId === socket.id) {
      console.log(`다음 음악 재생 요청 승인 (제어권 보유자: ${socket.id.slice(0, 8)})`);
      playNextMusic();
    } else {
      console.log(`다음 음악 재생 요청 거부 (관리자: ${isAdmin}, 제어권: ${controlSessionId === socket.id})`);
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 다음 음악 재생이 가능합니다.' });
    }
  });

  // 대기열에서 삭제 (제어권 있는 관리자만 가능)
  socket.on('removeFromQueue', (musicId) => {
    if (isAdmin && controlSessionId === socket.id) {
      queueManager.removeFromQueue(musicId);
      io.emit('queueUpdated', queueManager.getQueue());
      console.log(`대기열에서 제거됨 (제어권 보유자): ${musicId}`);
    } else {
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 대기열 삭제가 가능합니다.' });
    }
  });

  // 대기열 순서 변경 (제어권 있는 관리자만 가능)
  socket.on('reorderQueue', (data) => {
    if (isAdmin && controlSessionId === socket.id) {
      const { fromIndex, toIndex } = data;
      const success = queueManager.reorderQueue(fromIndex, toIndex);
      if (success) {
        io.emit('queueUpdated', queueManager.getQueue());
        console.log(`대기열 순서 변경: ${fromIndex} -> ${toIndex} (제어권 보유자)`);
      } else {
        socket.emit('error', { message: '대기열 순서 변경에 실패했습니다.' });
      }
    } else {
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 대기열 순서 변경이 가능합니다.' });
    }
  });

  // 제어권 가져오기 요청 (관리자만 가능)
  socket.on('requestControl', () => {
    if (!isAdmin) {
      socket.emit('error', { message: '관리자만 제어권을 가져올 수 있습니다.' });
      return;
    }

    if (controlSessionId === socket.id) {
      socket.emit('error', { message: '이미 제어권을 가지고 있습니다.' });
      return;
    }

    // 제어권 이전
    if (controlSessionId) {
      const previousController = connectedClients.get(controlSessionId);
      if (previousController) {
        previousController.hasControl = false;
        const prevSocket = io.sockets.sockets.get(controlSessionId);
        if (prevSocket) {
          prevSocket.emit('controlStatus', { hasControl: false });
          prevSocket.emit('controlTaken', { message: '제어권이 다른 세션으로 이전되었습니다.' });
        }
      }
    }

    // 새 제어권 부여
    controlSessionId = socket.id;
    clientInfo.hasControl = true;
    socket.emit('controlStatus', { hasControl: true });
    socket.emit('controlGranted', { message: '제어권을 가져왔습니다.' });
    
    console.log(`제어권 이전: ${socket.id}`);
    
    // 모든 관리자에게 제어권 상태 업데이트
    broadcastControlStatus();
  });

  // 클라이언트 목록 조회 (관리자만 가능)
  socket.on('getClientList', () => {
    if (isAdmin) {
      // 각 클라이언트에 hasControl 정보 추가
      const clientList = Array.from(connectedClients.values()).map(clientInfo => ({
        ...clientInfo,
        hasControl: controlSessionId === clientInfo.socketId
      }));
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

  // 일괄 연결 해제 (제어권 있는 관리자만 가능, 제어권 있는 세션 제외 - 관리자 포함 모두 해제)
  socket.on('disconnectAllExceptController', () => {
    console.log(`일괄 해제 요청 (요청자: ${socket.id.slice(0, 8)}, 관리자: ${isAdmin}, 제어권: ${controlSessionId === socket.id})`);
    
    if (isAdmin && controlSessionId === socket.id) {
      let disconnectedCount = 0;
      let adminDisconnectedCount = 0;
      let userDisconnectedCount = 0;
      const clientsToDisconnect = [];
      
      // 제어권 있는 세션을 제외한 모든 클라이언트 수집 (관리자 포함)
      connectedClients.forEach((clientInfo, socketId) => {
        // 제어권 있는 세션만 제외하고 나머지는 모두 해제 (관리자든 일반 사용자든)
        if (socketId !== controlSessionId) {
          clientsToDisconnect.push({ socketId, clientInfo });
        }
      });
      
      console.log(`해제 대상: ${clientsToDisconnect.length}개 (제어권 보유자: ${controlSessionId?.slice(0, 8)} 제외)`);
      
      // 일괄 해제 (관리자 포함 모두 해제)
      clientsToDisconnect.forEach(({ socketId, clientInfo }) => {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          const isAdminClient = clientInfo?.isAdmin || false;
          targetSocket.disconnect(true);
          connectedClients.delete(socketId);
          disconnectedCount++;
          if (isAdminClient) {
            adminDisconnectedCount++;
          } else {
            userDisconnectedCount++;
          }
          console.log(`클라이언트 해제: ${socketId.slice(0, 8)} (${isAdminClient ? '관리자' : '사용자'})`);
        }
      });
      
      console.log(`일괄 연결 해제 완료: 총 ${disconnectedCount}개 해제됨 (관리자 ${adminDisconnectedCount}개, 사용자 ${userDisconnectedCount}개)`);
      console.log(`남은 세션: 제어권 보유자만 남음 (${controlSessionId?.slice(0, 8)})`);
      broadcastClientList();
      socket.emit('allClientsDisconnected', { count: disconnectedCount });
    } else {
      console.log(`일괄 해제 요청 거부 (권한 없음)`);
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 일괄 해제가 가능합니다.' });
    }
  });

  // 연결 해제
  socket.on('disconnect', () => {
    console.log('클라이언트 연결 해제:', socket.id);
    
    // 제어권을 가진 세션이 해제되면 제어권 해제
    if (controlSessionId === socket.id) {
      controlSessionId = null;
      console.log('제어권 해제됨 (세션 연결 해제)');
      
      // 다른 관리자 중 첫 번째에게 제어권 부여
      for (const [socketId, clientInfo] of connectedClients.entries()) {
        if (clientInfo.isAdmin && socketId !== socket.id) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket) {
            controlSessionId = socketId;
            clientInfo.hasControl = true;
            console.log(`제어권 이전: ${socketId}`);
            targetSocket.emit('controlStatus', { hasControl: true });
            break;
          }
        }
      }
      
      // 모든 관리자에게 제어권 상태 업데이트
      broadcastControlStatus();
    }
    
    connectedClients.delete(socket.id);
    broadcastClientList();
  });
});

// 재생 시작 함수
function startPlaying(music) {
  console.log('startPlaying 호출됨:', music ? music.title : 'null');
  
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
  const playData = {
    ...currentPlaying,
    playStartTime: playStartTime
  };
  console.log('musicPlaying 이벤트 전송:', playData);
  io.emit('musicPlaying', playData);
  
  console.log(`재생 시작: ${currentPlaying.title} (재생 시간: ${musicDuration ? musicDuration + '초' : '알 수 없음'})`);
  
  // 재생 시간이 있으면 자동으로 다음 곡 재생 (백업용 - 클라이언트에서 감지 실패 시)
  if (musicDuration && musicDuration > 0) {
    autoPlayTimer = setTimeout(() => {
      // 중복 처리 방지: 이미 처리 중이거나 다른 곡이 재생 중이면 무시
      if (!isProcessingNext && currentPlaying && currentPlaying.id === music.id && isPlaying) {
        console.log('자동 재생 시간 초과 - 다음 곡 재생 (백업)');
        isProcessingNext = true;
        // playNextMusic 내부에서 isProcessingNext 리셋
        playNextMusic();
      } else {
        // 이미 처리되었거나 다른 곡이 재생 중이면 타이머만 정리
        console.log('백업 타이머 무시 (이미 처리됨 또는 다른 곡 재생 중)');
      }
    }, (musicDuration + 3) * 1000); // 3초 여유 (클라이언트 감지보다 늦게)
  }
}

// 다음 음악 재생 함수
function playNextMusic() {
  const queue = queueManager.getQueue();
  console.log('playNextMusic 호출됨', { isProcessingNext, currentPlaying: currentPlaying?.title, queueLength: queue.length });
  
  // 중복 호출 방지: 이미 처리 중이면 무시
  if (isProcessingNext) {
    console.log('playNextMusic 중복 호출 방지 (이미 처리 중)');
    return;
  }
  
  // 플래그 설정 (중복 방지)
  isProcessingNext = true;
  
  // 타이머 정리 (백업 타이머 취소)
  if (autoPlayTimer) {
    clearTimeout(autoPlayTimer);
    autoPlayTimer = null;
  }
  
  console.log('현재 대기열:', queue.map(m => m.title));
  const nextMusic = queueManager.getNextMusic();
  console.log('다음 음악:', nextMusic ? nextMusic.title : '없음');
  
  if (nextMusic) {
    queueManager.removeFromQueue(nextMusic.id);
    console.log('대기열에서 제거 후:', queueManager.getQueue().map(m => m.title));
    startPlaying(nextMusic); // startPlaying 내부에서 isProcessingNext = false로 리셋
    io.emit('queueUpdated', queueManager.getQueue());
    console.log(`다음 곡으로 전환: ${nextMusic.title}`);
  } else {
    // 재생할 음악이 없으면 상태 초기화
    console.log('재생할 음악이 없어서 상태 초기화');
    currentPlaying = null;
    isPlaying = false;
    playStartTime = null;
    musicDuration = null;
    isProcessingNext = false; // 플래그 리셋 (중요: 대기열에 곡이 추가되면 재생 가능하도록)
    io.emit('musicStopped');
    io.emit('queueUpdated', queueManager.getQueue());
    console.log('재생할 음악이 없습니다. 대기열에 곡이 추가되면 자동 재생됩니다.');
  }
}

  // 관리자에게 클라이언트 목록 브로드캐스트
function broadcastClientList() {
  // 각 클라이언트에 hasControl 정보 추가
  const clientList = Array.from(connectedClients.values()).map(clientInfo => ({
    ...clientInfo,
    hasControl: controlSessionId === clientInfo.socketId
  }));
  // 모든 관리자에게 클라이언트 목록 전송
  io.sockets.sockets.forEach((sock) => {
    const clientInfo = connectedClients.get(sock.id);
    if (clientInfo && clientInfo.isAdmin) {
      sock.emit('clientList', clientList);
    }
  });
}

// 모든 관리자에게 제어권 상태 브로드캐스트
function broadcastControlStatus() {
  io.sockets.sockets.forEach((sock) => {
    const clientInfo = connectedClients.get(sock.id);
    if (clientInfo && clientInfo.isAdmin) {
      const hasControl = controlSessionId === sock.id;
      clientInfo.hasControl = hasControl;
      sock.emit('controlStatus', { hasControl: hasControl });
    }
  });
}

// 서버 상태 초기화 함수
function initializeServer() {
  // 모든 연결된 클라이언트 초기화
  connectedClients.clear();
  
  // 제어권 초기화
  controlSessionId = null;
  
  // 재생 상태 초기화
  currentPlaying = null;
  isPlaying = false;
  playStartTime = null;
  musicDuration = null;
  isProcessingNext = false;
  
  // 타이머 정리
  if (autoPlayTimer) {
    clearTimeout(autoPlayTimer);
    autoPlayTimer = null;
  }
  
  // 대기열 초기화
  queueManager.clearQueue();
  
  console.log('서버 상태 초기화 완료');
}

// 서버 시작 전 초기화
initializeServer();

// 서버 시작
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0'; // 모든 네트워크 인터페이스에서 접속 가능

server.listen(PORT, HOST, () => {
  console.log(`서버가 ${HOST}:${PORT}에서 실행 중입니다.`);
  console.log(`로컬 접속: http://localhost:${PORT}`);
  console.log(`네트워크 접속: http://[서버IP]:${PORT}`);
  console.log('모든 세션 및 상태가 초기화되었습니다.');
});

