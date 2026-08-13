# Alexandria

글과 음성을 알아서 정리하고, 찾아주고, 먼저 보여주는 개인용 데스크톱 앱. 전체 설명은 [README.md](./README.md).

```
packages/core     수집·전사·정리·색인. Electron 의존성 없음
packages/cli      alx — 코어를 그대로 사용
apps/desktop      Electron + React
```

## 명령

```bash
pnpm build        # 전체 빌드 (pnpm -r build)
pnpm typecheck
pnpm test         # 코어 테스트. dist 를 대상으로 하므로 build 후 실행
pnpm alx <args>   # CLI
pnpm desktop      # Electron 개발 실행
```

## 커밋 규칙

**Conventional Commits + scope**, 제목은 **영어**.

```
<type>(<scope>): <subject>

<body — 선택>

Co-Authored-By: ...
```

- **type** — `feat` `fix` `refactor` `perf` `test` `docs` `chore` `build`
- **scope** — `core` `cli` `desktop`. 저장소 전체에 걸치면 생략
- **subject** — 영어 명령형 현재시제, 72자 이내, 끝에 마침표 없음
  - `feat(core): add file-backed vault with SQLite index`
  - `fix(cli): resolve the claude binary instead of the npm shim on Windows`
- **body** — 필요할 때만. *무엇을* 했는지는 diff 가 말하므로 **왜** 그렇게 했는지를 적는다
- **Co-Authored-By** 트레일러를 남긴다

### 이 저장소의 추가 규칙

- **기능 단위로 커밋한다.** 한 커밋은 하나의 완결된 변경이고, 그 시점에서 빌드가 통과해야 한다
- **측정으로 정한 것은 수치를 본문에 남긴다.** 이 프로젝트의 핵심 결정들(툴 스키마 제거, `--effort low`, `node:sqlite` 채택)은 전부 실측 근거가 있고, 그 숫자가 없으면 나중에 되돌릴 근거도 사라진다
- 커밋과 푸시는 요청받았을 때만 한다

## 설계상 지켜야 할 것

- **보관소가 진실의 원천이다.** 마크다운 파일이 원본이고 SQLite 는 언제든 `alx reindex` 로 재생성되는 파생물. 색인에만 존재하는 상태를 만들지 않는다
- **재빌드가 필요한 네이티브 모듈을 추가하지 않는다.** 색인은 내장 `node:sqlite`, 전사와 LLM 호출은 자식 프로세스. 임베딩만 예외로 `onnxruntime-node` 를 쓰는데, N-API 프리빌트라 Node 24 와 Electron 43 양쪽에서 재빌드 없이 로드되는 것을 실측했다. 빌드 툴체인이 필요한 의존성이 들어오면 이 성질이 깨진다. 패키징할 때 `.node` 는 asar 에서 unpack 해야 한다
- **전사 정확도는 협상 대상이 아니다.** 틀린 사람 이름은 항목의 `people` 에 그대로 박히고 이후 어디서도 걸러지지 않는다. 정리 단계의 오류 복원은 실측상 신뢰할 수 없었다(같은 오디오에서 한 번은 복원, 한 번은 실패). 기본 whisper 모델을 `small` 아래로 내리지 않는다
- **관련 없으면 빈 결과를 낸다.** 관련 기록은 유사도 상위 N 이 아니라 항목별 기준선 대비 이상치만 인정한다. 무관한 노트끼리도 코사인이 0.74~0.82 에 몰리기 때문에 절대 임계값은 동작하지 않는다. 억지 순위는 그 영역 전체를 무시하게 만든다
- **의미 검색은 어휘 검색을 대체하지 않는다.** 둘을 각각 돌리고 순위로 융합한다(RRF). 임베딩 점수는 좁은 대역에 몰려 있어 원점수 혼합은 노이즈에 뒤집힌다. 모델이 없거나 실패하면 조용히 어휘 검색으로 내려간다
- **정리 호출은 툴 없는 에이전트로 보낸다.** `--agents '{...,"tools":[]}'` + `--agent` + `--effort low`. 이 조합을 벗어나면 호출당 비용이 100배까지 뛴다
- **원문 언어를 보존한다.** 제목·요약·태그는 원문 언어 그대로, `keywords` 만 영어. 교차 언어 검색이 여기에 의존한다

