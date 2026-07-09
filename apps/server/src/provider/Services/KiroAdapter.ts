import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KiroAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kiro";
}

export class KiroAdapter extends Context.Service<KiroAdapter, KiroAdapterShape>()(
  "t3/provider/Services/KiroAdapter",
) {}
