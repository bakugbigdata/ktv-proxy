# archive (Google AI Studio용)

## 실행

1) Node.js 18+ 설치
2) 폴더에서:

```bash
npm install
npm start
```

3) 브라우저에서:

- http://localhost:8787

## 동작
- 검색: /api/search (나누리 HTML 검색 결과를 파싱)
- 상세: /api/play-url (상세 페이지에서 m3u8 추출)
- 선택: 프론트에서 `window.postMessage({ type: 'ARCHIVE_SELECT', payload }, '*')`

## autocut 프로그램과 합치기
- autocut 쪽에서 message 이벤트로 ARCHIVE_SELECT를 받아 타임라인 로직에 주입하면 됩니다.

> 참고: 나누리 검색 결과 마크업이 바뀌면 /api/search 파싱 규칙을 약간 조정해야 할 수 있습니다.
