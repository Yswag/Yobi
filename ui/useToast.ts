import { useCallback, useMemo, useState } from "scripting"

export interface ToastBinding {
  message: string
  isPresented: boolean
  onChanged: (presented: boolean) => void
}

export interface ToastController {
  message: string | null
  showToast: (text: string) => void
  clearToast: () => void
  toastProps: ToastBinding
}

export function useToast(): ToastController {
  const [message, setMessage] = useState<string | null>(null)

  const showToast = useCallback((text: string): void => {
    setMessage(text)
  }, [])

  const clearToast = useCallback((): void => {
    setMessage(null)
  }, [])

  const onChanged = useCallback((presented: boolean): void => {
    if (!presented) setMessage(null)
  }, [])

  const toastProps: ToastBinding = useMemo(
    () => ({
      message: message ?? "",
      isPresented: message !== null,
      onChanged,
    }),
    [message, onChanged],
  )

  return { message, showToast, clearToast, toastProps }
}
