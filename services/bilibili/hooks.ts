let biliLineSwitchListener: ((host: string) => void) | null = null
let biliWarmHandler: ((manifestUrl: string, seconds: number) => void) | null = null

export function setBiliLineSwitchListener(listener: ((host: string) => void) | null): void {
  biliLineSwitchListener = listener
}

export function notifyBiliLineSwitch(host: string): void {
  biliLineSwitchListener?.(host)
}

export function registerBiliWarmHandler(
  handler: (manifestUrl: string, seconds: number) => void,
): void {
  biliWarmHandler = handler
}

export function warmBiliStartLazy(manifestUrl: string, seconds: number): void {
  biliWarmHandler?.(manifestUrl, seconds)
}
