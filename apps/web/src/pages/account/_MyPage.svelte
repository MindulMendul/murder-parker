<script lang="ts">
  import { Panel, Button, Modal } from "../../shared/ui";
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import NicknameField from '../../features/account/NicknameField.svelte';
  import type { Guest } from '@festival/shared';
  import type { WorkshopStory } from '../workshop/model/_story';
  let { me, accountType, locale, busy, onRename, onLogout, onDeleteAccount, onEdit, onWorkshop }: {
    me: Guest; accountType: string | null; locale: 'ko' | 'en'; busy: boolean;
    onRename: (nickname: string) => Promise<void>; onLogout: () => Promise<void>; onDeleteAccount: () => Promise<void>; onEdit: (id: string) => void; onWorkshop: () => void;
  } = $props();
  let nickname = $state(untrack(() => me.nickname)), confirmLogout = $state(false), settings = $state(false), confirmDelete = $state(false);
  let items = $state<WorkshopStory[]>([]), total = $state(0), offset = $state(0), loading = $state(true), error = $state('');
  let deletion = $state<WorkshopStory | null>(null), deleting = $state(false), deleteError = $state('');
  let settingsOpener = $state<HTMLButtonElement>();
  let disposed = false;
  onDestroy(() => { disposed = true; });
  const label = (ko: string, en: string) => locale === 'en' ? en : ko;
  async function load(next = 0) {
    loading = true; error = '';
    try {
      const response = await fetch(`/api/workshop/stories?view=mine&limit=24&offset=${next}`);
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      if (disposed) return;
      if (!data.items.length && next > 0) { await load(Math.max(0, next - 24)); return; }
      items = data.items; total = data.total; offset = next;
    } catch (cause) { error = cause instanceof Error ? cause.message : label('목록을 불러오지 못했어요.', 'Could not load stories.'); }
    finally { loading = false; }
  }
  async function removeDraft() {
    if (!deletion || deleting) return;
    deleting = true; deleteError = '';
    try {
      const response = await fetch(`/api/workshop/drafts/${encodeURIComponent(deletion.id)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw Error(label('초안을 삭제하지 못했어요. 다시 시도해 주세요.', 'Could not delete the draft. Please try again.'));
      if (disposed) return;
      // 404 also means the owner-only draft is already absent (e.g. a retried request).
      deletion = null;
      await load(offset);
      await tick();
      document.getElementById('my-stories-title')?.focus();
    } catch (cause) { if (!disposed) deleteError = cause instanceof Error ? cause.message : label('삭제하지 못했어요.', 'Could not delete.'); }
    finally { if (!disposed) deleting = false; }
  }
  onMount(() => { void load(); });
</script>
<main class="main account-page">
  <div class="page-heading"><div><p class="eyebrow">MY ACCOUNT</p><h1 class="heading-one">{label('마이페이지', 'My page')}</h1><p class="muted">{me.nickname} · {accountType === 'google' ? 'GOOGLE' : 'GUEST'}</p></div><Button variant="secondary" onclick={onWorkshop}>{label('창작마당으로', 'Workshop')} ↗</Button></div>
  <Panel><h2 class="heading-two">{label('닉네임 변경', 'Change nickname')}</h2>
    <form onsubmit={event => { event.preventDefault(); void onRename(nickname); }}>
      <NicknameField bind:value={nickname} {locale} {busy} />
      <Button type="submit" disabled={busy || nickname.trim() === me.nickname}>{label('닉네임 저장', 'Save nickname')}</Button>
    </form>
  </Panel>
  <Panel><h2 id="my-stories-title" tabindex="-1" class="heading-two">{label('내가 만든 창작 머미', 'My stories')} ({total})</h2>
    {#if loading}<p role="status">{label('불러오는 중…', 'Loading…')}</p>
    {:else if error}<p role="alert">{error}</p><Button variant="secondary" onclick={() => void load(offset)}>{label('다시 시도', 'Retry')}</Button>
    {:else if !items.length}<p class="muted">{label('아직 만든 작품이 없어요.', 'You have not created any stories yet.')}</p>
    {:else}<ul>{#each items as item (item.id)}<li><div><strong>{item.title}</strong><p class="muted">{item.published ? label('공개', 'Published') : label('비공개 초안', 'Private draft')}</p></div><div class="story-actions"><Button variant="secondary" disabled={deleting} onclick={() => onEdit(item.id)}>{label('수정하기', 'Edit')} ↗</Button>{#if !item.published}<Button variant="text" disabled={deleting} onclick={() => { deleteError = ''; deletion = item; }}>{label('초안 삭제', 'Delete draft')}</Button>{/if}</div></li>{/each}</ul>{/if}
    {#if total > 24}<nav aria-label={label('내 작품 페이지', 'My stories pages')}><Button variant="secondary" disabled={loading || offset === 0} onclick={() => void load(offset - 24)}>{label('이전', 'Previous')}</Button><Button variant="secondary" disabled={loading || offset + 24 >= total} onclick={() => void load(offset + 24)}>{label('다음', 'Next')}</Button></nav>{/if}
  </Panel>
  {#if settings}
    <Panel>
      <div class="settings-heading"><h2 id="account-settings-title" tabindex="-1" class="heading-two">{label('계정 설정', 'Account settings')}</h2><Button variant="text" onclick={async () => { settings = false; confirmLogout = false; confirmDelete = false; await tick(); settingsOpener?.focus(); }}>{label('설정 닫기', 'Close settings')}</Button></div>
      <section aria-labelledby="sign-out-title">
        <h3 id="sign-out-title">{label('로그아웃', 'Sign out')}</h3>
        <p class="muted">{accountType === 'guest' ? label('게스트는 로그아웃하면 닉네임, 만든 작품과 즐겨찾기가 삭제되며 복구할 수 없어요.', 'Signing out deletes your guest nickname, stories and favorites permanently.') : label('다시 구글 로그인하면 내 작품과 닉네임이 유지돼요.', 'Your nickname and stories will be here when you sign in with Google again.')}</p>
        {#if confirmLogout}<p>{label('로그아웃할까요?', 'Sign out now?')}</p><div class="story-actions"><Button disabled={busy} onclick={() => void onLogout()}>{label('로그아웃 확인', 'Confirm sign out')}</Button><Button variant="secondary" disabled={busy} onclick={() => confirmLogout = false}>{label('취소', 'Cancel')}</Button></div>
        {:else}<Button variant="secondary" disabled={busy} onclick={() => { confirmDelete = false; confirmLogout = true; }}>{label('로그아웃', 'Sign out')}</Button>{/if}
      </section>
      <section aria-labelledby="delete-account-title">
        <h3 id="delete-account-title">{label('회원탈퇴', 'Delete account')}</h3>
        <p class="muted">{label('탈퇴하면 닉네임, 구글 계정 연결, 만든 작품(공개 작품 포함), 즐겨찾기와 모든 로그인 세션이 삭제되며 복구할 수 없어요. 구글 계정 자체는 삭제되지 않아요. 이미 진행한 게임 기록과 익명 통계는 남을 수 있어요.', 'Deleting your account permanently removes your nickname, Google account link, stories (including published stories), favorites and all sign-in sessions. Your Google account itself is not deleted. Previous game records and anonymous statistics may remain.')}</p>
        {#if confirmDelete}<p>{label('계정을 영구 삭제할까요?', 'Permanently delete your account?')}</p><div class="story-actions"><Button disabled={busy} onclick={() => void onDeleteAccount()}>{label('회원탈퇴 확인', 'Confirm account deletion')}</Button><Button variant="secondary" disabled={busy} onclick={() => confirmDelete = false}>{label('취소', 'Cancel')}</Button></div>
        {:else}<Button variant="secondary" disabled={busy} onclick={() => { confirmLogout = false; confirmDelete = true; }}>{label('회원탈퇴', 'Delete account')}</Button>{/if}
      </section>
    </Panel>
  {:else}
    <button bind:this={settingsOpener} class="text-button" onclick={async () => { settings = true; await tick(); document.getElementById('account-settings-title')?.focus(); }}>{label('계정 설정', 'Account settings')}</button>
  {/if}
</main>
{#if deletion}
  <Modal open={true} labelledby="delete-draft-title" onClose={() => { if (!deleting) deletion = null; }}>
    <h2 id="delete-draft-title">{label('초안을 삭제할까요?', 'Delete this draft?')}</h2>
    <p class="draft-title">{deletion.title}</p>
    <p>{label('삭제한 초안은 복구할 수 없어요.', 'Deleted drafts cannot be restored.')}</p>
    {#if deleteError}<p role="alert">{deleteError}</p>{/if}
    <div class="story-actions"><Button variant="secondary" disabled={deleting} onclick={() => { deletion = null; }}>{label('취소', 'Cancel')}</Button>
    <Button disabled={deleting} onclick={() => void removeDraft()}>{deleting ? label('삭제 중…', 'Deleting…') : label('삭제 확인', 'Confirm delete')}</Button></div>
  </Modal>
{/if}
<style>.settings-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--spacing-3)}section+section{margin-top:var(--spacing-6);padding-top:var(--spacing-6);border-top:var(--border-thin) solid var(--color-festival-line)}section p{margin:var(--spacing-4) 0}.story-actions{display:flex;flex-wrap:wrap;gap:var(--spacing-2)}.draft-title{overflow-wrap:anywhere}.account-page li>div{min-width:0;overflow-wrap:anywhere}@media(max-width:640px){.account-page li{flex-wrap:wrap}}.account-page{display:grid;gap:var(--spacing-6)}.account-page form{max-width:100%}.account-page h2{margin-bottom:var(--spacing-4)}ul{list-style:none;padding:0}li{display:flex;align-items:center;justify-content:space-between;gap:var(--spacing-4);border-bottom:var(--border-thin) solid var(--color-festival-line);padding:var(--spacing-4) 0}li :global(.secondary),.page-heading :global(.secondary){width:auto}nav{display:flex;gap:var(--spacing-4)}</style>
