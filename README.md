# 음악 선곡기 (Music Selector)

여러 사용자가 동시에 음악을 요청하고, 유튜브 검색 결과를 바탕으로 대기열을 관리하며 실시간으로 동기화하는 웹 애플리케이션입니다. 클라이언트 측에서 문장 임베딩 모델을 사용해 제목·메타 정보 기반 유사도 추천을 제공합니다.

## 프로젝트 개요

- **실시간 협업**: Socket.io로 접속자·대기열·재생 상태·좋아요 등이 공유됩니다.
- **유튜브 연동**: `youtube-search-api`로 검색하고, 필요 시 YouTube Data API(환경 변수 설정 시)로 메타데이터를 보강합니다.
- **재생 제어**: 한 세션에 제어권을 두어 재생·스킵·관리자 기능 등을 조정할 수 있습니다.
- **AI 추천(클라이언트)**: 브라우저에서 `Transformers.js`로 다국어 임베딩 모델을 로드하고, 코사인 유사도와 규칙 기반 점수(인기도·아티스트 매칭 등)를 결합해 추천 후보를 만듭니다.

백엔드는 추론을 수행하지 않으며, 임베딩·유사도 계산은 사용자 브라우저에서 이루어집니다.

## 기술 스택

### 백엔드

- **Express.js**: HTTP API 및 정적 연동
- **Socket.io**: 실시간 이벤트
- **youtube-search-api**: 유튜브 검색
- **cors**: 교차 출처 요청 허용

### 프론트엔드

- **React 18**: UI
- **Socket.io-client**: 실시간 동기화
- **@xenova/transformers**: 브라우저 내 임베딩 모델 실행
- **CSS**: 앱 스타일(다크/라이트 테마 등)

## 프로젝트 구조

```
MUSIC_SELECTOR/
├── server/
│   ├── index.js                 # Express + Socket.io, 대기열·좋아요·관리자 등
│   ├── services/
│   │   ├── queueManager.js      # 대기열 관리
│   │   └── youtubeService.js    # 유튜브 검색·보조 API
│   └── package.json
├── client/
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── App.js               # 소켓 연결, 제어권·테마·레이아웃
│   │   ├── components/
│   │   │   ├── ai/
│   │   │   │   ├── AutoRecommendationButton.jsx
│   │   │   │   ├── RecommendationButton.jsx
│   │   │   │   ├── RecommendationModal.jsx
│   │   │   │   └── RecommendationList.jsx
│   │   │   ├── ClientList.jsx
│   │   │   ├── CurrentPlaying.jsx
│   │   │   ├── LikedMusicList.jsx
│   │   │   ├── MusicRequestForm.jsx
│   │   │   ├── PlaylistModal.jsx
│   │   │   └── QueueList.jsx
│   │   ├── services/ai/
│   │   │   ├── modelLoader.js          # Transformers.js 모델 로드
│   │   │   ├── embeddingService.js     # 텍스트 임베딩
│   │   │   ├── similarityCalculator.js
│   │   │   └── recommendationService.js
│   │   ├── utils/ai/
│   │   │   └── indexedDB.js            # 앱용 IndexedDB·캐시 유틸
│   │   ├── index.js
│   │   └── App.css
│   └── package.json
├── test_ai_recommendation.js    # AI 추천 관련 스크립트(루트)
├── package.json                 # concurrently로 server/client 동시 실행
└── README.md
```

## AI 관련 기술

| 구분 | 기술·구성 요소 | 역할 |
|------|----------------|------|
| 브라우저 ML 런타임 | `@xenova/transformers` (Transformers.js) | Hugging Face 계열 모델을 ONNX 등으로 브라우저에서 로드·실행 |
| 임베딩 모델 | `Xenova/multilingual-e5-small` | `feature-extraction` 파이프라인, 다국어 문장 벡터(평균 풀링·정규화), 양자화 모델 옵션 |
| 임베딩 API | `embeddingService.js` | 문자열 → `Float32Array` 임베딩, 메모리 캐시 |
| 유사도·벡터 연산 | `similarityCalculator.js` | 코사인 유사도, 가중 평균 임베딩, 유클리드 거리 |
| 추천 로직 | `recommendationService.js` | 임베딩 유사도와 좋아요·대기열·검색 순위·조회수·아티스트 문자열 매칭 등을 조합한 점수화 |
| 로컬 저장소 | IndexedDB | Transformers.js가 브라우저 캐시로 모델 파일을 재사용; `utils/ai/indexedDB.js`는 앱 DB·TTL 캐시 등 |

