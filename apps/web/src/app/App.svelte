<script lang="ts">
  import MyPage from "../pages/account/_MyPage.svelte";
  import NicknameField from "../features/account/NicknameField.svelte";
  import type { Guest } from "@festival/shared";
  import { Modal, Button, Panel, PageState } from "../shared/ui";
  import { syncMetadata } from "../shared/seo/client";
  import { pageMetadata } from "../shared/seo/metadata";
  import { onMount, tick } from "svelte";
  import type { Command, ServerEvent, Snapshot } from "@festival/shared";
  import { SoloGame } from "../pages/solo";
  import { clearSoloExit, matchesSoloExit, pendingSoloExit, type SoloExit } from "../shared/lib/solo-lifecycle";
  import { getLocaleFromPath, localePath, translate } from "../shared/lib";

  import { EntryPage } from "../pages/entry";
  import { GamePage } from "../pages/game";
  import { LobbyPage } from "../pages/lobby";
  import { WorkshopPage } from "../pages/workshop/_index";
  import WorkshopEditor from "../pages/workshop/ui/WorkshopEditor.svelte";
  import { RoomPage } from "../pages/room";
  import { AppFooter } from "../widgets/app-footer";
  import LegalLinks from "../widgets/app-footer/ui/LegalLinks.svelte";
  import { AppHeader } from "../widgets/app-header";
  import { ErrorNotice } from "../widgets/error-notice";
  import { StoryPickerDialog } from "../widgets/story-picker";

  let snapshot = $state<Snapshot | null>(null);
  let account = $state<{ me: Guest | null; accountType: string | null; needsNickname: boolean }>({ me: null, accountType: null, needsNickname: false });
  let authConfig = $state({ google: false, demo: false });
  let nickname = $state("");
  let code = $state("");
  let error = $state("");
  let busy = $state(false);
  let connected = $state(false);
  let loading = $state(true);
  let accountLoaded = false;
  let soloRecovery = $state<SoloExit | null>(null);
  let ownedSoloPlayId = $state<string | null>(null);
  let soloStartRequest: { requestId: string; roomId: string } | null = null;
  let soloEndedNotice = $state(false);
  let picker = $state(false);
  let copied = $state(false);
  let locale = $state<"ko" | "en">(getLocaleFromPath(location.pathname));
  const pagePath = (pathname: string) => pathname.replace(/^\/en(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  let currentPath = $state(pagePath(location.pathname));
  let loginDialog = $state<HTMLDialogElement>(undefined!);
  let pendingWorkshopAction: (() => void) | undefined;
  type AuthDestination = { page: "workshop" | "editor" | "account"; id?: string };
  let pendingAuthDestination: AuthDestination | undefined;
  let pendingGoogleAction: (() => void) | undefined;
  let editorPath = $derived(currentPath === "/workshop/editor");
  let entryHome = $derived(currentPath === "/" && snapshot === null);
  let editorHasChanges = $state(false);
  let editorId = $state<string | undefined>(new URLSearchParams(location.search).get("id") ?? undefined);
  $effect(() => { syncMetadata(localePath(locale, currentPath)); });
  const t = (key: string) => translate(locale, key as Parameters<typeof translate>[1]);

  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  let room = $derived(snapshot?.room ?? null);
  let session = $derived(room?.session ?? null);
  let host = $derived(room?.hostId === snapshot?.me.id);
  let canStart = $derived(
    !!room && room.count === room.capacity && room.members.every((member) => member.online),
  );

  async function api(path: string, body?: unknown) {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data.error ?? "요청에 실패했어."), { status: response.status });
    }
    return data;
  }

  async function action(run: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await run();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "연결을 확인해 줘.";
    } finally {
      busy = false;
    }
  }

  function connect() {
    if (disposed) return;
    socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/lobby/ws`);
    socket.onopen = () => {
      connected = true;
      error = "";
    };
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ServerEvent;
        if (event.type === "snapshot") {
          snapshot = event.data;
          if (ownedSoloPlayId !== snapshot.room?.soloPlayId) ownedSoloPlayId = null;
          if (soloRecovery && !matchesSoloExit(soloRecovery, snapshot.room)) {
            clearSoloExit(sessionStorage, soloRecovery);
            soloRecovery = null;
            soloEndedNotice = !snapshot.room?.soloStarted;
          }
        } else {
          if (soloStartRequest && soloStartRequest.requestId === event.requestId) {
            if (event.type === "ack" && snapshot?.room?.id === soloStartRequest.roomId && snapshot.room.soloStarted) ownedSoloPlayId = snapshot.room.soloPlayId;
            soloStartRequest = null;
          }
          if (event.requestId) {
            clearTimeout(pending.get(event.requestId));
            pending.delete(event.requestId);
            busy = false;
          }
          if (event.type === "error") error = event.message;
        }
      } catch {
        error = "서버 응답을 확인할 수 없어.";
      }
    };
    socket.onclose = () => {
      connected = false;
      for (const timeout of pending.values()) clearTimeout(timeout);
      pending.clear();
      soloStartRequest = null;
      busy = false;
      if (!disposed) {
        reconnectTimer = setTimeout(async () => {
          try {
            snapshot = await api("/lobby/state");
            connect();
          } catch (cause) {
            if ((cause as { status?: number }).status === 401) {
              snapshot = null;
              error = "게스트 로그인이 만료됐어.";
            } else if (!disposed) {
              connect();
            }
          }
        }, 2000);
      }
    };
    socket.onerror = () => {
      error = "실시간 연결을 확인 중이야.";
    };
  }

  function command(type: Command["type"], targetId?: string, mode?: "solo" | "multiplayer") {
    if (!connected || busy || !socket) return;
    if (type === "start") soloEndedNotice = false;
    error = "";
    busy = true;
    const requestId = crypto.randomUUID();
    if (type === "start" && room?.mode === "solo") soloStartRequest = { requestId, roomId: room.id };
    pending.set(
      requestId,
      setTimeout(() => {
        pending.delete(requestId);
        busy = false;
        if (soloStartRequest?.requestId === requestId) soloStartRequest = null;
        error = "응답이 지연됐어. 현재 상태를 확인하고 다시 시도해 줘.";
      }, 8000),
    );
    socket.send(JSON.stringify({ type, requestId, ...(targetId ? { targetId } : {}), ...(mode ? { mode } : {}) }));
  }

  function changeLocale(next: "ko" | "en") {
    locale = next;
    document.documentElement.lang = next;
    history.pushState({}, "", `${localePath(next, location.pathname)}${location.search}${location.hash}`);
  }

  function openWorkshop() {
    picker = false;
    currentPath = "/workshop";
    history.pushState({}, "", localePath(locale, "/workshop"));
  }

  function openEditor(id?: string) {
    if (!snapshot) { requestWorkshopLogin(() => openEditor(id), { page: "editor", id }); return; }
    editorId = id;
    currentPath = "/workshop/editor";
    history.pushState({}, "", `${localePath(locale, currentPath)}${id ? `?id=${encodeURIComponent(id)}` : ""}`);
  }

  function requestWorkshopLogin(resume?: () => void, destination: AuthDestination = { page: "workshop" }) {
    pendingWorkshopAction = resume;
    pendingAuthDestination = destination;
    loginDialog.showModal();
  }

  function createWorkshopStory() {
    if (snapshot) openEditor();
    else requestWorkshopLogin(() => openEditor(), { page: "editor" });
  }

  function savedWorkshopStory(id: string) {
    editorId = id;
    history.replaceState({}, "", `${localePath(locale, "/workshop/editor")}?id=${encodeURIComponent(id)}`);
  }

  function selectGameMode(modeId: string) {
    if (modeId === "host") picker = true;
  }

  async function loadAccount() {
    account = await api("/platform/account");
    if (account.me && !account.needsNickname) {
      snapshot = await api("/lobby/state");
      if (!accountLoaded) {
        soloRecovery = pendingSoloExit(sessionStorage, snapshot?.room ?? null);
        if (soloRecovery) await reconcileSolo();
      }
      accountLoaded = true;
      if (!socket || socket.readyState > 1) connect();
      resumeGoogleAction();
    }
  }
  async function reconcileSolo() {
    if (!soloRecovery) return;
    const exit = soloRecovery;
    await api("/lobby/rooms/solo-exit", exit);
    snapshot = await api("/lobby/state");
    clearSoloExit(sessionStorage, exit);
    soloRecovery = null;
    soloEndedNotice = true;
  }
  function soloPageExited(exit: SoloExit) {
    ownedSoloPlayId = null;
    if (matchesSoloExit(exit, snapshot?.room ?? null)) soloRecovery = exit;
    else clearSoloExit(sessionStorage, exit);
  }
  function openAccount() {
    if (editorPath && editorHasChanges && !window.confirm(locale === 'en' ? 'Discard unsaved changes?' : '저장하지 않은 변경을 버리고 나갈까요?')) return;
    if (!snapshot) { requestWorkshopLogin(openAccount, { page: "account" }); return; }
    currentPath = "/mypage";
    history.pushState({}, "", localePath(locale, currentPath));
  }
  function rememberGoogleAction() {
    const destination = pendingAuthDestination ?? (editorPath ? { page: "editor", id: editorId } : currentPath === "/mypage" ? { page: "account" } : currentPath === "/workshop" ? { page: "workshop" } : undefined);
    pendingGoogleAction = pendingWorkshopAction;
    sessionStorage.removeItem("festival_auth_return");
    if (destination) sessionStorage.setItem("festival_auth_return", JSON.stringify(destination));
  }
  function resumeGoogleAction() {
    if (!snapshot || account.needsNickname) return;
    const stored = sessionStorage.getItem("festival_auth_return");
    sessionStorage.removeItem("festival_auth_return");
    const resume = pendingGoogleAction;
    pendingGoogleAction = undefined;
    pendingAuthDestination = undefined;
    if (resume) { resume(); return; }
    if (!stored) return;
    try {
      const destination = JSON.parse(stored) as AuthDestination;
      if (destination.page === "editor" && (destination.id === undefined || typeof destination.id === "string" && destination.id.length <= 200)) openEditor(destination.id);
      else if (destination.page === "account") openAccount();
      else if (destination.page === "workshop") openWorkshop();
    } catch { /* Ignore an invalid saved destination; never navigate to an arbitrary URL. */ }
  }
  async function googleLogin() {
    if (authConfig.google) { rememberGoogleAction(); location.assign(`/api/platform/auth/google?locale=${locale}`); return; }
    await action(async () => {
      if (!authConfig.demo) throw Error(locale === "en" ? "Google sign-in is not configured. Please use guest sign-in." : "구글 로그인 설정이 필요해요. 게스트 로그인을 이용해 주세요.");
      rememberGoogleAction();
      account = await api("/platform/auth/google/demo", {});
      nickname = "";
      loginDialog?.close();
      await loadAccount();
    });
  }
  async function rename(next: string) {
    await action(async () => { account = await api("/platform/account/nickname", { nickname: next }); await loadAccount(); });
  }
  async function logout(remove = false) {
    await action(async () => {
      await api(remove ? "/platform/account/delete" : "/platform/account/logout", {});
      sessionStorage.removeItem("festival_auth_return");
      if (socket) { socket.onclose = null; socket.close(); }
      clearTimeout(reconnectTimer);
      location.assign(localePath(locale));
    });
  }
  async function login() {
    const resume = loginDialog?.open ? pendingWorkshopAction : undefined;
    pendingWorkshopAction = undefined;
    await action(async () => {
      await api("/platform/guest", { nickname });
      await loadAccount();
      if (loginDialog?.open) {
        loginDialog.close();
        await tick();
        resume?.();
      }
    });
  }

  async function create(scenarioId: string) {
    await action(async () => {
      await api("/lobby/rooms", { scenarioId });
      snapshot = await api("/lobby/state");
      picker = false;
    });
  }

  async function join(invite = code) {
    await action(async () => {
      await api("/lobby/rooms/join", { code: invite });
      snapshot = await api("/lobby/state");
      code = "";
    });
  }

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(`${location.origin}/?room=${room?.code}`);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      error = `초대 코드: ${room?.code}`;
    }
  }

  onMount(() => {
    const syncLocale = () => {
      if (loginDialog?.open) loginDialog.close();
      locale = getLocaleFromPath(location.pathname);
      currentPath = pagePath(location.pathname);
      code = new URLSearchParams(location.search).get("room") ?? "";
      editorId = new URLSearchParams(location.search).get("id") ?? undefined;
      document.documentElement.lang = locale;
    };
    window.addEventListener("popstate", syncLocale);
    void (async () => {
      try {
        authConfig = await api("/platform/auth/config");
        const authError = new URLSearchParams(location.search).get("auth");
        if (authError) sessionStorage.removeItem("festival_auth_return");
        await loadAccount();
        if (authError) error = locale === "en" ? "Google sign-in was cancelled or failed. Please try again." : "구글 로그인이 취소되었거나 실패했어요. 다시 시도해 주세요.";
      } catch (cause) {
        if ((cause as { status?: number }).status !== 401) {
          error = "서버에 연결할 수 없어. 잠시 후 새로고침해 줘.";
        }
      } finally {
        code = new URLSearchParams(location.search).get("room") ?? "";
        loading = false;
      }
    })();

    return () => {
      disposed = true;
      window.removeEventListener("popstate", syncLocale);
      clearTimeout(reconnectTimer);
      for (const timeout of pending.values()) clearTimeout(timeout);
      socket?.close();
    };
  });
</script>

<svelte:head>
  <title>{pageMetadata(localePath(locale, currentPath)).title}</title>
</svelte:head>

<div class="shell">
  {#if !entryHome}
    <AppHeader {snapshot} {connected} {locale} {t} accountType={account.accountType} onAccount={openAccount} onLocaleChange={changeLocale} />
  {/if}

  {#if error}
    <ErrorNotice message={error} onDismiss={() => (error = "")} />
  {/if}
  {#if soloEndedNotice}
    <p class="main" role="status">{locale === "en" ? "Your previous solo investigation ended when you left the page. You are back in the room; start a new investigation when ready." : "페이지를 떠나 이전 1인 수사가 종료됐어. 같은 방으로 돌아왔으니 준비되면 새 수사를 시작해 줘."}</p>
  {/if}

  {#if loading}
    <PageState kind="loading" message={t("workshopLoading")} />
  {:else if soloRecovery && snapshot}
    <main class="main"><Panel><p role="status">{locale === "en" ? "The previous solo investigation has ended. Reconnect to return to your room." : "이전 1인 수사가 종료됐어. 연결을 확인한 뒤 같은 방으로 돌아가 줘."}</p><Button disabled={busy} onclick={() => void action(async () => { await reconcileSolo(); if (!socket || socket.readyState > 1) connect(); })}>{locale === "en" ? "Retry returning to room" : "방 복귀 다시 시도"}</Button></Panel></main>
  {:else if account.needsNickname}
    <main class="main"><Panel><h1 class="heading-one">{locale === "en" ? "Choose your nickname" : "닉네임을 정해 주세요"}</h1><form onsubmit={event => { event.preventDefault(); void rename(nickname); }}><NicknameField bind:value={nickname} {locale} {busy} /><Button type="submit" disabled={busy}>{locale === "en" ? "Save and continue" : "저장하고 시작하기"}</Button></form><Button variant="secondary" disabled={busy} onclick={() => void logout()}>{locale === "en" ? "Sign out" : "로그아웃"}</Button></Panel></main>
  {:else if currentPath === "/mypage" && snapshot}
    <MyPage me={snapshot.me} accountType={account.accountType} {locale} {busy} onRename={rename} onLogout={() => logout()} onDeleteAccount={() => logout(true)} onEdit={openEditor} onWorkshop={openWorkshop} />
  {:else if currentPath === "/workshop"}
    <WorkshopPage {locale} loggedIn={snapshot !== null} onLogin={requestWorkshopLogin} onEdit={(id) => id ? openEditor(id) : createWorkshopStory()} />
  {:else if editorPath && snapshot}
    {#key editorId}<WorkshopEditor {locale} onDirtyChange={(dirty) => { editorHasChanges = dirty; }} storyId={editorId} onBack={openWorkshop} onSaved={savedWorkshopStory} />{/key}
  {:else if !snapshot}
    <EntryPage bind:nickname {busy} {t} {locale} demo={authConfig.demo} onGoogle={googleLogin} onLogin={login} />
  {:else if room?.soloStarted && ownedSoloPlayId !== room.soloPlayId}
    <main class="main"><Panel><p role="status">{locale === "en" ? "A solo investigation is open in another page. Return to that page to continue. Ending it here also closes that investigation." : "다른 페이지에서 1인 수사가 열려 있어. 수사를 이어가려면 해당 페이지로 돌아가 줘. 여기서 종료하면 그 수사도 끝나."}</p><Button disabled={busy || !connected} onclick={() => command("solo-return")}>{locale === "en" ? "End investigation and return to room" : "수사 종료하고 방으로 돌아가기"}</Button></Panel></main>
  {:else if room?.soloStarted}
    {#key room.soloPlayId}<main class="main"><SoloGame {locale} storyId={room.soloStory.id} roomLifecycle={{ roomId: room.id, soloPlayId: room.soloPlayId }} onLifecycleExit={soloPageExited} exitDisabled={!connected || busy} exitMessage={!connected ? (locale === "en" ? "Reconnecting. Return to the room when the connection is restored." : "재연결 중이야. 연결이 복구되면 방으로 돌아갈 수 있어.") : busy ? (locale === "en" ? "Returning to the room…" : "방으로 돌아가는 중…") : ""} exitLabel={locale === "en" ? "Return to room" : "방으로 돌아가기"} onExit={() => command("solo-return")} /></main>{/key}
  {:else if !room}
    <LobbyPage
      bind:code
      {snapshot}
      {busy}
      {connected}
      {t}
      onSelectMode={selectGameMode}
      onCreate={create}
      onJoin={join}
    />
  {:else if !session}
    <RoomPage
      {snapshot}
      {room}
      {host}
      {canStart}
      {busy}
      {connected}
      {copied}
      {locale}
      onMode={(mode) => command("mode", undefined, mode)}
      onCopy={copyInviteLink}
      onCommand={command}
    />
  {:else}
    <GamePage {room} {session} {host} {busy} {connected} onCommand={command} />
  {/if}

  {#if entryHome}
    <footer class="flex justify-center py-4 text-festival-muted"><LegalLinks {locale} /></footer>
  {:else}
    <AppFooter {snapshot} {connected} {t} {locale} />
  {/if}
</div>

<StoryPickerDialog
  open={picker && snapshot !== null}
  {busy}
  {connected}
  {t}
  onClose={() => (picker = false)}
  onWorkshop={openWorkshop}
  onCreate={create}
/>


<Modal bind:element={loginDialog} class="workshop-login" onClose={() => { pendingWorkshopAction = undefined; pendingAuthDestination = undefined; }} labelledby="workshop-login-title">
  <h2 id="workshop-login-title">{locale === "en" ? "Sign in to the workshop" : "창작마당 로그인"}</h2>
  <p>{locale === "en" ? "Sign in with a guest nickname to create stories and save favorites." : "닉네임으로 게스트 로그인하면 창작과 즐겨찾기를 이용할 수 있어요."}</p>
  <Button variant="secondary" disabled={busy} onclick={() => void googleLogin()}>{locale === "en" ? "Continue with Google" : "구글로 로그인"}{authConfig.demo ? (locale === "en" ? " (test)" : " (테스트)") : ""}</Button>
  <form onsubmit={(event) => { event.preventDefault(); void login(); }}>
    <NicknameField id="workshop-nickname" bind:value={nickname} {locale} {busy} />
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="login-actions"><Button type="submit" class="primary" disabled={busy} variant="primary">{locale === "en" ? "Sign in" : "로그인"}</Button><Button type="button" class="secondary" onclick={() => loginDialog.close()} variant="secondary">{locale === "en" ? "Cancel" : "취소"}</Button></div>
  </form>
</Modal>
<style>
:global(.workshop-login) h2 {
  font-size:var(--typography-size-control-6)}
:global(.workshop-login) p {
  margin:var(--spacing-4) 0;
  line-height:1.7}
:global(.workshop-login) label {
  display:block;
  margin-bottom:var(--spacing-2)}
:global(.workshop-login) :global(.primary),:global(.workshop-login) :global(.secondary) {
  width:auto;
  margin-top:0}
.login-actions {
  display:flex;
  gap:var(--spacing-4);
  margin-top:var(--spacing-4)}
</style>
