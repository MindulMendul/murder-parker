# #109 검증 기록

dev `aa578234ed7b8bee3a091e143ecb715f99178910`에서 분리한 `fix/qa-followups-109`에 최신 dev `2db2e60f0e17bdf584c6e79c7c200fa05a237ccd`를 통합한 뒤 검증했습니다. 운영·QA 배포와 운영 DB는 사용하지 않았습니다.

- `PUBLIC_SITE_URL= bash scripts/codex/verify.sh` (Bun 1.4.4): exit 0, check/build 및 56 tests / 4,746 assertions 통과. 로컬 로그: `.codex-results/verify.tYPhSjP9.log`.
- `PUBLIC_SITE_URL= bash scripts/codex/verify.sh --browser`: 같은 check/build 및 56 tests / 4,746 assertions 통과. 마지막 단계는 기존 `test:e2e` 미구성으로 exit 1이며 자동 브라우저 검사 통과로 보고하지 않습니다. wrapper를 건너뛰거나 약화하지 않았습니다. 로컬 로그: `.codex-results/verify.ppYt7YnF.log`.
- 실제 Chromium (`/usr/bin/chromium`) + Playwright, 전용 Bun 서버와 메모리 SQLite, 한국어·영어 및 1280px/320px 화면에서 검증했습니다. 결과는 [browser-results.json](browser-results.json)에 있습니다.
- 없는 경로의 HTTP 404, noindex/nofollow, 홈 canonical 부재와 언어별 홈 복귀를 확인했습니다. 알려진 앱·약관·개인정보 페이지 및 robots/sitemap은 HTTP 200입니다. API 오류와 HEAD 404는 HTTP 회귀 테스트에도 포함합니다.
- 서명된 한국어·영어 OAuth 시도에서 불일치 state를 보내면 고정된 언어별 앱 오류 화면으로 돌아오며 로그인 세션이 생기지 않습니다. 이때 다른 탭의 유효한 pending 쿠키는 보존하고, 일치하는 취소 콜백은 쿠키를 삭제합니다. 만료·잘못된 쿠키도 삭제합니다. 잘못된 콜백 뒤 원래 정상 콜백의 로그인 가능 여부는 서버 회귀로 확인했습니다. 쿠키가 없으면 안전한 기본 한국어 홈으로 돌아옵니다. 만료·재사용·변조·누락 시 upstream 요청 및 세션 발급 차단은 서버 테스트로 확인했습니다.
- 양쪽 개인정보 페이지에서 Google subject, 영속 계정 연결, 로그아웃 시 보존 및 자동 삭제 기한 부재를 확인했습니다. 미병합 계정 탈퇴 PR의 동작은 가정하지 않았습니다.
- 실제 닉네임 중복 확인과 자기 닉네임 제외가 양쪽 언어에서 동작합니다. 인증된 계정 ID 또는 실제 접속 IP별 분당 60회 제한, 위조 IP 헤더 무시, 다른 접속자·계정의 확인 유지, 만료 후 복구 및 세션 보존은 서버 테스트로 검증했습니다. 한·영 화면의 429 안내도 확인했습니다. bucket은 최대 4,096개이며 만료 항목을 정리합니다. 실제 IP가 없는 호출은 제한된 공통 anonymous bucket을, 같은 reverse proxy를 거치는 익명 이용자는 해당 접속 IP bucket을 공유합니다. 전달받은 IP 헤더는 신뢰하지 않습니다. 인덱스의 Unicode/재시작/과거 중복 이름/변경·로그아웃/저장 실패 롤백도 포함합니다.
- 캔버스에서 만든 유효 JPEG에 5개 APP15 세그먼트를 붙인 328,476바이트 파일을 양쪽 화면에서 실제 WebP(562바이트, RIFF/WEBP 헤더)로 내려받았습니다. 16MP 초과 헤더와 10MiB 초과 파일은 디코더 추가 호출 없이 거절됩니다. 변환은 브라우저에서 처리합니다. JPEG 프레임 탐색은 최대 10MiB 파일 안에서 세그먼트 본문을 건너뛰며 최대 4,096회, 회당 최대 12바이트를 읽고 SOF에서 멈춥니다. 전체 파일 버퍼 복사 없이 기존 256KiB보다 작은 읽기 예산을 유지하며, 잘못된 길이·잘린 세그먼트·과도한 세그먼트 수를 거절하는 테스트를 포함합니다.
- 브라우저 pageerror 0건, 확인한 320px 화면 가로 넘침 없음. 테스트 서버·브라우저는 종료했습니다. 기존 Astro pages 경고와 Svelte 미사용 CSS 경고는 남아 있습니다.

화면: [영어 404](en-404.png), [한국어 인증 실패](ko-auth-failed.png), [영어 개인정보](en-privacy.png), [영어 JPEG 변환](en-jpeg-converted.png).
