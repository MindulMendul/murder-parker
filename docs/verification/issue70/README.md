# Issue 70 검증

최신 확인 dev `32b9b4e`를 기존 PR #107에 통합했습니다. 작품 필터를 기본 접힘으로 제공하고 기존 색상·타이포그래피 토큰으로 요약 행과 활성 조건 배지를 구성합니다. 접힌 필터는 작품 목록을 밀어내지 않습니다.

- `bash scripts/codex/verify.sh`: 통과. 타입 확인·빌드·61 tests / 4,800 assertions가 성공했습니다. 제한된 sandbox에서 로컬 HTTP 테스트가 시작되지 않았으나 네트워크 접근을 허용해 다시 실행했을 때 전체 검증이 통과했습니다.
- 실제 Chromium/Playwright: 한국어·영어 각각 1440/768/375/320px에서 기본 접힘, Enter/Space 키보드 조작, 검색 조건 유지, 초기화, 가로 넘침 없음, 런타임 오류 0을 확인했습니다. 관측한 각 결과는 `browser-results.json`에 기록했습니다.
- 재현 서버는 로컬 테스트 DB `/tmp/issue70-resume.sqlite`와 포트 3179를 사용했습니다. 스크립트는 기본적으로 프로젝트의 `playwright` 패키지를 사용하며 `PLAYWRIGHT_MODULE`로 모듈 경로, `CHROMIUM_PATH`로 브라우저 경로를 지정할 수 있습니다. 컨테이너에서만 필요한 경우 `PLAYWRIGHT_NO_SANDBOX=1`을 명시합니다.

```sh
BASE_URL=http://127.0.0.1:3179 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROMIUM_PATH=/absolute/path/to/chromium \
PLAYWRIGHT_NO_SANDBOX=1 \
node docs/verification/issue70/browser.cjs
```

- `ko-1440-*`, `ko-320-*`는 한국어 펼침·접힘 실제 화면입니다.

QA 배포와 사용자 확인은 별도 단계이며 수행하지 않았습니다. 최신 PR head의 CI·Qodo 및 필요한 사람 승인이 충족되기 전 병합하지 않습니다.
