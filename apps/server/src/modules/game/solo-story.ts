import type { SoloStoryView, StoryPackage } from "@festival/shared";

/** The current UI implements opening → investigation → accusation, with three evidence slots. */
export function supportsSoloStory(source: StoryPackage) {
  const mechanics = source.content.mechanics;
  const opening = source.content.scenes.find(scene => scene.id === source.story.startSceneId);
  return source.story.mode === "solo" && source.story.playerCount.min === 1 && source.story.playerCount.max === 1 && mechanics.type === "solo-investigation" &&
    !["resolution", "investigation"].includes(source.story.startSceneId) && opening?.nextSceneId === "investigation" &&
    source.content.scenes.length === 3 && source.content.scenes.every(scene => scene.choices.length === 0) &&
    source.content.scenes.find(scene => scene.id === "investigation")?.nextSceneId === "resolution" &&
    source.content.scenes.some(scene => scene.id === "investigation") &&
    source.content.scenes.some(scene => scene.id === "resolution") &&
    mechanics.suspects.length > 0 && mechanics.evidence.length >= 3 &&
    new Set(mechanics.locations.map(location => location.id)).size === mechanics.locations.length &&
    mechanics.solution.minimumEvidenceCount <= 3 &&
    new Set(mechanics.solution.requiredEvidenceIds).size >= mechanics.solution.minimumEvidenceCount &&
    mechanics.suspects.every(suspect => mechanics.alibis.some(alibi => alibi.suspectId === suspect.id && alibi.statements.length >= 2)) &&
    new Set(mechanics.locations.flatMap(location => location.evidenceIds)).size === mechanics.evidence.length;
}

export function soloStoryView(source: StoryPackage): SoloStoryView {
  if (source.content.mechanics.type !== "solo-investigation") throw new Error("지원하지 않는 플레이 방식이야.");
  const mechanics = source.content.mechanics;
  return {
    story: source.story,
    content: {
      mechanics: {
        type: mechanics.type,
        victim: mechanics.victim,
        suspects: mechanics.suspects,
        evidence: mechanics.evidence,
        locations: mechanics.locations,
        alibis: mechanics.alibis,
        hints: mechanics.hints,
        reactions: mechanics.reactions.map(reaction => ({
          suspectId: reaction.suspectId, evidenceId: reaction.evidenceId, lines: reaction.lines,
        })),
      },
    },
  };
}
