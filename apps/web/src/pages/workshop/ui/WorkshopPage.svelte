<script lang="ts">
  import { Modal, Button, Select, TextInput, FilterBar, StateMessage } from "../../../shared/ui";
  import { onDestroy, tick, untrack } from 'svelte';
  import { workshopRequest, type WorkshopStory } from '../model/_story';
  let { locale, loggedIn = false, onLogin, onEdit, onPlay }: {
    locale: 'ko' | 'en'; loggedIn?: boolean; onLogin: (resume?: () => void) => void; onEdit: (id?: string) => void; onPlay: (id: string) => void;
  } = $props();
  const label = (ko: string, en: string) => locale === 'en' ? en : ko;
  let stories = $state<WorkshopStory[]>([]), total = $state(0), offset = $state(0);
  let loading = $state(true), error = $state(''), query = $state(''), author = $state('');
  let view = $state('all'), sort = $state('latest'), mode = $state(''), difficulty = $state('');
  let ratingMin = $state(''), playsMin = $state(''), favoritesMin = $state(''), publishedAfter = $state('');
  let selected = $state<WorkshopStory | null>(null);
  let dialog = $state<HTMLDialogElement>(undefined!);
  let favoriteBusy = $state<string[]>([]);
  let disposed = false;
  let request = 0, pendingOffset = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const pageSize = 24;
  const tabs = [
    { key: 'all', ko: '최신 순', en: 'Latest', sort: 'latest' },
    { key: 'favorites', ko: '즐겨찾기', en: 'Favorites', sort: 'latest' },
    { key: 'rating', ko: '최고 평점', en: 'Top rated', sort: 'rating' },
    { key: 'plays', ko: '플레이 횟수', en: 'Most played', sort: 'plays' },
    { key: 'mine', ko: '내가 만든 목록', en: 'My stories', sort: 'latest' },
  ];
  let tab = $state('all');
  const filters = $derived({ q: query.trim(), author: author.trim(), mode, difficulty, ratingMin, playsMin, favoritesMin, publishedAfter });
  const activeFilterCount = $derived(Object.values(filters).filter(Boolean).length);
  async function load(nextOffset = 0) {
    if (disposed) return;
    pendingOffset = nextOffset;
    const version = ++request;
    loading = true; error = '';
    try {
      const params = new URLSearchParams({ view, sort, limit: String(pageSize), offset: String(nextOffset) });
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      const data = await workshopRequest(`/stories?${params}`);
      if (version !== request) return;
      if (nextOffset > 0 && nextOffset >= data.total) {
        await load(data.total ? Math.floor((data.total - 1) / pageSize) * pageSize : 0);
        return;
      }
      stories = data.items; total = data.total; offset = nextOffset;
    } catch (cause) {
      if (!disposed && version === request) error = cause instanceof Error ? cause.message : label('목록을 불러오지 못했어요.', 'Could not load stories.');
    } finally { if (version === request) loading = false; }
  }
  function schedule() {
    clearTimeout(timer); pendingOffset = 0; request++; loading = true; error = '';
    timer = setTimeout(() => void load(0), 250);
  }
  function refresh() { clearTimeout(timer); pendingOffset = 0; request++; loading = true; queueMicrotask(() => void load(0)); }
  function chooseTab(next: typeof tabs[number]) {
    if (disposed) return;
    if ((next.key === 'favorites' || next.key === 'mine') && !loggedIn) { onLogin(() => chooseTab(next)); return; }
    tab = next.key; view = next.key === 'favorites' || next.key === 'mine' ? next.key : 'all'; sort = next.sort; refresh();
  }
  function edit(id?: string) { onEdit(id); }
  async function favorite(story: WorkshopStory) {
    if (disposed) return;
    if (!loggedIn) { onLogin(() => void favorite(story)); return; }
    if (favoriteBusy.includes(story.id)) return;
    favoriteBusy = [...favoriteBusy, story.id];
    const version = request;
    error = '';
    try {
      const { item } = await workshopRequest(`/stories/${encodeURIComponent(story.id)}/favorite`, { method: story.isFavorite ? 'DELETE' : 'PUT' });
      if (disposed) return;
      if (selected?.id === item.id) selected = item;
      clearTimeout(timer);
      await load(loading ? pendingOffset : offset);
    } catch (cause) { if (!disposed && version === request) error = cause instanceof Error ? cause.message : label('즐겨찾기를 저장하지 못했어요.', 'Could not save favorite.'); }
    finally { if (!disposed) favoriteBusy = favoriteBusy.filter(id => id !== story.id); }
  }
  async function details(story: WorkshopStory) { selected = story; await tick(); dialog.showModal(); }
  function reset() {
    query = ''; author = ''; mode = ''; difficulty = ''; ratingMin = ''; playsMin = ''; favoritesMin = ''; publishedAfter = ''; refresh();
  }
  const difficultyLabel = (value: WorkshopStory['difficulty']) => value === 'easy' ? label('쉬움', 'Easy') : value === 'normal' ? label('보통', 'Normal') : value === 'hard' ? label('어려움', 'Hard') : label('미지정', 'Unspecified');
  $effect(() => {
    const authenticated = loggedIn;
    untrack(() => {
      if (!authenticated && view !== 'all') { view = 'all'; tab = 'all'; }
      clearTimeout(timer); void load(0);
    });
  });
  onDestroy(() => { disposed = true; clearTimeout(timer); request++; });
