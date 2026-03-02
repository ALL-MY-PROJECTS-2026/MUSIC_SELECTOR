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
let currentPlaybackPosition = null; // 현재 재생 위치 (초 단위)
let playbackPositionTimer = null; // 재생 위치 브로드캐스트 타이머

// 연결된 클라이언트 관리
const connectedClients = new Map(); // socketId -> clientInfo

// 제어권 관리 (하나의 세션만 제어권 보유)
let controlSessionId = null; // 제어권을 가진 세션 ID (브라우저 세션 ID)
let controlSocketId = null; // 제어권을 가진 socket.id (현재 연결된 소켓)

// 세션 ID와 socket.id 매핑 관리
const sessionToSocketMap = new Map(); // sessionId -> socketId
const socketToSessionMap = new Map(); // socketId -> sessionId

// 제어권 확인 헬퍼 함수 (socket.id로 제어권 확인)
const hasControlBySocketId = (socketId) => {
  const sessionId = socketToSessionMap.get(socketId);
  return sessionId && controlSessionId === sessionId && controlSocketId === socketId;
};

// 좋아요 데이터 저장소
const musicLikes = new Map(); // videoId -> { title, count, likedSessions: Set }

// 관리자 패스워드 (환경 변수 또는 기본값)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

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
  
  // 관리자 권한 확인 (기본적으로 false, 인증 후 true로 변경)
  const isAdmin = false;
  
  // 제어권 확인 (기본적으로 제어권 없음, 인증 후 부여)
  const hasControl = false;
  
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
  
  // 재생 중이고 재생 위치가 있으면 새 클라이언트에게 즉시 재생 위치 전송
  if (isPlaying && currentPlaybackPosition && currentPlaying && 
      currentPlaybackPosition.videoId === currentPlaying.videoId) {
    // 네트워크 지연 보정
    const delay = Date.now() - currentPlaybackPosition.timestamp;
    const adjustedPosition = currentPlaybackPosition.position + (delay / 1000);
    
    socket.emit('playbackPositionUpdate', {
      videoId: currentPlaybackPosition.videoId,
      position: adjustedPosition,
      timestamp: Date.now()
    });
  }

  // 재연결 시 자동 재생 체크 (제어권 부여 후)
  // 인증 후에만 자동 재생 체크 (현재는 제어권이 없으므로 스킵)
  // 인증 성공 후 재연결 시 자동 재생은 authenticate 이벤트에서 처리

  // 세션 ID 등록 (새로고침 후 제어권 복원을 위해)
  socket.on('registerSession', (data) => {
    const { sessionId } = data;
    if (!sessionId) {
      console.log('세션 ID가 제공되지 않음:', socket.id);
      return;
    }
    
    console.log(`세션 ID 등록: ${sessionId} -> ${socket.id}`);
    
    // 이전 socket.id 매핑 제거 (같은 세션이 재연결된 경우)
    const oldSocketId = sessionToSocketMap.get(sessionId);
    if (oldSocketId && oldSocketId !== socket.id) {
      socketToSessionMap.delete(oldSocketId);
      const oldClientInfo = connectedClients.get(oldSocketId);
      if (oldClientInfo) {
        oldClientInfo.hasControl = false;
      }
    }
    
    // 새 매핑 저장
    sessionToSocketMap.set(sessionId, socket.id);
    socketToSessionMap.set(socket.id, sessionId);
    clientInfo.sessionId = sessionId;
    
    // 이전에 제어권을 가진 세션이면 제어권 복원
    if (controlSessionId === sessionId) {
      console.log(`제어권 복원: ${sessionId} (socket.id: ${socket.id})`);
      controlSocketId = socket.id;
      clientInfo.hasControl = true;
      clientInfo.isAdmin = true; // 제어권이 있으면 관리자 권한도 복원
      
      socket.emit('currentState', {
        currentPlaying,
        queue: queueManager.getQueue(),
        isPlaying,
        isAdmin: true,
        hasControl: true
      });
      socket.emit('controlStatus', { hasControl: true });
      socket.emit('authenticationSuccess', {
        message: '제어권이 복원되었습니다.',
        hasControl: true,
        isAdmin: true
      });
      
      // 모든 관리자에게 제어권 상태 업데이트
      broadcastControlStatus();
      broadcastClientList();
    }
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
      const { musicData, requestedBy, fromPlaylist, isFirstInPlaylist, isAIRecommendation } = data;
      console.log(`음악 요청: ${musicData.title} (요청자: ${requestedBy || socket.id}, 플레이리스트: ${fromPlaylist}, 첫번째: ${isFirstInPlaylist}, AI추천: ${isAIRecommendation || false})`);

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
        duration: musicData.duration || null,
        isAIRecommendation: isAIRecommendation || false // AI 추천 여부 추가
      };

      queueManager.addToQueue(musicItem);

      // 모든 클라이언트에게 대기열 업데이트 전송
      io.emit('queueUpdated', queueManager.getQueue());

      // 제어권이 있을 때만 자동 재생 시도
      // 제어권이 없어도 음악 신청은 가능 (대기열에만 추가)
      const hasControlForPlay = !!controlSessionId;
      // 유휴 상태 체크: 재생 중이 아니고 현재 재생 중인 음악도 없을 때만 (정지 상태 제외)
      const isIdle = !isPlaying && !currentPlaying;
      
      console.log('[requestMusic] 음악 추가 완료, 재생 조건 확인:', {
        isPlaying,
        hasCurrentPlaying: !!currentPlaying,
        hasControl: hasControlForPlay,
        controlSessionId: controlSessionId,
        isIdle,
        isProcessingNext,
        queueLength: queueManager.getQueue().length,
        fromPlaylist: fromPlaylist,
        isFirstInPlaylist: isFirstInPlaylist
      });
      
      // 플레이리스트에서 온 요청이고 첫 번째 노래가 아니면 무조건 대기열에만 추가
      if (fromPlaylist && !isFirstInPlaylist) {
        console.log('[requestMusic] 플레이리스트의 나머지 노래 - 대기열에만 추가 (자동 재생하지 않음)');
        socket.emit('musicAdded', { message: '음악이 대기열에 추가되었습니다.' });
        return;
      }
      
      // 제어권이 있고 유휴 상태일 때만 자동 재생
      if (isIdle && hasControlForPlay) {
        console.log('[requestMusic] 유휴 상태 + 제어권 있음 - 즉시 재생 시작');
        // isProcessingNext가 true인 경우 리셋 (유휴 상태에서는 false여야 함)
        if (isProcessingNext) {
          console.log('[requestMusic] 유휴 상태인데 isProcessingNext가 true - 리셋');
          isProcessingNext = false;
        }
        // playNextMusic을 호출하여 대기열의 첫 번째 곡 재생
        // 클라이언트 준비 시간을 확보하기 위해 지연 시간 증가
        console.log('[requestMusic] playNextMusic 호출 예약 (800ms 지연)');
        setTimeout(() => {
          console.log('[requestMusic] playNextMusic 호출 실행');
          playNextMusic();
        }, 800);
      } else if (isIdle && !hasControlForPlay) {
        console.log('[requestMusic] 유휴 상태이지만 제어권이 없어서 대기 중 (음악은 대기열에 추가됨)', {
          isPlaying,
          hasCurrentPlaying: !!currentPlaying,
          hasControl: hasControlForPlay,
          controlSessionId: controlSessionId,
          connectedClients: Array.from(connectedClients.keys()),
          adminClients: Array.from(connectedClients.values()).filter(c => c.isAdmin).map(c => ({ socketId: c.socketId, hasControl: c.hasControl }))
        });
      } else {
        console.log('[requestMusic] 현재 재생 중이므로 대기열에만 추가 (자동 재생하지 않음)', {
          isPlaying,
          hasCurrentPlaying: !!currentPlaying,
          currentPlayingTitle: currentPlaying?.title
        });
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

  // 재생 종료 알림 (클라이언트에서 감지) - 재생 불가능한 동영상 감지 시 즉시 처리
  // 매우 중요: 어떤 상태든 음악이 끝나면 무조건 다음 곡으로 넘어가야 함
  socket.on('musicEnded', () => {
    const receiveTime = Date.now();
    const elapsedSinceStart = playStartTime ? receiveTime - playStartTime : null;
    
    console.log(`[musicEnded] 음악 재생 종료 알림 수신 (클라이언트: ${socket.id.slice(0, 8)})`, {
      isProcessingNext,
      isPlaying,
      currentPlaying: currentPlaying?.title,
      currentPlayingId: currentPlaying?.id,
      queueLength: queueManager.getQueue().length,
      hasAutoTimer: !!autoPlayTimer,
      playStartTime: playStartTime,
      receiveTime: receiveTime,
      elapsedSinceStart: elapsedSinceStart,
      elapsedSeconds: elapsedSinceStart ? (elapsedSinceStart / 1000).toFixed(2) : null
    });
    
    // 재생 시작 직후 5초 이내의 musicEnded는 무시 (플레이어 초기화 중 발생할 수 있는 오탐)
    // musicPlaying 이벤트 전송 후 클라이언트가 플레이어를 생성하고 비디오를 로드하는데 시간이 필요
    const IGNORE_DURATION = 5000; // 5초로 증가 (3초 -> 5초)
    if (elapsedSinceStart !== null && elapsedSinceStart < IGNORE_DURATION) {
      console.log(`[musicEnded] ⚠️ 초기 musicEnded 무시 (재생 시작 후 ${(elapsedSinceStart / 1000).toFixed(2)}초 경과, ${IGNORE_DURATION / 1000}초 이내)`, {
        currentPlaying: currentPlaying?.title,
        currentPlayingId: currentPlaying?.id,
        elapsedSinceStart,
        elapsedSeconds: (elapsedSinceStart / 1000).toFixed(2),
        reason: '플레이어 초기화 중 오탐 가능성 - 클라이언트가 플레이어를 준비하는 시간 필요'
      });
      // 클라이언트에 무시됨을 알림
      socket.emit('musicEndedReceived', { 
        received: true,
        ignored: true,
        reason: `초기 재생 시작 후 ${IGNORE_DURATION / 1000}초 이내 musicEnded는 무시됩니다. (플레이어 초기화 중)`,
        elapsedSinceStart,
        elapsedSeconds: (elapsedSinceStart / 1000).toFixed(2)
      });
      return; // 무시하고 종료
    }
    
    // 클라이언트에 이벤트 수신 확인 전송
    socket.emit('musicEndedReceived', { 
      received: true,
      queueLength: queueManager.getQueue().length 
    });
    
    // 타이머 정리 (다음 곡 재생 전에 정리 - musicEnded는 실제 재생 종료이므로 우선 처리)
    if (autoPlayTimer) {
      console.log('[musicEnded] 기존 타이머 정리');
      clearTimeout(autoPlayTimer);
      autoPlayTimer = null;
    }
    
    // 매우 중요: 어떤 상태든 음악이 끝났으면 다음 곡으로 넘어가야 함
    // isProcessingNext가 true인 경우라도 실제 재생 종료이므로 무조건 리셋하고 진행
    // 이전 처리 중이던 것이 완료되지 않았거나 오류가 발생한 경우를 대비
    if (isProcessingNext) {
      console.log('[musicEnded] isProcessingNext가 true였지만 실제 재생 종료이므로 강제 리셋 후 다음 곡 재생');
    }
    // 무조건 리셋 (실제 재생 종료이므로)
    isProcessingNext = false;
    
    // 대기열이 비어있으면 상태만 초기화 (유휴 상태)
    const queue = queueManager.getQueue();
    if (queue.length === 0) {
      console.log('[musicEnded] 대기열이 비어있음 - 상태 초기화 (유휴 상태)');
      isProcessingNext = false;
      currentPlaying = null;
      isPlaying = false;
      playStartTime = null;
      musicDuration = null;
      io.emit('musicStopped');
      io.emit('queueUpdated', queue);
      return;
    }
    
    // 정지 상태에서는 다음 곡으로 넘어가지 않음
    if (!isPlaying) {
      console.log('[musicEnded] 정지 상태 - 다음 곡으로 넘어가지 않음', {
        isPlaying,
        currentPlaying: currentPlaying?.title,
        queueLength: queue.length
      });
      // 정지 상태에서는 musicEnded를 무시하고 종료
      return;
    }
    
    // 대기열이 있으면 즉시 다음 곡 재생 (음악이 끝나면 자동으로 다음 곡 재생)
    // 재생 중일 때만 다음 곡으로 넘어감
    console.log(`[musicEnded] 재생 종료 감지 - 즉시 다음 곡 재생 (대기열: ${queue.length}개)`);
    console.log(`[musicEnded] 대기열 내용:`, queue.map(m => ({ id: m.id, title: m.title })));
    
    // playNextMusic 내부에서 isProcessingNext를 설정하므로 여기서는 설정하지 않음
    // force=true로 호출하여 재생 중일 때만 다음 곡 재생
    console.log('[musicEnded] playNextMusic 호출 시작 (재생 중일 때만 실행, force=true)');
    try {
      playNextMusic(true); // force=true로 강제 실행
      console.log('[musicEnded] playNextMusic 호출 완료');
    } catch (error) {
      console.error('[musicEnded] playNextMusic 호출 오류:', error);
      // 오류 발생 시에도 isProcessingNext 리셋 보장
      isProcessingNext = false;
    }
  });

  // 재생 중지 요청 (제어권 있는 관리자만 가능)
  socket.on('pauseMusic', () => {
    const clientInfo = connectedClients.get(socket.id);
    if (clientInfo && clientInfo.isAdmin && hasControlBySocketId(socket.id)) {
      isPlaying = false;
      // 정지 시 타이머 취소 (정지 상태에서 시간이 지나도 다음 곡으로 넘어가지 않도록)
      if (autoPlayTimer) {
        console.log('[pauseMusic] 정지 요청 - 자동 재생 타이머 취소');
        clearTimeout(autoPlayTimer);
        autoPlayTimer = null;
      }
      // 정지 시 재생 위치 브로드캐스트 중지 (정지 상태에서 재생 시간이 진행되지 않도록)
      stopPlaybackPositionBroadcast();
      // 정지 시 playStartTime을 null로 설정하여 재생 시간이 진행되지 않도록 함
      // 재생 재개 시 현재 재생 위치를 기준으로 playStartTime을 다시 설정
      if (playStartTime && currentPlaybackPosition && currentPlaying) {
        // 정지 시점의 재생 위치 저장 (재생 재개 시 사용)
        const pausedPosition = currentPlaybackPosition.position;
        console.log('[pauseMusic] 정지 시점 재생 위치 저장:', pausedPosition, '초');
        // playStartTime을 null로 설정하여 재생 시간 진행 중지
        playStartTime = null;
      } else {
        playStartTime = null;
        console.log('[pauseMusic] playStartTime을 null로 설정 (재생 시간 진행 중지)');
      }
      io.emit('musicPaused');
      console.log('음악 일시정지 (제어권 보유자)');
    } else {
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 재생 제어가 가능합니다.' });
    }
  });

  // 재생 시작 요청 (제어권 있는 관리자만 가능)
  socket.on('resumeMusic', () => {
    const clientInfo = connectedClients.get(socket.id);
    if (clientInfo && clientInfo.isAdmin && hasControlBySocketId(socket.id)) {
      if (currentPlaying) {
        isPlaying = true;
        // 재생 재개 시 playStartTime을 현재 재생 위치를 기준으로 다시 설정
        // 클라이언트에서 전송한 재생 위치를 기준으로 playStartTime 계산
        if (currentPlaybackPosition && currentPlaybackPosition.videoId === currentPlaying.videoId) {
          // 현재 재생 위치를 기준으로 playStartTime 설정
          // playStartTime = 현재시간 - 재생위치(초)
          const currentPosition = currentPlaybackPosition.position;
          playStartTime = Date.now() - (currentPosition * 1000);
          console.log('[resumeMusic] 재생 재개 - playStartTime 재설정:', {
            currentPosition,
            playStartTime: new Date(playStartTime).toISOString(),
            calculatedFrom: 'currentPlaybackPosition'
          });
        } else {
          // 재생 위치 정보가 없으면 현재 시간을 기준으로 설정
          playStartTime = Date.now();
          console.log('[resumeMusic] 재생 재개 - playStartTime을 현재 시간으로 설정 (재생 위치 정보 없음)');
        }
        // 재생 위치 브로드캐스트 재시작
        startPlaybackPositionBroadcast();
        io.emit('musicResumed', currentPlaying);
        console.log('음악 재생 재개 (제어권 보유자)');
      }
    } else {
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 재생 제어가 가능합니다.' });
    }
  });

  // 재생 위치 업데이트 (제어권 있는 클라이언트에서만 수신)
  socket.on('updatePlaybackPosition', (data) => {
    const clientInfo = connectedClients.get(socket.id);
    // 제어권이 있는 클라이언트만 수신
    if (clientInfo && hasControlBySocketId(socket.id) && data && typeof data.position === 'number') {
      currentPlaybackPosition = {
        videoId: currentPlaying?.videoId,
        position: data.position,
        timestamp: Date.now()
      };
      // 로그는 너무 자주 출력되므로 주석 처리
      // console.log('[updatePlaybackPosition] 재생 위치 업데이트:', currentPlaybackPosition);
    }
  });

  // 재생 위치 seek 이벤트 (제어권 있는 클라이언트에서만 수신, 즉시 브로드캐스트)
  socket.on('seekPlaybackPosition', (data) => {
    const clientInfo = connectedClients.get(socket.id);
    // 제어권이 있는 클라이언트만 수신
    if (clientInfo && hasControlBySocketId(socket.id) && data && typeof data.position === 'number') {
      currentPlaybackPosition = {
        videoId: currentPlaying?.videoId,
        position: data.position,
        timestamp: data.timestamp || Date.now()
      };
      
      console.log('[seekPlaybackPosition] Seek 감지 - 즉시 브로드캐스트:', currentPlaybackPosition);
      
      // 3단계: 즉시 모든 클라이언트에게 브로드캐스트
      const delay = Date.now() - currentPlaybackPosition.timestamp;
      const adjustedPosition = currentPlaybackPosition.position + (delay / 1000);
      
      io.emit('playbackPositionSeek', {
        videoId: currentPlaybackPosition.videoId,
        position: adjustedPosition,
        timestamp: Date.now()
      });
    }
  });

  // 다음 음악 재생 요청 (제어권 있는 관리자만 가능)
  socket.on('playNext', () => {
    const clientInfo = connectedClients.get(socket.id);
    const isAdminUser = clientInfo && clientInfo.isAdmin;
    console.log(`다음 음악 재생 요청 받음`, { 
      socketId: socket.id.slice(0, 8), 
      isAdmin: isAdminUser, 
      hasControl: hasControlBySocketId(socket.id),
      controlSessionId: controlSessionId?.slice(0, 8)
    });
    
    if (isAdminUser && hasControlBySocketId(socket.id)) {
      console.log(`다음 음악 재생 요청 승인 (제어권 보유자: ${socket.id.slice(0, 8)})`);
      playNextMusic();
    } else {
      console.log(`다음 음악 재생 요청 거부 (관리자: ${isAdminUser}, 제어권: ${hasControlBySocketId(socket.id)})`);
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 다음 음악 재생이 가능합니다.' });
    }
  });

  // 대기열에서 삭제 (제어권 있는 관리자만 가능)
  socket.on('removeFromQueue', (musicId) => {
    const clientInfo = connectedClients.get(socket.id);
    if (clientInfo && clientInfo.isAdmin && hasControlBySocketId(socket.id)) {
      queueManager.removeFromQueue(musicId);
      io.emit('queueUpdated', queueManager.getQueue());
      console.log(`대기열에서 제거됨 (제어권 보유자): ${musicId}`);
    } else {
      socket.emit('error', { message: '제어권이 없습니다. 제어권을 가진 세션에서만 대기열 삭제가 가능합니다.' });
    }
  });

  // 대기열 순서 변경 (제어권 있는 관리자만 가능)
  socket.on('reorderQueue', (data) => {
    const clientInfo = connectedClients.get(socket.id);
    if (clientInfo && clientInfo.isAdmin && hasControlBySocketId(socket.id)) {
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

  // 패스워드 인증 요청
  socket.on('authenticate', (data) => {
    const { password } = data;
    const clientInfo = connectedClients.get(socket.id);
    
    if (!clientInfo) {
      socket.emit('authenticationFailed', { message: '클라이언트 정보를 찾을 수 없습니다.' });
      return;
    }
    
    if (password === ADMIN_PASSWORD) {
      // 인증 성공
      clientInfo.isAdmin = true;
      
      // 세션 ID 확인
      const sessionId = clientInfo.sessionId || socketToSessionMap.get(socket.id);
      
      // 제어권 이전 (다른 세션에서 제어권을 가지고 있으면 이전)
      if (controlSessionId && controlSessionId !== sessionId) {
        const prevSocketId = sessionToSocketMap.get(controlSessionId);
        if (prevSocketId) {
          const previousController = connectedClients.get(prevSocketId);
          if (previousController) {
            previousController.hasControl = false;
            const prevSocket = io.sockets.sockets.get(prevSocketId);
            if (prevSocket) {
              prevSocket.emit('controlStatus', { hasControl: false });
              prevSocket.emit('controlTaken', { 
                message: '다른 위치에서 인증이 완료되어 제어권이 이동되었습니다.' 
              });
            }
          }
        }
      }
      
      // 새 제어권 부여 (세션 ID로 관리)
      if (sessionId) {
        controlSessionId = sessionId;
        controlSocketId = socket.id;
        clientInfo.hasControl = true;
      } else {
        // 세션 ID가 없으면 socket.id를 세션 ID로 사용 (하위 호환성)
        controlSessionId = socket.id;
        controlSocketId = socket.id;
        clientInfo.hasControl = true;
      }
      
      socket.emit('authenticationSuccess', { 
        message: '인증이 완료되었습니다. 제어권을 획득했습니다.',
        hasControl: true,
        isAdmin: true
      });
      socket.emit('controlStatus', { hasControl: true });
      // controlGranted는 인증과 별도로 제어권만 가져올 때만 전송 (중복 방지)
      
      console.log(`인증 성공 및 제어권 부여: ${socket.id}`);
      
      // 모든 관리자에게 제어권 상태 업데이트
      broadcastControlStatus();
      broadcastClientList();
      
      // 제어권 획득 후 자동 재생 체크
      const queue = queueManager.getQueue();
      const isIdle = !isPlaying || !currentPlaying;
      
      console.log(`[authenticate] 제어권 획득 후 자동 재생 체크:`, {
        queueLength: queue.length,
        isPlaying,
        hasCurrentPlaying: !!currentPlaying,
        isIdle,
        isProcessingNext
      });
      
      // 대기열에 곡이 있고 유휴 상태이면 자동 재생
      if (queue.length > 0 && isIdle) {
        console.log(`[authenticate] 대기열에 곡이 있고 유휴 상태 - 자동 재생 시작`);
        // 약간의 지연을 두어 클라이언트가 상태를 받은 후 재생
        setTimeout(() => {
          playNextMusic();
        }, 500);
      } else if (queue.length > 0 && isPlaying && !currentPlaying) {
        // 재생 중이라고 표시되어 있지만 실제 재생 중인 곡이 없으면 재생
        console.log(`[authenticate] 상태 불일치 감지: isPlaying=true지만 currentPlaying=null - 자동 재생 시작`);
        setTimeout(() => {
          playNextMusic();
        }, 500);
      } else {
        console.log(`[authenticate] 자동 재생 조건 불만족:`, {
          queueLength: queue.length,
          isPlaying,
          hasCurrentPlaying: !!currentPlaying
        });
      }
    } else {
      // 인증 실패
      socket.emit('authenticationFailed', { 
        message: '패스워드가 올바르지 않습니다.' 
      });
      console.log(`인증 실패: ${socket.id}`);
    }
  });

  // 제어권 가져오기 요청 (관리자만 가능)
  socket.on('requestControl', () => {
    const clientInfo = connectedClients.get(socket.id);
    if (!clientInfo || !clientInfo.isAdmin) {
      socket.emit('error', { message: '관리자만 제어권을 가져올 수 있습니다.' });
      return;
    }

    // 세션 ID 확인
    const sessionId = clientInfo.sessionId || socketToSessionMap.get(socket.id);
    
    if (controlSessionId === sessionId && hasControlBySocketId(socket.id)) {
      socket.emit('error', { message: '이미 제어권을 가지고 있습니다.' });
      return;
    }

    // 제어권 이전
    if (controlSessionId) {
      const prevSocketId = sessionToSocketMap.get(controlSessionId);
      if (prevSocketId) {
        const previousController = connectedClients.get(prevSocketId);
        if (previousController) {
          previousController.hasControl = false;
          const prevSocket = io.sockets.sockets.get(prevSocketId);
          if (prevSocket) {
            prevSocket.emit('controlStatus', { hasControl: false });
            prevSocket.emit('controlTaken', { message: '제어권이 다른 세션으로 이전되었습니다.' });
          }
        }
      }
    }

    // 새 제어권 부여 (세션 ID로 관리)
    if (sessionId) {
      controlSessionId = sessionId;
      controlSocketId = socket.id;
      clientInfo.hasControl = true;
    } else {
      // 세션 ID가 없으면 socket.id를 세션 ID로 사용 (하위 호환성)
      controlSessionId = socket.id;
      controlSocketId = socket.id;
      clientInfo.hasControl = true;
    }
    socket.emit('controlStatus', { hasControl: true });
    socket.emit('controlGranted', { message: '제어권을 가져왔습니다.' });
    
    console.log(`[requestControl] 제어권 이전: ${socket.id}`);
    
    // 모든 관리자에게 제어권 상태 업데이트
    broadcastControlStatus();
    
    // 제어권 획득 후 자동 재생 체크
    const queue = queueManager.getQueue();
    const isIdle = !isPlaying || !currentPlaying;
    
    console.log(`[requestControl] 제어권 획득 후 자동 재생 체크:`, {
      queueLength: queue.length,
      isPlaying,
      hasCurrentPlaying: !!currentPlaying,
      isIdle,
      isProcessingNext
    });
    
    // 대기열에 곡이 있고 유휴 상태이면 자동 재생
    if (queue.length > 0 && isIdle) {
      console.log(`[requestControl] 대기열에 곡이 있고 유휴 상태 - 자동 재생 시작`);
      setTimeout(() => {
        playNextMusic();
      }, 500);
    }
  });

  // 플레이리스트 전송 요청 (제어권 보유 클라이언트로)
  socket.on('sendPlaylistToController', (data) => {
    try {
      const { playlists, fromSocketId } = data;
      
      console.log(`[sendPlaylistToController] 플레이리스트 전송 요청 수신:`, {
        fromSocketId: fromSocketId?.slice(0, 8),
        playlistCount: playlists?.length || 0,
        hasControlSession: !!controlSessionId
      });

      // 검증: 플레이리스트 데이터 유효성 확인
      if (!playlists || !Array.isArray(playlists) || playlists.length === 0) {
        socket.emit('playlistReceivedByServer', {
          success: false,
          message: '유효하지 않은 플레이리스트 데이터입니다.'
        });
        return;
      }

      // 제어권 보유 세션이 있는지 확인
      if (!controlSessionId) {
        socket.emit('playlistReceivedByServer', {
          success: false,
          message: '제어권을 가진 세션이 없습니다.'
        });
        return;
      }

      // 제어권 보유 클라이언트로 플레이리스트 전달
      const controllerSocketId = controlSocketId || sessionToSocketMap.get(controlSessionId);
      const controllerSocket = controllerSocketId ? io.sockets.sockets.get(controllerSocketId) : null;
      if (controllerSocket) {
        controllerSocket.emit('receivePlaylistFromClient', {
          playlists: playlists,
          fromSocketId: fromSocketId
        });
        
        // 전송 클라이언트에 성공 알림
        socket.emit('playlistReceivedByServer', {
          success: true,
          message: '플레이리스트가 제어권 보유자에게 전달되었습니다.'
        });
        
        console.log(`[sendPlaylistToController] 플레이리스트 전달 완료: ${controlSessionId.slice(0, 8)}`);
      } else {
        socket.emit('playlistReceivedByServer', {
          success: false,
          message: '제어권 보유 세션을 찾을 수 없습니다.'
        });
      }
    } catch (error) {
      console.error('[sendPlaylistToController] 오류:', error);
      socket.emit('playlistReceivedByServer', {
        success: false,
        message: '플레이리스트 전송 중 오류가 발생했습니다.'
      });
    }
  });

  // 플레이리스트 저장 완료 알림 (제어권 보유 클라이언트에서)
  socket.on('playlistSavedByController', (data) => {
    console.log('[playlistSavedByController] 플레이리스트 저장 완료:', data);
  });

  // 플레이리스트 거부 알림 (제어권 보유 클라이언트에서)
  socket.on('playlistRejectedByController', (data) => {
    console.log('[playlistRejectedByController] 플레이리스트 거부:', data);
  });

  // 클라이언트 목록 조회 (관리자만 가능)
  socket.on('getClientList', () => {
    const clientInfo = connectedClients.get(socket.id);
    if (clientInfo && clientInfo.isAdmin) {
      // 각 클라이언트에 hasControl 정보 추가
      const clientList = Array.from(connectedClients.values()).map(clientInfo => ({
        ...clientInfo,
        hasControl: hasControlBySocketId(clientInfo.socketId)
      }));
      socket.emit('clientList', clientList);
    } else {
      socket.emit('error', { message: '권한이 없습니다.' });
    }
  });

  // 클라이언트 강제 연결 해제 (관리자만 가능)
  socket.on('disconnectClient', (targetSocketId) => {
    const clientInfo = connectedClients.get(socket.id);
    if (clientInfo && clientInfo.isAdmin) {
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
    const clientInfo = connectedClients.get(socket.id);
    const isAdminUser = clientInfo && clientInfo.isAdmin;
    console.log(`일괄 해제 요청 (요청자: ${socket.id.slice(0, 8)}, 관리자: ${isAdminUser}, 제어권: ${hasControlBySocketId(socket.id)})`);
    
    if (isAdminUser && hasControlBySocketId(socket.id)) {
      let disconnectedCount = 0;
      let adminDisconnectedCount = 0;
      let userDisconnectedCount = 0;
      const clientsToDisconnect = [];
      
      // 제어권 있는 세션을 제외한 모든 클라이언트 수집 (관리자 포함)
      connectedClients.forEach((clientInfo, socketId) => {
        // 제어권 있는 세션만 제외하고 나머지는 모두 해제 (관리자든 일반 사용자든)
        if (!hasControlBySocketId(socketId)) {
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

  // 좋아요 이벤트 수신
  socket.on('likeMusic', (data) => {
    const { videoId, title, socketId } = data;
    
    if (!videoId || !title) {
      socket.emit('error', { message: '좋아요 요청에 필요한 정보가 없습니다.' });
      return;
    }
    
    // 좋아요 데이터 초기화 (없으면 생성)
    if (!musicLikes.has(videoId)) {
      musicLikes.set(videoId, {
        title: title,
        count: 0,
        likedSessions: new Set()
      });
    }
    
    const likeData = musicLikes.get(videoId);
    
    // 이미 좋아요를 눌렀는지 확인
    if (likeData.likedSessions.has(socketId)) {
      socket.emit('error', { message: '이미 좋아요를 눌렀습니다.' });
      return;
    }
    
    // 좋아요 추가
    likeData.likedSessions.add(socketId);
    likeData.count = likeData.likedSessions.size;
    
    console.log(`[likeMusic] 좋아요 추가: ${title} (videoId: ${videoId}, count: ${likeData.count})`);
    
    // 모든 클라이언트에 좋아요 업데이트 브로드캐스트
    io.emit('likeUpdated', {
      videoId: videoId,
      title: title,
      count: likeData.count
    });
  });
  
  // 좋아요 취소 이벤트 수신
  socket.on('unlikeMusic', (data) => {
    const { videoId, title, socketId } = data;
    
    if (!videoId) {
      socket.emit('error', { message: '좋아요 취소 요청에 필요한 정보가 없습니다.' });
      return;
    }
    
    const likeData = musicLikes.get(videoId);
    
    if (!likeData || !likeData.likedSessions.has(socketId)) {
      socket.emit('error', { message: '좋아요를 누르지 않은 노래입니다.' });
      return;
    }
    
    // 좋아요 제거
    likeData.likedSessions.delete(socketId);
    likeData.count = likeData.likedSessions.size;
    
    console.log(`[unlikeMusic] 좋아요 취소: ${title || videoId} (videoId: ${videoId}, count: ${likeData.count})`);
    
    // 모든 클라이언트에 좋아요 업데이트 브로드캐스트
    io.emit('likeUpdated', {
      videoId: videoId,
      title: title || likeData.title,
      count: likeData.count
    });
  });
  
  // 좋아요 개수 조회
  socket.on('getLikeCount', (videoId) => {
    if (!videoId) {
      socket.emit('error', { message: 'videoId가 필요합니다.' });
      return;
    }
    
    const likeData = musicLikes.get(videoId);
    const count = likeData ? likeData.count : 0;
    
    socket.emit('likeCount', {
      videoId: videoId,
      count: count
    });
  });
  
  // 세션별 좋아요 여부 확인
  socket.on('checkLiked', (videoId) => {
    if (!videoId) {
      socket.emit('error', { message: 'videoId가 필요합니다.' });
      return;
    }
    
    const likeData = musicLikes.get(videoId);
    const isLiked = likeData ? likeData.likedSessions.has(socket.id) : false;
    const count = likeData ? likeData.count : 0;
    
    socket.emit('likedStatus', {
      videoId: videoId,
      isLiked: isLiked,
      count: count
    });
  });

  // 연결 해제
  // ============================================
  // AI 추천 기능을 위한 이벤트 핸들러 (기존 코드와 독립적)
  // ============================================
  
  // 대기열 + 하트 데이터 제공
  socket.on('getQueueAndLikes', () => {
    try {
      const queueData = queueManager.getQueue();
      const likesData = {};
      
      // 현재 재생 중인 음악도 항상 포함 (대기열에 없으면 추가, 있으면 맨 앞으로 이동)
      let extendedQueue = [...queueData];
      if (currentPlaying) {
        // 현재 재생 중인 음악이 대기열에 있는지 확인
        const currentPlayingIndex = extendedQueue.findIndex(music => music.videoId === currentPlaying.videoId);
        
        if (currentPlayingIndex !== -1) {
          // 대기열에 있으면 맨 앞으로 이동
          extendedQueue.splice(currentPlayingIndex, 1);
          extendedQueue = [currentPlaying, ...extendedQueue];
          console.log('[getQueueAndLikes] 현재 재생 중인 음악을 맨 앞으로 이동:', currentPlaying.title);
        } else {
          // 대기열에 없으면 맨 앞에 추가
          extendedQueue = [currentPlaying, ...extendedQueue];
          console.log('[getQueueAndLikes] 현재 재생 중인 음악 포함 (대기열에 없음):', currentPlaying.title);
        }
      }
      
      // 각 음악의 좋아요 개수 조회 (대기열 + 현재 재생 중인 음악 모두 포함)
      extendedQueue.forEach(music => {
        const likeData = musicLikes.get(music.videoId);
        likesData[music.videoId] = likeData ? likeData.count : 0;
      });
      
      console.log(`[getQueueAndLikes] 확장된 대기열 반환: ${extendedQueue.length}개 (대기열: ${queueData.length}개, 현재 재생: ${currentPlaying ? 1 : 0}개)`);
      
      socket.emit('queueAndLikes', {
        queue: extendedQueue,
        musicLikes: likesData
      });
    } catch (error) {
      console.error('[getQueueAndLikes] 오류:', error);
      socket.emit('error', { message: '대기열 데이터 조회 실패' });
    }
  });

  // YouTube Data API 조회수 가져오기 (선택사항, API 키가 있을 때만 사용)
  socket.on('getVideoDetails', async (videoIds) => {
    try {
      // YouTube Data API 키가 없으면 폴백
      if (!process.env.YOUTUBE_API_KEY) {
        socket.emit('videoDetailsError', { 
          message: 'YouTube Data API 키가 설정되지 않았습니다. 검색 순서 기반 인기도를 사용합니다.' 
        });
        return;
      }

      // googleapis 패키지가 설치되어 있지 않으면 폴백
      let google;
      try {
        google = require('googleapis');
      } catch (err) {
        socket.emit('videoDetailsError', { 
          message: 'googleapis 패키지가 설치되지 않았습니다. 검색 순서 기반 인기도를 사용합니다.' 
        });
        return;
      }

      const youtube = google.youtube('v3');
      
      // 배치 처리 (최대 50개)
      const videoIdsBatch = Array.isArray(videoIds) ? videoIds.slice(0, 50) : [videoIds];
      
      const response = await youtube.videos.list({
        key: process.env.YOUTUBE_API_KEY,
        part: 'statistics,snippet,status',
        id: videoIdsBatch.join(',')
      });
      
      const details = response.data.items.map(item => ({
        videoId: item.id,
        viewCount: parseInt(item.statistics.viewCount || 0),
        publishedAt: item.snippet.publishedAt,
        // 재생 가능 여부 확인
        isPlayable: item.status && item.status.embeddable !== false && 
                   item.status.privacyStatus === 'public' &&
                   item.status.uploadStatus === 'processed'
      }));
      
      socket.emit('videoDetails', details);
    } catch (error) {
      console.error('[getVideoDetails] 오류:', error);
      // 폴백: 검색 순서 기반 사용
      socket.emit('videoDetailsError', { 
        message: 'YouTube Data API 호출 실패. 검색 순서 기반 인기도를 사용합니다.' 
      });
    }
  });

  // 재생 가능 여부 확인 (배치 처리)
  socket.on('checkVideoPlayability', async (videoIds) => {
    try {
      if (!process.env.YOUTUBE_API_KEY) {
        socket.emit('playabilityCheckError', { 
          message: 'YouTube Data API 키가 설정되지 않았습니다.' 
        });
        return;
      }

      let google;
      try {
        google = require('googleapis');
      } catch (err) {
        socket.emit('playabilityCheckError', { 
          message: 'googleapis 패키지가 설치되지 않았습니다.' 
        });
        return;
      }

      const youtube = google.youtube('v3');
      
      // 배치 처리 (최대 50개)
      const videoIdsBatch = Array.isArray(videoIds) ? videoIds.slice(0, 50) : [videoIds];
      
      const response = await youtube.videos.list({
        key: process.env.YOUTUBE_API_KEY,
        part: 'status',
        id: videoIdsBatch.join(',')
      });
      
      // 재생 가능 여부 확인 결과
      const playabilityResults = {};
      
      if (response.data.items) {
        response.data.items.forEach(item => {
          // 재생 가능 조건:
          // 1. embeddable이 true (또는 undefined - 기본값 true)
          // 2. privacyStatus가 'public'
          // 3. uploadStatus가 'processed'
          const isPlayable = item.status && 
                           item.status.embeddable !== false && 
                           item.status.privacyStatus === 'public' &&
                           item.status.uploadStatus === 'processed';
          
          playabilityResults[item.id] = {
            videoId: item.id,
            isPlayable: isPlayable,
            reason: isPlayable ? '재생 가능' : 
                   (item.status.privacyStatus !== 'public' ? '비공개 영상' :
                   (item.status.uploadStatus !== 'processed' ? '처리 중인 영상' :
                   (item.status.embeddable === false ? '임베드 불가능' : '알 수 없는 이유')))
          };
        });
      }
      
      // API에서 반환되지 않은 videoId는 재생 불가능으로 간주
      videoIdsBatch.forEach(videoId => {
        if (!playabilityResults[videoId]) {
          playabilityResults[videoId] = {
            videoId: videoId,
            isPlayable: false,
            reason: '영상을 찾을 수 없음 (삭제되었거나 존재하지 않음)'
          };
        }
      });
      
      socket.emit('playabilityCheckResults', playabilityResults);
    } catch (error) {
      console.error('[checkVideoPlayability] 오류:', error);
      socket.emit('playabilityCheckError', { 
        message: '재생 가능 여부 확인 실패: ' + error.message 
      });
    }
  });

  // 채널 정보 확인 (공식 채널 우선순위 확인용)
  socket.on('getChannelInfo', async (videoIds) => {
    try {
      if (!process.env.YOUTUBE_API_KEY) {
        socket.emit('channelInfoError', { 
          message: 'YouTube Data API 키가 설정되지 않았습니다.' 
        });
        return;
      }

      let google;
      try {
        google = require('googleapis');
      } catch (err) {
        socket.emit('channelInfoError', { 
          message: 'googleapis 패키지가 설치되지 않았습니다.' 
        });
        return;
      }

      const youtube = google.youtube('v3');
      
      // 배치 처리 (최대 50개)
      const videoIdsBatch = Array.isArray(videoIds) ? videoIds.slice(0, 50) : [videoIds];
      
      // 먼저 비디오 정보로 채널 ID 가져오기
      const videoResponse = await youtube.videos.list({
        key: process.env.YOUTUBE_API_KEY,
        part: 'snippet',
        id: videoIdsBatch.join(',')
      });
      
      const channelIds = [];
      const videoIdToChannelId = {};
      
      if (videoResponse.data.items) {
        videoResponse.data.items.forEach(item => {
          const channelId = item.snippet.channelId;
          if (channelId && !channelIds.includes(channelId)) {
            channelIds.push(channelId);
          }
          videoIdToChannelId[item.id] = channelId;
        });
      }
      
      if (channelIds.length === 0) {
        socket.emit('channelInfoResults', {});
        return;
      }
      
      // 채널 정보 가져오기
      const channelResponse = await youtube.channels.list({
        key: process.env.YOUTUBE_API_KEY,
        part: 'snippet,brandingSettings',
        id: channelIds.join(',')
      });
      
      const channelInfoMap = {};
      
      if (channelResponse.data.items) {
        channelResponse.data.items.forEach(channel => {
          const channelId = channel.id;
          const channelTitle = channel.snippet.title || '';
          const channelDescription = channel.snippet.description || '';
          
          // 공식 채널 판단 기준
          const isOfficial = 
            channel.brandingSettings?.channel?.keywords?.toLowerCase().includes('official') ||
            channelTitle.toLowerCase().includes('official') ||
            channelTitle.toLowerCase().includes('공식') ||
            channelDescription.toLowerCase().includes('official channel') ||
            channelDescription.toLowerCase().includes('공식 채널');
          
          // 음악 레이블 채널 판단
          const isMusicLabel = 
            channelTitle.toLowerCase().includes('records') ||
            channelTitle.toLowerCase().includes('music') ||
            channelTitle.toLowerCase().includes('entertainment') ||
            channelTitle.toLowerCase().includes('레코드') ||
            channelTitle.toLowerCase().includes('뮤직') ||
            channelTitle.toLowerCase().includes('엔터테인먼트');
          
          let channelType = 'user';
          if (isOfficial) {
            channelType = 'official';
          } else if (isMusicLabel) {
            channelType = 'label';
          }
          
          channelInfoMap[channelId] = {
            channelId: channelId,
            channelTitle: channelTitle,
            channelType: channelType,
            isOfficial: isOfficial,
            isMusicLabel: isMusicLabel
          };
        });
      }
      
      // videoId별 채널 정보 매핑
      const results = {};
      videoIdsBatch.forEach(videoId => {
        const channelId = videoIdToChannelId[videoId];
        if (channelId && channelInfoMap[channelId]) {
          results[videoId] = channelInfoMap[channelId];
        } else {
          results[videoId] = {
            channelId: channelId || null,
            channelTitle: null,
            channelType: 'unknown',
            isOfficial: false,
            isMusicLabel: false
          };
        }
      });
      
      socket.emit('channelInfoResults', results);
    } catch (error) {
      console.error('[getChannelInfo] 오류:', error);
      socket.emit('channelInfoError', { 
        message: '채널 정보 확인 실패: ' + error.message 
      });
    }
  });

  // ============================================
  // 기존 이벤트 핸들러 (변경 없음)
  // ============================================

  socket.on('disconnect', () => {
    console.log('클라이언트 연결 해제:', socket.id);
    
    // 세션 ID와 socket.id 매핑 제거
    const sessionId = socketToSessionMap.get(socket.id);
    if (sessionId) {
      socketToSessionMap.delete(socket.id);
      // 같은 세션의 다른 socket.id가 없으면 매핑 제거
      const currentSocketId = sessionToSocketMap.get(sessionId);
      if (currentSocketId === socket.id) {
        sessionToSocketMap.delete(sessionId);
      }
    }
    
    // 제어권을 가진 socket.id가 해제되면 제어권 해제 (세션 ID는 유지하여 재연결 시 복원 가능)
    if (controlSocketId === socket.id) {
      controlSocketId = null;
      // 세션 ID는 유지 (재연결 시 복원 가능)
      console.log('제어권 해제됨 (socket 연결 해제, 세션 ID는 유지):', controlSessionId);
      
      // 제어권 해제 시 상태 완전 초기화 (실제 재생 불가하므로)
      console.log('[disconnect] 제어권 해제로 인한 상태 초기화');
      isProcessingNext = false;
      
      // 타이머 정리 (제어권이 없으면 재생 불가)
      if (autoPlayTimer) {
        console.log('[disconnect] 제어권 해제로 인한 타이머 정리');
        clearTimeout(autoPlayTimer);
        autoPlayTimer = null;
      }
      
      // 재생 상태 초기화 (제어권이 없으면 실제 재생 불가)
      // 단, currentPlaying은 유지 (재연결 시 상태 확인용)
      isPlaying = false;
      console.log('[disconnect] isPlaying = false 설정 (제어권 없음)');
      
      // 다른 관리자 중 첫 번째에게 제어권 부여
      let controlTransferred = false;
      for (const [socketId, clientInfo] of connectedClients.entries()) {
        if (clientInfo && clientInfo.isAdmin && socketId !== socket.id) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket) {
            const sessionId = clientInfo.sessionId || socketToSessionMap.get(socketId) || socketId;
            controlSessionId = sessionId;
            controlSocketId = socketId;
            clientInfo.hasControl = true;
            controlTransferred = true;
            console.log(`제어권 이전: ${socketId} (세션: ${sessionId})`);
            targetSocket.emit('controlStatus', { hasControl: true });
            break;
          }
        }
      }
      
      // 제어권이 이전되지 않았으면 상태 완전 초기화
      if (!controlTransferred) {
        console.log('[disconnect] 제어권 이전 없음 - 상태 완전 초기화');
        currentPlaying = null;
        playStartTime = null;
        musicDuration = null;
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
  console.log('[startPlaying] 함수 호출됨:', music ? { id: music.id, title: music.title } : 'null');
  
  // 이전 타이머 정리
  if (autoPlayTimer) {
    console.log('[startPlaying] 기존 타이머 정리');
    clearTimeout(autoPlayTimer);
    autoPlayTimer = null;
  }
  
  currentPlaying = music;
  isPlaying = true;
  isProcessingNext = false;
  playStartTime = Date.now();
  console.log('[startPlaying] 상태 설정 완료:', {
    currentPlayingId: currentPlaying?.id,
    isPlaying,
    isProcessingNext
  });
  
  // 재생 시간 파싱 (예: "3:45" -> 225초)
  if (music.duration && typeof music.duration === 'string') {
    const parts = music.duration.split(':');
    if (parts.length === 2) {
      const minutes = parseInt(parts[0], 10);
      const seconds = parseInt(parts[1], 10);
      if (!isNaN(minutes) && !isNaN(seconds)) {
        musicDuration = minutes * 60 + seconds;
      } else {
        musicDuration = null;
      }
    } else if (parts.length === 3) {
      const hours = parseInt(parts[0], 10);
      const minutes = parseInt(parts[1], 10);
      const seconds = parseInt(parts[2], 10);
      if (!isNaN(hours) && !isNaN(minutes) && !isNaN(seconds)) {
        musicDuration = hours * 3600 + minutes * 60 + seconds;
      } else {
        musicDuration = null;
      }
    } else {
      musicDuration = null;
    }
  } else {
    musicDuration = null;
  }
  
  // 제어권이 있을 때만 재생 신호 전송 (제어권이 없으면 실제 재생 불가)
  // 제어권이 있는 클라이언트에게만 musicPlaying 이벤트 전송
  if (!controlSessionId) {
    console.error('[startPlaying] ⚠️ 제어권이 없어서 재생 불가 (이 함수는 제어권이 있을 때만 호출되어야 함)', {
      controlSessionId: controlSessionId,
      musicTitle: music?.title,
      connectedClients: Array.from(connectedClients.keys()),
      adminClients: Array.from(connectedClients.values()).filter(c => c.isAdmin).map(c => ({ socketId: c.socketId, hasControl: c.hasControl }))
    });
    // 제어권이 없으면 상태를 설정하지 않고 return
    // (이미 설정된 상태는 유지 - 제어권 획득 시 재생 가능하도록)
    isProcessingNext = false;
    return; // 제어권이 없으면 재생하지 않음
  }
  
  const playData = {
    ...currentPlaying,
    playStartTime: playStartTime
  };
  console.log('[startPlaying] musicPlaying 이벤트 전송 예약 (800ms 지연)', {
    controlSessionId: controlSessionId,
    musicTitle: currentPlaying.title
  });
  setTimeout(() => {
    console.log('[startPlaying] musicPlaying 이벤트 전송 (모든 클라이언트에게):', playData);
    // 모든 클라이언트에게 전송 (제어권이 없는 클라이언트도 썸네일 업데이트를 위해)
    io.emit('musicPlaying', playData);
    console.log('[startPlaying] musicPlaying 이벤트 전송 완료 (모든 클라이언트)');
    
    // 재생 위치 브로드캐스트 시작
    startPlaybackPositionBroadcast();
  }, 800);
  
  console.log(`재생 시작: ${currentPlaying.title} (재생 시간: ${musicDuration ? musicDuration + '초' : '알 수 없음'})`);
  
  // 서버에서 자동으로 다음 곡 재생 (제어권 있는 서버에서만 처리)
  // 재생 시간이 있으면 해당 시간 후 자동 재생, 없으면 기본 5분 후 재생
  // 여유 시간을 더 많이 주어 실제 재생 종료를 기다림 (10초 여유)
  const playDuration = musicDuration && musicDuration > 0 ? musicDuration : 300; // 기본 5분
  const timerDuration = (playDuration + 10) * 1000; // 재생 시간 + 10초 여유 (밀리초) - 실제 재생 종료를 기다림
  console.log(`서버 자동 재생 타이머 설정: ${playDuration}초 후 다음 곡 재생 (${timerDuration}ms, 10초 여유)`);
  
  // 타이머에 저장할 음악 ID (클로저 문제 방지)
  const timerMusicId = music.id;
  
  autoPlayTimer = setTimeout(() => {
    console.log('서버 타이머 실행:', { 
      isProcessingNext, 
      currentPlayingId: currentPlaying?.id, 
      timerMusicId: timerMusicId,
      isPlaying,
      queueLength: queueManager.getQueue().length,
      hasControl: !!controlSessionId
    });
    
    // 제어권이 없으면 타이머 실행하지 않음 (실제 재생 불가)
    if (!controlSessionId) {
      console.log('서버 타이머 무시: 제어권이 없음 - 상태 완전 정리');
      isProcessingNext = false;
      // 제어권이 없으면 실제 재생 불가하므로 상태 초기화
      isPlaying = false;
      // currentPlaying은 유지 (재연결 시 상태 확인용)
      console.log('서버 타이머: isPlaying = false 설정 (제어권 없음)');
      return;
    }
    
    // 대기열이 비어있으면 상태 초기화
    const queue = queueManager.getQueue();
    if (queue.length === 0) {
      console.log('서버 타이머: 대기열이 비어있음 - 상태 초기화');
      isProcessingNext = false;
      currentPlaying = null;
      isPlaying = false;
      playStartTime = null;
      musicDuration = null;
      io.emit('musicStopped');
      io.emit('queueUpdated', queue);
      return;
    }
    
    // 현재 재생 중인 곡이 타이머가 설정된 곡과 일치하는지 확인
    // 이미 다른 곡이 재생 중이거나 처리 중이면 무시
    if (isProcessingNext) {
      console.log('서버 타이머 무시: 이미 다음 곡 처리 중 (musicEnded가 먼저 처리함)');
      return;
    }
    
    // 현재 재생 중인 곡이 타이머가 설정된 곡과 일치하는지 확인
    // 클로저 문제 방지를 위해 timerMusicId 사용
    if (!currentPlaying || currentPlaying.id !== timerMusicId) {
      console.log('서버 타이머 무시: 다른 곡이 재생 중', { 
        currentPlayingId: currentPlaying?.id, 
        timerMusicId: timerMusicId
      });
      return;
    }
    
    if (!isPlaying) {
      console.log('서버 타이머 무시: 재생 중이 아님');
      return;
    }
    
    // 모든 조건 만족 - 다음 곡 재생
    // musicEnded가 먼저 실행되지 않았다면 타이머가 다음 곡 재생
    // 타이머는 시간 기반이므로 강제 실행 (musicEnded가 오지 않았을 수 있음)
    console.log('서버 타이머: 자동 재생 시간 초과 - 다음 곡 재생 (강제 실행)');
    try {
      // 타이머는 시간 기반이므로 force=true로 강제 실행
      // musicEnded가 오지 않았거나 클라이언트에서 전송하지 못한 경우 대비
      playNextMusic(true); // force=true로 강제 실행
    } catch (error) {
      console.error('서버 타이머: playNextMusic 실행 오류:', error);
      // 오류 발생 시 리셋 보장
      isProcessingNext = false;
    }
  }, timerDuration);
}

// 다음 음악 재생 함수
// force: true이면 isProcessingNext 체크를 무시하고 강제 실행 (musicEnded에서 호출 시 사용)
function playNextMusic(force = false) {
  const queue = queueManager.getQueue();
  console.log('[playNextMusic] 함수 호출됨', { 
    isProcessingNext, 
    currentPlaying: currentPlaying?.title,
    currentPlayingId: currentPlaying?.id,
    queueLength: queue.length,
    hasControl: !!controlSessionId,
    force
  });
  
  // force=true인 경우 무조건 isProcessingNext 리셋 (musicEnded에서 호출 시)
  // 실제 재생 종료이므로 어떤 상태든 무시하고 진행
  if (force) {
    if (isProcessingNext) {
      console.log('[playNextMusic] force=true이므로 isProcessingNext 강제 리셋 후 실행');
    }
    isProcessingNext = false; // force=true일 때는 무조건 리셋
  }
  
  // 중복 호출 방지: 이미 처리 중이면 무시 (단, force=true이면 무시하지 않음)
  if (isProcessingNext && !force) {
    console.log('[playNextMusic] 중복 호출 방지 (이미 처리 중)');
    return;
  }
  
  // 제어권이 없으면 관리자 중 첫 번째에게 자동 부여 시도
  if (!controlSessionId) {
    console.log('[playNextMusic] 제어권이 없음 - 관리자에게 자동 부여 시도', {
      controlSessionId: controlSessionId,
      connectedClients: Array.from(connectedClients.keys()),
      adminClients: Array.from(connectedClients.values()).filter(c => c.isAdmin).map(c => c.socketId)
    });
    
    // 관리자 중 첫 번째에게 제어권 부여 시도
    for (const [socketId, clientInfo] of connectedClients.entries()) {
      if (clientInfo.isAdmin) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          const sessionId = clientInfo.sessionId || socketToSessionMap.get(socketId) || socketId;
          controlSessionId = sessionId;
          controlSocketId = socketId;
          clientInfo.hasControl = true;
          console.log(`[playNextMusic] 제어권 자동 부여: ${socketId} (세션: ${sessionId})`);
          targetSocket.emit('controlStatus', { hasControl: true });
          broadcastControlStatus();
          break;
        }
      }
    }
    
    // 여전히 제어권이 없으면 실행하지 않음
    if (!controlSessionId) {
      console.log('[playNextMusic] 제어권 부여 실패 - 실행하지 않음 - isProcessingNext 리셋');
      isProcessingNext = false;
      return;
    }
  }
  
  // 플래그 설정 (중복 방지) - 가장 먼저 설정하여 경쟁 조건 방지
  isProcessingNext = true;
  console.log('[playNextMusic] isProcessingNext = true 설정');
  
  try {
    // 타이머 정리 (백업 타이머 취소)
    if (autoPlayTimer) {
      console.log('[playNextMusic] 기존 타이머 정리');
      clearTimeout(autoPlayTimer);
      autoPlayTimer = null;
    }
    
    console.log('[playNextMusic] 현재 대기열:', queue.map(m => ({ id: m.id, title: m.title })));
    const nextMusic = queueManager.getNextMusic();
    console.log('[playNextMusic] 다음 음악:', nextMusic ? { id: nextMusic.id, title: nextMusic.title } : '없음');
    
    if (nextMusic) {
      queueManager.removeFromQueue(nextMusic.id);
      console.log('[playNextMusic] 대기열에서 제거 후:', queueManager.getQueue().map(m => ({ id: m.id, title: m.title })));
      console.log('[playNextMusic] startPlaying 호출 시작:', nextMusic.title);
      // startPlaying 호출 (제어권이 없으면 return하므로 isProcessingNext 리셋 필요)
      startPlaying(nextMusic);
      // startPlaying에서 제어권이 없어서 return한 경우를 대비해 isProcessingNext 리셋
      // (제어권이 있으면 startPlaying 내부에서 isProcessingNext = false로 리셋됨)
      if (!controlSessionId) {
        console.log('[playNextMusic] startPlaying에서 제어권 없음으로 return됨 - isProcessingNext 리셋');
        isProcessingNext = false;
      }
      io.emit('queueUpdated', queueManager.getQueue());
      console.log(`[playNextMusic] 다음 곡으로 전환 완료: ${nextMusic.title}`);
    } else {
      // 재생할 음악이 없으면 상태 완전 초기화 (유휴 상태)
      console.log('[playNextMusic] 재생할 음악이 없어서 상태 초기화 (유휴 상태)');
      currentPlaying = null;
      isPlaying = false;
      playStartTime = null;
      musicDuration = null;
      isProcessingNext = false; // 플래그 리셋 (중요: 대기열에 곡이 추가되면 재생 가능하도록)
      stopPlaybackPositionBroadcast(); // 재생 위치 브로드캐스트 중지
      io.emit('musicStopped');
      io.emit('queueUpdated', queueManager.getQueue());
      console.log('[playNextMusic] 재생할 음악이 없습니다. 대기열에 곡이 추가되면 자동 재생됩니다.');
    }
  } catch (error) {
    // 예외 발생 시 리셋 보장
    console.error('[playNextMusic] 오류 발생:', error);
    isProcessingNext = false;
    // 상태 초기화
    if (!currentPlaying) {
      isPlaying = false;
      playStartTime = null;
      musicDuration = null;
    }
  }
}

  // 관리자에게 클라이언트 목록 브로드캐스트
function broadcastClientList() {
  // 각 클라이언트에 hasControl 정보 추가
  const clientList = Array.from(connectedClients.values()).map(clientInfo => ({
    ...clientInfo,
    hasControl: hasControlBySocketId(clientInfo.socketId)
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
      const hasControl = hasControlBySocketId(sock.id);
      clientInfo.hasControl = hasControl;
      sock.emit('controlStatus', { hasControl: hasControl });
    }
  });
}

// 재생 위치 브로드캐스트 시작
function startPlaybackPositionBroadcast() {
  // 기존 타이머 정리
  if (playbackPositionTimer) {
    clearInterval(playbackPositionTimer);
    playbackPositionTimer = null;
  }
  
  // 5초마다 재생 위치 브로드캐스트
  playbackPositionTimer = setInterval(() => {
    if (currentPlaybackPosition && currentPlaying && isPlaying) {
      // 네트워크 지연 보정: timestamp와 현재 시간의 차이를 더함
      const delay = Date.now() - currentPlaybackPosition.timestamp;
      const adjustedPosition = currentPlaybackPosition.position + (delay / 1000);
      
      io.emit('playbackPositionUpdate', {
        videoId: currentPlaybackPosition.videoId,
        position: adjustedPosition,
        timestamp: Date.now()
      });
    }
  }, 5000); // 5초마다 브로드캐스트
}

// 재생 위치 브로드캐스트 중지
function stopPlaybackPositionBroadcast() {
  if (playbackPositionTimer) {
    clearInterval(playbackPositionTimer);
    playbackPositionTimer = null;
  }
  currentPlaybackPosition = null;
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
  
  // 재생 위치 브로드캐스트 타이머 정리
  stopPlaybackPositionBroadcast();
  
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

