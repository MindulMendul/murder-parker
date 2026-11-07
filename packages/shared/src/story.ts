import { z } from "zod";

const storyId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const text = z.string().trim().min(1).max(5000);

export const storyCueSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("dialogue.show"),
    speaker: z.string().max(80).optional(),
    text,
    characterId: storyId.optional(),
  }),
  z.strictObject({
    type: z.literal("transition.play"),
    effect: z.enum(["fade", "dissolve", "cut"]),
    durationMs: z.number().int().min(0).max(10000),
  }),
  z.strictObject({
    type: z.literal("wait"),
    durationMs: z.number().int().min(0).max(30000),
  }),
]);

const sceneChoiceSchema = z.strictObject({
  id: storyId,
  label: text,
  targetSceneId: storyId,
  visibleWhen: z
    .discriminatedUnion("type", [
      z.strictObject({ type: z.literal("always") }),
      z.strictObject({ type: z.literal("has_information"), informationId: storyId }),
      z.strictObject({ type: z.literal("owns_item"), itemId: storyId }),
      z.strictObject({ type: z.literal("role_is"), roleId: storyId }),
    ])
    .default({ type: "always" }),
});

const audienceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("all") }),
  z.strictObject({ type: z.literal("roles"), roleIds: z.array(storyId).min(1) }),
]);

const releaseTriggerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session_start") }),
  z.strictObject({ type: z.literal("elapsed_seconds"), seconds: z.number().int().min(0) }),
  z.strictObject({ type: z.literal("scene_entered"), sceneId: storyId }),
]);

const storyContentSchema = z.strictObject({
  characters: z.array(
    z.strictObject({ id: storyId, name: text, description: text.optional() }),
  ),
  assets: z.array(
    z.strictObject({
      id: storyId,
      path: z.string().min(1).max(240),
      mediaType: z.enum(["image", "audio", "video"]),
    }),
  ),
  scenes: z.array(
    z.strictObject({
      id: storyId,
      cues: z.array(storyCueSchema),
      nextSceneId: storyId.optional(),
      choices: z.array(sceneChoiceSchema).default([]),
    }),
  ),
  roles: z.array(
    z.strictObject({
      id: storyId,
      name: text,
      description: text.optional(),
    }),
  ),
  information: z.array(
    z.strictObject({
      id: storyId,
      title: text,
      body: text,
      audience: audienceSchema,
      releasedWhen: releaseTriggerSchema,
      sharing: z.enum(["never", "owner_choice", "public"]).default("never"),
      shareableWithRoleIds: z.array(storyId).default([]),
    }),
  ),
  items: z.array(
    z.strictObject({
      id: storyId,
      name: text,
      description: text.optional(),
      initialOwnerRoleId: storyId.optional(),
      visibleTo: audienceSchema,
      transfer: z.discriminatedUnion("mode", [
        z.strictObject({ mode: z.literal("never") }),
        z.strictObject({ mode: z.literal("owner_choice"), toRoleIds: z.array(storyId) }),
        z.strictObject({ mode: z.literal("anyone") }),
      ]),
    }),
  ),
  mechanics: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("solo-investigation"),
      victim: z.strictObject({ name: text, details: text }),
      suspects: z.array(
        z.strictObject({ id: storyId, name: text, details: text }),
      ),
      evidence: z.array(
        z.strictObject({
          id: storyId,
          icon: z.string().max(16),
          name: text,
          place: text,
          detail: text,
        }),
      ),
      locations: z.array(
        z.strictObject({
          id: storyId,
          name: text,
          evidenceIds: z.array(storyId),
          mood: text,
        }),
      ),
      alibis: z.array(
        z.strictObject({ suspectId: storyId, statements: z.array(text).min(1) }),
      ),
      reactions: z.array(
        z.strictObject({
          suspectId: storyId,
          evidenceId: storyId,
          lines: z.array(text).min(1),
          revealsTruth: z.boolean().default(false),
        }),
      ),
      hints: z.record(z.string(), z.array(text).min(1)),
      solution: z.strictObject({
        culpritId: storyId,
        requiredEvidenceIds: z.array(storyId).min(1),
        minimumEvidenceCount: z.number().int().positive(),
        resolutionLines: z.array(text).min(1),
        failureMessages: z.strictObject({
          wrongSuspect: text,
          insufficientEvidence: text,
        }),
      }),
    }),
    z.strictObject({ type: z.literal("roleplay") }),
  ]),
});

