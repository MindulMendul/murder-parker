import type { StoryCatalog } from "./ports/story-catalog";
import type { SQLiteWorkshopStore } from "../../../infrastructure/sqlite/workshop-store";

/** Community IDs are storage IDs, independent of the uploaded package's embedded ID. */
export class PlayStoryCatalog implements StoryCatalog {
  constructor(private readonly files: StoryCatalog, private readonly workshop: SQLiteWorkshopStore) {}
  get(id: string, version?: number) {
    if (!id.startsWith("community-")) return this.files.get(id, version);
    const source = this.workshop.playableSource(id);
    return version === undefined || source?.story.version === version ? source : undefined;
  }
}
