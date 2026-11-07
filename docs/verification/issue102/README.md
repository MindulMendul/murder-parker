# Issue 102 — 작품 선택 카드 검증

기준 dev: `b867227f9dc446ccaa4bc0ffb3df0f9360933e27`.

## 기존 초대장 SVG 조사

`rg --files` / `git ls-tree -r origin/dev --name-only`의 `.svg`·초대장·invitation 경로, `apps/web/src`·`apps/web/public`의 inline svg/초대장/`invitation`, `git log --all -- *.svg *Invitation* *invitation*`를 확인했지만 기존 초대장 SVG나 생성 컴포넌트를 찾지 못했습니다. 게임 텍스트의 초대장 언급은 그래픽 자산이 아닙니다.

따라서 `apps/web/public/images/story-invitation.svg`는 이번 변경에서 새로 만든 장식용 공통 썸네일입니다. 기존 자산을 재사용했다고 주장하지 않습니다. 특정 작품의 장면이나 전용 표지를 의미하지 않으며, `alt=""`로 제목과 중복 낭독하지 않습니다.

## 결과

- 카드 상단의 일정 비율 썸네일과 출처·상태 배지, 제목·소개, 플레이 인원·예상 시간·난이도·평점, 작은 이용 통계, 선택 버튼 순으로 정리했습니다. 기존 디자인 토큰 유틸리티만 사용했습니다.
- 데이터는 기존 API에서 그대로 가져옵니다. 평가가 없으면 `평가 없음`만 표시하고, 평점이 있으면 실제 평점과 평가 수를 표시합니다. 이용 통계 0은 그대로 표시합니다. 미출시 3부작의 4인·60분은 기존 카탈로그의 임시 기획 값이므로 확정값처럼 보여 주지 않고 카드에 인원·시간 `미정`으로 안내합니다.
- 실제 Chromium/Playwright: 한·영 각각 1440/768/375/320px에서 실제 네 작품, 썸네일 네 개 로딩, 준비 중 세 작품 비활성화와 체험판 한 작품 선택 가능, 문서·패널 가로 넘침 없음 확인. 실제 320px 작품 선택 → 방 생성 → 방 나가기 통과. 런타임 오류 0건.
- 긴 제목·소개는 브라우저 API 응답만 변경해 320px에서 검증했으며 운영 카탈로그에 가짜 데이터를 넣지 않았습니다.
- 수정 전후 실제 화면: `before-1440.png`, `before-320.png`, `after-ko-1440.png`, `after-ko-320.png`, `after-en-320.png`. 전체 결과는 `browser-results.json`.
- `bash scripts/codex/verify.sh`: exit 0, check/build 및 61 tests / 4,800 assertions 통과.
- `bash scripts/codex/verify.sh --browser`: check/build 및 61 tests / 4,800 assertions 통과 후 기존 `test:e2e` 부재로 최종 exit 1. 자동 브라우저 단계 통과로 처리하지 않았고 위 실제 검증으로 보완했습니다. 기존 Astro 페이지 경고와 Svelte unused CSS 경고는 남아 있습니다.
- `git diff --check` 통과.

`browser.cjs`는 테스트 서버 `http://127.0.0.1:3212`와 전용 `/tmp/ready-102.sqlite` DB, 사전 설치된 Playwright/Chromium을 사용했습니다. QA/main 승격·배포·운영 데이터 접근은 없습니다.

브라우저 스크립트는 게스트 계정과 방을 만듭니다. 직접 실행할 때는 `DATABASE_PATH=:memory:`로 본인이 시작한 로컬 테스트 서버만 사용하세요. 스크립트는 정확한 loopback origin만 허용하며 `DISPOSABLE_TEST_SERVER=1` 확인 값이 없으면 브라우저나 API 요청을 시작하지 않습니다. 종료 후 서버를 멈추면 in-memory DB도 사라집니다.

## 다른 환경에서 재현

Playwright를 설치하고 Chromium을 준비한 뒤 아래처럼 실행합니다. Playwright 기본 브라우저를 사용하면 `CHROMIUM_PATH`를 생략할 수 있습니다. 시스템의 절대 경로는 환경 변수로만 전달하며 스크립트에 고정하지 않습니다. `RESULTS_DIR` 기본값은 스크립트 디렉터리입니다.

```sh
PORT=3212 DATABASE_PATH=:memory: bun apps/server/src/index.ts
# 다른 터미널; 먼저 bun run build 실행 필요
DISPOSABLE_TEST_SERVER=1 BASE_URL=http://127.0.0.1:3212 PLAYWRIGHT_MODULE=playwright CHROMIUM_PATH=/path/to/chromium RESULTS_DIR=/tmp/issue102-results node docs/verification/issue102/browser.cjs
```

브라우저 스크립트는 빈 테스트 DB에서 게스트를 만들고 종료 전 방에서 퇴장합니다. 기존 네 작품의 카탈로그를 사용하므로 별도 데이터 시드는 필요 없습니다. 평가 표시 분기와 긴 텍스트 검증은 브라우저 응답만 대체합니다.
