export type ErrorScope = "player" | "storage" | "proxy" | "auth" | "stream"

export type ErrorReporter = (scope: ErrorScope, context: string, error: unknown) => void

const reporters: Set<ErrorReporter> = new Set()

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return String(error)
}

export function subscribeErrors(reporter: ErrorReporter): () => void {
  reporters.add(reporter)
  return (): void => {
    reporters.delete(reporter)
  }
}

export function reportError(scope: ErrorScope, context: string, error: unknown): void {
  console.error(`[yobi:${scope}] ${context}: ${describeError(error)}`, error)
  for (const reporter of Array.from(reporters)) {
    try {
      reporter(scope, context, error)
    } catch (nested: unknown) {
      console.error(`[yobi:errors] reporter for ${context} failed: ${describeError(nested)}`, nested)
    }
  }
}