export const storyPackageSchema = z
  .strictObject({
    format: z.literal("murder-parker-story"),
    formatVersion: z.literal(1),
    story: z.strictObject({
      id: storyId,
      version: z.number().int().positive(),
      mode: z.enum(["solo", "multiplayer"]),
      locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
      title: text,
      subtitle: text,
      playerCount: z.strictObject({ min: z.number().int().positive(), max: z.number().int().positive() }),
      estimatedMinutes: z.number().int().positive(),
      startSceneId: storyId,
    }),
    content: storyContentSchema,
  })
  .superRefine((story, ctx) => {
    if (story.story.playerCount.min > story.story.playerCount.max) {
      ctx.addIssue({ code: "custom", path: ["story", "playerCount"], message: "최소 인원은 최대 인원보다 클 수 없어." });
    }

    const unique = (values: string[], path: (string | number)[]) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: "custom", path, message: "같은 ID를 중복해서 쓸 수 없어." });
      }
    };
    const sceneIds = story.content.scenes.map((item) => item.id);
    const roleIds = story.content.roles.map((item) => item.id);
    const infoIds = story.content.information.map((item) => item.id);
    const itemIds = story.content.items.map((item) => item.id);
    const assetIds = story.content.assets.map((item) => item.id);
    const characterIds = story.content.characters.map((item) => item.id);
    unique(sceneIds, ["content", "scenes"]);
    unique(roleIds, ["content", "roles"]);
    unique(infoIds, ["content", "information"]);
    unique(itemIds, ["content", "items"]);
    unique(assetIds, ["content", "assets"]);
    unique(characterIds, ["content", "characters"]);

    const exists = (id: string, ids: string[]) => ids.includes(id);
    if (
      (story.story.mode === "solo" && story.content.mechanics.type !== "solo-investigation") ||
      (story.story.mode === "multiplayer" && story.content.mechanics.type !== "roleplay")
    ) {
      ctx.addIssue({ code: "custom", path: ["content", "mechanics"], message: "게임 모드와 진행 규칙 유형이 맞지 않아." });
    }
    if (!exists(story.story.startSceneId, sceneIds)) {
      ctx.addIssue({ code: "custom", path: ["story", "startSceneId"], message: "시작 장면을 찾을 수 없어." });
    }
    story.content.scenes.forEach((scene, sceneIndex) => {
      if (scene.nextSceneId && !exists(scene.nextSceneId, sceneIds)) {
        ctx.addIssue({ code: "custom", path: ["content", "scenes", sceneIndex, "nextSceneId"], message: "다음 장면을 찾을 수 없어." });
      }
      scene.choices.forEach((choice, choiceIndex) => {
        if (!exists(choice.targetSceneId, sceneIds)) {
          ctx.addIssue({ code: "custom", path: ["content", "scenes", sceneIndex, "choices", choiceIndex], message: "선택 대상 장면을 찾을 수 없어." });
        }
        if (choice.visibleWhen.type === "has_information" && !exists(choice.visibleWhen.informationId, infoIds)) {
          ctx.addIssue({ code: "custom", path: ["content", "scenes", sceneIndex, "choices", choiceIndex, "visibleWhen"], message: "선택 조건의 정보를 찾을 수 없어." });
        }
        if (choice.visibleWhen.type === "owns_item" && !exists(choice.visibleWhen.itemId, itemIds)) {
          ctx.addIssue({ code: "custom", path: ["content", "scenes", sceneIndex, "choices", choiceIndex, "visibleWhen"], message: "선택 조건의 아이템을 찾을 수 없어." });
        }
        if (choice.visibleWhen.type === "role_is" && !exists(choice.visibleWhen.roleId, roleIds)) {
          ctx.addIssue({ code: "custom", path: ["content", "scenes", sceneIndex, "choices", choiceIndex, "visibleWhen"], message: "선택 조건의 역할을 찾을 수 없어." });
        }
      });
    });
    story.content.items.forEach((item, index) => {
      if (item.initialOwnerRoleId && !exists(item.initialOwnerRoleId, roleIds)) {
        ctx.addIssue({ code: "custom", path: ["content", "items", index, "initialOwnerRoleId"], message: "아이템 소유 역할을 찾을 수 없어." });
      }
      if (item.transfer.mode === "owner_choice" && item.transfer.toRoleIds.some((id) => !exists(id, roleIds))) {
        ctx.addIssue({ code: "custom", path: ["content", "items", index, "transfer"], message: "아이템을 받을 역할을 찾을 수 없어." });
      }
    });
    story.content.information.forEach((info, index) => {
      if (info.audience.type === "roles" && info.audience.roleIds.some((id) => !exists(id, roleIds))) {
        ctx.addIssue({ code: "custom", path: ["content", "information", index, "audience"], message: "정보를 받을 역할을 찾을 수 없어." });
      }
      if (info.sharing === "owner_choice" && info.shareableWithRoleIds.some((id) => !exists(id, roleIds))) {
        ctx.addIssue({ code: "custom", path: ["content", "information", index, "shareableWithRoleIds"], message: "정보를 공유할 역할을 찾을 수 없어." });
      }
      if (info.releasedWhen.type === "scene_entered" && !exists(info.releasedWhen.sceneId, sceneIds)) {
        ctx.addIssue({ code: "custom", path: ["content", "information", index, "releasedWhen"], message: "공개 조건의 장면을 찾을 수 없어." });
      }
    });
    story.content.items.forEach((item, index) => {
      if (item.visibleTo.type === "roles" && item.visibleTo.roleIds.some((id) => !exists(id, roleIds))) {
        ctx.addIssue({ code: "custom", path: ["content", "items", index, "visibleTo"], message: "아이템을 볼 수 있는 역할을 찾을 수 없어." });
      }
    });
    if (story.content.mechanics.type === "solo-investigation") {
      const mechanics = story.content.mechanics;
      const suspectIds = mechanics.suspects.map((item) => item.id);
      const evidenceIds = mechanics.evidence.map((item) => item.id);
      unique(suspectIds, ["content", "mechanics", "suspects"]);
      unique(evidenceIds, ["content", "mechanics", "evidence"]);
      mechanics.locations.forEach((location, index) => {
        if (location.evidenceIds.some((id) => !exists(id, evidenceIds))) {
          ctx.addIssue({ code: "custom", path: ["content", "mechanics", "locations", index], message: "장소에서 찾는 증거를 찾을 수 없어." });
        }
      });
      mechanics.alibis.forEach((alibi, index) => {
        if (!exists(alibi.suspectId, suspectIds)) {
          ctx.addIssue({ code: "custom", path: ["content", "mechanics", "alibis", index], message: "진술의 용의자를 찾을 수 없어." });
        }
      });
      mechanics.reactions.forEach((reaction, index) => {
        if (!exists(reaction.suspectId, suspectIds) || !exists(reaction.evidenceId, evidenceIds)) {
          ctx.addIssue({ code: "custom", path: ["content", "mechanics", "reactions", index], message: "반응에 연결된 용의자나 증거를 찾을 수 없어." });
        }
      });
      if (!exists(mechanics.solution.culpritId, suspectIds)) {
        ctx.addIssue({ code: "custom", path: ["content", "mechanics", "solution", "culpritId"], message: "범인 용의자를 찾을 수 없어." });
      }
      if (mechanics.solution.requiredEvidenceIds.some((id) => !exists(id, evidenceIds))) {
        ctx.addIssue({ code: "custom", path: ["content", "mechanics", "solution", "requiredEvidenceIds"], message: "정답 판정에 필요한 증거를 찾을 수 없어." });
      }
    }
  });