## 알려진 함정

- **pnpm 이 설치 스크립트를 지운 채 스토어에 넣는다.** 빌드가 허용되기 전에 추출된 패키지는 `scripts` 가 `null` 로 남고, 나중에 `allowBuilds` 를 켜도 `pnpm rebuild` 가 실행할 것이 없다. electron 이 이 문제로 바이너리 없이 설치되어 `pnpm desktop` 이 `Error: Electron uninstall` 로 죽었다. 루트 `postinstall` 의 `scripts/ensure-electron.mjs` 가 매 설치마다 복구한다
- **패키징이 성공해도 dev 가 동작한다는 뜻은 아니다.** electron-builder 는 자체 캐시로 Electron 을 따로 받으므로 `node_modules/electron` 이 비어 있어도 설치본은 만들어진다. 둘을 각각 확인한다
- **`loadURL` 의 프라미스는 성공 신호가 아니다.** 리다이렉트가 기존 내비게이션을 대체하면 `ERR_ABORTED(-3)` 로 거부되는데 페이지는 정상적으로 뜬다. `did-finish-load` / `did-fail-load` 를 봐야 한다
- **데스크톱 앱에는 자동 테스트가 없다.** 코어는 38개로 덮여 있지만 렌더러와 메인 프로세스는 기동 확인이 전부다. UI 로만 닿는 경로는 임시 스모크를 붙여 실제로 돌려 보고 걷어낸다
- **Tailwind 를 들이면 클래스 이름 공간이 전역으로 넓어진다.** 임의로 붙인 수식 클래스가 유틸리티 이름과 겹치면 조용히 그 유틸리티의 의미를 갖는다. `.right.fixed` 가 `position: fixed` 가 되어 패널이 그리드에서 튀어나갔다. 수식 클래스에는 접두사를 붙인다
- **레이어 밖 CSS 는 레이어 안 CSS 를 항상 이긴다.** 손CSS 를 `@layer legacy` 로 넣어 `utilities` 아래에 두지 않으면 새 컴포넌트가 전부 옛 규칙에 덮인다
- **그리드 행 수를 자식 개수에 의존시키지 않는다.** `grid-template-rows: auto 1fr auto` 인 셸에 배너를 하나 더 넣자 배너가 `1fr` 을 가져가 본문이 짓눌렸다. 셸은 flex column 으로 둔다
- **종료 순서를 가정하지 않는다.** `before-quit` 은 창이 이미 파괴된 뒤에도 온다. 그때 `contentView` 를 만지면 `Object has been destroyed` 가 이벤트 핸들러에서 던져지고 Electron 이 오류 대화상자를 띄운다. 정리 코드는 `isDestroyed()` 를 확인하고 try/catch 로 감싼다
- **기본 설정을 고쳐도 이미 있는 보관소는 따라오지 않는다.** `loadConfig` 는 저장된 `config.json` 을 기본값 위에 덮으므로, `defaultConfig` 에 확장자를 추가해도 기존 보관소에서는 조용히 무시된다. `.mov` 를 추가하고도 계획이 그대로여서 한참 헤맸다. 목록형 설정을 바꿀 때는 `alx config set` 으로 갱신하는 안내를 함께 낸다
- **e2e 는 그 경로를 실제로 지나가야 의미가 있다.** 브라우저 패널을 한 번도 열지 않는 테스트는 브라우저 정리 코드를 검증하지 못한다. 수정을 되돌려 테스트가 실패하는지 확인한다
