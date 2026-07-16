import { AddPois1787000000000 } from "./1787000000000-AddPois.js";
import { AddPoiDecisionSupportFields1793000000000 } from "./1793000000000-AddPoiDecisionSupportFields.js";
import { AddPoiDeactivatedAt1798000000000 } from "./1798000000000-AddPoiDeactivatedAt.js";
import { AddPoiGeographyIndex1799000000000 } from "./1799000000000-AddPoiGeographyIndex.js";
import { AddPoiImportRegions1800000000000 } from "./1800000000000-AddPoiImportRegions.js";
import { AddPoiImportRuns1801000000000 } from "./1801000000000-AddPoiImportRuns.js";
import { AddPoisSourceRegionIndex1802000000000 } from "./1802000000000-AddPoisSourceRegionIndex.js";
import { AddPoiImportRunWarning1803000000000 } from "./1803000000000-AddPoiImportRunWarning.js";

/**
 * The single POI migration registry (ADR-0007). Consumed by both the runtime
 * TypeORM factory (`buildPoiTypeOrmOptions`) and the CLI `PoiDataSource`, so the
 * two can no longer drift. Guarded by `migration-registry.spec.ts`.
 */
export const POI_MIGRATIONS = [
  AddPois1787000000000,
  AddPoiDecisionSupportFields1793000000000,
  AddPoiDeactivatedAt1798000000000,
  AddPoiGeographyIndex1799000000000,
  AddPoiImportRegions1800000000000,
  AddPoiImportRuns1801000000000,
  AddPoisSourceRegionIndex1802000000000,
  AddPoiImportRunWarning1803000000000,
] as const;