export const storyCatalogItemSchema = z.strictObject({
  id: storyId,
  version: z.number().int().positive(),
  mode: z.enum(["solo", "multiplayer"]),
  locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
  title: text,
  subtitle: text,
  playerCount: z.strictObject({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  }),
  estimatedMinutes: z.number().int().positive(),
});
export const storyCatalogResponseSchema = z.strictObject({
  items: z.array(storyCatalogItemSchema),
});

export const startStorySessionSchema = z.strictObject({ storyId });
export const inspectStoryEvidenceSchema = z.strictObject({ evidenceId: storyId });
export const accuseStorySchema = z.strictObject({
  suspectId: storyId,
  evidenceIds: z.array(storyId).max(3),
});
export const rumVitalSchema = z.strictObject({
  storyId,
  metricName: z.enum(["LCP", "INP", "CLS", "FCP", "TTFB", "page_load_ms"]),
  value: z.number().min(0).max(60000),
  navigationId: z.string().uuid(),
  route: z.enum(["/solo"]),
});

export type StoryCue = z.infer<typeof storyCueSchema>;
export type StoryPackage = z.infer<typeof storyPackageSchema>;
export type StoryCatalogItem = z.infer<typeof storyCatalogItemSchema>;
export type StoryCatalogResponse = z.infer<typeof storyCatalogResponseSchema>;

/** Public solo view: source packages, answer keys and unreleased scenes stay on the server. */
type SoloMechanics = Extract<StoryPackage["content"]["mechanics"], { type: "solo-investigation" }>;
export type SoloStoryView = {
  story: StoryPackage["story"];
  content?: { mechanics: Omit<SoloMechanics, "solution" | "reactions"> & { reactions: Omit<SoloMechanics["reactions"][number], "revealsTruth">[] } };
};
