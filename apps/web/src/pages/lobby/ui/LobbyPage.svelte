<script lang="ts">
  import type { Snapshot } from "@festival/shared";
  import { RoomCard } from "../../../entities/room";
  import { JoinRoomForm } from "../../../features/room-join";
  import { Badge, Button, Card } from "../../../shared/ui";

  let {
    snapshot,
    busy,
    connected,
    t,
    code = $bindable(""),
    onSelectMode,
    onCreate,
    onJoin,
  }: {
    snapshot: Snapshot;
    busy: boolean;
    connected: boolean;
    t: (key: string) => string;
    code?: string;
    onSelectMode: (modeId: string) => void;
    onCreate: (scenarioId: string) => void;
    onJoin: (code?: string) => void;
  } = $props();

  let joinOpen = $state(false);
  $effect(() => {
    if (code.trim()) joinOpen = true;
  });
</script>

<main class="main !pt-5 max-mobile:!pt-4">
  <h1 class="sr-only">{t("lobbyTitle")}</h1>
  <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
    <Button
      class="!m-0 !w-auto !px-3 !py-2"
      disabled={busy || !connected}
      onclick={() => onSelectMode("host")}
    >
      <span aria-hidden="true">＋</span> {t("createRoom")}
    </Button>
    <details class="min-w-0 max-w-full" bind:open={joinOpen}>
      <summary class="min-h-11 cursor-pointer py-3 text-body-sm text-festival-muted hover:text-festival-gold">{t("joinByCode")}</summary>
      <div class="mt-2 border border-festival-line bg-festival-panel p-4">
        <JoinRoomForm bind:code {busy} {connected} {t} onSubmit={() => onJoin()} />
      </div>
    </details>
  </div>

  <section aria-labelledby="lobby-stories-title">
    <h2 id="lobby-stories-title" class="mb-3 text-body-sm font-medium text-festival-muted">{t("platformStories")}</h2>
    {#if snapshot.scenarios.length}
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each snapshot.scenarios as story (story.id)}
          <Card class="!p-4 flex flex-col gap-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-label tracking-label text-festival-gold">{t(story.kind === "demo" ? "storyDemo" : "storyOriginal")}</span>
              <Badge>{t(story.available ? "storyAvailable" : "storyComingSoon")}</Badge>
            </div>
            <h3 class="heading-three !m-0">{story.title}</h3>
            <p class="muted grow">{story.subtitle}</p>
            {#if story.available}
              <dl class="flex flex-wrap gap-4 border-t border-festival-line pt-3 text-xs text-festival-muted">
                <div><dt>{t("workshopPlayers")}</dt><dd>{story.players}{t("playerUnit")}</dd></div>
                <div><dt>{t("storyDifficulty")}</dt><dd>{story.difficulty ? t(`difficulty${story.difficulty[0].toUpperCase()}${story.difficulty.slice(1)}`) : t("difficultyUndetermined")}</dd></div>
              </dl>
            {/if}
            <Button
              variant="secondary"
              class="!mt-0 !px-3 !py-2"
              ariaLabel={`${t(story.available ? "createRoom" : "storyComingSoon")} · ${story.title}`}
              disabled={!story.available || busy || !connected}
              onclick={() => onCreate(story.id)}
            >
              {t(story.available ? "createRoom" : "storyComingSoon")}
              {#if story.available}<span aria-hidden="true">↗</span>{/if}
            </Button>
          </Card>
        {/each}
      </div>
    {:else}
      <p class="muted py-4" role="status">{t("workshopEmpty")}</p>
    {/if}
  </section>

  <section class="mt-8 border-t border-festival-line pt-5" aria-labelledby="lobby-rooms-title">
    <div class="section-heading mb-4">
      <h2 id="lobby-rooms-title" class="heading-two section-title">{t("openRooms")}</h2>
      <span class="count">{snapshot.rooms.length}</span>
    </div>
    {#if !snapshot.rooms.length}
      <p class="muted" role="status">{t("noOpenRooms")}</p>
    {:else}
      <div class="rooms">
        {#each snapshot.rooms as room (room.id)}
          <RoomCard {room} {busy} {connected} onJoin={onJoin} />
        {/each}
      </div>
    {/if}
  </section>
</main>