</script>

<main class="main workshop">
  <div class="page-heading">
    <div><p class="eyebrow">COMMUNITY STORIES</p><h1 class="heading-one">{label('창작마당', 'Workshop')}</h1><p class="muted">{label('누군가의 상상에서 시작된 이야기. 다음 이야기는 당신이 만들어 보세요.', 'Discover stories from the community. Create the next one yourself.')}</p></div>
    <Button class="primary" onclick={() => edit()} variant="primary">＋ {label('새 머미 만들기', 'Create a story')}</Button>
  </div>
  <a class="text-button" href={locale === 'en' ? '/en/' : '/'}>← {label('플랫폼으로 돌아가기', 'Back to platform')}</a>
  <nav class="tabs" aria-label={label('창작 머미 목록', 'Story collections')}>
    {#each tabs as item}<button class="tab" class:active={tab === item.key} aria-pressed={tab === item.key} onclick={() => chooseTab(item)}>{label(item.ko, item.en)}</button>{/each}
  </nav>
  <details class="filter-disclosure">
    <summary>
      <span class="filter-title">{label('작품 필터', 'Story filters')}<span aria-live="polite" aria-atomic="true">{#if activeFilterCount}<span class="filter-count" aria-label={label(`적용 중인 필터 ${activeFilterCount}개`, `${activeFilterCount} active filters`)}>{activeFilterCount}</span>{/if}</span></span>
      <span class="filter-hint">{label('원하는 이야기를 찾아보세요', 'Find a story for you')} <span class="filter-chevron" aria-hidden="true">⌄</span></span>
    </summary>
  <FilterBar label={label('작품 필터', 'Story filters')} class="workshop-filters">
    <label>{label('제목·설명', 'Title / description')}<TextInput type="search" maxlength={100} bind:value={query} oninput={schedule} placeholder={label('어떤 이야기를 찾으세요?', 'Find your next story')}  /></label>
    <label>{label('만든 이', 'Creator')}<TextInput type="search" maxlength={100} bind:value={author} oninput={schedule} placeholder={label('제작자 이름', 'Creator name')}  /></label>
    <label>{label('평점', 'Rating')}<Select bind:value={ratingMin} onchange={refresh}><option value="">{label('전체 평점', 'Any rating')}</option>{#each [1,2,3,4,5] as rating}<option value={String(rating)}>{rating} ★ {label('이상', 'and up')}</option>{/each}</Select></label>
    <label>{label('플레이 횟수', 'Play count')}<input class="input-field" type="number" min="0" max="1000000000" step="1" bind:value={playsMin} oninput={schedule} placeholder={label('최소 횟수', 'Minimum plays')} /></label>
    <label>{label('즐겨찾기 수', 'Favorite count')}<input class="input-field" type="number" min="0" max="1000000000" step="1" bind:value={favoritesMin} oninput={schedule} placeholder={label('최소 수', 'Minimum favorites')} /></label>
    <label>{label('난이도', 'Difficulty')}<Select bind:value={difficulty} onchange={refresh}><option value="">{label('모든 난이도', 'Any difficulty')}</option><option value="easy">{label('쉬움', 'Easy')}</option><option value="normal">{label('보통', 'Normal')}</option><option value="hard">{label('어려움', 'Hard')}</option><option value="unset">{label('미지정', 'Unspecified')}</option></Select></label>
    <label>{label('모드', 'Mode')}<Select bind:value={mode} onchange={refresh}><option value="">{label('모든 모드', 'Any mode')}</option><option value="solo">{label('혼자 플레이', 'Solo')}</option><option value="multiplayer">{label('함께 플레이', 'Multiplayer')}</option></Select></label>
    <label>{label('공개일 이후', 'Published since')}<TextInput type="date" bind:value={publishedAfter} onchange={refresh}  /></label>
    <label>{label('정렬', 'Sort by')}<Select bind:value={sort} onchange={refresh}><option value="latest">{label('최신 순', 'Newest')}</option><option value="rating">{label('최고 평점', 'Top rated')}</option><option value="plays">{label('플레이 횟수', 'Most played')}</option><option value="favorites">{label('즐겨찾기 수', 'Most favorited')}</option><option value="title">{label('제목 순', 'Title')}</option></Select></label>
    <Button class="secondary reset" onclick={reset} variant="secondary">{label('필터 초기화', 'Reset filters')}</Button>
  </FilterBar>
  </details>
  <div class="results"><span class="muted" aria-live="polite">{label('작품', 'Stories')} {total}</span>{#if !loggedIn}<span class="muted">{label('로그인하면 창작과 즐겨찾기를 이용할 수 있어요.', 'Sign in to create stories and save favorites.')}</span>{/if}</div>
  {#if error}<div class="panel notice" role="alert"><p>{error}</p><Button class="secondary" onclick={() => void load(pendingOffset)} variant="secondary">{label('다시 시도', 'Retry')}</Button></div>{/if}
  {#if loading}<StateMessage kind="loading" message={label('이야기를 불러오는 중…', 'Loading stories…')} />
  {:else if !stories.length}<div class="empty"><span class="empty-symbol">✧</span><h2 class="heading-three">{label('아직 일치하는 이야기가 없어요.', 'No stories match yet.')}</h2><p class="muted">{label('필터를 바꾸거나 새로운 이야기를 만들어 보세요.', 'Try different filters or create a story.')}</p></div>
  {:else}
    <div class="story-grid">{#each stories as story (story.id)}
      <article class="panel story-card">
        <div class="thumbnail">{#if story.thumbnailUrl}<img src={story.thumbnailUrl} alt={story.title} loading="lazy" referrerpolicy="no-referrer" />{:else}<span aria-hidden="true">✧</span><span class="thumbnail-caption">STORY ARCHIVE</span>{/if}<span class="mode-tag">{story.mode === 'solo' ? label('혼자 플레이', 'Solo') : label('함께 플레이', 'Multiplayer')}</span></div>
        <div class="card-content"><div class="card-heading"><span class="tag">{difficultyLabel(story.difficulty)}</span>{#if !story.published}<span class="tag">{label('비공개 초안', 'Private draft')}</span>{/if}</div>
        <h2 class="heading-two">{story.title}</h2><p class="muted description">{story.subtitle}</p><p class="creator">{label('만든 이', 'By')} · {story.author.name}</p>
        <div class="statistics"><span>★ {story.averageRating === null ? label('평가 전', 'Unrated') : story.averageRating.toFixed(1)} <small>({story.ratingCount})</small></span><span>▷ {story.playCount} {label('플레이', 'plays')}</span><span>♡ {story.favoriteCount}</span></div>
        <div class="card-actions"><Button class="secondary" onclick={() => details(story)} variant="secondary">{label('자세히 보기', 'Details')}</Button>{#if story.published}<button class="favorite" class:saved={story.isFavorite} aria-pressed={story.isFavorite} aria-label={`${story.title} ${label('즐겨찾기', 'favorite')}`} disabled={favoriteBusy.includes(story.id)} onclick={() => void favorite(story)}>{story.isFavorite ? '♥' : '♡'}</button>{/if}{#if story.canEdit}<Button class="text-button" onclick={() => edit(story.id)} variant="text">{label('수정하기', 'Edit')} ↗</Button>{/if}</div>
        </div>
      </article>
    {/each}</div>
    {#if total > pageSize}<nav class="pagination" aria-label={label('작품 페이지', 'Story pages')}><Button class="secondary" disabled={loading || offset === 0} onclick={() => void load(Math.max(0, offset-pageSize))} variant="secondary">← {label('이전', 'Previous')}</Button><span class="muted">{offset+1}–{Math.min(offset+pageSize,total)} / {total}</span><Button class="secondary" disabled={loading || offset+pageSize >= total} onclick={() => void load(offset+pageSize)} variant="secondary">{label('다음', 'Next')} →</Button></nav>{/if}
  {/if}
</main>
<Modal bind:element={dialog} class="story-dialog" labelledby="story-dialog-title" onClose={() => selected = null}>
  {#if selected}<div class="dialog-content"><p class="eyebrow">STORY DETAILS</p><h2 id="story-dialog-title" class="heading-two">{selected.title}</h2><p class="muted">{selected.subtitle}</p><p>{label('만든 이', 'Creator')}: {selected.author.name}</p><p>{label('난이도', 'Difficulty')}: {difficultyLabel(selected.difficulty)}</p><p>★ {selected.averageRating?.toFixed(1) ?? label('평가 전', 'Unrated')} · {selected.playCount} {label('플레이', 'plays')} · ♡ {selected.favoriteCount}</p><p class="muted">{selected.playerCount.min}–{selected.playerCount.max} {label('명', 'players')} · {selected.estimatedMinutes} {label('분', 'min')}</p><p class="muted">{selected.published && selected.mode === 'solo' ? label('공개된 1인 추리 작품을 플레이할 수 있어요. 지원하지 않는 진행 방식은 시작 전에 안내합니다.', 'Play a published solo investigation. Unsupported story formats are checked before play starts.') : label('공개된 1인 추리 작품만 플레이할 수 있어요.', 'Only published solo investigations can be played.')}</p><div class="card-actions">{#if selected.published && selected.mode === 'solo'}<Button variant="primary" class="primary" onclick={() => { const id = selected!.id; dialog.close(); onPlay(id); }}>{label('플레이하기', 'Play story')} →</Button>{/if}<Button class="secondary" onclick={() => dialog.close()} variant="primary">{label('닫기', 'Close')}</Button>{#if selected.canEdit}<Button class="secondary" onclick={() => { const id = selected!.id; dialog.close(); edit(id); }} variant="secondary">{label('수정하기', 'Edit')}</Button>{/if}</div></div>{/if}
</Modal>
<style>
.workshop {
  padding-bottom:var(--spacing-16)}
.workshop :global(.primary),.workshop :global(.secondary),:global(.story-dialog) :global(.primary),:global(.story-dialog) :global(.secondary) {
  width:auto;
  margin-top:0}
.filter-disclosure {
  border:var(--border-thin) solid var(--color-workshop-line);
  background:var(--color-workshop-thumbnail)}
.filter-disclosure summary {
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:var(--spacing-3);
  padding:var(--spacing-4) var(--spacing-5);
  cursor:pointer;
  list-style:none}
.filter-disclosure summary::-webkit-details-marker { display:none }
.filter-disclosure summary:focus-visible {
  outline:2px solid var(--color-workshop-accent);
  outline-offset:3px}
.filter-title,.filter-hint {
  display:flex;
  align-items:center;
  gap:var(--spacing-3)}
.filter-title { color:var(--color-workshop-accent-text) }
.filter-count {
  border-radius:var(--spacing-4);
  padding:0 var(--spacing-2);
  background:var(--color-workshop-selected);
  color:var(--color-workshop-accent);
  font-size:var(--typography-size-body-sm)}
.filter-hint {
  color:var(--color-workshop-muted);
  font-size:var(--typography-size-body-sm)}
.filter-chevron { display:inline-block }
.filter-disclosure[open] .filter-chevron { transform:rotate(180deg) }
.workshop :global(.workshop-filters) {
  border:0;
  border-top:var(--border-thin) solid var(--color-workshop-line);
  background:transparent;
  margin:0}
.tabs {
  display:flex;
  flex-wrap:wrap;
  gap:var(--spacing-2);
  margin:var(--spacing-8) 0 var(--spacing-4)}
.tabs .tab {
  padding:var(--spacing-2-8) var(--spacing-4);
  border:var(--border-thin) solid var(--color-workshop-line);
  color:var(--color-workshop-muted);
  background:transparent;
  cursor:pointer}
.tabs .tab.active {
  border-color:var(--color-workshop-accent);
  color:var(--color-workshop-accent-text);
  background:var(--color-workshop-selected)}
:global(.reset) {
  align-self:end}
.results {
  display:flex;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:var(--spacing-4);
  margin:var(--spacing-6) 0;
  font-size:var(--typography-size-control-3-2)}
.story-grid {
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--layout-size-290-px)),1fr));
  gap:var(--spacing-6)}
.story-card {
  padding:0;
  overflow:hidden;
  display:flex;
  flex-direction:column}
.thumbnail {
  position:relative;
  height:var(--layout-size-180-px);
  display:flex;
  flex-direction:column;
  justify-content:center;
  align-items:center;
  background:radial-gradient(ellipse at top,var(--color-workshop-thumbnail),var(--color-festival-bg));
  color:var(--color-workshop-accent);
  font-size:var(--typography-size-control-12);
  border-bottom:var(--border-thin) solid var(--color-workshop-line)}
.thumbnail img {
  width:100%;
  height:100%;
  object-fit:cover}
.thumbnail-caption {
  font-size:var(--typography-size-control-2-4);
  letter-spacing:.25em}
.mode-tag {
  position:absolute;
  bottom:var(--spacing-3);
  left:var(--spacing-4);
  background:var(--color-workshop-overlay);
  padding:var(--spacing-1-4) var(--spacing-2-6);
  font-size:var(--typography-size-control-2-6)}
.card-content {
  display:flex;
  flex:1;
  flex-direction:column;
  padding:var(--spacing-5)}
.card-heading {
  display:flex;
  gap:var(--spacing-2);
  margin-bottom:var(--spacing-4)}
.description {
  flex:1;
  line-height:1.7;
  white-space:pre-wrap;
  overflow-wrap:anywhere}
.creator {
  font-size:var(--typography-size-control-3);
  color:var(--color-workshop-muted);
  margin:var(--spacing-4) 0}
.statistics {
  display:flex;
  flex-wrap:wrap;
  gap:var(--spacing-4);
  font-size:var(--typography-size-control-3);
  color:var(--color-workshop-accent);
  border-top:var(--border-thin) solid var(--color-workshop-line);
  padding:var(--spacing-4) 0}
.statistics small {
  color:var(--color-workshop-muted)}
.card-actions {
  display:flex;
  align-items:center;
  flex-wrap:wrap;
  gap:var(--spacing-2-6)}
.favorite {
  padding:var(--spacing-2) var(--spacing-3-2);
  border:var(--border-thin) solid var(--color-workshop-border);
  background:transparent;
  color:var(--color-workshop-accent);
  font-size:var(--typography-size-control-4-8)}
.favorite.saved {
  background:var(--color-workshop-favorite)}
.pagination {
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-top:var(--spacing-8);
  gap:var(--spacing-4)}
.dialog-content {
  padding:var(--spacing-8);
  overflow-wrap:anywhere}
.notice {
  margin:var(--spacing-4) 0}
button:disabled {
  opacity:.5;
  cursor:wait}

</style>
