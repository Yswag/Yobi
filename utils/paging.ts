export function appendUnique<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const seen: Set<string> = new Set(existing.map((item: T): string => item.id))
  const fresh: T[] = []
  for (const item of incoming) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    fresh.push(item)
  }
  return fresh.length > 0 ? [...existing, ...fresh] : existing
}

export function prefetchIndexFor(count: number, hasMore: boolean, lead: number): number {
  return hasMore && count > 0 ? Math.max(0, count - lead) : -1
}