### @xenova/transformers (Transformers.js) 상세

| 항목 | 설명 |
|------|------|
| 정체성 | Hugging Face의 **Transformers** 패턴을 자바스크립트에서 쓰기 위한 라이브러리(브랜드명 **Transformers.js**). NPM 패키지명은 `@xenova/transformers`이다. |
| 추론 백엔드 | 브라우저에서는 주로 **ONNX** 형식 가중치와 **ONNX Runtime Web**을 사용하며, **WebAssembly** 등으로 CPU 추론을 수행한다(별도 GPU 가속 없이도 동작). |
| 모델 소스 | 기본적으로 **원격 Hugging Face Hub**에서 모델 파일을 가져온다. 이 프로젝트는 `env.allowLocalModels = false`, `env.allowRemoteModels = true`로 로컬 파일 대신 원격 로드를 사용한다(`client/src/services/ai/modelLoader.js`). |
| 캐시 | 브라우저 환경에서 **IndexedDB 등 브라우저 스토리지**에 모델을 캐시해 두 번째 방문부터 로드를 줄인다. |
| API 형태 | `pipeline(task, modelName, options)`으로 태스크별 파이프라인을 만든다. 이 앱은 **`feature-extraction`** 태스크로 문장 임베딩 벡터를 얻는다. |
| 본 프로젝트 모델 | **`Xenova/multilingual-e5-small`**: 다국어 문장 임베딩용 소형 모델. 옵션으로 **`quantized: true`**(양자화 가중치)를 켜 용량·속도를 우선한다. |
| 임베딩 호출 | `embeddingService.js`에서 파이프라인에 문자열을 넘길 때 `pooling: 'mean'`, `normalize: true`로 시퀀스를 하나의 단위 벡터로 만들고 코사인 유사도에 맞게 정규화한다. |
| 출력 | 텐서 형태의 결과에서 `.data`를 꺼내 **`Float32Array`** 등으로 후처리해 앱의 유사도 계산에 넘긴다. |
| 장점 | **서버로 임베딩 요청을 보내지 않음**(텍스트가 사용자 브라우저 안에서 처리되는 경향이 강함), Hugging Face에 올라온 다양한 ONNX 변환 모델을 동일 API로 시도하기 쉽다. |
| 유의점 | **첫 로드 시 모델 다운로드**로 시간·트래픽이 들고, **메인 스레드/WebAssembly 부하**로 UI가 잠시 무거워질 수 있다. **CORS·네트워크·저장 공간** 이슈 시 로드가 실패할 수 있어, 콘솔·캐시 삭제 등이 필요할 수 있다. |

## 설치 및 실행

### 의존성 설치

루트에서:

```bash
npm run install-all
```

### 개발 실행 (권장)

루트에서 서버와 클라이언트 동시 실행:

```bash
npm run dev
```

### 개별 실행

서버(기본 포트 5000):

```bash
cd server
npm start
```

클라이언트(기본 포트 3000):

```bash
cd client
npm start
```

### 접속

- 로컬: `http://localhost:3000`
- LAN에서 접속 시: `http://[서버 PC의 IPv4]:3000` 클라이언트는 동일 호스트의 5000 포트로 소켓 연결을 시도합니다.
- 다른 주소로 백엔드를 쓰려면 `client/.env`에 `REACT_APP_SERVER_URL=http://[호스트]:5000` 을 설정합니다.

## 환경 변수

| 변수 | 적용 위치 | 설명 |
|------|-----------|------|
| `PORT` | 서버 | HTTP/Socket 포트 (기본 5000) |
| `HOST` | 서버 | 바인드 주소 (기본 0.0.0.0) |
| `ADMIN_PASSWORD` | 서버 | 관리자 인증 비밀번호 (미설정 시 기본값 사용) |
| `YOUTUBE_API_KEY` | 서버 | YouTube Data API 키(선택). 없으면 검색·보조 기능 일부가 제한될 수 있음 |
| `REACT_APP_SERVER_URL` | 클라이언트 | 백엔드 베이스 URL 오버라이드 |

## 주의사항

- 유튜브 검색·API는 사용량·정책 제한이 있을 수 있습니다.
- AI 모델은 최초 로드 시 네트워크로 가중치를 받으며, 브라우저와 기기 성능에 따라 지연이 클 수 있습니다.

## 라이선스

ISC
