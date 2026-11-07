<script lang="ts">
  import type { Command, RoomView, Snapshot } from "@festival/shared";
  import { RoomMemberRow } from "../../../entities/member";
  import { Button, Panel } from "../../../shared/ui";

  let {
    snapshot,
    room,
    host,
    canStart,
    busy,
    connected,
    copied,
    onCopy,
    locale,
    onMode,
    onCommand,
  }: {
    snapshot: Snapshot;
    room: RoomView;
    host: boolean;
    canStart: boolean;
    busy: boolean;
    connected: boolean;
    copied: boolean;
    locale: "ko" | "en";
    onMode: (mode: "solo" | "multiplayer") => void;
    onCopy: () => void;
    onCommand: (type: Command["type"], targetId?: string) => void;
  } = $props();
</script>

<main class="main">
  <p class="eyebrow">ROOM DETAILS</p>
  <div class="page-heading">
    <div>
      <h1 class="heading-one page-title">{room.title}</h1>
      <p class="muted">
        {#if room.mode === "solo"}
          {locale === "en" ? "A solo investigation: collect clues and question suspects." : "단서와 진술을 모아 범인을 밝혀내는 1인 추리극"}
        {:else}
          {room.scenario.kind === "demo" ? "기능 검증용 테스트 시나리오" : "오리지널 스토리"}
          · {room.capacity}인 · 약 {room.scenario.minutes}분
        {/if}
      </p>
    </div>
    <Button variant="text" disabled={busy || !connected} onclick={() => onCommand("leave")}>방 나가기 ↗</Button>
  </div>

  <Panel class="mb-6">
    <h2 class="heading-two">{locale === "en" ? "Room mode" : "방 모드"}</h2>
    <p class="muted">{locale === "en" ? `Solo plays ${room.soloStory.title}. Multiplayer plays your selected story, ${room.scenario.title}.` : `1인 모드는 「${room.soloStory.title}」을 플레이해. 다인 모드는 선택한 작품 「${room.scenario.title}」을 플레이해.`}</p>
    <div class="flex flex-wrap gap-3">
      <Button variant={room.mode === "solo" ? "primary" : "secondary"} disabled={!host || busy || !connected || room.count !== 1} onclick={() => onMode("solo")} aria-pressed={room.mode === "solo"}>{locale === "en" ? "Solo mode" : "1인 모드"} · {room.soloStory.title}</Button>
      <Button variant={room.mode === "multiplayer" ? "primary" : "secondary"} disabled={!host || busy || !connected} onclick={() => onMode("multiplayer")} aria-pressed={room.mode === "multiplayer"}>{locale === "en" ? "Multiplayer mode" : "다인 모드"}</Button>
    </div>
    {#if room.count > 1}<p class="fine">{locale === "en" ? "Solo mode is available when only the host remains." : "방장 혼자 남았을 때 1인 모드로 바꿀 수 있어."}</p>{/if}
    {#if room.mode === "solo"}<p class="fine">{locale === "en" ? "Reloading or leaving this page ends the investigation and returns you to this room. Progress is not saved." : "새로고침하거나 페이지를 떠나면 수사를 종료하고 이 방으로 돌아와. 수사 진행은 저장되지 않아."}</p>{/if}
  </Panel>

  <div class="lobby-grid">
    <Panel>
      <div class="section-heading">
        <h2 class="heading-two section-title">참가자</h2>
        <span class="count">{room.count} / {room.capacity}</span>
      </div>
      <div class="members">
        {#each room.members as member (member.id)}
          <RoomMemberRow member={member} currentMemberId={snapshot.me.id} hostId={room.hostId} />
        {/each}
        {#each Array(room.capacity - room.count) as _}
          <div class="member vacant">
            <span class="avatar vacant-avatar">＋</span><span>누군가의 입장을 기다리는 중</span>
          </div>
        {/each}
      </div>
    </Panel>

    <aside class="sidebar">
      {#if room.mode === "multiplayer"}
      <Panel>
        <p class="eyebrow">INVITE YOUR FRIENDS</p>
        <h2 class="heading-two sidebar-title">초대 코드</h2>
        <p class="invite-code">{room.code}</p>
        <Button variant="secondary" onclick={onCopy}>{copied ? "초대 링크 복사 완료" : "초대 링크 복사 ↗"}</Button>
      </Panel>
      {/if}
      <Panel>
        <p class="muted">
          {room.mode === "solo" ? (locale === "en" ? "Your solo room is ready. Start whenever you like." : "1인 방이 준비됐어. 다른 참가자를 기다리지 않고 시작할 수 있어.") : canStart ? "모든 참가자가 모였어. 이야기를 시작해도 좋아." : "필요한 인원이 모두 접속하면 시작할 수 있어."}
        </p>
        {#if host}
          <Button disabled={!canStart || !connected || busy} onclick={() => onCommand("start")}>
            게임 시작 <span>→</span>
          </Button>
        {:else}
          <p class="fine">방장이 게임을 시작하기를 기다리는 중</p>
        {/if}
      </Panel>
    </aside>
  </div>
</main>
