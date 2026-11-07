<script>
  import { Button } from "../../shared/ui";
  import { supportedSoloStory } from '@festival/shared';
  import { rememberSoloExit } from '../../shared/lib/solo-lifecycle';
  import { onMount } from 'svelte';
  import { translate } from '../../shared/lib/i18n.js';
  import { trackEvent } from '../../analytics.js';
  import StoryCuePlayer from './StoryCuePlayer.svelte';
  import StoryRating from './StoryRating.svelte';

  /** @type {{ locale?: 'ko' | 'en', storyId?: string, onExit?: () => void, exitLabel?: string, exitDisabled?: boolean, exitMessage?: string, roomLifecycle?: import('../../shared/lib/solo-lifecycle').SoloExit, onLifecycleExit?: (exit: import('../../shared/lib/solo-lifecycle').SoloExit) => void }} */
  let { locale = 'ko', storyId = supportedSoloStory.id, onExit = () => {}, exitLabel, exitDisabled = false, exitMessage = '', roomLifecycle, onLifecycleExit = () => {} } = $props();
  /** @param {Parameters<typeof translate>[1]} key */
  const t = (key) => translate(locale, key);

  let storyPackage = $state(/** @type {import('@festival/shared').StoryPackage | null} */ (null));
  let storyLoadError = $state('');
  let mechanics = $derived(
    storyPackage?.content.mechanics.type === 'solo-investigation'
      ? storyPackage.content.mechanics
      : null,
  );
  let suspects = $derived(mechanics?.suspects ?? []);
  let evidence = $derived(Object.fromEntries((mechanics?.evidence ?? []).map((item) => [item.id, item])));
  let rooms = $derived((mechanics?.locations ?? []).map((location) => ({ ...location, evidence: location.evidenceIds })));
  let alibis = $derived(Object.fromEntries((mechanics?.alibis ?? []).map(({ suspectId, statements }) => [suspectId, statements])));
  /** @type {Record<string, Record<string, [string, boolean?]>>} */
  let reactions = $derived((mechanics?.reactions ?? []).reduce((bySuspect, item) => {
    bySuspect[item.suspectId] ??= {};
    bySuspect[item.suspectId][item.evidenceId] = [item.lines.join('\n'), item.revealsTruth];
    return bySuspect;
  }, /** @type {Record<string, Record<string, [string, boolean?]>>} */ ({})));
  /** @type {import('@festival/shared').StoryCue[]} */
  let openingCues = $state([]);
  /** @type {import('@festival/shared').StoryCue[]} */
  let resolutionCues = $state([]);
  let hints = $derived(mechanics?.hints ?? {});

  let phase = $state('title');
  let roomId = $state('');
  /** @type {string[]} */
  let found = $state([]);
  let currentEvidence = $state('');
  let selectedSuspect = $state('');
  /** @type {{ text: string, source: string }[]} */
  let responses = $state([]);
  /** @type {string[]} */
  let accusation = $state([]);
  let resultMessage = $state('');
  let hintMessage = $state('');
  let startedAt = $state(0);
  let runId = $state('');
  /** @type {Record<string, number>} */
  let hintIndex = $state({});

  let selectedRoom = $derived(rooms.find((room) => room.id === roomId));
  let selected = $derived(suspects.find((suspect) => suspect.id === selectedSuspect));

  onMount(() => {
    const lifecycle = roomLifecycle;
    const navigationId = crypto.randomUUID();
    const navigation = performance.getEntriesByType('navigation')[0];
    const pageLoadMs = navigation instanceof PerformanceNavigationTiming && navigation.loadEventEnd > 0
      ? navigation.loadEventEnd - navigation.startTime
      : performance.now();
    void fetch('/api/platform/analytics/vitals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        storyId,
        metricName: 'page_load_ms',
        value: Math.max(0, pageLoadMs),
        navigationId,
        route: '/solo',
      }),
    }).catch(() => {});
    void fetch(`/api/game/stories/${encodeURIComponent(storyId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('스토리를 불러오지 못했어.');
        storyPackage = await response.json();
      })
      .catch((error) => {
        storyLoadError = error instanceof Error ? error.message : '스토리를 불러오지 못했어.';
      });
    let exited = false;
    const recordAbandonment = () => {
      if (exited) return;
      exited = true;
      if (lifecycle) {
        rememberSoloExit(sessionStorage, lifecycle);
        onLifecycleExit(lifecycle);
        navigator.sendBeacon('/api/lobby/rooms/solo-exit', new Blob([JSON.stringify(lifecycle)], { type: 'application/json' }));
      }
      if (!startedAt || phase === 'win' || phase === 'fail') return;
      if (runId) navigator.sendBeacon(`/api/game/sessions/${runId}/abandon`, new Blob([], { type: 'application/json' }));
      trackEvent('story_abandon', {
        story_id: storyPackage?.story.id ?? 'deokil-trading-murder',
        play_duration_seconds: Math.round((Date.now() - startedAt) / 1000),
        clue_count: found.length,
        language: locale,
      });
    };
    window.addEventListener('pagehide', recordAbandonment);
    /** @param {PageTransitionEvent} event */
    const restorePage = (event) => { if (event.persisted && lifecycle) location.reload(); };
    window.addEventListener('pageshow', restorePage);
    return () => {
      window.removeEventListener('pagehide', recordAbandonment);
      window.removeEventListener('pageshow', restorePage);
      recordAbandonment();
    };
  });

  async function startOver() {
    if (!storyPackage) return;
    runId = '';
    storyLoadError = '';
    resolutionCues = [];
    try {
      const response = await fetch('/api/game/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyId: storyPackage.story.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '플레이를 시작하지 못했어.');
      runId = data.runId;
      openingCues = data.scene.cues;
      startedAt = Date.parse(data.progress.startedAt);
    } catch (error) {
      storyLoadError = error instanceof Error ? error.message : '플레이를 시작하지 못했어.';
      return;
    }
    trackEvent('story_start', { story_id: storyPackage.story.id, language: locale });
    phase = 'intro';
    roomId = '';
    found = [];
    currentEvidence = '';
    selectedSuspect = '';
    responses = [];
    accusation = [];
    resultMessage = '';
    hintMessage = '';
    hintIndex = {};
  }

  async function finishOpening() {
    if (runId) {
      const response = await fetch(`/api/game/sessions/${runId}/advance`, { method: 'POST' });
      if (!response.ok) {
        const data = await response.json();
        storyLoadError = data.error ?? '다음 장면을 불러오지 못했어.';
        return;
      }
    }
    phase = 'cast';
  }

  /** @param {string} id */
  function enterRoom(id) {
    trackEvent('case_location_open', { story_id: storyPackage?.story.id ?? 'deokil-trading-murder', location_id: id, language: locale });
    roomId = id;
    currentEvidence = '';
  }

  /** @param {string} id */
  async function inspect(id) {
    if (runId) {
      try {
        const response = await fetch(`/api/game/sessions/${runId}/evidence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ evidenceId: id }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? '증거를 확인하지 못했어.');
        found = data.foundEvidenceIds;
      } catch (error) {
        storyLoadError = error instanceof Error ? error.message : '증거를 확인하지 못했어.';
        return;
      }
    }
    trackEvent('case_clue_open', { story_id: storyPackage?.story.id ?? 'deokil-trading-murder', clue_id: id, language: locale });
    if (!found.includes(id)) found = [...found, id];
    currentEvidence = id;
  }

  /** @param {string} id */
  function chooseSuspect(id) {
    selectedSuspect = id;
    responses = [];
  }

  /** @param {number} index */
  function askAlibi(index) {
    trackEvent('case_question', { story_id: storyPackage?.story.id ?? 'deokil-trading-murder', suspect_id: selectedSuspect, question_type: index === 0 ? 'alibi' : 'relationship', language: locale });
    const text = alibis[selectedSuspect][index];
    responses = [...responses, { text, source: index === 0 ? '알리바이' : '피해자와의 관계' }];
  }

  /** @param {string} id */
  function presentEvidence(id) {
    trackEvent('case_evidence_present', { story_id: storyPackage?.story.id ?? 'deokil-trading-murder', suspect_id: selectedSuspect, clue_id: id, language: locale });
    const response = reactions[selectedSuspect]?.[id];
    const text = response?.[0] ?? '…그 증거가 저와 무슨 상관이죠?';
    responses = [...responses, { text, source: evidence[id].name }];
  }

  /** @param {string} id */
  function toggleAccusation(id) {
    trackEvent('case_accusation_evidence_select', { story_id: storyPackage?.story.id ?? 'deokil-trading-murder', clue_id: id, selected: !accusation.includes(id), language: locale });
    if (accusation.includes(id)) accusation = accusation.filter((item) => item !== id);
    else if (accusation.length < 3) accusation = [...accusation, id];
  }

  async function arrest() {
    if (!runId) return;
    const response = await fetch(`/api/game/sessions/${runId}/accuse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suspectId: selectedSuspect, evidenceIds: accusation }),
    });
    const result = await response.json();
    if (!response.ok) {
      storyLoadError = result.error ?? '고발 결과를 확인하지 못했어.';
      return;
    }
    const outcome = result.outcome === 'success' ? 'success' : 'failure';
    trackEvent('story_attempt_end', { story_id: storyPackage?.story.id ?? 'deokil-trading-murder', outcome, clue_count: found.length, play_duration_seconds: Math.round((Date.now() - startedAt) / 1000), language: locale });
    if (result.outcome === 'success') {
      resolutionCues = result.cues;
      phase = 'win';
    } else {
      resultMessage = result.message;
      phase = 'fail';
    }
  }

  function showHint() {
    const list = hints[phase] ?? ['지금은 힌트가 필요 없어요.'];
    const index = Math.min(hintIndex[phase] ?? 0, list.length - 1);
    hintIndex = { ...hintIndex, [phase]: index + 1 };
    hintMessage = list[index];
    trackEvent('case_hint_view', { story_id: storyPackage?.story.id ?? 'deokil-trading-murder', stage: phase, hint_number: index + 1, language: locale });
  }
</script>

<svelte:head><title>{storyPackage?.story.title ?? '덕일상사 살인사건'} · 이상한 축제</title></svelte:head>

{#if storyLoadError}<p class="mx-auto mb-4 max-w-[960px] border border-red-700/50 bg-festival-panel px-5 py-3 text-sm text-red-300" role="alert">{storyLoadError}</p>{/if}
{#if exitMessage}<p class="mx-auto mb-4 max-w-[960px] text-sm text-festival-muted" role="status">{exitMessage}</p>{/if}
{#if hintMessage}
  <aside class="mx-auto mb-6 flex max-w-[960px] items-start justify-between gap-4 border border-festival-gold-border bg-festival-panel px-5 py-4" role="status"><p class="m-0 text-sm leading-[1.9] text-festival-copy"><span class="mr-2 text-festival-gold">힌트</span>{hintMessage}</p><Button class="dismiss" ariaLabel="힌트 닫기" onclick={() => hintMessage = ''} variant="dismiss">×</Button></aside>
{/if}

{#if phase === 'title'}
  <section class="mx-auto max-w-[760px] border border-festival-line bg-festival-panel p-8 text-center max-[520px]:p-5">
    <p class="eyebrow">A CASE FOR ONE DETECTIVE</p>
    <div class="mb-7 border-y border-festival-line py-8">
      <span class="text-5xl text-festival-gold" aria-hidden="true">✳</span>
      <p class="my-4 text-[11px] tracking-[3px] text-festival-muted">{locale === 'en' ? 'DEOKIL TRADING · 23:00' : '덕일상사 · 23:00'}</p>
      <h1 class="m-0 font-serif text-[38px] font-medium leading-[1.5] tracking-[-1px] max-[520px]:text-[30px]">{storyPackage?.story.title ?? t('caseTitle')}</h1>
      <p class="mt-3 text-sm leading-[1.9] text-festival-muted">{storyPackage?.story.subtitle ?? t('caseSubtitle')}</p>
    </div>
    <div class="mx-auto grid max-w-[540px] grid-cols-3 gap-3 text-left max-[520px]:grid-cols-1">
      {#each [{ number: '01', label: '현장 조사' }, { number: '02', label: '진술 검증' }, { number: '03', label: '범인 지목' }] as step}
        <div class="border border-festival-line px-4 py-3"><span class="text-[10px] tracking-[1px] text-festival-gold">{step.number}</span><p class="mb-0 mt-2 text-sm">{step.label}</p></div>
      {/each}
    </div>
    <Button class="primary mx-auto max-w-[540px]" disabled={!storyPackage} onclick={startOver} variant="primary">{t('caseStart')} <span>→</span></Button>
    <button class="mt-5 cursor-pointer border-0 bg-transparent px-3 py-2 text-xs text-festival-muted hover:text-festival-gold disabled:cursor-not-allowed disabled:opacity-50" disabled={exitDisabled} onclick={onExit}>{exitLabel ?? t('backToPlatform')}</button>
  </section>
{:else if phase === 'intro'}
  {#if openingCues.length}<StoryCuePlayer cues={openingCues} onComplete={finishOpening} />{/if}
{:else if phase === 'cast'}
  <section class="mx-auto max-w-[840px]">
    <p class="eyebrow">THE SUSPECTS</p><h1 class="heading-one page-title">{t('suspectsTitle')}</h1><p class="muted mb-7">{t('suspectDescription')}</p>
    <div class="grid grid-cols-2 gap-4 max-[650px]:grid-cols-1">
      <article class="panel"><span class="eyebrow">{t('victim')}</span><h2 class="heading-two mb-2">{mechanics?.victim.name}</h2><p class="muted">{mechanics?.victim.details}</p></article>
      {#each suspects as suspect, i}
        <article class="panel"><div class="section-heading"><span class="eyebrow section-eyebrow">SUSPECT 0{i + 1}</span><span class="tag">{t('suspect')}</span></div><h2 class="heading-two mb-2 mt-4">{suspect.name}</h2><p class="muted">{suspect.details}</p></article>
      {/each}
    </div>
    <Button class="primary mt-6" onclick={() => { phase = 'explore'; }} variant="primary">{t('investigate')} <span>→</span></Button>
  </section>
{:else if phase === 'explore'}
  <section class="mx-auto max-w-[960px]">
    <div class="page-heading"><div><p class="eyebrow">INVESTIGATION · 01</p><h1 class="heading-one page-title">{t('investigate')}</h1><p class="muted">{t('investigationDescription')}</p></div><span class="tag gold">{t('collectedEvidence')} {found.length} / {mechanics?.evidence.length ?? 0}</span></div>
    <div class="lobby-grid"><section class="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
      {#each rooms as room}
        <button class="cursor-pointer border bg-festival-panel p-5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-festival-gold {roomId === room.id ? 'border-festival-gold' : 'border-festival-line hover:border-festival-gold-border'}" onclick={() => enterRoom(room.id)}>
          <span class="text-[10px] tracking-[1.5px] text-festival-gold">LOCATION</span>
          <h2 class="mb-1 mt-3 font-serif text-[19px] font-medium">{room.name}</h2><p class="muted">{room.mood}</p>
          <span class="mt-4 block text-xs text-festival-muted">{t('cluePlural')} {room.evidence.filter((id) => found.includes(id)).length} / {room.evidence.length}</span>
        </button>
      {/each}
    </section><aside class="panel min-h-[210px]">
      {#if selectedRoom}
        <p class="eyebrow">SEARCH THE ROOM</p><h2 class="heading-two">{selectedRoom.name}</h2><p class="muted">{selectedRoom.mood}</p>
        <div class="grid gap-2">{#each selectedRoom.evidence as id}<Button class="secondary mt-0" onclick={() => inspect(id)} variant="secondary"><span>{found.includes(id) ? '✓ ' : ''}{evidence[id].name}</span><span>↗</span></Button>{/each}</div>
        {#if currentEvidence}<div class="mt-5 border-t border-festival-line pt-4"><p class="mb-2 text-xs text-festival-gold">{evidence[currentEvidence].icon} {evidence[currentEvidence].name}</p><p class="m-0 text-sm leading-[1.9] text-festival-copy-soft">{evidence[currentEvidence].detail}</p></div>{/if}
      {:else}<p class="eyebrow">CRIME SCENE</p><h2 class="heading-two">{t('whereStart')}</h2><p class="muted">{t('searchRoom')}</p>{/if}
    </aside></div>
    <div class="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-festival-line pt-5"><Button class="text-button" onclick={showHint} variant="text">{t('hint')}</Button><Button class="primary mt-0 w-auto min-w-[230px]" onclick={() => { phase = 'alibi'; selectedSuspect = ''; }} variant="primary">{t('exploreNext')} <span>→</span></Button></div>
  </section>
{:else if phase === 'alibi' || phase === 'cross'}
  <section class="mx-auto max-w-[960px]">
    <div class="page-heading"><div><p class="eyebrow">INTERROGATION · {phase === 'alibi' ? '02' : '03'}</p><h1 class="heading-one page-title">{phase === 'alibi' ? t('interview') : t('presentEvidence')}</h1><p class="muted">{t('interrogationDescription')}</p></div><span class="tag gold">{t('evidenceCount')} {found.length}</span></div>
    <nav class="steps" aria-label="수사 단계"><span class="step">{t('stageOne')}</span><span class:active={phase === 'alibi'} class="step">{t('stageTwo')}</span><span class:active={phase === 'cross'} class="step">{t('stageThree')}</span><span class="step">{t('stageFour')}</span></nav>
    <div class="lobby-grid"><section class="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">{#each suspects as suspect}
      <button class="cursor-pointer border bg-festival-panel p-5 text-left focus-visible:outline-2 focus-visible:outline-festival-gold {selectedSuspect === suspect.id ? 'border-festival-gold' : 'border-festival-line hover:border-festival-gold-border'}" onclick={() => chooseSuspect(suspect.id)}><span class="text-[10px] tracking-[1px] text-festival-muted">SUSPECT</span><h2 class="mb-2 mt-3 font-serif text-[20px] font-medium">{suspect.name}</h2><p class="m-0 text-xs leading-[1.8] text-festival-muted">{suspect.details}</p></button>
    {/each}</section><aside class="panel min-h-[300px]">
      {#if selected}
        <p class="eyebrow">QUESTION · {selected.name}</p><h2 class="heading-two">{t('chooseQuestion')}</h2>
        {#if phase === 'alibi'}<div class="grid gap-2"><Button class="secondary mt-0" onclick={() => askAlibi(0)} variant="secondary">{t('askAlibi')} <span>↗</span></Button><Button class="secondary mt-0" onclick={() => askAlibi(1)} variant="secondary">{t('askRelationship')} <span>↗</span></Button></div>
        {:else}<p class="muted mb-3">{t('showEvidence')}</p>{#if found.length}<div class="grid max-h-[230px] gap-2 overflow-auto">{#each found as id}<Button class="secondary mt-0" onclick={() => presentEvidence(id)} variant="secondary"><span>{evidence[id].icon} {evidence[id].name}</span><span>↗</span></Button>{/each}</div>{:else}<p class="muted">{t('noEvidence')}</p>{/if}{/if}
        <div class="mt-5 grid gap-3">{#each responses.slice().reverse() as response}<blockquote class="m-0 border-l-2 border-festival-gold-border bg-festival-panel-input px-4 py-3"><span class="text-[10px] tracking-[1px] text-festival-gold">{response.source}</span><p class="mb-0 mt-2 text-sm leading-[1.9] text-festival-copy">“{response.text}”</p></blockquote>{/each}</div>
      {:else}<p class="eyebrow">INTERVIEW NOTES</p><h2 class="heading-two">{t('chooseSuspect')}</h2><p class="muted">{t('compareStatements')}</p>{/if}
    </aside></div>
    <div class="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-festival-line pt-5"><Button class="text-button" onclick={showHint} variant="text">{t('hint')}</Button><div class="flex flex-wrap gap-3"><Button class="secondary mt-0 w-auto" onclick={() => { phase = phase === 'alibi' ? 'explore' : 'alibi'; selectedSuspect = ''; }} variant="secondary">← {t('previous')}</Button>{#if phase === 'alibi'}<Button class="primary mt-0 w-auto min-w-[190px]" onclick={() => { phase = 'cross'; selectedSuspect = ''; }} variant="primary">{t('presentEvidence')} <span>→</span></Button>{:else}<Button class="primary mt-0 w-auto min-w-[190px]" onclick={() => { phase = 'accuse'; selectedSuspect = ''; accusation = []; }} variant="primary">{t('accusationTitle')} <span>→</span></Button>{/if}</div></div>
  </section>
{:else if phase === 'accuse'}
  <section class="mx-auto max-w-[960px]">
    <p class="eyebrow">FINAL · 04</p><h1 class="heading-one page-title">{t('accusationTitle')}</h1><p class="muted mb-7">{t('accusationDescription')}</p>
    <div class="lobby-grid"><section class="panel"><h2 class="heading-two">{t('culpritQuestion')}</h2><div class="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">{#each suspects as suspect}<button class="cursor-pointer border p-4 text-left focus-visible:outline-2 focus-visible:outline-festival-gold {selectedSuspect === suspect.id ? 'border-festival-gold bg-festival-panel-hover' : 'border-festival-line bg-transparent hover:border-festival-gold-border'}" onclick={() => chooseSuspect(suspect.id)}><span class="text-xs text-festival-muted">{selectedSuspect === suspect.id ? `● ${t('selectedLabel')}` : `○ ${t('selectLabel')}`}</span><h3 class="heading-three mb-0 mt-2">{suspect.name}</h3></button>{/each}</div></section><aside class="panel"><div class="section-heading"><h2 class="heading-two mb-0">{t('decisiveEvidence')}</h2><span class="tag gold">{accusation.length} / 3</span></div><p class="muted my-4">{t('chooseThreeEvidence')}</p><div class="grid max-h-[390px] gap-2 overflow-auto">{#each found as id}<Button class="secondary mt-0" onclick={() => toggleAccusation(id)} variant="secondary"><span>{accusation.includes(id) ? '☑' : '☐'} {evidence[id].icon} {evidence[id].name}</span><span>{accusation.includes(id) ? t('selectedLabel') : ''}</span></Button>{/each}</div></aside></div>
    <div class="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-festival-line pt-5"><Button class="text-button" onclick={showHint} variant="text">{t('hint')}</Button><div class="flex gap-3"><Button class="secondary mt-0 w-auto" onclick={() => { phase = 'cross'; selectedSuspect = ''; }} variant="secondary">{t('reviewEvidence')}</Button><Button class="primary mt-0 w-auto min-w-[190px]" disabled={!selectedSuspect || accusation.length !== 3} onclick={arrest} variant="primary">{t('arrest')} <span>→</span></Button></div></div>
  </section>
{:else if phase === 'win'}
  <section class="mx-auto max-w-[760px] border border-festival-gold-border bg-festival-panel p-8 text-center max-[520px]:p-5"><p class="eyebrow">{t('allCaught')}</p><h1 class="heading-one page-title">{t('success')}</h1><p class="muted">{t('successDescription')}</p>{#if resolutionCues.length}<div class="mt-8"><StoryCuePlayer cues={resolutionCues} onComplete={() => {}} /></div>{/if}<StoryRating {runId} /><Button class="primary mt-7" onclick={startOver} variant="primary">{t('replay')} <span>↻</span></Button><button class="mt-4 cursor-pointer border-0 bg-transparent px-3 py-2 text-xs text-festival-muted hover:text-festival-gold disabled:cursor-not-allowed disabled:opacity-50" disabled={exitDisabled} onclick={onExit}>{exitLabel ?? t('backToPlatform')}</button></section>
{:else}
  <section class="mx-auto max-w-[680px] border border-festival-line bg-festival-panel p-8 text-center max-[520px]:p-5"><p class="eyebrow">{t('caseUnresolved')}</p><span class="text-5xl text-festival-gold" aria-hidden="true">…</span><h1 class="heading-one page-title mt-5">{t('unresolved')}</h1><p class="narrative">{resultMessage}</p><StoryRating {runId} /><div class="mt-7 grid gap-3 sm:grid-cols-2"><Button class="primary mt-0" onclick={startOver} variant="primary">{t('restart')} <span>↻</span></Button><Button class="secondary mt-0" disabled={exitDisabled} onclick={onExit} variant="secondary">{exitLabel ?? t('backToPlatform')} <span>↗</span></Button></div></section>
{/if}
