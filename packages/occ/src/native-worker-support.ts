/**
 * Whether the OpenClaw commit pinned in deploy/runtime/Dockerfile accepts the
 * required worker placement for ordinary sessions (`cloudWorkers.requiredProfile`)
 * and node-owned native inference (`models.providers` with a worker-local credential).
 * The pinned source accepts the canonical configuration but lacks complete placement
 * activation. Configuration validation alone must not enable this capability;
 * update the source pin and verify placement plus inference before setting it true.
 */
export const PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS: boolean = false;

/**
 * Operator declaration in the Installation startup file (`runtime.nativeWorkerSupport`)
 * that the configured runtime image was built from an OpenClaw source with native
 * worker support. No API or Agent Configuration field can set it.
 */
export type NativeWorkerSupport = "custom-image";

/** Where dedicated native OpenClaw support comes from, when it is available. */
export type NativeWorkerSupportSource = "pinned-runtime" | "custom-image";

export function nativeWorkerSupportSource(
  declared: NativeWorkerSupport | undefined,
): NativeWorkerSupportSource | undefined {
  if (PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS) {
    return "pinned-runtime";
  }
  return declared;
}
