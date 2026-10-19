import type { ToolCall } from "./types";

export function describeAction(a: ToolCall): string {
  switch (a.tool) {
    case "reroute_batch":
      return `Reroute ${a.args.units} units of ${a.args.batchId} to ${a.args.targetAssetId}`;
    case "open_work_order":
      return `Open ${a.args.priority}-priority work order on ${a.args.assetId}, window ${a.args.windowMinutes} min`;
    case "adjust_line_speed":
      return `Change line speed by ${a.args.pctChange > 0 ? "+" : ""}${a.args.pctChange}%`;
    case "hold_gate":
      return `Hold batch ${a.args.batchId} at its gate`;
    case "request_inspection":
      return `Raise inspection on ${a.args.assetId} to ${a.args.sampleRatePct}%`;
  }
}
