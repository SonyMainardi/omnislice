import type { ConnectorCheck } from "../core/connectors";
import type { Placement } from "../core/layout";
import type { PartGeometry } from "../core/part";
import type { PartStats } from "../worker/protocol";

/** Resultado final (encaixes aplicados) usado na exportação e na prévia de impressão. */
export interface AppliedConnectorsResult {
  parts: { id: string; geometry: PartGeometry; stats: PartStats }[];
  extras: { id: string; name: string; geometry: PartGeometry; stats: PartStats; interfaceId: string }[];
  checks: ConnectorCheck[];
  layout: { placements: Placement[]; plates: number } | null;
}
