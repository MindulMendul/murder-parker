<script lang="ts">
  import type { Snapshot } from "@festival/shared";
  import { localePath } from "../../../shared/lib";

  let {
    accountType = null, onAccount,
    snapshot,
    connected,
    locale,
    t,
    onLocaleChange,
  }: {
    accountType?: string | null; onAccount: () => void;
    snapshot: Snapshot | null;
    connected: boolean;
    locale: "ko" | "en";
    t: (key: string) => string;
    onLocaleChange: (locale: "ko" | "en") => void;
  } = $props();
</script>

<header class="header">
  <a class="brand" href={localePath(locale)} aria-label={`${t("brand")} home`}>
    <span class="emblem">S</span>
    <span>{t("brand")}<small class="brand-subtitle">{t("brandSubtitle")}</small></span>
  </a>
  <div class="header-actions">
    <nav class="header-navigation" aria-label={locale === "en" ? "Main navigation" : "주요 메뉴"}>
      <a class="text-button" href={localePath(locale, "/workshop")}>{t("workshopNav")}</a>
      {#if snapshot}<button class="text-button" onclick={onAccount}>{locale === "en" ? "My page" : "마이페이지"}</button>{/if}
      <label class="sr-only" for="language">{t("language")}</label>
      <select
        class="border border-festival-line bg-festival-panel-input px-2 py-2 text-xs text-festival-text focus-visible:outline-2 focus-visible:outline-festival-gold"
        id="language"
        value={locale}
        onchange={(event) => onLocaleChange(event.currentTarget.value as "ko" | "en")}
      >
        <option value="ko">한국어</option>
        <option value="en">English</option>
      </select>
    </nav>
    <div class="identity">
      {#if snapshot}
        <span class:live={connected} class="dot"></span>
        <span class="identity-name" title={snapshot.me.nickname}>{snapshot.me.nickname}</span>
        <span class="tag identity-tag">{accountType === "google" ? "GOOGLE" : "GUEST"}</span>
      {:else}
        <span class="edition">{t("brandSubtitle")}</span>
      {/if}
    </div>
  </div>
</header>

<style>
  .brand { flex-shrink: 0; }
  .header-actions, .header-navigation { display: flex; align-items: center; gap: var(--spacing-4); }
  .header-actions { min-width: 0; max-width: 100%; flex-wrap: wrap; }
  .header-navigation { flex-wrap: wrap; row-gap: var(--spacing-2); }
  .header-navigation .text-button { display: inline-flex; align-items: center; white-space: nowrap; }
  .identity { max-width: 100%; flex-wrap: nowrap; white-space: nowrap; }
  .identity-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .identity-tag { display: inline-block; flex-shrink: 0; }
  @media (max-width: 640px) {
    .header { height: auto; flex-wrap: wrap; gap: var(--spacing-4); padding: var(--spacing-4) 0; }
    .header-actions { width: 100%; gap: var(--spacing-3); }
    .header-navigation { gap: var(--spacing-3); }
  }
</style>
