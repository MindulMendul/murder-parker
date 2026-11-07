# 공개 창작 1인 플레이 (#87)

공개 창작 작품 상세 화면의 `플레이하기`에서 기존 1인 수사 엔진으로 연결합니다. 현재 엔진이 지원하는 시작→조사→결말 3장면, 1인·3개 증거 제출 방식만 허용합니다. 비공개·없는 작품, 손상된 파일, 다인/다른 분기 방식은 서버가 거절하고 화면에서 이유를 알립니다.

공개 플레이 URL은 `/workshop?play=<작품 ID>`이며 뒤로/앞으로와 새로고침 때 선택한 작품을 복원합니다. 페이지를 떠난 수사는 기존 동작대로 중단하고 새로 시작합니다. 비공개 작품 재시작이 실패해도 완료한 플레이의 결과와 평점을 유지합니다.

플레이 시작 때 검증한 원본 패키지를 `story_runs.package_json`에 비공개로 고정합니다. 같은 버전의 내용 수정이나 비공개 전환·서버 재시작 뒤에도 시작한 플레이는 해당 원본으로 계속됩니다. 비공개 전환 후 새 플레이는 거절합니다. 고정 원본의 UTF-8 저장 예산은 전체 활성 플레이 합계 **64 MiB**입니다. 확인과 삽입은 SQLite immediate 트랜잭션에서 수행하며 초과 시 새 시작을 429로 거절합니다. 기존 활성 원본은 삭제하지 않습니다. 완료·실패·중단하면 원본만 해제하고 작품 ID·버전·이벤트·평점은 보존합니다.

업로드 파일에 들어 있던 ID 대신 창작마당 저장 ID로 플레이·평점·통계를 연결합니다.

미리보기 API는 작품 메타데이터만 제공합니다. 시작 응답은 수사 UI에 필요한 mechanics를 허용 목록으로 구성하며 solution, revealsTruth, 원본 정보/역할/아이템, 전체 scenes를 포함하지 않습니다. 장면 cues는 현재 장면과 성공한 고발의 결말에서만 전달합니다. 세션 ID는 기존 엔진과 동일한 예측 불가능한 플레이 capability이므로 공개 목록이나 로그에 기록하지 않습니다.

최신 dev `32b9b4e` (#102 카드·#110 첫 화면 개선)를 통합한 뒤 재검증했습니다.

검증:

- `bash scripts/codex/verify.sh --browser`: 타입 검사·빌드와 66 tests / 4,864 assertions 통과 후 기존 `test:e2e` 부재로 exit 1. 자동 브라우저 단계가 성공한 것은 아닙니다.
- 서버 회귀 5개: 공개 응답의 비밀/장면 비노출, 같은 버전 수정·비공개·DB 재개방 후 원본 고정, private/missing/invalid/multiplayer/추가 장면/분기 선택/중복 장소/불가능한 중복 증거 작품 거절, canonical ID와 버전별 플레이·평점 분리. 익명 시작 40건·SQLite 두 연결에 걸친 UTF-8 바이트 예산과 종료/중단 후 원본 해제·기록/평점 유지.
- 실제 Chromium: 1280px 한국어 공개 카드→시작→조사→결말→평점→창작마당 복귀. 플레이 중 수정·비공개 전환에도 기존 장면 유지, 새 시작 거절, 창작 ID의 플레이 1·평점 5와 원본 파일 ID의 플레이 0 확인.
- 320px 영어 화면에서 수정된 새 버전 시작·조사, 가로 넘침 없음. 지원하지 않는 작품의 안내와 시작 버튼 비활성화, 비공개 재시작 실패 후 기존 평점 저장, 시작한 플레이에서 Back/Forward/새로고침의 선택 복원과 방 참가 중 직접 play URL 접근 제한도 확인. 런타임 pageerror 0.
- 결과는 `browser-results.json`, 화면은 `desktop-play-entry.png`, `mobile-opening.png`, `mobile-investigation.png`입니다. 결말·수집 증거를 담은 화면과 세션 ID/쿠키는 게시하지 않습니다.

재현 환경:

1. 저장소 루트에서 Bun 1.4.4와 잠금 의존성을 준비하고 `bun run build`를 실행합니다.
2. 테스트 전용 DB와 포트로 서버를 실행합니다: `DATABASE_PATH="${TEST_DB_PATH:-/tmp/workshop-play-verification.sqlite}" PORT=3287 bun apps/server/src/index.ts`. 기존 DB에는 테스트 작품과 계정을 만들므로 운영 DB를 사용하지 않습니다.
3. Playwright와 Chromium을 준비한 뒤 `node docs/verification/issue87/browser.cjs`를 실행합니다. 표준 `playwright` 패키지와 Playwright 브라우저를 기본 사용하며 `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH`, `BASE_URL`, `OUTPUT_DIR`로 환경에 맞출 수 있습니다. 결과/화면 폴더는 자동 생성합니다. 실행마다 임시 테스트 계정·작품을 만듭니다.
4. 서버를 종료하고 테스트 DB·WAL·SHM 파일을 정리합니다.

QA/main 승격과 운영 배포는 포함하지 않습니다. 최신 PR head의 CI·SonarCloud·Qodo와 필요한 사람 승인 확인 후 dev 병합 대상입니다.

## Empty opening cue regression

An accepted public solo story can have an empty opening cue list. The intro displays a localized **Begin investigation** action that calls the existing server-side advance endpoint and enters the suspects stage. The server regression uses a valid three-scene package, confirms the run advances from `opening` to `investigation`, and checks that the response does not include the solution, truth flag, or resolution scene.

- Integrated `dev` through `5c8ebaf` before final verification.
- `bash scripts/codex/verify.sh`: passed, 72 tests / 4,910 assertions.
- `bash scripts/codex/verify.sh --browser`: the same checks passed; the wrapper then exited 1 because this repo has no `test:e2e` command. The independent browser run is recorded separately.
- Actual Chromium/Playwright: Korean desktop 1440px and English mobile 375px. Each case published a test-only story with an empty opening, started play, used the fallback action, and reached the suspects stage. No horizontal overflow or page errors. See `empty-opening-browser-results.json` and screenshots.
- Test server used port 3195 and `/tmp/issue87-review-final3.sqlite`, with no real account or production data.

Reproduce with Bun 1.4.4, dependencies, and Playwright/Chromium available:

```sh
PORT=3195 HOST=127.0.0.1 APP_ORIGIN=http://127.0.0.1:3195 \\
DATABASE_PATH=/tmp/issue87-review-final3.sqlite bun apps/server/src/index.ts

BASE_URL=http://127.0.0.1:3195 \\
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \\
CHROMIUM_PATH=/absolute/path/to/chromium \\
PLAYWRIGHT_NO_SANDBOX=1 \\
node docs/verification/issue87/empty-opening-browser.cjs
```

The existing implementation also lets a started run continue from its pinned source after a story is unpublished. That policy question remains open for product approval; this fix does not change that behavior or claim the policy was approved.
