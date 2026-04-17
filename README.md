# Music Selector (Release)

이 브랜치는 배포 전용 브랜치입니다. 개발 소스는 제외하고, 서버 실행 코드와 빌드된 정적 파일만 포함합니다.

## 실행 방법

1. 서버 의존성 설치

```bash
cd server
npm install --omit=dev
```

2. 서버 실행

```bash
cd ..
npm start
```

3. 접속

- 로컬: `http://localhost:5000`
- 네트워크: `http://[서버IP]:5000`

## 환경 변수

- `PORT`: 서버 포트 (기본 `5000`)
- `HOST`: 바인드 주소 (기본 `0.0.0.0`)
- `ADMIN_PASSWORD`: 관리자 인증 비밀번호
- `YOUTUBE_API_KEY`: YouTube Data API 키(선택)

## 포함 파일

- `server/index.js`
- `server/services/*`
- `server/public/*` (빌드된 프론트엔드 산출물)
